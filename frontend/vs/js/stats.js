/**
 * stats.js — подсчёт и отображение статистики по операциям
 */

import { el, normalizeFio, formatTime, hasMatchInEmplKeys, getCompanyByFio } from './utils.js';

/**
 * Ключ "задачи": для КДК (По линии) — один вклад в одну ячейку одним товаром = одна задача; для остальных — одна операция = одна задача.
 */
function getTaskKey(item) {
  const type = (item.operationType || '').toUpperCase();
  if (type === 'PICK_BY_LINE') {
    const exec = item.executorId || item.executor || '';
    const cell = item.cell || '';
    const product = item.nomenclatureCode || item.productName || '';
    return `kdk|${exec}|${cell}|${product}`;
  }
  return item.id ? `op|${item.id}` : `op|${(item.completedAt || item.startedAt || '')}|${item.executor || ''}|${item.cell || ''}`;
}

/**
 * Считает статистику по плоскому массиву операций.
 * Для КДК (По линии) несколько вкладов одного товара в одну ячейку одним сотрудником считаются одной задачей.
 * @param {Array} items — flattenItem[]
 * @param {Map} emplMap — Map(normalizedFio -> company)
 * @param {string} filterCompany — '__all__' | '__none__' | company
 */
export function calcStats(items, emplMap, filterCompany) {
  const filtered = filterByCompany(items, emplMap, filterCompany);

  const totalTaskKeys = new Set(filtered.map(i => getTaskKey(i)));
  const totalOps = totalTaskKeys.size;
  const totalQty = filtered.reduce((s, i) => s + (Number(i.quantity) || 0), 0);

  // Статистика по сотрудникам (ops = число задач с дедупом КДК)
  const byExecutor = new Map();
  for (const item of filtered) {
    const key = item.executor || 'Неизвестно';
    if (!byExecutor.has(key)) byExecutor.set(key, { name: key, taskKeys: new Set(), qty: 0, firstAt: null, lastAt: null });
    const e = byExecutor.get(key);
    e.taskKeys.add(getTaskKey(item));
    e.qty += Number(item.quantity) || 0;
    const ts = item.completedAt || item.startedAt;
    if (ts) {
      if (!e.firstAt || ts < e.firstAt) e.firstAt = ts;
      if (!e.lastAt  || ts > e.lastAt)  e.lastAt  = ts;
    }
  }
  const executors = [...byExecutor.values()].map(e => ({
    ...e,
    ops: e.taskKeys.size,
    company: emplMap ? (getCompanyByFio(emplMap, normalizeFio(e.name)) || '—') : '—',
  })).sort((a, b) => b.ops - a.ops);

  // Статистика по часам: ориентир — completedAt (время подтверждения задачи). Как на бэкенде.
  const byHour = new Map(); // hour -> { hour, taskKeys: Set, kdkTaskKeys: Set, employees: Set, storageOps, kdkOps }
  for (const item of filtered) {
    const ts = item.completedAt;
    if (!ts) continue;
    const h = new Date(ts).getHours();
    if (!byHour.has(h)) byHour.set(h, { hour: h, taskKeys: new Set(), kdkTaskKeys: new Set(), employees: new Set(), storageOps: 0, kdkOps: 0 });
    const hh = byHour.get(h);
    const type = (item.operationType || '').toUpperCase();
    const isKdk = type === 'PICK_BY_LINE';
    const tk = getTaskKey(item);
    hh.taskKeys.add(tk);
    if (isKdk) hh.kdkTaskKeys.add(tk);
    else if (type === 'PIECE_SELECTION_PICKING') hh.storageOps++;
    hh.kdkOps = hh.kdkTaskKeys.size;
    if (item.executorId || item.executor) hh.employees.add(item.executorId || item.executor);
  }
  const hourly = [...byHour.values()].map(x => ({
    hour: x.hour,
    ops: x.taskKeys.size,
    employees: x.employees.size,
    storageOps: x.storageOps,
    kdkOps: x.kdkOps,
  })).sort((a, b) => a.hour - b.hour);

  // Время старта и последнего пика (по completedAt)
  let firstAt = null;
  let lastAt = null;
  for (const item of filtered) {
    const ts = item.completedAt;
    if (!ts) continue;
    if (!firstAt || ts < firstAt) firstAt = ts;
    if (!lastAt  || ts > lastAt)  lastAt  = ts;
  }

  return { totalOps, totalQty, executors, filteredCount: filtered.length, hourly, firstAt, lastAt };
}

function filterByCompany(items, emplMap, filterCompany) {
  if (!emplMap || !filterCompany || filterCompany === '__all__') return items;
  if (filterCompany === '__none__') {
    return items.filter(i => !hasMatchInEmplKeys(normalizeFio(i.executor), emplMap));
  }
  return items.filter(i => getCompanyByFio(emplMap, normalizeFio(i.executor)) === filterCompany);
}

/**
 * Рендерит карточки статистики.
 */
export function renderStats(stats, shiftLabel) {
  const container = el('stats-cards');
  if (!container) return;

  const totalStorage = (stats.hourly || []).reduce((s, h) => s + (h.storageOps || 0), 0);

  container.innerHTML = `
    <div class="stat-card">
      <div class="stat-icon">📦</div>
      <div class="stat-value">${(stats.totalOps || 0).toLocaleString('ru-RU')}</div>
      <div class="stat-label">Операций</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">📋</div>
      <div class="stat-value">${totalStorage.toLocaleString('ru-RU')}</div>
      <div class="stat-label">Задач (хранение)</div>
    </div>
    <div class="stat-card stat-card--green">
      <div class="stat-icon">🔢</div>
      <div class="stat-value">${(stats.totalQty || 0).toLocaleString('ru-RU')}</div>
      <div class="stat-label">Единиц товара</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">👷</div>
      <div class="stat-value">${(stats.executors || []).length}</div>
      <div class="stat-label">Сотрудников</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">📅</div>
      <div class="stat-value stat-value--sm">${shiftLabel || '—'}</div>
      <div class="stat-label">Дата</div>
    </div>

  `;
}

/**
 * Рендерит таблицу топ-сотрудников.
 */
export function renderExecutorTable(executors) {
  const tbody = el('executor-tbody');
  if (!tbody) return;

  if (!executors.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Нет данных</td></tr>';
    return;
  }

  const maxOps = Math.max(...executors.map(e => e.ops), 1);
  tbody.innerHTML = executors.map((e, i) => `
    <tr>
      <td class="rank">${i + 1}</td>
      <td class="executor-company">${escHtml(e.company || '—')}</td>
      <td class="executor-name">${escHtml(e.name)}</td>
      <td class="text-right">${e.qty.toLocaleString('ru-RU')}</td>
      <td class="qty-cell">
        <div class="qty-bar-wrap">
          <div class="qty-bar" style="width:${Math.round((e.ops / maxOps) * 100)}%"></div>
          <span class="qty-value">${e.ops.toLocaleString('ru-RU')}</span>
        </div>
      </td>
      <td class="text-right time-cell">${e.firstAt ? formatTime(e.firstAt) : '—'} – ${e.lastAt ? formatTime(e.lastAt) : '—'}</td>
    </tr>
  `).join('');
}

/** Часы для отображения: день — колонка 10 = 09:00–10:00, колонка 21 = 20:00–21:00 (номер колонки = конец часа) */
const DAY_HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
/** Ночь: колонка 22 = 21:00–22:00, 23 = 22:00–23:00, 0 = 23:00–00:00, … 9 = 08:00–09:00 (смена 21–09) */
const NIGHT_HOURS = [22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** По storageByHour (ключи 0–23, час МСК) и списку колонок cols строит byHour для строки «Хранение». col = (hour+1)%24. */
export function buildStorageRowForCols(storageByHour, cols) {
  const byHour = {};
  let total = 0;
  for (const col of cols) {
    const hour = (col - 1 + 24) % 24;
    const v = (storageByHour[hour] ?? 0) + (storageByHour[String(hour)] ?? 0);
    byHour[col] = v;
    total += v;
  }
  return { byHour, total };
}

/**
 * Приводит массив по часам к порядку и диапазону смены; заполняет нулями отсутствующие часы.
 * Метки столбцов = конец интервала (10 = 09:00–10:00, 21 = 20:00–21:00). Данные из calcStats по началу часа (9..20).
 * @param {Array} hourly — массив { hour, ops, employees, storageOps, kdkOps }
 * @param {'day'|'night'} shiftFilter
 */
export function getHourlyForShift(hourly, shiftFilter) {
  const byHour = new Map();
  if (Array.isArray(hourly)) {
    for (const h of hourly) byHour.set(h.hour, {
      hour: h.hour,
      ops: h.ops || 0,
      employees: h.employees ?? 0,
      storageOps: h.storageOps ?? 0,
      kdkOps: h.kdkOps ?? 0,
    });
  }
  const order = shiftFilter === 'night' ? NIGHT_HOURS : DAY_HOURS;
  return order.map(col => {
    const dataHour = shiftFilter === 'day' ? col - 1 : (col - 1 + 24) % 24;
    const h = byHour.get(dataHour) || { hour: dataHour, ops: 0, employees: 0, storageOps: 0, kdkOps: 0 };
    return { ...h, hour: col };
  });
}

/**
 * Рендерит диаграмму пиков по часам: сверху операции и сотрудников, два столбика — хранение и КДК, значение внутри столбика.
 */
export function renderHourlyChart(hourly, shiftFilter = 'day') {
  const container = el('hourly-chart');
  if (!container) return;

  const ordered = getHourlyForShift(hourly || [], shiftFilter);
  const hasData = ordered.some(h => h.ops > 0 || h.storageOps > 0 || h.kdkOps > 0);

  if (!hasData) {
    container.innerHTML = '<div class="empty-row" style="padding:20px;text-align:center;color:var(--text-muted)">Нет данных</div>';
    return;
  }

  const maxBar = Math.max(...ordered.map(h => Math.max(h.storageOps, h.kdkOps)), 1);

  container.innerHTML = `
    <div class="hourly-bars">
      ${ordered.map(h => `
        <div class="hourly-col">
          <div class="hourly-values">
            <span class="hourly-ops">${h.ops} оп.</span>
            <span class="hourly-employees">${h.employees} чел.</span>
          </div>
          <div class="hourly-bar-wrap">
            <div class="hourly-bar-storage" style="height:${Math.round((h.storageOps / maxBar) * 100)}%" title="Хранение">
              <span class="hourly-bar-value">${h.storageOps}</span>
            </div>
            <div class="hourly-bar-kdk" style="height:${Math.round((h.kdkOps / maxBar) * 100)}%" title="КДК">
              <span class="hourly-bar-value">${h.kdkOps}</span>
            </div>
          </div>
          <div class="hourly-label">${String(h.hour).padStart(2, '0')}:00</div>
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Считает для каждого сотрудника СЗ по каждому часу — так же, как на dsh:
 * ХР = только PIECE_SELECTION_PICKING (каждая операция), КДК = уникальные по (товар + ячейка) для PICK_BY_LINE.
 * СЗ = ХР + КДК (без двойного учёта).
 * @param {Array} items — flattenItem[] уже отфильтрованные по смене/компании
 * @param {'day'|'night'} shiftFilter
 * @returns {{ hours: number[], rows: Array<{name:string, byHour:Object, total:number}> }}
 */
export function calcHourlyByEmployee(items, shiftFilter = 'day') {
  const order = shiftFilter === 'night' ? NIGHT_HOURS : DAY_HOURS;

  // byEmployee: name -> Map<hour, { pieceSelectionCount: number, kdkSet: Set<product||cell> }>
  const byEmployee = new Map();

  for (const item of items) {
    const ts = item.completedAt;
    if (!ts) continue;
    const h = new Date(ts).getHours();
    // Колонка 10 = 09:00–10:00 (час 9), колонка 21 = 20:00–21:00 (час 20) → ключ col = конец интервала
    const col = (h + 1) % 24;
    const name = item.executor || 'Неизвестно';

    if (!byEmployee.has(name)) byEmployee.set(name, new Map());
    const hourMap = byEmployee.get(name);

    if (!hourMap.has(col)) hourMap.set(col, { pieceSelectionCount: 0, kdkSet: new Set() });
    const cell = hourMap.get(col);

    const type = (item.operationType || '').toUpperCase();
    if (type === 'PIECE_SELECTION_PICKING') {
      cell.pieceSelectionCount++;
    } else if (type === 'PICK_BY_LINE') {
      const productId = item.nomenclatureCode || item.productName || 'no-product';
      const targetCell = item.cell || 'no-target-cell';
      cell.kdkSet.add(`${productId}||${targetCell}`);
    }
  }

  const rows = [];
  for (const [name, hourMap] of byEmployee) {
    const byHour = {};
    let total = 0;
    for (const col of order) {
      const cell = hourMap.get(col);
      if (!cell) { byHour[col] = 0; continue; }
      const sz = cell.pieceSelectionCount + (cell.kdkSet ? cell.kdkSet.size : 0);
      byHour[col] = sz;
      total += sz;
    }
    rows.push({ name, byHour, total });
  }

  return { hours: order, rows };
}

/**
 * Часы, которые уже наступили (для выбранной даты). Для «сегодня» — только прошедшие; для прошлой даты — все.
 */
export function filterHoursToPassed(selectedDate, shiftFilter) {
  const order = shiftFilter === 'night' ? NIGHT_HOURS : DAY_HOURS;
  const today = typeof selectedDate === 'string' && selectedDate === getTodayStr();
  if (!today) return order;
  const now = new Date();
  const currentHour = now.getHours();
  if (shiftFilter === 'day') {
    return order.filter(col => col <= currentHour);
  }
  return order.filter(col => col >= 22 || col <= currentHour);
}

/**
 * Прошедшие часы + текущий час (колонка текущего интервала). В 15:56 показываем 10,11,12,13,14,15,16.
 */
export function getHoursPassedIncludingCurrent(selectedDate, shiftFilter) {
  const order = shiftFilter === 'night' ? NIGHT_HOURS : DAY_HOURS;
  const passed = filterHoursToPassed(selectedDate, shiftFilter);
  const today = typeof selectedDate === 'string' && selectedDate === getTodayStr();
  if (!today) return passed;
  const now = new Date();
  const currentHour = now.getHours();
  const currentCol = shiftFilter === 'day' ? currentHour + 1 : (currentHour + 1) % 24;
  if (order.includes(currentCol) && !passed.includes(currentCol)) {
    return shiftFilter === 'day' ? [...passed, currentCol].sort((a, b) => a - b) : order.filter(col => passed.includes(col) || col === currentCol);
  }
  return passed;
}

function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Данные «Сотрудники по часам»: только прошедшие часы, с компанией, сгруппированы по компании (для отправки в Telegram).
 * allRows — все сотрудники: компании идут подряд (по убыванию суммы задач), внутри компании — СЗ по убыванию.
 * companiesOrder — компании по убыванию суммы задач (для порядка отправки в Telegram).
 */
export function getHourlyByEmployeeGroupedByCompany(items, shiftFilter, emplMap, selectedDate) {
  const { hours: allHours, rows } = calcHourlyByEmployee(items, shiftFilter);
  const hours = filterHoursToPassed(selectedDate, shiftFilter);
  const getCompany = (name) => (emplMap && name ? (getCompanyByFio(emplMap, normalizeFio(name)) || '—') : '—');
  const withCompany = rows.map(r => ({ ...r, company: getCompany(r.name) }));
  const byCompany = new Map();
  for (const r of withCompany) {
    const c = r.company || '—';
    if (!byCompany.has(c)) byCompany.set(c, []);
    byCompany.get(c).push(r);
  }
  for (const arr of byCompany.values()) {
    arr.sort((a, b) => (b.total - a.total));
  }
  const companyTotals = new Map();
  for (const [c, arr] of byCompany) {
    companyTotals.set(c, arr.reduce((s, r) => s + r.total, 0));
  }
  const companiesOrder = [...byCompany.keys()].sort((a, b) => (companyTotals.get(b) || 0) - (companyTotals.get(a) || 0));
  // Общий список: компании вместе, внутри компании — от макс. СЗ к мин.
  const allRows = companiesOrder.flatMap(c => byCompany.get(c) || []);
  return { hours, byCompany: Object.fromEntries(byCompany), allRows, companiesOrder };
}

/**
 * То же, что getHourlyByEmployeeGroupedByCompany, но из сохранённой сводки (когда allItems пуст).
 * hourlyByEmployee: { hours: number[], rows: Array<{ name, byHour, total }> }
 */
export function getHourlyByEmployeeGroupedByCompanyFromSummary(hourlyByEmployee, shiftFilter, emplMap, selectedDate) {
  const hours = filterHoursToPassed(selectedDate, shiftFilter);
  const rows = Array.isArray(hourlyByEmployee?.rows) ? hourlyByEmployee.rows : [];
  const getCompany = (name) => (emplMap && name ? (getCompanyByFio(emplMap, normalizeFio(name)) || '—') : '—');
  const withCompany = rows.map(r => ({ ...r, company: getCompany(r.name) }));
  const byCompany = new Map();
  for (const r of withCompany) {
    const c = r.company || '—';
    if (!byCompany.has(c)) byCompany.set(c, []);
    byCompany.get(c).push(r);
  }
  for (const arr of byCompany.values()) {
    arr.sort((a, b) => (b.total - a.total));
  }
  const companyTotals = new Map();
  for (const [c, arr] of byCompany) {
    companyTotals.set(c, arr.reduce((s, r) => s + r.total, 0));
  }
  const companiesOrder = [...byCompany.keys()].sort((a, b) => (companyTotals.get(b) || 0) - (companyTotals.get(a) || 0));
  const allRows = companiesOrder.flatMap(c => byCompany.get(c) || []);
  return { hours, byCompany: Object.fromEntries(byCompany), allRows, companiesOrder };
}

/**
 * Данные для таблицы сводки по компаниям: Компания, сотруднико, СЗЧ, [часы 10..текущий], Итог.
 * СЗЧ = среднее задач в час = Итог / сотруднико / кол-во прошедших часов (без текущего).
 * hoursDisplay = прошедшие часы + текущий (в 15:56 → 10,11,12,13,14,15,16).
 */
export function getCompanySummaryTableData(items, shiftFilter, emplMap, selectedDate) {
  const { hours, byCompany, companiesOrder } = getHourlyByEmployeeGroupedByCompany(items, shiftFilter, emplMap, selectedDate);
  const hoursDisplay = getHoursPassedIncludingCurrent(selectedDate, shiftFilter);
  const passedHours = hours.length;
  const rows = companiesOrder.map(c => {
    const companyRows = byCompany[c] || [];
    const employeesCount = companyRows.length;
    const totalTasks = companyRows.reduce((s, r) => s + r.total, 0);
    const szch = passedHours > 0 && employeesCount > 0 ? Math.round(totalTasks / employeesCount / passedHours) : 0;
    const byHour = {};
    for (const col of hoursDisplay) {
      byHour[col] = companyRows.reduce((s, r) => s + (r.byHour && r.byHour[col] ? r.byHour[col] : 0), 0);
    }
    return { companyName: c, employeesCount, szch, totalTasks, byHour };
  });
  return { rows, hoursDisplay };
}

/**
 * Рендер таблицы сводки по компаниям (Компания, сотруднико, СЗЧ, [опционально часы], Итог) и подписи формул.
 * showHours: true — с колонками по часам; false — только Компания, Сотрудников, СЗЧ, Итог.
 */
export function renderCompanySummaryTable(rows, hoursDisplay = [], showHours = true) {
  const container = el('company-summary-table-wrap');
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = '<div class="empty-row" style="padding:16px;text-align:center;color:var(--text-muted)">Нет данных</div>';
    return;
  }
  const thHours = showHours && (hoursDisplay || []).length
    ? (hoursDisplay || []).map(col => `<th class="cs-th-hour" title="${String(col).padStart(2, '0')}:00">${col}</th>`).join('')
    : '';
  const trRows = rows.map(r => {
    const cellsHours = showHours && (hoursDisplay || []).length
      ? (hoursDisplay || []).map(col => `<td class="cs-td-num cs-td-hour">${r.byHour && r.byHour[col] != null ? r.byHour[col] : ''}</td>`).join('')
      : '';
    return `
    <tr>
      <td class="cs-td-company">${escHtml(r.companyName)}</td>
      <td class="cs-td-num">${r.employeesCount}</td>
      <td class="cs-td-num">${r.szch}</td>
      ${thHours ? cellsHours : ''}
      <td class="cs-td-num">${r.totalTasks}</td>
    </tr>
  `;
  }).join('');
  container.innerHTML = `
    <table class="company-summary-table">
      <thead>
        <tr>
          <th class="cs-th-company">Компания</th>
          <th class="cs-th-num">Сотрудников</th>
          <th class="cs-th-num">СЗЧ</th>
          ${thHours}
          <th class="cs-th-num">Итог</th>
        </tr>
      </thead>
      <tbody>${trRows}</tbody>
    </table>
    <div class="company-summary-formulas">
      <div class="cs-formula-row">
        <span class="cs-formula-label">Считаем количество сотрудников</span>
      </div>
      <div class="cs-formula-row">
        <span class="cs-formula-label">СЗЧ — среднее задач в час:</span>
        <span class="cs-formula-text">сумма задач ÷ количество сотрудников ÷ количество прошедших часов (с 9:00 для дневной смены). Пример: Итог ∕ Сотрудников ∕ часы = СЗЧ</span>
      </div>
      ${showHours ? '<div class="cs-formula-row"><span class="cs-formula-label">Колонки по часам — сумма выполненных задач за каждый час (прошедшие + текущий). Итог — СЗ за все часы у компании.</span></div>' : ''}
    </div>
  `;
}

/** Стиль первой колонки (ФИО у левого края) — инлайн, чтобы html2canvas не терял при рендере */
const HE_NAME_COL_STYLE = 'width:200px;min-width:200px;max-width:200px;text-align:left;padding:6px 8px;border:1px solid #DDE2EA;background:#fff;font-weight:500;box-sizing:border-box;';

/**
 * HTML таблицы по часам для одной компании (для скриншота в Telegram).
 * ФИО — строго в первой колонке у левого края, часы — справа от неё.
 */
export function buildHourlyTableHtmlForCompany(companyName, rows, hours, dateStr, shiftLabel) {
  const hourLabel = (col) => {
    const start = (col + 23) % 24;
    return `${String(start).padStart(2, '0')}–${String(col).padStart(2, '0')}`;
  };
  const thHours = hours.map(col => `<th style="width:46px;padding:6px 8px;border:1px solid #DDE2EA;background:#f5f7fa;font-size:12px;text-align:center;" title="${hourLabel(col)}">${String(col).padStart(2, '0')}</th>`).join('');
  const thTotalStyle = 'width:56px;padding:6px 8px;border:1px solid #DDE2EA;background:#f5f7fa;font-size:12px;text-align:center;';
  const szCellClass = (v) => {
    if (v < 50) return 'he-sz-red';
    if (v <= 75) return 'he-sz-mid';
    return 'he-sz-white';
  };
  const trRows = rows.map(r => {
    const cells = hours.map(col => {
      const v = r.byHour[col] || 0;
      const cl = szCellClass(v);
      return `<td class="he-td-val ${cl}" style="width:46px;padding:6px 8px;border:1px solid #DDE2EA;text-align:center;">${v > 0 ? v : ''}</td>`;
    }).join('');
    const totalStyle = 'width:56px;padding:6px 8px;border:1px solid #DDE2EA;text-align:center;font-weight:600;';
    return `<tr><th scope="row" style="${HE_NAME_COL_STYLE}">${escHtml(r.name)}</th>${cells}<td style="${totalStyle}">${r.total}</td></tr>`;
  }).join('');
  return `
    <div class="he-telegram-wrap" style="padding:12px;background:#fff;font-family:Inter,sans-serif;">
      <div class="he-telegram-title" style="font-size:16px;font-weight:700;margin-bottom:4px;">${escHtml(companyName)}</div>
      <div class="he-telegram-meta" style="font-size:12px;color:#6b7280;margin-bottom:10px;">${escHtml(dateStr)} • ${escHtml(shiftLabel)}</div>
      <table style="border-collapse:collapse;table-layout:fixed;width:100%;font-size:13px;">
        <thead><tr><th style="${HE_NAME_COL_STYLE}background:#f5f7fa;font-size:12px;">Исполнитель</th>${thHours}<th style="${thTotalStyle}">Итого</th></tr></thead>
        <tbody>${trRows}</tbody>
      </table>
    </div>`;
}

const HE_COMPANY_COL_STYLE = 'width:180px;min-width:180px;max-width:180px;text-align:left;padding:6px 8px;border:1px solid #DDE2EA;background:#fff;font-size:12px;box-sizing:border-box;';

/**
 * HTML таблицы «Весь список по часам» со всеми сотрудниками (для скриншота в Telegram).
 * Колонки: Компания, Исполнитель, часы…, Итого. Сортировка: задачи по убыванию, компания по убыванию.
 */
export function buildHourlyTableHtmlFullList(rows, hours, dateStr, shiftLabel) {
  const hourLabel = (col) => {
    const start = (col + 23) % 24;
    return `${String(start).padStart(2, '0')}–${String(col).padStart(2, '0')}`;
  };
  const thHours = hours.map(col => `<th style="width:46px;padding:6px 8px;border:1px solid #DDE2EA;background:#f5f7fa;font-size:12px;text-align:center;" title="${hourLabel(col)}">${String(col).padStart(2, '0')}</th>`).join('');
  const thTotalStyle = 'width:56px;padding:6px 8px;border:1px solid #DDE2EA;background:#f5f7fa;font-size:12px;text-align:center;';
  const szCellClass = (v) => {
    if (v < 50) return 'he-sz-red';
    if (v <= 75) return 'he-sz-mid';
    return 'he-sz-white';
  };
  const trRows = rows.map(r => {
    const cells = hours.map(col => {
      const v = r.byHour[col] || 0;
      const cl = szCellClass(v);
      return `<td class="he-td-val ${cl}" style="width:46px;padding:6px 8px;border:1px solid #DDE2EA;text-align:center;">${v > 0 ? v : ''}</td>`;
    }).join('');
    const totalStyle = 'width:56px;padding:6px 8px;border:1px solid #DDE2EA;text-align:center;font-weight:600;';
    return `<tr><th scope="row" style="${HE_COMPANY_COL_STYLE}">${escHtml(r.company)}</th><th scope="row" style="${HE_NAME_COL_STYLE}">${escHtml(r.name)}</th>${cells}<td style="${totalStyle}">${r.total}</td></tr>`;
  }).join('');
  return `
    <div class="he-telegram-wrap" style="padding:12px;background:#fff;font-family:Inter,sans-serif;">
      <div class="he-telegram-title" style="font-size:16px;font-weight:700;margin-bottom:4px;">Весь список по часам</div>
      <div class="he-telegram-meta" style="font-size:12px;color:#6b7280;margin-bottom:10px;">${escHtml(dateStr)} • ${escHtml(shiftLabel)} • Компании подряд, внутри компании — СЗ по убыванию</div>
      <table style="border-collapse:collapse;table-layout:fixed;width:100%;font-size:13px;">
        <thead><tr><th style="${HE_COMPANY_COL_STYLE}background:#f5f7fa;font-size:12px;">Компания</th><th style="${HE_NAME_COL_STYLE}background:#f5f7fa;font-size:12px;">Исполнитель</th>${thHours}<th style="${thTotalStyle}">Итого</th></tr></thead>
        <tbody>${trRows}</tbody>
      </table>
    </div>`;
}

/** Порог простоя по умолчанию для колонки «Простои» (мс). */
const IDLE_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Считает простои (паузы между операциями) по каждому сотруднику. items — операции с executor и completedAt.
 * Возвращает { [имя]: "10:30–10:45, 14:00–14:20" }.
 */
export function calcIdlesByEmployee(items, thresholdMs = IDLE_THRESHOLD_MS) {
  const byExecutor = new Map();
  for (const item of items) {
    const name = item.executor || '';
    if (!name) continue;
    const ts = item.completedAt;
    if (!ts) continue;
    if (!byExecutor.has(name)) byExecutor.set(name, []);
    byExecutor.get(name).push(new Date(ts).getTime());
  }
  const out = {};
  for (const [name, times] of byExecutor) {
    if (times.length < 2) continue;
    times.sort((a, b) => a - b);
    const idles = [];
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] >= thresholdMs) {
        idles.push(formatTime(new Date(times[i - 1]).toISOString()) + '–' + formatTime(new Date(times[i]).toISOString()));
      }
    }
    if (idles.length) out[name] = idles.join(', ');
  }
  return out;
}

/** Разбирает строку простоев вида "10:30–10:45, 14:00–14:20" в интервалы в минутах от начала смены (12 часов). */
function parseIdleIntervalsForTimeline(raw, shiftFilter = 'day') {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const str = String(raw);
  const parts = str.split(',').map(p => p.trim()).filter(Boolean);
  const out = [];
  const re = /(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/;
  const mapToShiftMinute = (h, m) => {
    if (shiftFilter === 'night') {
      // Ночь: 21–09. Ось 0–12ч: 0–3ч (21–24), 3–12ч (0–9).
      if (h >= 21 && h <= 23) {
        return (h - 21) * 60 + m;        // 21:00 → 0
      }
      if (h >= 0 && h < 9) {
        return 3 * 60 + h * 60 + m;      // 0:00 → 3:00, 8:59 → <12ч
      }
      return null;
    }
    // День: 9–21. Ось 0–12ч: 0–12ч (9–21).
    if (h < 9 || h >= 21) return null;
    return (h - 9) * 60 + m;            // 9:00 → 0
  };
  for (const part of parts) {
    const m = part.match(re);
    if (!m) continue;
    let h1 = Number(m[1]); let m1 = Number(m[2]);
    let h2 = Number(m[3]); let m2 = Number(m[4]);
    if (!Number.isFinite(h1) || !Number.isFinite(m1) || !Number.isFinite(h2) || !Number.isFinite(m2)) continue;
    h1 = Math.min(Math.max(h1, 0), 23);
    h2 = Math.min(Math.max(h2, 0), 23);
    m1 = Math.min(Math.max(m1, 0), 59);
    m2 = Math.min(Math.max(m2, 0), 59);
    const start = mapToShiftMinute(h1, m1);
    const end = mapToShiftMinute(h2, m2);
    if (start == null || end == null) continue;
    if (end <= start) continue;
    out.push({ start, end, label: part });
  }
  return out;
}

/** Строит HTML-таймлайн простоев (красные капсулы по оси 0–12 часов смены). */
function buildIdleTimelineHtml(raw, shiftFilter = 'day') {
  const intervals = parseIdleIntervalsForTimeline(raw, shiftFilter);
  if (!intervals.length) {
    return escHtml(raw || '—');
  }
  const totalMinutes = 12 * 60;
  const blocks = intervals.map(iv => {
    const left = Math.max(0, Math.min(100, (iv.start / totalMinutes) * 100));
    const width = Math.max(1, ((iv.end - iv.start) / totalMinutes) * 100);
    return `<div class="he-idle-block" style="left:${left}%;width:${width}%;" title="${escHtml(iv.label)}"></div>`;
  }).join('');
  return `<div class="he-idles-timeline">${blocks}</div>`;
}

/**
 * Рендерит таблицу «Сотрудник по часам». emplMap — для колонки «Компания». storageSupplement — опционально { storageByHour, totalStorageCount } для строки «Хранение».
 * showIdles, idlesByEmployee — при showIdles добавляется колонка «Простои >15 мин».
 */
export function renderHourlyByEmployee(items, shiftFilter = 'day', emplMap = null, storageSupplement = null, showIdles = false, idlesByEmployee = {}) {
  const container = el('hourly-employee-table-wrap');
  if (!container) return;

  const { hours, rows } = calcHourlyByEmployee(items, shiftFilter);

  const getCompany = (name) => (emplMap && name ? (getCompanyByFio(emplMap, normalizeFio(name)) || '—') : '—');
  const withCompany = rows.map(r => ({ ...r, company: getCompany(r.name) }));
  const weightByEmployee = storageSupplement?.weightByEmployee || {};
  const totalWeightGrams = storageSupplement?.totalWeightGrams || 0;
  withCompany.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return (b.company || '').localeCompare(a.company || '', 'ru');
  });

  if (!withCompany.length) {
    container.innerHTML = '<div class="empty-row" style="padding:20px;text-align:center;color:var(--text-muted)">Нет данных</div>';
    return;
  }

  const hourLabel = (col) => {
    const start = (col + 23) % 24;
    return `${String(start).padStart(2,'0')}–${String(col).padStart(2,'0')}`;
  };
  // Когда включены «Простои >15 мин», убираем почасовые колонки и оставляем только Итог.
  const thHours = showIdles ? '' : hours.map(col => `<th class="he-th-hour" title="${hourLabel(col)}">${String(col).padStart(2,'0')}</th>`).join('');
  const szCellClass = (v) => {
    if (v < 50) return 'he-sz-red';
    if (v <= 75) return 'he-sz-mid';
    return 'he-sz-white';
  };
  /** Граммы → тонны (÷1_000_000), 2 знака: 246743 г → 0.25 т */
  const formatTonnes = (grams) => (grams && grams > 0) ? (grams / 1e6).toFixed(2) : '';
  const weightForName = (name) => {
    if (!name || name === 'Хранение') return totalWeightGrams;
    const a = weightByEmployee[name];
    if (a != null) return a;
    const parts = String(name).split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return weightByEmployee[parts.slice().reverse().join(' ')] ?? 0;
    return 0;
  };

  // Ширина колонки «Простои» ≈ суммарная ширина всех часовых колонок (9–21).
  const idleWidthPx = showIdles ? Math.max(1, (hours.length || 1) * 60) : 0;
  const thIdles = showIdles
    ? `<th class="he-th-idles" style="width:${idleWidthPx}px;min-width:${idleWidthPx}px;" title="Паузы между задачами более 15 мин">Простои &gt;15 мин</th>`
    : '';
  const getIdlesCell = (name) => {
    if (!showIdles) return '';
    const raw = idlesByEmployee[name] || '';
    const timeline = buildIdleTimelineHtml(raw, shiftFilter);
    return `<td class="he-td-idles" style="width:${idleWidthPx}px;min-width:${idleWidthPx}px;">${timeline}</td>`;
  };

  const trRows = withCompany.map(r => {
    const cells = showIdles ? '' : hours.map(col => {
      const v = r.byHour[col] || 0;
      const cl = szCellClass(v);
      return `<td class="he-td-val ${cl}" title="${hourLabel(col)} — ${v} оп.">${v > 0 ? v : ''}</td>`;
    }).join('');
    const weightG = weightForName(r.name);
    const txCell = formatTonnes(weightG) ? `<td class="he-td-total" title="Вес собранный в хранении, т">${formatTonnes(weightG)}</td>` : '<td class="he-td-total"></td>';
    return `<tr>
      <td class="he-td-company">${escHtml(r.company)}</td>
      <td class="he-td-name">${escHtml(r.name)}</td>
      ${cells}
      <td class="he-td-total">${r.total}</td>
      ${thIdles ? getIdlesCell(r.name) : ''}
      ${txCell}
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="he-scroll-wrap">
      <table class="he-table">
        <thead>
          <tr>
            <th class="he-th-company">Компания</th>
            <th class="he-th-name">Сотрудник</th>
            ${thHours}
            <th class="he-th-total">Итого</th>
            ${thIdles}
            <th class="he-th-total" title="Вес собранный в хранении, т">Тх</th>
          </tr>
        </thead>
        <tbody>${trRows}</tbody>
      </table>
    </div>
  `;
}

/**
 * Рендер таблицы «Сотрудник по часам» из готовых данных (например из summary API).
 * rows: { name, company, byHour, total }[]
 * weightByEmployee, totalWeightGrams — для колонки Тх (вес в хранении, т).
 * showIdles, idlesByEmployee — при showIdles добавляется колонка «Простои >15 мин» (по оси 12 часов смены).
 */
export function renderHourlyByEmployeeFromSummary(hours = [], rows = [], weightByEmployee = {}, totalWeightGrams = 0, showIdles = false, idlesByEmployee = {}, shiftFilter = 'day') {
  const container = el('hourly-employee-table-wrap');
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = '<div class="empty-row" style="padding:20px;text-align:center;color:var(--text-muted)">Нет данных</div>';
    return;
  }
  const sorted = [...rows].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return (b.company || '').localeCompare(a.company || '', 'ru');
  });
  const hourLabel = (col) => {
    const start = (col + 23) % 24;
    return `${String(start).padStart(2,'0')}–${String(col).padStart(2,'0')}`;
  };
  // При включённых простоях показываем только Итог и колонку простоя, без почасовой сетки.
  const thHours = showIdles ? '' : hours.map(col => `<th class="he-th-hour" title="${hourLabel(col)}">${String(col).padStart(2,'0')}</th>`).join('');
  const szCellClass = (v) => {
    if (v < 50) return 'he-sz-red';
    if (v <= 75) return 'he-sz-mid';
    return 'he-sz-white';
  };
  /** Граммы → тонны (÷1_000_000), 2 знака: 246743 г → 0.25 т */
  const formatTonnes = (grams) => (grams && grams > 0) ? (grams / 1e6).toFixed(2) : '';
  const weightForName = (name) => {
    if (!name || name === 'Хранение') return totalWeightGrams;
    const a = weightByEmployee[name];
    if (a != null) return a;
    const parts = String(name).split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return weightByEmployee[parts.slice().reverse().join(' ')] ?? 0;
    return 0;
  };
  // Ширина колонки «Простои» ≈ суммарная ширина всех часовых колонок (9–21).
  const idleWidthPx = showIdles ? Math.max(1, (hours.length || 1) * 60) : 0;
  const thIdles = showIdles
    ? `<th class="he-th-idles" style="width:${idleWidthPx}px;min-width:${idleWidthPx}px;" title="Паузы между задачами более 15 мин">Простои &gt;15 мин</th>`
    : '';
  const getIdlesCell = (name) => {
    if (!showIdles) return '';
    const raw = idlesByEmployee[name] || '';
    const timeline = buildIdleTimelineHtml(raw, shiftFilter);
    return `<td class="he-td-idles" style="width:${idleWidthPx}px;min-width:${idleWidthPx}px;">${timeline}</td>`;
  };
  const trRows = sorted.map(r => {
    const cells = showIdles ? '' : hours.map(col => {
      const v = r.byHour && r.byHour[col] != null ? r.byHour[col] : 0;
      const cl = szCellClass(v);
      return `<td class="he-td-val ${cl}" title="${hourLabel(col)} — ${v} оп.">${v > 0 ? v : ''}</td>`;
    }).join('');
    const weightG = weightForName(r.name);
    const txCell = formatTonnes(weightG) ? `<td class="he-td-total" title="Вес собранный в хранении, т">${formatTonnes(weightG)}</td>` : '<td class="he-td-total"></td>';
    return `<tr>
      <td class="he-td-company">${escHtml(r.company || '—')}</td>
      <td class="he-td-name">${escHtml(r.name)}</td>
      ${cells}
      <td class="he-td-total">${r.total}</td>
      ${thIdles ? getIdlesCell(r.name) : ''}
      ${txCell}
    </tr>`;
  }).join('');
  container.innerHTML = `
    <div class="he-scroll-wrap">
      <table class="he-table">
        <thead>
          <tr>
            <th class="he-th-company">Компания</th>
            <th class="he-th-name">Сотрудник</th>
            ${thHours}
            <th class="he-th-total">Итого</th>
            ${thIdles}
            <th class="he-th-total" title="Вес собранный в хранении, т">Тх</th>
          </tr>
        </thead>
        <tbody>${trRows}</tbody>
      </table>
    </div>
  `;
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
