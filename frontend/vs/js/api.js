/**
 * api.js — все запросы к backend API
 */

const API = '/api';

// ─── Авторизация /vs (сессия + роли) ─────────────────────────────────────────

const credentials = 'include';

/** Вход: логин + пароль → сессия (cookie) + токен Samokat. Токен обязателен для продолжения. */
export async function loginVs(login, password) {
  const r = await fetch(`${API}/vs/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password }),
    credentials,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Ошибка входа');
  return data;
}

/** Текущая сессия и роли (для восстановления при загрузке). */
export async function getVsMe() {
  const r = await fetch(`${API}/vs/auth/me`, { credentials });
  if (!r.ok) return null;
  return r.json();
}

/** Выход из сессии /vs. */
export async function logoutVs() {
  await fetch(`${API}/vs/auth/logout`, { method: 'POST', credentials });
}

/** Список пользователей /vs (только админ). */
export async function getVsAdminUsers() {
  const r = await fetch(`${API}/vs/admin/users`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || r.statusText);
  return r.json();
}

/** Обновить пользователя: роль, модули (только админ). */
export async function putVsAdminUser(login, payload) {
  const r = await fetch(`${API}/vs/admin/users`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, ...payload }),
    credentials,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

/** Удалить доступ пользователя (только админ). */
export async function deleteVsAdminUser(login) {
  const r = await fetch(`${API}/vs/admin/users/${encodeURIComponent(login)}`, {
    method: 'DELETE',
    credentials,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

/** Статус привязки Telegram (для менеджера). */
export async function getVsTelegramStatus() {
  const r = await fetch(`${API}/vs/telegram/status`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || r.statusText);
  return r.json();
}

/** Начать привязку: выдать одноразовый код. */
export async function postVsTelegramBindStart() {
  const r = await fetch(`${API}/vs/telegram/bind-start`, {
    method: 'POST',
    credentials,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

export async function getStatus() {
  const r = await fetch(`${API}/status`);
  return r.json();
}

export async function requestFetch() {
  const r = await fetch(`${API}/vs/request-fetch`, { method: 'POST', credentials });
  return r.json();
}

export async function markUpdated() {
  const r = await fetch(`${API}/vs/mark-updated`, { method: 'POST', credentials });
  return r.json();
}

export async function getConfig() {
  const r = await fetch(`${API}/config`);
  return r.json();
}

export async function putConfig(data) {
  const r = await fetch(`${API}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.json();
}

export async function fetchData(options = {}, token) {
  const body = { options };
  if (token) body.token = token;
  const r = await fetch(`${API}/fetch-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

export async function listShifts() {
  const r = await fetch(`${API}/shifts`);
  return r.json();
}

export async function getCurrentShift() {
  const r = await fetch(`${API}/shifts/current`);
  return r.json();
}

export async function getShiftItems(shiftKey) {
  const r = await fetch(`${API}/shifts/${encodeURIComponent(shiftKey)}/items`);
  return r.json();
}

/** Операции за один календарный день. shift=day|night — только нужная смена (в разы меньше данных и быстрее). */
export async function getDateItems(date, { fromHour, toHour, shift } = {}) {
  const params = new URLSearchParams();
  if (shift === 'day' || shift === 'night') params.set('shift', shift);
  if (fromHour != null) params.set('fromHour', String(fromHour));
  if (toHour != null) params.set('toHour', String(toHour));
  const qs = params.toString();
  const url = `${API}/date/${encodeURIComponent(date)}/items` + (qs ? `?${qs}` : '');
  const r = await fetch(url);
  return r.json();
}

/** Быстрая сводка за дату и смену (цифры без полного списка операций). */
export async function getDateSummary(date, { shift, idleThresholdMinutes } = {}) {
  const params = new URLSearchParams();
  if (shift === 'day' || shift === 'night') params.set('shift', shift);
  if (idleThresholdMinutes != null && idleThresholdMinutes !== '') {
    params.set('idleThresholdMinutes', String(idleThresholdMinutes));
  }
  const qs = params.toString();
  const url = `${API}/date/${encodeURIComponent(date)}/summary` + (qs ? `?${qs}` : '');
  const r = await fetch(url, { credentials });
  return r.json();
}

/** Анализ: скорости сотрудников по истории (ед/час). */
export async function getAnalysisEmployeeRates({ dateFrom, dateTo, shift, idleThresholdMinutes } = {}) {
  const params = new URLSearchParams();
  if (dateFrom) params.set('dateFrom', String(dateFrom));
  if (dateTo) params.set('dateTo', String(dateTo));
  if (shift === 'day' || shift === 'night') params.set('shift', shift);
  if (idleThresholdMinutes != null && idleThresholdMinutes !== '') {
    params.set('idleThresholdMinutes', String(idleThresholdMinutes));
  }
  const qs = params.toString();
  const url = `${API}/analysis/employee-rates` + (qs ? `?${qs}` : '');
  const r = await fetch(url, { credentials });
  return r.json();
}

export async function scheduleStart() {
  const r = await fetch(`${API}/schedule/start`, { method: 'POST' });
  return r.json();
}

export async function scheduleStop() {
  const r = await fetch(`${API}/schedule/stop`, { method: 'POST' });
  return r.json();
}

export async function scheduleSettings(data) {
  // data: { intervalMinutes?, pageSize? }
  const r = await fetch(`${API}/schedule/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.json();
}

/** Получить персистентный список товаров без веса. */
export async function getMissingWeight() {
  const r = await fetch(`${API}/missing-weight`, { credentials });
  return r.json();
}

/** Таблица весов из Excel: { [article]: grams }. Кэшируется на весь сеанс. */
let _productWeightsCache = null;
export async function getProductWeights() {
  if (_productWeightsCache) return _productWeightsCache;
  try {
    const r = await fetch(`${API}/product-weights`, { credentials });
    _productWeightsCache = await r.json();
  } catch {
    _productWeightsCache = {};
  }
  return _productWeightsCache;
}

/** Синхронизировать список: добавить новые, убрать получившие вес. */
export async function syncMissingWeight(missing, withWeight) {
  const r = await fetch(`${API}/missing-weight/sync`, {
    method: 'POST',
    credentials,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ missing, withWeight }),
  });
  return r.json();
}

export async function getEmployees() {
  const r = await fetch(`${API}/employees`);
  return r.json();
}

/** Отправить PNG по компаниям как файлы (документы) в Telegram. items: [{ blob, caption, filename, companyKey? }]. companyKey: 'Full' | имя компании — для фильтра по чатам. */
export async function sendHourlyStatsTelegram(items, companiesPerFile = null) {
  const fd = new FormData();
  const captions = [];
  const keys = [];
  items.forEach((item, i) => {
    fd.append('documents', item.blob, item.filename || `hourly_${i + 1}.png`);
    captions.push(item.caption || '');
    keys.push(item.companyKey != null ? item.companyKey : (companiesPerFile && companiesPerFile[i]) || '');
  });
  fd.append('captions', JSON.stringify(captions));
  fd.append('companiesPerFile', JSON.stringify(keys));
  const r = await fetch(`${API}/stats/send-hourly-telegram`, { method: 'POST', body: fd, credentials });
  return r.json();
}

/** Отправить PNG таблицы простоев в Telegram. items: [{ blob, caption, filename }]. */
export async function sendIdlesTelegram(items, companiesPerFile = null) {
  const fd = new FormData();
  const captions = [];
  const keys = [];
  items.forEach((item, i) => {
    fd.append('documents', item.blob, item.filename || `idles_${i + 1}.png`);
    captions.push(item.caption || '');
    keys.push(item.companyKey != null ? item.companyKey : (companiesPerFile && companiesPerFile[i]) || '');
  });
  fd.append('captions', JSON.stringify(captions));
  fd.append('companiesPerFile', JSON.stringify(keys));
  const r = await fetch(`${API}/stats/send-idles-telegram`, { method: 'POST', body: fd, credentials });
  return r.json();
}

/** Добавить/дописать одного сотрудника в empl.csv (как в настройках дашборда). */
export async function saveEmplOne(fio, company) {
  const r = await fetch(`${API}/empl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fio: (fio || '').trim(), company: (company != null ? String(company) : '').trim() }),
  });
  return r.json();
}

const LIVE_MONITOR_URL = 'https://api.samokat.ru/wmsops-wwh/activity-monitor/selection/handling-units-in-progress';

/** Живой мониторинг через backend (токен с сервера). */
export async function getLiveMonitor() {
  const r = await fetch(`${API}/monitor/live`);
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150));
  }
  if (!r.ok) {
    const msg = data?.error || r.statusText;
    throw new Error(msg || `HTTP ${r.status}`);
  }
  return data;
}

/** Живой мониторинг запросом из браузера (с токеном пользователя) — чтобы Samokat видел сессию. */
export async function getLiveMonitorViaBrowser(token) {
  const r = await fetch(LIVE_MONITOR_URL, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    },
  });
  const text = await r.text();
  const trimmed = (text || '').trim().toLowerCase();
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('Сервер вернул HTML вместо JSON. Проверьте вход или обновите страницу.');
  }
  let data;
  try { data = text ? JSON.parse(text) : null; } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150));
  }
  if (!r.ok) {
    const msg = data?.message || data?.error || r.statusText;
    throw new Error(`API ${r.status}: ${msg}`);
  }
  return data;
}

export async function getRollcall() {
  const r = await fetch(`${API}/rollcall`);
  return r.json();
}

export async function putRollcall(shiftKey, present) {
  const r = await fetch(`${API}/rollcall`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shiftKey, present }),
  });
  return r.json();
}

export async function loginSamokat(login, password) {
  const r = await fetch('https://api.samokat.ru/wmsin-wwh/auth/password', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
    },
    body: JSON.stringify({ login, password }),
  });
  if (!r.ok) throw new Error(`Ошибка авторизации: ${r.status}`);
  return r.json();
}

export async function refreshSamokatToken(refreshToken) {
  const r = await fetch('https://api.samokat.ru/wmsin-wwh/auth/refresh', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
    },
    body: JSON.stringify({ refreshToken }),
  });
  if (!r.ok) throw new Error(`Ошибка обновления токена: ${r.status}`);
  return r.json();
}

// ─── Консолидация ────────────────────────────────────────────────────────────

export async function getConsolidationComplaints() {
  const r = await fetch(`${API}/consolidation/complaints`);
  return r.json();
}

export async function updateComplaintStatus(id, status) {
  const r = await fetch(`${API}/consolidation/complaints/${encodeURIComponent(id)}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return r.json();
}

export async function deleteComplaint(id) {
  const r = await fetch(`${API}/consolidation/complaints/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return r.json();
}

export async function saveComplaintLookup(id, data) {
  const r = await fetch(`${API}/consolidation/complaints/${encodeURIComponent(id)}/lookup`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.json();
}

export async function sendComplaintsToTelegram(complaintIds) {
  const r = await fetch(`${API}/consolidation/telegram/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ complaintIds }),
  });
  return r.json();
}

// ─── Подключение через браузер (страница /vs) ───────────────────────────────

const SAMOKAT_STOCKS_URL = 'https://api.samokat.ru/wmsops-wwh/stocks/changes/search';


function buildBodyForBrowser(options = {}) {
  let from = options.operationCompletedAtFrom;
  let to = options.operationCompletedAtTo;
  if (options.date) {
    const dateStr = String(options.date).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      from = `${dateStr}T00:00:00.000Z`;
      to = `${dateStr}T23:59:59.999Z`;
    }
  }
  if (!from || !to) {
    const now = new Date();
    const h = now.getHours();
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate();
    if (h >= 9 && h < 21) {
      const fromDate = new Date(y, m, d, 9, 0, 0, 0);
      const toDate = new Date(y, m, d, 20, 59, 59, 999);
      from = fromDate.toISOString();
      to = toDate.toISOString();
    } else {
      const start = new Date(y, m, d, 21, 0, 0, 0);
      if (h < 9) start.setDate(start.getDate() - 1);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      end.setHours(8, 59, 59, 999);
      from = start.toISOString();
      to = end.toISOString();
    }
  }
  return {
    productId: null,
    parts: [],
    operationTypes: ['PICK_BY_LINE', 'PIECE_SELECTION_PICKING'],
    sourceCellId: null,
    targetCellId: null,
    sourceHandlingUnitBarcode: null,
    targetHandlingUnitBarcode: null,
    operationStartedAtFrom: null,
    operationStartedAtTo: null,
    operationCompletedAtFrom: from,
    operationCompletedAtTo: to,
    executorId: null,
    pageNumber: options.pageNumber || 1,
    pageSize: options.pageSize || 2000,
  };
}

async function fetchOnePageFromBrowser(token, body) {
  const r = await fetch(SAMOKAT_STOCKS_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  const trimmed = (text || '').trim().toLowerCase();
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('Сервер вернул HTML вместо JSON. Проверьте VPN или доступ.');
  }
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150));
  }
  if (!r.ok) {
    const msg = data?.message || data?.error || r.statusText;
    throw new Error(`API ${r.status}: ${msg}`);
  }
  const value = data?.value || data;
  const items = Array.isArray(value?.items) ? value.items : [];
  const total = value?.total ?? data?.totalElements ?? null;
  return { items, total };
}

/** Точечный запрос: последняя активность по executorId за интервал (для мониторинга — 30 мин или 1 ч). */
export async function fetchLastCompletedForExecutor(token, executorId, fromIso, toIso) {
  const body = {
    productId: null,
    parts: [],
    operationTypes: [],
    sourceCellId: null,
    targetCellId: null,
    sourceHandlingUnitBarcode: null,
    targetHandlingUnitBarcode: null,
    operationStartedAtFrom: null,
    operationStartedAtTo: null,
    operationCompletedAtFrom: fromIso,
    operationCompletedAtTo: toIso,
    executorId: executorId || null,
    pageNumber: 1,
    pageSize: 100,
  };
  const { items } = await fetchOnePageFromBrowser(token, body);
  let maxCompletedAt = null;
  for (const item of items) {
    const at = item.operationCompletedAt;
    if (!at) continue;
    const ts = new Date(at).getTime();
    if (maxCompletedAt === null || ts > maxCompletedAt) maxCompletedAt = ts;
  }
  return { items, maxCompletedAt };
}

/** Группирует операции по (дата, час) по operationCompletedAt — время подтверждения/выполнения задачи. */
function groupItemsByHour(items) {
  const byHour = new Map();
  for (const item of items) {
    const ts = item.operationCompletedAt;
    if (!ts) continue;
    const d = new Date(ts);
    const dateStr = d.toISOString().slice(0, 10);
    const hour = d.getHours();
    const key = `${dateStr}\t${hour}`;
    if (!byHour.has(key)) byHour.set(key, []);
    byHour.get(key).push(item);
  }
  return byHour;
}

/** Загрузка данных через браузер (все страницы) и сохранение на сервер почасовыми порциями — много маленьких запросов вместо одного большого. */
export async function fetchDataViaBrowser(token, options = {}) {
  const pageSize = Math.min(2000, Math.max(100, parseInt(options.pageSize, 10) || 2000));
  const body = buildBodyForBrowser({ ...options, pageNumber: 1, pageSize });
  const first = await fetchOnePageFromBrowser(token, body);
  let allItems = [...first.items];
  let total = first.total ?? allItems.length;
  const totalPages = Math.ceil(total / pageSize);

  for (let p = 2; p <= totalPages; p++) {
    const nextBody = buildBodyForBrowser({ ...options, pageNumber: p, pageSize });
    const next = await fetchOnePageFromBrowser(token, nextBody);
    allItems = allItems.concat(next.items);
  }

  const byHour = groupItemsByHour(allItems);
  let totalAdded = 0;
  let totalSkipped = 0;
  const savedParts = [];
  let lastEngine = null;
  let lastTimings = null;
  let lastDotnetError = null;

  for (const [key, items] of byHour) {
    const [dateStr, hour] = key.split('\t');
    const saveRes = await fetch(`${API}/save-fetched-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { items, total: items.length } }),
    });
    const saveData = await saveRes.json();
    if (saveData.ok !== true) throw new Error(saveData.error || 'Ошибка сохранения');
    totalAdded += saveData.added ?? 0;
    totalSkipped += saveData.skipped ?? 0;
    savedParts.push(`${dateStr}-${hour}h`);
    lastEngine = saveData.engine || lastEngine;
    lastTimings = saveData.timings || lastTimings;
    lastDotnetError = saveData.dotnetError || lastDotnetError;
  }

  return {
    success: true,
    fetched: allItems.length,
    added: totalAdded,
    skipped: totalSkipped,
    savedTo: savedParts.length ? savedParts.join(', ') : '',
    engine: lastEngine,
    dotnetError: lastDotnetError,
    timings: lastTimings,
    itemsCount: allItems.length,
    total,
  };
}

// ─── Отгрузка / Приёмка РК ───────────────────────────────────────────────────

/** Сводка по всем адресам ЦФЗ. */
export async function getShipmentsCodes() {
  const r = await fetch(`${API}/shipments/codes`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка');
  return r.json();
}

export async function getShipmentsMissingCodes() {
  const r = await fetch(`${API}/shipments/missing-codes`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка');
  return r.json();
}

export async function setShipmentRecipientCode(address, code) {
  const r = await fetch(`${API}/shipments/set-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, code }),
    credentials,
  });
  return r.json();
}

export async function getShipmentsSummary() {
  const r = await fetch(`${API}/shipments`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка загрузки');
  return r.json();
}

/** История по адресу ЦФЗ. */
export async function getShipmentsByAddress(address) {
  const r = await fetch(`${API}/shipments/${encodeURIComponent(address)}`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка загрузки');
  return r.json();
}

const WMS_ROUTES_BASE = 'https://api-p01.samokat.ru/wmsout-wwh/shipments/routes';

function wmsRouteHeaders(token) {
  return {
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Origin': 'https://wwh.samokat.ru',
    'Referer': 'https://wwh.samokat.ru/',
  };
}

async function wmsRouteGet(url, token) {
  const r = await fetch(url, { headers: wmsRouteHeaders(token) });
  const text = await r.text();
  const trimmed = (text || '').trim().toLowerCase();
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('WMS вернул HTML — токен устарел. Обновите страницу и войдите заново.');
  }
  let data;
  try { data = text ? JSON.parse(text) : null; } catch {
    throw new Error('WMS вернул не JSON: ' + (text || '').slice(0, 150));
  }
  if (!r.ok) {
    const msg = data?.message || data?.error || r.statusText;
    throw new Error(`WMS ${r.status}: ${msg}`);
  }
  return data;
}

/** Загрузить маршруты из WMS за период (запросы из браузера), сохранить на бэкенд. */
export async function fetchShipmentsFromWms({ dateFrom, dateTo, token, onProgress }) {
  const fromIso = new Date(dateFrom + 'T00:00:00+03:00').toISOString();
  const toIso   = new Date(dateTo   + 'T23:59:59+03:00').toISOString();

  // 1. Список маршрутов (все страницы)
  const pageSize = 100;
  const firstData = await wmsRouteGet(
    `${WMS_ROUTES_BASE}?${new URLSearchParams({ dateFrom: fromIso, dateTo: toIso, pageNumber: 1, pageSize })}`,
    token
  );
  const first = firstData?.value ?? firstData;
  const total = first?.total || 0;
  const items = [...(first?.items || [])];
  const pages = Math.ceil(total / pageSize);
  for (let p = 2; p <= pages; p++) {
    const d = await wmsRouteGet(
      `${WMS_ROUTES_BASE}?${new URLSearchParams({ dateFrom: fromIso, dateTo: toIso, pageNumber: p, pageSize })}`,
      token
    );
    items.push(...((d?.value ?? d)?.items || []));
  }

  if (onProgress) onProgress(`Маршрутов: ${items.length}. Загружаю детали...`);

  // 2. Детали каждого маршрута (батчами по 5)
  const routeDetails = [];
  const BATCH = 5;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const details = await Promise.all(
      batch.map(item => wmsRouteGet(`${WMS_ROUTES_BASE}/${encodeURIComponent(item.id)}`, token).catch(e => ({ _error: e.message })))
    );
    for (const d of details) {
      if (!d._error) routeDetails.push(d);
    }
    if (onProgress) onProgress(`Загружено деталей: ${routeDetails.length} / ${items.length}...`);
  }

  // 3. Отправляем на бэкенд для сохранения
  const r = await fetch(`${API}/shipments/import-bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routes: routeDetails }),
    credentials,
  });
  return r.json();
}

/** Сотрудник вносит принятое количество РК. */
export async function submitShipmentsReceived({ address, routeId, date, received }) {
  const r = await fetch(`${API}/shipments/receive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, routeId, date, received }),
    credentials,
  });
  return r.json();
}

/** Список уникальных водителей для автодополнения. */
export async function getShipmentsDriversList(query) {
  const r = await fetch(`${API}/shipments/drivers?q=${encodeURIComponent(query)}`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка');
  return r.json();
}

/** Неподтверждённые маршруты конкретного водителя по имени. */
export async function getShipmentsRoutesByDriver(name) {
  const r = await fetch(`${API}/shipments/routes-by-driver?name=${encodeURIComponent(name)}`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка');
  return r.json();
}

/** Адреса конкретного маршрута по routeId. */
export async function getShipmentsByRoute(routeId) {
  const r = await fetch(`${API}/shipments/by-route/${encodeURIComponent(routeId)}`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка');
  return r.json();
}

/** Поиск адресов по имени водителя. */
export async function getShipmentsByDriver(query) {
  const r = await fetch(`${API}/shipments/by-driver?q=${encodeURIComponent(query)}`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка');
  return r.json();
}

/** Массовая приёмка от водителя. */
export async function submitShipmentsReceivedBulk(items) {
  const r = await fetch(`${API}/shipments/receive-bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
    credentials,
  });
  return r.json();
}

// ─── Отгрузка РК (маршрутная модель) ─────────────────────────────────────────

/** Загрузить маршруты из WMS и сохранить в route-rk (только метаданные, без счёта РК). */
export async function fetchRkFromWms({ dateFrom, dateTo, token, onProgress }) {
  const fromIso = new Date(dateFrom + 'T00:00:00+03:00').toISOString();
  const toIso   = new Date(dateTo   + 'T23:59:59+03:00').toISOString();

  function buildParams(pageNumber, pageSize) {
    const p = new URLSearchParams({ dateFrom: fromIso, dateTo: toIso, pageNumber, pageSize });
    p.append('status', 'PACKAGING');
    p.append('status', 'COMPLETED');
    return p;
  }

  const pageSize = 100;
  const firstData = await wmsRouteGet(`${WMS_ROUTES_BASE}?${buildParams(1, pageSize)}`, token);
  const first = firstData?.value ?? firstData;
  const total = first?.total || 0;
  const rawItems = [...(first?.items || [])];
  const pages = Math.ceil(total / pageSize);
  for (let p = 2; p <= pages; p++) {
    const d = await wmsRouteGet(`${WMS_ROUTES_BASE}?${buildParams(p, pageSize)}`, token);
    rawItems.push(...((d?.value ?? d)?.items || []));
  }
  // Дедупликация по id — маршрут не должен попасть дважды
  const seen = new Set();
  const items = rawItems.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; });

  if (onProgress) onProgress(`Маршрутов: ${items.length}. Загружаю детали...`);

  const routeDetails = [];
  const BATCH = 5;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const details = await Promise.all(
      batch.map(item => wmsRouteGet(`${WMS_ROUTES_BASE}/${encodeURIComponent(item.id)}`, token).catch(e => ({ _error: e.message })))
    );
    for (const d of details) {
      if (!d._error) routeDetails.push(d);
    }
    if (onProgress) onProgress(`Загружено деталей: ${routeDetails.length} / ${items.length}...`);
  }

  const r = await fetch(`${API}/rk/import-bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routes: routeDetails }),
    credentials,
  });
  return r.json();
}

/** Список маршрутов с фильтрацией. */
export async function getRkRoutes({ q, dateFrom, dateTo, status } = {}) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  if (status) params.set('status', status);
  const r = await fetch(`${API}/rk/routes?${params}`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка загрузки маршрутов');
  return r.json();
}

/** Загрузить фотографии, вернуть массив URL. */
export async function uploadRkPhotos(files) {
  const form = new FormData();
  for (const f of files) form.append('photos', f);
  const r = await fetch(`${API}/rk/photos`, { method: 'POST', body: form, credentials });
  return r.json();
}

/** Зафиксировать отгрузку РК по маршруту (по ЦФЗ). */
export async function submitRkShipment(routeId, { by, gate, items, photos }) {
  const r = await fetch(`${API}/rk/routes/${encodeURIComponent(routeId)}/ship`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by, gate, items, photos }),
    credentials,
  });
  return r.json();
}

/** Зафиксировать приёмку (возврат РК) по маршруту. */
export async function submitRkReceiving(routeId, { by, gate, items, photos }) {
  const r = await fetch(`${API}/rk/routes/${encodeURIComponent(routeId)}/receive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by, gate, items, photos }),
    credentials,
  });
  return r.json();
}

/** Редактировать данные отгрузки (работает для подтверждённых тоже). */
export async function updateRkShipment(routeId, payload) {
  const r = await fetch(`${API}/rk/routes/${encodeURIComponent(routeId)}/ship`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    credentials,
  });
  return r.json();
}

/** Редактировать данные приёмки. */
export async function updateRkReceiving(routeId, payload) {
  const r = await fetch(`${API}/rk/routes/${encodeURIComponent(routeId)}/receive`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    credentials,
  });
  return r.json();
}

/** Подтвердить отгрузку по маршруту. */
export async function confirmRkShipment(routeId) {
  const r = await fetch(`${API}/rk/routes/${encodeURIComponent(routeId)}/confirm-ship`, {
    method: 'POST',
    credentials,
  });
  return r.json();
}

/** Подтвердить приёмку по маршруту. */
export async function confirmRkReceiving(routeId) {
  const r = await fetch(`${API}/rk/routes/${encodeURIComponent(routeId)}/confirm-receive`, {
    method: 'POST',
    credentials,
  });
  return r.json();
}

/** Сводка по водителям. */
export async function getRkDrivers(q) {
  const r = await fetch(`${API}/rk/drivers?q=${encodeURIComponent(q || '')}`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка');
  return r.json();
}

/** Водители с неподтверждёнными маршрутами (для приёмки). */
export async function getRkDriversPending(q) {
  const r = await fetch(`${API}/rk/drivers/pending?q=${encodeURIComponent(q || '')}`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка');
  return r.json();
}

/** Маршруты конкретного водителя, ожидающие приёмки. */
export async function getRkDriverRoutesPending(driverName) {
  const r = await fetch(`${API}/rk/drivers/${encodeURIComponent(driverName)}/routes/pending`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка');
  return r.json();
}

/** Сводка по ЦФЗ. */
export async function getRkCfz(q) {
  const r = await fetch(`${API}/rk/cfz?q=${encodeURIComponent(q || '')}`, { credentials });
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка');
  return r.json();
}

/** Только сохранить уже полученные данные (например после ручной загрузки). */
export async function saveFetchedData(items) {
  const r = await fetch(`${API}/save-fetched-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: { items } }),
  });
  return r.json();
}
