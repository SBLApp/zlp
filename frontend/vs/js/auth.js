/**
 * auth.js — авторизация /vs: сессия (cookie) + токен Samokat, роли и модули
 *
 * Логика: токен получаем на первичной авторизации; если не получен — дальше не пропускаем.
 * Сессия хранится в cookie (vs_sid). Access- и refresh-токены Samokat — в localStorage,
 * чтобы после перезагрузки страницы токен восстанавливался без повторного ввода пароля.
 */

import * as api from './api.js';

const LS_REFRESH_KEY = 'wms_refresh_token';
const LS_ACCESS_KEY = 'wms_access_token';
const LS_ACCESS_EXPIRY_KEY = 'wms_access_token_expiry';
const EXPIRY_MARGIN_MS = 60 * 1000; // считаем токен недействительным за 1 мин до истечения

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

// ─── Сохранение токенов в localStorage (постоянная поддержка после перезагрузки) ─

function saveRefreshToken(token) {
  refreshToken = token;
  if (token) {
    try { localStorage.setItem(LS_REFRESH_KEY, token); } catch { /* ignore */ }
  } else {
    try { localStorage.removeItem(LS_REFRESH_KEY); } catch { /* ignore */ }
  }
}

function saveAccessToken(token, expiryMs) {
  accessToken = token;
  accessTokenExpiry = expiryMs || null;
  if (token) {
    try {
      localStorage.setItem(LS_ACCESS_KEY, token);
      localStorage.setItem(LS_ACCESS_EXPIRY_KEY, String(expiryMs || 0));
    } catch { /* ignore */ }
  } else {
    try {
      localStorage.removeItem(LS_ACCESS_KEY);
      localStorage.removeItem(LS_ACCESS_EXPIRY_KEY);
    } catch { /* ignore */ }
  }
}

function loadRefreshTokenFromStorage() {
  try { return localStorage.getItem(LS_REFRESH_KEY) || null; } catch { return null; }
}

function loadAccessTokenFromStorage() {
  try {
    const token = localStorage.getItem(LS_ACCESS_KEY);
    const expiry = parseInt(localStorage.getItem(LS_ACCESS_EXPIRY_KEY) || '0', 10);
    if (!token || expiry <= 0) return null;
    if (expiry <= Date.now() + EXPIRY_MARGIN_MS) return null;
    return { token, expiry };
  } catch { return null; }
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
  const expiry = Date.now() + (data.expiresIn || 300) * 1000;
  saveRefreshToken(data.refreshToken || null);
  saveAccessToken(data.accessToken, expiry);
  setRoleModules(data.role, data.modules, data.companyIds);
  await api.putConfig({ token: accessToken, refreshToken: refreshToken || '' });
  scheduleRefresh();
  notifyChange(true);
}

export async function logout() {
  await api.logoutVs();
  saveAccessToken(null);
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
    saveAccessToken(null);
    saveRefreshToken(null);
    notifyChange(true);
    return true;
  }

  const storedAccess = loadAccessTokenFromStorage();
  if (storedAccess) {
    accessToken = storedAccess.token;
    accessTokenExpiry = storedAccess.expiry;
    scheduleRefresh();
    notifyChange(true);
    return true;
  }

  const storedRefresh = loadRefreshTokenFromStorage();
  if (!storedRefresh) {
    notifyChange(false);
    return false;
  }
  refreshToken = storedRefresh;
  const ok = await doRefresh();
  if (!ok) {
    saveAccessToken(null);
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

    const expiry = Date.now() + (data.value.expiresIn || 300) * 1000;
    saveAccessToken(data.value.accessToken, expiry);

    if (data.value.refreshToken) saveRefreshToken(data.value.refreshToken);

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
      saveAccessToken(null);
      saveRefreshToken(null);
      notifyChange(false);
    }
  }, delay);
}
