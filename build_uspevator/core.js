'use strict';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const STORAGE_KEY = 'uspevator_data';
const VERSION = 1;
const BACKUP_FORMAT = 'uspevator-backup';
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];
const PHASES = ['idle', 'running', 'paused', 'done'];
const CHART_HISTORY_LIMIT = 180;
const RUN_HISTORY_LIMIT = 50;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const asMs = minutes => Math.round(minutes * MINUTE);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDuration = value => Number.isSafeInteger(value) && value >= 0;
const isStamp = value => isDuration(value) && value <= MAX_TIMESTAMP;
const isClockMinute = value => Number.isInteger(value) && value >= 0 && value < DAY / MINUTE;
const wallTime = () => Date.now();

function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function log(level, module, message, data, threshold = 'WARN') {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(threshold)) return;
  const method = {DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error', CRITICAL: 'error'}[level];
  const label = `[${level}] ${module}: ${message}`;
  if (data === undefined) console[method](label);
  else console[method](label, data instanceof Error ? {message: data.message, stack: data.stack} : data);
}

function estimate(value, label, fromField = false) {
  if (fromField) {
    const text = String(value).trim().replace(',', '.');
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) {
      throw new Error(t`${label}. Укажите неотрицательное число минут.`);
    }
    value = Number(text);
  }
  if (typeof value !== 'number' || value < 0 || !isDuration(asMs(value))) {
    throw new Error(t`${label}. Укажите неотрицательное число минут.`);
  }
  return value;
}

function taskFields(input, fromField = false) {
  if (!isObject(input) || typeof input.name !== 'string' || !input.name.trim()) {
    throw new Error(t('Укажите название задачи.'));
  }
  const minTime = estimate(input.minTime ?? input.optimisticEstimate, t('Базовая оценка'), fromField);
  const maxTime = estimate(input.maxTime ?? input.pessimisticEstimate, t('Оценка с запасом'), fromField);
  if (maxTime < minTime) throw new Error(t('Оценка с запасом должна быть не меньше базовой.'));
  if (input.firstStep !== undefined && typeof input.firstStep !== 'string') {
    throw new Error(t('Первый шаг должен быть текстом.'));
  }
  return {name: input.name.trim(), minTime, maxTime, firstStep: input.firstStep?.trim() || ''};
}

function makeTask(fields, id) {
  return {...fields, id, workedMs: 0, referenceMs: 0, remainingMs: null, done: false};
}

function emptyTimer() {
  return {
    phase: 'idle', startedAt: null, runningSince: null, pausedSince: null, finishedAt: null, activeId: null,
    baselineMs: 0, bufferMs: 0, points: []
  };
}

function emptyState() {
  return {
    version: VERSION, tasks: [], templates: [], pastRuns: [], timer: emptyTimer(),
    window: {start: null, finish: null}, settings: {sound: true, logLevel: 'WARN', language: 'system'}
  };
}

function planTotals(tasks) {
  let baselineMs = 0;
  let bufferMs = 0;
  for (const task of tasks) {
    const base = asMs(task.minTime);
    baselineMs += base;
    bufferMs += asMs(task.maxTime) - base;
  }
  return {baselineMs, bufferMs};
}

function localClockStamp(minutes, reference, dayOffset = 0) {
  const date = new Date(reference);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset,
    Math.floor(minutes / 60), minutes % 60).getTime();
}

function localDayIndex(stamp) {
  return Math.floor((stamp - new Date(stamp).getTimezoneOffset() * MINUTE) / DAY);
}

function deadlineStamp(minutes, durationMs, now) {
  const reference = Math.floor(now / MINUTE) * MINUTE;
  const offset = Math.floor(durationMs / DAY);
  const target = localClockStamp(minutes, reference, offset);
  // Multi-day plans use the first deadline that allows a start on the reference day.
  if (offset > 0) return target - durationMs < localClockStamp(0, reference)
    ? localClockStamp(minutes, reference, offset + 1) : target;
  return target >= reference ? target : localClockStamp(minutes, reference, 1);
}

function latestPlanStart(finish, durationMs) {
  return Math.floor((finish - durationMs) / MINUTE) * MINUTE;
}

function activeTask(state) {
  return state.tasks.find(task => task.id === state.timer.activeId) || null;
}

function workOn(task, timer, now) {
  const running = timer.phase === 'running' && timer.activeId === task.id;
  return Math.max(task.referenceMs, task.workedMs + (running ? Math.max(0, now - timer.runningSince) : 0));
}

function taskTiming(task, timer, now) {
  const base = asMs(task.minTime);
  const reserve = asMs(task.maxTime) - base;
  const elapsed = workOn(task, timer, now);
  const used = timer.activeId === task.id ? Math.max(0, elapsed - task.referenceMs) : 0;
  const optimistic = (task.remainingMs ?? base) - used;
  return {elapsed, optimistic, guarded: optimistic + reserve, reserve};
}

const yellowAt = progress => 5 + 0.4 * progress;

function riskAt(x, y, spentMs) {
  if (y === null) return spentMs > 0 ? 'over' : 'neutral';
  if (y > 100) return 'over';
  if (y >= yellowAt(x) + 50) return 'red';
  if (y >= yellowAt(x)) return 'yellow';
  return 'green';
}

function riskPosition(progress, penetration, spentMs) {
  if (penetration === null) return spentMs > 0 ? 100 : 0;
  const yellow = yellowAt(progress);
  const red = yellow + 50;
  const position = penetration < yellow ? penetration / yellow
    : penetration < red ? 1 + (penetration - yellow) / 50
    : 2 + (penetration - red) / (100 - red);
  return 100 * clamp(position, 0, 3) / 3;
}

function balanceTone(percentLeft, bufferMs, spentMs) {
  if (bufferMs === 0) return spentMs > 0 ? 'black' : 'neutral';
  if (percentLeft > 100) return 'blue';
  if (percentLeft > 66) return 'green';
  if (percentLeft >= 33) return 'yellow';
  if (percentLeft > 0) return 'red';
  return 'black';
}

// The timer gives a fallback forecast. Only finished work and an explicit estimate
// of remaining work earn horizontal movement in the chart.
function metrics(state, now) {
  const {timer, tasks} = state;
  const draft = timer.phase === 'idle';
  const done = timer.phase === 'done';
  const hasPlan = tasks.length > 0 || !draft;
  const included = tasks.filter(task => !task.excluded);
  const totals = planTotals(included);
  const {baselineMs, bufferMs} = draft ? totals : timer;
  const previewStart = draft && isClockMinute(state.window.startMinute)
    ? localClockStamp(state.window.startMinute, now) : null;
  const anchor = draft ? (previewStart ?? state.window.start ?? now) : timer.startedAt;
  const at = done ? timer.finishedAt : previewStart ?? Math.max(now, anchor);
  let earned = 0;
  let completed = 0;
  let workLeft = 0;
  let guardedLeft = 0;
  let task = null;
  let timing = null;

  for (const item of included) {
    const base = asMs(item.minTime);
    if (item.done) {
      earned += base;
      completed++;
      continue;
    }
    const estimate = taskTiming(item, timer, now);
    workLeft += Math.max(0, estimate.optimistic);
    guardedLeft += Math.max(0, estimate.guarded);
    if (item.remainingMs !== null) earned += Math.max(0, base - item.remainingMs);
    if (timer.activeId === item.id) {
      task = item;
      timing = estimate;
    }
  }

  let progress = totals.baselineMs > 0 ? 100 * earned / totals.baselineMs
    : included.length > 0 ? 100 * completed / included.length : 0;
  progress = done ? 100 : clamp(progress, 0, completed === included.length ? 100 : 99.9);
  const spentMs = hasPlan ? at - anchor + workLeft - baselineMs : 0;
  const remainingMs = bufferMs - spentMs;
  const penetration = bufferMs > 0 ? 100 * spentMs / bufferMs : null;
  const percentLeft = penetration === null ? null : 100 - penetration;
  const earliest = hasPlan ? at + workLeft : null;
  const guarded = hasPlan ? at + guardedLeft : null;
  const protectedFinish = hasPlan ? anchor + baselineMs + bufferMs : null;
  const estimateExhausted = timing !== null && timing.guarded <= 0;
  return {
    task, timing, activeElapsed: timing?.elapsed ?? 0,
    activeLeft: timing === null ? null : Math.max(0, timing.optimistic), baselineMs, bufferMs, hasPlan,
    spentMs, remainingMs, penetration, percentLeft, progress, completed,
    remainingTasks: included.length - completed, workLeft, guardedLeft, previewStart,
    pauseMs: timer.phase === 'paused' && timer.pausedSince != null ? Math.max(0, now - timer.pausedSince) : null,
    earliest, guarded, protectedFinish, estimateExhausted, risk: riskAt(progress, penetration, spentMs),
    riskPosition: riskPosition(progress, penetration, spentMs),
    tone: balanceTone(percentLeft, bufferMs, spentMs)
  };
}

function archiveCompleted(state) {
  const {timer, tasks} = state;
  if (timer.phase !== 'done') return state;
  const promise = timer.startedAt + timer.baselineMs + timer.bufferMs;
  const run = {
    startedAt: timer.startedAt, finishedAt: timer.finishedAt,
    protectedFinish: isStamp(promise) ? promise : null,
    tasks: tasks.map(task => ({name: task.name, workedMs: task.workedMs, excluded: Boolean(task.excluded)}))
  };
  return {...state, pastRuns: [...(state.pastRuns ?? []), run].slice(-RUN_HISTORY_LIMIT)};
}

function deadlineStatus(view, finish, phase) {
  if (finish === null) return {label: 'Срок не задан', detail: 'Укажите, к какому времени нужно закончить.', tone: 'neutral'};
  if (!view.hasPlan) return {label: 'Нужны задачи', detail: 'Прогноз появится после добавления первой задачи.', tone: 'neutral'};
  const optimisticMargin = finish - view.earliest;
  const guardedMargin = finish - view.guarded;
  if (phase === 'done') return optimisticMargin < 0
    ? {label: 'Завершено позже срока', margin: optimisticMargin, tone: 'red'}
    : {label: 'Завершено в срок', margin: optimisticMargin, tone: 'green'};
  if (optimisticMargin < 0) return {label: 'План не помещается', margin: optimisticMargin, tone: 'red'};
  if (view.estimateExhausted) return {label: 'Нужно уточнить остаток', detail: 'Оценка текущей задачи исчерпана.', tone: 'yellow'};
  if (guardedMargin < 0) return {label: 'Помещается без полного запаса', margin: guardedMargin, tone: 'yellow'};
  return {label: 'Помещается с запасом', margin: guardedMargin, tone: 'green'};
}

// Keep structural changes and both sides of a discontinuity, such as completing a task.
// The live point is computed in memory, with no writes from timer ticks.
function recordPoint(state, now) {
  if (state.timer.phase === 'idle') return state;
  const view = metrics(state, now);
  if (view.penetration === null) return state;
  const point = {x: view.progress, y: view.penetration, at: now};
  const previous = state.timer.points;
  const last = previous[previous.length - 1];
  if (last && Math.abs(last.x - point.x) < 0.005 && Math.abs(last.y - point.y) < 0.005) return state;
  const recent = previous.length < CHART_HISTORY_LIMIT
    ? previous : [previous[0], ...previous.slice(2)];
  return {...state, timer: {...state.timer, points: [...recent, point]}};
}

const TaskManager = {
  newPlan(state) {
    return {...archiveCompleted(state), tasks: [], timer: emptyTimer(), window: {start: null, finish: null}};
  },

  editable(state, id) {
    return state.timer.phase !== 'done' && state.tasks.some(task =>
      task.id === id && !task.done && task.id !== state.timer.activeId);
  },

  createTask(state, fields, id, beforeId = null) {
    if (state.timer.phase === 'done') return state;
    if (beforeId !== null && !this.editable(state, beforeId)) return state;
    const tasks = [...state.tasks];
    const index = beforeId === null ? tasks.length : tasks.findIndex(task => task.id === beforeId);
    tasks.splice(index, 0, makeTask(taskFields(fields), id));
    return {...state, tasks};
  },

  updateTask(state, id, fields) {
    if (!this.editable(state, id)) return state;
    const edited = taskFields(fields);
    const tasks = state.tasks.map(task => {
      if (task.id !== id) return task;
      const changedEstimate = edited.minTime !== task.minTime || edited.maxTime !== task.maxTime;
      return {...task, ...edited, ...(changedEstimate ? {remainingMs: null, referenceMs: task.workedMs} : {})};
    });
    return {...state, tasks};
  },

  deleteTask(state, id) {
    if (!this.editable(state, id)) return state;
    return {...state, tasks: state.tasks.filter(task => task.id !== id)};
  },

  moveTask(state, id, beforeId) {
    if (id === beforeId || !this.editable(state, id)) return state;
    if (beforeId !== null && !this.editable(state, beforeId)) return state;
    const task = state.tasks.find(item => item.id === id);
    const tasks = state.tasks.filter(item => item.id !== id);
    const index = beforeId === null ? tasks.length : tasks.findIndex(item => item.id === beforeId);
    tasks.splice(index, 0, task);
    return tasks.every((item, i) => item === state.tasks[i]) ? state : {...state, tasks};
  }
};

const Timer = {
  startTimer(state, now) {
    const {timer} = state;
    if (timer.phase === 'paused' && activeTask(state)) {
      const previous = recordPoint(state, now);
      return {...previous, timer: {...previous.timer, phase: 'running', pausedSince: null, runningSince: Math.max(timer.startedAt, now)}};
    }
    if (timer.phase !== 'idle' || !state.tasks.length) return state;
    const start = Math.min(now, state.window.start ?? now);
    const totals = planTotals(state.tasks);
    return recordPoint({
      ...state, timer: {
        ...emptyTimer(), ...totals, phase: 'running', startedAt: start, runningSince: now,
        activeId: state.tasks[0].id, points: totals.bufferMs ? [{x: 0, y: 0, at: start}] : []
      }
    }, now);
  },

  pauseTimer(state, now) {
    if (state.timer.phase !== 'running') return state;
    const previous = recordPoint(state, now);
    const tasks = state.tasks.map(task => task.id === state.timer.activeId
      ? {...task, workedMs: workOn(task, state.timer, now)} : task);
    return {...previous, tasks, timer: {...previous.timer, phase: 'paused', runningSince: null,
      pausedSince: Math.max(state.timer.startedAt, state.timer.runningSince, now)}};
  },

  resetTimer(state) {
    return {...state, tasks: state.tasks.map(task => makeTask(taskFields(task), task.id)), timer: emptyTimer()};
  },

  repeatPlan(state) {
    if (state.timer.phase !== 'done') return state;
    return {...this.resetTimer(archiveCompleted(state)), window: {start: null, finish: null}};
  },

  completeTask(state, now) {
    return this.advance(state, now, 'finish');
  },

  skipTask(state, now) {
    return this.advance(state, now, 'defer');
  },

  excludeTask(state, now) {
    return this.advance(state, now, 'exclude');
  },

  advance(state, now, action) {
    const current = activeTask(state);
    if (!current || (action === 'defer' && state.tasks.filter(task => !task.done).length < 2)) return state;
    const previous = recordPoint(state, now);
    const workedMs = workOn(current, state.timer, now);
    let tasks;
    if (action !== 'defer') {
      const result = {...current, workedMs, done: true};
      if (action === 'exclude') result.excluded = true;
      tasks = state.tasks.map(task => task.id === current.id ? result : task);
    } else {
      tasks = state.tasks.filter(task => task.id !== current.id);
      // Work already done stays in actual time. The next attempt starts from the
      // last explicit estimate or the original base if progress is unknown.
      tasks.push({...current, workedMs, referenceMs: workedMs});
    }
    const next = tasks.find(task => !task.done);
    const phase = next ? state.timer.phase : 'done';
    const timer = {
      ...previous.timer, phase, activeId: next?.id ?? null,
      runningSince: phase === 'running' ? Math.max(state.timer.startedAt, now) : null,
      pausedSince: phase === 'paused' ? state.timer.pausedSince ?? null : null,
      finishedAt: next ? null : Math.max(state.timer.startedAt, now)
    };
    return recordPoint({...previous, tasks, timer}, now);
  },

  setRemaining(state, now, remainingMs) {
    const current = activeTask(state);
    if (!current) return state;
    const previous = recordPoint(state, now);
    const referenceMs = workOn(current, state.timer, now);
    const tasks = state.tasks.map(task => task.id === current.id
      ? {...task, remainingMs, referenceMs} : task);
    return recordPoint({...previous, tasks}, now);
  }
};

function templateName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(t('Укажите название шаблона.'));
  return value.trim();
}

const TemplateManager = {
  saveTemplate(state, name, id) {
    const tasks = state.tasks.map(task => taskFields(task));
    if (!tasks.length) return state;
    const value = {id, name: templateName(name), tasks};
    const replacing = state.templates.some(template => template.id === id);
    const templates = replacing
      ? state.templates.map(template => template.id === id ? value : template)
      : [...state.templates, value];
    return {...state, templates};
  },

  deleteTemplate(state, id) {
    return {...state, templates: state.templates.filter(template => template.id !== id)};
  },

  applyTemplate(state, id, taskIds) {
    const template = state.templates.find(item => item.id === id);
    if (!template?.tasks.length) return state;
    const tasks = template.tasks.map((task, i) => makeTask(task, taskIds[i]));
    return {...archiveCompleted(state), tasks, timer: emptyTimer()};
  }
};

// Imports are fully validated before any state is committed. New task IDs isolate
// templates, copied tasks, and the daily plan from one another.
function readTemplates(raw, createId, keepIds = false) {
  if (!Array.isArray(raw)) throw new Error(t('В JSON должен быть массив templates.'));
  const seen = new Set();
  return raw.map((item, i) => {
    try {
      if (!isObject(item) || !Array.isArray(item.tasks)) throw new Error(t('Нужен массив задач tasks.'));
      const name = templateName(item.name);
      const id = keepIds ? readId(item.id, seen) : createId();
      return {id, name, tasks: item.tasks.map((task, j) => {
        try { return taskFields(task); }
        catch (error) { throw new Error(t`Задача ${j + 1}. ${error.message}`); }
      })};
    } catch (error) {
      throw new Error(t`Шаблон ${i + 1}. ${error.message}`);
    }
  });
}

function readId(value, seen) {
  if (typeof value !== 'string' || !value || seen.has(value)) throw new Error(t('Некорректный идентификатор.'));
  seen.add(value);
  return value;
}

function readTimer(raw, tasks) {
  if (!isObject(raw) || !PHASES.includes(raw.phase)) throw new Error(t('Некорректное состояние таймера.'));
  const {phase, startedAt, runningSince, finishedAt, activeId, baselineMs, bufferMs} = raw;
  const pausedSince = raw.pausedSince ?? null;
  if (phase === 'idle') {
    if (tasks.some(task => task.done || task.workedMs || task.remainingMs !== null)) {
      throw new Error(t('У незапущенного плана обнаружена история.'));
    }
    return emptyTimer();
  }
  const open = tasks.find(task => !task.done);
  if (!tasks.length || !isStamp(startedAt) || !isDuration(baselineMs) || !isDuration(bufferMs)
      || (phase === 'done' ? !!open || activeId !== null || !isStamp(finishedAt) || finishedAt < startedAt
        : !open || open.id !== activeId || finishedAt !== null)
      || (phase === 'running' ? !isStamp(runningSince) || runningSince < startedAt : runningSince !== null)
      || (pausedSince !== null && (phase !== 'paused' || !isStamp(pausedSince) || pausedSince < startedAt))) {
    throw new Error(t('Состояние таймера не согласуется с планом.'));
  }
  if (!Array.isArray(raw.points)) throw new Error(t('Некорректная история буфера.'));
  const points = raw.points.slice(-CHART_HISTORY_LIMIT).map(point => {
    if (!isObject(point) || !Number.isFinite(point.x) || point.x < 0 || point.x > 100
        || !Number.isFinite(point.y) || !isStamp(point.at)) throw new Error(t('Некорректная точка графика.'));
    return {x: point.x, y: point.y, at: point.at};
  });
  return {phase, startedAt, runningSince, pausedSince, finishedAt, activeId, baselineMs, bufferMs, points};
}

function readPastRuns(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(t('Некорректная история планов.'));
  return raw.slice(-RUN_HISTORY_LIMIT).map(run => {
    if (!isObject(run) || !isStamp(run.startedAt) || !isStamp(run.finishedAt) || run.finishedAt < run.startedAt
        || (run.protectedFinish !== null && !isStamp(run.protectedFinish))
        || !Array.isArray(run.tasks)) throw new Error(t('Некорректная запись истории планов.'));
    const tasks = run.tasks.map(task => {
      if (!isObject(task) || typeof task.name !== 'string' || !isDuration(task.workedMs)
          || typeof task.excluded !== 'boolean') throw new Error(t('Некорректная задача в истории планов.'));
      return {name: task.name, workedMs: task.workedMs, excluded: task.excluded};
    });
    return {startedAt: run.startedAt, finishedAt: run.finishedAt, protectedFinish: run.protectedFinish, tasks};
  });
}

function readState(raw, createId = uid) {
  if (!isObject(raw)) throw new Error(t('Файл должен содержать JSON-объект.'));
  // Older data only contained tasks and templates. Restore the plan as a draft.
  if (raw.version === undefined) {
    if (!Array.isArray(raw.tasks) && !Array.isArray(raw.templates)) throw new Error(t('План и шаблоны не найдены.'));
    return {
      ...emptyState(), tasks: (raw.tasks ?? []).map(task => makeTask(taskFields(task), createId())),
      templates: readTemplates(raw.templates ?? [], createId)
    };
  }
  if (raw.version !== VERSION || !Array.isArray(raw.tasks)) throw new Error(t('Эта версия данных не поддерживается.'));
  const seen = new Set();
  const tasks = raw.tasks.map(task => {
    const fields = taskFields(task);
    const id = readId(task.id, seen);
    const {workedMs, referenceMs, remainingMs, done, excluded} = task;
    if (!isDuration(workedMs) || !isDuration(referenceMs)
        || (remainingMs !== null && !isDuration(remainingMs)) || typeof done !== 'boolean'
        || (excluded !== undefined && (typeof excluded !== 'boolean' || (excluded && !done)))) {
      throw new Error(t('Некорректные данные о выполнении задачи.'));
    }
    if (referenceMs > workedMs && !(raw.timer?.phase === 'running' && raw.timer.activeId === id)) {
      throw new Error(t('Оценка остатка не согласуется со временем задачи.'));
    }
    return {...fields, id, workedMs, referenceMs, remainingMs, done, ...(excluded ? {excluded: true} : {})};
  });
  const schedule = raw.window;
  if (!isObject(schedule) || ![schedule.start, schedule.finish].every(value => value === null || isStamp(value))
      || (schedule.startMinute !== undefined && !isClockMinute(schedule.startMinute))) {
    throw new Error(t('Некорректные сроки плана.'));
  }
  const settings = raw.settings;
  if (!isObject(settings) || typeof settings.sound !== 'boolean' || !LEVELS.includes(settings.logLevel)) {
    throw new Error(t('Некорректные настройки.'));
  }
  return {
    version: VERSION, tasks, templates: readTemplates(raw.templates, createId, true), pastRuns: readPastRuns(raw.pastRuns),
    timer: readTimer(raw.timer, tasks), window: {
      start: schedule.start, finish: schedule.finish,
      ...(schedule.startMinute === undefined ? {} : {startMinute: schedule.startMinute})
    },
    settings: {sound: settings.sound, logLevel: settings.logLevel, language: normalizeLanguage(settings.language)}
  };
}

function exportTemplates(state) {
  return {templates: state.templates.map(template => ({
    name: template.name, tasks: template.tasks.map(task => ({
      name: task.name, minTime: task.minTime, maxTime: task.maxTime,
      ...(task.firstStep ? {firstStep: task.firstStep} : {})
    }))
  }))};
}

function parseImport(text, createId = uid) {
  let raw;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(t('В файле некорректный JSON.'), {cause: error}); }
  if (raw?.format === BACKUP_FORMAT) {
    const state = readState(raw.state, createId);
    if (state.timer.phase === 'running') throw new Error(t('Резервная копия должна содержать снимок на паузе.'));
    return {kind: 'backup', state};
  }
  return {kind: 'templates', templates: readTemplates(raw?.templates, createId)};
}

function exportBackup(state, now) {
  return {format: BACKUP_FORMAT, exportedAt: now, state: Timer.pauseTimer(state, now)};
}

class StateManager {
  constructor(storage, onWarning = () => {}) {
    this.storage = storage;
    this.onWarning = onWarning;
    this.state = emptyState();
    this.raw = null;
    this.unreadable = false;
    this.subscribers = new Set();
    if (!storage) {
      this.onWarning(t('Хранилище браузера недоступно. Для сохранения скачайте резервную копию.'));
      return;
    }
    try {
      this.raw = storage.getItem(STORAGE_KEY);
      if (this.raw !== null) this.state = readState(JSON.parse(this.raw));
    } catch (error) {
      this.unreadable = true;
      this.reportStorage(t('Сохранённые данные не удалось прочитать. Проверьте резервную копию.'), error);
    }
  }

  getState() { return this.state; }

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  updateView(next, operation) {
    const previous = this.state;
    this.state = next;
    for (const listener of this.subscribers) listener(next, previous, operation);
  }

  reportStorage(message, error) {
    log('ERROR', 'StateManager.storage', message, error, this.state.settings.logLevel);
    this.onWarning(message);
  }

  acceptStorage(raw) {
    if (raw === this.raw) return false;
    try {
      const next = raw === null ? emptyState() : readState(JSON.parse(raw));
      this.raw = raw;
      this.unreadable = false;
      this.updateView(next, 'external');
      this.onWarning('');
      return true;
    } catch (error) {
      this.raw = raw;
      this.unreadable = true;
      this.reportStorage(t('Не удалось прочитать обновление плана.'), error);
      return false;
    }
  }

  setState(next, operation, now = wallTime()) {
    if (next === this.state) return false;
    if (this.storage) {
      try {
        const latest = this.storage.getItem(STORAGE_KEY);
        if (latest !== this.raw) {
          this.acceptStorage(latest);
          return false;
        }
        if (this.unreadable && operation !== 'ImportExportManager.importBackup') {
          this.onWarning(t('Сохранённый план повреждён. Восстановите резервную копию через «Импорт JSON».'));
          return false;
        }
        const raw = JSON.stringify(next);
        if (this.storage.compareAndSet) {
          const result = this.storage.compareAndSet(this.raw, raw, operation);
          if (result === 'conflict') {
            this.acceptStorage(this.storage.getItem(STORAGE_KEY));
            return false;
          }
          if (result !== 'ok') throw new Error(t('Не удалось записать план.'));
        } else this.storage.setItem(STORAGE_KEY, raw);
        this.raw = raw;
        this.unreadable = false;
        this.onWarning('');
      } catch (error) {
        if (this.storage.compareAndSet) {
          this.reportStorage(t('Не удалось сохранить изменение плана.'), error);
          return false;
        }
        this.reportStorage(t('Изменения остались в этой вкладке. Скачайте резервную копию, чтобы их сохранить.'), error);
      }
    }
    const before = this.state;
    const threshold = next.settings.logLevel;
    if (before.tasks !== next.tasks || before.templates !== next.templates) {
      const changes = {};
      if (before.tasks !== next.tasks) changes.tasks = {before: before.tasks, after: next.tasks};
      if (before.templates !== next.templates) changes.templates = {before: before.templates, after: next.templates};
      log('INFO', operation, t('Данные изменены'), changes, threshold);
    }
    if (before.timer !== next.timer) {
      const view = metrics(next, now);
      log('INFO', operation, t('Состояние таймера'), {
        phase: next.timer.phase, taskId: next.timer.activeId,
        elapsedMs: view.activeElapsed, bufferLeftMs: view.remainingMs
      }, threshold);
    }
    this.updateView(next, operation);
    return true;
  }
}

const TASK_TONE_HZ = 620;
const BUFFER_TONE_HZ = 660;
const PULSE_SECONDS = 0.1;

function beepInterval(percentLeft) {
  const pulseMs = PULSE_SECONDS * 1000;
  return pulseMs + (3000 - pulseMs) * clamp(percentLeft, 0, 100) / 100;
}

class SoundManager {
  constructor(readLive, onError, onReady = () => {}) {
    this.readLive = readLive;
    this.onError = onError;
    this.onReady = onReady;
    this.context = null;
    this.runId = null;
    this.focusKey = null;
    this.alerted = new Set();
    this.alarm = null;
    this.preview = null;
    this.pulse = null;
    this.pending = null;
    this.lastBeep = null;
  }

  get ready() { return this.context?.state === 'running'; }

  async unlock(preview = false) {
    try {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) throw new Error(t('Этот браузер не поддерживает звуковые сигналы.'));
      if (!this.context || this.context.state === 'closed') {
        this.context = new Context();
        this.context.addEventListener('statechange', () => {
          this.onReady();
          this.sync();
        });
      }
      if (!this.ready) await this.context.resume();
      this.onReady();
      this.sync();
      if (preview && this.ready) this.playPreview();
      return this.ready;
    } catch (error) {
      this.onReady();
      this.onError(error);
      return false;
    }
  }

  tone(at, length, volume, frequency = TASK_TONE_HZ) {
    const context = this.context;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + 0.012);
    if (length !== null) {
      gain.gain.setValueAtTime(volume, at + length - 0.018);
      gain.gain.linearRampToValueAtTime(0, at + length);
    }
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(at);
    if (length !== null) oscillator.stop(at + length);
    return oscillator;
  }

  doubleSignal(at) {
    const length = 0.16;
    const second = at + 0.23;
    return {at, end: second + length, nodes: [this.tone(at, length, 0.17), this.tone(second, length, 0.17)]};
  }

  cancel(sequence) {
    if (sequence && this.context.currentTime < sequence.end) {
      for (const oscillator of sequence.nodes) oscillator.stop();
    }
  }

  playPreview() {
    const now = this.context.currentTime;
    if (this.alarm && this.alarm.end > now && this.alarm.at <= now + 0.41) return;
    this.cancel(this.preview);
    this.stopPulse();
    this.preview = this.doubleSignal(now + 0.012);
    this.sync();
  }

  clearAlarm() {
    if (!this.alarm) return;
    if (this.context.currentTime >= this.alarm.at) this.alerted.add(this.alarm.focusKey);
    this.cancel(this.alarm);
    this.alarm = null;
  }

  syncAlarm(live) {
    const now = this.context.currentTime;
    const at = now + Math.max(0.012, live.optimisticMs / 1000);
    if (this.alarm && now >= this.alarm.at) {
      this.alerted.add(live.focusKey);
      if (now >= this.alarm.end) this.alarm = null;
    }
    // Reschedule if the wall clock and audio clock diverged while the device slept.
    if (this.alarm && now < this.alarm.at && Math.abs(this.alarm.at - at) > 0.65) this.clearAlarm();
    if (!this.alarm && !this.alerted.has(live.focusKey)) {
      if (live.optimisticMs < -150) this.alerted.add(live.focusKey);
      else this.alarm = {...this.doubleSignal(at), focusKey: live.focusKey};
    }
  }

  stopPulse() {
    clearTimeout(this.pending);
    this.pending = null;
    this.lastBeep = null;
    this.cancel(this.pulse);
    this.pulse = null;
  }

  stop() {
    this.clearAlarm();
    this.stopPulse();
    this.cancel(this.preview);
    this.preview = null;
  }

  syncPulse(percentLeft) {
    clearTimeout(this.pending);
    this.pending = null;
    const audioNow = this.context.currentTime;
    const steady = this.pulse?.end === Infinity;
    if (steady && percentLeft > 0) this.stopPulse();
    if (steady && percentLeft <= 0) return;

    let availableAt = Math.max(audioNow, this.preview?.end ?? audioNow, this.pulse?.end ?? audioNow);
    if (this.alarm && this.alarm.at <= audioNow + 0.12) availableAt = Math.max(availableAt, this.alarm.end);
    if (percentLeft <= 0) {
      // Let the last pulse finish and keep one oscillator running until the
      // buffer recovers or playback stops. No periodic timer is needed.
      const at = Math.max(audioNow + 0.004, availableAt);
      const playing = this.pulse?.end > audioNow ? this.pulse.nodes : [];
      this.pulse = {end: Infinity, nodes: [...playing, this.tone(at, null, 0.09, BUFFER_TONE_HZ)]};
      return;
    }

    const now = performance.now();
    const interval = beepInterval(percentLeft);
    const left = this.lastBeep === null ? 0 : this.lastBeep + interval - now;
    const wait = Math.max(left, (availableAt - audioNow) * 1000);
    if (wait <= 0) {
      const at = audioNow + 0.004;
      this.pulse = {end: at + PULSE_SECONDS, nodes: [this.tone(at, PULSE_SECONDS, 0.11, BUFFER_TONE_HZ)]};
      this.lastBeep = now;
    }
    this.pending = setTimeout(() => this.sync(), wait > 0 ? wait : interval);
  }

  sync() {
    const live = this.readLive();
    if (live.runId !== this.runId || live.focusKey !== this.focusKey) {
      this.clearAlarm();
      this.stopPulse();
      if (live.runId !== this.runId) this.alerted.clear();
      this.runId = live.runId;
      this.focusKey = live.focusKey;
    }
    if (!this.ready || !live.enabled || !live.running || !live.focusKey) {
      this.clearAlarm();
      this.stopPulse();
      return;
    }
    if (this.preview && this.context.currentTime >= this.preview.end) this.preview = null;
    // The threshold has its own scheduled signal, including in background tabs.
    this.syncAlarm(live);
    if (live.foreground && live.optimisticMs <= 0) {
      this.syncPulse(live.reserveMs > 0 ? 100 * live.guardedMs / live.reserveMs : 0);
    } else {
      this.stopPulse();
    }
  }
}
