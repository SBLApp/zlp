const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const scheduler = require('./scheduler');
const dataCollector = require('./data-collector');
const storage = require('./storage');
const vsAuth = require('./vs-auth');

const app = express();
app.use(cookieParser());
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'config.json');

try {
  app.use(require('compression')());
} catch (_) {
  // compression не установлен — сервер работает без gzip
}

// ✅ МАКСИМАЛЬНЫЙ ЛИМИТ - 1 ГИГАБАЙТ
app.use(express.json({ limit: '1024mb' }));
app.use(express.urlencoded({ extended: true, limit: '1024mb' }));

const DEFAULT_CONFIG = {
  token: '',
  refreshToken: '',
  intervalMinutes: 60,
  pageSize: 500,
  apiUrl: 'https://api.samokat.ru/wmsops-wwh/stocks/changes/search',
  useVpn: true,
  cookie: '',
  telegramBotToken: '',
  telegramChatId: '',
  telegramThreadId: '',
  telegramChats: [], // [{ chatId, threadIdConsolidation?, threadIdStats?, label? }] — несколько чатов/пользователей
  telegramTimezone: 'Europe/Moscow', // часовой пояс для времени в уведомлениях (например Europe/Kaliningrad для UTC+2)
};

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { ...DEFAULT_CONFIG };
    const out = { ...DEFAULT_CONFIG, ...config };
    if (!Array.isArray(out.telegramChats)) out.telegramChats = [];
    // Миграция: старые чаты с одним threadId → раздельные (консолидация + статистика)
    for (const chat of out.telegramChats) {
      if (chat.threadId && !chat.threadIdConsolidation && !chat.threadIdStats) {
        chat.threadIdConsolidation = chat.threadId;
        chat.threadIdStats = chat.threadId;
      }
      if (chat.enabled === undefined) chat.enabled = true;
      if (!Array.isArray(chat.companiesFilter)) chat.companiesFilter = [];
    }
    if (out.telegramChats.length === 0 && (out.telegramChatId || '').trim()) {
      out.telegramChats = [{
        chatId: String(out.telegramChatId).trim(),
        threadIdConsolidation: String(out.telegramThreadId || '').trim(),
        threadIdStats: String(out.telegramThreadId || '').trim(),
        label: '',
        enabled: true,
        companiesFilter: [],
      }];
    }
    return out;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Список чатов для отправки: из telegramChats, только enabled !== false. companiesFilter: пустой = все компании. */
function getTelegramChats(config) {
  const list = Array.isArray(config.telegramChats) && config.telegramChats.length > 0
    ? config.telegramChats
    : (config.telegramChatId && String(config.telegramChatId).trim()
      ? [{
          chatId: String(config.telegramChatId).trim(),
          threadIdConsolidation: String(config.telegramThreadId || '').trim(),
          threadIdStats: String(config.telegramThreadId || '').trim(),
          enabled: true,
          companiesFilter: [],
        }]
      : []);
  return list
    .filter(c => c.enabled !== false && String(c.chatId || '').trim())
    .map(c => ({
      chatId: String(c.chatId || '').trim(),
      threadIdConsolidation: parseTelegramThreadId(c.threadIdConsolidation) || parseTelegramThreadId(c.threadId),
      threadIdStats: parseTelegramThreadId(c.threadIdStats) || parseTelegramThreadId(c.threadId),
      companiesFilter: Array.isArray(c.companiesFilter) ? c.companiesFilter.filter(x => x != null && String(x).trim()) : [],
    }));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

async function doFetch() {
  try {
    const result = await dataCollector.fetchFromAPI();
    return { success: true, ...result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      status: err.status,
      data: err.data,
    };
  }
}

scheduler.setFetchHandler(doFetch);

// API-маршруты регистрируем до статики, чтобы POST /api/empl и др. не отдавали index.html
app.get('/api/status', (req, res) => {
  try {
    const config = loadConfig();
    res.json({
      scheduleRunning: scheduler.isRunning(),
      tokenRefresherRunning: false,
      lastRun: scheduler.getLastRun(),
      config: {
        ...config,
        token: config.token ? '***' : '',
        refreshToken: config.refreshToken ? '***' : '',
        cookie: config.cookie ? '***' : '',
        intervalMinutes: config.intervalMinutes ?? 60,
        pageSize: config.pageSize ?? 500,
      },
    });
  } catch (err) {
    console.error('GET /api/status', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fetch-data', async (req, res) => {
  try {
    const config = loadConfig();
    const token = req.body?.token || config.token;
    const options = req.body?.options || {};
    const result = await dataCollector.fetchFromAPI(token, options);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || 'Ошибка запроса данных';
    if (status >= 500) console.error('POST /api/fetch-data:', message);
    else console.error('POST /api/fetch-data', err);
    res.status(status).json({
      success: false,
      error: message,
      data: err.data,
    });
  }
});

app.get('/api/config', (req, res) => {
  try {
    const c = loadConfig();
    const out = { ...c, token: c.token ? '***' : '' };
    if (out.refreshToken) out.refreshToken = '***';
    if (out.cookie) out.cookie = '***';
    if (out.telegramBotToken) out.telegramBotToken = '***';
    res.json(out);
  } catch (err) {
    console.error('GET /api/config', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config', (req, res) => {
  try {
    const body = req.body || {};
    const config = loadConfig();
    
    if (body.token !== undefined) config.token = String(body.token).trim();
    if (body.refreshToken !== undefined) config.refreshToken = String(body.refreshToken).trim();
    if (body.connectionMode !== undefined) config.connectionMode = body.connectionMode;
    if (body.intervalMinutes !== undefined) config.intervalMinutes = Math.max(1, parseInt(body.intervalMinutes, 10) || 60);
    if (body.pageSize !== undefined) config.pageSize = Math.min(1000, Math.max(1, parseInt(body.pageSize, 10) || 500));
    if (body.useVpn !== undefined) config.useVpn = !!body.useVpn;
    if (body.cookie !== undefined) config.cookie = typeof body.cookie === 'string' ? body.cookie : '';
    if (body.telegramBotToken !== undefined) config.telegramBotToken = typeof body.telegramBotToken === 'string' ? body.telegramBotToken.trim() : '';
    if (body.telegramChatId !== undefined) config.telegramChatId = typeof body.telegramChatId === 'string' ? body.telegramChatId.trim() : '';
    if (body.telegramThreadId !== undefined) config.telegramThreadId = typeof body.telegramThreadId === 'string' ? body.telegramThreadId.trim() : '';
    if (body.telegramChats !== undefined) {
      config.telegramChats = Array.isArray(body.telegramChats)
        ? body.telegramChats.map(c => ({
            chatId: String(c.chatId != null ? c.chatId : '').trim(),
            threadIdConsolidation: String(c.threadIdConsolidation != null ? c.threadIdConsolidation : '').trim(),
            threadIdStats: String(c.threadIdStats != null ? c.threadIdStats : '').trim(),
            label: String(c.label != null ? c.label : '').trim(),
            enabled: c.enabled !== false,
            companiesFilter: Array.isArray(c.companiesFilter) ? c.companiesFilter.map(x => String(x).trim()).filter(Boolean) : [],
          })).filter(c => c.chatId)
        : [];
      if (config.telegramChats.length === 0) config.telegramChatId = '';
      if (config.telegramChats.length === 0) config.telegramThreadId = '';
    }
    if (body.telegramTimezone !== undefined) config.telegramTimezone = typeof body.telegramTimezone === 'string' && body.telegramTimezone.trim() ? body.telegramTimezone.trim() : 'Europe/Moscow';
    saveConfig(config);
    
    const out = { ...config, token: config.token ? '***' : '' };
    if (out.refreshToken) out.refreshToken = '***';
    if (out.cookie) out.cookie = '***';
    if (out.telegramBotToken) out.telegramBotToken = '***';
    
    res.json({ ok: true, config: out });
  } catch (err) {
    console.error('PUT /api/config', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/history', (req, res) => {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) return res.json([]);
  const files = fs.readdirSync(dataDir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.light.json'))
    .map(f => {
      const stat = fs.statSync(path.join(dataDir, f));
      return { name: f, mtime: stat.mtime, size: stat.size };
    })
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime))
    .slice(0, 50);
  res.json(files);
});

app.get('/api/data/:filename', (req, res) => {
  const name = path.basename(req.params.filename);
  if (!name.endsWith('.json') || name.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(__dirname, 'data', name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  res.json(data);
});

const DATA_DIR = path.join(__dirname, 'data');
const EMPL_CSV_PATH = path.join(__dirname, '..', 'empl.csv');

// ─── Консолидация: multer + paths ──────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const CONSOLIDATION_PATH = path.join(__dirname, 'data', 'consolidation.json');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Только изображения'));
  },
});

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Только изображения (PNG)'));
  },
});

function loadComplaints() {
  try {
    if (!fs.existsSync(CONSOLIDATION_PATH)) return [];
    return JSON.parse(fs.readFileSync(CONSOLIDATION_PATH, 'utf8'));
  } catch { return []; }
}

function saveComplaints(list) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONSOLIDATION_PATH, JSON.stringify(list, null, 2), 'utf8');
}

function tgSafe(v) {
  return String(v == null ? '' : v).trim();
}

function escapeTgHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Экранирование для Telegram Markdown (* и _ в контенте не должны ломать разметку) */
function escapeTgMarkdown(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[');
}

function formatComplaintForTelegram(c, photoUrl, config = {}, companyResolved = null) {
  const dt = c?.operationCompletedAt || c?.createdAt || '';
  const tz = (config && config.telegramTimezone) || 'Europe/Moscow';
  const dateText = dt
    ? new Date(dt).toLocaleString('ru-RU', { timeZone: tz })
    : '—';
  const company = companyResolved != null ? companyResolved : (c.company != null && String(c.company).trim() !== '' ? c.company : '—');
  const v = (x) => escapeTgMarkdown(tgSafe(x) || '—');
  const dateEsc = escapeTgMarkdown(dateText);
  // Markdown: *текст* = жирный в Telegram
  return [
    `*Компания:* ${v(company)}`,
    `*Нарушитель:* ${v(c.violator)}`,
    `*Место:* ${v(c.cell)}`,
    `*ЕО:* ${v(c.handlingUnitBarcode)}`,
    `*ШК:* ${v(c.productBarcode)}`,
    `*Товар:* ${v(c.productName)}`,
    `*Время:* ${dateEsc}`,
    `*Фото:* ${photoUrl ? '✅' : '—'}`,
  ].join('\n');
}

function parseTelegramThreadId(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

async function sendTelegramMessage(botToken, chatId, text, threadId = null, parseMode = null) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (threadId) payload.message_thread_id = threadId;
  if (parseMode) payload.parse_mode = parseMode;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const e = new Error(data?.description || `Telegram API ${response.status}`);
    e.status = response.status;
    throw e;
  }
}

async function sendTelegramPhoto(botToken, chatId, caption, photoPath, photoFilename = 'photo.jpg', threadId = null, parseMode = null) {
  const fileBuf = fs.readFileSync(photoPath);
  return sendTelegramPhotoFromBuffer(botToken, chatId, caption, fileBuf, photoFilename, threadId, parseMode);
}

async function sendTelegramPhotoFromBuffer(botToken, chatId, caption, buffer, photoFilename = 'photo.png', threadId = null, parseMode = null) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (threadId) form.append('message_thread_id', String(threadId));
  if (caption) form.append('caption', caption);
  if (parseMode) form.append('parse_mode', parseMode);
  const blob = new Blob([buffer]);
  form.append('photo', blob, photoFilename);
  const response = await fetch(url, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const e = new Error(data?.description || `Telegram API ${response.status}`);
    e.status = response.status;
    throw e;
  }
}

async function sendTelegramDocumentFromBuffer(botToken, chatId, caption, buffer, documentFilename = 'file.png', threadId = null) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendDocument`;
  const form = new FormData();
  form.append('chat_id', chatId);
  if (threadId) form.append('message_thread_id', String(threadId));
  if (caption) form.append('caption', caption);
  const blob = new Blob([buffer]);
  form.append('document', blob, documentFilename);
  const response = await fetch(url, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const e = new Error(data?.description || `Telegram API ${response.status}`);
    e.status = response.status;
    throw e;
  }
}

async function sendTelegramMediaGroup(botToken, chatId, caption, files, threadId = null, parseMode = null) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMediaGroup`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (threadId) form.append('message_thread_id', String(threadId));

  const media = files.map((f, i) => {
    const item = { type: 'photo', media: `attach://photo${i}` };
    if (i === 0 && caption) {
      item.caption = caption;
      if (parseMode) item.parse_mode = parseMode;
    }
    return item;
  });
  form.append('media', JSON.stringify(media));

  files.forEach((f, i) => {
    const buf = fs.readFileSync(f.path);
    const blob = new Blob([buf]);
    form.append(`photo${i}`, blob, f.name || `photo_${i + 1}.jpg`);
  });

  const response = await fetch(url, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const e = new Error(data?.description || `Telegram API ${response.status}`);
    e.status = response.status;
    throw e;
  }
}

// save-fetched-data: только мерж в почасовые файлы (лёгкий формат). Без тяжёлого полного дампа — быстрая обработка.
app.post('/api/save-fetched-data', (req, res) => {
  try {
    const body = req.body || {};
    const value = body.value || body;
    const items = Array.isArray(value?.items) ? value.items : [];
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    let mergeResult = { added: 0, skipped: 0, byShift: {} };
    if (items.length > 0) {
      mergeResult = storage.mergeOperations(items);
    }
    const shiftKeys = Object.keys(mergeResult.byShift || {});
    const savedTo = shiftKeys.length ? shiftKeys.join(', ') : 'hourly';

    res.json({ ok: true, savedTo, added: mergeResult.added, skipped: mergeResult.skipped });
  } catch (err) {
    console.error('POST /api/save-fetched-data', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function readEmplCsvText() {
  const buf = fs.readFileSync(EMPL_CSV_PATH);
  const iconv = require('iconv-lite');
  const try1251 = iconv.decode(buf, 'cp1251');
  const hasCyrillic = /[\u0400-\u04FF]/.test(try1251);
  if (hasCyrillic) return try1251;
  return buf.toString('utf8');
}

/** Карта нормализованное ФИО -> компания для фильтра по роли manager */
function getEmplMapFioToCompany() {
  const map = new Map();
  if (!fs.existsSync(EMPL_CSV_PATH)) return map;
  let text;
  try {
    text = readEmplCsvText();
  } catch {
    return map;
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const idx = t.indexOf(';');
    if (idx < 0) continue;
    const fio = t.slice(0, idx).trim();
    const company = t.slice(idx + 1).trim();
    if (fio) {
      const key = fio.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!map.has(key)) map.set(key, company);
    }
  }
  return map;
}

function normalizeFioForMatch(fio) {
  return String(fio || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getCompanyByFio(emplMap, executorFio) {
  const norm = normalizeFioForMatch(executorFio);
  if (!norm) return null;
  for (const [key, company] of emplMap) {
    if (norm === key || norm.includes(key) || key.includes(norm)) return company;
  }
  return null;
}

app.get('/api/empl', (req, res) => {
  if (!fs.existsSync(EMPL_CSV_PATH)) {
    return res.json({ employees: [], companies: [] });
  }
  let text;
  try {
    text = readEmplCsvText();
  } catch {
    return res.json({ employees: [], companies: [] });
  }
  const employees = [];
  const companySet = new Set();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const idx = t.indexOf(';');
    if (idx < 0) continue;
    const fio = t.slice(0, idx).trim();
    const company = t.slice(idx + 1).trim();
    if (fio) {
      employees.push({ fio, company });
      if (company) companySet.add(company);
    }
  }
  res.json({ employees, companies: [...companySet].sort() });
});

function appendToEmplCsv(fio, company) {
  const iconv = require('iconv-lite');
  const line = String(fio).trim().replace(/;/g, ',') + ';' + String(company).trim().replace(/[\r\n]/g, ' ') + '\n';
  fs.appendFileSync(EMPL_CSV_PATH, iconv.encode(line, 'cp1251'));
}

app.post('/api/empl', (req, res) => {
  try {
    const { fio, company } = req.body || {};
    if (!fio || typeof fio !== 'string' || !fio.trim()) {
      return res.status(400).json({ ok: false, error: 'Укажите ФИО' });
    }
    appendToEmplCsv(fio.trim(), (company != null ? String(company) : '').trim());
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/empl', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Авторизация /vs: сессия + роли ─────────────────────────────────────────────

const SAMOKAT_AUTH_URL = 'https://api.samokat.ru/wmsin-wwh/auth/password';
const VS_SESSION_COOKIE = 'vs_sid';

async function samokatLogin(login, password) {
  const r = await fetch(SAMOKAT_AUTH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: 'https://wwh.samokat.ru',
      Referer: 'https://wwh.samokat.ru/',
    },
    body: JSON.stringify({ login, password }),
  });
  if (!r.ok) {
    const text = await r.text();
    const err = new Error(`Ошибка авторизации Samokat: ${r.status}`);
    err.status = r.status;
    try {
      const data = JSON.parse(text);
      if (data.message) err.message = data.message;
    } catch {}
    throw err;
  }
  return r.json();
}

app.post('/api/vs/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body || {};
    if (!login || !password) {
      return res.status(400).json({ ok: false, error: 'Укажите логин и пароль' });
    }
    const user = vsAuth.findUserByLogin(login);
    if (!user) {
      vsAuth.recordLoginAttempt(login, false);
      return res.status(403).json({ ok: false, error: 'Пользователь не найден в списке доступа /vs' });
    }

    if (user.passwordHash) {
      if (!vsAuth.verifyPassword(password, user.passwordHash)) {
        vsAuth.recordLoginAttempt(login, false);
        return res.status(401).json({ ok: false, error: 'Неверный пароль' });
      }
      vsAuth.recordLoginAttempt(login, true);
      const sessionId = vsAuth.createSession(user, login);
      const modules = user.modules || vsAuth.getModulesForRole(user.role);
      res.cookie(VS_SESSION_COOKIE, sessionId, {
        httpOnly: true,
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        sameSite: 'lax',
      });
      return res.json({
        ok: true,
        role: user.role,
        modules,
        allowWithoutToken: true,
        companyIds: user.role === 'manager' && Array.isArray(user.companyIds) ? user.companyIds : undefined,
      });
    }

    if (user.allowWithoutToken) {
      vsAuth.recordLoginAttempt(login, true);
      const sessionId = vsAuth.createSession(user, login);
      const modules = user.modules || vsAuth.getModulesForRole(user.role);
      res.cookie(VS_SESSION_COOKIE, sessionId, {
        httpOnly: true,
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        sameSite: 'lax',
      });
      return res.json({
        ok: true,
        role: user.role,
        modules,
        allowWithoutToken: true,
        companyIds: user.role === 'manager' && Array.isArray(user.companyIds) ? user.companyIds : undefined,
      });
    }

    const samokatRes = await samokatLogin(login, password);
    const accessToken = samokatRes?.value?.accessToken;
    const refreshToken = samokatRes?.value?.refreshToken;
    const expiresIn = samokatRes?.value?.expiresIn || 300;
    if (!accessToken) {
      return res.status(401).json({ ok: false, error: 'Токен не получен от Samokat' });
    }
    vsAuth.recordLoginAttempt(login, true);
    const sessionId = vsAuth.createSession(user, login);
    const modules = user.modules || vsAuth.getModulesForRole(user.role);
    res.cookie(VS_SESSION_COOKIE, sessionId, {
      httpOnly: true,
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    });
    res.json({
      ok: true,
      role: user.role,
      modules,
      accessToken,
      expiresIn,
      refreshToken: refreshToken || '',
      companyIds: user.role === 'manager' && Array.isArray(user.companyIds) ? user.companyIds : undefined,
    });
  } catch (err) {
    if (req.body?.login) vsAuth.recordLoginAttempt(req.body.login, false);
    console.error('POST /api/vs/auth/login', err);
    res.status(err.status === 401 ? 401 : 500).json({
      ok: false,
      error: err.message || 'Ошибка входа',
    });
  }
});

app.get('/api/vs/auth/me', (req, res) => {
  const sessionId = req.cookies?.[VS_SESSION_COOKIE];
  const session = vsAuth.getSession(sessionId);
  if (!session) {
    return res.status(401).json({ error: 'Сессия не найдена или истекла' });
  }
  res.json({
    role: session.role,
    modules: session.modules || vsAuth.getModulesForRole(session.role),
    allowWithoutToken: !!session.allowWithoutToken,
    companyIds: session.role === 'manager' && Array.isArray(session.companyIds) ? session.companyIds : undefined,
  });
});

app.post('/api/vs/auth/logout', (req, res) => {
  const sessionId = req.cookies?.[VS_SESSION_COOKIE];
  if (sessionId) vsAuth.destroySession(sessionId);
  res.clearCookie(VS_SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// ─── Привязка Telegram для менеджера (отчёты в личку) ─────────────────────────

async function getTelegramBotUsername(botToken) {
  if (!botToken || !botToken.trim()) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`);
    const data = await r.json();
    return data?.ok && data?.result?.username ? data.result.username : null;
  } catch {
    return null;
  }
}

app.get('/api/vs/telegram/status', vsSessionRequired, async (req, res) => {
  try {
    const login = req.vsSession?.login;
    const chatId = login ? vsAuth.getTelegramChatId(login) : null;
    const config = loadConfig();
    const botToken = String(config.telegramBotToken || '').trim();
    let botUsername = null;
    if (botToken) botUsername = await getTelegramBotUsername(botToken);
    res.json({ linked: !!chatId, botUsername });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vs/telegram/bind-start', vsSessionRequired, async (req, res) => {
  try {
    const login = req.vsSession?.login;
    if (!login) return res.status(401).json({ error: 'Нет логина в сессии' });
    const config = loadConfig();
    const botToken = String(config.telegramBotToken || '').trim();
    if (!botToken) return res.status(400).json({ error: 'Бот не настроен (добавьте Bot Token в настройках)' });
    const code = vsAuth.createBindingCode();
    vsAuth.addBindingCode(code, login);
    const botUsername = await getTelegramBotUsername(botToken);
    res.json({ code, botUsername: botUsername || '', expiresIn: 300 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Middleware: опционально подставляет req.vsSession. Не возвращает 401 — только для маршрутов, которые сами проверяют. */
function vsSessionOptional(req, res, next) {
  const sessionId = req.cookies?.[VS_SESSION_COOKIE];
  req.vsSession = sessionId ? vsAuth.getSession(sessionId) : null;
  next();
}

/** Middleware: доступ только с валидной сессией /vs, иначе 401. */
function vsSessionRequired(req, res, next) {
  const sessionId = req.cookies?.[VS_SESSION_COOKIE];
  const session = sessionId ? vsAuth.getSession(sessionId) : null;
  if (!session) {
    return res.status(401).json({ error: 'Требуется авторизация /vs' });
  }
  req.vsSession = session;
  next();
}

/** Middleware: только роль admin. */
function vsAdminRequired(req, res, next) {
  if (req.vsSession?.role !== 'admin') {
    return res.status(403).json({ error: 'Только для администратора' });
  }
  next();
}

// ─── API админа /vs: пользователи, права, модули ─────────────────────────────────

app.get('/api/vs/admin/users', vsSessionRequired, vsAdminRequired, (req, res) => {
  try {
    res.json(vsAuth.getAllUsersForAdmin());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/vs/admin/users', vsSessionRequired, vsAdminRequired, (req, res) => {
  try {
    const { login, role, modules, shiftType, companyIds, allowWithoutToken, password } = req.body || {};
    if (!login || String(login).trim() === '') {
      return res.status(400).json({ error: 'Укажите логин (номер телефона или буквенный)' });
    }
    vsAuth.saveUser(login, { role, modules, shiftType, companyIds, allowWithoutToken, password });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/vs/admin/users/:login', vsSessionRequired, vsAdminRequired, (req, res) => {
  try {
    const login = decodeURIComponent(req.params.login || '');
    if (!login.trim()) return res.status(400).json({ error: 'Укажите логин' });
    vsAuth.removeUser(login);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API для страницы /vs (смены, дата, мониторинг, перекличка) ─────────────────

app.get('/api/date/:date/items', vsSessionOptional, (req, res) => {
  try {
    const dateStr = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: 'Неверный формат даты (YYYY-MM-DD)' });
    }
    const fromHour = req.query.fromHour != null ? parseInt(req.query.fromHour, 10) : undefined;
    const toHour = req.query.toHour != null ? parseInt(req.query.toHour, 10) : undefined;
    let shift = req.query.shift === 'day' || req.query.shift === 'night' ? req.query.shift : undefined;
    const session = req.vsSession;
    if (session?.role === 'supervisor' && session.shiftType) {
      if (shift && shift !== session.shiftType) {
        return res.status(403).json({ error: 'Доступ только к своей смене' });
      }
      shift = session.shiftType;
    }
    let items = storage.getDateItems(dateStr, { fromHour, toHour, shift });
    if (session?.role === 'manager' && Array.isArray(session.companyIds) && session.companyIds.length > 0) {
      const emplMap = getEmplMapFioToCompany();
      const allowed = new Set(session.companyIds.map(c => c.trim().toLowerCase()));
      items = items.filter(it => {
        const company = getCompanyByFio(emplMap, it.executor);
        return company && allowed.has(company.trim().toLowerCase());
      });
    }
    res.json({ date: dateStr, count: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/date/:date/summary', vsSessionOptional, (req, res) => {
  try {
    const dateStr = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: 'Неверный формат даты (YYYY-MM-DD)' });
    }
    let shift = req.query.shift === 'day' || req.query.shift === 'night' ? req.query.shift : undefined;
    const session = req.vsSession;
    if (session?.role === 'supervisor' && session.shiftType) {
      if (shift && shift !== session.shiftType) {
        return res.status(403).json({ error: 'Доступ только к своей смене' });
      }
      shift = session.shiftType;
    }
    const emplMap = getEmplMapFioToCompany();
    const getCompany = (fio) => getCompanyByFio(emplMap, fio);
    const summary = storage.getDateSummary(dateStr, { shift }, { getCompany });
    res.json({ date: dateStr, shift: shift || null, ...summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/date/:date/storage', vsSessionOptional, (req, res) => {
  try {
    const dateStr = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: 'Неверный формат даты (YYYY-MM-DD)' });
    }
    const shift = req.body?.shift === 'night' ? 'night' : 'day';
    const totalStorageCount = Number(req.body?.totalStorageCount) || 0;
    const storageByHour = req.body?.storageByHour && typeof req.body.storageByHour === 'object' ? req.body.storageByHour : {};
    const totalWeightGrams = Number(req.body?.totalWeightGrams) || 0;
    const weightByEmployee = req.body?.weightByEmployee && typeof req.body.weightByEmployee === 'object' ? req.body.weightByEmployee : {};
    storage.saveStorageForDate(dateStr, shift, { totalStorageCount, storageByHour, totalWeightGrams, weightByEmployee });
    res.json({ ok: true, date: dateStr, shift });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shifts', vsSessionOptional, (req, res) => {
  try {
    let shifts = storage.listShifts();
    const session = req.vsSession;
    if (session?.role === 'supervisor' && session.shiftType) {
      shifts = shifts.filter(s => (s.shiftKey || '').endsWith('_' + session.shiftType));
    }
    res.json(shifts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shifts/current', (req, res) => {
  res.json({ shiftKey: storage.getCurrentShiftKey() });
});

app.get('/api/shifts/:shiftKey/items', (req, res) => {
  try {
    const { shiftKey } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}_(day|night)$/.test(shiftKey)) {
      return res.status(400).json({ error: 'Неверный формат shiftKey' });
    }
    const items = storage.getShiftItems(shiftKey);
    res.json({ shiftKey, count: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET/POST /api/employees — для страницы /vs (csv)
app.get('/api/employees', (req, res) => {
  try {
    if (!fs.existsSync(EMPL_CSV_PATH)) {
      return res.json({ csv: '', employees: [], companies: [] });
    }
    const text = readEmplCsvText();
    const employees = [];
    const companySet = new Set();
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const idx = t.indexOf(';');
      if (idx < 0) continue;
      const fio = t.slice(0, idx).trim();
      const company = t.slice(idx + 1).trim();
      if (fio) {
        employees.push({ fio, company });
        if (company) companySet.add(company);
      }
    }
    res.json({ csv: text, employees, companies: [...companySet].sort() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/employees', (req, res) => {
  try {
    const { csv } = req.body || {};
    if (typeof csv !== 'string') return res.status(400).json({ error: 'Нет поля csv' });
    const iconv = require('iconv-lite');
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    fs.writeFileSync(EMPL_CSV_PATH, Buffer.concat([bom, Buffer.from(csv, 'utf8')]));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const LIVE_MONITOR_URL = 'https://api.samokat.ru/wmsops-wwh/activity-monitor/selection/handling-units-in-progress';
const ROLLCALL_PATH = path.join(__dirname, 'data', 'rollcall.json');

app.get('/api/monitor/live', async (req, res) => {
  try {
    const config = loadConfig();
    const token = (config.token || '').trim();
    if (!token) return res.status(401).json({ error: 'Токен не задан' });
    const headers = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    };
    const cookie = (config.cookie || '').trim();
    if (cookie) headers['Cookie'] = cookie;
    const response = await fetch(LIVE_MONITOR_URL, { headers });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(502).json({ error: 'Ответ не JSON', preview: text.slice(0, 200) });
    }
    if (!response.ok) return res.status(response.status).json({ error: `API ${response.status}`, data });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/rollcall', (req, res) => {
  try {
    if (!fs.existsSync(ROLLCALL_PATH)) return res.json({ shiftKey: null, present: [] });
    res.json(JSON.parse(fs.readFileSync(ROLLCALL_PATH, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rollcall', (req, res) => {
  try {
    const { shiftKey, present } = req.body || {};
    storage.ensureDataDir();
    fs.writeFileSync(ROLLCALL_PATH, JSON.stringify({ shiftKey: shiftKey || null, present: present || [] }), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/schedule/start', (req, res) => {
  res.json(scheduler.start());
});

app.post('/api/schedule/stop', (req, res) => {
  res.json(scheduler.stop());
});

app.post('/api/schedule/settings', (req, res) => {
  try {
    const { intervalMinutes, pageSize } = req.body || {};
    const config = loadConfig();
    if (intervalMinutes !== undefined) {
      config.intervalMinutes = Math.max(1, parseInt(intervalMinutes, 10) || 10);
    }
    if (pageSize !== undefined) {
      config.pageSize = Math.min(1000, Math.max(1, parseInt(pageSize, 10) || 500));
    }
    saveConfig(config);
    const wasRunning = scheduler.isRunning();
    if (wasRunning) {
      scheduler.stop();
      const result = scheduler.start();
      return res.json({ ok: true, restarted: true, message: result.message, config: { intervalMinutes: config.intervalMinutes } });
    }
    res.json({ ok: true, restarted: false, config: { intervalMinutes: config.intervalMinutes } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Консолидация: маршруты ──────────────────────────────────────────────────

// POST /api/consolidation/complaints — создать жалобу
app.post('/api/consolidation/complaints', upload.array('photo', 10), (req, res) => {
  try {
    const { cell, barcode, employeeName } = req.body || {};
    if (!cell || !barcode) {
      return res.status(400).json({ ok: false, error: 'Укажите место хранения и штрихкод' });
    }
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const uploaded = Array.isArray(req.files) ? req.files : [];
    const photoFilenames = [];
    if (uploaded.length > 0) {
      for (let i = 0; i < uploaded.length; i++) {
        const f = uploaded[i];
        const ext = path.extname(f.originalname) || '.jpg';
        const suffix = i === 0 ? '' : `_${i + 1}`;
        const newName = `${id}${suffix}${ext}`;
        fs.renameSync(f.path, path.join(UPLOADS_DIR, newName));
        photoFilenames.push(newName);
      }
    }
    const photoFilename = photoFilenames[0] || null;
    const complaint = {
      id,
      createdAt: new Date().toISOString(),
      cell: cell.trim(),
      barcode: barcode.trim(),
      employeeName: (employeeName || '').trim() || null,
      photoFilename,
      photoFilenames,
      productName: null,
      nomenclatureCode: null,
      violator: null,
      violatorId: null,
      operationType: null,
      operationCompletedAt: null,
      status: 'new',
      lookupDone: false,
      lookupError: null,
    };
    const list = loadComplaints();
    list.unshift(complaint);
    saveComplaints(list);
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /api/consolidation/complaints', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/consolidation/complaints — список жалоб (компания из консолидации или по ФИО из empl)
app.get('/api/consolidation/complaints', (req, res) => {
  try {
    const list = loadComplaints();
    const emplMap = getEmplMapFioToCompany();
    const enriched = list.map(c => ({
      ...c,
      company: (c.company != null && String(c.company).trim() !== '') ? c.company : (getCompanyByFio(emplMap, c.violator) || ''),
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/consolidation/complaints/:id/status — сменить статус
app.put('/api/consolidation/complaints/:id/status', (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['new', 'in_progress', 'resolved'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'Неверный статус' });
    }
    const list = loadComplaints();
    const item = list.find(c => c.id === req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'Не найдено' });
    item.status = status;
    saveComplaints(list);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/consolidation/complaints/:id — удалить жалобу
app.delete('/api/consolidation/complaints/:id', (req, res) => {
  try {
    const list = loadComplaints();
    const idx = list.findIndex(c => c.id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: 'Не найдено' });
    const [removed] = list.splice(idx, 1);
    saveComplaints(list);
    // Удалить все фото жалобы
    const photos = Array.isArray(removed.photoFilenames) && removed.photoFilenames.length > 0
      ? removed.photoFilenames
      : (removed.photoFilename ? [removed.photoFilename] : []);
    for (const file of photos) {
      const photoPath = path.join(UPLOADS_DIR, file);
      if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/consolidation/uploads/:filename — отдача фото
app.get('/api/consolidation/uploads/:filename', (req, res) => {
  const name = path.basename(req.params.filename);
  if (name.includes('..')) return res.status(400).json({ error: 'Invalid' });
  const filePath = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// PUT /api/consolidation/complaints/:id/lookup — сохранить результат WMS-поиска (от клиента)
app.put('/api/consolidation/complaints/:id/lookup', (req, res) => {
  try {
    const list = loadComplaints();
    const item = list.find(c => c.id === req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'Не найдено' });
    const d = req.body || {};
    if (d.cell !== undefined) item.cell = d.cell;
    if (d.barcode !== undefined) item.barcode = d.barcode;
    if (d.productName !== undefined) item.productName = d.productName;
    if (d.nomenclatureCode !== undefined) item.nomenclatureCode = d.nomenclatureCode;
    if (d.productBarcode !== undefined) item.productBarcode = d.productBarcode;
    if (d.violator !== undefined) item.violator = d.violator;
    if (d.violatorId !== undefined) item.violatorId = d.violatorId;
    if (d.handlingUnitBarcode !== undefined) item.handlingUnitBarcode = d.handlingUnitBarcode;
    if (d.operationType !== undefined) item.operationType = d.operationType;
    if (d.operationCompletedAt !== undefined) item.operationCompletedAt = d.operationCompletedAt;
    if (d.lookupDone !== undefined) item.lookupDone = d.lookupDone;
    if (d.lookupError !== undefined) item.lookupError = d.lookupError;
    if (d.company !== undefined) item.company = d.company;
    if (d.taskArea !== undefined) item.taskArea = (d.taskArea === 'kdk' || d.taskArea === 'storage') ? d.taskArea : '';
    else if (d.operationType != null && (item.taskArea == null || String(item.taskArea).trim() === '')) {
      const op = String(d.operationType).toUpperCase();
      item.taskArea = (op === 'PICK_BY_LINE' || op.indexOf('PALLET') >= 0) ? 'kdk' : 'storage';
    }
    if (item.violator != null && (item.company == null || String(item.company).trim() === '')) {
      const emplMap = getEmplMapFioToCompany();
      item.company = getCompanyByFio(emplMap, item.violator) || '';
    }
    saveComplaints(list);
    res.json({ ok: true, complaint: item });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/consolidation/telegram/send — отправить выбранные жалобы в Telegram
app.post('/api/consolidation/telegram/send', async (req, res) => {
  try {
    const complaintIds = Array.isArray(req.body?.complaintIds)
      ? req.body.complaintIds.map(x => String(x))
      : [];
    if (complaintIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'Не переданы complaintIds' });
    }

    const config = loadConfig();
    const botToken = String(config.telegramBotToken || '').trim();
    const chats = getTelegramChats(config);
    if (!botToken || !chats.length) {
      return res.status(400).json({ ok: false, error: 'Не настроены telegramBotToken или список чатов (Chat ID) в config' });
    }

    const list = loadComplaints();
    const byId = new Map(list.map(c => [String(c.id), c]));
    const selected = complaintIds.map(id => byId.get(id)).filter(Boolean);

    const onlyInProgress = selected.filter(c => c.status === 'in_progress');
    const skipped = selected.filter(c => c.status !== 'in_progress').map(c => c.id);
    if (onlyInProgress.length === 0) {
      return res.status(400).json({ ok: false, error: 'Выбранные жалобы не имеют статус "в работе"', skipped });
    }

    const sent = [];
    const failed = [];
    const origin = `${req.protocol}://${req.get('host')}`;
    const emplMap = getEmplMapFioToCompany();
    for (const c of onlyInProgress) {
      const photos = Array.isArray(c?.photoFilenames) && c.photoFilenames.length > 0
        ? c.photoFilenames
        : (c?.photoFilename ? [c.photoFilename] : []);
      const photoUrl = photos.length > 0
        ? `${origin}/api/consolidation/uploads/${encodeURIComponent(photos[0])}`
        : '';
      const company = (c.company != null && String(c.company).trim() !== '') ? c.company : (getCompanyByFio(emplMap, c.violator) || '—');
      const text = formatComplaintForTelegram(c, photoUrl, config, company);
      const photoPaths = photos
        .map(name => ({ name, path: path.join(UPLOADS_DIR, name) }))
        .filter(x => fs.existsSync(x.path));
      let sentToAny = false;
      for (const chat of chats) {
        const threadId = chat.threadIdConsolidation;
        try {
          if (photoPaths.length > 1) {
            await sendTelegramMediaGroup(botToken, chat.chatId, text, photoPaths, threadId, 'Markdown');
          } else if (photoPaths.length === 1) {
            const p = photoPaths[0];
            await sendTelegramPhoto(botToken, chat.chatId, text, p.path, p.name, threadId, 'Markdown');
          } else {
            await sendTelegramMessage(botToken, chat.chatId, text, threadId, 'Markdown');
          }
          sentToAny = true;
        } catch (e) {
          failed.push({ id: c.id, error: e.message });
        }
      }
      if (sentToAny) sent.push(c.id);
    }

    res.json({
      ok: failed.length === 0,
      sentCount: sent.length,
      failedCount: failed.length,
      sent,
      failed,
      skipped,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/stats/send-hourly-telegram — отправить PNG по компаниям как файлы (документы) в Telegram
// Менеджер (с сессией): отправка в привязанный чат. Иначе — в чаты из настроек.
app.post('/api/stats/send-hourly-telegram', vsSessionOptional, uploadMemory.any(50), async (req, res) => {
  try {
    const config = loadConfig();
    const botToken = String(config.telegramBotToken || '').trim();
    if (!botToken) {
      return res.status(400).json({ ok: false, error: 'Не настроены Telegram (Bot Token в настройках)' });
    }
    const files = req.files && Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ ok: false, error: 'Не получены файлы' });
    }
    let captions = [];
    let companiesPerFile = [];
    try {
      if (req.body && req.body.captions) captions = JSON.parse(req.body.captions);
      if (req.body && req.body.companiesPerFile) companiesPerFile = JSON.parse(req.body.companiesPerFile);
    } catch (_) {}
    if (!Array.isArray(companiesPerFile)) companiesPerFile = [];

    let chats = [];
    if (req.vsSession?.role === 'manager' && req.vsSession?.login) {
      const managerChatId = vsAuth.getTelegramChatId(req.vsSession.login);
      if (managerChatId) {
        chats = [{ chatId: managerChatId, threadIdStats: null, companiesFilter: [] }];
      }
    }
    if (!chats.length) {
      chats = getTelegramChats(config);
      if (!chats.length) {
        return res.status(400).json({ ok: false, error: 'Не настроены чаты в настройках или привяжите Telegram (менеджер)' });
      }
    }

    const allowFileForChat = (fileIndex, chat) => {
      if (!Array.isArray(chat.companiesFilter) || chat.companiesFilter.length === 0) return true;
      const key = companiesPerFile[fileIndex];
      return key === 'Full' || (key && chat.companiesFilter.includes(key));
    };

    for (const chat of chats) {
      const threadId = chat.threadIdStats;
      let sentForChat = 0;
      for (let i = 0; i < files.length; i++) {
        if (!allowFileForChat(i, chat)) continue;
        const f = files[i];
        const caption = Array.isArray(captions) && captions[i] != null ? String(captions[i]) : `Сотрудники по часам ${i + 1}`;
        const filename = (f.originalname && /\.png$/i.test(f.originalname)) ? f.originalname : `hourly_${i + 1}.png`;
        await sendTelegramDocumentFromBuffer(botToken, chat.chatId, caption, f.buffer, filename, threadId);
        sentForChat++;
      }
    }
    res.json({ ok: true, sent: files.length });
  } catch (err) {
    console.error('POST /api/stats/send-hourly-telegram', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Страница /vs (WMS через браузер) ─────────────────────────────────────────

const VS_DIR = path.resolve(__dirname, '..', 'frontend', 'vs');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

app.get('/vs', (req, res) => {
  res.sendFile(path.join(VS_DIR, 'vs.html'));
});
app.use('/vs', express.static(VS_DIR));

// Главная страница — редирект на /vs; старая главная доступна по /tech
app.get('/', (req, res) => {
  res.redirect(302, '/vs');
});
app.get('/tech', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// Статика и SPA fallback — после всех API-маршрутов
app.use(express.static(FRONTEND_DIR));
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ─── Опрос Telegram для привязки менеджеров (код в личку боту) ───────────────

let telegramPollingOffset = 0;

async function telegramBindingPollOnce() {
  try {
    const config = loadConfig();
    const botToken = String(config.telegramBotToken || '').trim();
    if (!botToken) return;
    const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getUpdates?offset=${telegramPollingOffset}&timeout=20`;
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!data?.ok || !Array.isArray(data.result)) return;
    for (const upd of data.result) {
      if (upd.update_id >= telegramPollingOffset) telegramPollingOffset = upd.update_id + 1;
      const msg = upd.message || upd.edited_message;
      if (!msg?.text) continue;
      const text = String(msg.text).trim().toUpperCase();
      const chatId = msg.chat?.id;
      if (!chatId) continue;
      const login = vsAuth.consumeBindingCode(text);
      if (login) {
        vsAuth.setTelegramChatId(login, String(chatId));
        await sendTelegramMessage(botToken, chatId, '✅ Привязано. Отчёты по статистике будут приходить сюда.');
      }
    }
  } catch (_) {
    // игнорируем ошибки опроса
  }
}

function startTelegramBindingPolling() {
  setInterval(telegramBindingPollOnce, 3000);
}

app.listen(PORT, '0.0.0.0', () => {
  scheduler.ensureDataDir();
  startTelegramBindingPolling();
  console.log(`Сервер: http://localhost:${PORT} (доступен по сети на порту ${PORT})`);
});
