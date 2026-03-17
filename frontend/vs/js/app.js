/**
 * app.js — точка входа, координирует все модули
 */

import * as api from './api.js';
import * as auth from './auth.js';
import * as tableModule from './table.js';
import {
  calcStats, renderStats, renderExecutorTable, renderHourlyChart, renderHourlyByEmployee,
  renderHourlyByEmployeeFromSummary,
  getHourlyByEmployeeGroupedByCompany, getHourlyByEmployeeGroupedByCompanyFromSummary, buildHourlyTableHtmlForCompany, buildHourlyTableHtmlFullList, buildWeightByZoneTableHtml,
  getCompanySummaryTableData, renderCompanySummaryTable,
  buildStorageRowForCols,
  calcIdlesByEmployee,
  calcIdleTotalsByEmployee,
  buildIdleRowsFromMap,
  buildIdleTableHtml,
  computeWorkedMinutesInShift,
  getElapsedShiftMinutes,
  getShiftBoundaryMs,
  ZONES,
} from './stats.js';
import {
  initMonitor, updateMonitorEmpl, updateExecutorIdCacheFromItems, loadRollcall, getRollcallCount,
  startMonitorRefresh, refreshMonitor, renderMonitor,
  openRollcallModal, closeRollcallModal, saveRollcall, setTodayExecutorNames,
} from './monitor.js';
import { el, flattenItem, parseEmplCsv, formatDateTime, shiftLabel, normalizeFio as normFio, hasMatchInEmplKeys, getCompanyByFio, formatMinutesToHours } from './utils.js';
import { initConsolidation, loadComplaints } from './consolidation.js';
import { initAnalysis } from './analysis.js';

// ─── Состояние ───────────────────────────────────────────────────────────────

/** Выбранная дата (YYYY-MM-DD); по умолчанию сегодня */
let selectedDate = new Date().toISOString().slice(0, 10);
/** День (9–21) или Ночь (21–09) — фильтр отображаемых операций */
let shiftFilter = 'day';
let allItems = [];
/** Сводка за дату/смену (цифры без полного списка). Отдаётся быстро. */
let dateSummary = null;
/** Полные данные загружены для текущей даты/смены (вкладка Данные). */
let dataTabFullyLoaded = false;
let emplMap = new Map();
let emplCompanies = [];
let filterCompany = '__all__';
/** Режим таблицы сотрудников: 'hourly' | 'zones' */
let heTableMode = 'sz';
/** Уникальные продукты без веса (КДК) для экспорта */
let missingWeightNames = [];
let latestMissingWeightItems = [];
let latestWithWeightKeys = [];
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
  loadIdleSettings();
  initAnalysis();

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

// Сохранение/восстановление настроек простоя в localStorage
function saveIdleSettings() {
  try {
    const threshold = Math.max(0, parseInt(el('idle-threshold-minutes')?.value, 10) || 0);
    const allowed = Math.max(0, parseInt(el('allowed-idle-minutes')?.value, 10) || 0);
    localStorage.setItem('vs_idle_threshold_minutes', String(threshold));
    localStorage.setItem('vs_allowed_idle_minutes', String(allowed));
  } catch (e) { /* ignore */ }
}

function loadIdleSettings() {
  try {
    const t = parseInt(localStorage.getItem('vs_idle_threshold_minutes') || '', 10);
    const a = parseInt(localStorage.getItem('vs_allowed_idle_minutes') || '', 10);
    if (!Number.isNaN(t)) {
      const elT = el('idle-threshold-minutes'); if (elT) elT.value = String(Math.max(0, t));
    }
    if (!Number.isNaN(a)) {
      const elA = el('allowed-idle-minutes'); if (elA) elA.value = String(Math.max(0, a));
    }
    updateIdlesLabel();
  } catch (e) { /* ignore */ }
}

function updateIdlesLabel() {
  try {
    const thresholdMinutes = Math.max(0, parseInt(el('idle-threshold-minutes')?.value, 10) || 0);
    const btn = el('btn-he-mode-idles');
    if (btn) btn.textContent = `Простои >${thresholdMinutes} мин`;
  } catch (e) { /* ignore */ }
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
  // Быстрая загрузка сводки (цифры). Полный список — по кнопке «Загрузить данные» во вкладке Данные.
  loadDateSummary(selectedDate);
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
      fromInp.value = 21;
      toInp.value = 9;
    }
  }
}

/** Определяет смену по времени операции: день 9:00–20:59, ночь 21:00–08:59 (21–09) */
function getItemShift(iso) {
  if (!iso) return 'day';
  const h = new Date(iso).getHours();
  return (h >= 9 && h < 21) ? 'day' : 'night';
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
  const nextDate = new Date(dateStr + 'T12:00:00Z');
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const nextDateStr = nextDate.toISOString().slice(0, 10);

  for (const item of allItems) {
    const ts = item.completedAt;
    if (!ts) continue;
    const d = new Date(ts);
    const itemDateStr = d.toISOString().slice(0, 10);
    const h = d.getHours();

    if (shift === 'day') {
      if (itemDateStr === dateStr && h >= 9 && h < 21) covered.add(h);
    } else {
      // Ночь для даты D = 21:00 D – 09:00 (D+1): часы 21,22,23 по D и 0..8 по D+1
      if (itemDateStr === dateStr && h >= 21) covered.add(h);
      else if (itemDateStr === nextDateStr && h < 9) covered.add(h);
    }
  }
  return covered;
}

/** Возвращает время последней операции (completedAt) в allItems для указанной даты и часа в рамках смены, или null. */
function getLastCompletedAtForHour(dateStr, hour, shift) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const nextDate = new Date(dateStr + 'T12:00:00Z');
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const nextDateStr = nextDate.toISOString().slice(0, 10);
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
      // Ночь для даты D: часы 21,22,23 по D и 0..8 по D+1
      match = (itemDateStr === dateStr && h >= 21 && h === hour) || (itemDateStr === nextDateStr && h < 9 && h === hour);
    }
    if (match) {
      const t = d.getTime();
      if (maxTs === null || t > maxTs) maxTs = t;
    }
  }
  return maxTs;
}

/** Быстрая загрузка только сводки (цифры). Не грузит полный список операций. Хранение — из операций PIECE_SELECTION_PICKING и из сохранённых данных (вес/задачи по picking-selection API при «Обновить данные»). */
async function loadDateSummary(dateStr) {
  if (!dateStr) return;
  setLoading(true);
  try {
    const idleThresholdMinutes = Math.max(0, parseInt(el('idle-threshold-minutes')?.value, 10) || 0);
    const opts = { shift: shiftFilter, idleThresholdMinutes };
    const res = await api.getDateSummary(dateStr, opts);
    dateSummary = res;
    allItems = [];
    dataTabFullyLoaded = false;
    setTodayExecutorNames((res.executors || []).map(e => e.name).filter(Boolean));
    syncDatePickers();
    renderAll();
  } catch (err) {
    showNotification('Ошибка загрузки сводки: ' + err.message, 'error');
    dateSummary = null;
  } finally {
    setLoading(false);
  }
}

/** Полная загрузка операций (для вкладки Данные). Хранение — из операций PIECE_SELECTION_PICKING; вес в хранении (колонка Тх) — из сохранённых данных после «Обновить данные». */
async function loadDateData(dateStr) {
  if (!dateStr) return;
  setLoading(true);
  try {
    const opts = { shift: shiftFilter };
    const res = await api.getDateItems(dateStr, opts);
    const raw = res.items || [];
    allItems = raw.map(i => (i.executor !== undefined && i.completedAt !== undefined ? i : flattenItem(i)));
    updateExecutorIdCacheFromItems(allItems);
    dateSummary = null;
    setTodayExecutorNames([]);
    dataTabFullyLoaded = true;
    syncDatePickers();
    renderAll();
  } catch (err) {
    showNotification('Ошибка загрузки данных: ' + err.message, 'error');
  } finally {
    setLoading(false);
  }
}

/** Обновить данные на экране: если выбрана сегодняшняя дата — подтянуть сводку с сервера. */
async function refreshCurrentShift() {
  if (selectedDate === getTodayStr()) await loadDateSummary(selectedDate);
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

/** Краткая дата для подписи: 12.03.26 */
function shortDateLabel(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd || '—';
  const [y, m, d] = ymd.split('-');
  return `${d}.${m}.${y.slice(-2)}`;
}

/** Диапазон для операций по смене (логистические сутки). День 12.03 = 11.03 21:00–12.03 20:59; ночь 12.03 = 12.03 21:00–13.03 20:59. */
function getDateRangeForShift(dateStr, shift) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { dateFrom: null, dateTo: null };
  const prev = new Date(dateStr + 'T12:00:00Z');
  prev.setUTCDate(prev.getUTCDate() - 1);
  const prevStr = prev.toISOString().slice(0, 10);
  const next = new Date(dateStr + 'T12:00:00Z');
  next.setUTCDate(next.getUTCDate() + 1);
  const nextStr = next.toISOString().slice(0, 10);
  if (shift === 'day') {
    return { dateFrom: `${prevStr}T21:00:00.000Z`, dateTo: `${dateStr}T20:59:59.999Z` };
  }
  return { dateFrom: `${dateStr}T21:00:00.000Z`, dateTo: `${nextStr}T20:59:59.999Z` };
}

/** Подпись для карточки «Дата»: день — одна дата; ночь — диапазон выбранная дата > следующий день */
function dateCardLabel() {
  if (!selectedDate) return '—';
  if (shiftFilter === 'day') {
    return `${dateLabel(selectedDate)} · День 9–21`;
  }
  const next = new Date(selectedDate + 'T12:00:00Z');
  next.setUTCDate(next.getUTCDate() + 1);
  const nextStr = next.toISOString().slice(0, 10);
  return `Ночь ${shortDateLabel(selectedDate)} > ${shortDateLabel(nextStr)}`;
}

function setMissingWeightNames(list) {
  missingWeightNames = Array.isArray(list) ? list : [];
  const btn = el('btn-export-missing-weight');
  if (btn) btn.disabled = missingWeightNames.length === 0;
}

function renderAll() {
  // сбрасываем/обновляем список неучтённых продуктов
  setMissingWeightNames([]);
  if (allItems.length > 0) {
    const itemsByShift = getItemsByShift();
    const tableItems = filterItemsByCompany(itemsByShift);
    const stats = calcStats(itemsByShift, emplMap, filterCompany);
    setMissingWeightNames(stats.missingWeightNames);
    latestMissingWeightItems = stats.missingWeightItems || [];
    latestWithWeightKeys = stats.withWeightKeys || [];
    (stats.hourly || []).forEach(h => {
      h.ops = (h.storageOps || 0) + (h.kdkOps || 0);
    });
    renderStats(stats, dateCardLabel());
    renderExecutorTable(stats.executors);
    const summaryData = getCompanySummaryTableData(itemsByShift, shiftFilter, emplMap, selectedDate);
    renderCompanySummaryTable(summaryData.rows, summaryData.hoursDisplay, el('company-summary-show-hours')?.checked !== false);
    renderHourlyChart(stats.hourly, shiftFilter);
    const showIdles = heTableMode === 'idles';
    const thresholdMinutes = Math.max(0, parseInt(el('idle-threshold-minutes')?.value, 10) || 15);
    const allowedIdleMinutes = Math.max(0, parseInt(el('allowed-idle-minutes')?.value, 10) || 0);
    const thresholdMs = thresholdMinutes * 60 * 1000;
    // Всегда считаем простои — нужны для колонки «В работе»
    const isToday = selectedDate === getTodayStr();
    const { startMs: shiftStartMs, endMs: shiftEndMs } = getShiftBoundaryMs(selectedDate, shiftFilter, isToday);
    const idlesByEmployee = calcIdleTotalsByEmployee(tableItems, thresholdMs, shiftFilter, shiftStartMs, shiftEndMs);
    const elapsedShiftMin = isToday ? getElapsedShiftMinutes(shiftFilter) : 12 * 60;
    let totalIdleMinutes = 0;
    let totalWorkedMinutes = 0;
    for (const v of Object.values(idlesByEmployee)) {
      const t = (v && typeof v === 'object') ? (Number(v.totalMinutes) || 0) : 0;
      totalIdleMinutes += t;
      totalWorkedMinutes += computeWorkedMinutesInShift(t, allowedIdleMinutes, elapsedShiftMin);
    }
    const idleEl = el('stat-idle-total'); if (idleEl) idleEl.textContent = formatMinutesToHours(totalIdleMinutes);
    const workedEl = el('stat-worked-total'); if (workedEl) workedEl.textContent = formatMinutesToHours(totalWorkedMinutes);
    renderHourlyByEmployee(tableItems, shiftFilter, emplMap, showIdles, idlesByEmployee, allowedIdleMinutes, heTableMode, elapsedShiftMin, thresholdMinutes);
    tableModule.setTableData(tableItems, emplMap);
    return;
  }
  if (dateSummary) {
    setMissingWeightNames(dateSummary.missingWeightNames);
    if (Array.isArray(dateSummary.missingWeightItems) && dateSummary.missingWeightItems.length) {
      latestMissingWeightItems = dateSummary.missingWeightItems;
      latestWithWeightKeys = [];
    } else if (Array.isArray(dateSummary.missingWeightNames) && dateSummary.missingWeightNames.length) {
      latestMissingWeightItems = dateSummary.missingWeightNames.map(n => ({ name: String(n), article: '' }));
      latestWithWeightKeys = [];
    }
    const getCompanyForName = (name) => (emplMap && name ? (getCompanyByFio(emplMap, normFio(name)) || '—') : '—');
    const matchNameToFilter = (name) => {
      if (!filterCompany || filterCompany === '__all__') return true;
      if (filterCompany === '__none__') return !hasMatchInEmplKeys(normFio(name), emplMap);
      return getCompanyForName(name) === filterCompany;
    };

    // Фильтруем summary-данные по компании, чтобы чипы работали даже без полной загрузки allItems
    const executorsWithCompanyAll = (dateSummary.executors || []).map(e => ({
      ...e,
      company: getCompanyForName(e.name),
    }));
    const executorsWithCompany = executorsWithCompanyAll.filter(e => matchNameToFilter(e.name));

    const hourlyByEmployeeHours = dateSummary.hourlyByEmployee?.hours || [];
    const hourlyByEmployeeRowsAll = (dateSummary.hourlyByEmployee?.rows || []).map(r => ({
      ...r,
      company: r.company || getCompanyForName(r.name),
    }));
    const hourlyByEmployeeRows = hourlyByEmployeeRowsAll.filter(r => matchNameToFilter(r.name));

    // Карточки и топ сотрудников: считаем отфильтрованные суммы
    const totalOpsFiltered = executorsWithCompany.reduce((s, e) => s + (e.ops || 0), 0);
    const totalQtyFiltered = executorsWithCompany.reduce((s, e) => s + (e.qty || 0), 0);

    // График по часам: если есть hourlyByEmployee — соберём ops/чел по часам из него (иначе оставим общий hourly)
    let hourlyForChart = dateSummary.hourly || [];
    if (dateSummary.hourlyByEmployee && filterCompany && filterCompany !== '__all__') {
      const sumByHour = new Map(); // dataHour -> { ops, employeesSet }
      for (const r of hourlyByEmployeeRows) {
        const byHour = r.byHour || {};
        for (const [colStr, vRaw] of Object.entries(byHour)) {
          const col = Number(colStr);
          if (!Number.isFinite(col)) continue;
          const v = Number(vRaw) || 0;
          const dataHour = shiftFilter === 'day' ? (col - 1) : ((col - 1 + 24) % 24);
          if (!sumByHour.has(dataHour)) sumByHour.set(dataHour, { ops: 0, employees: new Set() });
          const cell = sumByHour.get(dataHour);
          cell.ops += v;
          if (v > 0) cell.employees.add(r.name);
        }
      }
      hourlyForChart = [...sumByHour.entries()].map(([hour, cell]) => ({
        hour,
        ops: cell.ops,
        employees: cell.employees.size,
        storageOps: 0,
        kdkOps: 0,
      }));
    }

    const csRowsAll = dateSummary.companySummary?.rows || [];
    const csRowsFiltered = (filterCompany && filterCompany !== '__all__' && filterCompany !== '__none__')
      ? csRowsAll.filter(r => r.companyName === filterCompany)
      : (filterCompany === '__none__' ? [] : csRowsAll);
    const isFiltered = filterCompany && filterCompany !== '__all__';
    const weightStorageGrams = isFiltered
      ? csRowsFiltered.reduce((s, r) => s + (r.weightStorageGrams || 0), 0)
      : (dateSummary.totalWeightStorageGrams || 0);
    const weightKdkGrams = isFiltered
      ? csRowsFiltered.reduce((s, r) => s + (r.weightKdkGrams || 0), 0)
      : (dateSummary.totalWeightKdkGrams || 0);
    const storageOpsFiltered = isFiltered
      ? csRowsFiltered.reduce((s, r) => s + (r.szStorage || 0), 0)
      : null; // null = use hourly
    renderStats(
      { totalOps: isFiltered ? totalOpsFiltered : (dateSummary.totalOps || 0),
        totalQty: isFiltered ? totalQtyFiltered : (dateSummary.totalQty || 0),
        executors: executorsWithCompany,
        hourly: hourlyForChart,
        totalWeightStorageGrams: weightStorageGrams,
        totalWeightKdkGrams: weightKdkGrams,
        totalWeightGrams: weightStorageGrams + weightKdkGrams,
        storageOpsOverride: storageOpsFiltered,
        missingWeightNames: Array.isArray(dateSummary.missingWeightNames) ? dateSummary.missingWeightNames : [],
      },
      dateCardLabel()
    );
    renderExecutorTable(executorsWithCompany);
    renderHourlyChart(hourlyForChart, shiftFilter);

    if (dateSummary.companySummary) {
      renderCompanySummaryTable(csRowsFiltered, dateSummary.companySummary.hoursDisplay || [], el('company-summary-show-hours')?.checked !== false);
    } else {
      renderCompanySummaryPlaceholder();
    }

    if (dateSummary.hourlyByEmployee) {
      const showIdlesHourly = heTableMode === 'idles';
      const thresholdMinutes = Math.max(0, parseInt(el('idle-threshold-minutes')?.value, 10) || 15);
      const allowedIdleMinutes = Math.max(0, parseInt(el('allowed-idle-minutes')?.value, 10) || 0);
      // Если полные данные не загружены — предупреждение о точности
      const noteEl = el('hourly-idles-note');
      if (!allItems.length && showIdlesHourly && noteEl) {
        noteEl.textContent = 'Порог применён к сводке. Для максимальной точности загрузите полный список операций.';
      } else if (noteEl) noteEl.textContent = '';
      const summaryShiftMin = selectedDate === getTodayStr() ? getElapsedShiftMinutes(shiftFilter) : 12 * 60;
      renderHourlyByEmployeeFromSummary(
        hourlyByEmployeeHours,
        hourlyByEmployeeRows,
        dateSummary.weightByEmployee || dateSummary.storageWeightByEmployee || {},
        dateSummary.totalWeightStorageGrams || dateSummary.storageTotalWeightGrams || 0,
        showIdlesHourly,
        dateSummary.idlesByEmployee && typeof dateSummary.idlesByEmployee === 'object' ? dateSummary.idlesByEmployee : {},
        allowedIdleMinutes,
        shiftFilter,
        heTableMode,
        summaryShiftMin,
        thresholdMinutes
      );
    } else {
      renderHourlyByEmployeePlaceholder();
    }
    renderTableLoadDataPlaceholder();
    return;
  }
  renderStats({ totalOps: 0, totalQty: 0, executors: [], hourly: [] }, dateCardLabel());
  renderExecutorTable([]);
  renderCompanySummaryPlaceholder();
  renderHourlyChart([], shiftFilter);
  renderHourlyByEmployeePlaceholder();
  renderTableLoadDataPlaceholder();
}

function renderCompanySummaryPlaceholder() {
  const container = el('company-summary-table-wrap');
  if (!container) return;
  container.innerHTML = '<div class="empty-row" style="padding:16px;text-align:center;color:var(--text-muted)">Загрузите полные данные во вкладке «Данные» (кнопка «Загрузить данные») для таблицы по компаниям.</div>';
}

function renderHourlyByEmployeePlaceholder() {
  const container = el('hourly-employee-table-wrap');
  if (!container) return;
  container.innerHTML = '<div class="empty-row" style="padding:20px;text-align:center;color:var(--text-muted)">Загрузите полные данные во вкладке «Данные» для таблицы по сотрудникам и часам.</div>';
}

function renderTableLoadDataPlaceholder() {
  const counterEl = el('table-counter');
  if (counterEl) counterEl.textContent = '—';
  const tbody = el('ops-tbody');
  if (!tbody) return;
  tbody.innerHTML = `
    <tr>
      <td colspan="7" class="empty-row" style="padding:32px;text-align:center;vertical-align:middle;">
        <p style="margin:0 0 12px;color:var(--text-muted)">Полный список операций не загружен.</p>
        <p style="margin:0 0 16px;font-size:0.9em;color:var(--text-muted)">Загрузка может занять 1–2 минуты.</p>
        <button type="button" class="btn btn-primary" id="btn-load-full-data">Загрузить данные</button>
      </td>
    </tr>`;
  el('btn-load-full-data')?.addEventListener('click', async () => {
    const btn = el('btn-load-full-data');
    if (btn) { btn.disabled = true; btn.textContent = 'Загрузка…'; }
    showNotification('Загрузка полного списка операций (1–2 мин)…', 'info');
    try {
      await loadDateData(selectedDate);
      showNotification('Данные загружены', 'success');
    } catch (e) {
      showNotification('Ошибка: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Загрузить данные'; }
    }
  });
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
      threadIdIdles: String(c.threadIdIdles ?? c.threadIdStats ?? c.threadId ?? '').trim(),
      label: String(c.label != null ? c.label : '').trim(),
      enabled: c.enabled !== false,
      companiesFilter: Array.isArray(c.companiesFilter) ? c.companiesFilter : (c.companiesFilter ? String(c.companiesFilter).split(',').map(s => s.trim()).filter(Boolean) : []),
    }));
  }
  if (config.telegramChatId && String(config.telegramChatId).trim()) {
    return [{
      chatId: String(config.telegramChatId).trim(),
      threadIdConsolidation: String(config.telegramThreadId || '').trim(),
      threadIdStats: String(config.telegramThreadId || '').trim(),
      threadIdIdles: String(config.telegramThreadIdIdles || config.telegramThreadId || '').trim(),
      label: '',
      enabled: true,
      companiesFilter: [],
    }];
  }
  return [];
}

function renderTelegramChatsList(container, chats) {
  if (!container) return;
  const companyOptions = (selectedList) => {
    const set = new Set(Array.isArray(selectedList) ? selectedList : []);
    return emplCompanies.length
      ? emplCompanies.map(co => `<option value="${escAttr(co)}" ${set.has(co) ? 'selected' : ''}>${escAttr(co)}</option>`).join('')
      : '<option value="" disabled>Загрузите сотрудников — появятся компании</option>';
  };
  container.innerHTML = chats.map((c, i) => `
    <div class="telegram-chat-row" data-index="${i}">
      <label class="tg-enabled-wrap" title="Отключает уведомления в этот чат">
        <input type="checkbox" class="tg-enabled" ${c.enabled !== false ? 'checked' : ''}> Вкл
      </label>
      <input type="text" class="form-control tg-chat-id" placeholder="Chat ID" value="${escAttr(c.chatId)}" title="Chat ID">
      <input type="text" class="form-control tg-thread-cons" placeholder="Thread консолидации" value="${escAttr(c.threadIdConsolidation)}">
      <input type="text" class="form-control tg-thread-stats" placeholder="Thread статистики" value="${escAttr(c.threadIdStats)}">
      <input type="text" class="form-control tg-thread-idles" placeholder="Thread простоев" value="${escAttr(c.threadIdIdles || '')}">
      <select multiple class="form-control tg-companies" title="Пусто = все компании; выберите нужные для этого чата">
        ${companyOptions(c.companiesFilter)}
      </select>
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

    renderTelegramChatsList(listEl, chats.length ? chats : [{ chatId: '', threadIdConsolidation: '', threadIdStats: '', threadIdIdles: '', label: '', enabled: true, companiesFilter: [] }]);

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

const VS_MODULE_LABELS = { stats: 'Статистика', data: 'Данные', monitor: 'Мониторинг', analysis: 'Анализ', consolidation: 'Консолидация', docs: 'Документы', settings: 'Настройки' };
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
  const modules = ['stats', 'data', 'monitor', 'analysis', 'consolidation', 'docs', 'settings'];
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
    renderEmplEditor(parsed.map, companies, res.employees || []);
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

function titleCaseFio(s) {
  return (s || '').replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function renderEmplEditor(emplMapArg, companiesArg, employees = []) {
  const tbody = el('empl-editor-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const source = employees.length ? employees : [...emplMapArg].map(([fio, company]) => ({ fio, company }));
  for (const { fio, company } of source) {
    tbody.appendChild(makeEmplRow(titleCaseFio(fio), company, companiesArg));
  }
  if (!source.length) {
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
  if (heTableMode === 'zones') {
    showNotification('Переключитесь в режим «По СЗ» или «По часам» для экспорта', 'info');
    return;
  }
  const wrap = el('hourly-employee-table-wrap');
  const table = wrap?.querySelector('.he-table');
  if (!table) { showNotification('Таблица не найдена', 'error'); return; }
  const thead = table.querySelector('thead tr');
  const tbody = table.querySelector('tbody');
  const bodyRows = tbody ? [...tbody.querySelectorAll('tr')] : [];
  if (!thead || !bodyRows.length) { showNotification('Нет данных для экспорта', 'error'); return; }
  const ExcelJS = window.ExcelJS || globalThis.ExcelJS;
  if (!ExcelJS) { showNotification('Библиотека ExcelJS не загружена', 'error'); return; }

  const hexToArgb = (hex) => {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0');
    return 'FF' + full.toUpperCase();
  };
  const fillFromStyle = (td) => {
    const m = (td.getAttribute('style') || '').match(/background:\s*(#[0-9a-fA-F]{3,8})/);
    if (!m) return null;
    return { type: 'pattern', pattern: 'solid', fgColor: { argb: hexToArgb(m[1]) } };
  };

  const TOTAL_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  const SUBHDR_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1D5DB' } };

  const modeLabel     = heTableMode === 'sz' ? 'По СЗ' : 'По часам';
  const shiftLabelTxt = shiftFilter === 'night' ? 'Ночная смена' : 'Дневная смена';
  const dateLabel2    = selectedDate ? selectedDate.split('-').reverse().join('.') : '';

  // ── Определяем тип каждой колонки по заголовку ───────────────────────────
  const thEls = [...thead.querySelectorAll('th')];
  const colDefs = thEls.map((th) => {
    const cls   = th.className || '';
    const txt   = th.textContent?.trim() || '';
    const title = th.getAttribute('title') || '';
    if (cls.includes('he-th-company') || txt === 'Компания')                           return { type: 'company',    label: 'Компания' };
    if (cls.includes('he-th-name') || txt === 'Исполнитель' || txt === 'Сотрудник')    return { type: 'name',       label: txt };
    if (cls.includes('he-th-idles') || txt.startsWith('Простои'))                      return { type: 'idles',      label: '' };
    if (title.includes('Первая') || txt.startsWith('Старт'))                           return { type: 'startpeak',  label: 'Старт / Пик' };
    if (title.includes('Вес в хранении') || txt === 'Вес ХР')                          return { type: 'wt_storage', label: 'Вес ХР' };
    if (title.includes('Вес в КДК')      || txt === 'Вес КДК')                         return { type: 'wt_kdk',     label: 'Вес КДК' };
    if (title.includes('Вес итог')        || txt === 'Вес итог')                       return { type: 'wt_total',   label: 'Вес итог' };
    if (title.includes('Время в работе') || txt === 'В работе')                        return { type: 'worked',     label: 'В работе' };
    if (cls.includes('he-th-total') && txt === 'Итого')                                return { type: 'total',      label: 'Итого' };
    if (cls.includes('he-th-hour') || /^\d{2}$/.test(txt) || /^\d{2}:\d{2}/.test(txt)) return { type: 'hour',      label: txt };
    return { type: 'other', label: txt };
  });

  // Исключаем таймлайн простоев (визуальный, не нужен в XLSX)
  const exportCols    = colDefs.map((def, i) => ({ ...def, srcIdx: i })).filter(d => d.type !== 'idles');
  const hourCols      = exportCols.filter(c => c.type === 'hour');
  const weightCols    = exportCols.filter(c => c.type === 'wt_storage' || c.type === 'wt_kdk' || c.type === 'wt_total');
  const numExportCols = exportCols.length;

  // Ширина каждой экспортируемой колонки
  const colWidth = (type) => {
    switch (type) {
      case 'company':    return 18;
      case 'name':       return 30;
      case 'hour':       return 8;
      case 'total':      return 8;
      case 'worked':     return 10;
      case 'startpeak':  return 12;
      case 'wt_storage': return 11;
      case 'wt_kdk':     return 11;
      case 'wt_total':   return 11;
      default:           return 10;
    }
  };

  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ВС';
    wb.created = new Date();
    const ws = wb.addWorksheet('Сотрудники по часам');

    // Утилиты для добавления строк ──────────────────────────────────────────
    const mergeWide = (rn) => { if (numExportCols > 1) ws.mergeCells(rn, 1, rn, numExportCols); };

    // ── Строка 1: заголовок отчёта ────────────────────────────────────────
    ws.addRow([`Сотрудники по часам • ${modeLabel} • ${dateLabel2} • ${shiftLabelTxt}`]);
    mergeWide(1);
    ws.getRow(1).getCell(1).style = {
      font: { bold: true, size: 13, color: { argb: 'FFFFFFFF' } },
      fill: HEADER_FILL,
      alignment: { horizontal: 'left', vertical: 'middle' },
    };
    ws.getRow(1).height = 26;

    // ── Раздел легенды (строки 2..) — над данными ────────────────────────
    const LEG_OUTLINE = 1; // уровень группировки (для возможности свернуть вручную)
    const LEG_LABEL_COL = 1; // цвет-свотч
    const LEG_NAME_COL  = 2; // название
    const LEG_DESC_FROM = 3; // начало описания (до numExportCols)

    const addLegTitle = (text) => {
      ws.addRow(new Array(numExportCols).fill(null));
      const rn = ws.lastRow.number;
      mergeWide(rn);
      const cell = ws.getRow(rn).getCell(1);
      cell.value = text;
      cell.style = {
        font: { bold: true, size: 11, color: { argb: 'FFFFFFFF' } },
        fill: HEADER_FILL,
        alignment: { horizontal: 'left', vertical: 'middle' },
      };
      ws.getRow(rn).height = 18;
      ws.getRow(rn).outlineLevel = LEG_OUTLINE;
    };

    // desc помещается в объединённую ячейку col3..numExportCols с wrapText
    const addLegRow = (swatchArgb, name, desc) => {
      ws.addRow(new Array(numExportCols).fill(null));
      const rn = ws.lastRow.number;
      if (numExportCols > LEG_DESC_FROM) ws.mergeCells(rn, LEG_DESC_FROM, rn, numExportCols);
      const r = ws.getRow(rn);
      const c1 = r.getCell(LEG_LABEL_COL);
      const c2 = r.getCell(LEG_NAME_COL);
      const c3 = r.getCell(LEG_DESC_FROM);
      if (swatchArgb) {
        c1.style = {
          fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: swatchArgb } },
          border: XLSX_BORDER,
          alignment: { vertical: 'middle', horizontal: 'center' },
        };
      }
      c2.value = name;
      c2.style = { font: { bold: true }, alignment: { vertical: 'middle', wrapText: false } };
      c3.value = desc;
      c3.style = { alignment: { vertical: 'middle', wrapText: true } };
      // Авторасчёт высоты строки по длине текста (≈75 символов на строку при ширине оставшихся колонок)
      const descLines = Math.max(1, Math.ceil((desc || '').length / 70));
      r.height = Math.max(18, descLines * 16);
      r.outlineLevel = LEG_OUTLINE;
    };

    const addLegSep = () => {
      ws.addRow(new Array(numExportCols).fill(null));
      const rn = ws.lastRow.number;
      ws.getRow(rn).height = 6;
      ws.getRow(rn).outlineLevel = LEG_OUTLINE;
    };

    // Цвета ячеек
    if (heTableMode === 'sz') {
      addLegTitle('Легенда — цвета ячеек (режим «По СЗ»)');
      addLegRow('FFFECACA', '< 50 задач/час',  'Низкая производительность');
      addLegRow('FFFEF08A', '50–75 задач/час', 'Средняя производительность');
      addLegRow('FFFFFFFF', '> 75 задач/час',  'Высокая производительность');
    } else {
      addLegTitle('Легенда — цвета ячеек (режим «По часам», доминирующая зона)');
      for (const z of ZONES) {
        addLegRow(hexToArgb(z.bg), z.label, '');
      }
    }

    addLegSep();
    addLegTitle('Описание колонок');
    addLegRow(null, 'Компания',          'Название компании-подрядчика сотрудника');
    addLegRow(null, 'Сотрудник',         'ФИО исполнителя');
    addLegRow(null, 'ЧЧ (часовые кол)', 'Кол-во задач за данный час смены; под числом — вес (кг)');
    addLegRow(null, 'Итого',             'Суммарное кол-во задач за смену');
    addLegRow(null, 'В работе',          'Время в работе: длительность смены − суммарные простои (ЧЧ:ММ)');
    addLegRow(null, 'Старт / Пик',       'Верхняя строка — первая операция смены; нижняя — последняя');
    addLegRow(null, 'Вес ХР',            'Суммарный вес отобранных товаров в зоне хранения (кг)');
    addLegRow(null, 'Вес КДК',           'Суммарный вес отобранных товаров в зоне КДК (кг)');
    addLegRow(null, 'Вес итог',          'Общий суммарный вес (хранение + КДК, кг)');
    addLegSep();
    addLegTitle('Методология расчётов');
    addLegRow(null, 'Простои',  'Паузы между операциями длиннее порога (по умолч. 15 мин). Учитывается время от старта смены до первой операции и от последней операции до конца смены');
    addLegRow(null, 'В работе', 'Длительность смены − суммарные простои + допустимые простои (настраиваемый порог)');


    // ── Пустой разделитель ────────────────────────────────────────────────
    ws.addRow(new Array(numExportCols).fill(null));
    ws.getRow(ws.lastRow.number).height = 4;

    // ── Двухуровневый заголовок (строки grpRowNum, subRowNum) ─────────────
    const grpRowNum = ws.lastRow.number + 1;
    const grpRow = ws.addRow(new Array(numExportCols).fill(''));
    const subRowNum = ws.lastRow.number + 1;
    const subRow = ws.addRow(new Array(numExportCols).fill(''));

    const grpHdrStyle = (argb) => ({
      font: { bold: true, color: { argb: 'FFFFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb } },
      border: XLSX_BORDER,
      alignment: XLSX_ALIGN,
    });
    const subHdrStyle = {
      font: { bold: true },
      fill: SUBHDR_FILL,
      border: XLSX_BORDER,
      alignment: XLSX_ALIGN,
    };

    const setGrp = (colNum, val, argb = 'FF374151') => {
      grpRow.getCell(colNum).value = val;
      grpRow.getCell(colNum).style = grpHdrStyle(argb);
    };
    const setSub = (colNum, val) => {
      subRow.getCell(colNum).value = val;
      subRow.getCell(colNum).style = subHdrStyle;
    };

    exportCols.forEach((def, ci) => {
      const colNum = ci + 1;
      const type = def.type;
      if (type === 'hour') {
        setSub(colNum, def.label);
      } else if (type === 'wt_storage' || type === 'wt_kdk' || type === 'wt_total') {
        setSub(colNum, def.label);
      } else {
        // Одиночные колонки: объединяем строки grpRowNum–subRowNum
        ws.mergeCells(grpRowNum, colNum, subRowNum, colNum);
        setGrp(colNum, def.label);
      }
    });

    // Группа «Задачи по часам»
    if (hourCols.length > 0) {
      const firstHour = exportCols.findIndex(c => c.type === 'hour') + 1;
      const lastHour  = firstHour + hourCols.length - 1;
      if (lastHour > firstHour) ws.mergeCells(grpRowNum, firstHour, grpRowNum, lastHour);
      setGrp(firstHour, 'Задачи по часам', 'FF1E3A5F');
    }
    // Группа «Вес (кг)»
    if (weightCols.length > 0) {
      const firstWt = exportCols.findIndex(c => c.type === 'wt_storage' || c.type === 'wt_kdk' || c.type === 'wt_total') + 1;
      const lastWt  = firstWt + weightCols.length - 1;
      if (lastWt > firstWt) ws.mergeCells(grpRowNum, firstWt, grpRowNum, lastWt);
      setGrp(firstWt, 'Вес (кг)', 'FF1E3A5F');
    }

    grpRow.height = 20;
    subRow.height = 18;

    // Замораживаем строки 1 (заголовок) + легенда (скрыта) + разделитель + 2 заголовка
    ws.views = [{ state: 'frozen', ySplit: subRowNum }];

    // ── Данные ──────────────────────────────────────────────────────────────
    const parsed = [];
    for (const tr of bodyRows) {
      const tds = tr.querySelectorAll('td');
      const rowData = [], colMeta = [];
      let totalNum = 0, companyStr = '';
      exportCols.forEach((def) => {
        const td = tds[def.srcIdx];
        if (!td) { rowData.push(''); colMeta.push({ fill: null, colType: def.type }); return; }
        const cls = td.className || '';
        let fill = null;
        if (def.type === 'hour') {
          const szSpan = td.querySelector('.he-cell-sz');
          const wgSpan = td.querySelector('.he-cell-weight');
          const szVal  = szSpan ? szSpan.textContent.trim() : td.textContent.trim();
          const wgVal  = wgSpan ? wgSpan.textContent.trim() : '';
          const num    = szVal === '' ? 0 : (Number(szVal) || 0);
          rowData.push(num > 0 && wgVal ? `${szVal}\n${wgVal}` : (num > 0 ? num : ''));
          fill = fillFromStyle(td);
          if (!fill) {
            if (cls.includes('he-sz-red'))        fill = HOURLY_XLSX_FILL.red;
            else if (cls.includes('he-sz-mid'))   fill = HOURLY_XLSX_FILL.mid;
            else if (cls.includes('he-sz-white')) fill = HOURLY_XLSX_FILL.white;
          }
        } else if (def.type === 'startpeak') {
          const divEl   = td.querySelector('div');
          const peak    = divEl ? divEl.textContent.trim() : '';
          const tdClone = td.cloneNode(true);
          tdClone.querySelector('div')?.remove();
          const start = tdClone.textContent.trim();
          rowData.push(start && peak ? `${start}\n${peak}` : (start || peak || '—'));
        } else if (def.type === 'total') {
          const text = td.textContent?.trim() ?? '';
          const num  = Number(text);
          if (!Number.isNaN(num) && text !== '' && String(num) === text) {
            totalNum = num;
            rowData.push(num);
          } else {
            rowData.push(text || '');
          }
        } else {
          const text = td.textContent?.trim() ?? '';
          if (def.type === 'company') companyStr = text;
          rowData.push(text);
        }
        colMeta.push({ fill, colType: def.type });
      });
      parsed.push({ rowData, colMeta, total: totalNum, company: companyStr });
    }

    parsed.sort((a, b) => {
      const cmp = (a.company || '').localeCompare(b.company || '', 'ru');
      return cmp !== 0 ? cmp : b.total - a.total;
    });

    for (const { rowData, colMeta } of parsed) {
      const row = ws.addRow(rowData);
      // Единая высота для всех строк данных (хватает на 2 строки в ячейке)
      row.height = 30;
      row.eachCell((cell, colNumber) => {
        const { fill, colType } = colMeta[colNumber - 1] || {};
        const hasNewline = typeof cell.value === 'string' && cell.value.includes('\n');
        const isTotal    = colType === 'total' || colType === 'worked' ||
                           colType === 'wt_storage' || colType === 'wt_kdk' || colType === 'wt_total';
        const cellFill   = isTotal ? TOTAL_FILL : (fill || undefined);
        cell.style = {
          border: XLSX_BORDER,
          alignment: { ...XLSX_ALIGN, wrapText: hasNewline },
          ...(cellFill ? { fill: cellFill } : {}),
        };
      });
    }

    // ── Ширина колонок (устанавливается явно через getColumn, без forEach) ──
    exportCols.forEach((def, ci) => {
      ws.getColumn(ci + 1).width = colWidth(def.type);
    });

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

async function exportMissingWeightXlsx() {
  const ExcelJS = window.ExcelJS || globalThis.ExcelJS;
  if (!ExcelJS) {
    showNotification('Библиотека ExcelJS не загружена', 'error');
    return;
  }
  try {
    // Сначала синхронизируем текущие данные, потом скачиваем актуальный список
    if (latestMissingWeightItems.length || latestWithWeightKeys.length) {
      await api.syncMissingWeight(latestMissingWeightItems, latestWithWeightKeys);
    }
    const items = await api.getMissingWeight();
    if (!items.length) {
      showNotification('Список неучтённых товаров пуст', 'info');
      return;
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Неучтенный вес');
    ws.columns = [
      { header: 'Артикул', key: 'article', width: 20 },
      { header: 'Название товара', key: 'name', width: 70 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9ECEF' } };
    for (const item of items) {
      ws.addRow({ article: item.article || '', name: item.name || '' });
    }
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `неучтенный_вес.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showNotification(`Выгружено ${items.length} товаров`, 'success');
  } catch (err) {
    showNotification('Ошибка экспорта: ' + err.message, 'error');
  }
}

async function exportAnalysisToXlsx() {
  const ExcelJS = window.ExcelJS || globalThis.ExcelJS;
  if (!ExcelJS) {
    showNotification('Библиотека ExcelJS не загружена', 'error');
    return;
  }
  const dateStr = el('analysis-date')?.value || selectedDate || 'дата';
  const startTime = el('analysis-start-time')?.value || '';

  const rows = document.querySelectorAll('#analysis-rows tr');
  if (!rows.length) {
    showNotification('Нет данных для экспорта', 'error');
    return;
  }

  try {
    const wb = new ExcelJS.Workbook();
    const wsPlan = wb.addWorksheet('План', { views: [{ state: 'frozen', ySplit: 1 }] });

    const header = [
      'Операция', 'Объём, кг', 'Средний вес/час', 'Людей в работе', 'Старт', 'Цель',
      'Нужно кг/час', 'Нужно часов', 'Завершим к', 'Нужно людей к цели',
    ];
    wsPlan.addRow(header);
    wsPlan.getRow(1).eachCell(c => {
      c.style = {
        font: { bold: true },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } },
        border: XLSX_BORDER,
        alignment: XLSX_ALIGN,
      };
    });

    rows.forEach(tr => {
      const tds = tr.querySelectorAll('td');
      if (!tds.length) return;
      const op = tds[0]?.textContent?.trim() || '';
      const volume = tr.querySelector('.analysis-volume')?.value || '';
      const peak = tr.querySelector('.analysis-peak')?.value || '';
      const people = tr.querySelector('.analysis-people')?.value || '';
      const start = tr.querySelector('.analysis-start')?.value || '';
      const target = tr.querySelector('.analysis-target')?.value || '';
      const required = tr.querySelector('.analysis-required')?.textContent?.trim() || '';
      const duration = tr.querySelector('.analysis-duration')?.textContent?.trim() || '';
      const finish = tr.querySelector('.analysis-finish')?.textContent?.trim() || '';
      const needPeople = tr.querySelector('.analysis-need-people')?.textContent?.trim() || '';
      const row = wsPlan.addRow([op, volume, peak, people, start, target, required, duration, finish, needPeople]);
      row.eachCell(cell => {
        cell.style = { border: XLSX_BORDER, alignment: XLSX_ALIGN };
      });
    });

    const wsAssign = wb.addWorksheet('Подбор', { views: [{ state: 'frozen', ySplit: 1 }] });
    wsAssign.addRow(['Операция', 'Нужно людей', 'Сотрудник', 'Эффективность', 'Подобрано, чел', 'Статус']);
    wsAssign.getRow(1).eachCell(c => {
      c.style = {
        font: { bold: true },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } },
        border: XLSX_BORDER,
        alignment: XLSX_ALIGN,
      };
    });
    const assignRows = document.querySelectorAll('#analysis-assign-body tr');
    assignRows.forEach(tr => {
      const cells = tr.querySelectorAll('td');
      if (!cells.length) return;
      const op = cells[0]?.textContent?.trim() || '';
      const need = cells[1]?.textContent?.trim() || '';
      const sum = cells[3]?.textContent?.trim() || '';
      const status = cells[4]?.textContent?.trim() || '';
      const chips = cells[2]?.querySelectorAll('.analysis-chip') || [];
      if (!chips.length) {
        const row = wsAssign.addRow([op, need, cells[2]?.textContent?.trim() || '', '', sum, status]);
        row.eachCell(cell => { cell.style = { border: XLSX_BORDER, alignment: XLSX_ALIGN }; });
        return;
      }
      chips.forEach((chip, idx) => {
        const text = chip.textContent?.trim() || '';
        const parts = text.split('·').map(s => s.trim()).filter(Boolean);
        const name = parts[0] || text;
        const rate = parts[1] || '';
        const row = wsAssign.addRow([
          idx === 0 ? op : '',
          idx === 0 ? need : '',
          name,
          rate,
          idx === 0 ? sum : '',
          idx === 0 ? status : '',
        ]);
        row.eachCell(cell => { cell.style = { border: XLSX_BORDER, alignment: XLSX_ALIGN }; });
      });
    });

    wsPlan.columns.forEach(col => { col.width = Math.max(12, (col.header || '').length + 2); });
    wsAssign.columns.forEach(col => { col.width = Math.max(14, (col.header || '').length + 2); });

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `план_${dateStr}${startTime ? '_' + startTime.replace(':', '-') : ''}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    showNotification('Файл плана .xlsx загружен', 'success');
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

  // Выбор даты — оба календаря (статистика и данные). Загружаем только сводку.
  for (const id of ['date-picker-stats', 'date-picker-data']) {
    el(id)?.addEventListener('change', async e => {
      selectedDate = e.target.value;
      syncDatePickers();
      await loadDateSummary(selectedDate);
    });
  }

  // Тумблер День / Ночь — синхронизация обоих тулбаров. Загружаем только сводку.
  document.querySelectorAll('.shift-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      shiftFilter = btn.dataset.shift;
      syncShiftToggle();
      loadDateSummary(selectedDate);
    });
  });

  // Сводка по компаниям: тумблер «по часам» — перерисовка таблицы без перезагрузки данных.
  el('company-summary-show-hours')?.addEventListener('change', () => renderAll());

  // Сотрудники по часам: тумблер «Простои >15 мин» — показать колонку с паузами между задачами.
  el('idle-threshold-minutes')?.addEventListener('change', () => {
    saveIdleSettings();
    if (!allItems.length) loadDateSummary(selectedDate);
    else renderAll();
  });
  el('allowed-idle-minutes')?.addEventListener('change', () => { saveIdleSettings(); renderAll(); });
  // Обновляем при вводе, без сохранения на каждый символ
  el('idle-threshold-minutes')?.addEventListener('input', () => { renderAll(); });
  el('allowed-idle-minutes')?.addEventListener('input', () => { renderAll(); });
  // Обновляем текст метки при изменении порога
  el('idle-threshold-minutes')?.addEventListener('input', () => { updateIdlesLabel(); });
  el('idle-threshold-minutes')?.addEventListener('change', () => { updateIdlesLabel(); });

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
        await loadDateSummary(selectedDate);
        await loadStatus();
      }
      return;
    }

    const [y, m, d] = selectedDate.split('-').map(Number);
    const minH = Math.min(...missingHours);
    const maxH = Math.max(...missingHours);
    let fromDate;
    let toDate;
    if (shiftFilter === 'night') {
      // Ночь для выбранной даты D: всегда 21:00 D — 08:59 (D+1), чтобы не захватывать 00:00–20:59 дня D
      const next = new Date(y, m - 1, d);
      next.setDate(next.getDate() + 1);
      fromDate = new Date(y, m - 1, d, 21, 0, 0, 0);
      toDate = new Date(next.getFullYear(), next.getMonth(), next.getDate(), 8, 59, 59, 999);
    } else {
      fromDate = new Date(y, m - 1, d, minH, 0, 0, 0);
      toDate = new Date(y, m - 1, d, maxH, 59, 59, 999);
    }
    if (!forceRecheck && selectedDate === todayStr && shiftFilter !== 'night' && minH === currentHour) {
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
    const engineEl = el('save-engine-note');
    if (engineEl) {
      const t = res.timings || {};
      const ms = (v) => Number.isFinite(v) ? `${Math.round(v / 100) / 10}с` : '';
      const parts = [];
      if (res.engine === 'dotnet') {
        parts.push('.NET');
      } else if (res.engine === 'node') {
        parts.push('Node');
        if (res.dotnetError) parts.push(`.NET ошибка: ${res.dotnetError}`);
      } else {
        engineEl.textContent = '';
      }
      if (t.totalMs) parts.push(`итого ${ms(t.totalMs)}`);
      if (t.rawWriteMs) parts.push(`raw ${ms(t.rawWriteMs)}`);
      if (t.dotnetMs) parts.push(`.NET ${ms(t.dotnetMs)}`);
      if (t.nodeMs) parts.push(`Node ${ms(t.nodeMs)}`);
      engineEl.textContent = parts.join(' · ');
    }
    await loadDateSummary(selectedDate);
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

  el('btn-export-missing-weight')?.addEventListener('click', exportMissingWeightXlsx);

  // Экспорт «Сотрудники по часам» в XLSX с раскраской СЗ
  el('btn-export-hourly-xlsx')?.addEventListener('click', exportHourlyToXlsx);
  el('btn-analysis-export-xlsx')?.addEventListener('click', exportAnalysisToXlsx);

  const heModeBtns = ['btn-he-mode-sz', 'btn-he-mode-hourly', 'btn-he-mode-zones', 'btn-he-mode-idles'];
  const setHeMode = (mode) => {
    heTableMode = mode;
    heModeBtns.forEach(id => el(id)?.classList.remove('active'));
    el(`btn-he-mode-${mode}`)?.classList.add('active');
    renderAll();
  };
  el('btn-he-mode-sz')?.addEventListener('click', () => setHeMode('sz'));
  el('btn-he-mode-hourly')?.addEventListener('click', () => setHeMode('hourly'));
  el('btn-he-mode-zones')?.addEventListener('click', () => setHeMode('zones'));
  el('btn-he-mode-idles')?.addEventListener('click', () => setHeMode('idles'));

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

  async function screenshotHtml(container, html) {
    container.innerHTML = html;
    const div = container.querySelector('.he-telegram-wrap') || container.firstElementChild;
    if (!div) return null;
    const canvas = await window.html2canvas(div, { scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff' });
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG'))), 'image/png', 1));
  }

  async function runSendHourlyTelegram(btn, companies, byCompany, hours, shiftFilter, selectedDate, allRows, mode = 'sz', idlesByEmployee = {}, allowedIdleMinutes = 0) {
    const dateStr = (selectedDate || '').replace(/(\d{4})-(\d{2})-(\d{2})/, '$3.$2.$1');
    const shiftLabelText = shiftFilter === 'night' ? 'Ночь' : 'День';
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;top:0;width:1400px;overflow:visible;';
    document.body.appendChild(container);
    if (btn) btn.disabled = true;
    try {
      const items = [];

      if (mode === 'zones') {
        // Один скриншот: таблица «Вес по зонам» для всех сотрудников
        const allRowsFlat = allRows && allRows.length > 0 ? allRows : companies.flatMap(c => byCompany[c] || []);
        const html = buildWeightByZoneTableHtml(allRowsFlat, dateStr, shiftLabelText);
        const blob = await screenshotHtml(container, html);
        if (blob && blob.size > 0) {
          items.push({ blob, caption: `Вес по зонам • ${dateStr} • ${shiftLabelText}`, filename: `zones_${dateStr.replace(/\./g, '-')}.png`, companyKey: 'Full' });
        }
      } else {
        // По СЗ или По часам — общий список + по каждой компании
        const modeLabel = mode === 'hourly' ? 'По часам' : 'По СЗ';
        const tgShiftMin = selectedDate === getTodayStr() ? getElapsedShiftMinutes(shiftFilter) : 12 * 60;
        if (allRows && allRows.length > 0) {
          try {
            const blob = await screenshotHtml(container, buildHourlyTableHtmlFullList(allRows, hours, dateStr, shiftLabelText, mode, idlesByEmployee, allowedIdleMinutes, tgShiftMin));
            if (blob && blob.size > 0) {
              items.push({ blob, caption: `Весь список • ${modeLabel} • ${dateStr} • ${shiftLabelText}`, filename: `full_list_${dateStr.replace(/\./g, '-')}.png`, companyKey: 'Full' });
            }
          } catch (e) { console.warn('Общий список не удалось сформировать:', e); }
        }
        for (const companyName of companies) {
          const rows = byCompany[companyName] || [];
          const blob = await screenshotHtml(container, buildHourlyTableHtmlForCompany(companyName, rows, hours, dateStr, shiftLabelText, mode, idlesByEmployee, allowedIdleMinutes, tgShiftMin));
          if (!blob) continue;
          const safeName = companyName.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 40) || 'company';
          items.push({ blob, caption: `${companyName} • ${modeLabel} • ${dateStr} • ${shiftLabelText}`, filename: `${safeName}_${dateStr.replace(/\./g, '-')}.png`, companyKey: companyName });
        }
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

  async function runSendIdlesTelegram(btn, rows, shiftFilter, selectedDate, thresholdMinutes, allowedIdleMinutes) {
    const dateStr = (selectedDate || '').replace(/(\d{4})-(\d{2})-(\d{2})/, '$3.$2.$1');
    const shiftLabelText = shiftFilter === 'night' ? 'Ночь' : 'День';
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;top:0;width:1200px;overflow:visible;';
    document.body.appendChild(container);
    if (btn) btn.disabled = true;
    try {
      const items = [];
      const byCompany = new Map();
      for (const r of rows) {
        const company = r.company || '—';
        if (!byCompany.has(company)) byCompany.set(company, []);
        byCompany.get(company).push(r);
      }
      const companyTotals = new Map();
      for (const [c, list] of byCompany) {
        companyTotals.set(c, list.reduce((s, r) => s + (Number(r.totalMinutes) || 0), 0));
      }
      const companiesOrder = [...byCompany.keys()].sort((a, b) => (companyTotals.get(b) || 0) - (companyTotals.get(a) || 0));
      for (const companyName of companiesOrder) {
        const list = byCompany.get(companyName) || [];
        if (!list.length) continue;
        const html = buildIdleTableHtml(list, dateStr, shiftLabelText, thresholdMinutes, allowedIdleMinutes, `Простои • ${companyName}`);
        container.innerHTML = html;
        const div = container.querySelector('.he-telegram-wrap') || container.firstElementChild;
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
        if (!blob || blob.size === 0) continue;
        const safeName = companyName.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 40) || 'company';
        items.push({
          blob,
          caption: `Простои • ${companyName} • ${dateStr} • ${shiftLabelText} • порог ${thresholdMinutes} мин`,
          filename: `idles_${safeName}_${dateStr.replace(/\./g, '-')}.png`,
          companyKey: companyName,
        });
      }
      document.body.removeChild(container);
      if (!items.length) throw new Error('Нет данных для отправки');
      const res = await api.sendIdlesTelegram(items);
      if (res.ok) showNotification(`Отправлено в Telegram: ${res.sent || items.length} файл(ов)`, 'success');
      else throw new Error(res.error || 'Ошибка отправки');
    } catch (err) {
      if (container.parentNode) document.body.removeChild(container);
      showNotification('Ошибка: ' + err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // Отправить текущую таблицу в Telegram. Режим определяется heTableMode.
  el('btn-hourly-telegram-png')?.addEventListener('click', async () => {
    const btn = el('btn-hourly-telegram-png');
    if (!window.html2canvas) {
      showNotification('Библиотека html2canvas не загружена', 'error');
      return;
    }

    const isManager = auth.getRole() === 'manager';

    // Проверка привязки для менеджера
    const ensureLinked = async (onLinked) => {
      if (!isManager) { await onLinked(); return; }
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
                await onLinked();
              }
            } catch (_) {}
          }, 2000);
          return;
        }
      } catch (err) {
        showNotification(err.message, 'error');
        return;
      }
      await onLinked();
    };

    if (heTableMode === 'idles') {
      // Режим простоев
      const thresholdMinutes = Math.max(0, parseInt(el('idle-threshold-minutes')?.value, 10) || 15);
      const allowedIdleMinutes = Math.max(0, parseInt(el('allowed-idle-minutes')?.value, 10) || 0);
      let idlesMap = {};
      if (allItems.length > 0) {
        const tableItems = getFilteredItems();
        const { startMs: s0, endMs: e0 } = getShiftBoundaryMs(selectedDate, shiftFilter, selectedDate === getTodayStr());
        idlesMap = calcIdleTotalsByEmployee(tableItems, thresholdMinutes * 60 * 1000, shiftFilter, s0, e0);
      } else if (dateSummary?.idlesByEmployee) {
        idlesMap = dateSummary.idlesByEmployee;
      }
      let rows = buildIdleRowsFromMap(idlesMap, emplMap, shiftFilter);
      if (filterCompany !== '__all__') {
        rows = filterCompany === '__none__'
          ? rows.filter(r => !r.company || r.company === '—')
          : rows.filter(r => r.company === filterCompany);
      }
      if (!rows.length) { showNotification('Нет данных для отправки', 'error'); return; }
      await ensureLinked(() => runSendIdlesTelegram(btn, rows, shiftFilter, selectedDate, thresholdMinutes, allowedIdleMinutes));
    } else {
      // Режимы По СЗ / По часам / По зонам
      let hours, byCompany, allRows, companiesOrder;
      if (allItems.length > 0) {
        const tableItems = getFilteredItems();
        ({ hours, byCompany, allRows, companiesOrder } = getHourlyByEmployeeGroupedByCompany(tableItems, shiftFilter, emplMap, selectedDate));
      } else if (dateSummary?.hourlyByEmployee) {
        ({ hours, byCompany, allRows, companiesOrder } = getHourlyByEmployeeGroupedByCompanyFromSummary(dateSummary.hourlyByEmployee, shiftFilter, emplMap, selectedDate));
      } else {
        hours = []; byCompany = {}; allRows = []; companiesOrder = [];
      }
      const companies = (companiesOrder || Object.keys(byCompany)).filter(c => (byCompany[c] || []).length > 0);
      const allRowsResolved = Array.isArray(allRows) && allRows.length > 0
        ? allRows
        : companies.flatMap(c => byCompany[c] || []);
      if (!companies.length && !allRowsResolved.length) {
        showNotification('Нет данных для отправки', 'error');
        return;
      }
      // Считаем простои для колонки "В работе"
      const thresholdMinutes = Math.max(0, parseInt(el('idle-threshold-minutes')?.value, 10) || 15);
      const allowedIdleMinutes = Math.max(0, parseInt(el('allowed-idle-minutes')?.value, 10) || 0);
      let idlesByEmployeeTg = {};
      if (allItems.length > 0) {
        const { startMs: s1, endMs: e1 } = getShiftBoundaryMs(selectedDate, shiftFilter, selectedDate === getTodayStr());
        idlesByEmployeeTg = calcIdleTotalsByEmployee(getFilteredItems(), thresholdMinutes * 60 * 1000, shiftFilter, s1, e1);
      } else if (dateSummary?.idlesByEmployee) {
        idlesByEmployeeTg = dateSummary.idlesByEmployee;
      }
      await ensureLinked(() => runSendHourlyTelegram(btn, companies, byCompany, hours, shiftFilter, selectedDate, allRowsResolved, heTableMode, idlesByEmployeeTg, allowedIdleMinutes));
    }
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
      // UTF-8 кириллица использует байты D0/D1 (>= 0xC0), поэтому "high bytes" эвристика ломает UTF-8.
      // Надёжнее: пробуем строгий UTF-8 (fatal), иначе — windows-1251 (часто Excel).
      let isUtf8 = false;
      try {
        // fatal=true: бросает ошибку на невалидных последовательностях UTF-8
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        isUtf8 = true;
      } catch {
        isUtf8 = false;
      }
      csvText = new TextDecoder(isUtf8 ? 'utf-8' : 'windows-1251').decode(bytes);
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
    const companyOptions = emplCompanies.length
      ? emplCompanies.map(co => `<option value="${escAttr(co)}">${escAttr(co)}</option>`).join('')
      : '<option value="" disabled>Нет компаний</option>';
    row.innerHTML = `
      <label class="tg-enabled-wrap"><input type="checkbox" class="tg-enabled" checked> Вкл</label>
      <input type="text" class="form-control tg-chat-id" placeholder="Chat ID" value="" title="Chat ID">
      <input type="text" class="form-control tg-thread-cons" placeholder="Thread консолидации" value="">
      <input type="text" class="form-control tg-thread-stats" placeholder="Thread статистики" value="">
      <input type="text" class="form-control tg-thread-idles" placeholder="Thread простоев" value="">
      <select multiple class="form-control tg-companies" title="Пусто = все компании">
        ${companyOptions}
      </select>
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
      const threadIdIdles = (row.querySelector('.tg-thread-idles')?.value || '').trim();
      const enabled = (row.querySelector('.tg-enabled'))?.checked !== false;
      const companiesSelect = row.querySelector('.tg-companies');
      const companiesFilter = companiesSelect
        ? Array.from(companiesSelect.selectedOptions).map(opt => opt.value).filter(Boolean)
        : [];
      if (!chatId) continue;
      if (threadIdConsolidation && !/^\d+$/.test(threadIdConsolidation)) {
        showNotification('Thread ID консолидации должен быть целым положительным числом', 'error');
        return;
      }
      if (threadIdStats && !/^\d+$/.test(threadIdStats)) {
        showNotification('Thread ID статистики должен быть целым положительным числом', 'error');
        return;
      }
      if (threadIdIdles && !/^\d+$/.test(threadIdIdles)) {
        showNotification('Thread ID простоев должен быть целым положительным числом', 'error');
        return;
      }
      telegramChats.push({ chatId, threadIdConsolidation, threadIdStats, threadIdIdles, label: '', enabled, companiesFilter });
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
