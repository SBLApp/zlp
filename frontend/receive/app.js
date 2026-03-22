'use strict';

const STORAGE_KEY = 'rk_employee_name';
let employeeName = '';
let opType = null;         // 'ship' | 'receive'
let routesList = [];
let selectedRoute = null;
let photoFiles = [];
let searchTimer = null;
let stepHistory = [];

// ─── Init ─────────────────────────────────────────────────────

function init() {
  employeeName = localStorage.getItem(STORAGE_KEY) || '';
  if (!employeeName) showNameScreen();
  else showMain();
}

// ─── Name Screen ───────────────────────────────────────────────

function showNameScreen() {
  document.getElementById('screen-name').style.display = 'flex';
  document.getElementById('screen-main').style.display = 'none';
  const input = document.getElementById('name-input');
  input.focus();
  input.addEventListener('keydown', e => { if (e.key === 'Enter') saveName(); });
  document.getElementById('name-btn').addEventListener('click', saveName);
}

function saveName() {
  const val = document.getElementById('name-input').value.trim();
  const errEl = document.getElementById('name-error');
  if (!val) {
    errEl.style.display = 'block';
    errEl.textContent = 'Введите фамилию и инициалы';
    return;
  }
  errEl.style.display = 'none';
  employeeName = val;
  localStorage.setItem(STORAGE_KEY, val);
  showMain();
}

// ─── Main Screen ───────────────────────────────────────────────

function showMain() {
  document.getElementById('screen-name').style.display = 'none';
  document.getElementById('screen-main').style.display = 'block';
  document.getElementById('header-name').textContent = employeeName;

  document.getElementById('change-name-btn').addEventListener('click', changeName);
  document.getElementById('back-btn').addEventListener('click', goBack);

  document.getElementById('step-type').querySelectorAll('.type-card').forEach(card => {
    card.addEventListener('click', () => { opType = card.dataset.type; goToSearch(); });
  });

  document.getElementById('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, 300);
  });

  document.getElementById('add-photo-btn').addEventListener('click', () => {
    document.getElementById('photo-input').click();
  });
  document.getElementById('photo-input').addEventListener('change', onPhotoSelected);
  document.getElementById('submit-btn').addEventListener('click', submit);

  goToType();
}

function changeName() {
  const v = prompt('Фамилия и инициалы:', employeeName);
  if (!v || !v.trim()) return;
  employeeName = v.trim();
  localStorage.setItem(STORAGE_KEY, employeeName);
  document.getElementById('header-name').textContent = employeeName;
}

// ─── Navigation ────────────────────────────────────────────────

const STEPS = ['type', 'search', 'data'];

function showStep(name, title, showBack) {
  STEPS.forEach(s => {
    document.getElementById(`step-${s}`).style.display = s === name ? 'block' : 'none';
  });
  document.getElementById('header-title').textContent = title || '📦 РК — Склад';
  document.getElementById('back-btn').style.display = showBack ? 'block' : 'none';
}

function goBack() {
  const prev = stepHistory.pop();
  if (!prev || prev === 'type') { goToType(); return; }
  if (prev === 'search') goToSearch(false);
}

function goToType() {
  stepHistory = [];
  opType = null;
  selectedRoute = null;
  showStep('type', '📦 РК — Склад', false);
}

function goToSearch(pushHistory = true) {
  if (pushHistory) stepHistory.push('type');
  showStep('search', opType === 'ship' ? '🚛 Отгрузка' : '📥 Приёмка', true);
  document.getElementById('search-input').placeholder = 'Водитель, маршрут, адрес ЦФЗ...';
  document.getElementById('search-input').value = '';
  doSearch();
  setTimeout(() => document.getElementById('search-input').focus(), 50);
}

function goToData(route, pushHistory = true) {
  if (pushHistory) stepHistory.push('search');
  selectedRoute = route;
  photoFiles = [];
  showStep('data', route.routeNumber || fmtDate(route.date), true);
  renderRouteData();
  renderPhotos();
  document.getElementById('gate-input').value = '';
  document.getElementById('submit-status').style.display = 'none';
  const btn = document.getElementById('submit-btn');
  btn.disabled = false;
  btn.style.display = 'block';
  btn.textContent = opType === 'ship' ? 'Сохранить отгрузку' : 'Сохранить приёмку';
}

// ─── Search ────────────────────────────────────────────────────

async function doSearch() {
  const q = document.getElementById('search-input').value.trim();
  const el = document.getElementById('search-results');
  el.innerHTML = '<div class="loading">Загрузка...</div>';
  try {
    const mode = opType === 'ship' ? 'unshipped' : 'pending';
    const url = `/api/rk/routes-search?mode=${mode}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
    routesList = await apiFetch(url);
    renderRoutesList(el);
  } catch (err) {
    el.innerHTML = `<div class="error-msg">${escHtml(err.message)}</div>`;
  }
}

// ─── Routes List ───────────────────────────────────────────────

function renderRoutesList(el) {
  if (!routesList.length) {
    el.innerHTML = '<div class="empty">Маршруты не найдены</div>';
    return;
  }
  el.innerHTML = routesList.map((r, i) => {
    const cfz = r.cfzAddresses || [];
    const cfzStr = cfz.slice(0, 3).map(a => escHtml(a.address)).join(', ') + (cfz.length > 3 ? '…' : '');

    // Для отгрузки: показываем, какие ЦФЗ уже заполнены
    let partialInfo = '';
    if (opType === 'ship' && r.shipment) {
      const done = (r.shipment.items || []).length;
      partialInfo = `<div class="card-partial">Заполнено ${done} из ${cfz.length} адресов</div>`;
    }

    return `
      <div class="card route-card" data-idx="${i}">
        <div class="route-card-top">
          <span class="card-date">${fmtDate(r.date)}</span>
          <span class="card-main">${escHtml(r.routeNumber || '—')}</span>
          ${r.vehicle ? `<span class="card-vehicle">${escHtml(r.vehicle.number || '')}</span>` : ''}
        </div>
        ${r.driver ? `<div class="card-driver">${escHtml(r.driver.name || '')}</div>` : ''}
        ${cfzStr ? `<div class="card-cfz">${cfzStr}</div>` : ''}
        ${partialInfo}
      </div>
    `;
  }).join('');
  el.querySelectorAll('.route-card').forEach(card => {
    card.addEventListener('click', () => goToData(routesList[Number(card.dataset.idx)]));
  });
}

// ─── Route Data Entry ──────────────────────────────────────────

function renderRouteData() {
  const r = selectedRoute;
  document.getElementById('route-info').innerHTML = `
    <div class="route-info-num">${escHtml(r.routeNumber || '—')}</div>
    <div class="route-info-meta">${fmtDate(r.date)}${r.driver ? ` · ${escHtml(r.driver.name)}` : ''}${r.vehicle ? ` · ${escHtml(r.vehicle.number)}` : ''}</div>
    ${opType === 'receive' && r.shippedRK != null ? `<div class="route-info-shipped">Отгружено РК: ${r.shippedRK}</div>` : ''}
  `;

  const cfz = r.cfzAddresses || [];
  const cfzEl = document.getElementById('cfz-list');
  if (!cfz.length) {
    cfzEl.innerHTML = '<div class="empty">Нет адресов ЦФЗ</div>';
    return;
  }

  const existingItems = opType === 'ship' ? r.shipment?.items : r.receiving?.items;
  const existingMap = Object.fromEntries((existingItems || []).map(i => [i.address, i.rk]));

  cfzEl.innerHTML = cfz.map(a => {
    const shippedRk = opType === 'receive'
      ? (r.shipment?.items?.find(x => x.address === a.address)?.rk ?? null)
      : null;
    return `
      <div class="cfz-row">
        <span class="cfz-addr">${escHtml(a.address)}</span>
        ${shippedRk != null ? `<span class="cfz-shipped">отгр. ${shippedRk}</span>` : ''}
        <input type="number" class="cfz-input" data-addr="${escHtml(a.address)}"
          inputmode="numeric" min="0" placeholder="РК"
          value="${existingMap[a.address] ?? ''}">
      </div>
    `;
  }).join('');
}

// ─── Photos ────────────────────────────────────────────────────

function onPhotoSelected(e) {
  photoFiles.push(...Array.from(e.target.files || []));
  renderPhotos();
  e.target.value = '';
}

function renderPhotos() {
  const el = document.getElementById('photos-preview');
  if (!photoFiles.length) { el.innerHTML = ''; return; }
  el.innerHTML = photoFiles.map((f, i) => `
    <div class="photo-item">
      <img src="${URL.createObjectURL(f)}" class="photo-thumb" alt="">
      <button class="photo-remove" data-idx="${i}" type="button">×</button>
    </div>
  `).join('');
  el.querySelectorAll('.photo-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      photoFiles.splice(Number(btn.dataset.idx), 1);
      renderPhotos();
    });
  });
}

// ─── Submit ────────────────────────────────────────────────────

async function submit() {
  const statusEl = document.getElementById('submit-status');
  const btn = document.getElementById('submit-btn');
  statusEl.style.display = 'none';

  const gate = document.getElementById('gate-input').value.trim();
  const items = [];
  document.querySelectorAll('.cfz-input').forEach(input => {
    const val = input.value.trim();
    if (val !== '' && !isNaN(Number(val)) && Number(val) >= 0) {
      items.push({ address: input.dataset.addr, rk: Number(val) });
    }
  });

  if (!items.length) {
    showStatus(statusEl, 'error', 'Введите количество РК хотя бы для одного адреса');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Сохраняю...';

  try {
    let photos = [];
    if (photoFiles.length) {
      const fd = new FormData();
      photoFiles.forEach(f => fd.append('photos', f));
      const r = await fetch('/api/rk/photos', { method: 'POST', credentials: 'include', body: fd });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Ошибка загрузки фото');
      photos = d.urls;
    }

    const action = opType === 'ship' ? 'ship' : 'receive';
    await apiFetch(`/api/rk/routes/${encodeURIComponent(selectedRoute.routeId)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ by: employeeName, gate, items, photos }),
    });

    showStatus(statusEl, 'success', opType === 'ship' ? '✅ Отгрузка сохранена!' : '✅ Приёмка сохранена!');
    btn.style.display = 'none';
    setTimeout(goToType, 2000);
  } catch (err) {
    showStatus(statusEl, 'error', err.message);
    btn.disabled = false;
    btn.textContent = opType === 'ship' ? 'Сохранить отгрузку' : 'Сохранить приёмку';
  }
}

function showStatus(el, type, msg) {
  el.className = type === 'success' ? 'success-msg' : 'error-msg';
  el.textContent = msg;
  el.style.display = 'block';
}

// ─── Utils ─────────────────────────────────────────────────────

async function apiFetch(url, options = {}) {
  const { headers: extraHeaders = {}, ...restOptions } = options;
  const r = await fetch(url, {
    credentials: 'include',
    ...restOptions,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

init();
