/**
 * auth.js — авторизация /vs: сессия (cookie) + токен Samokat, роли и модули
 *
 * Логика: токен получаем на первичной авторизации; если не получен — дальше не пропускаем.
 * Сессия хранится в cookie (vs_sid), токен Samokat — в памяти и refresh в localStorage.
 */

import * as api from './api.js';

const LS_REFRESH_KEY = 'wms_refresh_token';

let accessToken = null;
let accessTokenExpiry = null;
let refreshToken = null;
let refreshTimer = null;
let onAuthChange = null;
let currentRole = null;
let currentModules = [];
let currentCompanyIds = [];

export function getToken() {
  return accessToken;
}

export function isLoggedIn() {
  return !!accessToken;
}

export function getRole() {
  return currentRole;
}

export function getModules() {
  return currentModules.length ? [...currentModules] : [];
}

/** Для роли «Менеджер» — список компаний, по которым доступны данные. */
export function getCompanyIds() {
  return currentCompanyIds.length ? [...currentCompanyIds] : [];
}

export function setOnAuthChange(cb) {
  onAuthChange = cb;
}

function setRoleModules(role, modules, companyIds) {
  currentRole = role || null;
  currentModules = Array.isArray(modules) ? modules : [];
  currentCompanyIds = Array.isArray(companyIds) ? companyIds : [];
}

function notifyChange(loggedIn) {
  if (onAuthChange) onAuthChange(loggedIn);
}

// ─── Сохранение refreshToken в localStorage ──────────────────────────────────

function saveRefreshToken(token) {
  refreshToken = token;
  if (token) {
    try { localStorage.setItem(LS_REFRESH_KEY, token); } catch { /* ignore */ }
  } else {
    try { localStorage.removeItem(LS_REFRESH_KEY); } catch { /* ignore */ }
  }
}

function loadRefreshTokenFromStorage() {
  try { return localStorage.getItem(LS_REFRESH_KEY) || null; } catch { return null; }
}

// ─── Публичные функции ───────────────────────────────────────────────────────

/** Вход через backend /vs: сессия + токен Samokat (или без токена, если разрешено). */
export async function login(loginValue, password) {
  const data = await api.loginVs(loginValue, password);
  if (!data?.ok) throw new Error(data?.error || 'Ошибка входа');

  setRoleModules(data.role, data.modules, data.companyIds);

  if (data?.allowWithoutToken) {
    accessToken = null;
    accessTokenExpiry = null;
    saveRefreshToken(null);
    notifyChange(true);
    return;
  }

  if (!data?.accessToken) throw new Error('Токен не получен — вход невозможен');
  accessToken = data.accessToken;
  accessTokenExpiry = Date.now() + (data.expiresIn || 300) * 1000;
  saveRefreshToken(data.refreshToken || null);
  setRoleModules(data.role, data.modules, data.companyIds);
  await api.putConfig({ token: accessToken, refreshToken: refreshToken || '' });
  scheduleRefresh();
  notifyChange(true);
}

export async function logout() {
  await api.logoutVs();
  accessToken = null;
  accessTokenExpiry = null;
  saveRefreshToken(null);
  setRoleModules(null, [], []);
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  notifyChange(false);
}

/**
 * Восстановление при загрузке: сессия /vs (cookie), затем токен Samokat (если не «без токена»).
 */
export async function tryRestoreSession() {
  const me = await api.getVsMe();
  if (!me?.role) {
    notifyChange(false);
    return false;
  }
  setRoleModules(me.role, me.modules || [], me.companyIds);

  if (me.allowWithoutToken) {
    accessToken = null;
    saveRefreshToken(null);
    notifyChange(true);
    return true;
  }

  const stored = loadRefreshTokenFromStorage();
  if (!stored) {
    notifyChange(false);
    return false;
  }
  refreshToken = stored;
  const ok = await doRefresh();
  if (!ok) {
    saveRefreshToken(null);
    notifyChange(false);
    return false;
  }
  return true;
}

// ─── Внутренние функции ──────────────────────────────────────────────────────

async function doRefresh() {
  if (!refreshToken) return false;
  try {
    const data = await api.refreshSamokatToken(refreshToken);
    if (!data?.value?.accessToken) return false;

    accessToken = data.value.accessToken;
    accessTokenExpiry = Date.now() + (data.value.expiresIn || 300) * 1000;

    // Обновляем refreshToken если пришёл новый
    if (data.value.refreshToken) saveRefreshToken(data.value.refreshToken);

    // Синхронизируем с сервером для фонового автосбора
    await api.putConfig({ token: accessToken, refreshToken: refreshToken || '' });

    notifyChange(true);
    scheduleRefresh();
    return true;
  } catch {
    return false;
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!accessTokenExpiry) return;
  // Обновляем за 60 секунд до истечения, минимум через 10 секунд
  const delay = Math.max(10000, accessTokenExpiry - Date.now() - 60000);
  refreshTimer = setTimeout(async () => {
    const ok = await doRefresh();
    if (!ok) {
      accessToken = null;
      saveRefreshToken(null);
      notifyChange(false);
    }
  }, delay);
}
