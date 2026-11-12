const $ = id => document.getElementById(id);
const androidBridge = typeof window === 'undefined' ? null : window.UspevatorAndroid;
const escapeHtml = value => String(value).replace(/[&<>"']/g, char =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[char]);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const shortDate = new Intl.DateTimeFormat('ru-RU', {day: 'numeric', month: 'short'});
const minutesLabel = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 4});
const percentLabel = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 1});
const pad = value => String(value).padStart(2, '0');

function display(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function fieldError(element, message = '') {
  display(element, message);
  element.hidden = !message;
}

function duration(ms, precise = false) {
  const seconds = Math.floor(Math.abs(ms) / 1000);
  if (seconds === 0 && ms !== 0) return '<1 с';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = seconds % 60;
  const parts = [];
  if (days) parts.push(`${days} д`);
  if (hours) parts.push(`${hours} ч`);
  if (minutes) parts.push(`${minutes} мин`);
  if ((precise || !parts.length) && rest) parts.push(`${rest} с`);
  return parts.join(' ') || '0 с';
}

function fmtClock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(pad).join(':');
}

function fmtCountdown(ms) {
  const time = fmtClock(Math.abs(ms));
  return (ms <= -1000 ? '−' : '') + (Math.abs(ms) < 3_600_000 ? time.slice(3) : time);
}

function localDay(ts) {
  const date = new Date(ts);
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localDateValue(ts) {
  if (!isStamp(ts)) return '';
  const date = new Date(ts);
  return `${localDay(ts)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function readLocalDate(value, label) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  if (!isStamp(ts) || localDateValue(ts) !== value) throw new Error(`${label}. Проверьте дату и время.`);
  return ts;
}

function timeParts(ts, now) {
  if (!isStamp(ts)) return {time: '—', day: ''};
  const date = new Date(ts);
  const day = localDay(ts) === localDay(now) ? '' : shortDate.format(date);
  return {time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    day: day && date.getFullYear() !== new Date(now).getFullYear() ? `${day} ${date.getFullYear()}` : day};
}

function fullTime(ts, now) {
  const {time, day} = timeParts(ts, now);
  return day ? `${time} · ${day}` : time;
}

function rangeLabel(task) {
  return `${minutesLabel.format(task.minTime)}–${minutesLabel.format(task.maxTime)} мин`;
}

function percentage(value) {
  const rounded = Math.round(value * 10) / 10;
  if (value !== 0 && rounded === 0) return value < 0 ? '−<0,1%' : '<0,1%';
  return `${rounded < 0 ? '−' : ''}${percentLabel.format(Math.abs(rounded))}%`;
}

const CHART = {left: 40, right: 410, top: 20, bottom: 133};
const chartX = value => CHART.left + clamp(value, 0, 100) / 100 * (CHART.right - CHART.left);
const chartY = value => CHART.bottom - clamp(value, 0, 100) / 100 * (CHART.bottom - CHART.top);
const chartPoint = (x, y) => `${chartX(x).toFixed(2)},${chartY(y).toFixed(2)}`;

function chartSetup() {
  const polygon = (zone, points) => `<polygon class="zone-${zone}" points="${points.map(point => chartPoint(...point)).join(' ')}"/>`;
  const grid = [0, 25, 50, 75, 100].map(n => `
    <line class="grid" x1="${CHART.left}" x2="${CHART.right}" y1="${chartY(n)}" y2="${chartY(n)}"/>
    <text x="34" y="${chartY(n) + 3.5}" text-anchor="end">${n}</text>
    <line class="grid" x1="${chartX(n)}" x2="${chartX(n)}" y1="${CHART.top}" y2="${CHART.bottom}"/>
    <text x="${chartX(n)}" y="148" text-anchor="${n === 100 ? 'end' : 'middle'}">${n}</text>
  `).join('');
  return `
    <text x="40" y="12" class="axis-label">Расход, %</text>
    ${polygon('green', [[0, 0], [100, 0], [100, 45], [0, 5]])}
    ${polygon('yellow', [[0, 5], [100, 45], [100, 95], [0, 55]])}
    ${polygon('red', [[0, 55], [100, 95], [100, 100], [0, 100]])}
    ${grid}
    <path class="axes" d="M${CHART.left},${CHART.top} V${CHART.bottom} H${CHART.right}"/>
    <path class="boundary" d="M${chartPoint(0, 5)} L${chartPoint(100, 45)} M${chartPoint(0, 55)} L${chartPoint(100, 95)}"/>
    <text x="410" y="167" text-anchor="end" class="axis-label">Готовность, %</text>
    <polyline id="chart-trend" class="trend" points=""/>
    <g id="chart-history"></g>
    <g id="chart-current" transform="translate(40 133)">
      <circle class="live-halo" r="10"/><circle class="live-dot" r="5.6"/><title></title>
    </g>`;
}

const RISK_COPY = {
  green: ['В норме', 'Резерв расходуется в пределах зелёной зоны.'],
  yellow: ['Нужно внимание', 'Уточните остаток работы и решите, что можно перенести.'],
  red: ['Нужно вмешаться', 'Пересмотрите объём оставшихся задач или срок.'],
  over: ['Перерасход', 'Расчётный финиш вышел за пределы защищённого.'],
  neutral: ['Без резерва', 'У базовых оценок нет запаса. Расход показан в минутах.']
};
const PHASE_COPY = {
  idle: ['Планирование', 'purple', 'Готовность к старту'],
  running: ['В работе', 'green', 'Сейчас в фокусе'],
  paused: ['На паузе', 'yellow', 'Таймер на паузе'],
  done: ['Завершён', 'green', 'Итог дня']
};

const DEMO = [
  {name: 'Подготовить заметку к встрече', minTime: 15, maxTime: 25, firstStep: 'Открыть прошлый протокол и выписать три открытых вопроса.'},
  {name: 'Ответить на важные письма', minTime: 20, maxTime: 35, firstStep: 'Найти письма, от которых зависит чужая работа.'},
  {name: 'Проверить черновик плана', minTime: 25, maxTime: 40, firstStep: 'Открыть план и отметить ближайший срок.'}
];

function rowButton(action, glyph, label, attrs = '', disabled = false) {
  return `<button class="btn btn-quiet icon-btn${action === 'drag' ? ' drag-handle' : ''}" type="button"
    data-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" ${attrs} ${disabled ? 'disabled' : ''}>${icon(glyph)}</button>`;
}

function pendingRow(task, index, count) {
  const attrs = `data-id="${escapeHtml(task.id)}"`;
  return `<li class="task-row" data-drop-task="${escapeHtml(task.id)}">
    ${rowButton('drag', 'grip', 'Порядок задачи. Перетащите или нажмите стрелку вверх или вниз', `${attrs} data-drag="task"`, count < 2)}
    <div class="task-text"><span class="task-title">${escapeHtml(task.name)}</span>
      <span class="task-meta">(${rangeLabel(task)})${task.workedMs ? ` · уже потрачено ${escapeHtml(duration(task.workedMs, true))}` : ''}</span></div>
    <div class="task-actions">
      ${rowButton('move-up', 'up', 'Выше в очереди', attrs, index === 0)}
      ${rowButton('move-down', 'down', 'Ниже в очереди', attrs, index === count - 1)}
      ${rowButton('edit', 'edit', 'Редактировать задачу', attrs)}
      ${rowButton('delete', 'trash', 'Удалить задачу', attrs)}
    </div></li>`;
}

function historyRow(task) {
  const delta = task.workedMs - asMs(task.minTime);
  const difference = task.excluded ? 'исключена из плана' : delta === 0 ? 'по базовой оценке'
    : `${delta < 0 ? 'экономия' : 'сверх базы'} ${escapeHtml(duration(delta, true))}`;
  return `<li class="task-row"><span class="row-mark">${icon('check')}</span>
    <div class="task-text"><span class="task-title">${escapeHtml(task.name)}</span><span class="task-meta">(${rangeLabel(task)}) · ${difference}</span></div>
    <span class="fact-time">${escapeHtml(duration(task.workedMs, true))}</span></li>`;
}

function formValues(form) {
  const values = {};
  new FormData(form).forEach((value, key) => { values[key] = value; });
  return values;
}

function downloadJson(data, filename) {
  if (androidBridge) {
    androidBridge.exportJson(filename, JSON.stringify(data, null, 2) + '\n');
    return;
  }
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

class UIManager {
  constructor(store) {
    this.store = store;
    this.dialog = $('action-dialog');
    this.dialogAction = null;
    this.toastTimeout = null;
    this.lastPoints = null;
    this.finishAfter = 0;
    this.undo = null;
    this.sound = androidBridge ? {
      ready: true,
      unlock: preview => Promise.resolve(!preview || androidBridge.testSignal()),
      sync() {},
      stop() {}
    } : new SoundManager(() => {
      const state = this.store.getState();
      const task = activeTask(state);
      const timing = task ? taskTiming(task, state.timer, wallTime()) : null;
      return {
        enabled: state.settings.sound, running: state.timer.phase === 'running',
        foreground: !document.hidden,
        runId: state.timer.startedAt, focusKey: task ? JSON.stringify([task.id, task.referenceMs, task.remainingMs]) : null,
        optimisticMs: timing?.optimistic, guardedMs: timing?.guarded, reserveMs: timing?.reserve
      };
    }, error => {
      log('WARN', 'SoundManager.unlock', 'Звук недоступен', error, this.store.getState().settings.logLevel);
      this.toast('Браузер не включил звук. Таймер продолжает работать.');
    }, () => this.renderSound(this.store.getState().settings));
    this.drag = new DragManager(this);
    $('chart').innerHTML = chartSetup();
    this.bind();
    this.store.subscribe((next, previous, operation) => this.render(next, previous, operation));
    this.render(this.store.getState(), null, 'init');
    setInterval(() => this.tick(), 1000);
  }

  toast(message) {
    const box = $('toast');
    clearTimeout(this.toastTimeout);
    box.hidden = false;
    display(box, message);
    this.toastTimeout = setTimeout(() => { box.hidden = true; }, 4400);
  }

  commit(operation, transform, scopeChange = false) {
    const now = wallTime();
    const current = this.store.getState();
    const next = transform(current, now);
    if (next === current) return false;
    const updated = scopeChange
      ? recordPoint({...next, timer: recordPoint(current, now).timer}, now) : next;
    if (!this.store.setState(updated, operation, now)) {
      this.toast($('storage-warning').hidden ? 'План обновился. Повторите действие.' : 'Не удалось сохранить изменение.');
      return false;
    }
    return true;
  }

  bind() {
    document.addEventListener('click', event => {
      const menu = $('app-menu');
      const button = event.target.closest('button[data-action]');
      if (!menu.contains(event.target) || button) menu.open = false;
      if (event.isTrusted && button?.dataset.action !== 'sound' && button?.dataset.action !== 'sound-test'
          && this.store.getState().settings.sound && !this.sound.ready) {
        void this.sound.unlock();
      }
      if (button && !button.disabled) {
        try { this.handle(button); }
        catch (error) { this.report('UIManager.handle', error); }
      }
    });
    document.addEventListener('keydown', event => {
      const menu = $('app-menu');
      if (event.key === 'Escape' && menu.open) {
        menu.open = false;
        menu.querySelector('summary').focus();
      }
    });
    $('plan-details').addEventListener('toggle', () => {
      if ($('plan-details').open) this.tick();
    });
    $('add-form').addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        const fields = taskFields(formValues(form), true);
        const id = uid();
        if (this.commit('TaskManager.createTask', state => TaskManager.createTask(state, fields, id), true)) {
          form.reset();
          $('add-step').open = false;
          fieldError($('add-error'));
          $('task-name').focus();
        }
      } catch (error) {
        const message = $('add-error');
        this.report('UIManager.addTask', error, message);
        const bounds = message.getBoundingClientRect();
        const viewport = window.visualViewport;
        const top = viewport?.offsetTop ?? 0;
        const bottom = top + (viewport?.height ?? innerHeight);
        if (bounds.top < top || bounds.bottom > bottom) message.scrollIntoView({block: 'center'});
      }
    });
    $('add-form').addEventListener('input', () => fieldError($('add-error')));
    $('window-form').addEventListener('submit', event => {
      event.preventDefault();
      try {
        const values = formValues(event.currentTarget);
        const current = this.store.getState();
        const start = current.timer.phase === 'idle' ? readLocalDate(values.start, 'Старт') : current.window.start;
        const finish = readLocalDate(values.finish, 'Крайний срок');
        if (start !== null && finish !== null && finish < start) throw new Error('Крайний срок должен быть после старта или совпадать с ним.');
        if (this.commit('UIManager.saveWindow', state => ({...state, window: {start, finish}}))) {
          $('window-details').open = false;
          this.toast('Окно дня сохранено.');
        }
      } catch (error) { this.report('UIManager.saveWindow', error, $('window-error')); }
    });
    $('dialog-form').addEventListener('submit', event => {
      event.preventDefault();
      try {
        if (this.dialogAction?.(formValues(event.currentTarget)) !== false) this.dialog.close();
      } catch (error) { this.report('UIManager.submitDialog', error, $('dialog-error')); }
    });
    this.dialog.addEventListener('close', () => { this.dialogAction = null; });
    const templatePicker = $('template-picker');
    templatePicker.addEventListener('close', () => {
      if (!templatePicker.open) document.documentElement.classList.remove('template-picker-open');
    });
    $('log-level').addEventListener('change', event => {
      const level = event.currentTarget.value;
      this.commit('UIManager.logLevel', state => ({...state, settings: {...state.settings, logLevel: level}}));
    });
    $('import-file').addEventListener('change', event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (file) void this.importFile(file);
    });
    document.addEventListener('visibilitychange', () => this.tick());
    window.addEventListener('pageshow', () => this.tick());
    window.addEventListener('storage', event => {
      if (event.key === STORAGE_KEY || event.key === null) this.store.acceptStorage(event.newValue);
    });
    window.addEventListener('error', event => {
      if (event.error) log('ERROR', 'Window.error', event.message, event.error, this.store.getState().settings.logLevel);
    });
  }

  report(module, error, field = null) {
    log('WARN', module, error.message, error, this.store.getState().settings.logLevel);
    if (field) fieldError(field, error.message);
    else this.toast(error.message);
  }

  openDialog({title, body, confirm = 'Сохранить', danger = false, action}) {
    display($('dialog-title'), title);
    $('dialog-body').innerHTML = body;
    const button = $('dialog-confirm');
    button.hidden = !action;
    display(button, confirm);
    button.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    fieldError($('dialog-error'));
    this.dialogAction = action;
    if (!this.dialog.open) this.dialog.showModal();
    const focus = $('dialog-body').querySelector('input') || this.dialog.querySelector('[data-action="close-dialog"]');
    focus.focus();
    if (focus.matches('input[type="text"], input:not([type])')) focus.select();
  }

  confirm(title, copy, confirm, action, danger = false) {
    this.openDialog({title, body: `<p class="dialog-copy">${escapeHtml(copy)}</p>`, confirm, action, danger});
  }

  handle(button) {
    const action = button.dataset.action;
    const id = button.dataset.id;
    const state = this.store.getState();
    const task = state.tasks.find(item => item.id === id);
    const template = state.templates.find(item => item.id === id);
    switch (action) {
      case 'go-add':
        if ($('template-picker').open) $('template-picker').close();
        $('queue-details').open = true;
        $('task-name').focus();
        break;
      case 'choose-template':
        this.openTemplatePicker(state);
        break;
      case 'close-template-picker':
        $('template-picker').close();
        break;
      case 'show-templates':
        if ($('template-picker').open) $('template-picker').close();
        this.showTemplates();
        break;
      case 'go-queue':
        $('queue-details').open = true;
        this.reveal($('queue-disclosure'));
        break;
      case 'plan-details':
        $('plan-details').open = true;
        $('plan-disclosure').focus();
        break;
      case 'task-actions':
        this.openTaskActions(state);
        break;
      case 'data':
        $('data-dialog').showModal();
        break;
      case 'close-data':
        $('data-dialog').close();
        break;
      case 'run-history':
        this.showHistory(state);
        break;
      case 'close-runs':
        $('runs-dialog').close();
        break;
      case 'help':
        $('help-dialog').showModal();
        break;
      case 'close-help':
        $('help-dialog').close();
        break;
      case 'close-dialog':
        this.dialog.close();
        break;
      case 'sound': {
        if (state.settings.sound && !this.sound.ready) {
          void this.sound.unlock(true);
          break;
        }
        const enabled = !state.settings.sound;
        if (this.commit('SoundManager.toggle', current => ({...current, settings: {...current.settings, sound: enabled}}))) {
          if (enabled && !androidBridge) void this.sound.unlock(true);
          else this.sound.stop();
        }
        break;
      }
      case 'sound-test':
        void this.sound.unlock(true).then(ready => {
          if (ready) this.toast('Тестовый двойной сигнал.');
        });
        break;
      case 'start':
        if (this.commit('Timer.startTimer', (current, now) => Timer.startTimer(current, now))) {
          clearTimeout(this.toastTimeout);
          $('toast').hidden = true;
        }
        break;
      case 'pause':
        this.commit('Timer.pauseTimer', (current, now) => Timer.pauseTimer(current, now));
        break;
      case 'finish':
        if (performance.now() >= this.finishAfter
            && this.commit('Timer.completeTask', (current, now) => Timer.completeTask(current, now))) {
          this.finishAfter = performance.now() + 400;
          if (!androidBridge) this.undo = {previous: state, result: this.store.getState(), until: performance.now() + 8000};
          this.renderUndo();
        }
        break;
      case 'undo':
        if (androidBridge) {
          if (androidBridge.undoFinish(this.store.raw || '')) {
            this.store.acceptStorage(androidBridge.readPlan() || null);
            this.toast('Завершение отменено.');
          } else this.renderUndo();
        } else if (this.canUndo() && this.commit('Timer.undoFinish', () => this.undo.previous)) {
          this.undo = null;
          this.renderUndo();
          this.toast('Завершение отменено.');
        }
        break;
      case 'skip':
        if (this.commit('Timer.skipTask', (current, now) => Timer.skipTask(current, now))) {
          if (this.dialog.open) this.dialog.close();
          this.toast('Задача перенесена в конец очереди.');
        }
        break;
      case 'exclude': {
        const active = activeTask(state);
        if (active) this.confirm('Исключить задачу из плана?',
          '«' + active.name + '» будет отмечена как исключённая. Прогноз учтёт оставшиеся задачи.',
          'Исключить', () => this.commit('Timer.excludeTask', (current, now) =>
            current.timer.activeId === active.id ? Timer.excludeTask(current, now) : current), true);
        break;
      }
      case 'repeat':
        if (this.commit('Timer.repeatPlan', current => Timer.repeatPlan(current))) {
          window.scrollTo(0, 0);
          this.toast('Список готов к новому запуску.');
        }
        break;
      case 'reset': {
        this.confirm('Сбросить выполнение?',
          'Задачи вернутся в очередь. Таймер, история выполнения и график начнутся с нуля.',
          'Сбросить',
          () => this.commit('Timer.resetTimer', current => Timer.resetTimer(current)), true);
        break;
      }
      case 'new-plan':
        this.newPlan(state);
        break;
      case 'save-and-new':
        this.editTemplate(null, true);
        break;
      case 'remaining':
        if (activeTask(state)) this.editRemaining(state);
        break;
      case 'edit':
        if (task) this.editTask(task);
        break;
      case 'delete':
        if (task) this.confirm('Удалить задачу?', `«${task.name}» исчезнет из плана дня.`, 'Удалить',
          () => this.commit('TaskManager.deleteTask', current => TaskManager.deleteTask(current, id), true), true);
        break;
      case 'move-up':
      case 'move-down':
        this.moveBy(id, action === 'move-up' ? -1 : 1, action);
        break;
      case 'demo':
        if (!state.tasks.length) {
          const tasks = DEMO.map(item => makeTask(item, uid()));
          this.commit('TaskManager.loadDemo', current => ({...current, tasks, timer: emptyTimer()}));
          this.toast('Пример загружен. Можно менять задачи и запускать таймер.');
        }
        break;
      case 'clear-window':
        this.commit('UIManager.clearWindow', current => ({
          ...current, window: {start: current.timer.phase === 'idle' ? null : current.window.start, finish: null}
        }));
        break;
      case 'save-template':
        this.editTemplate();
        break;
      case 'overwrite-template':
        if (template) this.editTemplate(template);
        break;
      case 'apply-template':
        if (template) this.applyTemplate(template);
        break;
      case 'delete-template':
        if (template) this.confirm('Удалить шаблон?', `«${template.name}» исчезнет из набора шаблонов.`, 'Удалить',
          () => this.commit('TemplateManager.deleteTemplate', current => TemplateManager.deleteTemplate(current, id)), true);
        break;
      case 'copy-template-task':
        this.copyTemplateTask(id, Number(button.dataset.index), null);
        break;
      case 'import':
        if ($('data-dialog').open) $('data-dialog').close();
        if (androidBridge) androidBridge.importJson();
        else $('import-file').click();
        break;
      case 'export':
        downloadJson(exportTemplates(state), 'uspevator_data.json');
        break;
      case 'backup':
        downloadJson(exportBackup(state, wallTime()), 'uspevator_backup.json');
        break;
      case 'tests': {
        const result = runSelfTests();
        display($('test-result'), `Пройдено ${result.passed} из ${result.total}. Подробности в консоли.`);
        break;
      }
    }
  }

  canUndo() {
    if (androidBridge) return androidBridge.canUndoFinish(this.store.raw || '');
    return this.undo && this.undo.result === this.store.getState() && performance.now() < this.undo.until;
  }

  renderUndo() {
    const available = Boolean(this.canUndo());
    $('undo-finish').hidden = !available;
    if (!available) this.undo = null;
  }

  openTaskActions(state) {
    const task = activeTask(state);
    if (!task) return;
    const canDefer = state.tasks.some(task => !task.done && task.id !== state.timer.activeId);
    const description = '<div class="task-menu-info"><p><strong>' + escapeHtml(task.name) + '</strong></p>'
      + (task.firstStep ? '<p class="dialog-copy"><b>Первый шаг</b> · ' + escapeHtml(task.firstStep) + '</p>' : '') + '</div>';
    this.openDialog({
      title: 'Действия с задачей',
      body: description + '<div class="task-menu-actions">'
        + '<button type="button" class="btn btn-soft" data-action="remaining">Уточнить остаток</button>'
        + '<button type="button" class="btn btn-quiet" data-action="skip" ' + (canDefer ? '' : 'disabled') + '>В конец очереди</button>'
        + '<button type="button" class="btn btn-quiet" data-action="exclude">Исключить из плана</button>'
        + '<button type="button" class="btn btn-quiet" data-action="reset">Сбросить весь план</button></div>'
    });
  }

  showHistory(state) {
    const runs = archiveCompleted(state).pastRuns ?? [];
    $('run-history').innerHTML = runs.length ? [...runs].reverse().map(run => {
      const finished = fullTime(run.finishedAt, wallTime());
      const count = run.tasks.filter(task => !task.excluded).length;
      return '<details class="run-entry"><summary><strong>' + escapeHtml(finished) + '</strong>'
        + '<span>' + count + ' из ' + run.tasks.length + ' задач</span>' + icon('chev') + '</summary>'
        + '<p class="subtext">Обещано к ' + escapeHtml(fullTime(run.protectedFinish, wallTime())) + '</p>'
        + '<ul>' + run.tasks.map(task => '<li>' + escapeHtml(task.name) + ' · '
          + (task.excluded ? 'исключена' : duration(task.workedMs, true)) + '</li>').join('') + '</ul></details>';
    }).join('') : '<p class="subtext">Здесь появятся результаты завершённых планов.</p>';
    $('runs-dialog').showModal();
  }

  editRemaining(state) {
    const view = metrics(state, wallTime());
    const value = Math.ceil(view.activeLeft / 600) / 100;
    this.openDialog({
      title: 'Уточнить остаток',
      body: `<div class="dialog-fields"><p class="dialog-copy">Оцените, сколько минут ещё нужно для текущей задачи. Это обновит прогноз и положение на графике.</p>
      <label class="field"><span>Осталось, мин</span><input name="remaining" inputmode="decimal" value="${value}" required></label></div>`,
      action: values => {
        const remainingMs = asMs(estimate(values.remaining, 'Остаток', true));
        return this.commit('Timer.setRemaining', (current, now) => Timer.setRemaining(current, now, remainingMs));
      }
    });
  }

  editTask(task) {
    const field = (name, label, value, mode = '') => `<label class="field"><span>${label}</span>
      <input name="${name}" value="${escapeHtml(value)}" ${mode ? `inputmode="${mode}"` : ''} autocomplete="off"></label>`;
    this.openDialog({
      title: 'Редактировать задачу',
      body: `<div class="dialog-fields">
        ${field('name', 'Название', task.name)}
        <div class="estimate-pair">${field('minTime', 'Оптимистично, мин', task.minTime, 'decimal')}${field('maxTime', 'С запасом, мин', task.maxTime, 'decimal')}</div>
        ${field('firstStep', 'Первый шаг', task.firstStep)}
      </div>`,
      action: values => {
        const fields = taskFields(values, true);
        return this.commit('TaskManager.updateTask', state => TaskManager.updateTask(state, task.id, fields), true);
      }
    });
  }

  newPlan(state) {
    const create = () => {
      if (!this.commit('TaskManager.newPlan', current => TaskManager.newPlan(current))) return false;
      this.focusNewPlan();
      return true;
    };
    if (!state.tasks.length) {
      create();
      return;
    }
    this.openDialog({
      title: 'Новый список',
      body: `<div class="dialog-fields">
        <p class="dialog-copy">Текущий список будет заменён. Результаты завершённого плана доступны в истории планов. Задачи можно сохранить как шаблон.</p>
        <div><button class="btn btn-soft" type="button" data-action="save-and-new">${icon('layers')}Сохранить как шаблон и начать новый</button></div>
      </div>`,
      confirm: 'Создать пустой список',
      action: create
    });
  }

  reveal(control) {
    requestAnimationFrame(() => {
      if (!control.isConnected) return;
      control.focus({preventScroll: true});
      control.scrollIntoView({block: 'start'});
    });
  }

  showTemplates(templateId = null) {
    $('templates').open = true;
    const item = Array.from($('template-list').children).find(row => row.dataset.template === templateId);
    if (item) item.open = true;
    this.reveal(item ? item.querySelector('summary') : $('templates-summary'));
  }

  openTemplatePicker(state) {
    const dialog = $('template-picker');
    const choices = $('template-choices');
    const available = state.templates.filter(template => template.tasks.length > 0);
    const hasChoices = available.length > 0;
    display($('template-picker-description'), hasChoices
      ? 'Выберите набор для списка задач. Таймер запускается кнопкой «Начать».'
      : 'Шаблонов с задачами пока нет. Импортируйте JSON или соберите список и сохраните его как шаблон.');
    choices.hidden = !hasChoices;
    choices.innerHTML = available.map(template => {
      const count = template.tasks.length;
      const last = count % 10;
      const lastTwo = count % 100;
      const ending = lastTwo >= 11 && lastTwo <= 14 ? 'задач' : last === 1 ? 'задача' : last >= 2 && last <= 4 ? 'задачи' : 'задач';
      return '<li><button class="btn btn-soft template-choice" type="button" data-action="apply-template" data-id="'
        + escapeHtml(template.id) + '"><span><strong>' + escapeHtml(template.name) + '</strong><small>'
        + count + ' ' + ending + '</small></span>' + icon('arrow') + '</button></li>';
    }).join('');
    $('picker-add').hidden = hasChoices || state.tasks.length > 0 || state.timer.phase !== 'idle';
    $('picker-manage').hidden = state.templates.length === 0;
    const importer = $('picker-import');
    importer.className = hasChoices ? 'btn btn-quiet' : 'btn btn-primary';
    fieldError($('template-picker-error'));
    if (!dialog.open) {
      dialog.showModal();
      document.documentElement.classList.add('template-picker-open');
    }
    (choices.querySelector('button') || importer).focus({preventScroll: true});
  }

  resetPlanForm() {
    $('queue-details').open = true;
    $('add-form').reset();
    $('add-step').open = false;
    $('window-details').open = false;
    fieldError($('add-error'));
  }

  focusNewPlan() {
    this.resetPlanForm();
    requestAnimationFrame(() => $('task-name').focus());
    this.toast('Новый список готов. Добавьте задачи.');
  }

  editTemplate(template = null, andNewPlan = false) {
    this.openDialog({
      title: template ? 'Перезаписать шаблон' : 'Сохранить план как шаблон',
      body: `<div class="dialog-fields"><p class="dialog-copy">В шаблон попадут задачи текущего плана в их порядке, оценки и первые шаги.</p>
        <label class="field"><span>Название шаблона</span><input name="name" value="${escapeHtml(template?.name || '')}" placeholder="Например, утренний блок" autocomplete="off" required></label></div>`,
      confirm: andNewPlan ? 'Сохранить и создать новый' : template ? 'Перезаписать' : 'Сохранить',
      action: values => {
        const name = templateName(values.name);
        const state = this.store.getState();
        if (state.templates.some(item => item.id !== template?.id && item.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) {
          throw new Error('Шаблон с таким названием уже есть. Его можно перезаписать из списка шаблонов.');
        }
        const id = template?.id ?? uid();
        if (!this.commit('TemplateManager.saveTemplate', current => {
          const saved = TemplateManager.saveTemplate(current, name, id);
          return andNewPlan && saved !== current ? TaskManager.newPlan(saved) : saved;
        })) return false;
        if (andNewPlan) this.focusNewPlan();
        else {
          this.showTemplates(id);
          this.toast('Шаблон сохранён.');
        }
        return true;
      }
    });
  }

  applyTemplate(template) {
    if (!template.tasks.length) return;
    const picker = $('template-picker');
    const apply = () => {
      const ids = template.tasks.map(() => uid());
      if (!this.commit('TemplateManager.applyTemplate', state => TemplateManager.applyTemplate(state, template.id, ids))) return false;
      if (picker.open) picker.close();
      this.toast('Шаблон применён к плану дня.');
      this.resetPlanForm();
      requestAnimationFrame(() => {
        $('primary-action').focus({preventScroll: true});
        window.scrollTo(0, 0);
      });
      return true;
    };
    if (this.store.getState().tasks.length) {
      if (picker.open) picker.close();
      this.confirm('Заменить план дня?', `Шаблон «${template.name}» заменит задачи и сбросит выполнение текущего плана.`, 'Применить', apply);
    } else apply();
  }

  moveBy(id, delta, action) {
    const state = this.store.getState();
    const pending = state.tasks.filter(task => TaskManager.editable(state, task.id));
    const index = pending.findIndex(task => task.id === id);
    if (index < 0 || index + delta < 0 || index + delta >= pending.length) return;
    const beforeId = pending[delta < 0 ? index - 1 : index + 2]?.id ?? null;
    if (this.commit('TaskManager.moveTask', current => TaskManager.moveTask(current, id, beforeId))) {
      const row = Array.from($('pending-list').children).find(item => item.dataset.dropTask === id);
      const same = row?.querySelector(`button[data-action="${action}"]`);
      const focus = same && !same.disabled ? same : row?.querySelector('.drag-handle');
      focus?.focus();
    }
  }

  copyTemplateTask(id, index, beforeId) {
    const state = this.store.getState();
    const task = state.templates.find(template => template.id === id)?.tasks[index];
    if (!task) return;
    const newId = uid();
    if (this.commit('TaskManager.copyTemplateTask', current => TaskManager.createTask(current, task, newId, beforeId), true)) {
      this.toast('Задача скопирована в план дня.');
    }
  }

  async importFile(file) {
    const picker = $('template-picker');
    try {
      const imported = parseImport(await file.text());
      if (imported.kind === 'templates') {
        this.confirm('Импортировать шаблоны?', `В файле ${imported.templates.length} шт. Набор шаблонов будет заменён, а текущий план сохранится.`,
          'Импортировать', () => {
            if (!this.commit('ImportExportManager.importTemplates', state => ({...state, templates: imported.templates}))) return false;
            if (picker.open) requestAnimationFrame(() => {
              if (picker.open) this.openTemplatePicker(this.store.getState());
            });
            else this.showTemplates();
            this.toast('Шаблоны импортированы.');
            return true;
          });
      } else {
        this.confirm('Восстановить резервную копию?', 'План, история, шаблоны и настройки будут заменены данными из файла.',
          'Восстановить', () => {
            if (!this.commit('ImportExportManager.importBackup', () => imported.state)) return false;
            if (picker.open) picker.close();
            this.toast('Резервная копия восстановлена.');
            return true;
          });
      }
    } catch (error) {
      this.report('ImportExportManager.importData', error, picker.open ? $('template-picker-error') : null);
    }
  }

  render(state, previous, operation) {
    if (operation === 'external') {
      this.drag.cancel();
      if (this.dialog.open) this.dialog.close();
      if ($('template-picker').open) $('template-picker').close();
      this.toast(androidBridge ? 'План обновлён с виджета.' : 'План обновлён из другой вкладки.');
    }
    const phaseChanged = state.timer.phase !== previous?.timer.phase;
    const activeChanged = state.timer.activeId !== previous?.timer.activeId;
    if (state.tasks !== previous?.tasks || activeChanged || phaseChanged) this.renderTasks(state);
    if (state.templates !== previous?.templates || phaseChanged || Boolean(state.tasks.length) !== Boolean(previous?.tasks.length)) {
      this.renderTemplates(state);
    }
    if (state.window !== previous?.window || phaseChanged) {
      $('planned-start').value = localDateValue(state.window.start);
      $('deadline').value = localDateValue(state.window.finish);
      $('planned-start').disabled = state.timer.phase !== 'idle';
      fieldError($('window-error'));
    }
    if (state.settings !== previous?.settings) {
      this.renderSound(state.settings);
      $('log-level').value = state.settings.logLevel;
    }
    if (phaseChanged && (state.timer.phase === 'idle' || state.timer.phase === 'done')) $('queue-details').open = true;
    if ((operation === 'init' || previous?.timer.phase === 'idle')
        && ['running', 'paused'].includes(state.timer.phase)) {
      $('queue-details').open = false;
      $('plan-details').open = false;
      if (operation !== 'init') window.scrollTo(0, 0);
    }
    this.renderControls(state);
    this.tick();
  }

  renderSound(settings) {
    const sound = $('sound-toggle');
    const ready = settings.sound && this.sound.ready;
    const needsActivation = settings.sound && !ready;
    sound.setAttribute('aria-pressed', String(ready));
    sound.dataset.activate = String(needsActivation);
    sound.title = ready ? 'Выключить звук' : needsActivation ? 'Активировать звук в этой вкладке' : 'Включить звук';
    const label = sound.title;
    sound.setAttribute('aria-label', label);
    sound.innerHTML = icon(ready ? 'sound' : 'muted');
  }

  renderControls(state) {
    const phase = state.timer.phase;
    const [label, tone] = PHASE_COPY[phase];
    const isActive = phase === 'running' || phase === 'paused';
    const task = activeTask(state);
    const hasTasks = state.tasks.length > 0;
    $('phase-label').dataset.tone = tone;
    display($('phase-label').lastElementChild, label);
    const completed = state.tasks.filter(item => item.done && !item.excluded).length;
    const included = state.tasks.filter(item => !item.excluded).length;
    display($('focus-kicker'), isActive ? 'Задача ' + (completed + 1) + ' из ' + included : 'План дня');
    display($('focus-heading'), task?.name || (phase === 'done' ? 'План завершён'
      : hasTasks ? 'Готово к старту' : 'С чего начнём?'));
    const step = $('first-step');
    step.hidden = !task?.firstStep;
    step.innerHTML = task?.firstStep ? '<b>Первый шаг</b> · ' + escapeHtml(task.firstStep) : '';
    const primary = $('primary-action');
    const choice = {
      idle: hasTasks ? ['start', 'play', 'Начать'] : ['go-add', 'plus', 'Добавить задачу'],
      running: ['pause', 'pause', 'Пауза'], paused: ['start', 'play', 'Продолжить'],
      done: ['new-plan', 'plus', 'Новый список']
    }[phase];
    primary.dataset.action = choice[0];
    primary.className = 'btn ' + (phase === 'running' ? 'focus-secondary' : 'focus-primary');
    primary.innerHTML = icon(choice[1]) + '<span>' + choice[2] + '</span>';
    $('finish-btn').className = 'btn ' + (phase === 'paused' ? 'focus-secondary' : 'focus-primary');
    $('finish-btn').hidden = !isActive;
    $('skip-btn').hidden = !isActive || !state.tasks.some(item => !item.done && item.id !== state.timer.activeId);
    $('task-actions').hidden = !isActive;
    $('reset-btn').hidden = !isActive;
    $('repeat-btn').hidden = phase !== 'done';
    $('focus-templates').hidden = phase !== 'idle' || hasTasks;
    $('queue-tools').hidden = !hasTasks;
    $('template-save').hidden = !hasTasks;
    $('template-new').hidden = phase !== 'done';
    $('templates-done-note').hidden = phase !== 'done';
    $('add-form').hidden = phase === 'done';
    $('done-plan-note').hidden = phase !== 'done';
    $('top').dataset.phase = phase;
  }

  renderTasks(state) {
    const active = activeTask(state);
    const pending = state.tasks.filter(task => !task.done && task.id !== state.timer.activeId);
    const done = state.tasks.filter(task => task.done);
    const focusId = document.activeElement?.dataset?.id;
    const focusAction = document.activeElement?.dataset?.action;
    $('pending-list').innerHTML = pending.map((task, index) => pendingRow(task, index, pending.length)).join('');
    if (focusId && focusAction) {
      const replacement = Array.from($('pending-list').querySelectorAll('button')).find(button =>
        button.dataset.id === focusId && button.dataset.action === focusAction && !button.disabled);
      replacement?.focus({preventScroll: true});
    }
    $('active-row').innerHTML = active ? `<div class="current-row">
      <span class="row-mark">${icon('bolt')}</span><div class="task-text"><span class="task-title">${escapeHtml(active.name)}</span>
      <span class="task-meta">(${rangeLabel(active)}) · ${state.timer.phase === 'paused' ? 'на паузе' : 'в работе'}</span></div>
      <span class="pill" data-tone="purple">Текущая</span></div>` : '';
    $('queue-empty').hidden = state.tasks.length > 0;
    $('save-template').disabled = !state.tasks.length;
    $('history').hidden = !done.length;
    $('history-list').innerHTML = done.map(historyRow).join('');
    display($('history-summary'), `Всего ${duration(done.reduce((sum, task) => sum + task.workedMs, 0), true)}`);
    display($('queue-summary'), state.tasks.length
      ? `В очереди ${pending.length} · выполнено ${done.length}` : 'Последовательно, по одной за раз');
    if (active) display($('queue-summary'), pending.length ? 'Далее · ' + pending[0].name : 'Последняя задача');
    else if (state.timer.phase === 'done') {
      const excluded = done.filter(task => task.excluded).length;
      display($('queue-summary'), 'Выполнено ' + (done.length - excluded) + (excluded ? ' · исключено ' + excluded : ''));
    }
  }

  renderTemplates(state) {
    const open = new Set(Array.from($('template-list').querySelectorAll('details[open]'), item => item.dataset.template));
    display($('template-count'), String(state.templates.length));
    $('templates-empty').hidden = state.templates.length > 0;
    $('template-export').hidden = state.templates.length === 0;
    $('template-list').innerHTML = state.templates.map(template => {
      const id = escapeHtml(template.id);
      const locked = state.timer.phase === 'done';
      const tasks = template.tasks.map((task, i) => {
        const attrs = `data-id="${id}" data-index="${i}"`;
        return `<li class="template-task">
          ${rowButton('drag', 'grip', 'Перетащить задачу в план дня', `${attrs} data-drag="template"`, locked)}
          <div class="task-text"><span class="task-title">${escapeHtml(task.name)}</span><span class="task-meta">(${rangeLabel(task)})</span></div>
          ${rowButton('copy-template-task', 'plus', 'Добавить задачу из шаблона', attrs, locked)}
        </li>`;
      }).join('');
      return `<details class="template-item" data-template="${id}" ${open.has(template.id) ? 'open' : ''}>
        <summary><span class="template-name">${escapeHtml(template.name)}</span><span class="template-meta">${template.tasks.length} шт.</span>${icon('chev').replace('class="icon"', 'class="icon chevron"')}</summary>
        <div class="template-body">
          <div class="row-buttons template-actions">
            <button class="btn btn-soft" type="button" data-action="apply-template" data-id="${id}" ${tasks ? '' : 'disabled'}>Применить</button>
            <button class="btn btn-quiet" type="button" data-action="overwrite-template" title="Сохранить текущий список в этот шаблон" data-id="${id}" ${state.tasks.length ? '' : 'disabled'}>Перезаписать</button>
            ${rowButton('delete-template', 'trash', 'Удалить шаблон', `data-id="${id}"`)}
          </div>
          ${tasks ? `<ul class="template-tasks">${tasks}</ul>` : '<p class="subtext">В шаблоне нет задач.</p>'}
        </div></details>`;
    }).join('');
  }

  tick() {
    const now = wallTime();
    const state = this.store.getState();
    const view = metrics(state, now);
    this.renderFocus(state, view, now);
    this.renderUndo();
    if ($('plan-details').open) {
      this.renderBuffer(state, view);
      this.renderForecast(state, view, now);
    }
    this.sound.sync();
    if (state.settings.logLevel === 'DEBUG' && state.timer.phase === 'running') {
      log('DEBUG', 'Timer.tick', 'Таймер обновлён', {
        elapsedMs: view.activeElapsed, taskBaseLeftMs: view.timing?.optimistic,
        taskSafeLeftMs: view.timing?.guarded, planBufferLeftMs: view.remainingMs
      }, 'DEBUG');
    }
  }

  renderFocus(state, view, now) {
    const {phase, startedAt, finishedAt} = state.timer;
    const {timing} = view;
    const draft = phase === 'idle';
    const done = phase === 'done';
    $('focus-clocks').hidden = !timing;
    $('focus-fact').hidden = draft;
    if (timing) {
      for (const [key, value, label] of [
        ['base', timing.optimistic, timing.optimistic < 0 ? 'Сверх оптимистичной' : 'Оптимистично'],
        ['safe', timing.guarded, timing.guarded < 0 ? 'Сверх верхней оценки' : 'С запасом']
      ]) {
        const countdown = $(key + '-countdown');
        const valueText = fmtCountdown(value);
        countdown.dataset.expired = String(value <= 0);
        countdown.dataset.long = String(valueText.length > 6);
        display(countdown.firstElementChild, label);
        display($(key + '-clock'), valueText);
      }
    }
    display($('fact-label'), done ? 'Время плана' : 'Работа');
    display($('task-clock'), fmtCountdown(done ? finishedAt - startedAt : view.activeElapsed));
    if (phase === 'paused') {
      display($('phase-label').lastElementChild, view.pauseMs === null ? 'На паузе' : 'Пауза ' + fmtCountdown(view.pauseMs));
    }

    const scheduled = draft && state.window.start !== null;
    const current = draft ? now + view.baselineMs + view.bufferMs : view.guarded;
    const showForecast = view.hasPlan && (!draft || (scheduled && current !== view.protectedFinish));
    const delta = (done ? finishedAt : view.guarded) - view.protectedFinish;
    $('focus-commitment').hidden = !view.hasPlan;
    display($('focus-promise-label'), draft ? (scheduled ? 'Финиш по плану' : 'Финиш с запасом') : 'Обещано к');
    display($('focus-promise-time'), fullTime(view.protectedFinish, now));
    $('focus-forecast').hidden = !showForecast;
    $('focus-forecast').dataset.warn = String(!done && (view.estimateExhausted || (!draft && delta >= 60_000)));
    display($('focus-forecast-label'), done ? 'Завершено в' : draft ? 'Если начать сейчас'
      : phase === 'paused' ? 'Если продолжить сейчас' : 'Прогноз с запасом');
    display($('focus-forecast-time'), view.estimateExhausted ? 'Нужна оценка' : fullTime(current, now));
    $('remaining-btn').hidden = !view.estimateExhausted;
    const risk = RISK_COPY[view.risk][0];
    $('risk-strip-marker').style.left = String(view.riskPosition) + '%';
    display($('risk-strip-label'), 'Буфер плана · ' + risk);
    $('focus-reserve').setAttribute('aria-label', 'Буфер плана · ' + risk + '. Открыть подробности');
    let hint = '';
    if (done) hint = delta === 0 ? 'Завершено ровно к обещанному времени.'
      : (delta < 0 ? 'Раньше обещанного на ' : 'Позже обещанного на ') + duration(delta, true) + '.';
    else if (draft && scheduled) hint = now > state.window.start + 1000
      ? 'Задержка старта · ' + duration(now - state.window.start, true)
      : 'Плановый старт · ' + fullTime(state.window.start, now);
    else if (!draft && !view.estimateExhausted && delta >= 60_000) hint = 'Прогноз позже обещанного на ' + duration(delta) + '.';
    $('focus-hint').hidden = !hint;
    $('focus-hint').dataset.warn = String((!draft && delta >= 60_000) || (draft && scheduled && now > state.window.start + 1000));
    display($('focus-hint'), hint);
  }

  renderBuffer(state, view) {
    const risk = view.hasPlan ? view.risk : 'neutral';
    const [label, message] = RISK_COPY[risk];
    const badge = $('risk-badge');
    badge.dataset.tone = risk;
    display(badge.lastElementChild, view.hasPlan ? label : 'Ожидание');
    display($('reserve-label'), view.remainingMs < 0 ? 'Перерасход резерва' : 'Резерв времени');
    display($('reserve-value'), view.hasPlan ? duration(view.remainingMs, true) : '—');
    $('reserve-value').title = view.hasPlan ? `Исходный резерв ${duration(view.bufferMs, true)}` : '';
    display($('burn-value'), !view.hasPlan ? '—' : view.penetration === null
      ? `${view.spentMs < 0 ? '−' : ''}${duration(view.spentMs, true)}` : percentage(view.penetration));
    const fill = view.percentLeft === null ? 0 : clamp(view.percentLeft, 0, 100);
    $('buffer-track').dataset.tone = view.tone;
    $('buffer-fill').dataset.tone = view.tone;
    $('buffer-fill').style.width = `${fill}%`;
    $('buffer-track').setAttribute('aria-valuenow', String(Math.round(fill)));
    $('buffer-track').setAttribute('aria-valuetext', view.percentLeft === null ? 'Процент неприменим'
      : `${percentage(view.percentLeft)} · ${duration(view.remainingMs, true)}`);
    let tip = view.hasPlan ? message : 'Добавьте задачи с двумя оценками времени.';
    if (state.timer.phase === 'done') {
      tip = view.remainingMs < 0 ? `Обещанный финиш превышен на ${duration(view.remainingMs, true)}.`
        : `На момент финиша осталось ${duration(view.remainingMs, true)} резерва.`;
    } else if (view.bufferMs > 0 && view.remainingMs === 0) {
      tip = 'Резерв исчерпан. Пересмотрите объём задач или срок.';
    }
    display($('risk-tip'), tip);
    $('chart-progress').hidden = !view.hasPlan;
    display($('chart-progress'), `Готово ${percentage(view.progress)}`);
    const chart = $('chart');
    chart.hidden = view.hasPlan && view.penetration === null;
    $('chart-empty').hidden = !chart.hidden;
    if (chart.hidden) {
      display($('chart-empty'), `Готовность ${percentage(view.progress)}. Для диагональных зон нужен исходный резерв.`);
      return;
    }
    const point = {x: view.progress, y: view.penetration ?? 0};
    const points = state.timer.points;
    const live = chartPoint(point.x, point.y);
    const trend = [...points.map(item => chartPoint(item.x, item.y)), live];
    $('chart-trend').setAttribute('points', trend.join(' '));
    if (this.lastPoints !== points) {
      $('chart-history').innerHTML = points.map(item => `<circle class="point" cx="${chartX(item.x)}" cy="${chartY(item.y)}" r="2.4">
        <title>Готовность ${percentage(item.x)}, расход ${percentage(item.y)}</title></circle>`).join('');
      this.lastPoints = points;
    }
    const marker = $('chart-current');
    marker.setAttribute('transform', `translate(${live.replace(',', ' ')})`);
    const summary = `Готовность ${percentage(point.x)}, расход буфера ${percentage(point.y)}`;
    display(marker.querySelector('title'), summary);
    chart.setAttribute('aria-label', summary);
  }

  renderForecast(state, view, now) {
    const done = state.timer.phase === 'done';
    display($('earliest-label'), done ? 'Фактический финиш' : view.estimateExhausted ? 'Нижняя граница' : 'По базовой оценке');
    display($('guarded-label'), done ? 'Изначально с запасом' : view.estimateExhausted ? 'Уточните остаток' : 'С запасом задач');
    for (const [key, stamp] of [['earliest', view.earliest], ['guarded', done ? view.protectedFinish : view.estimateExhausted ? null : view.guarded]]) {
      const {time, day} = timeParts(stamp, now);
      display($(`${key}-time`), time);
      display($(`${key}-day`), day);
      $(`${key}-day`).hidden = !day;
    }
    display($('protected-time'), fullTime(view.protectedFinish, now));
    const status = deadlineStatus(view, state.window.finish, state.timer.phase);
    $('deadline-fit').dataset.tone = status.tone;
    display($('fit-label'), status.label);
    let detail = status.detail;
    if (status.margin !== undefined) {
      const span = duration(status.margin, true);
      const finish = fullTime(state.window.finish, now);
      detail = status.margin === 0 ? `Ровно к сроку ${finish}.`
        : status.margin < 0 ? `До срока ${finish} не хватает ${span}.`
        : `До срока ${finish} остаётся ${span}.`;
    }
    display($('fit-detail'), detail);
    const {start, finish} = state.window;
    const windowParts = [start === null ? '' : `с ${fullTime(start, now)}`, finish === null ? '' : `до ${fullTime(finish, now)}`].filter(Boolean);
    display($('window-mini'), windowParts.join(' '));
  }
}

class DragManager {
  constructor(ui) {
    this.ui = ui;
    this.drag = null;
    this.raf = null;
    this.ghost = null;
    this.target = null;
    document.addEventListener('pointerdown', event => this.start(event));
    document.addEventListener('pointermove', event => this.move(event), {passive: false});
    document.addEventListener('pointerup', event => this.drop(event));
    document.addEventListener('pointercancel', event => {
      if (event.pointerId === this.drag?.pointer) this.cancel();
    });
    document.addEventListener('lostpointercapture', event => {
      if (event.pointerId === this.drag?.pointer) this.cancel();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.drag) this.cancel();
      const handle = event.target.closest('[data-drag="task"]');
      if (handle && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        this.ui.moveBy(handle.dataset.id, event.key === 'ArrowUp' ? -1 : 1, 'drag');
      }
    });
  }

  start(event) {
    const handle = event.target.closest('button[data-drag]');
    if (!handle || handle.disabled || this.drag || event.button !== 0 || !event.isPrimary) return;
    const row = handle.closest('li');
    this.drag = {handle, row, pointer: event.pointerId, id: handle.dataset.id, kind: handle.dataset.drag,
      index: Number(handle.dataset.index), startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY};
    handle.setPointerCapture(event.pointerId);
  }

  move(event) {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!this.ghost && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5) return;
    event.preventDefault();
    if (!this.ghost) {
      if (drag.kind === 'template') $('queue-details').open = true;
      drag.row.classList.add('dragging');
      this.ghost = document.createElement('div');
      this.ghost.className = 'drag-ghost';
      this.ghost.textContent = drag.row.querySelector('.task-title').textContent;
      this.ghost.setAttribute('aria-hidden', 'true');
      document.body.append(this.ghost);
      $('drop-tail').hidden = false;
      this.raf = requestAnimationFrame(() => this.scroll());
    }
    this.locate();
  }

  locate() {
    this.clearTarget();
    if (!this.ghost || !this.drag) return;
    const {x, y, id, kind} = this.drag;
    this.ghost.style.transform = `translate(${x + 12}px, ${y + 11}px)`;
    const element = document.elementFromPoint(x, y);
    const row = element?.closest('[data-drop-task]');
    const tail = element?.closest('[data-drop-tail]');
    if (tail) {
      this.target = {element: tail, css: 'drop-target', beforeId: null};
    } else if (row && (kind !== 'task' || row.dataset.dropTask !== id)) {
      const box = row.getBoundingClientRect();
      const after = y > box.top + box.height / 2;
      let next = row.nextElementSibling;
      if (kind === 'task' && next?.dataset.dropTask === id) next = next.nextElementSibling;
      this.target = {element: row, css: after ? 'drop-after' : 'drop-before',
        beforeId: after ? next?.dataset.dropTask ?? null : row.dataset.dropTask};
    }
    if (this.target) this.target.element.classList.add(this.target.css);
  }

  scroll() {
    if (!this.drag || !this.ghost) return;
    const y = this.drag.y;
    const margin = 67;
    const bottom = innerHeight - margin;
    const speed = y < margin ? -Math.ceil((margin - y) / 4) : y > bottom ? Math.ceil((y - bottom) / 4) : 0;
    if (speed) {
      window.scrollBy(0, speed);
      this.locate();
    }
    this.raf = requestAnimationFrame(() => this.scroll());
  }

  drop(event) {
    if (!this.drag || this.drag.pointer !== event.pointerId) return;
    const {id, kind, index} = this.drag;
    const target = this.target;
    this.cancel();
    if (!target) return;
    if (kind === 'task') {
      this.ui.commit('TaskManager.moveTask', state => TaskManager.moveTask(state, id, target.beforeId));
    } else {
      this.ui.copyTemplateTask(id, index, target.beforeId);
    }
  }

  clearTarget() {
    if (this.target) this.target.element.classList.remove(this.target.css);
    this.target = null;
  }

  cancel() {
    if (!this.drag) return;
    const {handle, row, pointer} = this.drag;
    this.drag = null;
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
    this.clearTarget();
    row.classList.remove('dragging');
    this.ghost?.remove();
    this.ghost = null;
    $('drop-tail').hidden = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }
}

function bindTheme(storage) {
  const choice = $('theme-choice');
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const key = 'uspevator_theme';
  const render = () => {
    const dark = choice.value === 'dark' || (choice.value === 'system'
      && (androidBridge ? androidBridge.systemDark() : system.matches));
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]').content = dark ? '#17141f' : '#f6f5fa';
  };
  const refresh = () => {
    let saved;
    try { saved = androidBridge ? androidBridge.theme() : storage?.getItem(key); }
    catch (error) { log('WARN', 'Theme.load', 'Не удалось прочитать тему', error); }
    choice.value = saved === 'light' || saved === 'dark' ? saved : 'system';
    render();
  };
  choice.addEventListener('change', () => {
    render();
    try {
      if (androidBridge) androidBridge.setTheme(choice.value);
      else storage?.setItem(key, choice.value);
    } catch (error) { log('WARN', 'Theme.save', 'Не удалось сохранить тему', error); }
  });
  if (system.addEventListener) system.addEventListener('change', render);
  else system.addListener(render);
  if (!androidBridge) window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) refresh();
  });
  refresh();
  return refresh;
}

function boot() {
  let storage = null;
  if (androidBridge) {
    storage = {
      getItem: () => androidBridge.readPlan() || null,
      compareAndSet: (expected, raw, operation) => androidBridge.writePlan(expected || '', raw, operation === 'Timer.completeTask')
    };
  } else {
    try { storage = window.localStorage; }
    catch (error) { log('WARN', 'StateManager.open', 'Хранилище браузера недоступно', error); }
  }
  const refreshTheme = bindTheme(storage);
  const store = new StateManager(storage, message => fieldError($('storage-warning'), message));
  const ui = new UIManager(store);
  if (!androidBridge) return;
  const keep = $('android-keep-screen');
  $('android-tools').hidden = false;
  keep.checked = androidBridge.keepScreen();
  keep.addEventListener('change', () => androidBridge.setKeepScreen(keep.checked));
  const shade = $('android-shade-timer');
  const refreshShade = () => {
    shade.checked = androidBridge.shadeTimer();
    shade.disabled = androidBridge.shadePermissionPending();
  };
  refreshShade();
  shade.addEventListener('change', () => {
    shade.disabled = true;
    androidBridge.setShadeTimer(shade.checked);
  });
  $('android-pin-widget').addEventListener('click', () => {
    $('app-menu').open = false;
    androidBridge.pinWidget();
  });
  const volume = $('android-signal-volume');
  volume.value = androidBridge.signalVolume();
  volume.addEventListener('change', () => androidBridge.setSignalVolume(Number(volume.value)));
  window.uspevatorAndroidRefresh = () => {
    refreshTheme();
    refreshShade();
    keep.checked = androidBridge.keepScreen();
    volume.value = androidBridge.signalVolume();
    store.acceptStorage(storage.getItem(STORAGE_KEY));
    ui.tick();
  };
  window.uspevatorAndroidImport = text => ui.importFile({text: () => Promise.resolve(text)});
  window.uspevatorAndroidBack = () => {
    const open = $('action-dialog').open ? $('action-dialog') : document.querySelector('dialog[open]');
    if (open) { open.close(); return true; }
    if ($('app-menu').open) { $('app-menu').open = false; return true; }
    return false;
  };
  window.uspevatorAndroidForm = action => {
    const state = store.getState();
    if (action === 'task-actions') ui.openTaskActions(state);
    else if (action === 'remaining') {
      if (activeTask(state)) ui.editRemaining(state);
    } else if (action === 'new-plan') ui.newPlan(state);
    else if (action === 'repeat') ui.handle($('repeat-btn'));
    else if (action === 'sound') ui.handle($('sound-toggle'));
    else if (action === 'choose-template' && state.timer.phase === 'idle' && state.tasks.length === 0) ui.openTemplatePicker(state);
    else if (action === 'add' && state.timer.phase === 'idle') {
      $('queue-details').open = true;
      $('task-name').focus();
    }
  };
}
