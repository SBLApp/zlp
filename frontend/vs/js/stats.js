/**
 * stats.js — подсчёт и отображение статистики по операциям
 */

import { el, normalizeFio, formatTime, hasMatchInEmplKeys, getCompanyByFio } from './utils.js';

export const ZONES = [
  { key: 'HH',  label: 'Хол. хранение', bg: '#1d4ed8', text: '#fff' },
  { key: 'KDH', label: 'КДК холод',       bg: '#93c5fd', text: '#1e3a5f' },
  { key: 'SH',  label: 'Сух. хранение',  bg: '#c2410c', text: '#fff' },
  { key: 'KDS', label: 'КДК сухой',       bg: '#fdba74', text: '#7c2d12' },
  { key: 'MH',  label: 'Хр. заморозка',  bg: '#6d28d9', text: '#fff' },
  { key: 'KDM', label: 'КДК заморозка',   bg: '#c4b5fd', text: '#3b0764' },
];

export function getZoneFromCell(cell) {
  const prefix = String(cell || '').split('-')[0].toUpperCase();
  return ZONES.find(z => z.key === prefix) || null;
}


function normalizeNameWeight(str) {
  return String(str || '').replace(/\u00a0|\u202f/g, ' ').trim();
}

function parseNumber(val) {
  const n = Number(String(val || '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function gramsFromUnit(value, unit) {
  const v = parseNumber(value);
  if (!v) return 0;
  const u = String(unit || '').toLowerCase();
  if (u === 'кг' || u === 'kg') return v * 1000;
  if (u === 'г' || u === 'g') return v;
  if (u === 'л' || u === 'l') return v * 1000;
  if (u === 'мл' || u === 'ml') return v;
  return 0;
}

function parseWeightGramsFromName(name) {
  const s = normalizeNameWeight(name);
  if (!s) return 0;
  const combo = s.match(/(\d+(?:[.,]\d+)?)\s*[xх×]\s*(\d+(?:[.,]\d+)?)\s*(кг|г|л|мл|kg|g|l|ml)/i);
  if (combo) {
    const count = parseNumber(combo[1]);
    const per = gramsFromUnit(combo[2], combo[3]);
    return count * per;
  }
  const simple = s.match(/(\d+(?:[.,]\d+)?)\s*(кг|г|л|мл|kg|g|l|ml)/i);
  if (simple) {
    return gramsFromUnit(simple[1], simple[2]);
  }
  return 0;
}

function formatWeight(grams) {
  const g = Number(grams) || 0;
  if (g <= 0) return '—';
  if (g >= 1_000_000) return `${(g / 1_000_000).toFixed(2)} т`;
  if (g >= 1_000) return `${(g / 1_000).toFixed(1)} кг`;
  return `${Math.round(g)} г`;
}

function addWeight(map, key, grams, isKdk) {
  if (!key || grams <= 0) return;
  const cur = map.get(key) || { storage: 0, kdk: 0, total: 0 };
  if (isKdk) cur.kdk += grams;
  else cur.storage += grams;
  cur.total = cur.storage + cur.kdk;
  map.set(key, cur);
}

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
  let totalWeightStorageGrams = 0;
  let totalWeightKdkGrams = 0;
  // missing: Map<key, {name, article}> — товары без веса
  // withWeight: Set<key> — товары с весом (для удаления из persistent списка)
  const missingWeightMap = new Map();
  const withWeightKeys = new Set();

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

    const name = item.productName || item.product || item.name;
    if (name) {
      const gramsPerUnit = parseWeightGramsFromName(name);
      const qty = Math.max(1, Number(item.quantity) || 1);
      const weight = gramsPerUnit * qty;
      const article = String(item.nomenclatureCode || item.article || '').trim();
      const key = article || String(name).trim();
      if (weight > 0) {
        if (isKdk) totalWeightKdkGrams += weight;
        else if (type === 'PIECE_SELECTION_PICKING') totalWeightStorageGrams += weight;
        withWeightKeys.add(key);
      } else {
        if (!missingWeightMap.has(key)) missingWeightMap.set(key, { name: String(name).trim(), article });
      }
    }
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

  return {
    totalOps,
    totalQty,
    executors,
    filteredCount: filtered.length,
    hourly,
    firstAt,
    lastAt,
    totalWeightStorageGrams,
    totalWeightKdkGrams,
    totalWeightGrams: totalWeightStorageGrams + totalWeightKdkGrams,
    missingWeightNames: Array.from(missingWeightMap.values()).map(v => v.name),
    missingWeightItems: Array.from(missingWeightMap.values()),
    withWeightKeys: Array.from(withWeightKeys),
    formatWeight,
  };
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

  const totalStorage = stats.storageOpsOverride != null
    ? stats.storageOpsOverride
    : (stats.hourly || []).reduce((s, h) => s + (h.storageOps || 0), 0);
  const formatW = stats.formatWeight || formatWeight;
  const weightStorage = formatW(stats.totalWeightStorageGrams || 0);
  const weightKdk = formatW(stats.totalWeightKdkGrams || 0);
  const weightTotal = formatW(stats.totalWeightGrams || 0);

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
      <div class="stat-icon">⚖️</div>
      <div class="stat-value">${weightStorage}</div>
      <div class="stat-label">Вес (хранение)</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">⚖️</div>
      <div class="stat-value">${weightKdk}</div>
      <div class="stat-label">Вес (КДК)</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">⚖️</div>
      <div class="stat-value">${weightTotal}</div>
      <div class="stat-label">Вес итог</div>
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

  const noteEl = el('stats-weight-note');
  if (noteEl) {
    if (stats.weightUnavailable) {
      noteEl.textContent = 'Вес доступен после загрузки полных данных.';
      return;
    }
    const list = Array.isArray(stats.missingWeightNames) ? stats.missingWeightNames : [];
    noteEl.textContent = `Не учтено в весе: ${list.length} (смена)`;
    // Подгружаем общий счётчик по всем сменам с бэкенда
    fetch('/api/missing-weight').then(r => r.json()).then(all => {
      if (noteEl && Array.isArray(all)) noteEl.textContent = `Не учтено в весе: ${list.length} (смена) · ${all.length} (всего)`;
    }).catch(() => {});
  }
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

  // byEmployee: name -> { hourMap: Map<col, { pieceSelectionCount, kdkSet, weightGrams }>, firstAt, lastAt }
  const byEmployee = new Map();

  for (const item of items) {
    const ts = item.completedAt;
    if (!ts) continue;
    const h = new Date(ts).getHours();
    // Колонка 10 = 09:00–10:00 (час 9), колонка 21 = 20:00–21:00 (час 20) → ключ col = конец интервала
    const col = (h + 1) % 24;
    const name = item.executor || 'Неизвестно';

    if (!byEmployee.has(name)) byEmployee.set(name, { hourMap: new Map(), firstAt: null, lastAt: null });
    const emp = byEmployee.get(name);
    if (!emp.firstAt || ts < emp.firstAt) emp.firstAt = ts;
    if (!emp.lastAt || ts > emp.lastAt) emp.lastAt = ts;
    const hourMap = emp.hourMap;

    if (!hourMap.has(col)) hourMap.set(col, { pieceSelectionCount: 0, kdkSet: new Set(), weightGrams: 0, zoneCounts: {}, zoneWeights: {} });
    const cell = hourMap.get(col);

    const type = (item.operationType || '').toUpperCase();
    if (type === 'PIECE_SELECTION_PICKING') {
      cell.pieceSelectionCount++;
    } else if (type === 'PICK_BY_LINE') {
      const productId = item.nomenclatureCode || item.productName || 'no-product';
      const targetCell = item.cell || 'no-target-cell';
      cell.kdkSet.add(`${productId}||${targetCell}`);
    }

    const isWeightOp = type === 'PIECE_SELECTION_PICKING' || type === 'PICK_BY_LINE';
    if (isWeightOp) {
      const zone = getZoneFromCell(item.cell);
      if (zone) cell.zoneCounts[zone.key] = (cell.zoneCounts[zone.key] || 0) + 1;
      const productName = item.productName || item.product || item.name;
      if (productName) {
        const gramsPerUnit = parseWeightGramsFromName(productName);
        if (gramsPerUnit > 0) {
          const qty = Math.max(1, Number(item.quantity) || 1);
          const grams = gramsPerUnit * qty;
          cell.weightGrams += grams;
          if (zone) cell.zoneWeights[zone.key] = (cell.zoneWeights[zone.key] || 0) + grams;
        }
      }
    }
  }

  const rows = [];
  for (const [name, emp] of byEmployee) {
    const { hourMap, firstAt, lastAt } = emp;
    const byHour = {};
    const weightByHour = {};
    const byHourZone = {};
    const byZone = {};
    let total = 0;
    for (const col of order) {
      const cell = hourMap.get(col);
      if (!cell) { byHour[col] = 0; weightByHour[col] = 0; byHourZone[col] = null; continue; }
      const sz = cell.pieceSelectionCount + (cell.kdkSet ? cell.kdkSet.size : 0);
      byHour[col] = sz;
      weightByHour[col] = cell.weightGrams;
      // доминирующая зона: взвешенный скор = 0.5×(count/total) + 0.5×(weight/total)
      {
        const totalCnt = Object.values(cell.zoneCounts).reduce((s, v) => s + v, 0);
        const totalWg = Object.values(cell.zoneWeights).reduce((s, v) => s + v, 0);
        const allZk = new Set([...Object.keys(cell.zoneCounts), ...Object.keys(cell.zoneWeights)]);
        let domKey = null, domScore = -1;
        for (const zk of allZk) {
          const scoreCnt = totalCnt > 0 ? (cell.zoneCounts[zk] || 0) / totalCnt : 0;
          const scoreWg  = totalWg  > 0 ? (cell.zoneWeights[zk] || 0) / totalWg  : 0;
          const score = totalWg > 0 ? (scoreCnt + scoreWg) / 2 : scoreCnt;
          if (score > domScore) { domScore = score; domKey = zk; }
        }
        byHourZone[col] = domKey;
      }
      // накапливаем по зонам
      for (const [zk, cnt] of Object.entries(cell.zoneCounts)) {
        if (!byZone[zk]) byZone[zk] = { count: 0, weightGrams: 0 };
        byZone[zk].count += cnt;
      }
      for (const [zk, wg] of Object.entries(cell.zoneWeights)) {
        if (!byZone[zk]) byZone[zk] = { count: 0, weightGrams: 0 };
        byZone[zk].weightGrams += wg;
      }
      total += sz;
    }
    rows.push({ name, byHour, weightByHour, byHourZone, byZone, total, firstAt, lastAt });
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
  const hours = getHoursPassedIncludingCurrent(selectedDate, shiftFilter);
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
  const hours = getHoursPassedIncludingCurrent(selectedDate, shiftFilter);
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
  const weightByCompany = new Map();
  const szByCompany = new Map(); // { storage: 0, kdk: 0 }
  for (const item of items || []) {
    const type = (item.operationType || '').toUpperCase();
    const isKdk = type === 'PICK_BY_LINE';
    if (!isKdk && type !== 'PIECE_SELECTION_PICKING') continue;
    const company = emplMap ? (getCompanyByFio(emplMap, normalizeFio(item.executor)) || '—') : '—';
    // считаем СЗ по типам
    if (!szByCompany.has(company)) szByCompany.set(company, { storage: 0, kdk: 0 });
    const szEntry = szByCompany.get(company);
    if (isKdk) szEntry.kdk += 1; else szEntry.storage += 1;
    // считаем вес
    const name = item.productName || item.product || item.name;
    if (!name) continue;
    const gramsPerUnit = parseWeightGramsFromName(name);
    if (gramsPerUnit <= 0) continue;
    const qty = Math.max(1, Number(item.quantity) || 1);
    const grams = gramsPerUnit * qty;
    addWeight(weightByCompany, company, grams, isKdk);
  }
  const rows = companiesOrder.map(c => {
    const companyRows = byCompany[c] || [];
    const employeesCount = companyRows.length;
    const totalTasks = companyRows.reduce((s, r) => s + r.total, 0);
    const szch = passedHours > 0 && employeesCount > 0 ? Math.round(totalTasks / employeesCount / passedHours) : 0;
    const byHour = {};
    for (const col of hoursDisplay) {
      byHour[col] = companyRows.reduce((s, r) => s + (r.byHour && r.byHour[col] ? r.byHour[col] : 0), 0);
    }
    const w = weightByCompany.get(c) || { storage: 0, kdk: 0, total: 0 };
    const sz = szByCompany.get(c) || { storage: 0, kdk: 0 };
    const vezch = passedHours > 0 && employeesCount > 0 ? Math.round(w.total / employeesCount / passedHours) : 0;
    const firstAtC = companyRows.reduce((min, r) => !r.firstAt ? min : (!min || r.firstAt < min ? r.firstAt : min), null);
    const lastAtC = companyRows.reduce((max, r) => !r.lastAt ? max : (!max || r.lastAt > max ? r.lastAt : max), null);
    return {
      companyName: c,
      employeesCount,
      szch,
      vezch,
      totalTasks,
      szStorage: sz.storage,
      szKdk: sz.kdk,
      byHour,
      weightStorageGrams: w.storage,
      weightKdkGrams: w.kdk,
      weightTotalGrams: w.total,
      firstAt: firstAtC,
      lastAt: lastAtC,
    };
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
      <td class="cs-td-num">${formatWeight(r.vezch || 0)}</td>
      ${thHours ? cellsHours : ''}
      <td class="cs-td-num">${r.totalTasks}</td>
      <td class="cs-td-num">${formatWeight(r.weightTotalGrams)}</td>
      <td class="cs-td-num">${r.szStorage ?? 0}</td>
      <td class="cs-td-num">${r.szKdk ?? 0}</td>
      <td class="cs-td-num">${formatWeight(r.weightStorageGrams)}</td>
      <td class="cs-td-num">${formatWeight(r.weightKdkGrams)}</td>
    </tr>
  `;
  }).join('');
  container.innerHTML = `
    <table class="company-summary-table">
      <thead>
        <tr>
          <th class="cs-th-company">Компания</th>
          <th class="cs-th-num">Сотрудников</th>
          <th class="cs-th-num">СЗ/Ч</th>
          <th class="cs-th-num">ВЕС/Ч</th>
          ${thHours}
          <th class="cs-th-num">Итог</th>
          <th class="cs-th-num">Вес итог</th>
          <th class="cs-th-num" title="СЗ в хранении (PIECE_SELECTION_PICKING)">СЗ хранение</th>
          <th class="cs-th-num" title="СЗ в КДК (PICK_BY_LINE)">СЗ КДК</th>
          <th class="cs-th-num">Вес хранение</th>
          <th class="cs-th-num">Вес КДК</th>
        </tr>
      </thead>
      <tbody>${trRows}</tbody>
    </table>
    <div class="company-summary-formulas">
      <div class="cs-formula-row">
        <span class="cs-formula-label">СЗ/Ч — среднее задач в час на сотрудника:</span>
        <span class="cs-formula-text">Итог ÷ Сотрудников ÷ прошедших часов</span>
      </div>
      <div class="cs-formula-row">
        <span class="cs-formula-label">ВЕС/Ч — средний вес в час на сотрудника:</span>
        <span class="cs-formula-text">Вес итог ÷ Сотрудников ÷ прошедших часов</span>
      </div>
      ${showHours ? '<div class="cs-formula-row"><span class="cs-formula-label">Колонки по часам — сумма выполненных задач за каждый час (прошедшие + текущий). Итог — СЗ за все часы у компании.</span></div>' : ''}
    </div>
  `;
}

/** Легенда цветовой схемы для таблицы по часам. */
function buildHeLegendHtml(mode) {
  if (mode === 'sz') {
    return `<div class="he-legend">
      <span class="he-legend-item"><span class="he-legend-swatch" style="background:#fecaca;"></span>&lt;50 задач/ч</span>
      <span class="he-legend-item"><span class="he-legend-swatch" style="background:linear-gradient(135deg,#fecaca,#fef08a);"></span>50–75 задач/ч</span>
      <span class="he-legend-item"><span class="he-legend-swatch" style="background:#fff;border:1px solid #e5e7eb;"></span>&gt;75 задач/ч</span>
    </div>`;
  }
  if (mode === 'hourly') {
    return `<div class="he-legend">${ZONES.map(z =>
      `<span class="he-legend-item"><span class="he-legend-swatch" style="background:${z.bg};"></span><span style="color:${z.text === '#fff' ? 'var(--text)' : z.text}">${z.label}</span></span>`
    ).join('')}</div>`;
  }
  return '';
}

/** Стиль первой колонки (ФИО у левого края) — инлайн, чтобы html2canvas не терял при рендере */
const HE_NAME_COL_STYLE = 'width:200px;min-width:200px;max-width:200px;text-align:left;padding:6px 8px;border:1px solid #DDE2EA;background:#fff;font-weight:500;box-sizing:border-box;';

// ─── Общие стили для Telegram-скриншотов ─────────────────────────────────────
const TG_FONT     = 'Inter,Segoe UI,Arial,sans-serif';
const TG_BORDER   = '1px solid #e2e8f0';
const TG_HDR_BG   = '#1e3a5f';
const TG_HDR_BG2  = '#2d5186';
const TG_TOTAL_BG  = '#eef2ff';
const TG_WORKED_BG = '#f0fdf4';
const TG_ODD_BG   = '#ffffff';
const TG_EVEN_BG  = '#f8fafc';

function tgHourCell(v, wg, style = '') {
  const base = `width:50px;padding:4px 5px;border:${TG_BORDER};text-align:center;line-height:1.3;font-size:12px;box-sizing:border-box;${style}`;
  if (!v) return `<td style="${base}"></td>`;
  const wgHtml = wg > 0
    ? `<div style="font-size:9px;opacity:.7;border-top:1px solid currentColor;margin-top:2px;padding-top:1px;">${formatWeight(wg)}</div>`
    : '';
  return `<td style="${base}"><b>${v}</b>${wgHtml}</td>`;
}

function tgTotalCell(total, totalWg) {
  const wgHtml = totalWg > 0
    ? `<div style="font-size:9px;font-weight:400;border-top:1px solid #c7d2fe;margin-top:2px;padding-top:1px;">${formatWeight(totalWg)}</div>`
    : '';
  return `<td style="width:58px;padding:4px 6px;border:${TG_BORDER};text-align:center;font-weight:700;line-height:1.3;font-size:13px;background:${TG_TOTAL_BG};box-sizing:border-box;">${total}${wgHtml}</td>`;
}

function tgStartPeakCell(firstAt, lastAt) {
  const start = firstAt ? formatTime(firstAt) : '—';
  const peak  = lastAt  ? formatTime(lastAt)  : '—';
  return `<td style="width:54px;padding:4px 5px;border:${TG_BORDER};text-align:center;line-height:1.3;font-size:12px;box-sizing:border-box;"><b>${start}</b><div style="font-size:10px;opacity:.65;border-top:1px solid #e2e8f0;margin-top:2px;padding-top:1px;">${peak}</div></td>`;
}

function tgWorkedCell(worked) {
  return `<td style="width:58px;padding:4px 6px;border:${TG_BORDER};text-align:center;font-size:12px;background:${TG_WORKED_BG};box-sizing:border-box;">${worked > 0 ? formatMinutesToHours(worked) : '—'}</td>`;
}

function szBg(v) {
  if (v < 50) return 'background:#fecaca;color:#7f1d1d;';
  if (v <= 75) return 'background:#fef3c7;color:#78350f;';
  return 'background:#dcfce7;color:#14532d;';
}

function hourlyBg(zoneKey) {
  const zone = zoneKey ? ZONES.find(z => z.key === zoneKey) : null;
  return zone ? `background:${zone.bg};color:${zone.text};` : 'background:#f3f4f6;color:#374151;';
}

function tgLegendHtml(mode) {
  if (mode === 'sz') {
    return `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px;align-items:center;">
      <span style="font-size:10px;color:#94a3b8;margin-right:2px;">Цвета:</span>
      <span style="background:#fecaca;color:#7f1d1d;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;">&lt;50 зад/ч</span>
      <span style="background:#fef3c7;color:#78350f;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;">50–75 зад/ч</span>
      <span style="background:#dcfce7;color:#14532d;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;">&gt;75 зад/ч</span>
    </div>`;
  }
  return `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px;align-items:center;">
    <span style="font-size:10px;color:#94a3b8;margin-right:2px;">Зоны:</span>
    ${ZONES.map(z => `<span style="background:${z.bg};color:${z.text};padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;">${z.label}</span>`).join('')}
  </div>`;
}

function tgCardHtml(title, meta, legendHtml, tableHtml) {
  return `<div class="he-telegram-wrap" style="font-family:${TG_FONT};background:#f1f5f9;padding:12px;border-radius:0;display:inline-block;min-width:400px;">
    <div style="background:linear-gradient(135deg,${TG_HDR_BG} 0%,${TG_HDR_BG2} 100%);border-radius:10px 10px 0 0;padding:12px 16px;">
      <div style="font-size:17px;font-weight:700;color:#fff;letter-spacing:-0.2px;">${title}</div>
      <div style="font-size:11px;color:#93c5fd;margin-top:3px;">${meta}</div>
    </div>
    <div style="background:#fff;border-radius:0 0 10px 10px;padding:10px 12px 12px;box-shadow:0 2px 8px rgba(0,0,0,.06);">
      ${legendHtml}
      ${tableHtml}
    </div>
  </div>`;
}

/**
 * HTML таблицы «Сотрудники по часам» для скриншота Telegram (по одной компании).
 */
export function buildHourlyTableHtmlForCompany(companyName, rows, hours, dateStr, shiftLabel, mode = 'sz', idlesByEmployee = {}, allowedIdleMinutes = 0, shiftMinutes = 12 * 60) {
  const modeLabel = mode === 'hourly' ? 'По часам' : 'По СЗ';
  const hourPad   = (col) => String(col).padStart(2, '0');
  const hourTitle = (col) => `${String((col + 23) % 24).padStart(2,'0')}–${hourPad(col)}`;
  const thStyle   = `padding:5px 4px;border:${TG_BORDER};background:${TG_HDR_BG2};color:#fff;font-size:11px;text-align:center;font-weight:600;white-space:nowrap;`;
  const thHours   = hours.map(col =>
    `<th style="width:50px;${thStyle}" title="${hourTitle(col)}">${hourPad(col)}</th>`
  ).join('');

  const trRows = rows.map((r, i) => {
    const rowBg  = i % 2 === 0 ? TG_ODD_BG : TG_EVEN_BG;
    const nameTd = `<td style="width:200px;min-width:200px;padding:5px 8px;border:${TG_BORDER};background:${rowBg};font-size:12px;font-weight:500;">${escHtml(r.name)}</td>`;
    const cells  = hours.map(col => {
      const v  = r.byHour?.[col] || 0;
      const wg = r.weightByHour?.[col] || 0;
      const bg = v > 0 ? (mode === 'hourly' ? hourlyBg(r.byHourZone?.[col]) : szBg(v)) : `background:${rowBg};`;
      return tgHourCell(v, wg, bg);
    }).join('');
    const totalWg = Object.values(r.weightByHour || {}).reduce((s, v) => s + (v || 0), 0);
    const raw     = idlesByEmployee[r.name] || {};
    const idleMin = typeof raw === 'object' ? (Number(raw.totalMinutes) || 0) : 0;
    const worked  = computeWorkedMinutesInShift(idleMin, Number(allowedIdleMinutes) || 0, shiftMinutes);
    return `<tr>${nameTd}${cells}${tgTotalCell(r.total, totalWg)}${tgWorkedCell(worked)}${tgStartPeakCell(r.firstAt, r.lastAt)}</tr>`;
  }).join('');

  const tableHtml = `<table style="border-collapse:collapse;table-layout:fixed;font-size:12px;">
    <thead><tr>
      <th style="width:200px;${thStyle}text-align:left;padding-left:8px;">Исполнитель</th>
      ${thHours}
      <th style="width:58px;${thStyle}background:#3730a3;">Итого</th>
      <th style="width:58px;${thStyle}background:#166534;">В работе</th>
      <th style="width:54px;${thStyle}">Старт<div style="font-size:9px;font-weight:400;border-top:1px solid #93c5fd;margin-top:1px;">Пик</div></th>
    </tr></thead>
    <tbody>${trRows}</tbody>
  </table>`;

  return tgCardHtml(escHtml(companyName), `${escHtml(dateStr)} · ${escHtml(shiftLabel)} · ${modeLabel}`, tgLegendHtml(mode), tableHtml);
}

const HE_COMPANY_COL_STYLE = 'width:180px;min-width:180px;max-width:180px;text-align:left;padding:6px 8px;border:1px solid #DDE2EA;background:#fff;font-size:12px;box-sizing:border-box;';

/**
 * HTML таблицы «Весь список по часам» со всеми сотрудниками (для скриншота в Telegram).
 */
export function buildHourlyTableHtmlFullList(rows, hours, dateStr, shiftLabel, mode = 'sz', idlesByEmployee = {}, allowedIdleMinutes = 0, shiftMinutes = 12 * 60) {
  const modeLabel = mode === 'hourly' ? 'По часам' : 'По СЗ';
  const hourPad   = (col) => String(col).padStart(2, '0');
  const hourTitle = (col) => `${String((col + 23) % 24).padStart(2,'0')}–${hourPad(col)}`;
  const thStyle   = `padding:5px 4px;border:${TG_BORDER};background:${TG_HDR_BG2};color:#fff;font-size:11px;text-align:center;font-weight:600;white-space:nowrap;`;
  const thHours   = hours.map(col =>
    `<th style="width:50px;${thStyle}" title="${hourTitle(col)}">${hourPad(col)}</th>`
  ).join('');

  const companyColors  = new Map();
  const COMPANY_PALETTES = ['#eff6ff','#f0fdf4','#fdf4ff','#fff7ed','#f0f9ff','#fefce8'];
  let paletteIdx = 0;
  const getCompanyBg = (company) => {
    if (!companyColors.has(company)) {
      companyColors.set(company, COMPANY_PALETTES[paletteIdx % COMPANY_PALETTES.length]);
      paletteIdx++;
    }
    return companyColors.get(company);
  };

  const trRows = rows.map(r => {
    const compBg = getCompanyBg(r.company || '—');
    const compTd = `<td style="width:160px;min-width:160px;padding:5px 8px;border:${TG_BORDER};background:${compBg};font-size:11px;color:#475569;">${escHtml(r.company || '—')}</td>`;
    const nameTd = `<td style="width:200px;min-width:200px;padding:5px 8px;border:${TG_BORDER};background:${compBg};font-size:12px;font-weight:500;">${escHtml(r.name)}</td>`;
    const cells  = hours.map(col => {
      const v  = r.byHour?.[col] || 0;
      const wg = r.weightByHour?.[col] || 0;
      const bg = v > 0 ? (mode === 'hourly' ? hourlyBg(r.byHourZone?.[col]) : szBg(v)) : `background:${compBg};`;
      return tgHourCell(v, wg, bg);
    }).join('');
    const totalWg = Object.values(r.weightByHour || {}).reduce((s, v) => s + (v || 0), 0);
    const raw     = idlesByEmployee[r.name] || {};
    const idleMin = typeof raw === 'object' ? (Number(raw.totalMinutes) || 0) : 0;
    const worked  = computeWorkedMinutesInShift(idleMin, Number(allowedIdleMinutes) || 0, shiftMinutes);
    return `<tr>${compTd}${nameTd}${cells}${tgTotalCell(r.total, totalWg)}${tgWorkedCell(worked)}${tgStartPeakCell(r.firstAt, r.lastAt)}</tr>`;
  }).join('');

  const tableHtml = `<table style="border-collapse:collapse;table-layout:fixed;font-size:12px;">
    <thead><tr>
      <th style="width:160px;${thStyle}text-align:left;padding-left:8px;">Компания</th>
      <th style="width:200px;${thStyle}text-align:left;padding-left:8px;">Исполнитель</th>
      ${thHours}
      <th style="width:58px;${thStyle}background:#3730a3;">Итого</th>
      <th style="width:58px;${thStyle}background:#166534;">В работе</th>
      <th style="width:54px;${thStyle}">Старт<div style="font-size:9px;font-weight:400;border-top:1px solid #93c5fd;margin-top:1px;">Пик</div></th>
    </tr></thead>
    <tbody>${trRows}</tbody>
  </table>`;

  return tgCardHtml(`Весь список · ${modeLabel}`, `${escHtml(dateStr)} · ${escHtml(shiftLabel)}`, tgLegendHtml(mode), tableHtml);
}

/** HTML таблицы «Вес по зонам» для скриншота в Telegram. */
export function buildWeightByZoneTableHtml(rows, dateStr, shiftLabel) {
  if (!rows.length) return '';
  const sorted = [...rows].sort((a, b) => {
    const wa = ZONES.reduce((s, z) => s + ((a.byZone?.[z.key]?.weightGrams) || 0), 0);
    const wb = ZONES.reduce((s, z) => s + ((b.byZone?.[z.key]?.weightGrams) || 0), 0);
    return wb - wa;
  });
  const thZones = ZONES.map(z =>
    `<th style="padding:6px 8px;border:1px solid #DDE2EA;background:${z.bg};color:${z.text};font-size:12px;text-align:center;">${z.label}</th>`
  ).join('');
  const trRows = sorted.map(r => {
    const totalGrams = ZONES.reduce((s, z) => s + ((r.byZone?.[z.key]?.weightGrams) || 0), 0);
    const cells = ZONES.map(z => {
      const wg = r.byZone?.[z.key]?.weightGrams || 0;
      const style = wg > 0 ? `background:${z.bg}22;` : '';
      return `<td style="padding:6px 8px;border:1px solid #DDE2EA;text-align:center;${style}">${wg > 0 ? formatWeight(wg) : '—'}</td>`;
    }).join('');
    return `<tr>
      <td style="${HE_COMPANY_COL_STYLE}">${escHtml(r.company || '—')}</td>
      <td style="${HE_NAME_COL_STYLE}">${escHtml(r.name)}</td>
      ${cells}
      <td style="padding:6px 8px;border:1px solid #DDE2EA;text-align:center;font-weight:600;">${formatWeight(totalGrams)}</td>
    </tr>`;
  }).join('');
  return `
    <div class="he-telegram-wrap" style="padding:12px;background:#fff;font-family:Inter,sans-serif;">
      <div class="he-telegram-title" style="font-size:16px;font-weight:700;margin-bottom:4px;">Вес по зонам</div>
      <div class="he-telegram-meta" style="font-size:12px;color:#6b7280;margin-bottom:10px;">${escHtml(dateStr)} • ${escHtml(shiftLabel)}</div>
      <table style="border-collapse:collapse;table-layout:fixed;width:100%;font-size:13px;">
        <thead><tr>
          <th style="${HE_COMPANY_COL_STYLE}background:#f5f7fa;font-size:12px;">Компания</th>
          <th style="${HE_NAME_COL_STYLE}background:#f5f7fa;font-size:12px;">Сотрудник</th>
          ${thZones}
          <th style="padding:6px 8px;border:1px solid #DDE2EA;background:#f5f7fa;font-size:12px;text-align:center;">Итого</th>
        </tr></thead>
        <tbody>${trRows}</tbody>
      </table>
    </div>`;
}

/** Порог простоя по умолчанию для колонки «Простои» (мс). */
let IDLE_THRESHOLD_MS = 15 * 60 * 1000;

/** Установить порог простоя (мс). */
export function setIdleThresholdMs(ms) {
  const n = Number(ms);
  if (Number.isFinite(n) && n >= 0) IDLE_THRESHOLD_MS = Math.floor(n);
}

/** Получить текущий порог простоя (мс). */
export function getIdleThresholdMs() {
  return IDLE_THRESHOLD_MS;
}

/**
 * Возвращает границы смены в мс (UTC). Day: 09:00–21:00 МСК, Night: 21:00 пред. дня – 09:00 МСК.
 * useNowAsEnd: для живых данных endMs = Date.now().
 */
export function getShiftBoundaryMs(dateStr, shiftFilter, useNowAsEnd = false) {
  if (!dateStr) return { startMs: 0, endMs: 0 };
  const [y, m, d] = dateStr.split('-').map(Number);
  if (shiftFilter === 'day') {
    return {
      startMs: Date.UTC(y, m - 1, d, 6, 0, 0),   // 09:00 МСК = 06:00 UTC
      endMs: useNowAsEnd ? Date.now() : Date.UTC(y, m - 1, d, 18, 0, 0),  // 21:00 МСК = 18:00 UTC
    };
  }
  return {
    startMs: Date.UTC(y, m - 1, d - 1, 18, 0, 0),  // 21:00 МСК пред. дня = 18:00 UTC
    endMs: useNowAsEnd ? Date.now() : Date.UTC(y, m - 1, d, 6, 0, 0),    // 09:00 МСК = 06:00 UTC
  };
}

/**
 * Считает простои по каждому сотруднику: паузы между операциями, а также до первой и после последней.
 * shiftStartMs/shiftEndMs — границы смены в мс; 0 = не учитывать.
 * Возвращает { [имя]: "10:30–10:45, 14:00–14:20" }.
 */
export function calcIdlesByEmployee(items, thresholdMs = IDLE_THRESHOLD_MS, shiftStartMs = 0, shiftEndMs = 0) {
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
    if (!times.length) continue;
    times.sort((a, b) => a - b);
    const idles = [];
    if (shiftStartMs > 0 && times[0] - shiftStartMs >= thresholdMs) {
      idles.push(formatTime(new Date(shiftStartMs).toISOString()) + '–' + formatTime(new Date(times[0]).toISOString()));
    }
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] >= thresholdMs) {
        idles.push(formatTime(new Date(times[i - 1]).toISOString()) + '–' + formatTime(new Date(times[i]).toISOString()));
      }
    }
    if (shiftEndMs > 0 && shiftEndMs - times[times.length - 1] >= thresholdMs) {
      idles.push(formatTime(new Date(times[times.length - 1]).toISOString()) + '–' + formatTime(new Date(shiftEndMs).toISOString()));
    }
    if (idles.length) out[name] = idles.join(', ');
  }
  return out;
}

/**
 * Возвращает промежутки простоев и суммарное время простоя в минутах/мс по каждому сотруднику.
 * Возвращаемая структура: { name: { intervals: '10:30–10:45, ...', totalMinutes: 15, totalMs: 900000 } }
 */
export function calcIdleTotalsByEmployee(items, thresholdMs = IDLE_THRESHOLD_MS, shiftFilter = 'day', shiftStartMs = 0, shiftEndMs = 0) {
  const idlesMap = calcIdlesByEmployee(items, thresholdMs, shiftStartMs, shiftEndMs);
  const out = {};
  for (const [name, raw] of Object.entries(idlesMap)) {
    const intervals = parseIdleIntervalsForTimeline(raw, shiftFilter);
    let totalMinutes = 0;
    for (const iv of intervals) {
      if (iv && typeof iv.start === 'number' && typeof iv.end === 'number') {
        totalMinutes += Math.max(0, iv.end - iv.start);
      }
    }
    out[name] = { intervals: raw, totalMinutes, totalMs: totalMinutes * 60 * 1000 };
  }
  return out;
}

/** Сумма простоев (мин) из строки интервалов "10:30–10:45, ...". */
function calcIdleTotalMinutesFromRaw(raw, shiftFilter = 'day') {
  const intervals = parseIdleIntervalsForTimeline(raw, shiftFilter);
  let totalMinutes = 0;
  for (const iv of intervals) {
    if (iv && typeof iv.start === 'number' && typeof iv.end === 'number') {
      totalMinutes += Math.max(0, iv.end - iv.start);
    }
  }
  return totalMinutes;
}

/** Привести объект простоев к массиву строк для таблицы. */
export function buildIdleRowsFromMap(idlesByEmployee = {}, emplMap = null, shiftFilter = 'day') {
  const rows = [];
  for (const [name, raw] of Object.entries(idlesByEmployee || {})) {
    if (!name) continue;
    let intervals = '';
    let totalMinutes = 0;
    if (raw && typeof raw === 'object' && raw.intervals !== undefined) {
      intervals = String(raw.intervals || '');
      totalMinutes = Number(raw.totalMinutes) || 0;
      if (!totalMinutes && intervals) totalMinutes = calcIdleTotalMinutesFromRaw(intervals, shiftFilter);
    } else {
      intervals = String(raw || '');
      totalMinutes = intervals ? calcIdleTotalMinutesFromRaw(intervals, shiftFilter) : 0;
    }
    const company = emplMap && name ? (getCompanyByFio(emplMap, normalizeFio(name)) || '—') : '—';
    rows.push({ name, company, intervals, totalMinutes });
  }
  rows.sort((a, b) => (b.totalMinutes - a.totalMinutes) || a.name.localeCompare(b.name, 'ru'));
  return rows;
}

/** HTML таблицы простоев (для скриншота в Telegram). */
export function buildIdleTableHtml(rows = [], dateStr, shiftLabel, thresholdMinutes = 15, allowedIdleMinutes = 0, titleText = 'Простои') {
  const safeDate = dateStr || '—';
  const safeShift = shiftLabel || '—';
  const thStyle = 'padding:6px 8px;border:1px solid #DDE2EA;background:#f5f7fa;font-size:12px;text-align:left;';
  const tdStyle = 'padding:6px 8px;border:1px solid #E5E7EB;font-size:12px;vertical-align:top;';
  const totalStyle = 'padding:6px 8px;border:1px solid #E5E7EB;font-size:12px;text-align:right;font-weight:600;white-space:nowrap;';
  const headerNote = `Порог: ${Math.max(0, Number(thresholdMinutes) || 0)} мин` + (allowedIdleMinutes ? ` · Доп. простоя: ${Math.max(0, Number(allowedIdleMinutes) || 0)} мин` : '');
  const bodyRows = rows.length
    ? rows.map(r => `
        <tr>
          <td style="${tdStyle}">${escHtml(r.company || '—')}</td>
          <td style="${tdStyle}">${escHtml(r.name || '—')}</td>
          <td style="${tdStyle}">${escHtml(r.intervals || '—')}</td>
          <td style="${totalStyle}">${formatMinutesToHours(r.totalMinutes || 0)}</td>
        </tr>`).join('')
    : `<tr><td colspan="4" style="${tdStyle}text-align:center;color:#6b7280;">Нет данных</td></tr>`;

  return `
    <div class="he-telegram-wrap" style="padding:12px;background:#fff;font-family:Inter,sans-serif;">
      <div class="he-telegram-title" style="font-size:16px;font-weight:700;margin-bottom:4px;">${escHtml(titleText || 'Простои')}</div>
      <div class="he-telegram-meta" style="font-size:12px;color:#6b7280;margin-bottom:6px;">${escHtml(safeDate)} • ${escHtml(safeShift)}</div>
      <div class="he-telegram-meta" style="font-size:12px;color:#6b7280;margin-bottom:10px;">${escHtml(headerNote)}</div>
      <table style="border-collapse:collapse;table-layout:fixed;width:100%;font-size:12px;">
        <thead>
          <tr>
            <th style="${thStyle}width:180px;">Компания</th>
            <th style="${thStyle}width:220px;">Сотрудник</th>
            <th style="${thStyle}">Интервалы простоев</th>
            <th style="${thStyle}width:110px;text-align:right;">Итого</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;
}

/**
 * Вычисляет количество минут, отработанных в смене по времени.
 * shiftMinutes по умолчанию 12 часов = 720 минут.
 * Логика: effectiveIdle = max(0, totalIdleMinutes - allowedIdleMinutes);
 * workedMinutes = max(0, shiftMinutes - effectiveIdle).
 */
export function computeWorkedMinutesInShift(totalIdleMinutes, allowedIdleMinutes = 0, shiftMinutes = 12 * 60) {
  const t = Math.max(0, Number(totalIdleMinutes) || 0);
  const a = Math.max(0, Number(allowedIdleMinutes) || 0);
  const effectiveIdle = Math.max(0, t - a);
  return Math.max(0, shiftMinutes - effectiveIdle);
}

/**
 * Возвращает количество минут, прошедших с начала текущей смены (по московскому времени UTC+3).
 * День: 9:00–21:00, Ночь: 21:00–9:00. Возвращает значение от 0 до 720.
 */
export function getElapsedShiftMinutes(shiftFilter = 'day') {
  const nowMsk = new Date(Date.now() + 3 * 3600 * 1000);
  const totalMin = nowMsk.getUTCHours() * 60 + nowMsk.getUTCMinutes();
  if (shiftFilter === 'day') {
    return Math.max(0, Math.min(720, totalMin - 9 * 60));
  } else {
    const start = 21 * 60;
    const elapsed = totalMin >= start ? totalMin - start : (24 * 60 - start) + totalMin;
    return Math.max(0, Math.min(720, elapsed));
  }
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
import { formatMinutesToHours } from './utils.js';

export function renderHourlyByEmployee(items, shiftFilter = 'day', emplMap = null, showIdles = false, idlesByEmployee = {}, allowedIdleMinutes = 0, mode = 'hourly', shiftMinutes = 12 * 60, thresholdMinutes = 15) {
  const container = el('hourly-employee-table-wrap');
  if (!container) return;

  const { hours, rows } = calcHourlyByEmployee(items, shiftFilter);

  const getCompany = (name) => (emplMap && name ? (getCompanyByFio(emplMap, normalizeFio(name)) || '—') : '—');
  const withCompany = rows.map(r => ({ ...r, company: getCompany(r.name) }));
  const weightByEmployee = new Map();
  for (const item of items || []) {
    const type = (item.operationType || '').toUpperCase();
    const isKdk = type === 'PICK_BY_LINE';
    if (!isKdk && type !== 'PIECE_SELECTION_PICKING') continue;
    const name = item.productName || item.product || item.name;
    if (!name) continue;
    const gramsPerUnit = parseWeightGramsFromName(name);
    if (gramsPerUnit <= 0) continue;
    const qty = Math.max(1, Number(item.quantity) || 1);
    const grams = gramsPerUnit * qty;
    const empName = item.executor || item.executorId || 'Неизвестно';
    addWeight(weightByEmployee, empName, grams, isKdk);
  }
  withCompany.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return (b.company || '').localeCompare(a.company || '', 'ru');
  });

  if (!withCompany.length) {
    container.innerHTML = '<div class="empty-row" style="padding:20px;text-align:center;color:var(--text-muted)">Нет данных</div>';
    return;
  }

  if (mode === 'zones') {
    renderWeightByZoneInto(container, withCompany);
    return;
  }

  const hourLabel = (col) => {
    const start = (col + 23) % 24;
    return `${String(start).padStart(2,'0')}–${String(col).padStart(2,'0')}`;
  };
  // Когда включены «Простои >15 мин», убираем почасовые колонки и оставляем только Итог.
  const thHours = showIdles ? '' : hours.map(col => `<th class="he-th-hour" title="${hourLabel(col)}">${String(col).padStart(2,'0')}</th>`).join('');
  const szCellStyle = (v) => {
    if (v < 50) return 'background:#fecaca;color:#1d1d1b;';
    if (v <= 75) return 'background:linear-gradient(135deg,#fecaca 0%,#fef08a 100%);color:#1d1d1b;';
    return 'background:#fff;color:#1d1d1b;';
  };
  const weightForName = (name) => {
    if (!name) return { storage: 0, kdk: 0, total: 0 };
    const a = weightByEmployee.get(name);
    if (a) return a;
    const parts = String(name).split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return weightByEmployee.get(parts.slice().reverse().join(' ')) || { storage: 0, kdk: 0, total: 0 };
    return { storage: 0, kdk: 0, total: 0 };
  };

  // Ширина колонки «Простои» ≈ суммарная ширина всех часовых колонок (9–21).
  const idleWidthPx = showIdles ? Math.max(1, (hours.length || 1) * 60) : 0;
  const thIdles = showIdles
    ? `<th class="he-th-idles" style="width:${idleWidthPx}px;min-width:${idleWidthPx}px;" title="Паузы между задачами более ${thresholdMinutes} мин">Простои &gt;${thresholdMinutes} мин</th>`
    : '';
  const getIdlesCell = (name) => {
    if (!showIdles) return '';
    const raw = idlesByEmployee[name] || '';
    // idlesByEmployee can be either raw string ("HH:MM–HH:MM, ...") or an object { intervals, totalMinutes, totalMs }
    let intervalsRaw = '';
    let totalMinutes = 0;
    if (raw && typeof raw === 'object' && raw.intervals !== undefined) {
      intervalsRaw = raw.intervals || '';
      totalMinutes = Number(raw.totalMinutes) || 0;
    } else {
      intervalsRaw = String(raw || '');
      // try to parse intervals to compute totalMinutes
      const parsed = parseIdleIntervalsForTimeline(intervalsRaw, shiftFilter);
      for (const iv of parsed) if (iv && typeof iv.start === 'number' && typeof iv.end === 'number') totalMinutes += Math.max(0, iv.end - iv.start);
    }
    const timeline = buildIdleTimelineHtml(intervalsRaw, shiftFilter);
    const workedMinutes = computeWorkedMinutesInShift(totalMinutes, Number(allowedIdleMinutes) || 0, shiftMinutes);
    const totalsHtml = `<div style="margin-top:6px;font-size:12px;color:var(--text-muted)">Простои: ${formatMinutesToHours(totalMinutes)} · Отработано: ${formatMinutesToHours(workedMinutes)}</div>`;
    return `<td class="he-td-idles" style="width:${idleWidthPx}px;min-width:${idleWidthPx}px;">${timeline}${totalsHtml}</td>`;
  };

  const trRows = withCompany.map(r => {
    const cells = showIdles ? '' : hours.map(col => {
      const v = r.byHour[col] || 0;
      const wg = (r.weightByHour && r.weightByHour[col]) || 0;
      let style, title;
      if (mode === 'sz') {
        style = v > 0 ? szCellStyle(v) : '';
        title = `${hourLabel(col)} — ${v} оп.`;
      } else {
        const domZoneKey = r.byHourZone && r.byHourZone[col];
        const zone = domZoneKey ? ZONES.find(z => z.key === domZoneKey) : null;
        style = zone ? `background:${zone.bg};color:${zone.text};` : (v > 0 ? 'background:#f3f4f6;' : '');
        title = `${hourLabel(col)} — ${v} оп.${zone ? ' · ' + zone.label : ''}`;
      }
      const label = v > 0 ? (wg > 0 ? `<span class="he-cell-sz">${v}</span><span class="he-cell-weight">${formatWeight(wg)}</span>` : `${v}`) : '';
      return `<td class="he-td-val" style="${style}" title="${title}">${label}</td>`;
    }).join('');
    const w = weightForName(r.name);
    const raw = idlesByEmployee[r.name] || {};
    const idleMin = typeof raw === 'object' ? (Number(raw.totalMinutes) || 0) : 0;
    const workedMin = computeWorkedMinutesInShift(idleMin, Number(allowedIdleMinutes) || 0, shiftMinutes);
    const workedCell = `<td class="he-td-total" title="Время в работе (смена − простои)">${workedMin > 0 ? formatMinutesToHours(workedMin) : '—'}</td>`;
    return `<tr>
      <td class="he-td-company">${escHtml(r.company)}</td>
      <td class="he-td-name">${escHtml(r.name)}</td>
      ${cells}
      <td class="he-td-total">${r.total}</td>
      ${workedCell}
      ${thIdles ? getIdlesCell(r.name) : ''}
      <td class="he-td-total" title="Первая / последняя операция">${r.firstAt ? formatTime(r.firstAt) : '—'}<div style="font-size:10px;opacity:.75;border-top:1px solid currentColor;margin-top:1px;">${r.lastAt ? formatTime(r.lastAt) : '—'}</div></td>
      <td class="he-td-total" title="Вес в хранении">${formatWeight(w.storage)}</td>
      <td class="he-td-total" title="Вес в КДК">${formatWeight(w.kdk)}</td>
      <td class="he-td-total" title="Вес итог">${formatWeight(w.total)}</td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    ${buildHeLegendHtml(mode)}
    <div class="he-scroll-wrap">
      <table class="he-table">
        <thead>
          <tr>
            <th class="he-th-company">Компания</th>
            <th class="he-th-name">Сотрудник</th>
            ${thHours}
            <th class="he-th-total">Итого</th>
            <th class="he-th-total" title="Время в работе (смена − простои)">В работе</th>
            ${thIdles}
            <th class="he-th-total" title="Первая / последняя операция">Старт<div style="font-size:10px;font-weight:400;border-top:1px solid currentColor;margin-top:1px;">Пик</div></th>
            <th class="he-th-total" title="Вес в хранении">Вес ХР</th>
            <th class="he-th-total" title="Вес в КДК">Вес КДК</th>
            <th class="he-th-total" title="Вес итог">Вес итог</th>
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
 * weightByEmployee, totalWeightGrams — вес хранение (если есть), для отчёта без полной загрузки.
 * showIdles, idlesByEmployee — при showIdles добавляется колонка «Простои >15 мин» (по оси 12 часов смены).
 */
export function renderHourlyByEmployeeFromSummary(hours = [], rows = [], weightByEmployee = {}, totalWeightGrams = 0, showIdles = false, idlesByEmployee = {}, allowedIdleMinutes = 0, shiftFilter = 'day', mode = 'hourly', shiftMinutes = 12 * 60, thresholdMinutes = 15) {
  const container = el('hourly-employee-table-wrap');
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = '<div class="empty-row" style="padding:20px;text-align:center;color:var(--text-muted)">Нет данных</div>';
    return;
  }
  if (mode === 'zones') {
    const withCompany = rows.map(r => ({
      ...r,
      company: r.company || '—',
    }));
    renderWeightByZoneInto(container, withCompany);
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
  const szCellStyle = (v) => {
    if (v < 50) return 'background:#fecaca;color:#1d1d1b;';
    if (v <= 75) return 'background:linear-gradient(135deg,#fecaca 0%,#fef08a 100%);color:#1d1d1b;';
    return 'background:#fff;color:#1d1d1b;';
  };
  const weightForName = (name) => {
    if (!name || name === 'Хранение') return { storage: totalWeightGrams || 0, kdk: 0, total: totalWeightGrams || 0 };
    const a = weightByEmployee[name];
    if (a != null) {
      if (typeof a === 'object') {
        const storage = Number(a.storage) || 0;
        const kdk = Number(a.kdk) || 0;
        return { storage, kdk, total: storage + kdk };
      }
      const v = Number(a) || 0;
      return { storage: v, kdk: 0, total: v };
    }
    const parts = String(name).split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const v = weightByEmployee[parts.slice().reverse().join(' ')] ?? 0;
      if (typeof v === 'object') {
        const storage = Number(v.storage) || 0;
        const kdk = Number(v.kdk) || 0;
        return { storage, kdk, total: storage + kdk };
      }
      const n = Number(v) || 0;
      return { storage: n, kdk: 0, total: n };
    }
    return { storage: 0, kdk: 0, total: 0 };
  };
  // Ширина колонки «Простои» ≈ суммарная ширина всех часовых колонок (9–21).
  const idleWidthPx = showIdles ? Math.max(1, (hours.length || 1) * 60) : 0;
  const thIdles = showIdles
    ? `<th class="he-th-idles" style="width:${idleWidthPx}px;min-width:${idleWidthPx}px;" title="Паузы между задачами более ${thresholdMinutes} мин">Простои &gt;${thresholdMinutes} мин</th>`
    : '';
  const getIdlesCell = (name) => {
    if (!showIdles) return '';
    const raw = idlesByEmployee[name] || '';
    let intervalsRaw = '';
    let totalMinutes = 0;
    if (raw && typeof raw === 'object' && raw.intervals !== undefined) {
      intervalsRaw = raw.intervals || '';
      totalMinutes = Number(raw.totalMinutes) || 0;
    } else {
      intervalsRaw = String(raw || '');
      const parsed = parseIdleIntervalsForTimeline(intervalsRaw, shiftFilter);
      for (const iv of parsed) if (iv && typeof iv.start === 'number' && typeof iv.end === 'number') totalMinutes += Math.max(0, iv.end - iv.start);
    }
    const timeline = buildIdleTimelineHtml(intervalsRaw, shiftFilter);
    const workedMinutes = computeWorkedMinutesInShift(totalMinutes, Number(allowedIdleMinutes) || 0, shiftMinutes);
    const totalsHtml = `<div style="margin-top:6px;font-size:12px;color:var(--text-muted)">Простои: ${formatMinutesToHours(totalMinutes)} · Отработано: ${formatMinutesToHours(workedMinutes)}</div>`;
    return `<td class="he-td-idles" style="width:${idleWidthPx}px;min-width:${idleWidthPx}px;">${timeline}${totalsHtml}</td>`;
  };
  const trRows = sorted.map(r => {
    const cells = showIdles ? '' : hours.map(col => {
      const v = r.byHour && r.byHour[col] != null ? r.byHour[col] : 0;
      const wg = (r.weightByHour && r.weightByHour[col]) || 0;
      let style, title;
      if (mode === 'sz') {
        style = v > 0 ? szCellStyle(v) : '';
        title = `${hourLabel(col)} — ${v} оп.`;
      } else {
        const domZoneKey = r.byHourZone && r.byHourZone[col];
        const zone = domZoneKey ? ZONES.find(z => z.key === domZoneKey) : null;
        style = zone ? `background:${zone.bg};color:${zone.text};` : (v > 0 ? 'background:#f3f4f6;' : '');
        title = `${hourLabel(col)} — ${v} оп.${zone ? ' · ' + zone.label : ''}`;
      }
      const label = v > 0 ? (wg > 0 ? `<span class="he-cell-sz">${v}</span><span class="he-cell-weight">${formatWeight(wg)}</span>` : `${v}`) : '';
      return `<td class="he-td-val" style="${style}" title="${title}">${label}</td>`;
    }).join('');
    const w = weightForName(r.name);
    const raw = idlesByEmployee[r.name] || {};
    const idleMin = typeof raw === 'object' ? (Number(raw.totalMinutes) || 0) : 0;
    const workedMin = computeWorkedMinutesInShift(idleMin, Number(allowedIdleMinutes) || 0, shiftMinutes);
    const workedCell = `<td class="he-td-total" title="Время в работе (смена − простои)">${workedMin > 0 ? formatMinutesToHours(workedMin) : '—'}</td>`;
    return `<tr>
      <td class="he-td-company">${escHtml(r.company || '—')}</td>
      <td class="he-td-name">${escHtml(r.name)}</td>
      ${cells}
      <td class="he-td-total">${r.total}</td>
      ${workedCell}
      ${thIdles ? getIdlesCell(r.name) : ''}
      <td class="he-td-total" title="Первая / последняя операция">${r.firstAt ? formatTime(r.firstAt) : '—'}<div style="font-size:10px;opacity:.75;border-top:1px solid currentColor;margin-top:1px;">${r.lastAt ? formatTime(r.lastAt) : '—'}</div></td>
      <td class="he-td-total" title="Вес в хранении">${formatWeight(w.storage)}</td>
      <td class="he-td-total" title="Вес в КДК">${formatWeight(w.kdk)}</td>
      <td class="he-td-total" title="Вес итог">${formatWeight(w.total)}</td>
    </tr>`;
  }).join('');
  container.innerHTML = `
    ${buildHeLegendHtml(mode)}
    <div class="he-scroll-wrap">
      <table class="he-table">
        <thead>
          <tr>
            <th class="he-th-company">Компания</th>
            <th class="he-th-name">Сотрудник</th>
            ${thHours}
            <th class="he-th-total">Итого</th>
            <th class="he-th-total" title="Время в работе (смена − простои)">В работе</th>
            ${thIdles}
            <th class="he-th-total" title="Первая / последняя операция">Старт<div style="font-size:10px;font-weight:400;border-top:1px solid currentColor;margin-top:1px;">Пик</div></th>
            <th class="he-th-total" title="Вес в хранении">Вес ХР</th>
            <th class="he-th-total" title="Вес в КДК">Вес КДК</th>
            <th class="he-th-total" title="Вес итог">Вес итог</th>
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

/** Рендер таблицы «Вес по зонам» в контейнер. rows — от calcHourlyByEmployee или buildSummaryFromItems. */
function renderWeightByZoneInto(container, rows) {
  if (!rows.length) {
    container.innerHTML = '<div class="empty-row" style="padding:20px;text-align:center;color:var(--text-muted)">Нет данных</div>';
    return;
  }
  const sorted = [...rows].sort((a, b) => {
    const wa = ZONES.reduce((s, z) => s + ((a.byZone?.[z.key]?.weightGrams) || 0), 0);
    const wb = ZONES.reduce((s, z) => s + ((b.byZone?.[z.key]?.weightGrams) || 0), 0);
    return wb - wa;
  });
  const thZones = ZONES.map(z =>
    `<th class="zw-th" style="background:${z.bg};color:${z.text};" title="${z.label}">${z.label}</th>`
  ).join('');
  const trRows = sorted.map(r => {
    const totalGrams = ZONES.reduce((s, z) => s + ((r.byZone?.[z.key]?.weightGrams) || 0), 0);
    const cells = ZONES.map(z => {
      const wg = r.byZone?.[z.key]?.weightGrams || 0;
      return wg > 0
        ? `<td class="zw-td" style="background:${z.bg}22;">${formatWeight(wg)}</td>`
        : `<td class="zw-td">—</td>`;
    }).join('');
    return `<tr>
      <td class="he-td-company">${escHtml(r.company || '—')}</td>
      <td class="he-td-name">${escHtml(r.name)}</td>
      ${cells}
      <td class="zw-td zw-td-total">${formatWeight(totalGrams)}</td>
    </tr>`;
  }).join('');
  container.innerHTML = `
    <div class="he-scroll-wrap">
      <table class="he-table">
        <thead>
          <tr>
            <th class="he-th-company">Компания</th>
            <th class="he-th-name">Сотрудник</th>
            ${thZones}
            <th class="zw-th zw-th-total">Итого</th>
          </tr>
        </thead>
        <tbody>${trRows}</tbody>
      </table>
    </div>`;
}
