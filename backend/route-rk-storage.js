/**
 * route-rk-storage.js — учёт отгрузки/приёмки РК по маршрутам
 *
 * Структура data/route-rk.json:
 * {
 *   "routeId": {
 *     "routeId": "uuid",
 *     "routeNumber": "20260321-1",
 *     "date": "2026-03-21",
 *     "driver": { "name": "Иванов И.И.", "phone": "..." },
 *     "vehicle": { "number": "А001АА78", "model": "Газель" },
 *     "logisticsCompany": "...",
 *     "cfzAddresses": [{ "address": "...", "storeId": "uuid" }],
 *     "importedAt": "ISO",
 *
 *     "shipment": null | {
 *       "by": "Фамилия И.О.",           // кладовщик
 *       "gate": "3",                    // ворота
 *       "at": "ISO",
 *       "photos": ["/rk-photos/x.jpg"],
 *       "items": [{ "address": "...", "rk": 5 }]
 *     },
 *     "receiving": null | {
 *       "by": "Фамилия И.О.",
 *       "gate": "2",
 *       "at": "ISO",
 *       "photos": ["/rk-photos/x.jpg"],
 *       "items": [{ "address": "...", "rk": 4 }]
 *     }
 *   }
 * }
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, 'data');
const RK_PATH   = path.join(DATA_DIR, 'route-rk.json');
const PHOTO_DIR = path.join(DATA_DIR, 'rk-photos');

function load() {
  try {
    if (!fs.existsSync(RK_PATH)) return {};
    return JSON.parse(fs.readFileSync(RK_PATH, 'utf-8'));
  } catch { return {}; }
}

function save(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RK_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function ensurePhotoDir() {
  if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });
}

// ─── WMS импорт ───────────────────────────────────────────────────────────────

function parseWmsRoute(json) {
  const route = json?.value ?? json;
  if (!route || !Array.isArray(route.stores)) throw new Error('Неверный формат маршрута');

  const date = (route.completedRouteDate || route.plannedRouteDate || '').slice(0, 10);
  const driver = route.vehicleDriver
    ? {
        name: [route.vehicleDriver.lastName, route.vehicleDriver.firstName].filter(Boolean).join(' '),
        phone: route.vehicleDriver.phone || '',
      }
    : null;
  const vehicle = route.vehicle
    ? { number: route.vehicle.number || '', model: route.vehicle.model || '' }
    : null;
  const logisticsCompany = route.logisticsCompany?.name || null;
  const cfzAddresses = (route.stores || [])
    .map(s => ({ address: String(s.address || '').trim(), storeId: s.id || null }))
    .filter(s => s.address);

  return { routeId: route.id || null, routeNumber: route.routeNumber || null, date, driver, vehicle, logisticsCompany, cfzAddresses };
}

function importRoute(json) {
  const parsed = parseWmsRoute(json);
  if (!parsed.routeId) throw new Error('Маршрут без ID');
  const data = load();
  const existing = data[parsed.routeId];
  if (existing) {
    data[parsed.routeId] = { ...existing, ...parsed, shipment: existing.shipment, receiving: existing.receiving };
    save(data);
    return { added: 0, updated: 1 };
  }
  data[parsed.routeId] = { ...parsed, importedAt: new Date().toISOString(), shipment: null, receiving: null };
  save(data);
  return { added: 1, updated: 0 };
}

function importBulk(routeJsons) {
  const data = load();
  let added = 0, updated = 0;
  for (const json of routeJsons) {
    try {
      const parsed = parseWmsRoute(json);
      if (!parsed.routeId) continue;
      const existing = data[parsed.routeId];
      if (existing) {
        data[parsed.routeId] = { ...existing, ...parsed, shipment: existing.shipment, receiving: existing.receiving };
        updated++;
      } else {
        data[parsed.routeId] = { ...parsed, importedAt: new Date().toISOString(), shipment: null, receiving: null };
        added++;
      }
    } catch { /* пропускаем */ }
  }
  save(data);
  return { added, updated };
}

// ─── Отгрузка / Приёмка ───────────────────────────────────────────────────────

/**
 * Записать отгрузку по маршруту.
 * items: [{ address, rk }]
 * photos: массив имён файлов (уже сохранённых через savePhoto)
 */
function submitShipment(routeId, { by, gate, items, photos }) {
  const data = load();
  if (!data[routeId]) throw new Error('Маршрут не найден');
  data[routeId].shipment = {
    by: by || null,
    gate: gate || null,
    at: new Date().toISOString(),
    confirmed: false,
    confirmedAt: null,
    photos: photos || [],
    items: (items || []).map(i => ({ address: String(i.address), rk: Number(i.rk) })),
  };
  save(data);
  return withTotals(data[routeId]);
}

/**
 * Записать приёмку (возврат РК) по маршруту.
 */
function submitReceiving(routeId, { by, gate, items, photos }) {
  const data = load();
  if (!data[routeId]) throw new Error('Маршрут не найден');
  data[routeId].receiving = {
    by: by || null,
    gate: gate || null,
    at: new Date().toISOString(),
    confirmed: false,
    confirmedAt: null,
    photos: photos || [],
    items: (items || []).map(i => ({ address: String(i.address), rk: Number(i.rk) })),
  };
  save(data);
  return withTotals(data[routeId]);
}

// ─── Вычисляемые поля ─────────────────────────────────────────────────────────

function shippedTotal(route) {
  return (route.shipment?.items || []).reduce((s, i) => s + (i.rk || 0), 0);
}
function receivedTotal(route) {
  return (route.receiving?.items || []).reduce((s, i) => s + (i.rk || 0), 0);
}
function calcDiff(route) {
  if (!route.shipment || !route.receiving) return null;
  return receivedTotal(route) - shippedTotal(route);
}

// Маршрут считается не до конца отгруженным, если хотя бы один адрес ЦФЗ не имеет записи в items
function isPartialShipment(route) {
  if (!route.shipment) return true;
  const shipped = new Set((route.shipment.items || []).map(i => i.address));
  return (route.cfzAddresses || []).some(a => !shipped.has(a.address));
}

function isPartialReceiving(route) {
  if (!route.receiving) return true;
  const received = new Set((route.receiving.items || []).map(i => i.address));
  return (route.cfzAddresses || []).some(a => !received.has(a.address));
}

function withTotals(route) {
  const shipped  = route.shipment  ? shippedTotal(route)  : null;
  const received = route.receiving ? receivedTotal(route) : null;
  return {
    ...route,
    shippedRK:  shipped,
    receivedRK: received,
    shippedAt:  route.shipment?.at  || null,
    receivedAt: route.receiving?.at || null,
    diff: calcDiff(route),
  };
}

// ─── Запросы ──────────────────────────────────────────────────────────────────

function getRoutes({ q, dateFrom, dateTo, status } = {}) {
  const data = load();
  let routes = Object.values(data).map(withTotals);

  if (status === 'unshipped') routes = routes.filter(r => isPartialShipment(r));
  else if (status === 'pending') routes = routes.filter(r => !isPartialShipment(r) && isPartialReceiving(r));
  else if (status === 'done')    routes = routes.filter(r => !isPartialShipment(r) && !isPartialReceiving(r));

  if (dateFrom) routes = routes.filter(r => r.date >= dateFrom);
  if (dateTo)   routes = routes.filter(r => r.date <= dateTo);

  if (q) {
    const ql = q.toLowerCase();
    routes = routes.filter(r =>
      (r.routeNumber || '').toLowerCase().includes(ql) ||
      (r.driver?.name || '').toLowerCase().includes(ql) ||
      (r.vehicle?.number || '').toLowerCase().includes(ql) ||
      (r.cfzAddresses || []).some(a => a.address.toLowerCase().includes(ql))
    );
  }

  return routes.sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') || (b.routeNumber || '').localeCompare(a.routeNumber || '')
  );
}

function getByDriver({ q } = {}) {
  const data = load();
  const map = new Map();

  for (const raw of Object.values(data)) {
    const route = withTotals(raw);
    const name  = route.driver?.name || 'Неизвестно';
    if (q && !name.toLowerCase().includes(q.toLowerCase())) continue;

    if (!map.has(name)) {
      map.set(name, { name, phone: route.driver?.phone || '', routeCount: 0, shippedTotal: 0, receivedTotal: 0, routes: [] });
    }
    const d = map.get(name);
    d.routeCount++;
    if (route.shippedRK  != null) d.shippedTotal  += route.shippedRK;
    if (route.receivedRK != null) d.receivedTotal += route.receivedRK;
    d.routes.push({
      routeId: route.routeId, routeNumber: route.routeNumber, date: route.date,
      vehicle: route.vehicle, cfzAddresses: route.cfzAddresses || [],
      shippedRK: route.shippedRK, receivedRK: route.receivedRK, diff: route.diff,
      shippedAt: route.shippedAt, receivedAt: route.receivedAt,
    });
  }

  return Array.from(map.values())
    .map(d => ({
      ...d,
      diff: d.shippedTotal > 0 || d.receivedTotal > 0 ? d.receivedTotal - d.shippedTotal : null,
      routes: d.routes.sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function getByCfz({ q } = {}) {
  const data = load();
  const map = new Map();

  for (const raw of Object.values(data)) {
    const route = withTotals(raw);
    for (const { address, storeId } of route.cfzAddresses || []) {
      if (!address) continue;
      if (q && !address.toLowerCase().includes(q.toLowerCase())) continue;

      if (!map.has(address)) {
        map.set(address, { address, storeId, routeCount: 0, shippedTotal: 0, receivedTotal: 0, routes: [] });
      }
      const c = map.get(address);
      c.routeCount++;

      // Per-CFZ shipped/received from items
      const shippedItem  = route.shipment?.items?.find(i => i.address === address);
      const receivedItem = route.receiving?.items?.find(i => i.address === address);
      const cfzShipped  = shippedItem?.rk  ?? null;
      const cfzReceived = receivedItem?.rk ?? null;

      if (cfzShipped  != null) c.shippedTotal  += cfzShipped;
      if (cfzReceived != null) c.receivedTotal += cfzReceived;
      c.routes.push({
        routeId: route.routeId, routeNumber: route.routeNumber, date: route.date,
        driver: route.driver, vehicle: route.vehicle,
        shippedRK: cfzShipped, receivedRK: cfzReceived,
        shippedAt: route.shipment?.at  || null,
        receivedAt: route.receiving?.at || null,
        diff: cfzShipped != null && cfzReceived != null ? cfzReceived - cfzShipped : null,
      });
    }
  }

  return Array.from(map.values())
    .map(c => ({
      ...c,
      diff: c.shippedTotal > 0 || c.receivedTotal > 0 ? c.receivedTotal - c.shippedTotal : null,
      routes: c.routes.sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    }))
    .sort((a, b) => a.address.localeCompare(b.address, 'ru'));
}

function getDriversWithPending(q) {
  const data = load();
  const ql = String(q || '').trim().toLowerCase();
  const map = new Map();
  for (const raw of Object.values(data)) {
    if (isPartialShipment(raw) || !isPartialReceiving(raw) || !raw.cfzAddresses?.length) continue;
    const name = raw.driver?.name || 'Неизвестно';
    if (ql && !name.toLowerCase().includes(ql)) continue;
    if (!map.has(name)) map.set(name, { name, routeCount: 0, latestDate: raw.date });
    const d = map.get(name);
    d.routeCount++;
    if ((raw.date || '') > (d.latestDate || '')) d.latestDate = raw.date;
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function getDriversUnshipped(q) {
  const data = load();
  const ql = String(q || '').trim().toLowerCase();
  const map = new Map();
  for (const raw of Object.values(data)) {
    if (!isPartialShipment(raw) || !raw.cfzAddresses?.length) continue;
    const name = raw.driver?.name || 'Неизвестно';
    if (ql && !name.toLowerCase().includes(ql)) continue;
    if (!map.has(name)) map.set(name, { name, routeCount: 0, latestDate: raw.date });
    const d = map.get(name);
    d.routeCount++;
    if ((raw.date || '') > (d.latestDate || '')) d.latestDate = raw.date;
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function getRoutesByDriverUnshipped(driverName) {
  const data = load();
  const name = String(driverName || '').trim();
  return Object.values(data)
    .filter(r => isPartialShipment(r) && r.driver?.name === name && r.cfzAddresses?.length)
    .map(withTotals)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function getRoutesByDriverPending(driverName) {
  const data = load();
  const name = String(driverName || '').trim();
  return Object.values(data)
    .filter(r => r.driver?.name === name)
    .map(withTotals)
    .filter(r => !isPartialShipment(r) && isPartialReceiving(r))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function getRouteById(routeId) {
  const data = load();
  return data[routeId] ? withTotals(data[routeId]) : null;
}

// ─── Редактирование ───────────────────────────────────────────────────────────

function updateShipment(routeId, { by, gate, items, photos }) {
  const data = load();
  if (!data[routeId]) throw new Error('Маршрут не найден');
  // Если позиции не переданы или пусты — удаляем отгрузку
  if (!items || items.length === 0) {
    data[routeId].shipment = null;
    save(data);
    return withTotals(data[routeId]);
  }
  const ex = data[routeId].shipment;
  data[routeId].shipment = {
    by: by || ex?.by || null,
    gate: gate || ex?.gate || null,
    at: ex?.at || new Date().toISOString(),
    confirmed: ex?.confirmed || false,
    confirmedAt: ex?.confirmedAt || null,
    updatedAt: new Date().toISOString(),
    photos: photos != null ? photos : (ex?.photos || []),
    items: items.map(i => ({ address: String(i.address), rk: Number(i.rk) })),
  };
  save(data);
  return withTotals(data[routeId]);
}

function updateReceiving(routeId, { by, gate, items, photos }) {
  const data = load();
  if (!data[routeId]) throw new Error('Маршрут не найден');
  // Если позиции не переданы или пусты — удаляем приёмку
  if (!items || items.length === 0) {
    data[routeId].receiving = null;
    save(data);
    return withTotals(data[routeId]);
  }
  const ex = data[routeId].receiving;
  data[routeId].receiving = {
    by: by || ex?.by || null,
    gate: gate || ex?.gate || null,
    at: ex?.at || new Date().toISOString(),
    confirmed: ex?.confirmed || false,
    confirmedAt: ex?.confirmedAt || null,
    updatedAt: new Date().toISOString(),
    photos: photos != null ? photos : (ex?.photos || []),
    items: items.map(i => ({ address: String(i.address), rk: Number(i.rk) })),
  };
  save(data);
  return withTotals(data[routeId]);
}

// ─── Подтверждение ────────────────────────────────────────────────────────────

function confirmShipment(routeId, confirmedBy) {
  const data = load();
  if (!data[routeId]) throw new Error('Маршрут не найден');
  if (!data[routeId].shipment) throw new Error('Нет данных об отгрузке');
  data[routeId].shipment.confirmed = true;
  data[routeId].shipment.confirmedAt = new Date().toISOString();
  data[routeId].shipment.confirmedBy = confirmedBy || null;
  save(data);
  return withTotals(data[routeId]);
}

function confirmReceiving(routeId, confirmedBy) {
  const data = load();
  if (!data[routeId]) throw new Error('Маршрут не найден');
  if (!data[routeId].receiving) throw new Error('Нет данных о приёмке');
  data[routeId].receiving.confirmed = true;
  data[routeId].receiving.confirmedAt = new Date().toISOString();
  data[routeId].receiving.confirmedBy = confirmedBy || null;
  save(data);
  return withTotals(data[routeId]);
}

// ─── Фото ─────────────────────────────────────────────────────────────────────

function savePhoto(filename, buffer) {
  ensurePhotoDir();
  const filePath = path.join(PHOTO_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  return `/rk-photos/${filename}`;
}

function getPhotoPath(filename) {
  return path.join(PHOTO_DIR, filename);
}

// ─── Список всех уникальных ЦФЗ-адресов ──────────────────────────────────────

function getAddresses() {
  const data = load();
  const set = new Set();
  for (const route of Object.values(data)) {
    for (const a of (route.cfzAddresses || [])) {
      if (a.address) set.add(a.address);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
}

// ─── Данные для Excel-отчёта ─────────────────────────────────────────────────

function getReportData(dateFrom, dateTo) {
  const data = load();
  // address -> shipDate -> { shipped }
  // address -> recvDate -> { received }
  // Отгрузка и приёмка могут быть в разные дни, поэтому храним раздельно
  // итоговая структура: address -> date -> { shipped, received }
  const map = new Map(); // address -> date -> { shipped: 0, received: null }

  function ensureCell(addr, date) {
    if (!map.has(addr)) map.set(addr, new Map());
    const dm = map.get(addr);
    if (!dm.has(date)) dm.set(date, { shipped: 0, received: null });
    return dm.get(date);
  }

  for (const route of Object.values(data)) {
    if (route.shipment) {
      const shipDate = (route.shipment.at || route.date || '').slice(0, 10);
      if (shipDate >= dateFrom && shipDate <= dateTo) {
        for (const item of (route.shipment.items || [])) {
          ensureCell(item.address, shipDate).shipped += item.rk;
        }
      }
    }

    if (route.receiving) {
      const recvDate = (route.receiving.at || route.date || '').slice(0, 10);
      if (recvDate >= dateFrom && recvDate <= dateTo) {
        for (const item of (route.receiving.items || [])) {
          const cell = ensureCell(item.address, recvDate);
          cell.received = (cell.received || 0) + item.rk;
        }
      }
    }
  }

  return [...map.entries()]
    .map(([address, dm]) => ({
      address,
      records: [...dm.entries()]
        .filter(([, v]) => v.shipped > 0 || v.received != null)
        .map(([date, v]) => ({ date, shipped: v.shipped, received: v.received }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .filter(e => e.records.length > 0)
    .sort((a, b) => String(a.address).localeCompare(String(b.address), 'ru'));
}

// ─── Удаление маршрутов за период ────────────────────────────────────────────

function deleteRoutesByDateRange(dateFrom, dateTo) {
  if (!dateFrom || !dateTo) throw new Error('Укажите период');
  const data = load();
  let deleted = 0;
  for (const [id, route] of Object.entries(data)) {
    const d = (route.date || '').slice(0, 10);
    if (d >= dateFrom && d <= dateTo) {
      delete data[id];
      deleted++;
    }
  }
  save(data);
  return deleted;
}

module.exports = {
  importRoute, importBulk,
  submitShipment, submitReceiving,
  updateShipment, updateReceiving,
  confirmShipment, confirmReceiving,
  getRoutes, getByDriver, getByCfz,
  getDriversWithPending, getRoutesByDriverPending, getRouteById,
  getDriversUnshipped, getRoutesByDriverUnshipped,
  savePhoto, getPhotoPath, PHOTO_DIR,
  deleteRoutesByDateRange, getReportData, getAddresses,
};
