/**
 * vs-auth.js — сессии и роли для страницы /vs
 * Роли: admin, group_leader, supervisor, manager
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VS_USERS_PATH = path.join(__dirname, 'vs-users.json');
const VS_LOGINS_PATH = path.join(__dirname, 'data', 'vs-logins.json');
const VS_TELEGRAM_BIND_PATH = path.join(__dirname, 'data', 'vs-telegram-bind.json');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней
const BIND_CODE_TTL_MS = 5 * 60 * 1000; // 5 мин

/** Модули интерфейса: stats, data, monitor, consolidation, docs, settings */
const MODULES_BY_ROLE = {
  admin: ['stats', 'data', 'monitor', 'consolidation', 'docs', 'settings'],
  group_leader: ['stats', 'data', 'monitor', 'consolidation', 'docs', 'settings'],
  supervisor: ['stats', 'data', 'monitor', 'docs'],
  manager: ['stats', 'data', 'monitor', 'docs'],
};

const ALL_MODULES = ['stats', 'data', 'monitor', 'consolidation', 'docs', 'settings'];

const sessions = new Map();

function loadVsUsers() {
  try {
    const raw = fs.readFileSync(VS_USERS_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.users) ? data.users : [];
  } catch {
    return [];
  }
}

function saveVsUsers(users) {
  const dir = path.dirname(VS_USERS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VS_USERS_PATH, JSON.stringify({ users }, null, 2), 'utf8');
}

function loadLogins() {
  try {
    if (!fs.existsSync(VS_LOGINS_PATH)) return {};
    const raw = fs.readFileSync(VS_LOGINS_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data.logins && typeof data.logins === 'object' ? data.logins : {};
  } catch {
    return {};
  }
}

function saveLogins(logins) {
  const dir = path.dirname(VS_LOGINS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VS_LOGINS_PATH, JSON.stringify({ logins }, null, 2), 'utf8');
}

/** Нормализация логина (телефон) для сравнения */
function normalizeLogin(login) {
  return String(login || '').replace(/\D/g, '').slice(-10);
}

/** Буквенный логин (не телефон): содержит буквы */
function isLetterLogin(login) {
  return /[a-zA-Zа-яА-ЯёЁ]/.test(String(login || '').trim());
}

/** Хеш пароля для хранения (соль:хеш в hex). */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const idx = stored.indexOf(':');
  if (idx <= 0) return false;
  const salt = Buffer.from(stored.slice(0, idx), 'hex');
  const hash = Buffer.from(stored.slice(idx + 1), 'hex');
  const got = crypto.scryptSync(String(password), salt, 64);
  return got.length === hash.length && crypto.timingSafeEqual(got, hash);
}

/** Записать попытку входа. success = true если получен токен. */
function recordLoginAttempt(login, success) {
  const key = String(login || '').trim() || 'unknown';
  const logins = loadLogins();
  const now = new Date().toISOString();
  if (!logins[key]) logins[key] = { lastAttemptAt: null, lastSuccessAt: null };
  logins[key].lastAttemptAt = now;
  if (success) logins[key].lastSuccessAt = now;
  saveLogins(logins);
}

/**
 * Найти пользователя по логину. Возвращает { role, shiftType?, companyIds?, modules?, passwordHash? } или null.
 * Для буквенных логинов (passwordHash) сравнение по trim+lowercase.
 */
function findUserByLogin(login) {
  const trimmed = String(login || '').trim();
  const normalized = normalizeLogin(login);
  const users = loadVsUsers();
  for (const u of users) {
    let match = false;
    if (u.passwordHash) {
      match = trimmed.toLowerCase() === String(u.login || '').trim().toLowerCase();
    } else {
      const uLogin = normalizeLogin(u.login);
      match = uLogin && (uLogin === normalized || u.login === login);
    }
    if (match) {
      const role = ['admin', 'group_leader', 'supervisor', 'manager'].includes(u.role) ? u.role : 'manager';
      const modules = Array.isArray(u.modules) && u.modules.length > 0
        ? u.modules.filter(m => ALL_MODULES.includes(m))
        : (MODULES_BY_ROLE[role] || MODULES_BY_ROLE.manager);
      return {
        role,
        shiftType: u.shiftType === 'day' || u.shiftType === 'night' ? u.shiftType : undefined,
        companyIds: Array.isArray(u.companyIds) ? u.companyIds : undefined,
        modules,
        allowWithoutToken: !!u.allowWithoutToken,
        passwordHash: u.passwordHash || undefined,
      };
    }
  }
  return null;
}

function createSessionId() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Создать сессию после успешной авторизации Samokat.
 * user: { role, shiftType?, companyIds?, modules? }, login: string
 */
function createSession(user, login) {
  const sid = createSessionId();
  const session = {
    login: String(login || ''),
    role: user.role,
    shiftType: user.shiftType,
    companyIds: user.companyIds,
    modules: user.modules || getModulesForRole(user.role),
    allowWithoutToken: !!user.allowWithoutToken,
    createdAt: Date.now(),
  };
  sessions.set(sid, session);
  return sid;
}

function getSession(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function destroySession(sessionId) {
  if (sessionId) sessions.delete(sessionId);
}

function getModulesForRole(role) {
  return MODULES_BY_ROLE[role] || MODULES_BY_ROLE.manager;
}

/** Список пользователей для админа: из vs-users + данные о входах (успешный = получил токен). */
function getAllUsersForAdmin() {
  const users = loadVsUsers();
  const logins = loadLogins();
  const byLogin = new Map();
  for (const u of users) {
    const login = String(u.login || '').trim();
    if (!login) continue;
    const role = ['admin', 'group_leader', 'supervisor', 'manager'].includes(u.role) ? u.role : 'manager';
    const modules = Array.isArray(u.modules) && u.modules.length > 0
      ? u.modules.filter(m => ALL_MODULES.includes(m))
      : (MODULES_BY_ROLE[role] || MODULES_BY_ROLE.manager);
    const rec = logins[login] || {};
    byLogin.set(login, {
      login,
      role,
      shiftType: u.shiftType === 'day' || u.shiftType === 'night' ? u.shiftType : undefined,
      companyIds: Array.isArray(u.companyIds) ? u.companyIds : undefined,
      modules,
      allowWithoutToken: !!u.allowWithoutToken,
      hasPassword: !!u.passwordHash,
      lastAttemptAt: rec.lastAttemptAt || null,
      lastSuccessAt: rec.lastSuccessAt || null,
      hasAccess: true,
    });
  }
  for (const [login, rec] of Object.entries(logins)) {
    if (!byLogin.has(login)) {
      byLogin.set(login, {
        login,
        role: null,
        shiftType: undefined,
        companyIds: undefined,
        modules: [],
        lastAttemptAt: rec.lastAttemptAt || null,
        lastSuccessAt: rec.lastSuccessAt || null,
        hasAccess: false,
      });
    }
  }
  return Array.from(byLogin.values()).sort((a, b) => (a.login || '').localeCompare(b.login || ''));
}

function userLoginMatch(u, login, normalized, trimmedLogin) {
  if (u.passwordHash) return trimmedLogin.toLowerCase() === String(u.login || '').trim().toLowerCase();
  return normalizeLogin(u.login) === normalized && normalized || u.login === login;
}

/** Сохранить/обновить пользователя (роль, модули, пароль). Только для админа. */
function saveUser(login, payload) {
  const normalized = normalizeLogin(login);
  const trimmedLogin = String(login || '').trim();
  if (!trimmedLogin) throw new Error('Логин не указан');
  const users = loadVsUsers();
  let found = false;
  for (const u of users) {
    if (!userLoginMatch(u, login, normalized, trimmedLogin)) continue;
    if (payload.role !== undefined) u.role = ['admin', 'group_leader', 'supervisor', 'manager'].includes(payload.role) ? payload.role : 'manager';
    if (payload.modules !== undefined) u.modules = Array.isArray(payload.modules) ? payload.modules.filter(m => ALL_MODULES.includes(m)) : undefined;
    if (payload.shiftType !== undefined) u.shiftType = payload.shiftType === 'day' || payload.shiftType === 'night' ? payload.shiftType : undefined;
    if (payload.companyIds !== undefined) u.companyIds = Array.isArray(payload.companyIds) ? payload.companyIds : undefined;
    if (payload.allowWithoutToken !== undefined) u.allowWithoutToken = !!payload.allowWithoutToken;
    if (payload.password !== undefined && String(payload.password).trim() !== '') {
      u.passwordHash = hashPassword(payload.password.trim());
    }
    found = true;
    break;
  }
  if (!found) {
    const role = ['admin', 'group_leader', 'supervisor', 'manager'].includes(payload.role) ? payload.role : 'manager';
    const modules = Array.isArray(payload.modules) ? payload.modules.filter(m => ALL_MODULES.includes(m)) : undefined;
    const newUser = {
      login: trimmedLogin,
      role,
      shiftType: payload.shiftType === 'day' || payload.shiftType === 'night' ? payload.shiftType : undefined,
      companyIds: Array.isArray(payload.companyIds) ? payload.companyIds : undefined,
      modules: modules && modules.length > 0 ? modules : undefined,
      allowWithoutToken: !!payload.allowWithoutToken,
    };
    if (payload.password !== undefined && String(payload.password).trim() !== '') {
      newUser.passwordHash = hashPassword(payload.password.trim());
    }
    users.push(newUser);
  }
  saveVsUsers(users);
}

/** Удалить доступ пользователя (убрать из vs-users). */
function removeUser(login) {
  const trimmed = String(login || '').trim();
  const normalized = normalizeLogin(login);
  const users = loadVsUsers().filter(u => !userLoginMatch(u, login, normalized, trimmed));
  saveVsUsers(users);
}

/** Telegram chat_id для пользователя (менеджер — отчёты в личку). */
function getTelegramChatId(login) {
  const trimmed = String(login || '').trim();
  const normalized = normalizeLogin(login);
  const users = loadVsUsers();
  for (const u of users) {
    if (!userLoginMatch(u, login, normalized, trimmed)) continue;
    const id = u.telegramChatId;
    return id != null && String(id).trim() !== '' ? String(id).trim() : null;
  }
  return null;
}

function setTelegramChatId(login, chatId) {
  const trimmed = String(login || '').trim();
  const normalized = normalizeLogin(login);
  const users = loadVsUsers();
  for (const u of users) {
    if (!userLoginMatch(u, login, normalized, trimmed)) continue;
    u.telegramChatId = chatId != null ? String(chatId).trim() : '';
    saveVsUsers(users);
    return;
  }
}

// ─── Коды привязки Telegram (одноразовые, по времени) ─────────────────────────

function loadBindingCodes() {
  try {
    if (!fs.existsSync(VS_TELEGRAM_BIND_PATH)) return {};
    const raw = fs.readFileSync(VS_TELEGRAM_BIND_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data.codes && typeof data.codes === 'object' ? data.codes : {};
  } catch {
    return {};
  }
}

function saveBindingCodes(codes) {
  const dir = path.dirname(VS_TELEGRAM_BIND_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VS_TELEGRAM_BIND_PATH, JSON.stringify({ codes }, null, 2), 'utf8');
}

function addBindingCode(code, login) {
  const codes = loadBindingCodes();
  codes[String(code).toUpperCase()] = {
    login: String(login || '').trim(),
    expiresAt: Date.now() + BIND_CODE_TTL_MS,
  };
  saveBindingCodes(codes);
}

/** Вернуть login и удалить код, если он валидный и не истёк. Иначе null. */
function consumeBindingCode(code) {
  const key = String(code).trim().toUpperCase();
  if (!key) return null;
  const codes = loadBindingCodes();
  const entry = codes[key];
  if (!entry || Date.now() > entry.expiresAt) return null;
  delete codes[key];
  saveBindingCodes(codes);
  return entry.login;
}

function createBindingCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

module.exports = {
  loadVsUsers,
  findUserByLogin,
  createSession,
  getSession,
  destroySession,
  getModulesForRole,
  recordLoginAttempt,
  getAllUsersForAdmin,
  saveUser,
  removeUser,
  getTelegramChatId,
  setTelegramChatId,
  addBindingCode,
  consumeBindingCode,
  createBindingCode,
  loadBindingCodes,
  verifyPassword,
  isLetterLogin,
  MODULES_BY_ROLE,
  ALL_MODULES,
  VS_USERS_PATH,
};
