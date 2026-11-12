// Self-tests use explicit time and an in-memory store. They can run during a real
// session without touching its clock, localStorage, audio, or form fields.
function runSelfTests() {
  let total = 0;
  let passed = 0;
  const T = 1_800_000_000_000;
  const mins = MINUTE;
  const equal = (actual, expected) => {
    if (actual !== expected) throw new Error(`Ожидалось ${expected}, получено ${actual}`);
  };
  const assert = (condition, message = 'Условие не выполнено') => {
    if (!condition) throw new Error(message);
  };
  const rejects = fn => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    assert(threw, 'Ожидалась ошибка');
  };
  const test = (name, fn) => {
    total++;
    try {
      fn();
      passed++;
      console.info(`[INFO] Tests.run: ✓ ${name}`);
    } catch (error) {
      console.assert(false, `${name}. ${error.message}`, error.stack);
    }
  };
  const add = (state, id, base, safe) => TaskManager.createTask(state, {name: id, minTime: base, maxTime: safe}, id);
  const plan = (...pairs) => pairs.reduce((state, [id, base, safe]) => add(state, id, base, safe), emptyState());
  const example = () => plan(['a', 10, 20], ['b', 15, 25], ['c', 5, 10]);
  const memoryStore = () => {
    const map = new Map();
    return {
      getItem: key => map.get(key) ?? null,
      setItem: (key, value) => map.set(key, value)
    };
  };
  const soundFixture = (overrides = {}) => {
    const live = {runId: T, focusKey: 'a', running: true, enabled: true,
      foreground: false, optimisticMs: 10 * mins, guardedMs: 20 * mins, reserveMs: 10 * mins, ...overrides};
    const manager = new SoundManager(() => live, error => { throw error; });
    manager.context = {state: 'running', currentTime: 5};
    const tones = [];
    manager.tone = (at, length, volume, frequency) => {
      const tone = {at, length, volume, frequency, cancelled: false, stop() { this.cancelled = true; }};
      tones.push(tone);
      return tone;
    };
    return {live, manager, tones};
  };

  console.groupCollapsed('[INFO] Tests.run: Самопроверка Успеватора');

  test('Первый запуск с пустым планом', () => {
    const empty = emptyState();
    equal(Timer.startTimer(empty, T), empty);
    equal(metrics(empty, T).earliest, null);
    equal(metrics(empty, T).progress, 0);
  });

  test('Звук включён по умолчанию, явная настройка загружается из сохранения', () => {
    const draft = emptyState();
    equal(draft.settings.sound, true);
    const muted = {...draft, settings: {...draft.settings, sound: false}};
    equal(readState(JSON.parse(JSON.stringify(muted))).settings.sound, false);
  });

  test('Диапазоны, десятичные минуты и неизменяемость исходного плана', () => {
    const input = emptyState();
    const fields = taskFields({name: ' Первый ', minTime: '0,5', maxTime: '1.5', firstStep: '  открыть '}, true);
    const next = TaskManager.createTask(input, fields, 'a');
    equal(input.tasks.length, 0);
    equal(next.tasks[0].firstStep, 'открыть');
    equal(planTotals(next.tasks).bufferMs, mins);
    rejects(() => add(input, 'bad', 3, 2));
    rejects(() => add(input, 'bad', -0.000001, 2));
    rejects(() => add(input, 'bad', Infinity, Infinity));
    rejects(() => taskFields({name: ' ', minTime: 0, maxTime: 0}));
    rejects(() => taskFields({name: 'X', minTime: '', maxTime: '1'}, true));
  });

  test('Редактирование и удаление затрагивают только выбранную задачу', () => {
    const original = example();
    const edited = TaskManager.updateTask(original, 'b', {name: 'Б', minTime: 12, maxTime: 22});
    equal(edited.tasks[1].name, 'Б');
    equal(original.tasks[1].minTime, 15);
    equal(edited.tasks[0], original.tasks[0]);
    const removed = TaskManager.deleteTask(edited, 'b');
    equal(removed.tasks.map(task => task.id).join(''), 'ac');
  });

  test('До старта прогноз равен суммам оценок', () => {
    const view = metrics(example(), T);
    equal(view.baselineMs, 30 * mins);
    equal(view.bufferMs, 25 * mins);
    equal(view.earliest, T + 30 * mins);
    equal(view.guarded, T + 55 * mins);
  });

  test('Перестановка сохраняет прогноз и общий резерв', () => {
    const original = example();
    const moved = TaskManager.moveTask(original, 'a', null);
    equal(moved.tasks.map(task => task.id).join(''), 'bca');
    equal(metrics(moved, T).guarded, metrics(original, T).guarded);
    equal(metrics(moved, T).remainingMs, metrics(original, T).remainingMs);
  });

  test('Старт фиксирует базу, резерв, финиш и первую задачу', () => {
    const running = Timer.startTimer(example(), T);
    equal(running.timer.activeId, 'a');
    equal(running.timer.phase, 'running');
    equal(running.timer.bufferMs, 25 * mins);
    equal(metrics(running, T).protectedFinish, T + 55 * mins);
  });

  test('Рабочий таймер не засчитывает готовность и не завершает задачу', () => {
    const running = Timer.startTimer(example(), T);
    equal(metrics(running, T + 9 * mins).spentMs, 0);
    const later = metrics(running, T + 12 * mins);
    equal(later.task.id, 'a');
    equal(later.progress, 0);
    equal(later.spentMs, 2 * mins);
    equal(later.activeLeft, 0);
  });

  test('Фактические времена из примера ТЗ дают расход 7 минут и 28%', () => {
    let running = Timer.startTimer(example(), T);
    running = Timer.completeTask(running, T + 12 * mins);
    equal(running.timer.activeId, 'b');
    running = Timer.completeTask(running, T + 32 * mins);
    running = Timer.completeTask(running, T + 37 * mins);
    const view = metrics(running, T + 120 * mins);
    equal(running.timer.phase, 'done');
    equal(view.earliest, T + 37 * mins);
    equal(view.spentMs, 7 * mins);
    equal(view.penetration, 28);
    equal(view.progress, 100);
    equal(running.tasks[1].workedMs, 20 * mins);
  });

  test('Досрочное завершение пополняет резерв и продвигает график', () => {
    const state = Timer.completeTask(Timer.startTimer(example(), T), T + 4 * mins);
    const view = metrics(state, T + 4 * mins);
    equal(view.remainingMs, 31 * mins);
    equal(view.tone, 'blue');
    assert(Math.abs(view.progress - 100 / 3) < 0.0001);
    equal(view.activeElapsed, 0);
  });

  test('Пауза замораживает факт работы, но расходует резерв дня', () => {
    const start = Timer.startTimer(example(), T);
    const paused = Timer.pauseTimer(start, T + 4 * mins);
    const view = metrics(paused, T + 9 * mins);
    equal(paused.timer.runningSince, null);
    equal(view.activeElapsed, 4 * mins);
    equal(view.spentMs, 5 * mins);
    const resumed = Timer.startTimer(paused, T + 9 * mins);
    equal(metrics(resumed, T + 11 * mins).activeElapsed, 6 * mins);
    equal(metrics(resumed, T + 11 * mins).spentMs, 5 * mins);
  });

  test('Отложенное время учитывается один раз, а задача возвращается', () => {
    let state = Timer.startTimer(plan(['a', 10, 20], ['b', 10, 20]), T);
    state = Timer.skipTask(state, T + 4 * mins);
    equal(state.tasks.map(task => task.id).join(''), 'ba');
    equal(state.tasks[1].workedMs, 4 * mins);
    equal(metrics(state, T + 4 * mins).spentMs, 4 * mins);
    state = Timer.completeTask(state, T + 14 * mins);
    equal(state.timer.activeId, 'a');
    equal(Timer.skipTask(state, T + 14 * mins), state);
    equal(metrics(state, T + 14 * mins).activeLeft, 10 * mins);
    state = Timer.completeTask(state, T + 24 * mins);
    equal(state.tasks[1].workedMs, 14 * mins);
    equal(metrics(state, T + 24 * mins).spentMs, 4 * mins);
  });

  test('После уточнения остатка меняются прогноз и подтверждённая готовность', () => {
    let state = Timer.startTimer(example(), T);
    state = Timer.setRemaining(state, T + 8 * mins, 4 * mins);
    const report = metrics(state, T + 8 * mins);
    equal(report.progress, 20);
    equal(report.spentMs, 2 * mins);
    equal(report.activeLeft, 4 * mins);
    const after = metrics(state, T + 10 * mins);
    equal(after.progress, 20);
    equal(after.activeLeft, 2 * mins);
    equal(after.earliest, report.earliest);
  });

  test('Текущая и завершённые задачи зафиксированы при перестановке и правках', () => {
    const state = Timer.completeTask(Timer.startTimer(example(), T), T + 5 * mins);
    equal(TaskManager.moveTask(state, 'a', null), state);
    equal(TaskManager.moveTask(state, 'b', null), state);
    equal(TaskManager.moveTask(state, 'c', 'a'), state);
    equal(TaskManager.moveTask(state, 'c', 'b'), state);
    equal(TaskManager.deleteTask(state, 'b'), state);
    equal(TaskManager.updateTask(state, 'a', {name: 'X', minTime: 1, maxTime: 2}), state);
    equal(TaskManager.createTask(state, {name: 'X', minTime: 1, maxTime: 2}, 'x', 'a'), state);
  });

  test('Изменение будущего объёма двигает прогноз, сохраняя защищённый финиш', () => {
    const state = Timer.startTimer(example(), T);
    const changed = add(state, 'd', 12, 18);
    equal(metrics(changed, T).spentMs, 12 * mins);
    equal(metrics(changed, T).bufferMs, 25 * mins);
    equal(metrics(changed, T).protectedFinish, T + 55 * mins);
    equal(metrics(changed, T).guarded, T + 73 * mins);
    equal(metrics(TaskManager.deleteTask(changed, 'd'), T).spentMs, 0);
  });

  test('Задержка старта расходует резерв и сохраняется после нажатия «Старт»', () => {
    const draft = {...example(), window: {start: T, finish: T + 65 * mins}};
    const late = T + 6 * mins;
    equal(metrics(draft, late).spentMs, 6 * mins);
    equal(metrics(Timer.startTimer(draft, late), late).spentMs, 6 * mins);
    equal(Timer.startTimer(draft, T - mins).timer.startedAt, T - mins);
  });

  test('Окно дня различает достаточный, частичный и недоступный запас', () => {
    const view = metrics(example(), T);
    equal(deadlineStatus(view, T + 55 * mins, 'idle').tone, 'green');
    equal(deadlineStatus(view, T + 31 * mins, 'idle').tone, 'yellow');
    equal(deadlineStatus(view, T + 25 * mins, 'idle').tone, 'red');
    equal(deadlineStatus(view, null, 'idle').tone, 'neutral');
  });

  test('Одинаковый расход даёт разный риск в начале и конце', () => {
    equal(riskAt(0, 60, 1), 'red');
    equal(riskAt(90, 60, 1), 'yellow');
    equal(riskAt(90, 30, 1), 'green');
    equal(riskAt(99, 101, 1), 'over');
    equal(riskAt(0, 5, 1), 'yellow');
    equal(riskAt(100, 95, 1), 'red');
  });

  test('Цвет остатка имеет заданные пороги', () => {
    equal(balanceTone(105, mins, -1), 'blue');
    equal(balanceTone(100, mins, 0), 'green');
    equal(balanceTone(66, mins, 1), 'yellow');
    equal(balanceTone(33, mins, 1), 'yellow');
    equal(balanceTone(10, mins, 1), 'red');
    equal(balanceTone(0, mins, mins), 'black');
  });

  test('Нулевой резерв не приводит к делению на ноль', () => {
    const started = Timer.startTimer(plan(['a', 0, 0], ['b', 0, 0]), T);
    const view = metrics(started, T + mins);
    equal(view.penetration, null);
    equal(view.spentMs, mins);
    equal(view.risk, 'over');
    equal(metrics(Timer.completeTask(started, T + mins), T + mins).progress, 50);
  });

  test('Сброс сохраняет задачи, шаблоны и окно дня', () => {
    const data = TemplateManager.saveTemplate(example(), 'Утро', 'template');
    const state = Timer.completeTask(Timer.startTimer(data, T), T + mins);
    const reset = Timer.resetTimer(state);
    equal(reset.timer.phase, 'idle');
    equal(reset.tasks[0].workedMs, 0);
    equal(reset.tasks[0].done, false);
    equal(reset.templates, state.templates);
    equal(reset.window, state.window);
    equal(metrics(reset, T).remainingMs, 25 * mins);
  });

  test('Новый список очищает задачи, историю и окно дня, сохраняя шаблоны и настройки', () => {
    const saved = TemplateManager.saveTemplate(plan(['a', 1, 2]), 'Утро', 'template');
    const ready = {...saved, settings: {...saved.settings, sound: true}, window: {start: T, finish: T + 15 * mins}};
    const finished = Timer.completeTask(Timer.startTimer(ready, T), T + mins);
    const draft = TaskManager.newPlan(finished);
    equal(draft.timer.phase, 'idle');
    equal(draft.timer.points.length, 0);
    equal(draft.tasks.length, 0);
    equal(draft.window.start, null);
    equal(draft.window.finish, null);
    equal(draft.templates, finished.templates);
    equal(draft.settings, finished.settings);
    equal(finished.tasks[0].done, true);
    equal(add(draft, 'b', 2, 3).tasks.length, 1);
  });

  test('Применение и перезапись шаблона используют независимые копии', () => {
    const initial = TemplateManager.saveTemplate(example(), 'Утро', 'template');
    const applied = TemplateManager.applyTemplate(initial, 'template', ['x', 'y', 'z']);
    equal(applied.tasks[0].id, 'x');
    const edited = TaskManager.updateTask(applied, 'x', {name: 'Новая', minTime: 5, maxTime: 10});
    equal(edited.templates[0].tasks[0].name, 'a');
    const overwritten = TemplateManager.saveTemplate(edited, 'Вечер', 'template');
    equal(overwritten.templates.length, 1);
    equal(overwritten.templates[0].tasks[0].name, 'Новая');
    equal(TemplateManager.deleteTemplate(overwritten, 'template').tasks, overwritten.tasks);
  });

  test('Применение шаблона сохраняет окно дня и историю завершённого плана', () => {
    const draft = TemplateManager.saveTemplate(plan(['a', 1, 2]), 'Утро', 'template');
    const window = {start: T, finish: T + 10 * mins};
    const done = Timer.completeTask(Timer.startTimer({...draft, window}, T), T + mins);
    const applied = TemplateManager.applyTemplate(done, 'template', ['new-task']);
    equal(applied.window, window);
    equal(applied.pastRuns.length, 1);
    equal(applied.timer.phase, 'idle');
    equal(applied.tasks[0].id, 'new-task');
    equal(applied.tasks[0].workedMs, 0);
    equal(applied.tasks[0].done, false);
  });

  test('Пустой шаблон из старого файла не стирает текущий список', () => {
    const current = {...plan(['a', 1, 2]), templates: [{id: 'empty', name: 'Пустой', tasks: []}]};
    equal(TemplateManager.applyTemplate(current, 'empty', []), current);
  });

  test('Экспорт шаблонов совместим с JSON из ТЗ', () => {
    const saved = TemplateManager.saveTemplate(example(), 'Утро', 'template');
    const exported = exportTemplates(saved);
    equal(Object.keys(exported).join(','), 'templates');
    equal(Object.keys(exported.templates[0].tasks[0]).join(','), 'name,minTime,maxTime');
    const imported = parseImport(JSON.stringify(exported), () => 'imported');
    equal(imported.kind, 'templates');
    equal(imported.templates[0].tasks[1].maxTime, 25);
  });

  test('Отметка паузы сохраняется, а старый снимок остаётся читаемым', () => {
    const running = Timer.startTimer(plan(['a', 2, 4]), T);
    const paused = Timer.pauseTimer(running, T + mins);
    const restored = readState(JSON.parse(JSON.stringify(paused)));
    const view = metrics(restored, T + 2 * mins);
    equal(view.pauseMs, mins);
    equal(view.timing.optimistic, mins);
    equal(view.guarded - view.protectedFinish, mins);
    delete paused.timer.pausedSince;
    equal(metrics(readState(paused), T + 2 * mins).pauseMs, null);
  });

  test('Исключённая задача освобождает прогноз, но остаётся в результатах', () => {
    const running = Timer.startTimer(plan(['a', 2, 4], ['b', 3, 5]), T);
    const skipped = Timer.excludeTask(running, T + mins);
    const view = metrics(skipped, T + mins);
    equal(view.completed, 0);
    equal(view.task.name, 'b');
    equal(view.guarded, T + 6 * mins);
    equal(view.protectedFinish, T + 9 * mins);
    const done = Timer.completeTask(skipped, T + 2 * mins);
    const repeated = readState(Timer.repeatPlan(done));
    equal(repeated.pastRuns[0].tasks[0].excluded, true);
    equal(repeated.tasks[0].done, false);
  });

  test('Предельная оценка не повреждает историю и резервную копию', () => {
    const running = Timer.startTimer(plan(['a', 1, 150_000_000_000]), T);
    const next = TaskManager.newPlan(Timer.completeTask(running, T + mins));
    const restored = parseImport(JSON.stringify(exportBackup(next, T + 2 * mins))).state;
    equal(restored.pastRuns[0].protectedFinish, null);
    equal(restored.pastRuns[0].tasks[0].name, 'a');
  });

  test('Импорт проверяет весь файл и поддерживает BOM', () => {
    rejects(() => parseImport('{'));
    rejects(() => parseImport('null'));
    rejects(() => parseImport('{"templates":[{"name":"T","tasks":[{"name":"X","minTime":4,"maxTime":1}]}]}'));
    rejects(() => parseImport('{"templates":[{"name":"T","tasks":[{"name":"X","minTime":"1","maxTime":2}]}]}'));
    equal(parseImport('\uFEFF{"templates":[]}').templates.length, 0);
  });

  test('Резервная копия сохраняет выполнение на паузе без остановки живого таймера', () => {
    let state = Timer.startTimer(example(), T);
    state = Timer.setRemaining(state, T + 3 * mins, 4 * mins);
    const restored = parseImport(JSON.stringify(exportBackup(state, T + 5 * mins))).state;
    equal(state.timer.phase, 'running');
    equal(restored.timer.phase, 'paused');
    equal(metrics(restored, T + 12 * mins).activeElapsed, 5 * mins);
    equal(metrics(restored, T + 12 * mins).activeLeft, 2 * mins);
    equal(restored.timer.points.length, 2);
  });

  test('Сохранённый работающий таймер восстанавливается по меткам времени', () => {
    let state = Timer.startTimer(example(), T);
    state = Timer.setRemaining(state, T + 4 * mins, 5 * mins);
    const restored = readState(JSON.parse(JSON.stringify(state)));
    equal(restored.timer.phase, 'running');
    equal(metrics(restored, T + 6 * mins).activeElapsed, 6 * mins);
    equal(metrics(restored, T + 6 * mins).activeLeft, 3 * mins);
  });

  test('StateManager сохраняет перед уведомлением и загружает без потерь', () => {
    const storage = memoryStore();
    const state = new StateManager(storage);
    let notifications = 0;
    const off = state.subscribe(next => {
      notifications++;
      equal(JSON.parse(storage.getItem(STORAGE_KEY)).tasks[0].name, next.tasks[0].name);
    });
    equal(state.setState(example(), 'Tests.store', T), true);
    off();
    equal(state.getState().tasks.length, 3);
    equal(new StateManager(storage).getState().tasks[2].id, 'c');
    equal(notifications, 1);
  });

  test('Устаревшая вкладка не перезаписывает уже сохранённые данные', () => {
    const storage = memoryStore();
    const first = new StateManager(storage);
    const second = new StateManager(storage);
    equal(first.setState(example(), 'Tests.first', T), true);
    equal(second.setState(plan(['x', 1, 2]), 'Tests.second', T), false);
    equal(second.getState().tasks[0].id, 'a');
    equal(new StateManager(storage).getState().tasks.length, 3);
  });

  test('Старый формат локальных задач загружается как черновик', () => {
    const restored = readState({tasks: [{name: 'Старый план', optimisticEstimate: 1, pessimisticEstimate: 5}], templates: []}, () => 'old');
    equal(restored.timer.phase, 'idle');
    equal(restored.tasks[0].id, 'old');
    equal(restored.tasks[0].maxTime, 5);
  });

  test('К нулю интервал между началами пиков стремится к длине пика', () => {
    equal(beepInterval(100), 3000);
    equal(beepInterval(50), 1550);
    equal(beepInterval(1), 129);
    equal(beepInterval(0), PULSE_SECONDS * 1000);
  });

  test('Отсчёты задачи используют её оценки независимо от общего резерва', () => {
    const ready = plan(['a', 10, 20], ['b', 10, 80]);
    const started = Timer.startTimer(ready, T);
    const at = T + 15 * mins;
    const view = metrics(started, at);
    equal(view.timing.optimistic, -5 * mins);
    equal(view.timing.guarded, 5 * mins);
    equal(view.timing.reserve, 10 * mins);
    equal(view.percentLeft, 93.75);
    equal(metrics(Timer.pauseTimer(started, at), at + mins).timing.guarded, 5 * mins);
    equal(metrics(Timer.setRemaining(started, at, 3 * mins), at).timing.guarded, 13 * mins);
    equal(metrics(Timer.completeTask(started, at), at).timing.optimistic, 10 * mins);
  });

  test('Обещанный финиш с буфером закреплён, просрочка задачи требует новой оценки', () => {
    const ready = plan(['a', 10, 20], ['b', 10, 30]);
    const promise = T + 50 * mins;
    equal(metrics(ready, T).protectedFinish, promise);
    const started = Timer.startTimer(ready, T);
    const at = T + 21 * mins;
    const view = metrics(started, at);
    equal(view.protectedFinish, promise);
    equal(view.estimateExhausted, true);
    equal(deadlineStatus(view, at + 60 * mins, 'running').label, 'Нужно уточнить остаток');
    const revised = metrics(Timer.setRemaining(started, at, 4 * mins), at);
    equal(revised.estimateExhausted, false);
    equal(revised.protectedFinish, promise);
    equal(revised.guarded, at + 44 * mins);
    equal(riskPosition(50, 25, 0), 100 / 3);
    equal(riskPosition(50, 75, 0), 200 / 3);
    equal(riskPosition(50, 110, 0), 100);
  });

  test('При исчерпании запаса задачи текущий пик переходит в один непрерывный тон', () => {
    const {live, manager, tones} = soundFixture({foreground: true, optimisticMs: -9.9 * mins, guardedMs: 0.1 * mins});
    try {
      manager.sync();
      const lastPulse = tones[0];
      equal(lastPulse.length, PULSE_SECONDS);
      live.guardedMs = 0;
      manager.context.currentTime += 0.05;
      manager.sync();
      const steady = tones[1];
      equal(steady.at, lastPulse.at + lastPulse.length);
      equal(steady.length, null);
      equal(steady.frequency, BUFFER_TONE_HZ);
      equal(manager.pending, null);
      live.guardedMs = -500;
      manager.sync();
      equal(tones.length, 2);
      live.running = false;
      manager.sync();
      assert(steady.cancelled && lastPulse.cancelled);
      equal(manager.pulse, null);
    } finally {
      manager.stop();
    }
  });

  test('Смена задачи гасит писк и ставит порог новой задачи', () => {
    const {live, manager, tones} = soundFixture({foreground: true, optimisticMs: -11 * mins, guardedMs: -mins});
    try {
      manager.sync();
      const steady = tones[0];
      equal(steady.length, null);
      manager.context.currentTime += 1;
      live.focusKey = 'b';
      live.optimisticMs = mins;
      live.guardedMs = 11 * mins;
      manager.sync();
      assert(steady.cancelled);
      equal(tones.length, 3);
      equal(tones[1].at, 66);
      equal(manager.pulse, null);
      live.enabled = false;
      manager.sync();
      assert(tones[tones.length - 1].cancelled);
      equal(manager.pending, null);
    } finally {
      manager.stop();
    }
  });

  test('Пороговый двойной сигнал задачи планируется в фоне', () => {
    const {live, manager, tones} = soundFixture({optimisticMs: mins});
    manager.sync();
    equal(tones.length, 2);
    equal(tones[0].at, 65);
    assert(Math.abs(tones[1].at - 65.23) < 0.000001);
    equal(manager.pending, null);
    live.optimisticMs = -1000;
    manager.context.currentTime = 66;
    manager.sync();
    manager.sync();
    equal(tones.length, 2);
  });

  test('При равных оценках двойной сигнал переходит в писк на границе задачи', () => {
    const {live, manager, tones} = soundFixture({foreground: true, reserveMs: 0, optimisticMs: 1000, guardedMs: 1000});
    try {
      manager.sync();
      equal(tones[0].at, 6);
      manager.context.currentTime = 6;
      live.optimisticMs = live.guardedMs = 0;
      manager.sync();
      equal(tones.length, 3);
      equal(tones[2].length, null);
      equal(tones[2].at, tones[1].at + tones[1].length);
    } finally {
      manager.stop();
    }
  });

  test('Пауза переносит пороговый сигнал, а выключение отменяет его', () => {
    const {live, manager, tones} = soundFixture({optimisticMs: mins});
    manager.sync();
    manager.context.currentTime = 15;
    live.optimisticMs -= 10_000;
    live.running = false;
    manager.sync();
    assert(tones.slice(0, 2).every(tone => tone.cancelled));
    manager.context.currentTime = 25;
    live.running = true;
    manager.sync();
    equal(tones[2].at, 75);
    live.enabled = false;
    manager.sync();
    assert(tones.slice(2).every(tone => tone.cancelled));
    equal(manager.alarm, null);
  });

  test('Тестовый сигнал доступен при выключенных оповещениях', () => {
    const {manager, tones} = soundFixture({enabled: false, running: false});
    manager.playPreview();
    equal(tones.length, 2);
    equal(manager.pending, null);
    equal(manager.alarm, null);
    assert(tones.every(tone => !tone.cancelled));
    manager.stop();
    assert(tones.every(tone => tone.cancelled));
  });

  test('Время финиша после полуночи показывает следующий день', () => {
    const now = new Date(2026, 10, 8, 23, 55).getTime();
    const finish = metrics(example(), now).earliest;
    equal(timeParts(finish, now).time, '00:25');
    assert(timeParts(finish, now).day.includes('9'));
  });

  test('График и строки экранируют ввод и удерживают крайние точки', () => {
    const task = makeTask(taskFields({name: '<img src=x onerror=alert(1)>', minTime: 1, maxTime: 2}), 'x');
    assert(pendingRow(task, 0, 1).includes('&lt;img'));
    assert(!pendingRow(task, 0, 1).includes('<img'));
    equal(chartPoint(100, 110), chartPoint(100, 100));
    equal(chartPoint(0, -10), chartPoint(0, 0));
    assert(chartSetup().includes(t('Готовность, %')));
  });

  test('Язык по системе и ручной выбор сохраняются в данных плана', () => {
    equal(resolveLanguage('system', 'ru-RU'), 'ru');
    equal(resolveLanguage('system', 'en-GB'), 'en');
    equal(resolveLanguage('system', 'fr-FR'), 'en');
    equal(resolveLanguage('en', 'ru'), 'en');
    equal(resolveLanguage('ru', 'en'), 'ru');
    const old = emptyState();
    delete old.settings.language;
    equal(readState(old).settings.language, 'system');
    const plan = {...example(), settings: {...old.settings, language: 'en'}};
    equal(readState(plan).settings.language, 'en');
    equal(parseImport(JSON.stringify(exportBackup(plan, T))).state.settings.language, 'en');
    equal(TaskManager.newPlan(plan).settings.language, 'en');
  });

  console.info(`[INFO] Tests.run: Пройдено ${passed} из ${total}`);
  console.groupEnd();
  return {passed, total};
}
