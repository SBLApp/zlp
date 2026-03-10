/**
 * app.js — точка входа, координирует все модули
 */

import * as api from './api.js';
import * as auth from './auth.js';
import * as tableModule from './table.js';
import {
  calcStats, renderStats, renderExecutorTable, renderHourlyChart, renderHourlyByEmployee,
  getHourlyByEmployeeGroupedByCompany, buildHourlyTableHtmlForCompany, buildHourlyTableHtmlFullList,
  getCompanySummaryTableData, renderCompanySummaryTable,
} from './stats.js';
import {
  initMonitor, updateMonitorEmpl, loadRollcall, getRollcallCount,
  startMonitorRefresh, refreshMonitor, renderMonitor,
  openRollcallModal, closeRollcallModal, saveRollcall,
} from './monitor.js';
import { el, flattenItem, parseEmplCsv, formatDateTime, shiftLabel, normalizeFio as normFio, hasMatchInEmplKeys, getCompanyByFio } from './utils.js';
import { initConsolidation, loadComplaints } from './consolidation.js';

// ─── Состояние ───────────────────────────────────────────────────────────────

/** Выбранная дата (YYYY-MM-DD); по умолчанию сегодня */
let selectedDate = new Date().toISOString().slice(0, 10);
/** День (9–21) или Ночь (22–9) — фильтр отображаемых операций */
let shiftFilter = 'day';
let allItems = [];
let emplMap = new Map();
let emplCompanies = [];
let filterCompany = '__all__';
let autoRefreshTimer = null;
let telegramBindPollId = null;

// ─── Инициализация ───────────────────────────────────────────────────────────

async function init() {
  tableModule.initTableHeaders();
  initTabs();
  await loadEmployees();
  selectedDate = getTodayStr();
  syncDatePickers();
  syncShiftToggle();
  await loadStatus();
  setupEventListeners();

  // Инициализируем консолидацию
  initConsolidation();

  // Инициализируем мониторинг
  initMonitor(() => allItems, emplMap, emplCompanies, () => {
    loadEmployees();
    renderAll();
  });
  await loadRollcall();
  updateRollcallInfo();
  startMonitorRefresh();
  renderMonitor(); // отрисовать пустое состояние / перекличку без live-запроса

  auth.setOnAuthChange(onAuthChange);
  const restored = await auth.tryRestoreSession();
  if (!restored) showLoginForm();
  else showDashboard(); // loadDateData вызывается один раз внутри showDashboard

  // Авто-обновление UI каждые 10 минут (только если открыта текущая дата)
  autoRefreshTimer = setInterval(refreshCurrentShift, 10 * 60 * 1000);
  // Статус планировщика — каждые 30 сек
  setInterval(loadStatus, 30 * 1000);
}

function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getCurrentShiftKeyLocal() {
  const h = new Date().getHours();
  const today = getTodayStr();
  if (h >= 9 && h < 21) return `${today}_day`;
  const base = new Date();
  if (h < 9) base.setDate(base.getDate() - 1);
  return `${base.toISOString().slice(0, 10)}_night`;
}

function updateRollcallInfo() {
  const infoEl = el('monitor-rollcall-info');
  if (!infoEl) return;
  const count = getRollcallCount();
  infoEl.textContent = count > 0 ? `На смене отмечено: ${count} чел.` : 'Перекличка не проведена';
}

// ─── Вкладки и модули по ролям ───────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

/** Показать только вкладки (модули), разрешённые для роли пользователя. */
function applyModulesVisibility() {
  const modules = auth.getModules();
  const allowed = new Set(modules);
  document.querySelectorAll('.tab-btn[data-module]').forEach(btn => {
    const mod = btn.dataset.module;
    btn.style.display = allowed.has(mod) ? '' : 'none';
  });
  document.querySelectorAll('.tab-content[data-module]').forEach(panel => {
    const mod = panel.dataset.module;
    panel.classList.toggle('tab-content--hidden', !allowed.has(mod));
  });
  const activeBtn = document.querySelector('.tab-btn.active');
  const activeMod = activeBtn?.dataset.module;
  if (activeBtn && (!activeMod || !allowed.has(activeMod))) {
    const firstVisible = document.querySelector('.tab-btn[data-module]');
    const firstAllowed = firstVisible && allowed.has(firstVisible.dataset.module) ? firstVisible : null;
    const pick = firstAllowed || Array.from(document.querySelectorAll('.tab-btn[data-module]')).find(b => allowed.has(b.dataset.module));
    if (pick) switchTab(pick.dataset.tab);
  }
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === tabId));

  // При открытии консолидации — загружаем жалобы
  if (tabId === 'tab-consolidation') {
    loadComplaints();
  }
  // При открытии настроек — обновляем данные о сменах
  if (tabId === 'tab-settings') {
    loadSettingsTab();
  }
  // При открытии мониторинга — сразу грузим live-данные
  if (tabId === 'tab-monitor') {
    refreshMonitor();
  }
}

// ─── Авторизация ─────────────────────────────────────────────────────────────

function showLoginForm() {
  el('login-screen').style.display = 'flex';
  el('dashboard').style.display = 'none';
  const spinner = el('loading-spinner');
  if (spinner) spinner.style.display = 'none';
}

const ROLE_LABELS = { admin: 'Админ', group_leader: 'Руководитель группы', supervisor: 'Начальник смены', manager: 'Менеджер' };

function showDashboard() {
  el('login-screen').style.display = 'none';
  el('dashboard').style.display = 'block';
  const spinner = el('loading-spinner');
  if (spinner) spinner.style.display = 'none';
  const roleEl = el('header-role');
  if (roleEl) {
    const role = auth.getRole();
    roleEl.textContent = role ? (ROLE_LABELS[role] || role) : '';
  }
  applyModulesVisibility();
  const filterSection = el('company-filter-section');
  if (filterSection) filterSection.style.display = auth.getRole() === 'manager' ? 'none' : '';
  // Один раз загружаем данные для выбранной даты (избегаем двойного подсчёта в init)
  loadDateData(selectedDate);
}

function onAuthChange(loggedIn) {
  if (loggedIn) showDashboard();
  else showLoginForm();
}

async function handleLogin(e) {
  e.preventDefault();
  const loginVal = el('input-login').value.trim();
  const passVal = el('input-password').value.trim();
  if (!loginVal || !passVal) { showNotification('Введите логин и пароль', 'error'); return; }
  setLoginLoading(true);
  try {
    await auth.login(loginVal, passVal);
    showNotification('Авторизация успешна', 'success');
  } catch (err) {
    showNotification(err.message, 'error');
  } finally {
    setLoginLoading(false);
  }
}

function setLoginLoading(loading) {
  const btn = el('btn-login');
  if (btn) { btn.disabled = loading; btn.textContent = loading ? 'Вход...' : 'Войти'; }
}

// ─── Данные смены ────────────────────────────────────────────────────────────

function syncDatePickers() {
  for (const id of ['date-picker-stats', 'date-picker-data']) {
    const input = el(id);
    if (input) input.value = selectedDate;
  }
}

function syncShiftToggle() {
  for (const id of ['shift-toggle-day-stats', 'shift-toggle-night-stats', 'shift-toggle-day-data', 'shift-toggle-night-data']) {
    const btn = el(id);
    if (!btn) continue;
    const isActive = btn.dataset.shift === shiftFilter;
    btn.classList.toggle('active', isActive);
  }
  const fromInp = el('fetch-hour-from');
  const toInp = el('fetch-hour-to');
  if (fromInp && toInp) {
    if (shiftFilter === 'day') {
      fromInp.value = 9;
      toInp.value = 21;
    } else {
      fromInp.value = 22;
      toInp.value = 9;
    }
  }
}

/** Определяет смену по времени операции: день 9:00–21:59, ночь 22:00–9:59 */
function getItemShift(iso) {
  if (!iso) return 'day';
  const h = new Date(iso).getHours();
  return (h >= 9 && h <= 21) ? 'day' : 'night';
}

/** Операции за выбранную смену (до фильтра по подрядчику) */
function getItemsByShift() {
  return allItems.filter(i => getItemShift(i.completedAt || i.startedAt) === shiftFilter);
}

/**
 * По уже загруженным allItems возвращает множество часов, по которым есть данные с completedAt.
 * Только completedAt — иначе часы считаются «покрытыми» по startedAt и выгрузка пропускает 9–10, а в таблице по часам там пусто.
 */
function getCoveredHoursForDate(dateStr, shift) {
  const covered = new Set();
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return covered;
  const prevDate = new Date(dateStr);
  prevDate.setDate(prevDate.getDate() - 1);
  const prevDateStr = prevDate.toISOString().slice(0, 10);

  for (const item of allItems) {
    const ts = item.completedAt;
    if (!ts) continue;
    const d = new Date(ts);
    const itemDateStr = d.toISOString().slice(0, 10);
    const h = d.getHours();

    if (shift === 'day') {
      if (itemDateStr === dateStr && h >= 9 && h < 21) covered.add(h);
    } else {
      if (itemDateStr === prevDateStr && h >= 21) covered.add(h);
      else if (itemDateStr === dateStr && h < 9) covered.add(h);
    }
  }
  return covered;
}

/** Возвращает время последней операции (completedAt) в allItems для указанной даты и часа в рамках смены, или null. */
function getLastCompletedAtForHour(dateStr, hour, shift) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const prevDate = new Date(dateStr);
  prevDate.setDate(prevDate.getDate() - 1);
  const prevDateStr = prevDate.toISOString().slice(0, 10);
  let maxTs = null;
  for (const item of allItems) {
    const ts = item.completedAt;
    if (!ts) continue;
    const d = new Date(ts);
    const itemDateStr = d.toISOString().slice(0, 10);
    const h = d.getHours();
    let match = false;
    if (shift === 'day') {
      match = itemDateStr === dateStr && h >= 9 && h < 21 && h === hour;
    } else {
      match = (itemDateStr === prevDateStr && h >= 21 && h === hour) || (itemDateStr === dateStr && h < 9 && h === hour);
    }
    if (match) {
      const t = d.getTime();
      if (maxTs === null || t > maxTs) maxTs = t;
    }
  }
  return maxTs;
}

async function loadDateData(dateStr) {
  if (!dateStr) return;
  setLoading(true);
  try {
    const opts = { shift: shiftFilter };
    const res = await api.getDateItems(dateStr, opts);
    const raw = res.items || [];
    allItems = raw.map(i => (i.executor !== undefined && i.completedAt !== undefined ? i : flattenItem(i)));
    syncDatePickers();
    renderAll();
  } catch (err) {
    showNotification('Ошибка загрузки данных: ' + err.message, 'error');
  } finally {
    setLoading(false);
  }
}

/** Обновить данные на экране: если выбрана сегодняшняя дата — подтянуть с сервера. */
async function refreshCurrentShift() {
  if (selectedDate === getTodayStr()) await loadDateData(selectedDate);
}

async function loadStatus() {
  try {
    const status = await api.getStatus();
    const indicator = el('schedule-indicator');
    const lastRunEl = el('last-run');
    const lastRunStats = el('last-run-stats');
    const running = status.scheduleRunning;

    const tokenOk = status.tokenRefresherRunning;

    if (indicator) {
      // Зелёный — всё работает, жёлтый — сбор есть но токен не обновляется, серый — остановлен
      if (running && tokenOk) {
        indicator.className = 'schedule-dot dot-green';
        indicator.title = 'Автосбор работает · токен обновляется автоматически';
      } else if (running && !tokenOk) {
        indicator.className = 'schedule-dot dot-yellow';
        indicator.title = 'Автосбор работает · токен не обновляется (войдите через браузер)';
      } else {
        indicator.className = 'schedule-dot dot-gray';
        indicator.title = 'Автосбор остановлен';
      }
    }
    const lastRunText = status.lastRun ? 'Обновлено: ' + formatDateTime(status.lastRun) : '';
    if (lastRunEl) lastRunEl.textContent = lastRunText;
    if (lastRunStats) lastRunStats.textContent = lastRunText;

    // Настройки: статус
    const statusText = el('schedule-status-text');
    if (statusText) {
      const interval = status.config?.intervalMinutes ?? 10;
      const pageSize = status.config?.pageSize ?? 500;
      if (running && tokenOk) {
        statusText.textContent = `Работает · интервал ${interval} мин · токен обновляется автоматически`;
        statusText.style.color = 'var(--green)';
      } else if (running && !tokenOk) {
        statusText.textContent = `Работает · токен НЕ обновляется — войдите через браузер`;
        statusText.style.color = 'var(--warning)';
      } else {
        statusText.textContent = 'Остановлен';
        statusText.style.color = 'var(--text-muted)';
      }
    }

    // Статус обновления токена в настройках
    const tokenStatusEl = el('token-refresher-status');
    if (tokenStatusEl) {
      tokenStatusEl.textContent = tokenOk ? 'Работает (каждые 4 мин)' : 'Не запущен';
      tokenStatusEl.style.color = tokenOk ? 'var(--green)' : 'var(--text-muted)';
    }

    // Настройки: интервал и pageSize
    const intervalInput = el('setting-interval');
    if (intervalInput && status.config?.intervalMinutes) {
      intervalInput.value = status.config.intervalMinutes;
    }
    const pageSizeInput = el('setting-page-size');
    if (pageSizeInput && status.config?.pageSize) {
      pageSizeInput.value = status.config.pageSize;
    }
  } catch { /* ignore */ }
}


async function loadEmployees() {
  try {
    const res = await api.getEmployees();
    if (res.csv) applyEmplCsv(res.csv);
  } catch { /* ignore */ }
}

function applyEmplCsv(csvText) {
  const parsed = parseEmplCsv(csvText);
  emplMap = parsed.map;
  emplCompanies = parsed.companies;
  renderCompanyFilter();
  updateMonitorEmpl(emplMap, emplCompanies);
}

// ─── Рендеринг ───────────────────────────────────────────────────────────────

function dateLabel(ymd) {
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-');
  return d && m && y ? `${d}.${m}.${y}` : ymd;
}

/** Подпись для карточки «Дата»: при ночи показываем диапазон 21 (пред. день) – 09 */
function dateCardLabel() {
  const d = dateLabel(selectedDate);
  if (!d || d === '—') return d;
  if (shiftFilter === 'day') return `${d} · День 9–21`;
  const prev = new Date(selectedDate + 'T12:00:00Z');
  prev.setDate(prev.getDate() - 1);
  const prevStr = dateLabel(prev.toISOString().slice(0, 10));
  return `${d} · Ночь 22 (${prevStr}) – 09 (${d})`;
}

function renderAll() {
  const itemsByShift = getItemsByShift();
  const tableItems = filterItemsByCompany(itemsByShift);
  const stats = calcStats(itemsByShift, emplMap, filterCompany);
  renderStats(stats, dateCardLabel());
  renderExecutorTable(stats.executors);
  const summaryData = getCompanySummaryTableData(itemsByShift, shiftFilter, emplMap, selectedDate);
  renderCompanySummaryTable(summaryData.rows, summaryData.hoursDisplay);
  renderHourlyChart(stats.hourly, shiftFilter);
  renderHourlyByEmployee(tableItems, shiftFilter, emplMap);
  tableModule.setTableData(tableItems, emplMap);
}

function getFilteredItems() {
  return filterItemsByCompany(getItemsByShift());
}

function filterItemsByCompany(itemsByShift) {
  if (filterCompany === '__all__') return itemsByShift;
  if (filterCompany === '__none__') {
    return itemsByShift.filter(i => !hasMatchInEmplKeys(normFio(i.executor), emplMap));
  }
  return itemsByShift.filter(i => getCompanyByFio(emplMap, normFio(i.executor)) === filterCompany);
}

function renderCompanyFilter() {
  const wrap = el('company-filter');
  if (!wrap) return;

  const options = [
    { value: '__all__', label: 'Все сотрудники' },
    ...emplCompanies.map(c => ({ value: c, label: c })),
    { value: '__none__', label: 'Не в списке' },
  ];

  wrap.innerHTML = options.map(o => `
    <button class="filter-chip${filterCompany === o.value ? ' active' : ''}" data-company="${esc(o.value)}">
      ${esc(o.label)}
    </button>
  `).join('');

  wrap.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      filterCompany = btn.dataset.company;
      wrap.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderAll();
    });
  });
}

function setLoading(on) {
  const spinner = el('loading-spinner');
  if (spinner) spinner.style.display = on ? 'flex' : 'none';
}

// ─── Вкладка Настройки ───────────────────────────────────────────────────────

async function loadSettingsTab() {
  const isManager = auth.getRole() === 'manager';
  const managerCard = el('vs-settings-manager-telegram');
  const adminCards = document.querySelectorAll('.vs-settings-admin-only');
  if (isManager) {
    if (managerCard) managerCard.style.display = '';
    adminCards.forEach(el => { el.style.display = 'none'; });
    const statusEl = el('vs-settings-manager-telegram-status');
    try {
      const status = await api.getVsTelegramStatus();
      if (statusEl) statusEl.textContent = status.linked ? 'Привязан — отчёты приходят в Telegram' : 'Не привязан. Нажмите «В Telegram» на вкладке Статистика.';
    } catch {
      if (statusEl) statusEl.textContent = '—';
    }
  } else {
    if (managerCard) managerCard.style.display = 'none';
    adminCards.forEach(el => { el.style.display = ''; });
  }

  await loadStatus();
  if (auth.getRole() === 'admin') {
    el('vs-admin-users-card').style.display = '';
    await loadVsAdminUsers();
  } else {
    el('vs-admin-users-card').style.display = 'none';
  }
  if (!isManager) {
    await loadShiftsInfo();
    await loadEmplInfo();
    await loadCookieInfo();
    await loadTelegramInfo();
  }
}

async function loadCookieInfo() {
  try {
    const config = await api.getConfig();
    const cookieStatus = el('cookie-status');
    // Сервер маскирует куки как '***' если они есть
    if (config.cookie === '***') {
      if (cookieStatus) {
        cookieStatus.textContent = 'Куки заданы — запросы возможны вне корпоративной сети';
        cookieStatus.style.color = 'var(--green)';
      }
      // Не заполняем textarea — не показываем секретное значение
    } else {
      if (cookieStatus) {
        cookieStatus.textContent = 'Не задано — запросы только из корпоративной сети';
        cookieStatus.style.color = 'var(--text-muted)';
      }
    }
  } catch { /* ignore */ }
}

function getTelegramChatsFromConfig(config) {
  if (Array.isArray(config.telegramChats) && config.telegramChats.length > 0) {
    return config.telegramChats.map(c => ({
      chatId: String(c.chatId || '').trim(),
      threadIdConsolidation: String(c.threadIdConsolidation ?? c.threadId ?? '').trim(),
      threadIdStats: String(c.threadIdStats ?? c.threadId ?? '').trim(),
      label: String(c.label != null ? c.label : '').trim(),
    }));
  }
  if (config.telegramChatId && String(config.telegramChatId).trim()) {
    return [{
      chatId: String(config.telegramChatId).trim(),
      threadIdConsolidation: String(config.telegramThreadId || '').trim(),
      threadIdStats: String(config.telegramThreadId || '').trim(),
      label: '',
    }];
  }
  return [];
}

function renderTelegramChatsList(container, chats) {
  if (!container) return;
  container.innerHTML = chats.map((c, i) => `
    <div class="telegram-chat-row" data-index="${i}">
      <input type="text" class="form-control tg-chat-id" placeholder="Chat ID (-100... или id пользователя)" value="${escAttr(c.chatId)}" title="Chat ID">
      <input type="text" class="form-control tg-thread-cons" placeholder="Thread консолидации" value="${escAttr(c.threadIdConsolidation)}" title="ID темы для ошибок комплектации">
      <input type="text" class="form-control tg-thread-stats" placeholder="Thread статистики" value="${escAttr(c.threadIdStats)}" title="ID темы для статистики">
      <button type="button" class="btn btn-icon btn-icon-del btn-telegram-del" title="Удалить чат">✕</button>
    </div>
  `).join('');
  container.querySelectorAll('.btn-telegram-del').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.telegram-chat-row')?.remove();
    });
  });
}

async function loadTelegramInfo() {
  try {
    const config = await api.getConfig();
    const statusEl = el('telegram-status');
    const listEl = el('telegram-chats-list');
    const hasToken = config.telegramBotToken === '***';
    const chats = getTelegramChatsFromConfig(config);
    const hasChats = chats.some(c => c.chatId);

    renderTelegramChatsList(listEl, chats.length ? chats : [{ chatId: '', threadId: '', label: '' }]);

    if (statusEl) {
      if (hasToken && hasChats) {
        statusEl.textContent = `Настроено: bot token сохранён, чатов: ${chats.filter(c => c.chatId).length}`;
        statusEl.style.color = 'var(--green)';
      } else {
        statusEl.textContent = 'Не настроено';
        statusEl.style.color = 'var(--text-muted)';
      }
    }
  } catch { /* ignore */ }
}

// ─── Пользователи /vs (только админ) ─────────────────────────────────────────

const VS_MODULE_LABELS = { stats: 'Статистика', data: 'Данные', monitor: 'Мониторинг', consolidation: 'Консолидация', docs: 'Документы', settings: 'Настройки' };
const VS_ROLE_LABELS = { admin: 'Админ', group_leader: 'Руководитель группы', supervisor: 'Начальник смены', manager: 'Менеджер' };

async function loadVsAdminUsers() {
  try {
    const list = await api.getVsAdminUsers();
    renderVsAdminUsers(list);
  } catch (err) {
    const card = el('vs-admin-users-card');
    if (card) card.style.display = 'none';
    showNotification('Ошибка загрузки пользователей: ' + err.message, 'error');
  }
}

function renderVsAdminUsers(list) {
  const summaryEl = el('vs-users-summary');
  const tbody = el('vs-admin-users-tbody');
  if (!tbody) return;
  const successful = list.filter(u => u.lastSuccessAt).length;
  if (summaryEl) summaryEl.textContent = `Всего: ${list.length}, успешных входов (получили токен): ${successful}`;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-row">Нет записей о входах</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(u => {
    let roleText = u.role ? (VS_ROLE_LABELS[u.role] || u.role) : '—';
    if (u.role === 'manager' && u.companyIds && u.companyIds.length) {
      roleText += ' · ' + u.companyIds.join(', ');
    }
    if (u.allowWithoutToken) roleText += ' (без токена)';
    if (u.hasPassword) roleText += ' · пароль';
    const modulesText = (u.modules && u.modules.length) ? u.modules.map(m => VS_MODULE_LABELS[m] || m).join(', ') : '—';
    const successText = u.lastSuccessAt ? formatDateTime(u.lastSuccessAt) : (u.lastAttemptAt ? 'Нет (ошибка)' : '—');
    const actions = u.hasAccess
      ? `<button type="button" class="btn btn-sm btn-secondary vs-user-edit" data-login="${escAttr(u.login)}">Изменить</button> <button type="button" class="btn btn-sm btn-danger vs-user-delete" data-login="${escAttr(u.login)}">Удалить</button>`
      : `<button type="button" class="btn btn-sm btn-primary vs-user-edit" data-login="${escAttr(u.login)}">Дать доступ</button>`;
    return `<tr>
      <td>${esc(u.login)}</td>
      <td>${esc(roleText)}</td>
      <td style="max-width:200px;font-size:12px">${esc(modulesText)}</td>
      <td style="font-size:12px">${esc(successText)}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('.vs-user-edit').forEach(btn => {
    btn.addEventListener('click', () => openVsUserEditModal(list.find(u => u.login === btn.dataset.login) || { login: btn.dataset.login }));
  });
  tbody.querySelectorAll('.vs-user-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteVsUser(btn.dataset.login));
  });
}

function initVsUserEditModalCheckboxes() {
  const container = el('vs-user-edit-modules');
  if (!container || container.dataset.inited) return;
  container.dataset.inited = '1';
  const modules = ['stats', 'data', 'monitor', 'consolidation', 'docs', 'settings'];
  container.innerHTML = modules.map(m => `
    <label class="checkbox-label" style="display:block;margin-bottom:6px">
      <input type="checkbox" class="vs-module-cb" value="${escAttr(m)}"> ${VS_MODULE_LABELS[m]}
    </label>
  `).join('');
}

function openVsUserEditModal(user) {
  initVsUserEditModalCheckboxes();
  const isNew = !user || !user.login;
  el('vs-user-edit-title').textContent = isNew ? 'Добавить пользователя' : 'Права и модули';
  const loginInp = el('vs-user-edit-login');
  loginInp.value = user?.login || '';
  loginInp.disabled = !!user?.login;
  const role = user?.role || 'manager';
  el('vs-user-edit-role').value = role;
  const companiesRow = el('vs-user-edit-companies-row');
  const companiesInp = el('vs-user-edit-companies');
  if (companiesRow) companiesRow.style.display = role === 'manager' ? '' : 'none';
  if (companiesInp) companiesInp.value = (user?.companyIds && user.companyIds.length) ? user.companyIds.join(', ') : '';
  const allowWithoutTokenCb = el('vs-user-edit-allow-without-token');
  if (allowWithoutTokenCb) allowWithoutTokenCb.checked = !!user?.allowWithoutToken;
  const passwordInp = el('vs-user-edit-password');
  if (passwordInp) passwordInp.value = '';
  const mods = user?.modules || [];
  const container = el('vs-user-edit-modules');
  if (container) container.querySelectorAll('.vs-module-cb').forEach(cb => {
    cb.checked = mods.includes(cb.value);
  });
  el('vs-user-edit-modal').classList.add('modal--open');
}

function toggleVsUserEditCompaniesRow() {
  const role = el('vs-user-edit-role')?.value;
  const row = el('vs-user-edit-companies-row');
  if (row) row.style.display = role === 'manager' ? '' : 'none';
}

function closeVsUserEditModal() {
  el('vs-user-edit-modal').classList.remove('modal--open');
}

async function saveVsUserEdit() {
  const login = el('vs-user-edit-login').value.trim();
  if (!login) { showNotification('Введите логин (номер)', 'error'); return; }
  const role = el('vs-user-edit-role').value;
  const modules = [];
  el('vs-user-edit-modules').querySelectorAll('.vs-module-cb:checked').forEach(cb => modules.push(cb.value));
  let companyIds = undefined;
  if (role === 'manager') {
    const raw = (el('vs-user-edit-companies')?.value || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
    companyIds = raw.length ? raw : [];
  } else {
    companyIds = [];
  }
  const allowWithoutToken = el('vs-user-edit-allow-without-token')?.checked || false;
  const passwordVal = (el('vs-user-edit-password')?.value || '').trim();
  const payload = { role, modules, companyIds, allowWithoutToken };
  if (passwordVal) payload.password = passwordVal;
  try {
    await api.putVsAdminUser(login, payload);
    showNotification('Сохранено', 'success');
    closeVsUserEditModal();
    await loadVsAdminUsers();
  } catch (err) {
    showNotification('Ошибка: ' + err.message, 'error');
  }
}

async function deleteVsUser(login) {
  if (!window.confirm(`Удалить доступ для ${login}?`)) return;
  try {
    await api.deleteVsAdminUser(login);
    showNotification('Доступ удалён', 'success');
    await loadVsAdminUsers();
  } catch (err) {
    showNotification('Ошибка: ' + err.message, 'error');
  }
}

async function loadShiftsInfo() {
  try {
    const shifts = await api.listShifts();
    const tbody = el('shifts-info-tbody');
    if (!tbody) return;
    if (!shifts.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-row">Нет сохранённых смен</td></tr>';
      return;
    }
    tbody.innerHTML = shifts.map(s => `
      <tr>
        <td>${shiftLabel(s.shiftKey)}</td>
        <td style="text-align:right;font-weight:600">${s.count.toLocaleString('ru-RU')}</td>
        <td style="color:var(--text-muted);font-size:12px">${s.updatedAt ? formatDateTime(s.updatedAt) : '—'}</td>
      </tr>
    `).join('');
  } catch { /* ignore */ }
}

async function loadEmplInfo() {
  try {
    const res = await api.getEmployees();
    const infoEl = el('empl-file-info');
    const parsed = res.csv ? parseEmplCsv(res.csv) : { map: new Map(), companies: [] };
    if (res.csv) applyEmplCsv(res.csv);
    const count = parsed.map.size;
    const companies = parsed.companies;
    if (infoEl) {
      infoEl.textContent = res.csv
        ? count + ' сотрудников, ' + companies.length + ' подрядчиков' + (companies.length ? ': ' + companies.join(', ') : '')
        : 'Список пуст — добавьте вручную или загрузите CSV';
    }
    renderEmplNoCompanyList(parsed.map);
    renderEmplEditor(parsed.map, companies);
    filterEmplSearch();
  } catch { /* ignore */ }
}

// ─── Редактор сотрудников ────────────────────────────────────────────────────

/** Список «Сотрудники без компании»: из данных, но не в empl.csv. Клик → ввод компании → POST /api/empl → обновление. */
function renderEmplNoCompanyList(emplMapArg) {
  const listEl = el('empl-no-company-list');
  const emptyEl = el('empl-no-company-empty');
  if (!listEl) return;

  const fioToFull = new Map();
  for (const item of allItems) {
    const fio = (item.executor || '').trim();
    if (!fio) continue;
    const norm = normFio(fio);
    if (!hasMatchInEmplKeys(norm, emplMapArg)) fioToFull.set(norm, fio);
  }
  const noCompany = [...fioToFull.values()].sort((a, b) => a.localeCompare(b));

  if (emptyEl) emptyEl.style.display = noCompany.length ? 'none' : 'block';
  listEl.innerHTML = noCompany.map(fio => `<li><button type="button" class="btn-empl-fio">${escAttr(fio)}</button></li>`).join('');

  listEl.querySelectorAll('.btn-empl-fio').forEach(btn => {
    btn.addEventListener('click', async () => {
      const fio = btn.textContent.trim();
      const company = window.prompt('Введите компанию для сотрудника:\n' + fio, '');
      if (company == null) return;
      try {
        const data = await api.saveEmplOne(fio, company.trim());
        if (data.ok) {
          showNotification('Сохранено в empl.csv', 'success');
          await loadEmplInfo();
          renderAll();
        } else {
          showNotification('Ошибка: ' + (data.error || 'не удалось сохранить'), 'error');
        }
      } catch (e) {
        showNotification('Ошибка: ' + e.message, 'error');
      }
    });
  });
}

function filterEmplSearch() {
  const q = (el('empl-search-input')?.value || '').trim().toLowerCase();
  const run = (tbody) => {
    if (!tbody) return;
    for (const tr of tbody.querySelectorAll('tr')) {
      if (tr.classList.contains('empty-row') || tr.querySelector('.empty-row')) {
        tr.style.display = q ? 'none' : '';
        continue;
      }
      const fioCell = tr.querySelector('.empl-input-fio');
      const companyCell = tr.querySelector('.empl-select');
      const companyInp = tr.querySelector('.empl-input-company');
      const fio = (fioCell?.value || '').toLowerCase();
      const company = (companyCell ? (companyCell.options[companyCell.selectedIndex]?.text || '') : '') || (companyInp?.value || '').toLowerCase();
      const match = !q || fio.includes(q) || company.includes(q);
      tr.style.display = match ? '' : 'none';
    }
  };
  run(el('empl-editor-tbody'));
}

function renderEmplEditor(emplMapArg, companiesArg) {
  const tbody = el('empl-editor-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const [fioKey, company] of emplMapArg) {
    tbody.appendChild(makeEmplRow(fioKey, company, companiesArg));
  }
  if (!emplMapArg.size) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-row">Нет сотрудников — добавьте вручную или загрузите CSV</td></tr>';
  }
}

function makeEmplRow(fio, company, companies, isNew = false) {
  const tr = document.createElement('tr');
  if (isNew) tr.classList.add('empl-row-new');

  const opts = ['', ...(companies || [])].map(c => {
    const selAttr = c === company ? ' selected' : '';
    return '<option value="' + escAttr(c) + '"' + selAttr + '>' + escAttr(c || '— не указана —') + '</option>';
  }).join('');

  tr.innerHTML =
    '<td><input class="empl-input empl-input-fio" type="text" value="' + escAttr(fio) + '" placeholder="ФИО"></td>' +
    '<td><div style="display:flex;gap:4px;"><select class="empl-select">' + opts + '</select>' +
    '<input class="empl-input empl-input-company" type="text" placeholder="или новая..." style="width:110px;flex-shrink:0"></div></td>' +
    '<td><button class="btn-icon btn-icon-del" title="Удалить">✕</button></td>';

  tr.querySelector('.btn-icon-del').addEventListener('click', () => tr.remove());
  const selEl = tr.querySelector('.empl-select');
  const inpEl = tr.querySelector('.empl-input-company');
  inpEl.addEventListener('input', () => { if (inpEl.value) selEl.value = ''; });
  selEl.addEventListener('change', () => { if (selEl.value) inpEl.value = ''; });
  return tr;
}

function escAttr(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function collectEmplRows(tbodyId) {
  const rows = [];
  const tbody = el(tbodyId);
  if (!tbody) return rows;
  for (const tr of tbody.querySelectorAll('tr')) {
    const fio = tr.querySelector('.empl-input-fio')?.value.trim();
    const selVal = tr.querySelector('.empl-select')?.value.trim();
    const inpVal = tr.querySelector('.empl-input-company')?.value.trim();
    const company = inpVal || selVal || '';
    if (fio) rows.push({ fio, company });
  }
  return rows;
}

async function saveEmplEditor() {
  const mainRows = collectEmplRows('empl-editor-tbody');
  const seen = new Set();
  const all = [];
  for (const r of mainRows) {
    const k = normFio(r.fio);
    if (!seen.has(k)) { seen.add(k); all.push(r); }
  }
  const csv = all.map(r => r.fio + ';' + r.company).join('\n');
  try {
    const res = await fetch('/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv }),
    });
    const data = await res.json();
    if (data.ok) {
      showNotification('Сохранено ' + all.length + ' сотрудников', 'success');
      applyEmplCsv(csv);
      await loadEmplInfo();
      renderAll();
    } else {
      showNotification('Ошибка: ' + data.error, 'error');
    }
  } catch (err) {
    showNotification('Ошибка: ' + err.message, 'error');
  }
}

function exportEmplCsv() {
  const mainRows = collectEmplRows('empl-editor-tbody');
  const all = [...mainRows];
  if (!all.length) { showNotification('Нет данных для экспорта', 'error'); return; }
  const csv = all.map(r => r.fio + ';' + r.company).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'employees.csv'; a.click();
  URL.revokeObjectURL(url);
}

/** Цвета СЗ для XLSX (как в таблице: красный <50, градиент 50–75, белый >75). */
const HOURLY_XLSX_FILL = {
  red:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFECACA' } },
  mid:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF08A' } },
  white: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } },
};

const XLSX_BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
const XLSX_ALIGN = { horizontal: 'center', vertical: 'middle' };

async function exportHourlyToXlsx() {
  const wrap = el('hourly-employee-table-wrap');
  const table = wrap?.querySelector('.he-table');
  if (!table) {
    showNotification('Таблица не найдена', 'error');
    return;
  }
  const thead = table.querySelector('thead tr');
  const tbody = table.querySelector('tbody');
  const bodyRows = tbody ? [...tbody.querySelectorAll('tr')] : [];
  if (!thead || !bodyRows.length) {
    showNotification('Нет данных для экспорта', 'error');
    return;
  }
  const ExcelJS = window.ExcelJS || globalThis.ExcelJS;
  if (!ExcelJS) {
    showNotification('Библиотека ExcelJS не загружена', 'error');
    return;
  }
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Сотрудники по часам', { views: [{ state: 'frozen', ySplit: 1 }] });
    const headerCells = thead.querySelectorAll('th');
    const headerRow = [...headerCells].map(th => th.textContent?.trim() || '');
    ws.addRow(headerRow);
    const headerStyle = {
      font: { bold: true },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } },
      border: XLSX_BORDER,
      alignment: XLSX_ALIGN,
    };
    ws.getRow(1).eachCell(c => { c.style = headerStyle; });

    const parsed = [];
    for (const tr of bodyRows) {
      const cells = tr.querySelectorAll('td');
      const rowData = [];
      const cellStyles = [];
      let totalNum = 0;
      let companyStr = '';
      cells.forEach((td, idx) => {
        const text = td.textContent?.trim() ?? '';
        const cls = td.className || '';
        if (cls.includes('he-td-total')) {
          const num = text === '' ? 0 : Number(text);
          totalNum = Number.isNaN(num) ? 0 : num;
          rowData.push(totalNum);
        } else if (cls.includes('he-td-val')) {
          rowData.push(text === '' ? 0 : Number(text));
        } else {
          if (idx === 0) companyStr = text;
          rowData.push(text);
        }
        let fill = null;
        if (cls.includes('he-sz-red')) fill = HOURLY_XLSX_FILL.red;
        else if (cls.includes('he-sz-mid')) fill = HOURLY_XLSX_FILL.mid;
        else if (cls.includes('he-sz-white')) fill = HOURLY_XLSX_FILL.white;
        cellStyles.push(fill);
      });
      parsed.push({ rowData, cellStyles, total: totalNum, company: companyStr });
    }

    parsed.sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return (b.company || '').localeCompare(a.company || '', 'ru');
    });

    for (const { rowData, cellStyles } of parsed) {
      const row = ws.addRow(rowData);
      row.eachCell((cell, colNumber) => {
        const fill = cellStyles[colNumber - 1];
        cell.style = {
          border: XLSX_BORDER,
          alignment: XLSX_ALIGN,
          ...(fill ? { fill } : {}),
        };
      });
    }
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `сотрудники_по_часам_${selectedDate || 'дата'}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    showNotification('Файл .xlsx загружен', 'success');
  } catch (err) {
    showNotification('Ошибка экспорта: ' + err.message, 'error');
  }
}

// ─── Обработчики событий ─────────────────────────────────────────────────────

function setupEventListeners() {
  // Мониторинг — перекличка
  el('btn-rollcall')?.addEventListener('click', () => {
    const shiftKey = getCurrentShiftKeyLocal();
    openRollcallModal(shiftKey);
  });
  el('btn-rollcall-close')?.addEventListener('click', closeRollcallModal);
  el('btn-rollcall-cancel')?.addEventListener('click', closeRollcallModal);
  el('btn-rollcall-save')?.addEventListener('click', async () => {
    const shiftKey = getCurrentShiftKeyLocal();
    await saveRollcall(shiftKey);
    updateRollcallInfo();
  });
  el('btn-rc-all-global')?.addEventListener('click', () => {
    document.querySelectorAll('.rc-check').forEach(cb => cb.checked = true);
  });
  el('btn-rc-none-global')?.addEventListener('click', () => {
    document.querySelectorAll('.rc-check').forEach(cb => cb.checked = false);
  });
  el('btn-monitor-refresh')?.addEventListener('click', () => {
    refreshMonitor();
  });

  // Авторизация
  el('login-form')?.addEventListener('submit', handleLogin);
  el('btn-logout')?.addEventListener('click', () => auth.logout());

  // Пользователи /vs (админ)
  el('vs-admin-add-user')?.addEventListener('click', () => openVsUserEditModal(null));
  el('vs-user-edit-role')?.addEventListener('change', toggleVsUserEditCompaniesRow);
  el('vs-user-edit-close')?.addEventListener('click', closeVsUserEditModal);
  el('vs-user-edit-cancel')?.addEventListener('click', closeVsUserEditModal);
  el('vs-user-edit-save')?.addEventListener('click', saveVsUserEdit);
  el('vs-user-edit-modal')?.addEventListener('click', e => {
    if (e.target.id === 'vs-user-edit-modal') closeVsUserEditModal();
  });

  // Выбор даты — оба календаря (статистика и данные)
  for (const id of ['date-picker-stats', 'date-picker-data']) {
    el(id)?.addEventListener('change', async e => {
      selectedDate = e.target.value;
      syncDatePickers();
      await loadDateData(selectedDate);
    });
  }

  // Тумблер День / Ночь — синхронизация обоих тулбаров
  document.querySelectorAll('.shift-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      shiftFilter = btn.dataset.shift;
      syncShiftToggle();
      loadDateData(selectedDate);
    });
  });

  async function runFetchForHours(forceRecheck) {
    const fromHour = Math.max(0, Math.min(23, parseInt(el('fetch-hour-from')?.value, 10) || 9));
    const toHour = Math.max(0, Math.min(23, parseInt(el('fetch-hour-to')?.value, 10) || 21));

    const covered = getCoveredHoursForDate(selectedDate, shiftFilter);
    const requestedHours = [];
    if (shiftFilter === 'day') {
      for (let h = fromHour; h < toHour && h < 21; h++) requestedHours.push(h);
    } else {
      if (fromHour >= toHour) {
        for (let h = fromHour; h <= 23; h++) requestedHours.push(h);
        for (let h = 0; h < toHour; h++) requestedHours.push(h);
      } else {
        for (let h = fromHour; h < toHour; h++) requestedHours.push(h);
      }
    }

    let missingHours = forceRecheck ? [...requestedHours] : requestedHours.filter(h => !covered.has(h));
    const todayStr = getTodayStr();
    const currentHour = new Date().getHours();
    if (!forceRecheck && selectedDate === todayStr && requestedHours.includes(currentHour)) {
      if (!missingHours.includes(currentHour)) missingHours = [...missingHours, currentHour].sort((a, b) => a - b);
    }

    if (missingHours.length === 0) {
      if (!forceRecheck) {
        showNotification('Данные за выбранный диапазон уже загружены', 'success');
        await loadDateData(selectedDate);
        await loadStatus();
      }
      return;
    }

    const [y, m, d] = selectedDate.split('-').map(Number);
    const minH = Math.min(...missingHours);
    const maxH = Math.max(...missingHours);
    let fromDate;
    let toDate;
    if (shiftFilter === 'night' && (minH >= 22 || maxH < 9)) {
      const prev = new Date(y, m - 1, d);
      prev.setDate(prev.getDate() - 1);
      if (minH >= 22) {
        fromDate = new Date(prev.getFullYear(), prev.getMonth(), prev.getDate(), minH, 0, 0, 0);
      } else {
        fromDate = new Date(y, m - 1, d, minH, 0, 0, 0);
      }
      if (maxH >= 22) {
        toDate = new Date(prev.getFullYear(), prev.getMonth(), prev.getDate(), maxH, 59, 59, 999);
      } else {
        toDate = new Date(y, m - 1, d, maxH, 59, 59, 999);
      }
    } else {
      fromDate = new Date(y, m - 1, d, minH, 0, 0, 0);
      toDate = new Date(y, m - 1, d, maxH, 59, 59, 999);
    }
    if (!forceRecheck && selectedDate === todayStr && minH === currentHour) {
      const lastTs = getLastCompletedAtForHour(selectedDate, currentHour, shiftFilter);
      if (lastTs != null) {
        fromDate = new Date(lastTs);
      } else {
        fromDate = new Date(y, m - 1, d, currentHour, 0, 0, 0);
      }
    }

    showNotification(forceRecheck
      ? `Перепроверяю ${minH}:00–${maxH + 1}:00…`
      : `Запрашиваю только ${minH}:00–${maxH + 1}:00 (без уже загруженных)…`, 'info');

    let res;
    if (window.VS_PAGE) {
      const token = auth.getToken();
      if (!token) throw new Error('Войдите в систему');
      res = await api.fetchDataViaBrowser(token, {
        operationCompletedAtFrom: fromDate.toISOString(),
        operationCompletedAtTo: toDate.toISOString(),
      });
    } else {
      res = await api.fetchData({
        operationCompletedAtFrom: fromDate.toISOString(),
        operationCompletedAtTo: toDate.toISOString(),
      });
    }
    if (res.success === false) throw new Error(res.error);
    showNotification(`Получено ${res.fetched}, добавлено ${res.added}`, 'success');
    await loadDateData(selectedDate);
    await loadStatus();
  }

  el('btn-fetch-now')?.addEventListener('click', async () => {
    const btn = el('btn-fetch-now');
    btn.disabled = true;
    btn.textContent = 'Загрузка...';
    try {
      await runFetchForHours(false);
    } catch (err) {
      showNotification('Ошибка: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '⟳ Обновить данные';
    }
  });

  el('btn-recheck-from-hour')?.addEventListener('click', async () => {
    const btn = el('btn-recheck-from-hour');
    btn.disabled = true;
    try {
      await runFetchForHours(true);
    } catch (err) {
      showNotification('Ошибка: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Экспорт
  el('btn-export')?.addEventListener('click', () => {
    const safe = (selectedDate || '').replace(/[^0-9-]/g, '_');
    tableModule.exportTable(`operations_${safe}.csv`);
  });

  // Экспорт «Сотрудники по часам» в XLSX с раскраской СЗ
  el('btn-export-hourly-xlsx')?.addEventListener('click', exportHourlyToXlsx);

  // Закрытие модалки привязки Telegram
  function closeVsTelegramBindModal() {
    if (telegramBindPollId) clearInterval(telegramBindPollId);
    telegramBindPollId = null;
    el('vs-telegram-bind-modal')?.classList.remove('modal--open');
  }
  el('vs-telegram-bind-close')?.addEventListener('click', closeVsTelegramBindModal);
  el('vs-telegram-bind-modal')?.addEventListener('click', e => {
    if (e.target.id === 'vs-telegram-bind-modal') closeVsTelegramBindModal();
  });

  async function runSendHourlyTelegram(btn, companies, byCompany, hours, shiftFilter, selectedDate, allRows) {
    const dateStr = (selectedDate || '').replace(/(\d{4})-(\d{2})-(\d{2})/, '$3.$2.$1');
    const shiftLabelText = shiftFilter === 'night' ? 'Ночь' : 'День';
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;top:0;width:800px;';
    document.body.appendChild(container);
    if (btn) btn.disabled = true;
    try {
      const items = [];
      if (allRows && allRows.length > 0) {
        try {
          const fullHtml = buildHourlyTableHtmlFullList(allRows, hours, dateStr, shiftLabelText);
          container.innerHTML = fullHtml;
          const div = container.querySelector('.he-telegram-wrap') || container.firstElementChild;
          if (div) {
            const canvas = await window.html2canvas(div, {
              scale: 2,
              useCORS: true,
              logging: false,
              backgroundColor: '#ffffff',
            });
            const blob = await new Promise((resolve, reject) => {
              canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG'))), 'image/png', 1);
            });
            if (blob && blob.size > 0) {
              items.push({
                blob,
                caption: `Весь список по часам • ${dateStr} • ${shiftLabelText}`,
                filename: `full_list_${dateStr.replace(/\./g, '-')}.png`,
              });
            }
          }
        } catch (fullListErr) {
          console.warn('Общий список по часам не удалось сформировать:', fullListErr);
        }
      }
      for (const companyName of companies) {
        const rows = byCompany[companyName] || [];
        const html = buildHourlyTableHtmlForCompany(companyName, rows, hours, dateStr, shiftLabelText);
        container.innerHTML = html;
        const div = container.firstElementChild;
        if (!div) continue;
        const canvas = await window.html2canvas(div, {
          scale: 2,
          useCORS: true,
          logging: false,
          backgroundColor: '#ffffff',
        });
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG'))), 'image/png', 1);
        });
        const safeName = companyName.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 40) || 'company';
        items.push({
          blob,
          caption: `Сотрудники по часам • ${companyName} • ${dateStr} • ${shiftLabelText}`,
          filename: `${safeName}_${dateStr.replace(/\./g, '-')}.png`,
        });
      }
      document.body.removeChild(container);
      const res = await api.sendHourlyStatsTelegram(items);
      if (res.ok) showNotification(`Отправлено в Telegram: ${res.sent || items.length} файл(ов)`, 'success');
      else throw new Error(res.error || 'Ошибка отправки');
    } catch (err) {
      if (container.parentNode) document.body.removeChild(container);
      showNotification('Ошибка: ' + err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // Отправить «Сотрудники по часам» в Telegram. Менеджер: при первом нажатии — привязка, затем отправка в личку.
  el('btn-hourly-telegram-png')?.addEventListener('click', async () => {
    const btn = el('btn-hourly-telegram-png');
    if (!window.html2canvas) {
      showNotification('Библиотека html2canvas не загружена', 'error');
      return;
    }
    const tableItems = getFilteredItems();
    const { hours, byCompany, allRows, companiesOrder } = getHourlyByEmployeeGroupedByCompany(tableItems, shiftFilter, emplMap, selectedDate);
    const companies = (companiesOrder || Object.keys(byCompany)).filter(c => (byCompany[c] || []).length > 0);
    const allRowsResolved = Array.isArray(allRows) && allRows.length > 0
      ? allRows
      : companies.flatMap(c => byCompany[c] || []);
    if (!companies.length && !allRowsResolved.length) {
      showNotification('Нет данных для отправки', 'error');
      return;
    }

    const isManager = auth.getRole() === 'manager';
    if (isManager) {
      try {
        const status = await api.getVsTelegramStatus();
        if (!status.linked) {
          const bind = await api.postVsTelegramBindStart();
          el('vs-telegram-bind-bot').textContent = bind.botUsername ? `@${bind.botUsername}` : '@bot';
          el('vs-telegram-bind-code').textContent = bind.code || '—';
          el('vs-telegram-bind-modal').classList.add('modal--open');
          if (telegramBindPollId) clearInterval(telegramBindPollId);
          telegramBindPollId = setInterval(async () => {
            try {
              const s = await api.getVsTelegramStatus();
              if (s.linked) {
                if (telegramBindPollId) clearInterval(telegramBindPollId);
                telegramBindPollId = null;
                el('vs-telegram-bind-modal').classList.remove('modal--open');
                await runSendHourlyTelegram(btn, companies, byCompany, hours, shiftFilter, selectedDate, allRowsResolved);
              }
            } catch (_) {}
          }, 2000);
          return;
        }
      } catch (err) {
        showNotification(err.message, 'error');
        return;
      }
    }

    await runSendHourlyTelegram(btn, companies, byCompany, hours, shiftFilter, selectedDate, allRowsResolved);
  });

  // Поиск
  el('search-input')?.addEventListener('input', e => tableModule.setSearch(e.target.value));

  // Настройки: запуск/остановка
  el('settings-schedule-start')?.addEventListener('click', async () => {
    const res = await api.scheduleStart();
    showNotification(res.message, res.ok ? 'success' : 'error');
    await loadStatus();
  });

  el('settings-schedule-stop')?.addEventListener('click', async () => {
    const res = await api.scheduleStop();
    showNotification(res.message, 'info');
    await loadStatus();
  });

  // Настройки: сохранить интервал + pageSize
  el('btn-save-schedule')?.addEventListener('click', async () => {
    const intervalVal = parseInt(el('setting-interval')?.value, 10);
    const pageSizeVal = parseInt(el('setting-page-size')?.value, 10);

    if (!intervalVal || intervalVal < 1) {
      showNotification('Введите корректный интервал (от 1 мин)', 'error'); return;
    }
    if (!pageSizeVal || pageSizeVal < 1 || pageSizeVal > 1000) {
      showNotification('Записей на страницу: от 1 до 1000', 'error'); return;
    }

    const res = await api.scheduleSettings({ intervalMinutes: intervalVal, pageSize: pageSizeVal });
    if (res.ok) {
      showNotification(
        res.restarted
          ? `Настройки сохранены, планировщик перезапущен (${intervalVal} мин, ${pageSizeVal}/стр.)`
          : `Настройки сохранены: ${intervalVal} мин, ${pageSizeVal} зап./стр.`,
        'success'
      );
      await loadStatus();
    } else {
      showNotification('Ошибка: ' + res.error, 'error');
    }
  });

  // Настройки: импорт CSV сотрудников
  el('empl-file-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let csvText;
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      csvText = new TextDecoder('utf-8').decode(bytes.slice(3));
    } else {
      const hasHighBytes = bytes.some(b => b >= 0xC0);
      csvText = new TextDecoder(hasHighBytes ? 'windows-1251' : 'utf-8').decode(bytes);
    }
    applyEmplCsv(csvText);
    await loadEmplInfo();
    renderAll();
    showNotification('CSV импортирован — проверьте данные и нажмите «Сохранить»', 'info');
    e.target.value = '';
  });

  // Настройки: сохранить редактор сотрудников
  el('btn-save-empl')?.addEventListener('click', saveEmplEditor);

  // Настройки: экспорт CSV сотрудников
  el('btn-export-empl')?.addEventListener('click', exportEmplCsv);

  // Настройки: добавить пустую строку
  el('btn-add-empl-row')?.addEventListener('click', () => {
    const tbody = el('empl-editor-tbody');
    if (!tbody) return;
    const emptyTr = tbody.querySelector('.empty-row')?.closest('tr');
    if (emptyTr) emptyTr.remove();
    tbody.appendChild(makeEmplRow('', '', emplCompanies));
    tbody.lastElementChild.querySelector('.empl-input-fio')?.focus();
  });

  // Поиск по сотрудникам в настройках
  el('empl-search-input')?.addEventListener('input', () => filterEmplSearch());

  // Настройки: сохранить куки
  el('btn-save-cookie')?.addEventListener('click', async () => {
    const cookieVal = (el('setting-cookie')?.value || '').trim();
    if (!cookieVal) {
      showNotification('Вставьте значение Cookie', 'error');
      return;
    }
    const res = await api.putConfig({ cookie: cookieVal });
    if (res.ok) {
      el('setting-cookie').value = '';
      showNotification('Cookie сохранены — теперь запросы работают вне корпоративной сети', 'success');
      await loadCookieInfo();
    } else {
      showNotification('Ошибка: ' + res.error, 'error');
    }
  });

  // Настройки: очистить куки
  el('btn-clear-cookie')?.addEventListener('click', async () => {
    const res = await api.putConfig({ cookie: '' });
    if (res.ok) {
      el('setting-cookie').value = '';
      showNotification('Cookie очищены', 'info');
      await loadCookieInfo();
    }
  });

  // Настройки: добавить чат Telegram
  el('btn-telegram-add-chat')?.addEventListener('click', () => {
    const listEl = el('telegram-chats-list');
    if (!listEl) return;
    const row = document.createElement('div');
    row.className = 'telegram-chat-row';
    row.innerHTML = `
      <input type="text" class="form-control tg-chat-id" placeholder="Chat ID (-100... или id пользователя)" value="" title="Chat ID">
      <input type="text" class="form-control tg-thread-cons" placeholder="Thread консолидации" value="" title="ID темы для ошибок комплектации">
      <input type="text" class="form-control tg-thread-stats" placeholder="Thread статистики" value="" title="ID темы для статистики">
      <button type="button" class="btn btn-icon btn-icon-del btn-telegram-del" title="Удалить чат">✕</button>
    `;
    row.querySelector('.btn-telegram-del').addEventListener('click', () => row.remove());
    listEl.appendChild(row);
  });

  // Настройки: сохранить Telegram
  el('btn-save-telegram')?.addEventListener('click', async () => {
    const tokenVal = (el('setting-telegram-token')?.value || '').trim();
    const rows = el('telegram-chats-list')?.querySelectorAll('.telegram-chat-row') || [];
    const telegramChats = [];
    for (const row of rows) {
      const chatId = (row.querySelector('.tg-chat-id')?.value || '').trim();
      const threadIdConsolidation = (row.querySelector('.tg-thread-cons')?.value || '').trim();
      const threadIdStats = (row.querySelector('.tg-thread-stats')?.value || '').trim();
      if (!chatId) continue;
      if (threadIdConsolidation && !/^\d+$/.test(threadIdConsolidation)) {
        showNotification('Thread ID консолидации должен быть целым положительным числом', 'error');
        return;
      }
      if (threadIdStats && !/^\d+$/.test(threadIdStats)) {
        showNotification('Thread ID статистики должен быть целым положительным числом', 'error');
        return;
      }
      telegramChats.push({ chatId, threadIdConsolidation, threadIdStats, label: '' });
    }
    if (!telegramChats.length) {
      showNotification('Добавьте хотя бы один чат с Chat ID', 'error');
      return;
    }
    const payload = { telegramChats };
    if (tokenVal) payload.telegramBotToken = tokenVal;

    const res = await api.putConfig(payload);
    if (res.ok) {
      if (el('setting-telegram-token')) el('setting-telegram-token').value = '';
      showNotification('Настройки Telegram сохранены', 'success');
      await loadTelegramInfo();
    } else {
      showNotification('Ошибка: ' + res.error, 'error');
    }
  });

  // Настройки: очистить Telegram
  el('btn-clear-telegram')?.addEventListener('click', async () => {
    const res = await api.putConfig({ telegramBotToken: '', telegramChats: [] });
    if (res.ok) {
      if (el('setting-telegram-token')) el('setting-telegram-token').value = '';
      showNotification('Настройки Telegram очищены', 'info');
      await loadTelegramInfo();
    } else {
      showNotification('Ошибка: ' + res.error, 'error');
    }
  });
}

// ─── Уведомления ─────────────────────────────────────────────────────────────

function showNotification(text, type = 'info') {
  const container = el('notifications');
  if (!container) return;
  const n = document.createElement('div');
  n.className = `notification notification--${type}`;
  n.textContent = text;
  container.appendChild(n);
  requestAnimationFrame(() => n.classList.add('notification--visible'));
  setTimeout(() => {
    n.classList.remove('notification--visible');
    setTimeout(() => n.remove(), 300);
  }, 4000);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Старт ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
