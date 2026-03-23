/**
 * shipments.js — UI вкладки "Отгрузка"
 * Единая форма: кладовщик → тип (отгрузка/приёмка) → маршрут → ворота + РК по ЦФЗ + фото
 */

import * as api from './api.js';
import * as auth from './auth.js';

// ─── Состояние ────────────────────────────────────────────────────────────────

let activeView = 'routes';
let routesData  = [];
let driversData = [];
let cfzData     = [];

const expandedRoutes  = new Set();
const expandedDrivers = new Set();
const expandedCfz     = new Set();

// Сортировка таблиц водителей и ЦФЗ
// key: 'routeCount'|'shippedTotal'|'receivedTotal'|'diff', dir: 'asc'|'desc'|null
let driverSort = { key: null, dir: null };
let cfzSort    = { key: null, dir: null };

// Сортировка детальных подтаблиц (по ключу раскрытой строки)
const driverDetailSort = new Map(); // name -> { key, dir }
const cfzDetailSort    = new Map(); // address -> { key, dir }

function toggleSort(state, key) {
  if (state.key === key) {
    state.dir = state.dir === 'desc' ? 'asc' : state.dir === 'asc' ? null : 'desc';
    if (state.dir === null) state.key = null;
  } else {
    state.key = key;
    state.dir = 'desc';
  }
}

function sortedData(data, state) {
  if (!state.key || !state.dir) return data;
  return [...data].sort((a, b) => {
    const av = a[state.key] ?? (state.key === 'diff' ? 0 : 0);
    const bv = b[state.key] ?? (state.key === 'diff' ? 0 : 0);
    return state.dir === 'desc' ? bv - av : av - bv;
  });
}

function sortArrow(state, key) {
  if (state.key !== key) return '<span class="sh-sort-arrow sh-sort-none">⇅</span>';
  return state.dir === 'desc'
    ? '<span class="sh-sort-arrow sh-sort-active">↓</span>'
    : '<span class="sh-sort-arrow sh-sort-active">↑</span>';
}

let routesSearchTimer  = null;
let driversSearchTimer = null;
let cfzSearchTimer     = null;

// ─── Выбор строк ──────────────────────────────────────────────────────────────

const selectedRoutes = new Set();

// ─── Пагинация маршрутов ──────────────────────────────────────────────────────
let routesPage = 1;
const ROUTES_PER_PAGE = 50;

// ─── Единая форма (отгрузка / приёмка) ───────────────────────────────────────

let formStep           = 1;        // 1..4
let formMode           = 'create'; // 'create' | 'edit'
let formType           = null;     // 'ship' | 'receive'
let formWorker         = '';       // ФИО кладовщика
let formRoute          = null;     // выбранный маршрут
let formRoutesList     = [];       // список маршрутов для поиска
let formPhotos         = [];       // File[] (новые) — для режима create
let formPhotoUrls      = [];       // URL[] после upload
let formExistingPhotos = [];       // существующие URL фото — для режима create
// Состояние объединённого редактирования (режим edit)
let formEditShip = null; // { by, gate, existingPhotos, newPhotos }
let formEditRecv = null; // { by, gate, existingPhotos, newPhotos }

// ─── Инициализация ────────────────────────────────────────────────────────────

export function initShipments() {
  document.querySelectorAll('.sh-subtab').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.tab));
  });

  setupSearch('sh-routes-search',  q => loadRoutes(q),  t => { routesSearchTimer  = t; }, () => routesSearchTimer);
  setupSearch('sh-drivers-search', q => loadDrivers(q), t => { driversSearchTimer = t; }, () => driversSearchTimer);
  setupSearch('sh-cfz-search',     q => loadCfz(q),     t => { cfzSearchTimer     = t; }, () => cfzSearchTimer);

  document.getElementById('sh-fetch-btn')?.addEventListener('click', openFetchModal);
  document.getElementById('sh-report-btn')?.addEventListener('click', openReportModal);

  // Лайтбокс
  document.getElementById('sh-lb-close')?.addEventListener('click', closeLightbox);
  document.getElementById('sh-lightbox')?.addEventListener('click', e => { if (e.target === e.currentTarget || e.target === document.getElementById('sh-lb-img-wrap')) closeLightbox(); });
  document.getElementById('sh-lb-prev')?.addEventListener('click', () => lightboxNav(-1));
  document.getElementById('sh-lb-next')?.addEventListener('click', () => lightboxNav(+1));
  document.addEventListener('keydown', e => {
    const lb = document.getElementById('sh-lightbox');
    if (!lb || lb.style.display === 'none') return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft')  lightboxNav(-1);
    if (e.key === 'ArrowRight') lightboxNav(+1);
  });

  // Авто-обновление: слушаем события от кладовщиков
  const sse = new EventSource('/api/rk/events', { withCredentials: true });
  sse.addEventListener('routes-updated', () => {
    if (activeView === 'routes') loadRoutes(document.getElementById('sh-routes-search')?.value.trim());
  });

  // Модал: WMS
  document.getElementById('sh-fetch-modal-close')?.addEventListener('click', closeFetchModal);
  document.getElementById('sh-fetch-modal-close2')?.addEventListener('click', closeFetchModal);
  document.getElementById('sh-fetch-submit')?.addEventListener('click', handleFetch);
  document.getElementById('sh-fetch-modal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeFetchModal(); });

  // Единая форма — фикс: не закрывать при выделении текста за пределами окна
  document.getElementById('sh-form-modal-close')?.addEventListener('click', closeFormModal);
  let formModalMdOnBg = false;
  document.getElementById('sh-form-modal')?.addEventListener('mousedown', e => { formModalMdOnBg = e.target === e.currentTarget; });
  document.getElementById('sh-form-modal')?.addEventListener('click', e => { if (e.target === e.currentTarget && formModalMdOnBg) closeFormModal(); formModalMdOnBg = false; });
  document.getElementById('sh-form-next')?.addEventListener('click', formNext);
  document.getElementById('sh-form-back')?.addEventListener('click', formBack);
  document.getElementById('sh-form-submit')?.addEventListener('click', handleFormSubmit);

  // Модал: отчёт
  document.getElementById('sh-codes-btn')?.addEventListener('click', openCodesModal);
  document.getElementById('sh-codes-modal-close')?.addEventListener('click', closeCodesModal);
  document.getElementById('sh-codes-modal-close2')?.addEventListener('click', closeCodesModal);
  document.getElementById('sh-codes-modal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeCodesModal(); });
  document.getElementById('sh-codes-export-btn')?.addEventListener('click', handleCodesExport);
  document.getElementById('sh-codes-import-input')?.addEventListener('change', handleCodesImport);

  document.getElementById('sh-report-modal-close')?.addEventListener('click', closeReportModal);
  document.getElementById('sh-report-modal-close2')?.addEventListener('click', closeReportModal);
  document.getElementById('sh-report-modal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeReportModal(); });
  document.getElementById('sh-report-submit')?.addEventListener('click', handleDownloadReport);
  document.getElementById('sh-report-delete')?.addEventListener('click', handleDeleteByDate);
}

function setupSearch(inputId, handler, setTimer, getTimer) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener('input', () => {
    clearTimeout(getTimer());
    setTimer(setTimeout(() => handler(input.value.trim()), 350));
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(getTimer()); handler(input.value.trim()); }
  });
}

// ─── Загрузка ─────────────────────────────────────────────────────────────────

export async function loadSummary() {
  await loadActiveView();
  loadMissingCodes();
}

async function loadActiveView() {
  if (activeView === 'routes')  return loadRoutes(document.getElementById('sh-routes-search')?.value.trim());
  if (activeView === 'drivers') return loadDrivers(document.getElementById('sh-drivers-search')?.value.trim());
  return loadCfz(document.getElementById('sh-cfz-search')?.value.trim());
}

let codesEntries = [];

async function openCodesModal() {
  const modal = document.getElementById('sh-codes-modal');
  const list  = document.getElementById('sh-codes-list');
  if (!modal || !list) return;
  list.innerHTML = '<div class="sh-loading">Загрузка...</div>';
  modal.style.display = 'flex';

  const searchEl = document.getElementById('sh-codes-search');
  if (searchEl) { searchEl.value = ''; searchEl.oninput = () => renderCodesList(searchEl.value.trim()); }

  try {
    codesEntries = await api.getShipmentsCodes();
    renderCodesList('');
  } catch (err) {
    list.innerHTML = `<div class="sh-error">${escHtml(err.message)}</div>`;
  }
}

function renderCodesList(q) {
  const list = document.getElementById('sh-codes-list');
  if (!list) return;

  const ql = q.toLowerCase();
  const filtered = ql
    ? codesEntries.filter(e =>
        e.address.toLowerCase().includes(ql) ||
        (e.code || '').toLowerCase().includes(ql))
    : codesEntries;

  if (!filtered.length) {
    list.innerHTML = `<div class="sh-empty">${q ? 'Ничего не найдено' : 'Нет адресов ЦФЗ'}</div>`;
    return;
  }

  list.innerHTML = filtered.map(e => `
    <div class="sh-missing-row" data-addr="${escHtml(e.address)}">
      <span class="sh-missing-addr">${escHtml(e.address)}</span>
      <input class="sh-code-input sh-input" placeholder="Код получателя" value="${escHtml(e.code || '')}">
      <button class="btn btn-sm btn-primary sh-code-save-btn">Сохранить</button>
      <span class="sh-code-status"></span>
    </div>`).join('');

  list.querySelectorAll('.sh-code-save-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row    = btn.closest('.sh-missing-row');
      const addr   = row.dataset.addr;
      const code   = row.querySelector('.sh-code-input').value.trim();
      const status = row.querySelector('.sh-code-status');
      if (!code) return;
      btn.disabled = true;
      status.textContent = '';
      try {
        await api.setShipmentRecipientCode(addr, code);
        const entry = codesEntries.find(e => e.address === addr);
        if (entry) entry.code = code;
        status.textContent = '✓';
        status.style.color = '#2e7d32';
        loadMissingCodes();
      } catch {
        status.textContent = '✗';
        status.style.color = '#c62828';
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function closeCodesModal() { document.getElementById('sh-codes-modal').style.display = 'none'; }

async function handleCodesExport() {
  const btn = document.getElementById('sh-codes-export-btn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/shipments/codes/export', { credentials: 'include' });
    if (!r.ok) throw new Error((await r.json()).error);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Коды получателей ЦФЗ.xlsx';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { alert('Ошибка: ' + err.message); }
  finally { btn.disabled = false; }
}

async function handleCodesImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const resultEl = document.getElementById('sh-codes-import-result');
  resultEl.textContent = 'Загружаю...';
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/shipments/codes/import', { method: 'POST', body: fd, credentials: 'include' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    resultEl.textContent = `✅ Сохранено: ${data.saved}`;
    await openCodesModal();
    loadMissingCodes();
  } catch (err) {
    resultEl.textContent = `❌ ${err.message}`;
  } finally {
    e.target.value = '';
  }
}

async function loadMissingCodes() {
  const banner = document.getElementById('sh-missing-codes');
  if (!banner) return;
  try {
    const missing = await api.getShipmentsMissingCodes();
    if (!missing.length) { banner.style.display = 'none'; return; }
    let open = false;
    const render = () => {
      banner.style.display = '';
      banner.innerHTML = `
        <div class="sh-missing-header">
          ⚠️ ${missing.length} адрес${missing.length === 1 ? '' : missing.length < 5 ? 'а' : 'ов'} ЦФЗ без кода получателя
          <button class="sh-missing-toggle">${open ? 'Скрыть' : 'Показать'}</button>
        </div>
        ${open ? `<div class="sh-missing-list">${missing.map(addr => `
          <div class="sh-missing-row" data-addr="${escHtml(addr)}">
            <span class="sh-missing-addr">${escHtml(addr)}</span>
            <input class="sh-code-input sh-input" placeholder="Код получателя" type="text">
            <button class="btn btn-sm btn-primary sh-code-save-btn">Сохранить</button>
          </div>`).join('')}</div>` : ''}`;
      banner.querySelector('.sh-missing-toggle')?.addEventListener('click', () => { open = !open; render(); });
      banner.querySelectorAll('.sh-code-save-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.sh-missing-row');
          const addr = row.dataset.addr;
          const code = row.querySelector('.sh-code-input').value.trim();
          if (!code) return;
          btn.disabled = true;
          try {
            await api.setShipmentRecipientCode(addr, code);
            row.innerHTML = `<span class="sh-missing-addr">${escHtml(addr)}</span><span class="sh-code-saved">✓ ${escHtml(code)}</span>`;
            const idx = missing.indexOf(addr);
            if (idx !== -1) missing.splice(idx, 1);
            if (!missing.length) { banner.style.display = 'none'; }
          } catch { btn.disabled = false; }
        });
      });
    };
    render();
  } catch { /* тихо */ }
}

async function loadRoutes(q) {
  const c = document.getElementById('sh-routes-list');
  if (!c) return;
  c.innerHTML = '<div class="sh-loading">Загрузка...</div>';
  try { routesData = await api.getRkRoutes({ q }); routesPage = 1; renderRoutes(); }
  catch (err) { c.innerHTML = `<div class="sh-error">${escHtml(err.message)}</div>`; }
}
async function loadDrivers(q) {
  const c = document.getElementById('sh-drivers-list');
  if (!c) return;
  c.innerHTML = '<div class="sh-loading">Загрузка...</div>';
  try { driversData = await api.getRkDrivers(q); renderDrivers(); }
  catch (err) { c.innerHTML = `<div class="sh-error">${escHtml(err.message)}</div>`; }
}
async function loadCfz(q) {
  const c = document.getElementById('sh-cfz-list');
  if (!c) return;
  c.innerHTML = '<div class="sh-loading">Загрузка...</div>';
  try { cfzData = await api.getRkCfz(q); renderCfz(); }
  catch (err) { c.innerHTML = `<div class="sh-error">${escHtml(err.message)}</div>`; }
}

function switchView(view) {
  activeView = view;
  document.querySelectorAll('.sh-subtab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === view));
  document.querySelectorAll('.sh-view').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  loadActiveView();
}

// ─── Разница ──────────────────────────────────────────────────────────────────

function diffHtml(diff) {
  if (diff == null) return '<span class="sh-na">—</span>';
  if (diff > 0) return `<span class="sh-diff-plus">+${diff}</span>`;
  if (diff < 0) return `<span class="sh-diff-minus">${diff}</span>`;
  return '<span class="sh-diff-zero">0</span>';
}

// ─── Вид: по маршрутам ────────────────────────────────────────────────────────

function renderRoutes() {
  const c = document.getElementById('sh-routes-list');
  if (!c) return;
  if (!routesData.length) { c.innerHTML = '<div class="sh-empty">Нет маршрутов. Загрузите из WMS.</div>'; return; }

  const totalPages = Math.max(1, Math.ceil(routesData.length / ROUTES_PER_PAGE));
  if (routesPage > totalPages) routesPage = totalPages;
  const pageStart = (routesPage - 1) * ROUTES_PER_PAGE;
  const pageData  = routesData.slice(pageStart, pageStart + ROUTES_PER_PAGE);

  const hasSel = selectedRoutes.size > 0;
  const bulkBar = hasSel ? `
    <div class="sh-bulk-bar">
      <span class="sh-bulk-count">Выбрано: ${selectedRoutes.size}</span>
      <button class="btn btn-sm btn-primary sh-bulk-act" data-baction="confirm-ship">✓ Подтвердить отгрузку</button>
      <button class="btn btn-sm btn-primary sh-bulk-act" data-baction="confirm-receive">✓ Подтвердить приёмку</button>
      <button class="btn btn-sm btn-secondary" id="sh-bulk-clear">✕ Снять выбор</button>
    </div>` : '';

  const allOnPageChecked = pageData.length > 0 && pageData.every(r => selectedRoutes.has(r.routeId));

  const pagination = totalPages > 1 ? `
    <div class="sh-pagination">
      <button class="sh-page-btn" id="sh-page-first" ${routesPage === 1 ? 'disabled' : ''}>«</button>
      <button class="sh-page-btn" id="sh-page-prev"  ${routesPage === 1 ? 'disabled' : ''}>‹</button>
      <span class="sh-page-info">Стр. ${routesPage} из ${totalPages} &nbsp;·&nbsp; всего ${routesData.length}</span>
      <button class="sh-page-btn" id="sh-page-next"  ${routesPage === totalPages ? 'disabled' : ''}>›</button>
      <button class="sh-page-btn" id="sh-page-last"  ${routesPage === totalPages ? 'disabled' : ''}>»</button>
    </div>` : `<div class="sh-page-info-simple">Всего: ${routesData.length}</div>`;

  c.innerHTML = bulkBar + `
    <table class="sh-table">
      <thead><tr>
        <th class="sh-th-check"><input type="checkbox" id="sh-select-all" ${allOnPageChecked ? 'checked' : ''}></th>
        <th>Дата</th><th>Маршрут</th><th>Водитель</th><th>ТС</th><th>ЦФЗ</th>
        <th class="sh-th-num">Отгр.</th><th>Кто отгрузил</th><th class="sh-th-num">Дата отгр.</th>
        <th class="sh-th-num">Принято</th><th>Кто принял</th><th class="sh-th-num">Дата прин.</th>
        <th class="sh-th-num">Разница</th><th>Подтв. отгр.</th><th>Подтв. пр.</th>
        <th class="sh-th-actions">Действия</th>
      </tr></thead>
      <tbody>${pageData.map(r => routeRows(r)).join('')}</tbody>
    </table>` + pagination;

  // Bulk bar
  document.getElementById('sh-bulk-clear')?.addEventListener('click', () => { selectedRoutes.clear(); renderRoutes(); });
  c.querySelectorAll('.sh-bulk-act').forEach(btn => {
    btn.addEventListener('click', () => bulkConfirm(btn.dataset.baction));
  });

  // Select all (только текущая страница)
  document.getElementById('sh-select-all')?.addEventListener('change', e => {
    pageData.forEach(r => e.target.checked ? selectedRoutes.add(r.routeId) : selectedRoutes.delete(r.routeId));
    renderRoutes();
  });

  // Row checkboxes — ФИКС: вызываем renderRoutes чтобы показать/скрыть bulk bar
  c.querySelectorAll('.sh-row-check').forEach(cb => {
    cb.addEventListener('change', () => {
      cb.checked ? selectedRoutes.add(cb.dataset.id) : selectedRoutes.delete(cb.dataset.id);
      renderRoutes();
    });
  });

  // Row expand
  c.querySelectorAll('.sh-tr-main').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('.sh-td-actions') || e.target.type === 'checkbox') return;
      toggleRouteExpand(tr.dataset.id);
    });
  });

  // Per-row action buttons
  c.querySelectorAll('.sh-act-confirm-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); handleConfirmSingle(btn.dataset.id, btn.dataset.atype, btn); });
  });
  c.querySelectorAll('.sh-act-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openEditModal(btn.dataset.id); });
  });

  // Фото лайтбокс
  c.querySelectorAll('.sh-photo-thumb').forEach(el => {
    el.addEventListener('click', () => {
      const photos = JSON.parse(el.dataset.photos);
      openLightbox(photos, Number(el.dataset.idx));
    });
  });

  // Пагинация
  document.getElementById('sh-page-first')?.addEventListener('click', () => { routesPage = 1; renderRoutes(); });
  document.getElementById('sh-page-prev')?.addEventListener('click',  () => { routesPage--; renderRoutes(); });
  document.getElementById('sh-page-next')?.addEventListener('click',  () => { routesPage++; renderRoutes(); });
  document.getElementById('sh-page-last')?.addEventListener('click',  () => { routesPage = totalPages; renderRoutes(); });
}

async function handleConfirmSingle(routeId, atype, btn) {
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '...';
  try {
    const res = atype === 'ship' ? await api.confirmRkShipment(routeId) : await api.confirmRkReceiving(routeId);
    if (!res.ok) throw new Error(res.error || 'Ошибка');
    const idx = routesData.findIndex(r => r.routeId === routeId);
    if (idx !== -1) routesData[idx] = res.route;
    renderRoutes();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = orig;
    alert('Ошибка: ' + err.message);
  }
}

async function bulkConfirm(baction) {
  const ids = [...selectedRoutes];
  const confirmFn = baction === 'confirm-ship' ? api.confirmRkShipment : api.confirmRkReceiving;
  const bar = document.querySelector('.sh-bulk-bar');
  let done = 0;
  for (const id of ids) {
    try {
      const res = await confirmFn(id);
      if (res.ok) {
        const idx = routesData.findIndex(r => r.routeId === id);
        if (idx !== -1) routesData[idx] = res.route;
        selectedRoutes.delete(id);
      }
    } catch { /* пропускаем ошибочные */ }
    done++;
    if (bar) bar.querySelector('.sh-bulk-count').textContent = `Подтверждаю: ${done}/${ids.length}`;
  }
  renderRoutes();
}

function openEditModal(routeId) {
  const route = routesData.find(r => r.routeId === routeId);
  if (!route) return;

  formMode = 'edit';
  formRoute = route;
  formPhotos = [];
  formPhotoUrls = [];
  formExistingPhotos = [];

  formEditShip = {
    by: route.shipment?.by || '',
    gate: route.shipment?.gate || '',
    existingPhotos: [...(route.shipment?.photos || [])],
    newPhotos: [],
  };
  formEditRecv = {
    by: route.receiving?.by || '',
    gate: route.receiving?.gate || '',
    existingPhotos: [...(route.receiving?.photos || [])],
    newPhotos: [],
  };

  formStep = 4;
  renderFormStep();
  document.getElementById('sh-form-modal').style.display = 'flex';
}

function routeRows(r) {
  const expanded = expandedRoutes.has(r.routeId);
  const cfzList  = r.cfzAddresses || [];
  const isSel    = selectedRoutes.has(r.routeId);

  const shipConfirm = r.shipment
    ? (!r.shipment.confirmed
        ? `<button class="sh-act-btn sh-act-confirm-btn" data-id="${escHtml(r.routeId)}" data-atype="ship" title="Подтвердить отгрузку">✓ Отгр.</button>`
        : `<span class="sh-act-done" title="Отгрузка подтверждена">✓ Отгр.</span>`)
    : '';

  const recvConfirm = r.receiving
    ? (!r.receiving.confirmed
        ? `<button class="sh-act-btn sh-act-confirm-btn" data-id="${escHtml(r.routeId)}" data-atype="receive" title="Подтвердить приёмку">✓ Пр.</button>`
        : `<span class="sh-act-done" title="Приёмка подтверждена">✓ Пр.</span>`)
    : '';

  const editBtn = `<button class="sh-act-btn sh-act-edit-btn" data-id="${escHtml(r.routeId)}" title="Редактировать">✎</button>`;

  const mainRow = `<tr class="sh-tr-main ${r.shipment && !r.receiving ? 'sh-row-pending' : ''}" data-id="${escHtml(r.routeId)}" style="cursor:pointer">
    <td class="sh-td-check" onclick="event.stopPropagation()">
      <input type="checkbox" class="sh-row-check" data-id="${escHtml(r.routeId)}" ${isSel ? 'checked' : ''}>
    </td>
    <td>${fmtDate(r.date)}</td>
    <td class="sh-td-bold">${escHtml(r.routeNumber || '—')}</td>
    <td class="sh-td-trunc" title="${escHtml(r.driver?.name || '')}">${escHtml(r.driver?.name || '—')}</td>
    <td class="sh-td-muted sh-td-trunc" title="${escHtml(r.vehicle ? `${r.vehicle.model} ${r.vehicle.number}` : '')}">${escHtml(r.vehicle ? `${r.vehicle.model} ${r.vehicle.number}` : '—')}</td>
    <td class="sh-td-muted">${cfzList.length ? `${cfzList.length} ` : '—'}</td>
    <td class="sh-td-num">${r.shippedRK != null ? r.shippedRK : '<span class="sh-na">—</span>'}</td>
    <td class="sh-td-muted sh-td-trunc" title="${escHtml(r.shipment?.by || '')}">${escHtml(r.shipment?.by || '—')}</td>
    <td class="sh-td-muted sh-td-date">${fmtDateTime(r.shippedAt)}</td>
    <td class="sh-td-num">${r.receivedRK != null ? r.receivedRK : '<span class="sh-na">—</span>'}</td>
    <td class="sh-td-muted sh-td-trunc" title="${escHtml(r.receiving?.by || '')}">${escHtml(r.receiving?.by || '—')}</td>
    <td class="sh-td-muted sh-td-date">${fmtDateTime(r.receivedAt)}</td>
    <td class="sh-td-num">${diffHtml(r.diff)}</td>
    <td class="sh-td-muted sh-td-trunc" title="${escHtml(r.shipment?.confirmedBy || '')}">${escHtml(r.shipment?.confirmedBy || '—')}</td>
    <td class="sh-td-muted sh-td-trunc" title="${escHtml(r.receiving?.confirmedBy || '')}">${escHtml(r.receiving?.confirmedBy || '—')}</td>
    <td class="sh-td-actions sh-td-actions-cell">${shipConfirm}${recvConfirm}${editBtn}</td>
  </tr>`;

  let detailRow = '';
  if (expanded) {
    const shipItems = r.shipment?.items || [];
    const recvItems = r.receiving?.items || [];
    const addrs = cfzList.length ? cfzList.map(a => a.address) :
      [...new Set([...shipItems.map(i => i.address), ...recvItems.map(i => i.address)])];

    const rows = addrs.map(addr => {
      const s = shipItems.find(i => i.address === addr);
      const rv = recvItems.find(i => i.address === addr);
      const d = s && rv ? rv.rk - s.rk : null;
      return `<tr>
        <td>${escHtml(addr)}</td>
        <td class="sh-td-num">${s ? s.rk : '<span class="sh-na">—</span>'}</td>
        <td class="sh-td-num">${rv ? rv.rk : '<span class="sh-na">—</span>'}</td>
        <td class="sh-td-num">${diffHtml(d)}</td>
      </tr>`;
    });

    const meta = [
      r.shipment ? `Отгрузил: <b>${escHtml(r.shipment.by || '—')}</b>${r.shipment.gate ? ` · Ворота: <b>${escHtml(r.shipment.gate)}</b>` : ''}${r.shipment.confirmed ? ' <span class="sh-badge-ok">✓</span>' : ''}` : null,
      r.receiving ? `Принял: <b>${escHtml(r.receiving.by || '—')}</b>${r.receiving.gate ? ` · Ворота: <b>${escHtml(r.receiving.gate)}</b>` : ''}${r.receiving.confirmed ? ' <span class="sh-badge-ok">✓</span>' : ''}` : null,
    ].filter(Boolean).join(' &nbsp;|&nbsp; ');

    const shipPhotos = r.shipment?.photos  || [];
    const recvPhotos = r.receiving?.photos || [];

    const photoCol = (label, photos) => {
      if (!photos.length) return '';
      const thumbs = photos.map((u, i) =>
        `<span class="sh-photo-thumb" data-photos="${escHtml(JSON.stringify(photos))}" data-idx="${i}">` +
        `<img src="${escHtml(u)}" alt="фото"></span>`
      ).join('');
      return `<div class="sh-photo-col">
        <div class="sh-photo-col-label">${label}</div>
        <div class="sh-photos-row">${thumbs}</div>
      </div>`;
    };

    const photosHtml = shipPhotos.length || recvPhotos.length
      ? `<div class="sh-photo-cols">
          ${photoCol('Отгрузил', shipPhotos)}
          ${photoCol('Принял',   recvPhotos)}
        </div>`
      : '';

    const body = rows.length
      ? `<table class="sh-detail-table">
          <thead><tr><th>Адрес ЦФЗ</th><th class="sh-th-num">Отгружено</th><th class="sh-th-num">Принято</th><th class="sh-th-num">Разница</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
         </table>`
      : '<div class="sh-empty">Данные по ЦФЗ отсутствуют</div>';

    detailRow = `<tr class="sh-tr-detail"><td colspan="16"><div class="sh-detail-block">
      ${meta ? `<div class="sh-detail-meta">${meta}</div>` : ''}
      ${body}
      ${photosHtml}
    </div></td></tr>`;
  }

  return mainRow + detailRow;
}

function toggleRouteExpand(id) {
  if (expandedRoutes.has(id)) expandedRoutes.delete(id); else expandedRoutes.add(id);
  renderRoutes();
}

// ─── Вид: по водителям ────────────────────────────────────────────────────────

function renderDrivers() {
  const c = document.getElementById('sh-drivers-list');
  if (!c) return;
  if (!driversData.length) { c.innerHTML = '<div class="sh-empty">Нет данных.</div>'; return; }

  c.innerHTML = `
    <table class="sh-table">
      <thead><tr>
        <th>Водитель</th>
        <th class="sh-th-num sh-th-sort" data-sort="routeCount">Маршрутов ${sortArrow(driverSort, 'routeCount')}</th>
        <th class="sh-th-num sh-th-sort" data-sort="shippedTotal">Отгружено ${sortArrow(driverSort, 'shippedTotal')}</th>
        <th class="sh-th-num sh-th-sort" data-sort="receivedTotal">Принято ${sortArrow(driverSort, 'receivedTotal')}</th>
        <th class="sh-th-num sh-th-sort" data-sort="diff">Разница ${sortArrow(driverSort, 'diff')}</th>
      </tr></thead>
      <tbody>${sortedData(driversData, driverSort).map(d => driverRows(d)).join('')}</tbody>
    </table>`;

  c.querySelectorAll('.sh-th-sort:not(.sh-detail-sort)').forEach(th => {
    th.addEventListener('click', () => { toggleSort(driverSort, th.dataset.sort); renderDrivers(); });
  });
  c.querySelectorAll('.sh-detail-sort').forEach(th => {
    th.addEventListener('click', e => {
      e.stopPropagation();
      const owner = th.dataset.owner;
      if (!driverDetailSort.has(owner)) driverDetailSort.set(owner, { key: null, dir: null });
      toggleSort(driverDetailSort.get(owner), th.dataset.sort);
      renderDrivers();
    });
  });
  c.querySelectorAll('.sh-tr-main').forEach(tr => {
    tr.addEventListener('click', () => toggleDriverExpand(tr.dataset.id));
  });
}

function driverRows(d) {
  const expanded = expandedDrivers.has(d.name);
  const mainRow = `<tr class="sh-tr-main" data-id="${escHtml(d.name)}" style="cursor:pointer">
    <td class="sh-td-bold">${escHtml(d.name)}</td>
    <td class="sh-td-num">${d.routeCount}</td>
    <td class="sh-td-num">${d.shippedTotal || 0}</td>
    <td class="sh-td-num">${d.receivedTotal || 0}</td>
    <td class="sh-td-num">${diffHtml(d.diff)}</td>
  </tr>`;

  let detailRow = '';
  if (expanded) {
    const cfzMap = new Map();
    for (const route of d.routes || []) {
      for (const { address } of route.cfzAddresses || []) {
        if (!address) continue;
        if (!cfzMap.has(address)) cfzMap.set(address, { address, routeCount: 0, shipped: 0, received: 0 });
        const e = cfzMap.get(address);
        e.routeCount++;
        if (route.shippedRK  != null) e.shipped  += route.shippedRK;
        if (route.receivedRK != null) e.received += route.receivedRK;
      }
    }
    const ds = driverDetailSort.get(d.name) || { key: null, dir: null };
    let cfzList = Array.from(cfzMap.values()).map(e => ({ ...e, diff: (e.shipped > 0 || e.received > 0) ? e.received - e.shipped : null }));
    if (ds.key && ds.dir) {
      cfzList = cfzList.sort((a, b) => {
        const av = a[ds.key] ?? 0, bv = b[ds.key] ?? 0;
        return ds.dir === 'desc' ? bv - av : av - bv;
      });
    } else {
      cfzList.sort((a, b) => a.address.localeCompare(b.address, 'ru'));
    }

    const owner = escHtml(d.name);
    const body = cfzList.length
      ? `<table class="sh-detail-table">
          <thead><tr>
            <th>Адрес ЦФЗ</th>
            <th class="sh-th-num sh-th-sort sh-detail-sort" data-owner="${owner}" data-sort="routeCount">Маршрутов ${sortArrow(ds, 'routeCount')}</th>
            <th class="sh-th-num sh-th-sort sh-detail-sort" data-owner="${owner}" data-sort="shipped">Отгружено ${sortArrow(ds, 'shipped')}</th>
            <th class="sh-th-num sh-th-sort sh-detail-sort" data-owner="${owner}" data-sort="received">Принято ${sortArrow(ds, 'received')}</th>
            <th class="sh-th-num sh-th-sort sh-detail-sort" data-owner="${owner}" data-sort="diff">Разница ${sortArrow(ds, 'diff')}</th>
          </tr></thead>
          <tbody>${cfzList.map(e => `<tr>
            <td>${escHtml(e.address)}</td>
            <td class="sh-td-num">${e.routeCount}</td>
            <td class="sh-td-num">${e.shipped}</td>
            <td class="sh-td-num">${e.received}</td>
            <td class="sh-td-num">${diffHtml(e.diff)}</td>
          </tr>`).join('')}</tbody>
         </table>`
      : '<div class="sh-empty">Адреса ЦФЗ не указаны в маршрутах этого водителя</div>';

    detailRow = `<tr class="sh-tr-detail"><td colspan="5"><div class="sh-detail-block">${body}</div></td></tr>`;
  }
  return mainRow + detailRow;
}

function toggleDriverExpand(id) {
  if (expandedDrivers.has(id)) expandedDrivers.delete(id); else expandedDrivers.add(id);
  renderDrivers();
}

// ─── Вид: по ЦФЗ ─────────────────────────────────────────────────────────────

function renderCfz() {
  const c = document.getElementById('sh-cfz-list');
  if (!c) return;
  if (!cfzData.length) { c.innerHTML = '<div class="sh-empty">Нет данных.</div>'; return; }

  c.innerHTML = `
    <table class="sh-table">
      <thead><tr>
        <th>Адрес ЦФЗ</th>
        <th class="sh-th-num sh-th-sort" data-sort="routeCount">Маршрутов ${sortArrow(cfzSort, 'routeCount')}</th>
        <th class="sh-th-num sh-th-sort" data-sort="shippedTotal">Отгружено ${sortArrow(cfzSort, 'shippedTotal')}</th>
        <th class="sh-th-num sh-th-sort" data-sort="receivedTotal">Принято ${sortArrow(cfzSort, 'receivedTotal')}</th>
        <th class="sh-th-num sh-th-sort" data-sort="diff">Разница ${sortArrow(cfzSort, 'diff')}</th>
      </tr></thead>
      <tbody>${sortedData(cfzData, cfzSort).map(entry => cfzRows(entry)).join('')}</tbody>
    </table>`;

  c.querySelectorAll('.sh-th-sort:not(.sh-detail-sort)').forEach(th => {
    th.addEventListener('click', () => { toggleSort(cfzSort, th.dataset.sort); renderCfz(); });
  });
  c.querySelectorAll('.sh-detail-sort').forEach(th => {
    th.addEventListener('click', e => {
      e.stopPropagation();
      const owner = th.dataset.owner;
      if (!cfzDetailSort.has(owner)) cfzDetailSort.set(owner, { key: null, dir: null });
      toggleSort(cfzDetailSort.get(owner), th.dataset.sort);
      renderCfz();
    });
  });
  c.querySelectorAll('.sh-tr-main').forEach(tr => {
    tr.addEventListener('click', () => toggleCfzExpand(tr.dataset.id));
  });
}

function cfzRows(entry) {
  const expanded = expandedCfz.has(entry.address);
  const mainRow = `<tr class="sh-tr-main" data-id="${escHtml(entry.address)}" style="cursor:pointer">
    <td class="sh-td-bold">${escHtml(entry.address)}</td>
    <td class="sh-td-num">${entry.routeCount}</td>
    <td class="sh-td-num">${entry.shippedTotal || 0}</td>
    <td class="sh-td-num">${entry.receivedTotal || 0}</td>
    <td class="sh-td-num">${diffHtml(entry.diff)}</td>
  </tr>`;

  let detailRow = '';
  if (expanded) {
    const ds = cfzDetailSort.get(entry.address) || { key: null, dir: null };
    let routes = [...(entry.routes || [])];
    if (ds.key && ds.dir) {
      routes.sort((a, b) => {
        let av, bv;
        if (ds.key === 'date') { av = a.date || ''; bv = b.date || ''; return ds.dir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv); }
        av = a[ds.key] ?? 0; bv = b[ds.key] ?? 0;
        return ds.dir === 'desc' ? bv - av : av - bv;
      });
    }
    const owner = escHtml(entry.address);
    const body = routes.length
      ? `<table class="sh-detail-table">
          <thead><tr>
            <th class="sh-th-sort sh-detail-sort" data-owner="${owner}" data-sort="date">Дата ${sortArrow(ds, 'date')}</th>
            <th>Маршрут</th><th>Водитель</th>
            <th class="sh-th-num sh-th-sort sh-detail-sort" data-owner="${owner}" data-sort="shippedRK">Отгружено ${sortArrow(ds, 'shippedRK')}</th>
            <th class="sh-th-num">Дата отгр.</th>
            <th class="sh-th-num sh-th-sort sh-detail-sort" data-owner="${owner}" data-sort="receivedRK">Принято ${sortArrow(ds, 'receivedRK')}</th>
            <th class="sh-th-num">Дата прин.</th>
            <th class="sh-th-num sh-th-sort sh-detail-sort" data-owner="${owner}" data-sort="diff">Разница ${sortArrow(ds, 'diff')}</th>
          </tr></thead>
          <tbody>${routes.map(r => `<tr>
            <td>${fmtDate(r.date)}</td>
            <td>${escHtml(r.routeNumber || '—')}</td>
            <td>${escHtml(r.driver?.name || '—')}</td>
            <td class="sh-td-num">${r.shippedRK != null ? r.shippedRK : '<span class="sh-na">—</span>'}</td>
            <td class="sh-td-muted sh-td-date">${fmtDateTime(r.shippedAt)}</td>
            <td class="sh-td-num">${r.receivedRK != null ? r.receivedRK : '<span class="sh-na">—</span>'}</td>
            <td class="sh-td-muted sh-td-date">${fmtDateTime(r.receivedAt)}</td>
            <td class="sh-td-num">${diffHtml(r.diff)}</td>
          </tr>`).join('')}</tbody>
         </table>`
      : '<div class="sh-empty">Маршруты не найдены</div>';

    detailRow = `<tr class="sh-tr-detail"><td colspan="5"><div class="sh-detail-block">${body}</div></td></tr>`;
  }
  return mainRow + detailRow;
}

function toggleCfzExpand(id) {
  if (expandedCfz.has(id)) expandedCfz.delete(id); else expandedCfz.add(id);
  renderCfz();
}

// ─── Единая форма: шаги ───────────────────────────────────────────────────────

function openFormModal() {
  formMode = 'create'; formExistingPhotos = [];
  formStep = 1; formType = null; formWorker = ''; formRoute = null;
  formRoutesList = []; formPhotos = []; formPhotoUrls = [];
  renderFormStep();
  document.getElementById('sh-form-modal').style.display = 'flex';
}

function closeFormModal() {
  document.getElementById('sh-form-modal').style.display = 'none';
}

function formNext() {
  const err = validateFormStep();
  if (err) { showFormError(err); return; }
  showFormError('');
  formStep++;
  renderFormStep();
}

function formBack() {
  if (formMode === 'edit') { closeFormModal(); return; }
  showFormError('');
  formStep--;
  renderFormStep();
}

function validateFormStep() {
  if (formStep === 1) {
    const w = document.getElementById('sh-form-worker')?.value.trim();
    if (!w) return 'Введите ФИО кладовщика';
    formWorker = w;
  }
  if (formStep === 2) {
    if (!formType) return 'Выберите тип операции';
  }
  if (formStep === 3) {
    if (!formRoute) return 'Выберите маршрут';
  }
  return null;
}

function showFormError(msg) {
  const el = document.getElementById('sh-form-error');
  if (el) el.textContent = msg;
}

function renderFormStep() {
  const body    = document.getElementById('sh-form-body');
  const nextBtn = document.getElementById('sh-form-next');
  const backBtn = document.getElementById('sh-form-back');
  const subBtn  = document.getElementById('sh-form-submit');
  const title   = document.getElementById('sh-form-title');
  if (!body) return;

  const isLast = formStep === 4;
  nextBtn.style.display = isLast ? 'none' : '';
  subBtn.style.display  = isLast ? '' : 'none';
  backBtn.style.display = formStep > 1 ? '' : 'none';

  // Прогресс (в режиме редактирования скрываем шаги)
  const stepsEl = document.querySelector('.sh-form-steps');
  if (stepsEl) stepsEl.style.display = formMode === 'edit' ? 'none' : '';
  document.querySelectorAll('.sh-form-step-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i + 1 === formStep);
    dot.classList.toggle('done', i + 1 < formStep);
  });

  if (formStep === 1) {
    title.textContent = 'Шаг 1 — Кладовщик';
    body.innerHTML = `
      <label class="sh-form-label">Фамилия и инициалы кладовщика
        <input type="text" id="sh-form-worker" class="sh-input" placeholder="Иванов И.И." value="${escHtml(formWorker)}" autofocus>
      </label>`;
    document.getElementById('sh-form-worker')?.focus();
  }

  else if (formStep === 2) {
    title.textContent = 'Шаг 2 — Тип операции';
    body.innerHTML = `
      <div class="sh-type-cards">
        <div class="sh-type-card ${formType === 'ship' ? 'selected' : ''}" data-type="ship">
          <div class="sh-type-icon">🚚</div>
          <div class="sh-type-label">Отгрузка</div>
          <div class="sh-type-desc">РК уезжают с водителем</div>
        </div>
        <div class="sh-type-card ${formType === 'receive' ? 'selected' : ''}" data-type="receive">
          <div class="sh-type-icon">📥</div>
          <div class="sh-type-label">Приёмка</div>
          <div class="sh-type-desc">Водитель вернул РК</div>
        </div>
      </div>`;
    body.querySelectorAll('.sh-type-card').forEach(card => {
      card.addEventListener('click', () => {
        formType = card.dataset.type;
        body.querySelectorAll('.sh-type-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
      });
    });
  }

  else if (formStep === 3) {
    title.textContent = 'Шаг 3 — Маршрут';
    const status = formType === 'ship' ? 'unshipped' : 'pending';
    body.innerHTML = `
      <input type="text" id="sh-form-route-search" class="sh-input" placeholder="Поиск по водителю, маршруту..." style="width:100%;box-sizing:border-box;margin-bottom:10px">
      <div id="sh-form-routes-list"><div class="sh-loading">Загрузка...</div></div>`;
    const searchInput = document.getElementById('sh-form-route-search');
    let searchTimer = null;
    const doSearch = q => {
      api.getRkRoutes({ q, status }).then(routes => {
        formRoutesList = routes;
        renderFormRoutesList();
      }).catch(err => {
        document.getElementById('sh-form-routes-list').innerHTML = `<div class="sh-error">${escHtml(err.message)}</div>`;
      });
    };
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => doSearch(searchInput.value.trim()), 300);
    });
    doSearch('');
    // Если маршрут уже выбран — показать его
    if (formRoute) renderFormSelectedRoute();
  }

  else if (formStep === 4) {
    const isEdit = formMode === 'edit';

    if (isEdit) {
      // ── Объединённое редактирование ─────────────────────────────
      title.textContent = 'Редактировать маршрут';
      const cfzList = formRoute?.cfzAddresses || [];
      const shipItemMap = Object.fromEntries((formRoute?.shipment?.items || []).map(i => [i.address, i.rk]));
      const recvItemMap = Object.fromEntries((formRoute?.receiving?.items || []).map(i => [i.address, i.rk]));

      const cfzRows = (sectionClass, itemMap, hintMap) => cfzList.length
        ? cfzList.map(a => {
            const cur = itemMap[a.address] ?? '';
            const hint = hintMap && hintMap[a.address] != null
              ? `<span class="sh-form-cfz-hint">отгр: ${hintMap[a.address]}</span>` : '';
            return `<div class="sh-form-cfz-row">
              <span class="sh-form-cfz-addr">${escHtml(a.address)}</span>
              ${hint}
              <input type="number" class="sh-input sh-input-rk ${sectionClass}" data-addr="${escHtml(a.address)}" min="0" placeholder="0" value="${cur}">
            </div>`;
          }).join('')
        : '<div class="sh-empty">ЦФЗ не указаны</div>';

      const photoBlock = (sectionKey, state) => `
        ${state.existingPhotos.map((u, i) => `
          <div class="sh-photo-preview-item">
            <a href="${escHtml(u)}" target="_blank"><img src="${escHtml(u)}" class="sh-photo-thumb-img" alt="фото"></a>
            <button class="sh-photo-remove-btn" data-esec="${sectionKey}" data-eidx="${i}">✕</button>
          </div>`).join('')}
        ${state.newPhotos.map((f, i) => `
          <div class="sh-photo-preview-item">
            <img src="${URL.createObjectURL(f)}" class="sh-photo-thumb-img" alt="">
            <button class="sh-photo-remove-btn" data-nsec="${sectionKey}" data-nidx="${i}">✕</button>
          </div>`).join('')}`;

      body.innerHTML = `
        <div class="sh-form-route-summary">
          <span class="sh-form-route-num">${escHtml(formRoute?.routeNumber || '—')}</span>
          <span class="sh-form-route-driver">${escHtml(formRoute?.driver?.name || '—')}</span>
          <span class="sh-form-route-date">${fmtDate(formRoute?.date)}</span>
        </div>

        <div class="sh-edit-section">
          <div class="sh-edit-section-hdr">🚛 Отгрузка${formRoute?.shipment?.confirmed ? ' <span class="sh-badge-ok">✓</span>' : ''}</div>
          <div class="sh-edit-row2">
            <label class="sh-form-label">Кладовщик<input type="text" id="sh-edit-ship-by" class="sh-input" value="${escHtml(formEditShip.by)}" placeholder="Иванов И.И."></label>
            <label class="sh-form-label">Ворота<input type="text" id="sh-edit-ship-gate" class="sh-input sh-input-sm" value="${escHtml(formEditShip.gate)}" placeholder="№"></label>
          </div>
          <div class="sh-form-cfz-section">
            <div class="sh-form-section-title">РК по ЦФЗ <span class="sh-hint-clear">(оставьте пустым — запись удалится)</span></div>
            ${cfzRows('sh-ship-rk', shipItemMap, null)}
          </div>
          <div class="sh-form-photo-section">
            <div class="sh-photo-preview-row" id="sh-edit-ship-photos-preview">${photoBlock('ship', formEditShip)}</div>
            <label class="sh-photo-upload-label" style="margin-top:4px">
              <input type="file" id="sh-edit-ship-file" accept="image/*" multiple style="display:none">
              <span class="btn btn-sm btn-secondary">📷 Добавить фото</span>
            </label>
          </div>
        </div>

        <div class="sh-edit-section sh-edit-recv-section">
          <div class="sh-edit-section-hdr">📥 Приёмка${formRoute?.receiving?.confirmed ? ' <span class="sh-badge-ok">✓</span>' : ''}</div>
          <div class="sh-edit-row2">
            <label class="sh-form-label">Кладовщик<input type="text" id="sh-edit-recv-by" class="sh-input" value="${escHtml(formEditRecv.by)}" placeholder="Иванов И.И."></label>
            <label class="sh-form-label">Ворота<input type="text" id="sh-edit-recv-gate" class="sh-input sh-input-sm" value="${escHtml(formEditRecv.gate)}" placeholder="№"></label>
          </div>
          <div class="sh-form-cfz-section">
            <div class="sh-form-section-title">РК по ЦФЗ <span class="sh-hint-clear">(оставьте пустым — запись удалится)</span></div>
            ${cfzRows('sh-recv-rk', recvItemMap, shipItemMap)}
          </div>
          <div class="sh-form-photo-section">
            <div class="sh-photo-preview-row" id="sh-edit-recv-photos-preview">${photoBlock('recv', formEditRecv)}</div>
            <label class="sh-photo-upload-label" style="margin-top:4px">
              <input type="file" id="sh-edit-recv-file" accept="image/*" multiple style="display:none">
              <span class="btn btn-sm btn-secondary">📷 Добавить фото</span>
            </label>
          </div>
        </div>`;

      // Удаление фото
      body.querySelectorAll('.sh-photo-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const state = btn.dataset.esec === 'ship' || btn.dataset.nsec === 'ship' ? formEditShip : formEditRecv;
          if (btn.dataset.eidx != null) state.existingPhotos.splice(Number(btn.dataset.eidx), 1);
          else state.newPhotos.splice(Number(btn.dataset.nidx), 1);
          renderFormStep();
        });
      });

      // Добавление фото
      document.getElementById('sh-edit-ship-file')?.addEventListener('change', e => {
        formEditShip.newPhotos = [...formEditShip.newPhotos, ...Array.from(e.target.files)];
        renderFormStep();
      });
      document.getElementById('sh-edit-recv-file')?.addEventListener('change', e => {
        formEditRecv.newPhotos = [...formEditRecv.newPhotos, ...Array.from(e.target.files)];
        renderFormStep();
      });
    } else {
      // ── Создание (обычный режим) ─────────────────────────────────
      const shipItems = formRoute?.shipment?.items || [];
      title.textContent = formType === 'ship' ? 'Шаг 4 — Данные отгрузки' : 'Шаг 4 — Данные приёмки';
      const cfzList = formRoute?.cfzAddresses || [];

      body.innerHTML = `
        <div class="sh-form-route-summary">
          <span class="sh-form-route-num">${escHtml(formRoute?.routeNumber || '—')}</span>
          <span class="sh-form-route-driver">${escHtml(formRoute?.driver?.name || '—')}</span>
          <span class="sh-form-route-date">${fmtDate(formRoute?.date)}</span>
        </div>

        <label class="sh-form-label">Ворота
          <input type="text" id="sh-form-gate" class="sh-input sh-input-sm" placeholder="Номер ворот">
        </label>

        <div class="sh-form-cfz-section">
          <div class="sh-form-section-title">Количество РК по каждому ЦФЗ</div>
          ${cfzList.length
            ? cfzList.map(a => {
                const prevRk = shipItems.find(x => x.address === a.address)?.rk ?? '';
                const curRk = formType === 'receive' ? prevRk : '';
                const hint = formType === 'receive' && prevRk !== ''
                  ? `<span class="sh-form-cfz-hint">отгружено: ${prevRk}</span>` : '';
                return `<div class="sh-form-cfz-row">
                  <span class="sh-form-cfz-addr">${escHtml(a.address)}</span>
                  ${hint}
                  <input type="number" class="sh-input sh-input-rk sh-cfz-rk-input" data-addr="${escHtml(a.address)}" min="0" placeholder="0" value="${curRk}">
                </div>`;
              }).join('')
            : '<div class="sh-empty">ЦФЗ не указаны — введите вручную</div>'
          }
          ${!cfzList.length ? `<div class="sh-form-cfz-row sh-form-cfz-manual">
            <input type="text" id="sh-form-manual-addr" class="sh-input" placeholder="Адрес ЦФЗ">
            <input type="number" id="sh-form-manual-rk" class="sh-input sh-input-rk" min="0" placeholder="РК">
            <button class="btn btn-sm btn-secondary" id="sh-form-add-manual">+</button>
          </div>
          <div id="sh-form-manual-list"></div>` : ''}
        </div>

        <div class="sh-form-photo-section">
          <div class="sh-form-section-title">Фотографии</div>
          <label class="sh-photo-upload-label">
            <input type="file" id="sh-form-photos" accept="image/*" multiple style="display:none">
            <span class="btn btn-sm btn-secondary">📷 Добавить фото</span>
          </label>
          <div id="sh-form-photo-preview" class="sh-photo-preview-row"></div>
        </div>`;

      document.getElementById('sh-form-photos')?.addEventListener('change', e => {
        formPhotos = [...formPhotos, ...Array.from(e.target.files)];
        renderPhotoPreview();
      });
      renderPhotoPreview();

    // Ручное добавление ЦФЗ
    document.getElementById('sh-form-add-manual')?.addEventListener('click', () => {
      const addr = document.getElementById('sh-form-manual-addr')?.value.trim();
      const rk   = document.getElementById('sh-form-manual-rk')?.value.trim();
      if (!addr || !rk) return;
      const list = document.getElementById('sh-form-manual-list');
      const row = document.createElement('div');
      row.className = 'sh-form-cfz-row';
      row.innerHTML = `<span class="sh-form-cfz-addr">${escHtml(addr)}</span>
        <input type="number" class="sh-input sh-input-rk sh-cfz-rk-input" data-addr="${escHtml(addr)}" value="${escHtml(rk)}" min="0">
        <button class="btn btn-xs btn-secondary sh-remove-row">✕</button>`;
      row.querySelector('.sh-remove-row').addEventListener('click', () => row.remove());
      list.appendChild(row);
      document.getElementById('sh-form-manual-addr').value = '';
      document.getElementById('sh-form-manual-rk').value   = '';
    });
  } // closes else (create mode)
} // closes else if (formStep === 4)
} // closes renderFormStep

function renderFormRoutesList() {
  const el = document.getElementById('sh-form-routes-list');
  if (!el) return;
  if (!formRoutesList.length) {
    el.innerHTML = '<div class="sh-empty">Нет маршрутов</div>';
    return;
  }
  el.innerHTML = `<div class="sh-route-cards">${formRoutesList.map((r, i) => `
    <div class="sh-route-card ${formRoute?.routeId === r.routeId ? 'selected' : ''}" data-idx="${i}">
      <span class="sh-route-card-date">${fmtDate(r.date)}</span>
      <span class="sh-route-card-num">${escHtml(r.routeNumber || '—')}</span>
      <span class="sh-route-card-driver">${escHtml(r.driver?.name || '—')}</span>
      ${r.vehicle ? `<span class="sh-route-card-vehicle">${escHtml(r.vehicle.model)} ${escHtml(r.vehicle.number)}</span>` : ''}
      ${(r.cfzAddresses || []).length ? `<span class="sh-route-card-cfz">${r.cfzAddresses.length} </span>` : ''}
    </div>`).join('')}</div>`;

  el.querySelectorAll('.sh-route-card').forEach(card => {
    card.addEventListener('click', () => {
      formRoute = formRoutesList[Number(card.dataset.idx)];
      el.querySelectorAll('.sh-route-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
  });
}

function renderFormSelectedRoute() {
  // If route already selected, re-render to highlight it
  renderFormRoutesList();
}

function renderPhotoPreview() {
  const el = document.getElementById('sh-form-photo-preview');
  if (!el) return;
  el.innerHTML = formPhotos.map((f, i) => `
    <div class="sh-photo-preview-item">
      <img src="${URL.createObjectURL(f)}" class="sh-photo-thumb-img" alt="">
      <button class="sh-photo-remove-btn" data-idx="${i}">✕</button>
    </div>`).join('');
  el.querySelectorAll('.sh-photo-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      formPhotos.splice(Number(btn.dataset.idx), 1);
      renderPhotoPreview();
    });
  });
}

async function handleFormSubmit() {
  const err = validateFormStep();
  if (err) { showFormError(err); return; }

  // В edit mode items собираем внутри try-блока отдельно для ship/recv
  const items = [];
  const gate = document.getElementById('sh-form-gate')?.value.trim() || null;
  if (formMode !== 'edit') {
    document.querySelectorAll('.sh-cfz-rk-input').forEach(input => {
      const rk = Number(input.value);
      if (!isNaN(rk) && rk >= 0 && input.dataset.addr) {
        items.push({ address: input.dataset.addr, rk });
      }
    });
    if (!items.length) { showFormError('Введите количество РК хотя бы для одного ЦФЗ'); return; }
  }

  const subBtn = document.getElementById('sh-form-submit');
  subBtn.disabled = true;
  showFormError('Сохраняю...');

  try {
    if (formMode === 'edit') {
      // ── Объединённое редактирование ─────────────────────────────
      const collectItems = cls => {
        const out = [];
        document.querySelectorAll(`.${cls}`).forEach(inp => {
          const v = inp.value.trim();
          if (v !== '' && !isNaN(Number(v)) && inp.dataset.addr) {
            out.push({ address: inp.dataset.addr, rk: Number(v) });
          }
        });
        return out;
      };

      const shipItems = collectItems('sh-ship-rk');
      const recvItems = collectItems('sh-recv-rk');
      const shipBy    = document.getElementById('sh-edit-ship-by')?.value.trim() || '';
      const shipGate  = document.getElementById('sh-edit-ship-gate')?.value.trim() || '';
      const recvBy    = document.getElementById('sh-edit-recv-by')?.value.trim() || '';
      const recvGate  = document.getElementById('sh-edit-recv-gate')?.value.trim() || '';

      // Загрузка фото
      let shipPhotos = [...formEditShip.existingPhotos];
      if (formEditShip.newPhotos.length) {
        const r = await api.uploadRkPhotos(formEditShip.newPhotos);
        if (r.ok) shipPhotos = [...shipPhotos, ...r.urls];
      }
      let recvPhotos = [...formEditRecv.existingPhotos];
      if (formEditRecv.newPhotos.length) {
        const r = await api.uploadRkPhotos(formEditRecv.newPhotos);
        if (r.ok) recvPhotos = [...recvPhotos, ...r.urls];
      }

      // Сохранение — пустые items = удалить запись
      let lastRoute = null;
      if (formRoute.shipment || shipItems.length) {
        const r = await api.updateRkShipment(formRoute.routeId, { by: shipBy, gate: shipGate, items: shipItems, photos: shipPhotos });
        if (r.ok) lastRoute = r.route;
      }
      if (formRoute.receiving || recvItems.length) {
        const r = await api.updateRkReceiving(formRoute.routeId, { by: recvBy, gate: recvGate, items: recvItems, photos: recvPhotos });
        if (r.ok) lastRoute = r.route;
      }

      if (lastRoute) {
        const idx = routesData.findIndex(r => r.routeId === formRoute.routeId);
        if (idx !== -1) routesData[idx] = lastRoute;
      }
    } else {
      // ── Создание ────────────────────────────────────────────────
      let photoUrls = [];
      if (formPhotos.length) {
        const uploadRes = await api.uploadRkPhotos(formPhotos);
        if (uploadRes.ok) photoUrls = uploadRes.urls;
      }
      const payload = { by: formWorker, gate, items, photos: photoUrls };
      const res = formType === 'ship'
        ? await api.submitRkShipment(formRoute.routeId, payload)
        : await api.submitRkReceiving(formRoute.routeId, payload);
      if (!res.ok) { showFormError(`❌ ${res.error}`); subBtn.disabled = false; return; }
      const idx = routesData.findIndex(r => r.routeId === formRoute.routeId);
      if (idx !== -1) routesData[idx] = res.route;
    }

    showFormError('');
    document.getElementById('sh-form-body').innerHTML = `
      <div class="sh-form-success">
        <div class="sh-form-success-icon">✅</div>
        <div>${formMode === 'edit' ? 'Данные обновлены' : (formType === 'ship' ? 'Отгрузка' : 'Приёмка') + ' сохранена'}</div>
      </div>`;
    document.getElementById('sh-form-next').style.display = 'none';
    document.getElementById('sh-form-submit').style.display = 'none';
    document.getElementById('sh-form-back').style.display = 'none';
    setTimeout(() => { closeFormModal(); renderRoutes(); }, 1500);
  } catch (e) {
    showFormError(`❌ ${e.message}`);
  } finally {
    subBtn.disabled = false;
  }
}

// ─── Модал: загрузка из WMS ───────────────────────────────────────────────────

function openFetchModal() {
  const modal = document.getElementById('sh-fetch-modal');
  if (!modal) return;
  document.getElementById('sh-fetch-result').textContent = '';
  const now  = new Date();
  // WMS считает даты по Москве (UTC+3) — используем то же смещение
  const moscowNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const moscowDate = d => { const t = new Date(moscowNow); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
  document.getElementById('sh-fetch-date-from').value = moscowDate(-1);
  document.getElementById('sh-fetch-date-to').value   = moscowDate(+1);
  modal.style.display = 'flex';
}
function closeFetchModal() { document.getElementById('sh-fetch-modal').style.display = 'none'; }

async function handleFetch() {
  const dateFrom = document.getElementById('sh-fetch-date-from')?.value;
  const dateTo   = document.getElementById('sh-fetch-date-to')?.value;
  const resultEl = document.getElementById('sh-fetch-result');
  if (!dateFrom || !dateTo) { resultEl.textContent = 'Выберите даты'; return; }
  const btn = document.getElementById('sh-fetch-submit');
  btn.disabled = true;
  resultEl.textContent = 'Загружаю маршруты из WMS...';
  try {
    const token = auth.getToken();
    if (!token) throw new Error('Нет токена — войдите в систему заново');
    const res = await api.fetchRkFromWms({ dateFrom, dateTo, token, onProgress: msg => { resultEl.textContent = msg; } });
    if (res.ok) {
      resultEl.textContent = `✅ Маршрутов: ${res.routes}, добавлено: ${res.added}, обновлено: ${res.updated}`;
      setTimeout(() => { closeFetchModal(); loadActiveView(); }, 2000);
    } else {
      resultEl.textContent = `❌ ${res.error}`;
    }
  } catch (err) {
    resultEl.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ─── Модал: отчёт ─────────────────────────────────────────────────────────────

function openReportModal() {
  const modal = document.getElementById('sh-report-modal');
  if (!modal) return;
  const now = new Date();
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0');
  const from = document.getElementById('sh-report-date-from');
  const to   = document.getElementById('sh-report-date-to');
  if (from && !from.value) from.value = `${y}-${m}-01`;
  if (to   && !to.value)   to.value   = now.toISOString().slice(0, 10);
  document.getElementById('sh-report-result').textContent = '';
  modal.style.display = 'flex';
}
function closeReportModal() {
  document.getElementById('sh-report-modal').style.display = 'none';
  document.getElementById('sh-report-result').textContent = '';
}

async function handleDownloadReport() {
  const dateFrom = document.getElementById('sh-report-date-from')?.value;
  const dateTo   = document.getElementById('sh-report-date-to')?.value;
  const resultEl = document.getElementById('sh-report-result');
  if (!dateFrom || !dateTo) { resultEl.textContent = 'Выберите период'; return; }
  const btn = document.getElementById('sh-report-submit');
  btn.disabled = true;
  resultEl.textContent = 'Формирую отчёт...';
  try {
    const r = await fetch(`/api/shipments/report?dateFrom=${dateFrom}&dateTo=${dateTo}`, { credentials: 'include' });
    if (!r.ok) { const e = await r.json(); throw new Error(e.error || 'Ошибка'); }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Отчет по РК СПБ-3.xlsx';
    a.click();
    URL.revokeObjectURL(a.href);
    resultEl.textContent = '✅ Отчёт скачан';
  } catch (err) {
    resultEl.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function handleDeleteByDate() {
  const dateFrom = document.getElementById('sh-report-date-from')?.value;
  const dateTo   = document.getElementById('sh-report-date-to')?.value;
  const resultEl = document.getElementById('sh-report-result');
  if (!dateFrom || !dateTo) { resultEl.textContent = 'Выберите период'; return; }

  const from = dateFrom.split('-').reverse().join('.');
  const to   = dateTo.split('-').reverse().join('.');
  if (!confirm(`Удалить все данные за период ${from} — ${to}?\nЭто действие нельзя отменить.`)) return;

  const btn = document.getElementById('sh-report-delete');
  btn.disabled = true;
  resultEl.textContent = 'Удаляю...';
  try {
    const params = `dateFrom=${dateFrom}&dateTo=${dateTo}`;
    const r = await fetch(`/api/rk/routes?${params}`, { method: 'DELETE', credentials: 'include' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Ошибка удаления');
    resultEl.textContent = `✅ Удалено маршрутов: ${data.deleted}`;
    await loadRoutes(document.getElementById('sh-routes-search')?.value || '');
  } catch (err) {
    resultEl.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ─── Лайтбокс ────────────────────────────────────────────────────────────────

let lbPhotos = [];
let lbIdx    = 0;

function openLightbox(photos, idx) {
  lbPhotos = photos;
  lbIdx    = idx;
  document.getElementById('sh-lightbox').style.display = 'flex';
  renderLightbox();
}

function closeLightbox() {
  document.getElementById('sh-lightbox').style.display = 'none';
}

function lightboxNav(dir) {
  lbIdx = (lbIdx + dir + lbPhotos.length) % lbPhotos.length;
  renderLightbox();
}

function renderLightbox() {
  document.getElementById('sh-lb-img').src       = lbPhotos[lbIdx];
  document.getElementById('sh-lb-counter').textContent = `${lbIdx + 1} / ${lbPhotos.length}`;
  document.getElementById('sh-lb-prev').disabled = lbPhotos.length <= 1;
  document.getElementById('sh-lb-next').disabled = lbPhotos.length <= 1;
}

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-');
  return `${day}.${m}.${y}`;
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
