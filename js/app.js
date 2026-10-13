(() => {
  'use strict';

  /* ---------------------------------------------------------------------
     Константы
     --------------------------------------------------------------------- */
  const STORAGE_KEY = 'taskflow:v1';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DIALOG_CLOSE_MS = 160;
  const TOAST_LIFETIME_MS = 3500;
  const UPCOMING_LIMIT = 5;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 42;

  const PRIORITIES = {
    low: { label: 'Низкий', weight: 1 },
    medium: { label: 'Средний', weight: 2 },
    high: { label: 'Высокий', weight: 3 },
  };

  const VIEW_TITLES = {
    overview: 'Обзор',
    all: 'Все задачи',
    completed: 'Выполненные',
    settings: 'Настройки',
  };

  const STATUS = { active: 'active', completed: 'completed' };

  /* ---------------------------------------------------------------------
     Состояние
     --------------------------------------------------------------------- */
  const state = {
    tasks: [],
    userName: '',
    view: 'overview',
    filter: 'all',
    sort: 'due',
    query: '',
  };

  let editingTaskId = null;
  let pendingConfirm = null;

  /* ---------------------------------------------------------------------
     DOM-помощники
     --------------------------------------------------------------------- */
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function h(tag, { className, text, attrs, dataset } = {}, ...children) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (attrs) {
      for (const [name, value] of Object.entries(attrs)) {
        if (value === false || value == null) continue;
        node.setAttribute(name, value === true ? '' : value);
      }
    }
    if (dataset) Object.assign(node.dataset, dataset);
    node.append(...children.filter(Boolean));
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  const refs = {
    sidebar: $('#sidebar'),
    navToggle: $('#nav-toggle'),
    scrim: $('.scrim'),
    main: $('#main'),
    pageTitle: $('#page-title'),
    pageSub: $('#page-sub'),
    views: {
      overview: $('#view-overview'),
      tasks: $('#view-tasks'),
      settings: $('#view-settings'),
    },
    stats: { total: $('#stat-total'), active: $('#stat-active'), done: $('#stat-done') },
    ringValue: $('#ring-value'),
    ringLabel: $('#ring-label'),
    progressText: $('#progress-text'),
    progressBar: $('#progress-bar'),
    barFill: $('#bar-fill'),
    upcomingList: $('#upcoming-list'),
    searchInput: $('#search-input'),
    filterGroup: $('#filter-group'),
    sortSelect: $('#sort-select'),
    resultCount: $('#result-count'),
    taskList: $('#task-list'),
    emptyState: $('#empty-state'),
    profileForm: $('#profile-form'),
    userNameInput: $('#user-name'),
    taskDialog: $('#task-dialog'),
    taskDialogTitle: $('#task-dialog-title'),
    taskForm: $('#task-form'),
    taskTitle: $('#task-title'),
    taskTitleError: $('#task-title-error'),
    taskDescription: $('#task-description'),
    taskDue: $('#task-due'),
    confirmDialog: $('#confirm-dialog'),
    confirmTitle: $('#confirm-title'),
    confirmText: $('#confirm-text'),
    confirmAccept: $('#confirm-accept'),
    toasts: $('#toasts'),
  };

  /* ---------------------------------------------------------------------
     Даты
     --------------------------------------------------------------------- */
  const pad = (value) => String(value).padStart(2, '0');

  function toDateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function parseDateKey(key) {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function isValidDateKey(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && toDateKey(parseDateKey(value)) === value;
  }

  function startOfToday() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
  }

  function shiftDays(days) {
    const date = startOfToday();
    date.setDate(date.getDate() + days);
    return date;
  }

  function daysUntil(dateKey) {
    return Math.round((parseDateKey(dateKey) - startOfToday()) / 86400000);
  }

  function formatDate(date) {
    const options = { day: 'numeric', month: 'short' };
    if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
    return new Intl.DateTimeFormat('ru-RU', options).format(date).replace(/\.$/, '');
  }

  function formatFullDate(date) {
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  }

  /** Описание срока: текст и состояние для подсветки. */
  function describeDue(task) {
    if (!task.dueDate) return null;
    const dueDate = parseDateKey(task.dueDate);
    const label = formatDate(dueDate);
    if (task.status === STATUS.completed) return { text: label, state: '', title: formatFullDate(dueDate) };

    const diff = daysUntil(task.dueDate);
    if (diff < 0) {
      const text = diff === -1 ? 'Просрочено: вчера' : `Просрочено на ${-diff} дн.`;
      return { text, state: 'overdue', title: formatFullDate(dueDate) };
    }
    if (diff === 0) return { text: 'Сегодня', state: 'today', title: formatFullDate(dueDate) };
    if (diff === 1) return { text: 'Завтра', state: '', title: formatFullDate(dueDate) };
    return { text: label, state: '', title: formatFullDate(dueDate) };
  }

  /* ---------------------------------------------------------------------
     Данные и LocalStorage
     --------------------------------------------------------------------- */
  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function createDemoTasks() {
    const demo = (title, description, priority, dueOffset, createdOffset, status = STATUS.active) => ({
      id: createId(),
      title,
      description,
      priority,
      status,
      dueDate: dueOffset === null ? '' : toDateKey(shiftDays(dueOffset)),
      createdAt: shiftDays(createdOffset).toISOString(),
    });

    return [
      demo('Подготовить презентацию для встречи', 'Собрать итоги месяца и добавить три слайда с планами на следующий.', 'high', 1, -3),
      demo('Составить план на неделю', 'Расставить приоритеты и выделить время на глубокую работу.', 'medium', 0, -1),
      demo('Записаться к стоматологу', 'Выбрать удобное время на конец недели.', 'medium', -2, -6),
      demo('Оплатить интернет', '', 'low', 5, -2),
      demo('Прочитать документацию по Intl API', 'Пригодится для форматирования дат и чисел.', 'low', 9, -4),
      demo('Разобрать почту', 'Отписаться от лишних рассылок.', 'low', -1, -5, STATUS.completed),
      demo('Обновить резюме', 'Добавить последние проекты.', 'high', null, -8, STATUS.completed),
    ];
  }

  /** Приводит запись из хранилища к корректной задаче или возвращает null. */
  function sanitizeTask(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) return null;

    const createdAt = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
      ? raw.createdAt
      : new Date().toISOString();

    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : createId(),
      title: title.slice(0, 100),
      description: typeof raw.description === 'string' ? raw.description.slice(0, 500) : '',
      priority: Object.hasOwn(PRIORITIES, raw.priority) ? raw.priority : 'medium',
      status: raw.status === STATUS.completed ? STATUS.completed : STATUS.active,
      dueDate: isValidDateKey(raw.dueDate) ? raw.dueDate : '',
      createdAt,
    };
  }

  function loadState() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      showToast('Хранилище браузера недоступно: изменения не сохранятся', 'error');
      state.tasks = createDemoTasks();
      return;
    }

    if (raw === null) {
      state.tasks = createDemoTasks();
      saveState();
      return;
    }

    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.tasks)) throw new Error('Неверный формат данных');
      state.tasks = data.tasks.map(sanitizeTask).filter(Boolean);
      state.userName = typeof data.userName === 'string' ? data.userName.slice(0, 40) : '';
    } catch {
      state.tasks = [];
      showToast('Не удалось прочитать сохранённые данные. Начато с чистого списка', 'error');
    }
  }

  function saveState() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, userName: state.userName, tasks: state.tasks }));
      return true;
    } catch {
      showToast('Не удалось сохранить данные в браузере', 'error');
      return false;
    }
  }

  function findTask(id) {
    return state.tasks.find((task) => task.id === id);
  }

  /* ---------------------------------------------------------------------
     Операции над задачами
     --------------------------------------------------------------------- */
  function addTask(values) {
    state.tasks.push({
      id: createId(),
      ...values,
      status: STATUS.active,
      createdAt: new Date().toISOString(),
    });
    commit('Задача создана');
  }

  function updateTask(id, values) {
    const task = findTask(id);
    if (!task) {
      showToast('Задача не найдена. Возможно, она уже удалена', 'error');
      render();
      return;
    }
    Object.assign(task, values);
    commit('Изменения сохранены');
  }

  function deleteTask(id) {
    state.tasks = state.tasks.filter((task) => task.id !== id);
    commit('Задача удалена');
  }

  function toggleTask(id) {
    const task = findTask(id);
    if (!task) return;
    const becameDone = task.status === STATUS.active;
    task.status = becameDone ? STATUS.completed : STATUS.active;
    commit(becameDone ? 'Задача выполнена' : 'Задача возвращена в активные');
  }

  function clearAllTasks() {
    state.tasks = [];
    commit('Все задачи удалены');
  }

  function addDemoTasks() {
    state.tasks.push(...createDemoTasks());
    commit('Демонстрационные задачи добавлены');
  }

  /** Сохраняет данные, обновляет интерфейс и показывает уведомление об успехе. */
  function commit(message) {
    const saved = saveState();
    render();
    if (saved) showToast(message);
  }

  /* ---------------------------------------------------------------------
     Выборка: фильтр, поиск, сортировка
     --------------------------------------------------------------------- */
  const compareDue = (a, b) => {
    if (a.dueDate === b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  };
  const comparePriority = (a, b) => PRIORITIES[b.priority].weight - PRIORITIES[a.priority].weight;
  const compareCreated = (a, b) => a.createdAt.localeCompare(b.createdAt);
  const compareStatus = (a, b) => Number(a.status === STATUS.completed) - Number(b.status === STATUS.completed);

  const SORTERS = {
    due: (a, b) => compareStatus(a, b) || compareDue(a, b) || comparePriority(a, b) || compareCreated(a, b),
    priority: (a, b) => compareStatus(a, b) || comparePriority(a, b) || compareDue(a, b) || compareCreated(a, b),
  };

  function currentStatusFilter() {
    return state.view === 'completed' ? STATUS.completed : state.filter;
  }

  function getVisibleTasks() {
    const statusFilter = currentStatusFilter();
    const query = state.query.trim().toLowerCase();

    return state.tasks
      .filter((task) => statusFilter === 'all' || task.status === statusFilter)
      .filter((task) => !query || task.title.toLowerCase().includes(query))
      .sort(SORTERS[state.sort]);
  }

  function getStats() {
    const total = state.tasks.length;
    const completed = state.tasks.filter((task) => task.status === STATUS.completed).length;
    return { total, completed, active: total - completed, percent: total ? Math.round((completed / total) * 100) : 0 };
  }

  /* ---------------------------------------------------------------------
     Отрисовка
     --------------------------------------------------------------------- */
  function render() {
    renderNav();
    renderHeader();
    renderOverview();
    renderTasksView();
    refs.userNameInput.value = state.userName;
  }

  function renderNav() {
    $$('.nav__link').forEach((link) => {
      if (link.dataset.view === state.view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });

    const isTasks = state.view === 'all' || state.view === 'completed';
    refs.views.overview.hidden = state.view !== 'overview';
    refs.views.tasks.hidden = !isTasks;
    refs.views.settings.hidden = state.view !== 'settings';
    refs.filterGroup.hidden = state.view === 'completed';
  }

  function greeting() {
    const hour = new Date().getHours();
    const base = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';
    return state.userName ? `${base}, ${state.userName}` : base;
  }

  function renderHeader() {
    refs.pageTitle.textContent = VIEW_TITLES[state.view];
    document.title = `${VIEW_TITLES[state.view]} — TaskFlow`;

    const { active } = getStats();
    if (state.view === 'overview') {
      const today = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
      const summary = active ? `Активных задач: ${active}.` : 'Активных задач нет.';
      refs.pageSub.textContent = `${greeting()}. Сегодня ${today}. ${summary}`;
    } else if (state.view === 'settings') {
      refs.pageSub.textContent = 'Профиль и управление данными';
    } else {
      refs.pageSub.textContent = state.view === 'completed' ? 'Всё, что уже сделано' : 'Создавайте, ищите и отмечайте задачи';
    }
  }

  function renderOverview() {
    const stats = getStats();
    refs.stats.total.textContent = stats.total;
    refs.stats.active.textContent = stats.active;
    refs.stats.done.textContent = stats.completed;

    refs.ringLabel.textContent = `${stats.percent}%`;
    refs.ringValue.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - stats.percent / 100);
    refs.barFill.style.width = `${stats.percent}%`;
    refs.progressBar.setAttribute('aria-valuenow', String(stats.percent));
    refs.progressText.textContent = stats.total
      ? `Выполнено ${stats.completed} из ${stats.total}`
      : 'Добавьте первую задачу, и здесь появится прогресс';

    const upcoming = state.tasks
      .filter((task) => task.status === STATUS.active && task.dueDate)
      .sort(SORTERS.due)
      .slice(0, UPCOMING_LIMIT);

    refs.upcomingList.replaceChildren(
      ...(upcoming.length
        ? upcoming.map(createUpcomingItem)
        : [h('li', { className: 'upcoming__empty', text: 'Нет активных задач со сроком выполнения.' })]),
    );
  }

  function createDueMeta(task) {
    const due = describeDue(task);
    if (!due) return null;
    const meta = h('span', { className: `meta${due.state ? ` meta--${due.state}` : ''}`, attrs: { title: due.title } }, icon('calendar'), due.text);
    return meta;
  }

  function createPriorityBadge(task) {
    return h('span', { className: `priority priority--${task.priority}`, text: PRIORITIES[task.priority].label });
  }

  function createToggleButton(task) {
    const done = task.status === STATUS.completed;
    return h(
      'button',
      {
        className: 'task__check',
        attrs: {
          type: 'button',
          'aria-pressed': String(done),
          'aria-label': done ? `Вернуть в активные: ${task.title}` : `Отметить выполненной: ${task.title}`,
          title: done ? 'Вернуть в активные' : 'Отметить выполненной',
        },
        dataset: { action: 'toggle' },
      },
      icon('check'),
    );
  }

  function createUpcomingItem(task) {
    return h(
      'li',
      { className: 'upcoming__item', dataset: { id: task.id } },
      createToggleButton(task),
      h(
        'div',
        { className: 'upcoming__main' },
        h('p', { className: 'upcoming__title', text: task.title, attrs: { title: task.title } }),
        h('div', { className: 'upcoming__meta' }, createDueMeta(task), createPriorityBadge(task)),
      ),
    );
  }

  function createTaskItem(task) {
    const done = task.status === STATUS.completed;
    const created = new Date(task.createdAt);

    const actions = h(
      'div',
      { className: 'task__actions' },
      h('button', { className: 'icon-btn', attrs: { type: 'button', 'aria-label': `Редактировать: ${task.title}`, title: 'Редактировать' }, dataset: { action: 'edit' } }, icon('edit')),
      h('button', { className: 'icon-btn icon-btn--danger', attrs: { type: 'button', 'aria-label': `Удалить: ${task.title}`, title: 'Удалить' }, dataset: { action: 'delete' } }, icon('trash')),
    );

    const meta = h(
      'div',
      { className: 'task__meta' },
      createPriorityBadge(task),
      createDueMeta(task),
      h('span', { className: 'meta', attrs: { title: formatFullDate(created) } }, icon('clock'), `Создана ${formatDate(created)}`),
      h('span', { className: 'meta', text: done ? 'Выполнена' : 'Активна' }),
    );

    return h(
      'li',
      { className: `task${done ? ' is-done' : ''}`, dataset: { id: task.id } },
      createToggleButton(task),
      h(
        'div',
        { className: 'task__body' },
        h('h3', { className: 'task__title', text: task.title }),
        task.description ? h('p', { className: 'task__desc', text: task.description }) : null,
        meta,
      ),
      actions,
    );
  }

  function renderTasksView() {
    if (!(state.view === 'all' || state.view === 'completed')) return;

    $$('[data-filter]', refs.filterGroup).forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
    });

    const visible = getVisibleTasks();
    refs.taskList.replaceChildren(...visible.map(createTaskItem));
    refs.taskList.hidden = visible.length === 0;
    refs.resultCount.textContent = visible.length ? `Показано задач: ${visible.length}` : '';

    renderEmptyState(visible.length);
  }

  function renderEmptyState(visibleCount) {
    refs.emptyState.hidden = visibleCount > 0;
    if (visibleCount > 0) return;

    const isFiltered = Boolean(state.query.trim()) || currentStatusFilter() !== 'all';
    let title;
    let text;
    let button;

    if (state.tasks.length === 0) {
      title = 'Задач пока нет';
      text = 'Создайте первую задачу, чтобы начать планировать день.';
      button = h('button', { className: 'btn btn--primary', text: 'Создать задачу', attrs: { type: 'button' }, dataset: { action: 'new-task' } });
    } else if (state.view === 'completed' && !state.query.trim()) {
      title = 'Выполненных задач пока нет';
      text = 'Отметьте задачу выполненной, и она появится здесь.';
    } else if (isFiltered) {
      title = 'Ничего не найдено';
      text = 'Попробуйте изменить запрос или сбросить фильтры.';
      button = h('button', { className: 'btn', text: 'Сбросить фильтры', attrs: { type: 'button' }, dataset: { action: 'reset-filters' } });
    }

    refs.emptyState.replaceChildren(
      icon('inbox'),
      h('h2', { className: 'empty__title', text: title }),
      h('p', { className: 'empty__text', text }),
      button,
    );
    refs.emptyState.firstElementChild.classList.add('empty__icon');
  }

  /* ---------------------------------------------------------------------
     Уведомления
     --------------------------------------------------------------------- */
  function showToast(message, type = 'success') {
    const toast = h(
      'div',
      { className: `toast${type === 'error' ? ' toast--error' : ''}` },
      icon(type === 'error' ? 'alert' : 'done'),
      h('p', { className: 'toast__text', text: message }),
    );

    const dismiss = () => {
      if (!toast.isConnected || toast.classList.contains('is-leaving')) return;
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 200);
    };

    toast.addEventListener('click', dismiss);
    refs.toasts.append(toast);
    while (refs.toasts.children.length > 3) refs.toasts.firstElementChild.remove();
    setTimeout(dismiss, type === 'error' ? TOAST_LIFETIME_MS * 1.5 : TOAST_LIFETIME_MS);
  }

  /* ---------------------------------------------------------------------
     Модальные окна
     --------------------------------------------------------------------- */
  const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function openDialog(dialog) {
    dialog.classList.remove('is-closing');
    if (!dialog.open) dialog.showModal();
  }

  function closeDialog(dialog) {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    if (prefersReducedMotion()) {
      dialog.close();
      return;
    }
    dialog.classList.add('is-closing');
    setTimeout(() => {
      dialog.classList.remove('is-closing');
      if (dialog.open) dialog.close();
    }, DIALOG_CLOSE_MS);
  }

  function setupDialog(dialog) {
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog(dialog);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeDialog(dialog);
    });
    dialog.addEventListener('close', () => {
      if (document.activeElement === document.body || document.activeElement === null) refs.main.focus({ preventScroll: true });
    });
  }

  function setTitleError(message) {
    refs.taskTitleError.hidden = !message;
    refs.taskTitleError.textContent = message || '';
    if (message) refs.taskTitle.setAttribute('aria-invalid', 'true');
    else refs.taskTitle.removeAttribute('aria-invalid');
  }

  function openTaskDialog(taskId = null) {
    const task = taskId ? findTask(taskId) : null;
    editingTaskId = task ? task.id : null;

    refs.taskDialogTitle.textContent = task ? 'Редактирование задачи' : 'Новая задача';
    refs.taskTitle.value = task ? task.title : '';
    refs.taskDescription.value = task ? task.description : '';
    refs.taskDue.value = task ? task.dueDate : '';
    refs.taskForm.elements.priority.value = task ? task.priority : 'medium';
    setTitleError('');

    openDialog(refs.taskDialog);
    refs.taskTitle.focus();
  }

  function handleTaskFormSubmit(event) {
    event.preventDefault();

    const title = refs.taskTitle.value.trim();
    if (!title) {
      setTitleError('Введите название задачи');
      refs.taskTitle.focus();
      return;
    }

    const dueValue = refs.taskDue.value;
    const values = {
      title,
      description: refs.taskDescription.value.trim(),
      priority: refs.taskForm.elements.priority.value,
      dueDate: isValidDateKey(dueValue) ? dueValue : '',
    };

    if (editingTaskId) updateTask(editingTaskId, values);
    else addTask(values);

    closeDialog(refs.taskDialog);
  }

  function askConfirmation({ title, text, acceptLabel, onAccept }) {
    refs.confirmTitle.textContent = title;
    refs.confirmText.textContent = text;
    refs.confirmAccept.textContent = acceptLabel;
    pendingConfirm = onAccept;
    openDialog(refs.confirmDialog);
    refs.confirmAccept.focus();
  }

  /* ---------------------------------------------------------------------
     Навигация и маршрутизация
     --------------------------------------------------------------------- */
  function viewFromHash() {
    const name = window.location.hash.replace(/^#\/?/, '');
    return Object.hasOwn(VIEW_TITLES, name) ? name : 'overview';
  }

  function applyRoute() {
    state.view = viewFromHash();
    closeNav();
    render();
    window.scrollTo({ top: 0 });
  }

  function isNavOpen() {
    return document.body.classList.contains('nav-open');
  }

  function openNav() {
    document.body.classList.add('nav-open', 'is-locked');
    refs.scrim.hidden = false;
    refs.navToggle.setAttribute('aria-expanded', 'true');
    const firstLink = $('.nav__link', refs.sidebar);
    if (firstLink) firstLink.focus();
  }

  function closeNav({ restoreFocus = false } = {}) {
    if (!isNavOpen()) return;
    document.body.classList.remove('nav-open', 'is-locked');
    refs.scrim.hidden = true;
    refs.navToggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) refs.navToggle.focus();
  }

  /* ---------------------------------------------------------------------
     Обработчики событий
     --------------------------------------------------------------------- */
  function handleAction(action, taskId, trigger) {
    switch (action) {
      case 'new-task':
        openTaskDialog();
        break;
      case 'edit':
        openTaskDialog(taskId);
        break;
      case 'toggle':
        toggleTask(taskId);
        break;
      case 'delete': {
        const task = findTask(taskId);
        if (!task) break;
        askConfirmation({
          title: 'Удалить задачу?',
          text: `Задача «${task.title}» будет удалена без возможности восстановления.`,
          acceptLabel: 'Удалить',
          onAccept: () => deleteTask(taskId),
        });
        break;
      }
      case 'clear-all':
        if (state.tasks.length === 0) {
          showToast('Список задач уже пуст', 'error');
          break;
        }
        askConfirmation({
          title: 'Удалить все задачи?',
          text: `Будет удалено задач: ${state.tasks.length}. Это действие нельзя отменить.`,
          acceptLabel: 'Удалить все',
          onAccept: clearAllTasks,
        });
        break;
      case 'add-demo':
        addDemoTasks();
        break;
      case 'reset-filters':
        state.query = '';
        state.filter = 'all';
        refs.searchInput.value = '';
        render();
        break;
      case 'open-nav':
        openNav();
        break;
      case 'close-nav':
        closeNav({ restoreFocus: true });
        break;
      case 'close-dialog':
        closeDialog(trigger.closest('dialog'));
        break;
      default:
        break;
    }
  }

  function handleDocumentClick(event) {
    if (event.target.closest('.nav__link, .brand')) closeNav();

    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const item = trigger.closest('[data-id]');
    handleAction(trigger.dataset.action, item ? item.dataset.id : null, trigger);
  }

  function handleProfileSubmit(event) {
    event.preventDefault();
    state.userName = refs.userNameInput.value.trim().slice(0, 40);
    commit(state.userName ? 'Имя сохранено' : 'Имя удалено');
  }

  function bindEvents() {
    document.addEventListener('click', handleDocumentClick);
    window.addEventListener('hashchange', applyRoute);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isNavOpen()) closeNav({ restoreFocus: true });
    });
    window.matchMedia('(min-width: 1280px)').addEventListener('change', (event) => {
      if (event.matches) closeNav();
    });

    refs.searchInput.addEventListener('input', () => {
      state.query = refs.searchInput.value;
      renderTasksView();
    });
    refs.filterGroup.addEventListener('click', (event) => {
      const button = event.target.closest('[data-filter]');
      if (!button) return;
      state.filter = button.dataset.filter;
      renderTasksView();
    });
    refs.sortSelect.addEventListener('change', () => {
      state.sort = refs.sortSelect.value;
      renderTasksView();
    });

    refs.taskForm.addEventListener('submit', handleTaskFormSubmit);
    refs.taskTitle.addEventListener('input', () => {
      if (!refs.taskTitleError.hidden) setTitleError('');
    });
    refs.profileForm.addEventListener('submit', handleProfileSubmit);

    refs.confirmAccept.addEventListener('click', () => {
      const onAccept = pendingConfirm;
      pendingConfirm = null;
      closeDialog(refs.confirmDialog);
      if (onAccept) onAccept();
    });

    setupDialog(refs.taskDialog);
    setupDialog(refs.confirmDialog);
  }

  /* ---------------------------------------------------------------------
     Запуск
     --------------------------------------------------------------------- */
  function init() {
    loadState();
    bindEvents();
    applyRoute();
  }

  init();
})();
