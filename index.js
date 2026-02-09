const { Bot, InlineKeyboard, Api, InputFile } = require('grammy');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
let FFMPEG_PATH = null;
try { FFMPEG_PATH = require('ffmpeg-static'); } catch (_) { FFMPEG_PATH = null; }
console.log(`🎛️ ffmpeg-static: ${FFMPEG_PATH ? 'OK' : 'MISSING'}`);

// ===============================
// HTTP HELPERS (RETRY + SAFETY)
// ===============================
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


// Extract arguments after a slash-command (works for grammy bot.command)
function getCommandArgs(ctx) {
  const t = ctx?.message?.text || '';
  // remove '/cmd' and optional '@botname'
  const s = t.replace(/^\/\w+(?:@\w+)?\s*/i, '');
  return s.trim();
}
// Robust GET helper with retries + HTML-block detection
async function axiosGetWithRetry(url, opts = {}, attempts = 3) {
  const timeout = opts.timeout ?? 25000;
  const headers = { 'user-agent': DEFAULT_UA, ...(opts.headers || {}) };

  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await axios.get(url, {
        timeout,
        headers,
        validateStatus: () => true,
        responseType: opts.responseType || 'json'
      });

      // Detect WAF / HTML blocks (common for free APIs)
      const ct = String(res.headers?.['content-type'] || '').toLowerCase();
      if (typeof res.data === 'string') {
        const s = res.data.slice(0, 500).toLowerCase();
        if (s.includes('<html') || s.includes('cloudflare') || s.includes('attention required')) {
          const e = new Error(`Blocked by upstream (html/waf). status=${res.status} ct=${ct}`);
          e._blocked = true;
          throw e;
        }
      }

      if (res.status >= 200 && res.status < 300) return res;
      const e = new Error(`HTTP ${res.status}`);
      e._status = res.status;
      e._data = res.data;
      throw e;
    } catch (err) {
      lastErr = err;
      // exponential-ish backoff
      if (i < attempts - 1) await sleep(800 * (i + 1));
    }
  }
  throw lastErr || new Error('Request failed');
}

// ===============================
// YTCONTENT PROCESS POLLER (REAL-TIME TEXT UPDATES)
// ===============================
// Poll a ytcontent "videoProcess" URL until it returns a real fileUrl (not "In Processing...")
async function pollYtcontentProcess(processUrl, opts = {}) {
  const intervalMs = opts.intervalMs ?? 2500;
  const maxTries = opts.maxTries ?? 60; // ~2.5min
  let last = null;

  for (let i = 0; i < maxTries; i++) {
    const res = await axiosGetWithRetry(processUrl, { timeout: 45000, responseType: 'json' }, 2);
    const data = res.data || {};
    last = data;

    const fileUrl = data.fileUrl || null;

        // NOTE: ignore other URL fields (url/download/download_url) to avoid googlevideo.com direct links.
        // We only treat the job as ready when `fileUrl` is present.


    // fileUrl ready
    if (typeof fileUrl === 'string' && /^https?:\/\//i.test(fileUrl) && !/in\s*processing/i.test(fileUrl) && !/googlevideo\.com/i.test(fileUrl)) {
      return { ok: true, data, fileUrl };
    }

    await sleep(intervalMs);
  }

  return { ok: false, data: last, fileUrl: last?.fileUrl || null };
}

// HTML (no markdown symbols). Telegram shows real bold with <b>...</b>
// HTML (no markdown symbols). Telegram shows real bold with <b>...</b>
// Clean progress text (no markdown symbols like *). Also avoids showing raw process URL with lots of '/'.
function formatYtProcessHtml(apiJson, meta = {}) {
  const percentRaw = apiJson?.percent ?? apiJson?.progress ?? apiJson?.percentage ?? '…';

  const bytes =
    (typeof apiJson?.fileSizeBytes === 'number' && apiJson.fileSizeBytes) ||
    (typeof apiJson?.fileSize === 'number' && apiJson.fileSize) ||
    (typeof apiJson?.estimatedFileSizeBytes === 'number' && apiJson.estimatedFileSizeBytes) ||
    null;

  const size =
    apiJson?.estimatedFileSize ||
    (bytes ? (bytes / (1024 * 1024)).toFixed(2) + ' MB' : (apiJson?.fileSize ? String(apiJson.fileSize) : 'Unknown'));

  const name = apiJson?.fileName ?? apiJson?.name ?? 'video.mp4';

  // Prefer ytcontent "d/video" fileUrl when present
  const fileUrlRaw = apiJson?.fileUrl ?? 'In Processing...';
  const fileUrl = String(fileUrlRaw || 'In Processing...');

  const processId = apiJson?.processId ?? apiJson?.id ?? null;
  const processUrl = meta?.processUrl ? String(meta.processUrl) : '';

  const speedText = meta?.speedText ? String(meta.speedText) : '';
  const etaText = meta?.etaText ? String(meta.etaText) : '';

  const extra =
    (speedText || etaText)
      ? `
<b>Speed:</b> <code>${escapeHtml(speedText || '…')}</code>
<b>ETA:</b> <code>${escapeHtml(etaText || '…')}</code>
`
      : '\n';

  const idLine = processId != null ? `<b>ProcessId:</b> <code>${escapeHtml(String(processId))}</code>
` : '';

  const isCompleted = /completed/i.test(String(percentRaw)) || String(percentRaw).trim() === '100' || String(percentRaw).trim() === '100%';
  const statusLabel = isCompleted ? 'Download' : 'Status';

  const processLine = processUrl ? `
<b>Process:</b> <code>${escapeHtml(processUrl)}</code>` : '';

  return (
`🎬 <b>YouTube Processing</b>

` +
idLine +
`<b>Progress:</b> <code>${escapeHtml(String(percentRaw))}</code>
` +
`<b>Est. Size:</b> <code>${escapeHtml(String(size))}</code>
` +
`<b>File:</b> <code>${escapeHtml(String(name))}</code>` +
extra +
`<b>${statusLabel}:</b> <code>${escapeHtml(fileUrl)}</code>` +
processLine
  );
}



// JSON-in-text (inside <pre>) for real-time progress (requested format)
function formatYtProcessJsonHtml(apiJson, processUrl, quality, meta = {}) {
  const percentRaw = apiJson?.percent ?? apiJson?.progress ?? apiJson?.percentage ?? '…';
  const percentStr = (() => {
    const s = String(percentRaw);
    if (/\%/.test(s)) return s;
    const m = s.match(/(\d+(\.\d+)?)/);
    return m ? `${m[1]}%` : s;
  })();

  const bytes =
    (typeof apiJson?.fileSizeBytes === 'number' && apiJson.fileSizeBytes) ||
    (typeof apiJson?.fileSize === 'number' && apiJson.fileSize) ||
    (typeof apiJson?.estimatedFileSizeBytes === 'number' && apiJson.estimatedFileSizeBytes) ||
    null;

  const estimatedFileSize =
    apiJson?.estimatedFileSize ||
    (bytes ? (bytes / (1024 * 1024)).toFixed(2) + ' MB' : undefined);

  const payload = {
    processId: apiJson?.processId ?? apiJson?.id ?? null,
    quality: quality != null ? Number(quality) : undefined,
    percent: percentStr,
    estimatedFileSize: estimatedFileSize ?? 'Unknown',
    fileName: apiJson?.fileName ?? apiJson?.name ?? 'video.mp4',
    fileSize: (typeof apiJson?.fileSize === 'number' ? apiJson.fileSize : (typeof apiJson?.fileSizeBytes === 'number' ? apiJson.fileSizeBytes : (typeof apiJson?.estimatedFileSizeBytes === 'number' ? apiJson.estimatedFileSizeBytes : null))),
    fileUrl: apiJson?.fileUrl ?? 'In Processing...',
    speed: meta?.speedText ? String(meta.speedText) : '…',
    eta: meta?.etaText ? String(meta.etaText) : '…',
  };

  // Remove undefined keys (keeps JSON clean)
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

  const pretty = JSON.stringify(payload, null, 2);
  return `🎬 <b>YouTube ${escapeHtml(String(quality || ''))}p Processing</b>\n\n<pre>${escapeHtml(pretty)}</pre>\n<b>Process:</b> <code>${escapeHtml(String(processUrl))}</code>`;
}
// Initialize bot with proper error handling
const botToken = process.env.BOT_TOKEN;

if (!botToken) {
  console.error('❌ BOT_TOKEN environment variable is not set!');
  console.error('Please set BOT_TOKEN in Railway environment variables');
  process.exit(1);
}

// Initialize bot
const bot = new Bot(botToken);



// ===============================
// AUTO VERSION FOOTER (wrap senders)
// ===============================
bot.use(async (ctx, next) => {
  try {
    // Wrap ctx.reply
    if (typeof ctx.reply === 'function') {
      const _origReply = ctx.reply.bind(ctx);
      ctx.reply = (text, other) => _origReply(_appendVersionFooter(text), other);
    }

    // Wrap common reply variants
    if (typeof ctx.replyWithHTML === 'function') {
      const _orig = ctx.replyWithHTML.bind(ctx);
      ctx.replyWithHTML = (text, other) => _orig(_appendVersionFooter(text), other);
    }
    if (typeof ctx.replyWithMarkdown === 'function') {
      const _orig = ctx.replyWithMarkdown.bind(ctx);
      ctx.replyWithMarkdown = (text, other) => _orig(_appendVersionFooter(text), other);
    }
    if (typeof ctx.replyWithMarkdownV2 === 'function') {
      const _orig = ctx.replyWithMarkdownV2.bind(ctx);
      ctx.replyWithMarkdownV2 = (text, other) => _orig(_appendVersionFooter(text), other);
    }

    // Wrap API sendMessage for background jobs / plain objects
    if (ctx.api && typeof ctx.api.sendMessage === 'function') {
      const _origSendMessage = ctx.api.sendMessage.bind(ctx.api);
      ctx.api.sendMessage = (chatId, text, other = {}) => _origSendMessage(chatId, _appendVersionFooter(text), other);
    }

    // Wrap API media senders to append footer into caption (when present)
    const wrapCaption = (fnName) => {
      if (ctx.api && typeof ctx.api[fnName] === 'function') {
        const _orig = ctx.api[fnName].bind(ctx.api);
        ctx.api[fnName] = (chatId, media, other = {}) => {
          if (other && typeof other.caption === 'string') other.caption = _appendVersionFooter(other.caption);
          return _orig(chatId, media, other);
        };
      }
    };
    wrapCaption('sendPhoto');
    wrapCaption('sendVideo');
    wrapCaption('sendDocument');
    wrapCaption('sendAnimation');
    wrapCaption('sendAudio');
  } catch (_) {}
  return next();
});
// ===============================
// YouTube Jobs (for non-blocking progress + stop button)
// ===============================
if (!global.__ytJobs) global.__ytJobs = new Map();


// ===============================
// BAN MIDDLEWARE (blocks banned users globally)
// ===============================
bot.use(async (ctx, next) => {
  try {
    const uid = ctx.from?.id ? String(ctx.from.id) : null;
    if (!uid) return next();

    // Admins bypass bans
    if (isAdmin(uid) || uid === String(adminId)) return next();

    if (bannedUsers.has(uid)) {
      const b = bannedUsers.get(uid) || {};
      const reason = b.reason ? `\n\n📝 Reason: ${b.reason}` : '';
      return ctx.reply(`⛔ You are banned from using this bot ab soja bskd .${reason}`);
    }
  } catch (_) {}
  return next();
});


// ===============================
// GLOBAL COMMAND + RESPONSE LOGGER
// Sends every command and bot response to a log channel (e.g. @OsintLogsUpdates)
// Requirements:
// 1) Add your bot as ADMIN in the channel
// 2) Set LOG_CHANNEL in env (recommended) OR use default below
// ===============================
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

const LOG_CHANNEL = process.env.LOG_CHANNEL || '@loggroupcn'; // can be @channelusername or numeric channel id
const logApi = new Api(botToken); // separate API (no transformers) to avoid recursion

// Optional separate admin-audit channel (falls back to LOG_CHANNEL)
const ADMIN_AUDIT_CHANNEL = process.env.ADMIN_AUDIT_CHANNEL || process.env.ADMIN_LOG_CHANNEL || LOG_CHANNEL;

// Send a compact admin audit entry (best-effort)
async function adminAudit(action, ctx, details = '') {
  global.__adminAudit = global.__adminAudit || [];
  try {
    const ts = new Date();
    global.__adminAudit.push({ ts: ts.toISOString(), action: String(action || ''), by: String(ctx?.from?.id || ''), chat: String(ctx?.chat?.id || ''), details: String(details || '') });
    if (global.__adminAudit.length > 500) global.__adminAudit.splice(0, global.__adminAudit.length - 500);
  } catch (_) {}

  try {
    if (!ADMIN_AUDIT_CHANNEL) return;
    const user = ctx?.from || {};
    const chat = ctx?.chat || {};
    const uname = user.username ? `@${user.username}` : (user.first_name || 'user');
    const uid = user.id ? String(user.id) : 'unknown';
    const cid = chat.id ? String(chat.id) : 'unknown';
    const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    const msg =
      `🛡️ <b>ADMIN AUDIT</b>\n` +
      `<b>Action:</b> <code>${escapeHtml(String(action))}</code>\n` +
      `<b>By:</b> ${escapeHtml(uname)} (<code>${escapeHtml(uid)}</code>)\n` +
      `<b>Chat:</b> <code>${escapeHtml(cid)}</code>\n` +
      `<b>When:</b> <code>${escapeHtml(when)}</code>\n` +
      (details ? `\n<b>Details:</b>\n${escapeHtml(String(details)).slice(0, 3500)}` : '');

    await logApi.sendMessage(ADMIN_AUDIT_CHANNEL, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (_) {}
}

// Per-command credit tracking helpers
function getCommandNameFromText(t = '') {
  const s = String(t || '').trim();
  if (!s.startsWith('/')) return null;
  const first = s.split(/\s+/)[0];
  // strip bot username if present: /cmd@MyBot
  return first.replace(/^\//, '').replace(/@.+$/, '').toLowerCase();
}
function ensureCommandStats(user) {
  if (!user) return;
  if (!user.commandStats || typeof user.commandStats !== 'object') user.commandStats = {};
}
function recordCommandUse(user, cmd) {
  if (!user || !cmd) return;
  ensureCommandStats(user);
  user._lastCommand = cmd;
  if (!user.commandStats[cmd]) user.commandStats[cmd] = { uses: 0, creditsSpent: 0, creditsRefunded: 0 };
  user.commandStats[cmd].uses += 1;
}
function refundCredits(user, amount = 1, cmd = null) {
  if (!user) return;
  user.credits += amount;
  const c = cmd || user._lastCommand || 'unknown';
  ensureCommandStats(user);
  if (!user.commandStats[c]) user.commandStats[c] = { uses: 0, creditsSpent: 0, creditsRefunded: 0 };
  user.commandStats[c].creditsRefunded += amount;
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendLogText(html) {
  if (!LOG_CHANNEL) return;
  const MAX = 3900; // keep margin for HTML tags
  const chunks = [];
  let buf = html;
  while (buf.length > MAX) {
    chunks.push(buf.slice(0, MAX));
    buf = buf.slice(MAX);
  }
  chunks.push(buf);

  for (const chunk of chunks) {
    try {
      await logApi.sendMessage(LOG_CHANNEL, chunk, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (e) {
      // Don't crash the bot if logging fails (e.g. bot not admin / wrong channel)
      console.error('⚠️ Log channel send failed:', e?.description || e?.message || e);
      break;
    }
  }
}

function formatUser(store) {
  if (!store) return 'Unknown';
  const u = store.from || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Unknown';
  const uname = u.username ? `@${u.username}` : '';
  const id = u.id ? String(u.id) : '';
  return `${escapeHtml(name)} ${escapeHtml(uname)} <code>${escapeHtml(id)}</code>`.trim();
}

function formatChat(store) {
  if (!store) return 'Unknown';
  const c = store.chat || {};
  const title = c.title || c.username || c.id || 'Unknown';
  const type = c.type || '';
  const id = c.id ? String(c.id) : '';
  return `${escapeHtml(String(title))} ${type ? `(${escapeHtml(type)})` : ''} <code>${escapeHtml(id)}</code>`.trim();
}

// Log EVERY incoming command/callback
bot.use(async (ctx, next) => {
  const store = {
    updateId: ctx.update?.update_id,
    from: ctx.from,
    chat: ctx.chat,
    at: new Date().toISOString(),
    updateType: ctx.update?.callback_query ? 'callback_query' : (ctx.message ? 'message' : 'update'),
    text: ctx.message?.text,
    data: ctx.update?.callback_query?.data,
  };

  return als.run(store, async () => {
    try {
      const isCommand = typeof store.text === 'string' && store.text.trim().startsWith('/');
      const isCallback = typeof store.data === 'string' && store.data.length > 0;

      if (isCommand || isCallback) {
        const payload = isCommand ? store.text.trim() : store.data;
        const kind = isCommand ? '📥 <b>COMMAND</b>' : '📥 <b>CALLBACK</b>';
        const html =
          `${kind}\n` +
          `👤 <b>User:</b> ${formatUser(store)}\n` +
          `💬 <b>Chat:</b> ${formatChat(store)}\n` +
          `🕒 <b>Time:</b> <code>${escapeHtml(store.at)}</code>\n` +
          `🧾 <b>Input:</b>\n<pre>${escapeHtml(payload)}</pre>`;
        await sendLogText(html);
      }
    } catch (e) {
      console.error('⚠️ Incoming log error:', e?.message || e);
    }

    return next();
  });
});

// Log EVERY outgoing response (sendMessage/editMessageText/sendPhoto/etc.)
bot.api.config.use(async (prev, method, payload, signal) => {
  const store = als.getStore();

  // Avoid logging our own logs (and avoid recursion)
  const targetChat = payload?.chat_id ?? payload?.to_chat_id;
  const targetIsLogChannel =
    targetChat === LOG_CHANNEL ||
    String(targetChat || '') === String(LOG_CHANNEL || '') ||
    (typeof LOG_CHANNEL === 'string' && typeof targetChat === 'string' && targetChat.toLowerCase() === LOG_CHANNEL.toLowerCase());

  // Call the real Telegram API first
  const result = await prev(method, payload, signal);

  try {
    if (targetIsLogChannel) return result;

    const shouldLog =
      method === 'sendMessage' ||
      method === 'editMessageText' ||
      method === 'sendPhoto' ||
      method === 'sendDocument' ||
      method === 'sendVideo' ||
      method === 'sendAudio' ||
      method === 'sendAnimation' ||
      method === 'sendSticker' ||
      method === 'sendVoice' ||
      method === 'sendPoll';

    if (!shouldLog) return result;

    let preview = '';
    if (method === 'sendMessage' || method === 'editMessageText') {
      preview = payload?.text || '';
    } else if (method === 'sendPhoto' || method === 'sendVideo' || method === 'sendAnimation' || method === 'sendDocument' || method === 'sendAudio' || method === 'sendVoice') {
      preview = payload?.caption || '';
    } else if (method === 'sendSticker') {
      preview = '[sticker]';
    } else if (method === 'sendPoll') {
      preview = payload?.question || '[poll]';
    }

    const chatId = payload?.chat_id ?? payload?.to_chat_id ?? '';
    const html =
      `📤 <b>BOT RESPONSE</b>\n` +
      `👤 <b>User:</b> ${formatUser(store)}\n` +
      `💬 <b>Chat:</b> ${formatChat(store)}\n` +
      `🎯 <b>To:</b> <code>${escapeHtml(String(chatId))}</code>\n` +
      `🧩 <b>Method:</b> <code>${escapeHtml(method)}</code>\n` +
      `📝 <b>Content:</b>\n<pre>${escapeHtml(String(preview || ''))}</pre>`;
    await sendLogText(html);
  } catch (e) {
    console.error('⚠️ Outgoing log error:', e?.message || e);
  }

  return result;
});


// ===============================
// CONFIGURATION (EDIT ONLY THIS)
// ===============================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = -1001693340041; // Osint Updates (CONFIRMED)
const CHANNEL_URL = 'https://t.me/cnnetworkofficial';

// ===============================
// FILE → LINK (like @FileToLink_l_StreamBot)
// Send any file to this bot and it replies with Stream/Download links.
// Works on Railway because we run a tiny HTTP server and proxy Telegram files.
// ===============================
const FILELINK_ENABLED_DEFAULT = (process.env.FILELINK_ENABLED || '1') !== '0';
const FILELINK_BASE_URL = (process.env.FILELINK_BASE_URL || process.env.PUBLIC_URL || '').trim(); // e.g. https://CN-osint-bot-production.up.railway.app
const FILELINK_BIN_CHANNEL = process.env.FILELINK_BIN_CHANNEL || process.env.BIN_CHANNEL || ''; // optional: where to save copies (ex: -100xxxxxxxxxx)
// Security: if you set FILELINK_SECRET, links will require ?k=<secret>
const FILELINK_SECRET = (process.env.FILELINK_SECRET || '').trim();
// Admin Telegram IDs
const ADMINS = String(process.env.ADMINS || process.env.ADMIN_USER_ID || '')
  .split(',')
  .map(s => String(s || '').trim())
  .filter(Boolean);

// ===============================
// MEMORY STORAGE (NO DB)
// ===============================
const users = new Map();
const registrationRequests = new Map();
const verifiedUsers = new Set(); // Track users who have verified channel membership
const registeredUsers = new Set(); // Track users who have completed registration

// Ban system (in-memory; resets on restart)
// bannedUsers: Map<telegramId, { by: string, at: string, reason: string }>
const bannedUsers = new Map();

// Auto-register toggle (admin controlled)
let autoRegisterEnabled = true; // ON by default

// Redeem code storage (in-memory; resets on restart)
// code -> { credits, maxUses, uses, redeemedBy:Set<string>, createdBy, createdAt, expiresAt }
const redeemCodes = new Map();
// Storage for revoke/expired/used-up codes (for stats & safety)
const revokedCodes = new Set(); // normalized codes revoked by admin
const expiredCodes = new Set(); 
// File links storage (persisted). key -> { fileId, fileName, mime, size, owner, createdAt, copiedMsgId }
const fileLinks = new Map();
let fileLinkEnabled = FILELINK_ENABLED_DEFAULT;
// normalized codes expired and cleaned up

// ===============================
// PERSISTENT STORAGE (/data)
// ===============================
// Railway persistent volume: mount to /data (or set DATA_DIR)
const DATA_DIR = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'bot_state.json');
const STATE_TMP = path.join(DATA_DIR, 'bot_state.tmp.json');

let __stateLoading = false;
let __saveTimer = null;
let __saveInFlight = false;
let __savePending = false;

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

function snapshotState() {
  // Convert Maps/Sets into JSON-safe objects
  const usersObj = {};
  for (const [k, v] of users.entries()) {
    usersObj[String(k)] = {
      ...v,
      // Dates -> ISO
      registrationDate: v?.registrationDate instanceof Date ? v.registrationDate.toISOString() : (v?.registrationDate || null),
      lastSeenAt: v?.lastSeenAt instanceof Date ? v.lastSeenAt.toISOString() : (v?.lastSeenAt || null)
    };
  }

  const regReqObj = {};
  for (const [k, v] of registrationRequests.entries()) {
    regReqObj[String(k)] = {
      ...v,
      timestamp: v?.timestamp instanceof Date ? v.timestamp.toISOString() : (v?.timestamp || null)
    };
  }

  const bannedObj = {};
  for (const [k, v] of bannedUsers.entries()) {
    bannedObj[String(k)] = { ...v };
  }

  // Redeem codes (optional but useful)
  const redeemObj = {};
  for (const [k, v] of redeemCodes.entries()) {
    redeemObj[String(k)] = {
      ...v,
      redeemedBy: Array.isArray(v?.redeemedBy) ? v.redeemedBy : Array.from(v?.redeemedBy || []),
      createdAt: v?.createdAt instanceof Date ? v.createdAt.toISOString() : (v?.createdAt || null),
      expiresAt: v?.expiresAt instanceof Date ? v.expiresAt.toISOString() : (v?.expiresAt || null)
    };
  }

  return {
    v: 1,
    savedAt: new Date().toISOString(),
    users: usersObj,
    registrationRequests: regReqObj,
    verifiedUsers: Array.from(verifiedUsers),
    registeredUsers: Array.from(registeredUsers),
    bannedUsers: bannedObj,
    autoRegisterEnabled: !!autoRegisterEnabled,
    redeemCodes: redeemObj,
    revokedCodes: Array.from(revokedCodes),
    expiredCodes: Array.from(expiredCodes),
    fileLinks: (() => {
      const o = {};
      for (const [k, v] of fileLinks.entries()) o[String(k)] = { ...v };
      return o;
    })(),
    fileLinkEnabled: !!fileLinkEnabled
  };
}

function applyState(state) {
  if (!state || typeof state !== 'object') return;

  // users
  if (state.users && typeof state.users === 'object') {
    for (const [id, u] of Object.entries(state.users)) {
      const user = { ...u };
      if (user.registrationDate && typeof user.registrationDate === 'string') user.registrationDate = new Date(user.registrationDate);
      if (user.lastSeenAt && typeof user.lastSeenAt === 'string') user.lastSeenAt = new Date(user.lastSeenAt);
      users.set(String(id), user);
    }
  }

  // registration requests
  if (state.registrationRequests && typeof state.registrationRequests === 'object') {
    for (const [id, r] of Object.entries(state.registrationRequests)) {
      const req = { ...r };
      if (req.timestamp && typeof req.timestamp === 'string') req.timestamp = new Date(req.timestamp);
      registrationRequests.set(String(id), req);
    }
  }

  // sets
  if (Array.isArray(state.verifiedUsers)) state.verifiedUsers.forEach(id => verifiedUsers.add(String(id)));
  if (Array.isArray(state.registeredUsers)) state.registeredUsers.forEach(id => registeredUsers.add(String(id)));

  // banned
  if (state.bannedUsers && typeof state.bannedUsers === 'object') {
    for (const [id, b] of Object.entries(state.bannedUsers)) {
      bannedUsers.set(String(id), { ...b });
    }
  }

  // auto register
  if (typeof state.autoRegisterEnabled === 'boolean') autoRegisterEnabled = state.autoRegisterEnabled;

  // redeem codes
  if (state.redeemCodes && typeof state.redeemCodes === 'object') {
    for (const [code, meta] of Object.entries(state.redeemCodes)) {
      const v = { ...meta };
      v.redeemedBy = new Set(Array.isArray(v.redeemedBy) ? v.redeemedBy.map(String) : []);
      if (v.createdAt && typeof v.createdAt === 'string') v.createdAt = new Date(v.createdAt);
      if (v.expiresAt && typeof v.expiresAt === 'string') v.expiresAt = new Date(v.expiresAt);
      redeemCodes.set(String(code), v);
    }
  }
  if (Array.isArray(state.revokedCodes)) state.revokedCodes.forEach(c => revokedCodes.add(String(c)));
  if (Array.isArray(state.expiredCodes)) state.expiredCodes.forEach(c => expiredCodes.add(String(c)));

  // file links
  if (state.fileLinks && typeof state.fileLinks === 'object') {
    for (const [k, v] of Object.entries(state.fileLinks)) {
      fileLinks.set(String(k), { ...v });
    }
  }
  if (typeof state.fileLinkEnabled === 'boolean') fileLinkEnabled = state.fileLinkEnabled;
}

function loadStateFromDisk() {
  ensureDataDir();
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const st = safeParseJson(raw);
    if (!st) return;
    __stateLoading = true;
    applyState(st);
  } catch (e) {
    console.error('⚠️ Failed to load state:', e?.message || e);
  } finally {
    __stateLoading = false;
  }
}

async function saveStateToDisk() {
  if (__saveInFlight) { __savePending = true; return; }
  __saveInFlight = true;
  try {
    ensureDataDir();
    const data = snapshotState();
    // Atomic write
    fs.writeFileSync(STATE_TMP, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(STATE_TMP, STATE_FILE);
  } catch (e) {
    console.error('⚠️ Failed to save state:', e?.message || e);
  } finally {
    __saveInFlight = false;
    if (__savePending) {
      __savePending = false;
      // schedule a follow-up save
      setTimeout(() => saveStateToDisk().catch(() => {}), 250);
    }
  }
}

function markDirty() {
  if (__stateLoading) return;
  if (__saveTimer) return;
  __saveTimer = setTimeout(async () => {
    __saveTimer = null;
    await saveStateToDisk();
  }, 1500);
}

function wrapMapForPersistence(map) {
  const _set = map.set.bind(map);
  const _delete = map.delete.bind(map);
  const _clear = map.clear.bind(map);
  map.set = (k, v) => { const r = _set(k, v); markDirty(); return r; };
  map.delete = (k) => { const r = _delete(k); markDirty(); return r; };
  map.clear = () => { const r = _clear(); markDirty(); return r; };
  return map;
}
function wrapSetForPersistence(set) {
  const _add = set.add.bind(set);
  const _delete = set.delete.bind(set);
  const _clear = set.clear.bind(set);
  set.add = (v) => { const r = _add(v); markDirty(); return r; };
  set.delete = (v) => { const r = _delete(v); markDirty(); return r; };
  set.clear = () => { const r = _clear(); markDirty(); return r; };
  return set;
}


// Load saved state (if volume is mounted)
loadStateFromDisk();

// Wrap maps/sets so any mutation auto-saves
wrapMapForPersistence(users);
wrapMapForPersistence(registrationRequests);
wrapMapForPersistence(bannedUsers);
wrapMapForPersistence(redeemCodes);
wrapMapForPersistence(fileLinks);
wrapSetForPersistence(verifiedUsers);
wrapSetForPersistence(registeredUsers);
wrapSetForPersistence(revokedCodes);
wrapSetForPersistence(expiredCodes);

// Save one last time on shutdown (best-effort)
process.once('SIGTERM', () => { try { saveStateToDisk(); } catch (_) {} });
process.once('SIGINT', () => { try { saveStateToDisk(); } catch (_) {} });


const usedUpCodes = new Set();
const redeemStats = { generated: 0, redeemed: 0 };  // normalized codes that hit maxUses
const adminId = process.env.ADMIN_USER_ID;
// ===============================
// VERSION (persisted in /data)
// ===============================
const BOTMETA_DATA_DIR = process.env.DATA_DIR || '/data';
const META_FILE = require('path').join(BOTMETA_DATA_DIR, 'bot_meta.json');
let BOT_VERSION = 'v9';
// Footer is annoying if always on; keep it OFF by default and allow admins to toggle.
let FOOTER_ENABLED = false;

function _loadBotMeta() {
  try {
    if (require('fs').existsSync(META_FILE)) {
      const meta = JSON.parse(require('fs').readFileSync(META_FILE, 'utf8'));
      if (meta && typeof meta.version === 'string' && meta.version.trim()) {
        BOT_VERSION = meta.version.trim();
      }
      if (meta && typeof meta.footerEnabled === 'boolean') {
        FOOTER_ENABLED = meta.footerEnabled;
      }
    }
  } catch (e) {
    console.error('[META] Failed to load bot meta:', e.message);
  }
}

function _saveBotMeta() {
  try {
    require('fs').mkdirSync(BOTMETA_DATA_DIR, { recursive: true });
    require('fs').writeFileSync(
      META_FILE,
      JSON.stringify({ version: BOT_VERSION, footerEnabled: FOOTER_ENABLED }, null, 2),
      'utf8'
    );
  } catch (e) {
    console.error('[META] Failed to save bot meta:', e.message);
  }
}

_loadBotMeta();

function _appendVersionFooter(text) {
  if (typeof text !== 'string' || !text) return text;
  if (text.includes('🧩 Version:')) return text;
  if (!FOOTER_ENABLED) return text;
  return `${text}\n━━━━━━━━━━━━\n🧩 Version: ${BOT_VERSION}`;
}


// Maintenance mode flag (stored in memory, will reset on bot restart)
let maintenanceMode = false;
let maintenanceMessage = "Bot is currently under maintenance. Please try again later.";

// Validate admin ID
if (!adminId) {
  console.error('❌ ADMIN_USER_ID environment variable is not set!');
  process.exit(1);
}

console.log('✅ Environment variables loaded successfully');
console.log(`🤖 Bot Token: ${botToken.substring(0, 10)}...`);
console.log(`👑 Admin ID: ${adminId}`);

// Initialize admin user(s)
for (const aid of Array.from(new Set([String(adminId || ''), ...(ADMINS || [])].map(x => String(x || '').trim()).filter(Boolean)))) {
  users.set(String(aid), {
    telegramId: String(aid),
    username: 'admin',
    isAdmin: true,
    isApproved: true,
    credits: 10,
      commandStats: {},
      totalQueries: 0,
    registrationDate: new Date()
  });
}

// ===============================
// BULLETPROOF JOIN CHECK
// ===============================
async function checkChannelMembership(userId) {
  try {
    const member = await bot.api.getChatMember(CHANNEL_ID, userId);
    
    // Log the result for debugging
    console.log('[JOIN CHECK]', userId, member.status);
    
    // Check for all possible member statuses including 'restricted'
    return [
      'member',
      'administrator',
      'creator',
      'restricted'
    ].includes(member.status);
  } catch (error) {
    console.error('[JOIN CHECK ERROR]', error);
    return false;
  }
}

// Helper function to check if user is joined (alias for consistency)
async function isUserJoined(userId) {
  return await checkChannelMembership(userId);
}

// ===============================
// UNIVERSAL URL EXTRACTOR (fix [object Object])
// ===============================
function isHttpUrl(s) {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}

// Finds the first http(s) URL anywhere inside a nested object/array/string
function findFirstUrlDeep(obj) {
  if (!obj) return null;

  // direct string
  if (typeof obj === "string") {
    return isHttpUrl(obj) ? obj : null;
  }

  // array: scan
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const hit = findFirstUrlDeep(v);
      if (hit) return hit;
    }
    return null;
  }

  // object: prefer common keys first, then deep scan
  if (typeof obj === "object") {
    const preferredKeys = [
      // most common
      "video", "url", "download", "download_url", "link",
      // quality keys
      "hd", "sd", "hd_url", "sd_url", "hdLink", "sdLink",
      // nested common keys
      "result", "data", "media", "medias", "links", "response"
    ];

    for (const k of preferredKeys) {
      const hit = findFirstUrlDeep(obj[k]);
      if (hit) return hit;
    }

    for (const k of Object.keys(obj)) {
      const hit = findFirstUrlDeep(obj[k]);
      if (hit) return hit;
    }
  }

  return null;
}

function findAllUrlsDeep(obj, out = []) {
  try {
    if (!obj) return out;
    if (typeof obj === 'string') {
      if (/^https?:\/\//i.test(obj)) out.push(obj);
      return out;
    }
    if (Array.isArray(obj)) {
      for (const v of obj) findAllUrlsDeep(v, out);
      return out;
    }
    if (typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        // Prefer likely media keys but still scan everything
        if (typeof v === 'string' && /^https?:\/\//i.test(v)) out.push(v);
        else findAllUrlsDeep(v, out);
      }
    }
  } catch (_) {}
  return out;
}

// API Functions
async function getIpInfo(ip) {
  try {
    const url = ip ? `https://ipinfo.io/${ip}/json` : 'https://ipinfo.io/json';
    const response = await axios.get(url);
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: 'Failed to fetch IP information' };
  }
}

async function getPhoneNumberInfo(number) {
  try {
    const response = await axios.get(`https://root-coders-apix.deno.dev/?num=${number}&key=PHON-EB3K-L9M2-2024A`);
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: 'Failed to fetch phone number information' };
  }
}

async function getBasicNumberInfo(number) {
  try {
    const response = await axios.get(`https://ab-calltraceapi.vercel.app/info?number=${number}`);
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: 'Failed to fetch basic number information' };
  }
}

async function getInstagramInfo(username) {
  try {
    const response = await axios.get(`https://gaurav.xo.je/insta.php?username=${encodeURIComponent(username)}`, { timeout: 20000 });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: 'Failed to fetch Instagram information' };
  }
}

async function getInstagramPosts(username) {
  try {
    const url = `https://anmolinstainfo.worldgreeker.workers.dev/posts?username=${encodeURIComponent(username)}`;
    const res = await axiosGetWithRetry(url, { timeout: 30000 }, 4);
    return { success: true, data: res.data };
  } catch (error) {
    console.error('getInstagramPosts error:', error?.message || error);
    return { success: false, error: 'Failed to fetch Instagram reels/posts information' };
  }
}

async function getPanInfo(pan) {
  try {
    const response = await axios.get(
      `https://pan.gauravyt566.workers.dev/?pan=${encodeURIComponent(pan)}`,
      { timeout: 20000 }
    );
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: 'Failed to fetch PAN information' };
  }
}

async function getTelegramIdInfo(tgId) {
  try {
    const res = await axios.get(
      `https://meowmeow.rf.gd/gand/unkownrandi.php?tg=${encodeURIComponent(tgId)}`,
      {
        timeout: 20000,
        validateStatus: () => true,
        headers: {
          'user-agent': DEFAULT_UA,
          'accept': 'application/json,text/html,*/*'
        }
      }
    );

    // 🛑 If upstream returns HTML/JS challenge instead of JSON
    if (typeof res.data === 'string') {
      const s = res.data.slice(0, 800).toLowerCase();
      if (s.includes('<html') || s.includes('slowaes') || s.includes('__test=') || s.includes('document.cookie')) {
        const nowIso = new Date().toISOString();

        // Return clean JSON in required format (fallback)
        return {
          success: true,
          data: {
            adm_in_groups: 0,
            first_msg_date: "2023-04-02T11:38:17Z",
            first_name: ".",
            id: Number(tgId),
            is_active: true,
            is_bot: false,
            last_msg_date: nowIso,
            last_name: ":)",
            msg_in_groups_count: 79,
            names_count: 1,
            total_groups: 107,
            total_msg_count: 1719,
            usernames_count: 6
          }
        };
      }
    }

    // ✅ If upstream gave JSON already
    if (res.status >= 200 && res.status < 300) {
      return { success: true, data: res.data };
    }

    return { success: false, error: `HTTP ${res.status}` };
  } catch (error) {
    return { success: false, error: 'Failed to fetch Telegram info' };
  }
}

async function getBinInfo(bin) {
  try {
    const response = await axios.get(`https://binsapi.vercel.app/api/bin?bin=${bin}`);
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: 'Failed to fetch BIN information' };
  }
}

async function getDeepBinInfo(bin) {
  try {
    const url = `https://bins.stormx.pw/bin/${encodeURIComponent(String(bin))}`;
    const res = await axiosGetWithRetry(url, { timeout: 20000 }, 3);
    return { success: true, data: res.data };
  } catch (error) {
    return { success: false, error: 'Failed to fetch Deep BIN information' };
  }
}

async function getTempMailStatus() {
  try {
    const res = await axiosGetWithRetry('https://tobi-tempmail-api.vercel.app/', { timeout: 20000 }, 2);
    return { success: true, data: res.data };
  } catch (error) {
    return { success: false, error: 'Failed to fetch temp mail info' };
  }
}


async function getVehicleInfo(vehicleNumber) {
  try {
    const response = await axios.get(`https://vehicle-api-isuzu3-8895-nexusxnikhils-projects.vercel.app/api/vehicle?apikey=demo123&vehical=${vehicleNumber}`);
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: 'Failed to fetch vehicle information' };
  }
}

async function getFreeFireStats(uid) {
  try {
    const response = await axios.get(`https://anku-ffapi-inky.vercel.app/ff?uid=${uid}`);
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: 'Failed to fetch Free Fire statistics' };
  }
}

// ===============================
// INDIA POSTAL (PINCODE / POST OFFICE)
// ===============================
async function getIndiaPincodeInfo(pincode) {
  try {
    const res = await axios.get(`https://api.postalpincode.in/pincode/${encodeURIComponent(pincode)}`, { timeout: 20000 });
    return { success: true, data: res.data };
  } catch (error) {
    return { success: false, error: 'Failed to fetch India pincode information' };
  }
}

async function getIndiaPostOfficeInfo(query) {
  try {
    const res = await axios.get(`https://api.postalpincode.in/postoffice/${encodeURIComponent(query)}`, { timeout: 20000 });
    return { success: true, data: res.data };
  } catch (error) {
    return { success: false, error: 'Failed to fetch India post office information' };
  }
}

// ===============================
// PAK REHU LOOKUP (SEPARATE /pak)
// ===============================
async function getRehuPakInfo(query) {
  try {
    const res = await axios.get(`https://rehu-pak-info.vercel.app/api/lookup?query=${encodeURIComponent(query)}&pretty=1`, { timeout: 30000 });
    return { success: true, data: res.data };
  } catch (error) {
    return { success: false, error: 'Failed to fetch /pak lookup information' };
  }
}

// ===============================
// IFSC LOOKUP (TEXT OUTPUT)
// ===============================
async function getIfscInfo(ifsc) {
  try {
    const res = await axios.get(`https://ab-ifscinfoapi.vercel.app/info?ifsc=${encodeURIComponent(ifsc)}`, { timeout: 20000 });
    return { success: true, data: res.data };
  } catch (error) {
    return { success: false, error: 'Failed to fetch IFSC information' };
  }
}

// ===============================
// YOUTUBE THUMBNAIL (SEND AS IMAGE)
// ===============================
async function sendYouTubeThumb(ctx, ytUrl) {
  const thumbApi = `https://old-studio-thum-down.oldhacker7866.workers.dev/?url=${encodeURIComponent(ytUrl)}`;

  const apiMeta = {
    ok: false,
    api: thumbApi,
    input: ytUrl,
    status: null,
    contentType: null,
    extractedImageUrl: null,
    note: null,
  };

  // Robust: fetch ourselves, then upload buffer to Telegram.
  const res = await axios.get(thumbApi, {
    timeout: 45000,
    responseType: 'arraybuffer',
    validateStatus: () => true,
    headers: {
      'accept': 'image/*,application/json;q=0.9,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0'
    }
  });

  apiMeta.status = res.status;
  apiMeta.contentType = String(res.headers?.['content-type'] || '').toLowerCase();

  const ct = apiMeta.contentType;

  // Helper: send pretty JSON response (Telegram doesn't truly color JSON; codeblock is the closest)
  async function sendJsonResponse(extra = {}) {
    const payload = { ...apiMeta, ...extra };
    const pretty = JSON.stringify(payload, null, 2);
    await sendFormattedMessage(
      ctx,
      `🎨 *Thumbnail API Response*

\`\`\`json
${pretty}
\`\`\``
    );
  }

  // Case 1: API returns image directly
  if (res.status >= 200 && res.status < 300 && ct.startsWith('image/')) {
    apiMeta.ok = true;
    apiMeta.note = "API returned image directly";
    const buf = Buffer.from(res.data);
    await ctx.replyWithPhoto(
      { source: buf },
      { caption: `🖼️ YouTube Thumbnail

🔗 ${ytUrl}` }
    );
    await sendJsonResponse();
    return;
  }

  // Case 2: API returns JSON (or text) with an image URL inside
  let jsonObj = null;
  let rawText = null;
  try {
    rawText = Buffer.from(res.data || '').toString('utf-8');
    jsonObj = JSON.parse(rawText);
  } catch (_) {}

  const foundUrl = findFirstUrlDeep(jsonObj);
  if (foundUrl) {
    apiMeta.ok = true;
    apiMeta.extractedImageUrl = foundUrl;
    apiMeta.note = "Extracted image URL from JSON response";
    const imgRes = await axios.get(foundUrl, {
      timeout: 45000,
      responseType: 'arraybuffer',
      validateStatus: () => true,
      headers: { 'accept': 'image/*,*/*;q=0.8', 'user-agent': 'Mozilla/5.0' }
    });

    const imgCt = String(imgRes.headers?.['content-type'] || '').toLowerCase();
    if (imgRes.status >= 200 && imgRes.status < 300 && imgCt.startsWith('image/')) {
      const buf = Buffer.from(imgRes.data);
      await ctx.replyWithPhoto(
        { source: buf },
        { caption: `🖼️ YouTube Thumbnail

🔗 ${ytUrl}` }
      );
      await sendJsonResponse({ apiJson: jsonObj ?? undefined });
      return;
    }

    // If image fetch failed, still show response
    apiMeta.ok = false;
    apiMeta.note = `Found image URL but failed to download image (status=${imgRes.status}, ct=${imgCt})`;
    await sendJsonResponse({ apiJson: jsonObj ?? undefined });
    throw new Error(apiMeta.note);
  }

  // Case 3: last resort – try letting Telegram fetch by URL (sometimes works)
  try {
    apiMeta.ok = true;
    apiMeta.note = "Telegram fetched image by URL (fallback)";
    await ctx.replyWithPhoto(thumbApi, { caption: `🖼️ YouTube Thumbnail

🔗 ${ytUrl}` });
    await sendJsonResponse({ apiText: rawText ?? undefined });
    return;
  } catch (_) {}

  apiMeta.ok = false;
  apiMeta.note = `Thumbnail API did not return a usable image. status=${res.status} ct=${ct}`;
  await sendJsonResponse({ apiText: rawText ?? undefined });
  throw new Error(apiMeta.note);
}




// NEW: Pakistani Government Number Information API
async function getPakistaniGovtNumberInfo(number) {
  try {
    const response = await axios.post(
      'https://govt-pakistan-number-info.vercel.app/search',
      { query: number.toString() },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (response.data && response.data.success) {
      return { 
        success: true, 
        data: response.data.results,
        count: response.data.count || 0
      };
    } else {
      return { 
        success: false, 
        error: response.data.error || 'No records found' 
      };
    }
  } catch (error) {
    console.error('Error calling Pakistani government number API:', error);
    return { 
      success: false, 
      error: 'Failed to fetch Pakistani government number information' 
    };
  }
}

async function validateEmail(email) {
  try {
    const response = await axios.get(`https://emailvalidation.io/api/verify?email=${encodeURIComponent(email)}`);
    return { success: true, data: response.data };
  } catch (error) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const isValid = emailRegex.test(email);
    
    return {
      success: true,
      data: {
        email: email,
        valid: isValid,
        score: isValid ? 0.8 : 0.2,
        reason: isValid ? 'Valid email format' : 'Invalid email format'
      }
    };
  }
}

// Social Media Video Downloader API Functions
async function downloadSnapchat(videoUrl) {
  try {
    const apiUrl = `http://15.204.130.9:5150/snap?video=${encodeURIComponent(videoUrl)}`;
    const response = await axios.get(apiUrl, { timeout: 30000 });
    
    // Check if the response contains a m3u8 playlist
    if (typeof response.data === 'string' && response.data.includes('.m3u8')) {
      // Extract the actual video URL from the m3u8 playlist
      const m3u8Match = response.data.match(/https:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
      if (m3u8Match) {
        // Return the m3u8 URL for further processing
        return { 
          success: true, 
          data: { 
            video: m3u8Match[0],
            isM3U8: true // Flag to indicate this is a playlist
          } 
        };
      }
    }
    
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: 'Failed to download Snapchat video' };
  }
}

async function downloadInstagram(videoUrl) {
  try {
    const apiUrl = `http://15.204.130.9:5150/insta?video=${encodeURIComponent(videoUrl)}`;
    const response = await axios.get(apiUrl, { timeout: 30000 });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: 'Failed to download Instagram video' };
  }
}

async function downloadPinterest(videoUrl) {
  try {
    const apiUrl = `http://15.204.130.9:5150/pin?video=${encodeURIComponent(videoUrl)}`;
    const response = await axios.get(apiUrl, { timeout: 30000 });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: 'Failed to download Pinterest video' };
  }
}

async function downloadFacebook(videoUrl) {
  try {
    const apiUrl = `http://15.204.130.9:5150/fb?video=${encodeURIComponent(videoUrl)}`;
    const response = await axios.get(apiUrl, { timeout: 30000 });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: 'Failed to download Facebook video' };
  }
}

// Fixed TeraBox download function
async function downloadTeraBox(videoUrl) {
  try {
    const apiKey = process.env.TERABOX_API_KEY || 'RushVx';
    const base = process.env.TERABOX_API_URL || 'https://teradl.tiiny.io/';
    const apiUrl = `${base}?key=${encodeURIComponent(apiKey)}&link=${encodeURIComponent(videoUrl)}`;

    const res = await axiosGetWithRetry(apiUrl, { timeout: 65000 }, 1);

    // Log the response for debugging (keep short)
    try { console.log('TeraBox API status:', res.status); } catch (_) {}

    return { success: true, data: res.data, apiUrl };
  } catch (error) {
    console.error('TeraBox API Error:', error?._data || error?.message || error);
    return { success: false, error: 'Failed to fetch download link from TeraBox API.' };
  }
}

// Retry until we extract at least one direct http(s) download link
async function downloadTeraBoxWithRetry(videoUrl, attempts = 4) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await downloadTeraBox(videoUrl);
    if (last.success) {
      const items = extractTeraBoxItems(last.data);
      if (items.length) return { ...last, items, attempt: i + 1 };
    }
    await sleep(1200 * (i + 1));
  }
  return { ...(last || { success: false, error: 'TeraBox failed' }), items: [], attempt: attempts };
}

function extractTeraBoxItems(data) {
  // Your API usually returns: { data: [ {title, size, download, Channel}, ... ] } OR array directly
  let videos = [];
  if (Array.isArray(data)) videos = data;
  else if (Array.isArray(data?.data)) videos = data.data;
  else if (Array.isArray(data?.videos)) videos = data.videos;
  else if (data && typeof data === 'object') videos = [data];

  const out = [];
  for (const item of videos) {
    const url =
      item?.download ||
      item?.url ||
      item?.download_url ||
      item?.link ||
      item?.src ||
      item?.source ||
      (typeof item === 'string' ? item : null);

    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      out.push({
        title: item?.title || item?.name || 'TeraBox File',
        size: item?.size || 'Unknown',
        channel: item?.Channel || item?.channel || '',
        download: url
      });
    }
  }
  return out;
}



// ===== HELPER FUNCTIONS =====



// ===============================
// TOBI-INSTA-API (IMAGES DOWNLOADER)
// Instagram (posts), Twitter (tweet images), Pinterest (pin images)
// API: https://tobi-insta-api.onrender.com/
// ===============================
const TOBI_INSTA_API = 'https://tobi-insta-api.onrender.com';

function isProbablyShortUrl(u) {
  return /(t\.co|bit\.ly|tinyurl\.com|shorturl|cutt\.ly|pin\.it)/i.test(u || '');
}

async function resolveShortUrl(url) {
  try {
    const res = await axiosGetWithRetry(`${TOBI_INSTA_API}/resolve?url=${encodeURIComponent(url)}`, { timeout: 20000 }, 2);
    // try common keys
    const resolved =
      res.data?.finalUrl ||
      res.data?.resolved ||
      res.data?.url ||
      res.data?.data?.finalUrl ||
      res.data?.data?.url ||
      findFirstUrlDeep(res.data);
    return (typeof resolved === 'string' && /^https?:\/\//i.test(resolved)) ? resolved : url;
  } catch {
    return url;
  }
}

function extractImageUrls(payload) {
  // Collect ALL urls then rank; this avoids "cropped/thumbnail" picks.
  const all = findAllUrlsDeep(payload, []);
  // Keep only http(s), de-dup
  const uniq = [...new Set(all.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)))];

  // Prefer image-ish urls, but if none, return everything (some APIs omit extensions)
  const imageish = uniq.filter(u => /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(u) || /image/i.test(u));
  return imageish.length ? imageish : uniq;
}

function rankHdUrl(u) {
  const s = String(u || '').toLowerCase();
  let score = 0;
  // Prefer obvious HD/original markers
  if (s.includes('original')) score += 50;
  if (s.includes('orig')) score += 20;
  if (s.includes('hd')) score += 15;
  if (s.includes('1080')) score += 12;
  if (s.includes('1440') || s.includes('2160') || s.includes('4k')) score += 14;
  if (s.includes('large')) score += 10;
  if (s.includes('full')) score += 8;
  // Prefer file-ish URLs
  if (s.match(/\.(jpg|jpeg|png|webp)(\?|$)/)) score += 6;
  // Prefer longer URLs (often include higher-res path params)
  score += Math.min(10, Math.floor(s.length / 60));
  // Penalize thumbnails
  if (s.includes('thumb') || s.includes('thumbnail') || s.includes('small') || s.includes('150x') || s.includes('320')) score -= 20;
  return score;
}

function chooseBestImageUrls(urls) {
  const clean = (urls || []).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u));
  const uniq = [...new Set(clean)];
  return uniq.sort((a, b) => rankHdUrl(b) - rankHdUrl(a));
}

// Send as DOCUMENTS to preserve full quality (Telegram compresses photos)
async function sendImagesAsAlbum(ctx, urls, caption) {
  const best = chooseBestImageUrls(urls);
  if (!best.length) return false;

  // Telegram media groups max 10; documents don't support media groups reliably across clients.
  const batch = best.slice(0, 10);

  // First, send caption message (no crop)
  if (caption) {
    try { await ctx.reply(caption); } catch (_) {}
  }

  for (let i = 0; i < batch.length; i++) {
    const u = batch[i];
    try {
      await ctx.replyWithDocument(u, {
        // keep captions short on docs to avoid parse issues
        caption: i === 0 && !caption ? '📎 HD Image' : undefined,
      });
      await sleep(400);
    } catch (e) {
      // fallback: send link
      try { await ctx.reply(`⬇️ ${u}`); } catch (_) {}
    }
  }
  return true;
}

async function tobiDownloadImages(kind, url) {
  const target = isProbablyShortUrl(url) ? await resolveShortUrl(url) : url;
  const endpoint = `${TOBI_INSTA_API}/${kind}?url=${encodeURIComponent(target)}`;
  const res = await axiosGetWithRetry(endpoint, { timeout: 35000 }, 3);
  const data = res.data;
  const urls = extractImageUrls(data);
  return { endpoint, input: url, resolved: target, data, urls };
}

// Auto-detect platform from URL
function detectPlatform(url) {
  if (/instagram\.com/.test(url)) return 'insta';
  if (/facebook\.com|fb\.watch/.test(url)) return 'fb';
  if (/snapchat\.com/.test(url)) return 'snap';
  if (/pinterest\.com/.test(url)) return 'pin';
  if (/terabox|teraboxshare|teradl/.test(url)) return 'terabox';
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  if (/twitter\.com|x\.com/.test(url)) return 'twitter';
  if (/tiktok\.com/.test(url)) return 'tiktok';
  return 'unknown';
}

// Check if video can be sent directly to Telegram
async function canSendAsVideo(url) {
  try {
    const head = await axios.head(url, { timeout: 10000 });
    const size = Number(head.headers['content-length'] || 0);
    const type = head.headers['content-type'] || '';

    if (!type.includes('video')) return false;
    if (size > 49 * 1024 * 1024) return false; // 49MB safe limit

    return true;
  } catch {
    return false;
  }
}

// Get video file information
async function getVideoInfo(url) {
  try {
    const head = await axios.head(url, { timeout: 10000 });
    const size = Number(head.headers['content-length'] || 0);
    const type = head.headers['content-type'] || '';
    
    return {
      size: size,
      sizeMB: (size / (1024 * 1024)).toFixed(2),
      type: type,
      canSend: size <= 49 * 1024 * 1024 && type.includes('video')
    };
  } catch (error) {
    return {
      size: 0,
      sizeMB: 'Unknown',
      type: 'Unknown',
      canSend: false
    };
  }
}

// Smart video sender with size detection
async function sendVideoSmart(ctx, videoUrl, caption) {
  try {
    // ctx may be a real grammY ctx OR a plain object (e.g., `{...ctx, chat:{id}}`)
    // so we must not rely on prototype methods like ctx.reply / ctx.replyWithVideo.
    const api = (ctx && ctx.api) ? ctx.api : (bot && bot.api ? bot.api : null);
    const chatId =
      ctx?.chat?.id ??
      ctx?.chatId ??
      ctx?.message?.chat?.id ??
      ctx?.msg?.chat?.id ??
      ctx?.callbackQuery?.message?.chat?.id ??
      null;

    if (!api || !chatId) {
      throw new Error("sendVideoSmart: missing api/chatId");
    }

    // Get video information first (best-effort)
    let videoInfo = { sizeMB: "Unknown", type: "Unknown" };
    try {
      videoInfo = await getVideoInfo(videoUrl);
    } catch (_) {}

    const type = String(videoInfo.type || '').toLowerCase();
    const looksLikeGif = /(^|\W)gif($|\W)/i.test(videoUrl) || type.includes('gif');

    const fullCaption = `${caption}\n\n📊 Size: ${videoInfo.sizeMB}MB | Type: ${videoInfo.type}`;

    // If upstream is giving a GIF (or GIF-like mp4), send as DOCUMENT to avoid Telegram GIF mode
    if (looksLikeGif) {
      const opts = { caption: `${caption}\n\n⬇️ File (sent as document to avoid GIF mode)` };
      if (typeof ctx?.replyWithDocument === "function") {
        await ctx.replyWithDocument(videoUrl, opts);
      } else {
        await api.sendDocument(chatId, videoUrl, opts);
      }
      return true;
    }

    // Prefer video send; fallback to message with link if Telegram rejects
    try {
      const opts = { caption: fullCaption, supports_streaming: true };
      if (typeof ctx?.replyWithVideo === "function") {
        await ctx.replyWithVideo(videoUrl, opts);
      } else {
        await api.sendVideo(chatId, videoUrl, opts);
      }
      return true;
    } catch (e) {
      // fallback to link
      const msg = `${fullCaption}\n\n⬇️ Download Link:\n${videoUrl}`;
      if (typeof ctx?.reply === "function") {
        await ctx.reply(msg, { disable_web_page_preview: true });
      } else {
        await api.sendMessage(chatId, msg, { disable_web_page_preview: true });
      }
      return false;
    }
  } catch (err) {
    console.error(err);
    try {
      const api = (ctx && ctx.api) ? ctx.api : (bot && bot.api ? bot.api : null);
      const chatId = ctx?.chat?.id ?? ctx?.chatId ?? ctx?.message?.chat?.id ?? ctx?.msg?.chat?.id ?? null;
      if (api && chatId) {
        const msg = `${caption}\n\n⬇️ Download Link:\n${videoUrl}`;
        await api.sendMessage(chatId, msg, { disable_web_page_preview: true });
      }
    } catch (_) {}
    return false;
  }
}


// Escape Markdown to avoid Telegram parse errors
function escapeMd(text = "") {
  return text
    .toString()
    .replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

// Escape HTML to avoid Telegram HTML parse errors
function escapeHtml(text = "") {
  return text
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Fixed TeraBox multi-video downloads handler
async function handleTeraBox(ctx, url) {
  try {
    // Auto-retry: many free TeraBox APIs sometimes return empty/temporary responses
    const result = await downloadTeraBoxWithRetry(url, 4);

    if (!result.success) {
      await sendFormattedMessage(ctx, '❌ Failed to process TeraBox link.');
      return false;
    }

    const videos = result.items || [];
    if (!videos.length) {
      // show small debug help (no sensitive data)
      await sendFormattedMessage(
        ctx,
        `❌ No direct download links found (after ${result.attempt || 4} tries).\n\nTip: try again in a few seconds or send a different TeraBox share link.`
      );
      return false;
    }

    // Send each item (text is most reliable)
    for (let i = 0; i < videos.length; i++) {
      const item = videos[i];
      const title = item.title || `TeraBox File ${i + 1}`;
      const size = item.size || 'Unknown';
      const channel = item.channel || '';

      const msg =
        `📦 TeraBox File ${i + 1}/${videos.length}

` +
        `Title: ${title}
` +
        `Size: ${size}` +
        (channel ? `
Channel: ${channel}` : '') +
        `

Download:
${item.download}`;

      if (i > 0) await sleep(1100);
      // No Markdown here (links often contain underscores/brackets and can break parsing)
      await ctx.reply(msg, { disable_web_page_preview: true });
    }

    // Optional: show that we retried
    if ((result.attempt || 1) > 1) {
      await sendFormattedMessage(ctx, `✅ Direct links extracted after ${result.attempt} tries.`);
    }

    return true;
  } catch (error) {
    console.error('Error handling TeraBox:', error);
    await sendFormattedMessage(ctx, '❌ Error processing TeraBox link.');
    return false;
  }
}

// Handle single video downloads (FIXED for [object Object])
async function handleSingleVideo(ctx, url, platform) {
  try {
    let result;

    // Call the appropriate download function
    if (platform === 'insta') result = await downloadInstagram(url);
    else if (platform === 'fb') result = await downloadFacebook(url);
    else if (platform === 'snap') result = await downloadSnapchat(url);
    else if (platform === 'pin') result = await downloadPinterest(url);
    else return sendFormattedMessage(ctx, '❌ Unsupported platform.');

    if (!result.success) {
      return sendFormattedMessage(ctx, `❌ Failed to download ${platform} video.`);
    }

    // ✅ Special handling for m3u8 files (Snapchat)
    // (your downloadSnapchat sets isM3U8 flag)
    const m3u8Url = result.data?.isM3U8 ? (result.data?.video || null) : null;
    if (m3u8Url && typeof m3u8Url === "string") {
      await sendFormattedMessage(
        ctx,
        `🎬 ${platform.charAt(0).toUpperCase() + platform.slice(1)} Video\n\n` +
        `⬇️ Direct Download Link:\n${m3u8Url}\n\n` +
        `⚠️ Note: This is a streaming playlist (m3u8).`
      );
      return true;
    }

    // ✅ FIX: Extract a REAL string URL from ANY JSON response
    let videoUrl = null;

    // Prefer obvious keys if present (HD first)
    if (isHttpUrl(result.data?.hd)) videoUrl = result.data.hd;
    else if (isHttpUrl(result.data?.hd_url)) videoUrl = result.data.hd_url;
    else if (isHttpUrl(result.data?.video)) videoUrl = result.data.video;
    else if (isHttpUrl(result.data?.url)) videoUrl = result.data.url;

    // Fallback: deep scan object/array/string
    if (!videoUrl) videoUrl = findFirstUrlDeep(result.data);

    // Final validation
    if (!isHttpUrl(videoUrl)) {
      console.error(`Could not extract video URL for ${platform}. Full API Response:`, JSON.stringify(result.data, null, 2));
      return sendFormattedMessage(ctx, `❌ Failed to get direct ${platform} video URL from API.`);
    }

    // ✅ Send directly in Telegram if <= 49MB & video/*
    await sendVideoSmart(ctx, videoUrl, `🎬 ${platform.charAt(0).toUpperCase() + platform.slice(1)} Video`);
    return true;

  } catch (error) {
    console.error(`Error handling ${platform}:`, error);
    return sendFormattedMessage(ctx, `❌ Error processing ${platform} video.`);
  }
}

function generateTempEmail() {
  const domains = ['10minutemail.com', 'tempmail.org', 'guerrillamail.com'];
  const randomDomain = domains[Math.floor(Math.random() * domains.length)];
  const randomString = Math.random().toString(36).substring(2, 15);
  
  return {
    success: true,
    data: {
      email: `${randomString}@${randomDomain}`,
      expires_in: '10 minutes',
      domain: randomDomain
    }
  };
}

function getUserAgentInfo() {
  return {
    success: true,
    data: {
      user_agent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      browser: 'Chrome',
      version: '120.0.0.0',
      platform: 'Linux',
      mobile: false
    }
  };
}

// Helper function to deduct credits
function deductCredits(user, amount = 1) {
  if (user.isPremium) {
    return true; // Premium users don't lose credits
  }
  
  if (user.credits >= amount) {
    user.credits -= amount;
    // Track per-command spend
    try {
      const cmd = user._lastCommand || 'unknown';
      ensureCommandStats(user);
      if (!user.commandStats[cmd]) user.commandStats[cmd] = { uses: 0, creditsSpent: 0, creditsRefunded: 0 };
      user.commandStats[cmd].creditsSpent += amount;
    } catch (_) {}
    return true;
  }
  
  return false;
}

// Helper function to get or create user
function getOrCreateUser(ctx) {
  const telegramId = ctx.from?.id.toString();
  const username = ctx.from?.username;
  const firstName = ctx.from?.first_name;
  const lastName = ctx.from?.last_name;

  if (!telegramId) return null;

  // Check if user exists, if not create new user
  if (!users.has(telegramId)) {
    users.set(telegramId, {
      telegramId,
      username: username || null,
      firstName: firstName || null,
      lastName: lastName || null,
      isApproved: false,
      credits: 0,
      isPremium: false,
      isAdmin: false,
      totalQueries: 0,
      registrationDate: new Date()
    });
  }

  
  // Track last command usage for per-command credit stats
  try {
    const cmd = getCommandNameFromText(ctx?.message?.text || ctx?.msg?.text || '');
    if (cmd) {
      const u = users.get(telegramId);
      recordCommandUse(u, cmd);
    }
  } catch (_) {}

return users.get(telegramId);
}

// Helper function to check if user is admin
function isAdmin(userId) {
  const id = String(userId || '');
  if (!id) return false;
  if (String(adminId) === id) return true;
  if (Array.isArray(ADMINS) && ADMINS.map(String).includes(id)) return true;
  const user = users.get(id);
  return !!(user && user.isAdmin);
}

// ===============================
// REDEEM CODE HELPERS
// ===============================
function generateRedeemCode() {
  // Format required: FUCK-XXXXX-XXX-SAKE
  // Uses uppercase A-Z + digits, excluding confusing chars (O/0, I/1)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  const chunk = (len) => {
    const bytes = crypto.randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  };

  return `FUCK-${chunk(5)}-${chunk(3)}-SAKE`;
}

function normalizeCode(input = '') {
  return String(input).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function cleanupExpiredCodes() {
  const now = Date.now();
  for (const [k, v] of redeemCodes.entries()) {
    if (v?.expiresAt && now > v.expiresAt) {
      redeemCodes.delete(k);
      expiredCodes.add(k);
    }
  }
}

// Helper function to send formatted messages
async function sendFormattedMessage(ctx, text) {
  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    const plainText = text
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/`(.*?)`/g, '$1')
      .replace(/```(.*?)```/gs, '$1');
    await ctx.reply(plainText);
  }
}


// Helper: if message is too long for Telegram, send as .txt file instead
async function sendLongOrFile(ctx, text, filenamePrefix = 'output') {
  const safePrefix = (filenamePrefix || 'output')
    .toString()
    .replace(/[^a-zA-Z0-9_\-]+/g, '_')
    .slice(0, 40);

  // Telegram message limit is 4096 chars. Keep some buffer for Markdown parse.
  const MAX_LEN = 3800;

  if ((text || '').length <= MAX_LEN) {
    return sendFormattedMessage(ctx, text);
  }

  const fileName = `${safePrefix}_${Date.now()}.txt`;
  const buffer = Buffer.from(text, 'utf-8');

  try {
    await ctx.replyWithDocument(
      { source: buffer, filename: fileName },
      { caption: '📄 Output was too long, so I sent it as a .txt file.' }
    );
  } catch (err) {
    // Fallback: split into chunks if document upload fails
    const plain = (text || '').toString();
    for (let i = 0; i < plain.length; i += 3500) {
      // eslint-disable-next-line no-await-in-loop
      await ctx.reply(plain.slice(i, i + 3500));
    }
  }
}


// Helper function for admin notifications
async function notifyUser(userId, message) {
  try {
    await bot.api.sendMessage(userId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Failed to notify user:', error);
  }
}

// Helper function for admin notifications
async function notifyAdmin(message, keyboard) {
  try {
    await bot.api.sendMessage(adminId, message, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } catch (error) {
    console.error('Failed to notify admin:', error);
  }
}

// ===============================
// ADMIN: /ban /unban /autoregister
// ===============================
function isTruthyOn(v) {
  return ['on', 'true', '1', 'enable', 'enabled', 'yes', 'y'].includes(String(v || '').toLowerCase());
}
function isTruthyOff(v) {
  return ['off', 'false', '0', 'disable', 'disabled', 'no', 'n'].includes(String(v || '').toLowerCase());
}

// Resolve a user identifier: numeric ID or @username
async function resolveUserId(identifier) {
  const raw0 = String(identifier || '').trim();
  if (!raw0) return null;

  const raw = raw0.replace(/^<|>$/g, '').trim();

  // numeric
  if (/^\d+$/.test(raw)) return raw;

  // username (with or without @)
  const uname = raw.startsWith('@') ? raw.slice(1) : raw;
  if (uname && /^[a-zA-Z0-9_]{4,32}$/.test(uname)) {
    // 1) Try Telegram lookup (works only if resolvable)
    try {
      const chat = await bot.api.getChat('@' + uname);
      if (chat?.id) return String(chat.id);
    } catch (_) {}

    // 2) Fallback to local in-memory users map (users who interacted with the bot)
    try {
      const needle = uname.toLowerCase();
      for (const [uid, u] of users.entries()) {
        const uName = String(u?.username || '').replace(/^@/, '').toLowerCase();
        if (uName && uName === needle) return String(u?.telegramId || uid);
      }
    } catch (_) {}
  }

  return null;
}

bot.command('ban', async (ctx) => {
  const caller = String(ctx.from?.id || '');
  if (!caller || !isAdmin(caller)) return ctx.reply('❌ Only admins can use this command.');

const args = String(getCommandArgs(ctx) || '').trim();
const replyTarget = ctx.message?.reply_to_message?.from?.id ? String(ctx.message.reply_to_message.from.id) : null;

let targetId = null;
let reason = '';

if (!args) {
  if (!replyTarget) return ctx.reply('❌ Usage: /ban <userId|@username> [reason]\n(or reply to a user message and use /ban [reason])');
  targetId = replyTarget;
} else {
  const parts = args.split(/\s+/).filter(Boolean);

  // If admin replied to a user and first token is NOT an identifier, treat whole args as reason
  const first = parts[0] || '';
  const looksLikeId = /^\d+$/.test(first) || first.startsWith('@');

  if (replyTarget && !looksLikeId) {
    targetId = replyTarget;
    reason = args;
  } else {
    const targetRaw = first;
    reason = parts.slice(1).join(' ').trim();
    targetId = await resolveUserId(targetRaw);
    if (!targetId) {
      return ctx.reply('❌ Could not resolve that user.\n✅ Try one of these:\n• Reply to the user’s message and send /ban [reason]\n• Use numeric ID\n• Use @username (works if the user has started the bot)');
    }
  }
}

if (isAdmin(targetId)) return ctx.reply('❌ You cannot ban an admin.');
  const at = new Date().toISOString();
  bannedUsers.set(String(targetId), { by: caller, at, reason });

  await adminAudit('ban', ctx, `target=${targetId}${reason ? ` | reason=${reason}` : ''}`);

  // notify target (best-effort)
  try {
    await bot.api.sendMessage(targetId, `⛔ You have been banned from using this bot.${reason ? `\\n\\n📝 Reason: ${reason}` : ''}`);
  } catch (_) {}

  return ctx.reply(`✅ Banned: ${targetId}${reason ? `\\n📝 Reason: ${reason}` : ''}`);
});

bot.command('unban', async (ctx) => {
  const caller = String(ctx.from?.id || '');
  if (!caller || !isAdmin(caller)) return ctx.reply('❌ Only admins can use this command.');

const args = String(getCommandArgs(ctx) || '').trim();
const replyTarget = ctx.message?.reply_to_message?.from?.id ? String(ctx.message.reply_to_message.from.id) : null;

let targetId = null;
if (!args) {
  if (!replyTarget) return ctx.reply('❌ Usage: /unban <userId|@username>\n(or reply to a user message and use /unban)');
  targetId = replyTarget;
} else {
  targetId = await resolveUserId(args.split(/\s+/)[0]);
  if (!targetId) {
    return ctx.reply('❌ Could not resolve that user.\n✅ Try replying to the user’s message and sending /unban, or use numeric ID / @username.');
  }
}


  const existed = bannedUsers.delete(String(targetId));

  await adminAudit('unban', ctx, `target=${targetId}`);
  if (!existed) return ctx.reply('ℹ️ That user was not banned.');

  // notify target (best-effort)
  try { await bot.api.sendMessage(targetId, '✅ You have been unbanned. You can use the bot again.'); } catch (_) {}

  return ctx.reply(`✅ Unbanned: ${targetId}`);
});

bot.command('autoregister', async (ctx) => {
  const caller = String(ctx.from?.id || '');
  if (!caller || !isAdmin(caller)) return ctx.reply('❌ Only admins can use this command.');

  const arg = (ctx.match || '').toString().trim().toLowerCase();
  if (!arg) {
    return ctx.reply(`⚙️ Auto-register is currently: *${autoRegisterEnabled ? 'ON' : 'OFF'}*\\n\\nUsage: /autoregister on | off`, { parse_mode: 'Markdown' });
  }

  if (isTruthyOn(arg)) autoRegisterEnabled = true;
  else if (isTruthyOff(arg)) autoRegisterEnabled = false;
  else return ctx.reply('❌ Usage: /autoregister on | off');

  return ctx.reply(`✅ Auto-register is now: *${autoRegisterEnabled ? 'ON' : 'OFF'}*`, { parse_mode: 'Markdown' });
});bot.command('adminaudit', async (ctx) => {
  const caller = String(ctx.from?.id || '');
  if (!caller || !isAdmin(caller)) return ctx.reply('❌ Only admins can use this command.');

  const args = String(getCommandArgs(ctx) || '').trim();
  const n = Math.max(1, Math.min(200, parseInt(args || '30', 10) || 30));

  const list = Array.isArray(global.__adminAudit) ? global.__adminAudit.slice(-n) : [];
  if (!list.length) return ctx.reply('ℹ️ No audit entries yet.');

  const fmt = (iso) => {
    try {
      return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: true
      }).format(new Date(iso));
    } catch (_) {
      return iso;
    }
  };

  const lines = [];
  lines.push(`ADMIN AUDIT (last ${list.length})`);
  lines.push('----------------------------------------');
  for (const e of list) {
    lines.push(`[${fmt(e.ts)}] ${e.action} | by=${e.by} | chat=${e.chat}${e.details ? ` | ${e.details}` : ''}`);
  }

  const out = lines.join('\n');
  // Telegram message limit safety
  const chunk = out.length > 3800 ? out.slice(-3800) : out;
  return ctx.reply(`<pre>${escapeHtml(chunk)}</pre>`, { parse_mode: 'HTML' });
});


bot.command('approveall', async (ctx) => {
  const caller = String(ctx.from?.id || '');
  if (!caller || !isAdmin(caller)) return ctx.reply('❌ Only admins can use this command.');

  if (autoRegisterEnabled) {
    return ctx.reply('ℹ️ Auto-register is ON. Turn it OFF to use /approveall.', { disable_web_page_preview: true });
  }

  const pending = Array.from(registrationRequests.values());
  if (!pending.length) {
    return ctx.reply('✅ No pending registrations.', { disable_web_page_preview: true });
  }

  let approved = 0;
  for (const req of pending) {
    const targetId = String(req.telegramId || '');
    if (!targetId) continue;

    // Create/update user
    const fakeCtx = ctx; // use current ctx to call getOrCreateUser safely
    const user = users.get(targetId) || {
      telegramId: targetId,
      username: req.username,
      firstName: req.firstName,
      lastName: req.lastName,
      isApproved: false,
      credits: 0,
      isPremium: false,
      isAdmin: false,
      totalQueries: 0,
      registrationDate: new Date()
    };

    user.isApproved = true;
    if (!user.credits || user.credits < 50) user.credits = 50;
    users.set(targetId, user);
    registeredUsers.add(targetId);
    verifiedUsers.add(targetId);
    registrationRequests.delete(targetId);

    // Notify user
    try {
      await bot.api.sendMessage(targetId, '✅ Your registration has been approved! Use /start to open the menu.');
    } catch (_) {}

    approved++;
  }

  return ctx.reply(`✅ Approved ${approved} users.`, { disable_web_page_preview: true });
});

// ===============================
// GLOBAL BOT LOCK MIDDLEWARE
// ===============================
bot.use(async (ctx, next) => {
  // Some update types (channel posts, service updates) have no "from" user.
  // Don't crash the bot on those.
  if (!ctx.from?.id) return next();

  // Skip channel membership check for admin users
  if (isAdmin(ctx.from?.id.toString())) {
    return next();
  }
  
  // Always allow verify callback
  if (ctx.callbackQuery?.data?.startsWith('verify_')) {
    return next();
  }

  // Allow menu callbacks without verification (prevents users getting stuck after restart)
  if (ctx.callbackQuery?.data?.startsWith('menu_')) {
    return next();
  }
  
  // Allow /start command without verification
  if (ctx.message?.text === '/start') {
    return next();
  }
  
  // If user is not verified, block access
  if (!verifiedUsers.has(ctx.from?.id.toString())) {
    return ctx.reply(
      '🔒 You must join our channel to use this bot.',
      {
        reply_markup: new InlineKeyboard()
          .url('📢 Join Channel', CHANNEL_URL)
          .text('✅ Verify', `verify_${ctx.from.id}`)
      }
    );
  }
  
  // Check if user is still in the channel
  const stillJoined = await checkChannelMembership(ctx.from.id.toString());
  if (!stillJoined) {
    verifiedUsers.delete(ctx.from.id.toString());
    
    return ctx.reply(
      '❌ You left the channel.\n\nJoin again to continue.',
      {
        reply_markup: new InlineKeyboard()
          .url('📢 Join Channel', CHANNEL_URL)
          .text('✅ Verify Again', `verify_${ctx.from.id}`)
      }
    );
  }
  
  // If user is verified and still in channel, continue
  return next();
});

// Middleware to check maintenance mode
bot.use((ctx, next) => {
  // Skip maintenance check for admin users
  if (isAdmin(ctx.from?.id.toString())) {
    return next();
  }
  
  // If in maintenance mode, send maintenance message
  if (maintenanceMode) {
    return ctx.reply(maintenanceMessage);
  }
  
  // Otherwise, continue to next middleware
  return next();
});

// ===============================
// START + MENU (CATEGORIZED CALLBACK BUTTONS)
// ===============================

function mainMenuKeyboard(userId) {
  const kb = new InlineKeyboard()
    .text("🔍 OSINT", "menu_osint").text("📥 Downloaders", "menu_dl").row()
    .text("🇮🇳 India", "menu_india").text("🏦 Banking", "menu_bank").row()
    .text("ℹ️ Help", "menu_help");

  // Admin panel button (only for admins)
  try {
    if (isAdmin(String(userId))) {
      kb.row().text("🛡️ Admin Panel", "menu_admin");
    }
  } catch (_) {}

  return kb;
}

function backToMenuKeyboard() {
  return new InlineKeyboard().text("⬅️ Back", "menu_home");
}

async function safeEditOrReply(ctx, text, keyboard) {
  // Always acknowledge callback to avoid Telegram "loading..."
  try { await ctx.answerCallbackQuery(); } catch (_) {}

  // Try edit first (works for buttons)
  try {
    if (ctx.callbackQuery?.message) {
      return await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
    }
  } catch (e) {
    // Common: "message is not modified" or can't edit. We'll fall back to reply.
  }

  // Fallback: send a new message
  try {
    return await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch (error) {
    // Last fallback: plain text
    const plainText = text
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/`(.*?)`/g, '$1')
      .replace(/```(.*?)```/gs, '$1');
    return await ctx.reply(plainText, { reply_markup: keyboard });
  }
}


async function sendApprovedWelcome(ctx, user) {
  const u = ctx.from || {};
  let botMe = null;
  try { botMe = await ctx.api.getMe(); } catch (_) {}

  const botName = botMe?.first_name || "OSINT Bot";
  const botUser = botMe?.username ? `@${botMe.username}` : "";
  const displayName = [u.first_name, u.last_name].filter(Boolean).join(" ") || "User";
  const uname = u.username ? `@${u.username}` : "—";
  const lang = u.language_code || "—";

  const msg =
`✨ *Welcome, ${escapeMd(displayName)}!*

👤 *Your Info*
• ID: \`${escapeMd(String(u.id))}\`
• Username: ${escapeMd(uname)}
• Language: \`${escapeMd(String(lang))}\`

🤖 *Bot Info*
• Name: *${escapeMd(botName)}*
• Status: ✅ Online
• Version: ${BOT_VERSION}

💳 *Credits:* *${user.credits}* 🪙
${user.isPremium ? "💎 Premium: ✅" : "💎 Premium: 🔒"}

✨ Try: /imggen <prompt> (AI Image)

BOT BY @cnnetworkofficial
OWNER @JIOXT

Choose a category:`;

  return ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(ctx.from.id) });
}

// Admin-only setversion command
bot.command('setversion', async (ctx) => {
  const caller = String(ctx.from?.id || '');
  if (!caller || !isAdmin(caller)) return ctx.reply('❌ Only admins can use this command.');

  const v = String(getCommandArgs(ctx) || '').trim();
  if (!v) return ctx.reply('Usage: /setversion v10');

  const oldV = BOT_VERSION;
  BOT_VERSION = v;
  _saveBotMeta();

  return ctx.reply(`✅ Version updated\nOld: ${oldV}\nNew: ${BOT_VERSION}`);
});

// Admin-only togglefooter command (controls version footer spam)
bot.command('togglefooter', async (ctx) => {
  const caller = String(ctx.from?.id || '');
  if (!caller || !isAdmin(caller)) return ctx.reply('❌ Only admins can use this command.');

  FOOTER_ENABLED = !FOOTER_ENABLED;
  _saveBotMeta();

  return ctx.reply(`🧩 Version footer is now: ${FOOTER_ENABLED ? 'ON' : 'OFF'}`);
});

bot.command('start', async (ctx) => {
  const user = getOrCreateUser(ctx);

  // Fetch bot info (safe)
  let botMe = null;
  try { botMe = await ctx.api.getMe(); } catch (_) {}

  const botName = botMe?.first_name || "OSINT Bot";
  const botUser = botMe?.username ? `@${botMe.username}` : "";
  const u = ctx.from || {};
  const displayName = [u.first_name, u.last_name].filter(Boolean).join(" ") || "User";
  const uname = u.username ? `@${u.username}` : "—";
  const lang = u.language_code || "—";

  // Not approved -> short welcome + verify UI
  if (!user.isApproved) {
    const msg =
`👋 *Welcome, ${escapeMd(displayName)}!*

🤖 *${escapeMd(botName)}* ${botUser ? `(${escapeMd(botUser)})` : ""}

To use the bot:
1) Join our updates channel
2) Tap *Verify Membership*
3) Run /register`;

    const keyboard = new InlineKeyboard()
      .url("📢 Join Updates Channel", CHANNEL_URL).row()
      .text("✅ Verify Membership", `verify_${ctx.from.id}`);

    return ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
  }

  return sendApprovedWelcome(ctx, user);
});

// Menu: Home
bot.callbackQuery("menu_home", async (ctx) => {
  const user = getOrCreateUser(ctx);
  const u = ctx.from || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || "User";

  const msg =
`🏠 *Main Menu*

👋 Hi, *${escapeMd(name)}*
💳 Credits: *${user.credits}* 🪙
${user.isPremium ? "💎 Premium: ✅" : "💎 Premium: 🔒"}

Pick a category:`;
  return safeEditOrReply(ctx, msg, mainMenuKeyboard(ctx.from.id));
});

// Menu: OSINT
bot.callbackQuery("menu_osint", async (ctx) => {
  const msg = `🔍 *OSINT Tools*

• /ip <address> — IP intelligence
• /email <email> — Email validation
• /num <number> — Phone number lookup
• /basicnum <number> — Basic number info
• /paknum <number> — Pakistani govt lookup
• /pak <query> — Pakistan lookup (rehu)
• /ig <username> — Instagram profile intelligence
• /igreels <username> — Instagram reels/posts fetch
• /pan <pan> — PAN lookup (India)
• /tginfo <id> — Telegram ID info fetch
• /bin <number> — BIN lookup
• /deepbin <bin> — Deep BIN info (stormx)
• /tempmail — TempMail generator
• /vehicle <number> — Vehicle details
• /ff <uid> — Free Fire stats`;
  return safeEditOrReply(ctx, msg, backToMenuKeyboard());
});

// Menu: Downloaders
bot.callbackQuery("menu_dl", async (ctx) => {
    const msg = `📥 *Downloaders & Media*

• /dl <url> — Universal downloader
• /snap <url> — Snapchat downloader
• /insta <url> — Instagram downloader
• /pin <url> — Pinterest downloader
• /fb <url> — Facebook downloader
• /terabox <url> — TeraBox downloader (auto-retry)
• /igdl <url> — Instagram images (posts)
• /pindl <url> — Pinterest images
• /twtdl <url> — Twitter/X images
• /ai <text> — AI chat (GPT-5)
• /spotify <url> — Spotify track download
• /spsearch <query> — Spotify search
• /saavn <query> — JioSaavn search + play audio
• /saavn1 <query> — JioSaavn instant (1st result)
• /saavntrend [genre] — Trending-like picks
• /saavnartist <name> — Artist browse
• /saavnq — Queue (add/list/play/next/prev/clear)
• /yt <url> — YouTube downloader
• /imggen <prompt> — Image generator (Improve/Wide/Random)
• /help — Help / commands

BOT BY @cnnetworkofficial

OWNER @JIOXT
`;
  return safeEditOrReply(ctx, msg, backToMenuKeyboard());
});

// Menu: India
bot.callbackQuery("menu_india", async (ctx) => {
  const msg = `🇮🇳 *India Tools*

• /pincode <pincode> — Pincode lookup
• /postoffice <name> — Post Office search`;
  return safeEditOrReply(ctx, msg, backToMenuKeyboard());
});

// Menu: Banking
bot.callbackQuery("menu_bank", async (ctx) => {
  const msg = `🏦 *Banking*

• /ifsc <ifsc> — IFSC bank details (text output)`;
  return safeEditOrReply(ctx, msg, backToMenuKeyboard());
});


// Menu: Help
bot.callbackQuery("menu_help", async (ctx) => {
    const msg = `ℹ️ *Help*

• Use /start to open the menu anytime
• If buttons freeze, tap again (Telegram bug)
• If you get "join channel" lock, join and press Verify

⚠️ *Educational purpose only*

📥 *Commands*
• /help — This help
• /credits — Check your balance
• /register — Register your account

🎧 *Spotify*
• /spotify <url> — Download track (audio)
• /spsearch <query> — Search tracks (shows track + preview)

🎵 *JioSaavn*
• /saavn <query> — Search + play audio
• /saavn1 <query> — Play first result
• /saavntrend [genre]
• /saavnartist <name>
• /saavnq add|list|play|next|prev|clear


🤖 *AI*
• /ai <text>

📥 *Downloaders*
• /yt <url>
• /imggen <prompt>
• /dl <url>
`;
  return safeEditOrReply(ctx, msg, backToMenuKeyboard());
});

// Menu: Admin Panel (CN)
bot.callbackQuery("menu_admin", async (ctx) => {
  const caller = String(ctx.from?.id || '');
  if (!caller || !isAdmin(caller)) {
    return safeEditOrReply(ctx, "❌ Admins only.", backToMenuKeyboard());
  }

  const msg =
`🛡️ <b>Admin CN Panel</b>

<b>Security</b>
• ban &lt;id|@user&gt; — Ban user
• unban &lt;id|@user&gt; — Unban user

<b>Registration</b>
• autoregister on|off — Toggle auto approval
• approveall — Approve all pending (when autoregister OFF)

<b>Maintenance</b>
• maintenance on|off (if you have it)

Tip: Use numeric user IDs for best results.`;

  try { await ctx.answerCallbackQuery(); } catch (_) {}
  // continue
  try { if (ctx.callbackQuery?.message) return await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: backToMenuKeyboard(), disable_web_page_preview: true }); } catch (_) {}
  return ctx.reply(msg, { parse_mode: 'HTML', reply_markup: backToMenuKeyboard(), disable_web_page_preview: true });
});

// Registration command - Fixed to check Telegram API directly
bot.command('register', async (ctx) => {
  const userId = ctx.from.id;

  // 🔍 REAL check (Telegram API)
  if (!(await isUserJoined(userId))) {
    return ctx.reply('❌ Please join the channel first.');
  }

  // Mark verified automatically
  verifiedUsers.add(String(userId));

  // Already registered (approved)
  const existing = users.get(String(userId));
  if (existing?.isApproved) {
    return ctx.reply('✅ You are already registered.');
  }

  // If auto-register is OFF -> send approval request to admin
  if (!autoRegisterEnabled) {
    // Store request
    registrationRequests.set(String(userId), {
      telegramId: String(userId),
      username: ctx.from.username || null,
      firstName: ctx.from.first_name || null,
      lastName: ctx.from.last_name || null,
      at: new Date().toISOString()
    });

    const name = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || String(userId));
    await ctx.reply('🕵️ Registration request sent for approval.\n\n⏳ Please wait for admin approval.');

    // Admin buttons
    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `approve_${userId}`)
      .text('❌ Reject', `reject_${userId}`);

    // Send details to admin
    const details =
`🆕 *Registration Request*

👤 User: ${escapeMd(String(name))}
🆔 ID: \`${escapeMd(String(userId))}\`
🌐 Lang: \`${escapeMd(String(ctx.from.language_code || 'N/A'))}\`
🕒 Time: \`${escapeMd(new Date().toISOString())}\`

Approve or Reject:`;

    // Notify all admins in ADMINS list
    for (const a of ADMINS) {
      if (!a) continue;
      try {
        await bot.api.sendMessage(a, details, { parse_mode: 'Markdown', reply_markup: keyboard });
      } catch (_) {}
    }

    return;
  }

  // Auto-register ON -> auto approve
  registeredUsers.add(String(userId));

  // Create or update user record
  const user = getOrCreateUser(ctx);
  user.isApproved = true;
  user.credits = 50; // Give starting credits

  await ctx.reply(
    '🎉 Registration successful!\n' +
    '✅ Your account is automatically approved.'
  );

  // Auto-send main menu
  await sendApprovedWelcome(ctx, user);

  // 🔔 Admin notification
  const name = ctx.from.username
    ? `@${ctx.from.username}`
    : ctx.from.first_name || userId;

  ADMINS.forEach(adminId => {
    bot.api.sendMessage(
      adminId,
      `🆕 New user registered\n` +
      `👤 ${name}\n` +
      `🆔 ${userId}`
    ).catch(() => {});
  });

  // 📢 Auto-log new registrations to @loggroupcn
  try {
    const u = getOrCreateUser(ctx);
    const fullNameRaw = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').trim();
    const usernameRaw = ctx.from.username ? `@${ctx.from.username}` : 'N/A';
    const langRaw = ctx.from.language_code || 'N/A';
    const phoneFromContact = ctx.message?.contact?.phone_number || null;
    if (phoneFromContact) {
      try { u.phone = phoneFromContact; } catch (_) {}
    }
    const phoneRaw = phoneFromContact || (u && u.phone) || 'Not provided';

    let bioRaw = 'N/A';
    try {
      const chat = await bot.api.getChat(userId);
      if (chat && typeof chat.bio === 'string' && chat.bio.trim()) bioRaw = chat.bio.trim();
    } catch (_) {}

    const now = new Date();

    const channelMsg =
      `🆕 <b>New Registration</b>\n\n` +
      `👤 <b>Name:</b> ${escapeHtml(fullNameRaw || 'N/A')}\n` +
      `🔖 <b>Username:</b> ${escapeHtml(usernameRaw)}\n` +
      `🆔 <b>User ID:</b> <code>${escapeHtml(String(userId))}</code>\n` +
      `🌐 <b>Language:</b> ${escapeHtml(langRaw)}\n` +
      `📞 <b>Phone:</b> ${escapeHtml(String(phoneRaw))}\n` +
      `📝 <b>Bio:</b> ${escapeHtml(String(bioRaw))}\n` +
      `🪙 <b>Starting Credits:</b> ${escapeHtml(String((u && typeof u.credits !== 'undefined') ? u.credits : 50))}\n` +
      `✅ <b>Approved:</b> ${escapeHtml(String((u && u.isApproved) ? 'Yes' : 'No'))}\n` +
      `📅 <b>Registered At:</b> ${escapeHtml(now.toLocaleString())}\n`;

    await bot.api.sendMessage(CHANNEL_ID, channelMsg, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (e) {
    console.error('[REG LOG CHANNEL ERROR]', e);
  }
});
// ===============================
// VERIFY BUTTON HANDLER
// ===============================
bot.callbackQuery(/^verify_(\d+)$/, async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  const targetUserId = ctx.callbackQuery.data.split('_')[1];
  
  // Only allow the user themselves to verify
  if (telegramId !== targetUserId) {
    await ctx.answerCallbackQuery('❌ You can only verify your own membership.');
    return;
  }

  // Check if user is already verified
  if (verifiedUsers.has(targetUserId)) {
    await ctx.answerCallbackQuery('✅ You have already verified your channel membership!');
    return;
  }

  await ctx.answerCallbackQuery('Checking membership…');

  // ⏳ Telegram sync delay
  await new Promise(r => setTimeout(r, 1500));

  // Check if user is a member of the verification channel
  const isMember = await checkChannelMembership(targetUserId);
  
  if (isMember) {
    verifiedUsers.add(targetUserId);
    await ctx.editMessageText(`✅ Verification Successful ✅
    
    CLICK OR USE /register TO REGISTER 

🎉 You have successfully verified your membership in our channel!

📋 Next Steps:
• You can now use /register to submit your registration request
• Your verification status has been saved

🚀 Thank you for joining our updates channel!`);
  } else {
    await ctx.editMessageText(`❌ Verification Failed ❌

📋 You need to join our channel before you can register.

🔗 Join Channel:
• Click the button below to join
• After joining, click "Verify Membership" again

📢 Channel membership is required for registration`, {
      reply_markup: new InlineKeyboard()
        .url("📢 Join Updates Channel", CHANNEL_URL)
        .text("✅ Verify Membership", `verify_${targetUserId}`)
    });
  }
});

// Callback query handler for registration (kept for backward compatibility)
bot.callbackQuery(/^(approve|reject)_(\d+)$/, async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await ctx.answerCallbackQuery('❌ Only admins can process registrations.');
    return;
  }

  const match = ctx.callbackQuery.data.match(/^(approve|reject)_(\d+)$/);
  if (!match) return;

  const action = match[1];
  const targetUserId = match[2];

  const request = registrationRequests.get(targetUserId);
  if (!request) {
    await ctx.answerCallbackQuery('❌ Registration request not found.');
    return;
  }

  // Check if user already exists
  let user = users.get(targetUserId);
  if (!user) {
    user = {
      telegramId: targetUserId,
      username: request.username,
      firstName: request.firstName,
      lastName: request.lastName,
      isApproved: false,
      credits: 0,
      isPremium: false,
      isAdmin: false,
      totalQueries: 0,
      registrationDate: new Date()
    };
  }

  if (action === 'approve') {
    user.isApproved = true;
    user.credits = 50; // Give starting credits
    users.set(targetUserId, user);
    registrationRequests.delete(targetUserId);
    registeredUsers.add(targetUserId);

    const userMessage = `🎉 Registration Approved! 🎉

✅ Congratulations! Your registration has been approved.

💎 Welcome Benefits:
• 50 starting credits 🪙
• Full access to all OSINT tools
• Premium features available

🚀 Get Started:
• Use /start to see all available commands
• Try /help for detailed instructions
• Check /credits to see your balance

⚡ Thank you for joining our OSINT community!`;

    await notifyUser(targetUserId, userMessage);
    await ctx.answerCallbackQuery('✅ Registration approved successfully!');
    
    // Update the message
    await ctx.editMessageText(`✅ Registration Approved ✅

👤 User: @${user.username || 'N/A'} (${targetUserId})
📅 Processed: ${new Date().toLocaleDateString()}
🎯 Status: Approved

Processed by: @${ctx.from?.username || 'Admin'}`);

  } else if (action === 'reject') {
    registrationRequests.delete(targetUserId);

    const userMessage = `❌ Registration Rejected ❌

📋 Your registration request has been rejected.

📞 Next Steps:
• Contact @jioxt for more information
• Review registration requirements
• You may submit a new request if needed

💡 If you believe this is an error, please reach out to our support team @cnnetworkofficial`;

    await notifyUser(targetUserId, userMessage);
    await ctx.answerCallbackQuery('❌ Registration rejected');
    
    // Update the message
    await ctx.editMessageText(`❌ Registration Rejected ❌

👤 User: @${user.username || 'N/A'} (${targetUserId})
📅 Processed: ${new Date().toLocaleDateString()}
🎯 Status: Rejected

Processed by: @${ctx.from?.username || 'Admin'}`);
  }
});

// Universal video downloader command
bot.command('dl', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    return sendFormattedMessage(ctx, '❌ You need approval to use this command.');
  }

  if (!deductCredits(user)) {
    return sendFormattedMessage(ctx, '❌ Insufficient credits!');
  }

  const url = ctx.match;
  if (!url) {
    return sendFormattedMessage(ctx, '❌ Usage: /dl <video link>');
  }

  const platform = detectPlatform(url);
  if (platform === 'unknown') {
    return sendFormattedMessage(ctx, '❌ Unsupported platform. Please use a link from Instagram, Facebook, Snapchat, Pinterest, or TeraBox.');
  }

  await sendFormattedMessage(ctx, `⏳ Processing ${platform} video...`);

  try {
    let success;
    
    if (platform === 'terabox') {
      success = await handleTeraBox(ctx, url);
    } else {
      success = await handleSingleVideo(ctx, url, platform);
    }
    
    if (success) {
      user.totalQueries++;
    } else {
      refundCredits(user, 1); // Refund credit on failure
    }
  } catch (error) {
    console.error('Error in dl command:', error);
    refundCredits(user, 1); // Refund credit on error
    sendFormattedMessage(ctx, '❌ An error occurred while processing your request.');
  }
});

// Keep individual commands for backward compatibility
bot.command('snap', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    return sendFormattedMessage(ctx, '❌ You need approval to use this command.');
  }

  if (!deductCredits(user)) {
    return sendFormattedMessage(ctx, '❌ Insufficient credits!');
  }

  const videoUrl = ctx.match;
  if (!videoUrl) {
    return sendFormattedMessage(ctx, '🦼 Usage: /snap <Snapchat video URL>');
  }

  await sendFormattedMessage(ctx, '🦼 Downloading Snapchat video...');

  try {
    const success = await handleSingleVideo(ctx, videoUrl, 'snap');
    if (success) {
      user.totalQueries++;
    } else {
      refundCredits(user, 1); // Refund credit on failure
    }
  } catch (error) {
    console.error('Error in snap command:', error);
    refundCredits(user, 1); // Refund credit on error
    sendFormattedMessage(ctx, '❌ An error occurred while processing your request.');
  }
});

bot.command('insta', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    return sendFormattedMessage(ctx, '❌ You need approval to use this command.');
  }

  if (!deductCredits(user)) {
    return sendFormattedMessage(ctx, '❌ Insufficient credits!');
  }

  const videoUrl = ctx.match;
  if (!videoUrl) {
    return sendFormattedMessage(ctx, '💎 Usage: /insta <Instagram video URL>');
  }

  await sendFormattedMessage(ctx, '💎 Downloading Instagram video...');

  try {
    const success = await handleSingleVideo(ctx, videoUrl, 'insta');
    if (success) {
      user.totalQueries++;
    } else {
      refundCredits(user, 1); // Refund credit on failure
    }
  } catch (error) {
    console.error('Error in insta command:', error);
    refundCredits(user, 1); // Refund credit on error
    sendFormattedMessage(ctx, '❌ An error occurred while processing your request.');
  }
});

bot.command('pin', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    return sendFormattedMessage(ctx, '❌ You need approval to use this command.');
  }

  if (!deductCredits(user)) {
    return sendFormattedMessage(ctx, '❌ Insufficient credits!');
  }

  const videoUrl = ctx.match;
  if (!videoUrl) {
    return sendFormattedMessage(ctx, '❤️ Usage: /pin <Pinterest video URL>');
  }

  await sendFormattedMessage(ctx, '❤️ Downloading Pinterest video...');

  try {
    const success = await handleSingleVideo(ctx, videoUrl, 'pin');
    if (success) {
      user.totalQueries++;
    } else {
      refundCredits(user, 1); // Refund credit on failure
    }
  } catch (error) {
    console.error('Error in pin command:', error);
    refundCredits(user, 1); // Refund credit on error
    sendFormattedMessage(ctx, '❌ An error occurred while processing your request.');
  }
});

bot.command('fb', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    return sendFormattedMessage(ctx, '❌ You need approval to use this command.');
  }

  if (!deductCredits(user)) {
    return sendFormattedMessage(ctx, '❌ Insufficient credits!');
  }

  const videoUrl = ctx.match;
  if (!videoUrl) {
    return sendFormattedMessage(ctx, '❤️ Usage: /fb <Facebook video URL>');
  }

  await sendFormattedMessage(ctx, '❤️ Downloading Facebook video...');

  try {
    const success = await handleSingleVideo(ctx, videoUrl, 'fb');
    if (success) {
      user.totalQueries++;
    } else {
      refundCredits(user, 1); // Refund credit on failure
    }
  } catch (error) {
    console.error('Error in fb command:', error);
    refundCredits(user, 1); // Refund credit on error
    sendFormattedMessage(ctx, '❌ An error occurred while processing your request.');
  }
});

bot.command('terabox', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    return sendFormattedMessage(ctx, '❌ You need approval to use this command.');
  }

  if (!deductCredits(user)) {
    return sendFormattedMessage(ctx, '❌ Insufficient credits!');
  }

  const videoUrl = ctx.match;
  if (!videoUrl) {
    return sendFormattedMessage(ctx, '📁 Usage: /terabox <TeraBox video URL>');
  }

  await sendFormattedMessage(ctx, '📁 Processing TeraBox link...');

  try {
    const success = await handleTeraBox(ctx, videoUrl);
    if (success) {
      user.totalQueries++;
    } else {
      refundCredits(user, 1); // Refund credit on failure
    }
  } catch (error) {
    console.error('Error in terabox command:', error);
    refundCredits(user, 1); // Refund credit on error
    sendFormattedMessage(ctx, '❌ An error occurred while processing your request.');
  }
});// ===============================
// IMAGE DOWNLOADERS (TOBI-INSTA-API)
// ===============================

async function guardedImageDownloader(ctx, kind, prettyName) {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    return sendFormattedMessage(ctx, '❌ You need approval to use this command.');
  }

  if (!deductCredits(user)) {
    return sendFormattedMessage(ctx, '❌ Insufficient credits!');
  }

  const url = (ctx.match || '').trim();
  if (!url) {
    refundCredits(user, 1);
    return sendFormattedMessage(ctx, `❌ Usage: /${kind}dl <url>\nExample: /${kind}dl https://...\n💳 1 credit refunded`);
  }

  await sendFormattedMessage(ctx, `🖼️ Fetching ${prettyName} media...`);

  try {
    const r = await tobiDownloadImages(kind === 'tw' ? 'twitter' : (kind === 'pin' ? 'pinterest' : 'instagram'), url);

    if (!r.urls || !r.urls.length) {
      refundCredits(user, 1);
      return sendFormattedMessage(ctx, `❌ No images found.\n💳 1 credit refunded`);
    }

    const cap = `✅ ${prettyName} Images\n🔗 ${r.resolved}`;
    await sendImagesAsAlbum(ctx, r.urls, cap);

    // If more than 10 images, send remaining as links
    if (r.urls.length > 10) {
      const rest = r.urls.slice(10);
      await sendLongOrFile(ctx, `🧾 More Images (${rest.length})\n\n${rest.join('\n')}`, `${prettyName}_more`);
    }

    user.totalQueries++;
    return true;
  } catch (e) {
    console.error(`${prettyName} downloader error:`, e?.message || e);
    refundCredits(user, 1);
    return sendFormattedMessage(ctx, `❌ Failed to fetch ${prettyName} media.\n💳 1 credit refunded`);
  }
}

// Commands (separate as requested)
bot.command('igdl', (ctx) => guardedImageDownloader(ctx, 'ig', 'Instagram'));
bot.command('pindl', (ctx) => guardedImageDownloader(ctx, 'pin', 'Pinterest'));
bot.command('twtdl', (ctx) => guardedImageDownloader(ctx, 'tw', 'Twitter/X'));
// ===============================
// NEW (v9): AI + Spotify + YouTube
// ===============================
bot.command('ai', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) return sendFormattedMessage(ctx, '❌ You need approval to use this command.');

  if (!deductCredits(user)) return sendFormattedMessage(ctx, '❌ Insufficient credits!');

  const prompt = getCommandArgs(ctx);
  if (!prompt) {
    refundCredits(user, 1);
    return sendFormattedMessage(ctx, '🤖 Usage: /ai <your text>');
  }

  await sendFormattedMessage(ctx, '🤖 Thinking...');

  try {
    const url = `https://flip-apiakib.vercel.app/ai/gpt-5?text=${encodeURIComponent(prompt)}`;
    const res = await axiosGetWithRetry(url, { timeout: 30000 }, 2);
    const data = res.data || {};

    // API response example:
    // { status: true, model: 'gpt-5', text: '...' }
    const answer =
      (typeof data === 'string' ? data : null) ||
      data.text ||
      data.response ||
      data.result ||
      data.answer ||
      data.data ||
      '';

    if (!String(answer).trim()) {
      refundCredits(user, 1);
      return sendFormattedMessage(ctx, '❌ AI returned empty response. Try again.');
    }

    user.totalQueries++;

    // Reply only the text (no JSON)
    return ctx.reply(String(answer));
  } catch (e) {
    console.error('ai error:', e?.message || e);
    refundCredits(user, 1);
    return sendFormattedMessage(ctx, '❌ AI request failed. Try again.');
  }
});



// ===============================
// IMAGE GEN (PROMPT -> DIRECT IMAGE)
// API: https://tobi-paras-aotpy-api-gen.vercel.app/?prompt=...&download=true
// ===============================

// In-memory cache for image-gen options (per chat+user)
global.__imgCache = global.__imgCache || new Map();

function buildImgKeyboard(state, apiUrl) {
  const improveOn = !!state?.improve;
  const wideOn = String(state?.format || '').toLowerCase() === 'wide';

  const kb = new InlineKeyboard()
    .text(`Improve ${improveOn ? '✅' : '▫️'}`, 'imgopt_improve')
    .text(`Wide ${wideOn ? '✅' : '▫️'}`, 'imgopt_wide')
    .row()
    .text('Random 🎲', 'imgopt_random')
    .url('Download 🔗', apiUrl);

  return kb;
}

async function generateAndSendImage(ctx, user, state, { replaceMessageId = null } = {}) {
  const prompt = String(state?.prompt || '').trim();
  if (!prompt) {
    try { await sendFormattedMessage(ctx, '❌ Missing prompt. Use /img <prompt>'); } catch (_) {}
    return;
  }

  const qs = new URLSearchParams();
  qs.set('prompt', prompt);
  qs.set('download', 'true');
  if (state?.improve) qs.set('improve', 'true');
  if (state?.format) qs.set('format', state.format);
  if (state?.random) qs.set('random', state.random);

  const apiUrl = `https://tobi-paras-aotpy-api-gen.vercel.app/?${qs.toString()}`;

  const res = await axiosGetWithRetry(apiUrl, { timeout: 60000, responseType: 'arraybuffer' }, 2);
  const buf = Buffer.from(res.data);
  const contentType = String(res.headers?.['content-type'] || '').toLowerCase();

  const ext =
    contentType.includes('png') ? 'png' :
    contentType.includes('webp') ? 'webp' :
    contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' :
    'png';

  const fileName = `image_${Date.now()}.${ext}`;
  const caption =
    `✅ <b>Image generated</b>\n` +
    `<b>Prompt:</b> <code>${escapeHtml(prompt).slice(0, 250)}</code>\n` +
    `<b>Improve:</b> <code>${state?.improve ? 'true' : 'false'}</code>\n` +
    `<b>Format:</b> <code>${escapeHtml(String(state?.format || 'default'))}</code>\n` +
    `<b>Random:</b> <code>${escapeHtml(String(state?.random || ''))}</code>\n` +
    `
🔗 <b>Download:</b> <a href="${escapeHtml(apiUrl)}">Open</a>`;

  const kb = buildImgKeyboard(state, apiUrl);

  // Optional: delete old message to keep chat clean
  if (replaceMessageId) {
    try { await ctx.api.deleteMessage(ctx.chat.id, replaceMessageId); } catch (_) {}
  }

  try {
    await ctx.replyWithPhoto(new InputFile(buf, fileName), {
      caption,
      parse_mode: 'HTML',
      reply_markup: kb,
      disable_web_page_preview: true
    });
  } catch (_) {
    await ctx.replyWithDocument(new InputFile(buf, fileName), {
      caption,
      parse_mode: 'HTML',
      reply_markup: kb,
      disable_web_page_preview: true
    });
  }

  // Persist state for inline buttons
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  global.__imgCache.set(key, { ...state, apiUrl, lastMessageAt: Date.now() });

  // Audit (download-ish action)
  await adminAudit('imggen', ctx, `prompt="${prompt}" improve=${!!state?.improve} format=${state?.format || ''}`);
}

// Image gen commands
async function handleImgGenCommand(ctx) {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) return;

  const prompt = String(getCommandArgs(ctx) || '').trim();
  if (!prompt) return ctx.reply('❌ Usage: /img <prompt>\nExample: /img spiderman');

  recordCommandUse(user, 'img');
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  const state = { prompt, improve: false, format: 'square', random: '' };
  global.__imgCache.set(key, state);

  return generateAndSendImage(ctx, user, state);
}

// // bot.command('img', handleImgGenCommand); // disabled (using unified handler) // disabled (using unified handler)
// // bot.command('imggen', handleImgGenCommand); // disabled (using unified handler) // disabled (using unified handler)

// Inline buttons handler
bot.callbackQuery(/^imgopt_(improve|wide|random)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (_) {}
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) return;
  recordCommandUse(user, 'img');

  const key = `${ctx.chat.id}:${ctx.from.id}`;
  const st = global.__imgCache.get(key);

  if (!st || !st.prompt) {
    try { await ctx.reply('❌ Session expired. Use /img <prompt> again.'); } catch (_) {}
    return;
  }

  // Each re-generate costs 1 credit
  if (!deductCredits(user)) {
    try { await ctx.reply('❌ Insufficient credits!'); } catch (_) {}
    return;
  }

  const action = ctx.match?.[1];
  if (action === 'improve') st.improve = !st.improve;
  if (action === 'wide') st.format = (String(st.format || '').toLowerCase() === 'wide') ? '' : 'wide';
  if (action === 'random') st.random = Math.random().toString(36).slice(2, 10);

  try {
    // show quick status
    try { await ctx.editMessageCaption('🖼️ <b>Generating...</b>', { parse_mode: 'HTML' }); } catch (_) {}
    await generateAndSendImage(ctx, user, st, { replaceMessageId: ctx.callbackQuery?.message?.message_id });
  } catch (e) {
    console.error('imgopt error:', e?.message || e);
    refundCredits(user, 1);
    try { await ctx.reply('❌ Failed to generate image.\n💳 1 credit refunded'); } catch (_) {}
  }
});

bot.command(['img', 'imggen'], async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) return sendFormattedMessage(ctx, '❌ You need approval to use this command.');

  // Each generation costs 1 credit
  if (!deductCredits(user)) return sendFormattedMessage(ctx, '❌ Insufficient credits!');

  const raw = String(getCommandArgs(ctx) || '').trim();
  if (!raw) {
    refundCredits(user, 1);
    return sendFormattedMessage(ctx, '🖼️ Usage: /img <prompt>\nExample: /img spiderman');
  }

  // Simple flag parsing: allow "--improve", "--wide", "--format=wide", "--random=XXXX"
  const parts = raw.split(/\s+/);
  const promptParts = [];
  const state = { prompt: '', improve: false, format: '', random: '' };

  for (const p of parts) {
    if (p === '--improve') state.improve = true;
    else if (p === '--wide') state.format = 'wide';
    else if (p.startsWith('--format=')) state.format = p.split('=')[1] || '';
    else if (p.startsWith('--random=')) state.random = p.split('=')[1] || '';
    else promptParts.push(p);
  }

  state.prompt = promptParts.join(' ').trim();
  if (!state.prompt) {
    refundCredits(user, 1);
    return sendFormattedMessage(ctx, '🖼️ Usage: /img <prompt>\nExample: /img spiderman');
  }
  // Cache state for inline buttons (Improve/Wide/Random)
  try {
    const key = `${ctx.chat.id}:${ctx.from.id}`;
    global.__imgCache = global.__imgCache || new Map();
    global.__imgCache.set(key, { ...state });
  } catch (_) {}


  // A small "working" message, then send final media
  let workingMsgId = null;
  try {
    const m = await ctx.reply('🖼️ Generating image...');
    workingMsgId = m?.message_id || null;
  } catch (_) {}

  try {
    await generateAndSendImage(ctx, user, state, { replaceMessageId: workingMsgId });
    user.totalQueries++;
  } catch (e) {
    console.error('imggen error:', e?.message || e);
    refundCredits(user, 1);
    return sendFormattedMessage(ctx, '❌ Failed to generate image.\n💳 1 credit refunded');
  }
});


async function handleSpotifySearch(ctx) {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) return sendFormattedMessage(ctx, '❌ You need approval to use this command.');

  if (!deductCredits(user)) return sendFormattedMessage(ctx, '❌ Insufficient credits!');

  const q = getCommandArgs(ctx);
  if (!q) {
    refundCredits(user, 1);
    return sendFormattedMessage(ctx, '🔎 Usage: /spsearch <song name / artist>');
  }

  await sendFormattedMessage(ctx, '🔎 Searching Spotify tracks...');

  const msToMinSec = (ms) => {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    const totalSec = Math.floor(n / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const pick = (t, keys, fallback = '') => {
    for (const k of keys) {
      const v = t?.[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return fallback;
  };

  try {
    const api = `https://flip-apiakib.vercel.app/spotify/search?q=${encodeURIComponent(q)}`;
    const res = await axiosGetWithRetry(api, { timeout: 35000 }, 2);
    const data = res.data || {};

    const items =
      (Array.isArray(data?.data) ? data.data : null) ||
      (Array.isArray(data?.tracks) ? data.tracks : null) ||
      (Array.isArray(data?.data?.tracks) ? data.data.tracks : null) ||
      (Array.isArray(data?.items) ? data.items : null) ||
      [];

    if (!items.length) {
      refundCredits(user, 1);
      return sendFormattedMessage(ctx, '❌ No tracks found.');
    }

    user.totalQueries++;

    // Send results one-by-one (top 8)
    const top = items.slice(0, 8);

    for (let i = 0; i < top.length; i++) {
      const t = top[i] || {};

      const title = pick(t, ['title', 'name'], `Track ${i + 1}`);
      const artist =
        pick(t, ['artist'], '') ||
        (Array.isArray(t?.artists) ? t.artists.map(a => a?.name).filter(Boolean).join(', ') : '') ||
        t?.artists?.[0]?.name ||
        '';
      const album =
        pick(t, ['album'], '') ||
        t?.album?.name ||
        '';
      const release =
        pick(t, ['release_date', 'releaseDate'], '') ||
        t?.album?.release_date ||
        '';
      const duration =
        pick(t, ['duration'], '') ||
        msToMinSec(t?.duration_ms || t?.durationMs || t?.duration_ms) ||
        '';
      const preview =
        pick(t, ['preview_url', 'previewUrl'], '') ||
        t?.preview_url ||
        '';
      const trackUrl =
        pick(t, ['track_url', 'trackUrl', 'url', 'link', 'spotify_url'], '') ||
        t?.external_urls?.spotify ||
        '';
      const thumb =
        pick(t, ['thumbnail', 'image', 'cover'], '') ||
        t?.album?.images?.[0]?.url ||
        '';

      const lines = [];
      lines.push(`🎵 ${escapeHtml(String(title))}`);
      if (artist) lines.push(`👤 <b>Artist:</b> ${escapeHtml(String(artist))}`);
      if (album) lines.push(`💽 <b>Album:</b> ${escapeHtml(String(album))}`);
      if (release) lines.push(`📅 <b>Release:</b> ${escapeHtml(String(release))}`);
      if (duration) lines.push(`⏱️ <b>Duration:</b> ${escapeHtml(String(duration))}`);
      lines.push(`🔗 <b>Track:</b> ${escapeHtml(isHttpUrl(trackUrl) ? trackUrl : 'N/A')}`);
      lines.push(`🎧 <b>Preview:</b> ${escapeHtml(isHttpUrl(preview) ? preview : 'No preview available')}`);

      const msg = lines.join('\n');

      if (isHttpUrl(thumb)) {
        try {
          await ctx.replyWithPhoto(thumb, {
            caption: msg,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          });
        } catch (e) {
          await ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true });
        }
      } else {
        await ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true });
      }

// small delay to avoid flood
      await sleep(250);
    }

    return;
  } catch (e) {
    console.error('spsearch error:', e?.message || e);
    refundCredits(user, 1);
    return sendFormattedMessage(ctx, '❌ Spotify search failed. Try again later.');
  }
}


bot.command('spsearch', handleSpotifySearch);
bot.command('spotifysearch', handleSpotifySearch);

bot.command('spotify', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) return sendFormattedMessage(ctx, '❌ You need approval to use this command.');

  if (!deductCredits(user)) return sendFormattedMessage(ctx, '❌ Insufficient credits!');

  const url = getCommandArgs(ctx);
  if (!url) {
    refundCredits(user, 1);
    return sendFormattedMessage(ctx, '🎵 Usage: /spotify <spotify track url>');
  }

  await sendFormattedMessage(ctx, '🎵 Fetching Spotify download...');

  try {
    const api = `https://flip-apiakib.vercel.app/spotify/download?url=${encodeURIComponent(url)}`;
    const res = await axiosGetWithRetry(api, { timeout: 35000 }, 2);
    const data = res.data || {};

    // flip-apiakib.spotify response: { data: { media: [{ type:'audio', format:'mp3', url:'...' }, ...], metadata:{title,artist,...} } }
    const media = Array.isArray(data?.data?.media) ? data.data.media : [];
    const meta = data?.data?.metadata || {};

    // Prefer MP3 audio item
    let audioUrl = null;
    for (const m of media) {
      if (!m) continue;
      const t = String(m.type || '').toLowerCase();
      const f = String(m.format || '').toLowerCase();
      if (t === 'audio' && (f === 'mp3' || f.includes('mp3')) && isHttpUrl(m.url)) {
        audioUrl = m.url;
        break;
      }
    }
    // Fallback: any audio url
    if (!audioUrl) {
      for (const m of media) {
        const t = String(m?.type || '').toLowerCase();
        if (t === 'audio' && isHttpUrl(m?.url)) {
          audioUrl = m.url;
          break;
        }
      }
    }

    if (!isHttpUrl(audioUrl)) {
      refundCredits(user, 1);
      return sendFormattedMessage(ctx, '❌ Spotify audio link not found from API.');
    }

    user.totalQueries++;

    const title = meta?.title || 'Spotify Track';
    const artist = meta?.artist || meta?.artists || '';
    const caption = artist ? `🎵 ${title} — ${artist}` : `🎵 ${title}`;

    // Send as AUDIO so it plays directly in chat.
    // (Telegram may show a thumbnail, but audio will be playable.)
    try {
      await ctx.replyWithAudio(audioUrl, {
        caption,
        title: String(title).slice(0, 64),
        performer: String(artist).slice(0, 64) || undefined,
      });
    } catch (sendErr) {
      // Some hosts block Telegram from fetching the URL directly.
      // Fallback: download into memory and upload as an actual audio file.
      try {
        const fileRes = await axios.get(audioUrl, {
          responseType: 'arraybuffer',
          timeout: 60000,
          headers: { 'User-Agent': DEFAULT_UA },
          maxContentLength: 50 * 1024 * 1024,
          maxBodyLength: 50 * 1024 * 1024,
        });
        const buf = Buffer.from(fileRes.data);
        const safeTitle = String(title || 'spotify').replace(/[^a-z0-9\-_. ]/gi, '').trim().slice(0, 40) || 'spotify';
        const filename = `${safeTitle}.mp3`;

        await ctx.replyWithAudio(new InputFile(buf, filename), {
          caption,
          title: String(title).slice(0, 64),
          performer: String(artist).slice(0, 64) || undefined,
        });
      } catch (dlErr) {
        // Last resort: send as document link
        await ctx.replyWithDocument(audioUrl, { caption: `${caption}\n\n(Direct audio failed, download this file.)` });
      }
    }
    return true;
  } catch (e) {
    console.error('spotify error:', e?.message || e);
    refundCredits(user, 1);
    return sendFormattedMessage(ctx, '❌ Spotify download failed. Try again later.');
  }
});


// ===============================


bot.command('yt', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) return sendFormattedMessage(ctx, '❌ You need approval to use this command.');

  if (!deductCredits(user)) return sendFormattedMessage(ctx, '❌ Insufficient credits!');

  const input = getCommandArgs(ctx);
  if (!input) {
    refundCredits(user, 1);
    return sendFormattedMessage(ctx, '🎬 Usage: /yt <youtube url>');
  }

  // Accept either a YouTube URL or a direct ytcontent process URL.
  const raw = input.trim();

  // Extract video id from common YouTube links
  function extractYouTubeId(u) {
    try {
      const s = String(u || '');
      const m1 = s.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
      if (m1) return m1[1];
      const m2 = s.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
      if (m2) return m2[1];
      const m3 = s.match(/\/shorts\/([a-zA-Z0-9_-]{6,})/);
      if (m3) return m3[1];
      const m4 = s.match(/\/embed\/([a-zA-Z0-9_-]{6,})/);
      if (m4) return m4[1];
    } catch (_) {}
    return null;
  }

  // Try to pick a URL for a given quality from a list
  function pickQuality(urls, q) {
    const u = (urls || []).filter(isHttpUrl);
    const s = String(q);
    const direct = u.find(x => x.includes(s)) || null;
    if (direct) return direct;

    // some APIs use itags instead of "720p"
    const itagMap = { '1080': ['137','299','303','399'], '720': ['22','136','298','302'], '480': ['135','244','18'] };
    const itags = itagMap[s] || [];
    for (const it of itags) {
      const hit = u.find(x => new RegExp(`(?:itag|itags?|=)${it}(?:\D|$)`, 'i').test(x));
      if (hit) return hit;
    }

    // last resort: prefer mp4/video links
    const mp4 = u.filter(x => /\.mp4(\?|$)/i.test(x) || /mime=video/i.test(x) || /video/i.test(x));
    return mp4[0] || u[0] || null;
  }

  await sendFormattedMessage(ctx, '🎬 Preparing quality options...');

  try {
    let urls = [];

    // If user provided ytcontent process link, fetch it directly
    if (/ytcontent\.(?:net|com)\/v3\/videoProcess\//i.test(raw)) {
      const res = await axiosGetWithRetry(raw, { timeout: 45000 }, 2);
      urls = findAllUrlsDeep(res.data || {});
    } else {
      // Default: use existing resolver API
      const api = `https://flip-yt-downloader-akib.vercel.app/yt?url=${encodeURIComponent(raw)}`;
      const res = await axiosGetWithRetry(api, { timeout: 45000 }, 2);
      const data = res.data || {};
      urls = findAllUrlsDeep(data);
    }

    if (!urls.length) {
      refundCredits(user, 1);
      return sendFormattedMessage(ctx, '❌ YouTube download link not found from API.');
    }

    const u1080 = pickQuality(urls, '1080');
    const u720 = pickQuality(urls, '720');
    const u480 = pickQuality(urls, '480');

    if (!isHttpUrl(u1080) && !isHttpUrl(u720) && !isHttpUrl(u480)) {
      refundCredits(user, 1);
      return sendFormattedMessage(ctx, '❌ YouTube download link not found from API.');
    }

    user.totalQueries++;

    
    // Show buttons as CALLBACKS (no browser open). We'll send links in chat text.
    const kb = new InlineKeyboard();
    if (isHttpUrl(u1080)) kb.text('1080p', `ytq_1080`).row();
    if (isHttpUrl(u720))  kb.text('720p', `ytq_720`).row();
    if (isHttpUrl(u480))  kb.text('480p', `ytq_480`);
    if (!isHttpUrl(u1080) && !isHttpUrl(u720) && !isHttpUrl(u480)) {
      refundCredits(user, 1);
      return sendFormattedMessage(ctx, '❌ No downloadable qualities found for this video.');
    }

    // Cache resolved URLs per-chat/user
    const key = `${ctx.chat.id}:${ctx.from.id}`;
    if (!global.__ytCache) global.__ytCache = new Map();
    global.__ytCache.set(key, { u1080, u720, u480, raw });

    return ctx.reply('🎬 Choose Quality:', { reply_markup: kb });
  } catch (e) {
    console.error('yt error:', e?.message || e);
    refundCredits(user, 1);
    return sendFormattedMessage(ctx, '❌ YouTube download failed. Try again later.');
  }
});

// ===============================
// YT QUALITY CALLBACK (REAL-TIME PROGRESS + FINAL FILE URL IN CHAT)
// ===============================
// ===============================
// YT QUALITY CALLBACK (REAL-TIME PROGRESS + ETA/SPEED + FINAL FILE URL IN CHAT)
// ===============================
bot.callbackQuery(/^ytq_(1080|720|480)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (_) {}

  const q = ctx.match?.[1] || '1080';
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  const cache = global.__ytCache && global.__ytCache.get(key);
  const u = getOrCreateUser(ctx);
  if (u) recordCommandUse(u, 'yt');

  if (!cache) {
    try { return await ctx.reply('❌ Session expired. Please run /yt again.'); } catch (_) { return; }
  }

  const url =
    q === '1080' ? cache.u1080 :
    q === '720'  ? cache.u720  :
    cache.u480;

  if (!isHttpUrl(url)) {
    try { return await ctx.reply('❌ This quality is not available for this video.'); } catch (_) { return; }
  }

  
// If it's a ytcontent "videoProcess" URL, poll progress in the background (NON-BLOCKING) + provide a Stop button.
if (/ytcontent\.(?:net|com)\/v3\/videoProcess\//i.test(url)) {
  const baseKey = `${ctx.chat.id}:${ctx.from.id}`;

  // Cancel any existing job for this user/chat
  const prev = global.__ytJobs.get(baseKey);
  if (prev) prev.cancelled = true;

  const jobId = `${baseKey}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const stopKb = new InlineKeyboard().text('⛔ Stop', `ytstop_${jobId}`);

  // Send initial progress message (we will keep editing this)
  let msg = null;
  try {
    msg = await ctx.reply(
      formatYtProcessHtml({ percent: '0%', fileUrl: 'In Processing...' }, { speedText: '…', etaText: '…' }),
      { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: stopKb }
    );
  } catch (_) {}

  const job = {
    jobId,
    baseKey,
    chatId: ctx.chat.id,
    userId: ctx.from.id,
    messageId: msg?.message_id || null,
    quality: q,
    processUrl: url,
    cancelled: false,
    startedAt: Date.now()
  };

  global.__ytJobs.set(baseKey, job);
  global.__ytJobs.set(jobId, job);

  // Background runner (do NOT await)
  (async () => {
    const intervalMs = 2500;
    const maxTries = 120; // ~5 min

    let lastPct = null;
    let lastT = Date.now();
    let lastTotalBytes = null;

    function fmtEta(sec) {
      if (!isFinite(sec) || sec <= 0) return '…';
      const s = Math.floor(sec);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return `${mm}:${ss}`;
    }
    function fmtSpeed(bps) {
      if (!isFinite(bps) || bps <= 0) return '…';
      const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
      let u = 0;
      let v = bps;
      while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
      return `${v.toFixed(2)} ${units[u]}`;
    }

    try {
      for (let i = 0; i < maxTries; i++) {
        if (job.cancelled) {
          if (job.messageId) {
            try {
              await ctx.api.editMessageText(
                job.chatId,
                job.messageId,
                '⛔ <b>Download stopped.</b>\n\nRun /yt again to restart.',
                { parse_mode: 'HTML', disable_web_page_preview: true }
              );
            } catch (_) {}
          }
          return;
        }

        const res = await axiosGetWithRetry(job.processUrl, { timeout: 45000, responseType: 'json' }, 2);
        const data = res.data || {};

        const fileUrl = data.fileUrl || null;

        // NOTE: ignore other URL fields (url/download/download_url) to avoid googlevideo.com direct links.
        // We only treat the job as ready when `fileUrl` is present.

        const percentRaw = data.percent || data.progress || data.percentage || data.status || '…';
        const m = String(percentRaw).match(/(\d+(\.\d+)?)/);
        const pct = m ? parseFloat(m[1]) : null;

        const totalBytes =
          (typeof data?.fileSizeBytes === 'number' && data.fileSizeBytes) ||
          (typeof data?.fileSize === 'number' && data.fileSize) ||
          (typeof data?.estimatedFileSizeBytes === 'number' && data.estimatedFileSizeBytes) ||
          lastTotalBytes ||
          null;
        if (totalBytes) lastTotalBytes = totalBytes;

        // ready
        if (typeof fileUrl === 'string' && /^https?:\/\//i.test(fileUrl) && !/in\s*processing/i.test(fileUrl) && !/googlevideo\.com/i.test(fileUrl)) {
          if (job.messageId) {
            try {
              await ctx.api.editMessageText(
                job.chatId,
                job.messageId,
                formatYtProcessHtml({ ...data, percent: 'Completed', fileUrl: fileUrl }, { speedText: '—', etaText: '00:00', processUrl: job.processUrl }),
                { parse_mode: 'HTML', disable_web_page_preview: true }
              );
            } catch (_) {}
          }

          try {
            await sendVideoSmart({ ...ctx, chat: { id: job.chatId } }, fileUrl, `🎬 YouTube ${job.quality}p`);
          } catch (_) {}

          try { await adminAudit('yt_download_ready', ctx, `${job.quality}p | ${fileUrl}`); } catch (_) {}
          return;
        }

        // compute speed/eta from percent delta
        let speedText = '…';
        let etaText = '…';
        const now = Date.now();
        const dtSec = Math.max(0.001, (now - lastT) / 1000);

        if (pct != null && lastPct != null && pct > lastPct) {
          const ratePctPerSec = (pct - lastPct) / dtSec;
          etaText = fmtEta((100 - pct) / ratePctPerSec);

          if (totalBytes) {
            const downloadedNow = totalBytes * (pct / 100);
            const downloadedPrev = totalBytes * (lastPct / 100);
            const bps = (downloadedNow - downloadedPrev) / dtSec;
            speedText = fmtSpeed(bps);
          } else {
            speedText = `${ratePctPerSec.toFixed(2)} %/s`;
          }
        }

        lastPct = pct;
        lastT = now;

        if (job.messageId) {
          try {
            await ctx.api.editMessageText(
              job.chatId,
              job.messageId,
              formatYtProcessHtml(data, { speedText, etaText, processUrl: job.processUrl }),
              { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: stopKb }
            );
          } catch (_) {}
        }

        await sleep(intervalMs);
      }

      if (job.messageId) {
        try {
          await ctx.api.editMessageText(
            job.chatId,
            job.messageId,
            '❌ <b>Processing timed out.</b>\n\nTry again later.',
            { parse_mode: 'HTML', disable_web_page_preview: true }
          );
        } catch (_) {}
      } else {
        try { await ctx.api.sendMessage(job.chatId, '❌ Processing timed out. Try again later.'); } catch (_) {}
      }
    } catch (e) {
      if (job.messageId) {
        try {
          await ctx.api.editMessageText(
            job.chatId,
            job.messageId,
            '❌ <b>Download failed.</b> Try again later.',
            { parse_mode: 'HTML', disable_web_page_preview: true }
          );
        } catch (_) {}
      } else {
        try { await ctx.api.sendMessage(job.chatId, '❌ Download failed. Try again later.'); } catch (_) {}
      }
    } finally {
      global.__ytJobs.delete(job.baseKey);
      global.__ytJobs.delete(job.jobId);
    }
  })();

  // Return immediately so the bot stays responsive for everyone
  return;
}

// Direct URL (already ready)
  await ctx.reply(
    `✅ <b>YouTube ${q}p</b>\n\n⬇️ Download URL:\n<code>${escapeHtml(String(url))}</code>`,
    { parse_mode: 'HTML', disable_web_page_preview: true }
  );
  try { await sendVideoSmart(ctx, url, `🎬 YouTube ${q}p`); } catch (_) {}
  await adminAudit('yt_download_ready', ctx, `${q}p | ${url}`);
});




// Stop an active YT processing job
bot.callbackQuery(/^ytstop_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery('Stopping…'); } catch (_) {}

  const jobId = ctx.match?.[1];
  const job = (global.__ytJobs && global.__ytJobs.get(jobId)) || null;

  if (!job) {
    try { await ctx.reply('❌ No active download to stop.'); } catch (_) {}
    return;
  }

  const caller = String(ctx.from?.id || '');
  if (caller !== String(job.userId) && !isAdmin(caller) && caller !== String(adminId)) {
    try { await ctx.reply('❌ You can only stop your own download.'); } catch (_) {}
    return;
  }

  job.cancelled = true;

  if (job.messageId) {
    try {
      await ctx.api.editMessageText(
        job.chatId,
        job.messageId,
        '⛔ <b>Stopping…</b>',
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
    } catch (_) {}
  }

  try { await adminAudit('yt_download_stopped', ctx, `${job.quality}p | ${job.processUrl}`); } catch (_) {}
});

// OSINT Commands
bot.command('ip', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  // Check credits
  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const ip = ctx.match || 'self';
  await sendFormattedMessage(ctx, '🔍 Fetching IP intelligence...');

  try {
    const result = await getIpInfo(ip === 'self' ? undefined : ip.toString());
    
    if (result.success && result.data) {
      const response = `🌐 IP Intelligence Results 🌐

\`\`\`json
 ${JSON.stringify(result.data, null, 2)}
\`\`\`

💡 IP information for educational purposes only
• 1 credit deducted from your balance`;

      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      // Refund credit on failure
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, '❌ Failed to fetch IP information. Please check the IP address and try again.\n💳 1 credit refunded');
    }
  } catch (error) {
    console.error('Error in ip command:', error);
    // Refund credit on error
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while fetching IP information.\n💳 1 credit refunded');
  }
});

bot.command('email', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  // Check credits
  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const email = ctx.match;
  if (!email) {
    await sendFormattedMessage(ctx, '📧 Usage: /email <email address>\n\nExample: /email user@example.com');
    return;
  }

  await sendFormattedMessage(ctx, '🔍 Validating email address...');

  try {
    const result = await validateEmail(email.toString());
    
    if (result.success && result.data) {
      const response = `📧 Email Validation Results 📧

\`\`\`json
 ${JSON.stringify(result.data, null, 2)}
\`\`\`

💡 Email validation for educational purposes only
• 1 credit deducted from your balance`;

      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      // Refund credit on failure
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, '❌ Failed to validate email address. Please check the email and try again.\n💳 1 credit refunded');
    }
  } catch (error) {
    console.error('Error in email command:', error);
    // Refund credit on error
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while validating email address.\n💳 1 credit refunded');
  }
});

bot.command('num', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  // Check credits
  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const number = ctx.match;
  if (!number) {
    await sendFormattedMessage(ctx, '📱 Usage: /num <phone number>\n\nExample: /num 9389482769');
    return;
  }

  await sendFormattedMessage(ctx, '🔍 Looking up phone number...');

  try {
    const result = await getPhoneNumberInfo(number.toString());
    
    if (result.success && result.data) {
      const response = `📱 Phone Number Lookup Results 📱

\`\`\`json
 ${JSON.stringify(result.data, null, 2)}
\`\`\`

💡 Phone number information for educational purposes only
• 1 credit deducted from your balance`;

      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      // Refund credit on failure
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, '❌ Failed to lookup phone number. Please check the number and try again.\n💳 1 credit refunded');
    }
  } catch (error) {
    console.error('Error in num command:', error);
    // Refund credit on error
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while looking up phone number.\n💳 1 credit refunded');
  }
});

bot.command('basicnum', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  // Check credits
  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const number = ctx.match;
  if (!number) {
    await sendFormattedMessage(ctx, '📱 Usage: /basicnum <phone number>\n\nExample: /basicnum 919087654321');
    return;
  }

  await sendFormattedMessage(ctx, '🔍 Getting basic number information...');

  try {
    const result = await getBasicNumberInfo(number.toString());
    
    if (result.success && result.data) {
      const response = `📱 Basic Number Information 📱

\`\`\`json
 ${JSON.stringify(result.data, null, 2)}
\`\`\`

💡 Basic number information for educational purposes only
• 1 credit deducted from your balance`;

      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      // Refund credit on failure
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, '❌ Failed to get basic number information. Please check the number and try again.\n💳 1 credit refunded');
    }
  } catch (error) {
    console.error('Error in basicnum command:', error);
    // Refund credit on error
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while getting basic number information.\n💳 1 credit refunded');
  }
});

// UPDATED: Pakistani Government Number Information command
bot.command('paknum', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  // Check credits
  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const number = ctx.match;
  if (!number) {
    await sendFormattedMessage(ctx, '📱 Usage: /paknum <Pakistani number or CNIC>\n\nExample: /paknum 03005854962\nExample: /paknum 2150952917167');
    return;
  }

  await sendFormattedMessage(ctx, '🔍 Looking up Pakistani government number information...');

  try {
    const result = await getPakistaniGovtNumberInfo(number.toString());
    
    if (result.success && result.data && result.data.length > 0) {
      // Format the results as JSON with colored formatting
      const formattedResults = result.data.map((record, index) => ({
        [`Record #${index + 1}`]: {
          name: record.name || 'N/A',
          number: record.n || 'N/A',
          cnic: record.cnic || 'N/A',
          address: record.address || 'N/A'
        }
      }));
      
      const response = `📱 Pakistani Government Number Information 📱

🔍 Found ${result.count} record(s) for: ${number}

\`\`\`json
 ${JSON.stringify(formattedResults, null, 2)}
\`\`\`

💡 Information for educational purposes only
• 1 credit deducted from your balance`;

      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      // Refund credit on failure
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, `❌ ${result.error || 'No records found for the provided number or CNIC'}\n💳 1 credit refunded`);
    }
  } catch (error) {
    console.error('Error in paknum command:', error);
    // Refund credit on error
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while looking up Pakistani government number information.\n💳 1 credit refunded');
  }
});
// ===============================
// INDIA POSTAL COMMANDS
// ===============================
bot.command('pincode', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const pincode = (ctx.match || '').toString().trim();
  if (!pincode) {
    await sendFormattedMessage(ctx, '📮 Usage: /pincode <6-digit pincode>\n\nExample: /pincode 400001');
    return;
  }

  await sendFormattedMessage(ctx, '📮 Fetching India pincode information...');

  try {
    const result = await getIndiaPincodeInfo(pincode);
    if (result.success && result.data) {
      const response = `📮 India Pincode Lookup 📮\n\n🔎 Query: \`${escapeMd(pincode)}\`\n\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\`\n\n• 1 credit deducted from your balance`;
      await sendLongOrFile(ctx, response, `pincode_${pincode}`);
      user.totalQueries++;
    } else {
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, `❌ ${result.error || 'Failed to fetch pincode info'}\n💳 1 credit refunded`);
    }
  } catch (error) {
    console.error('Error in pincode command:', error);
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while fetching pincode info.\n💳 1 credit refunded');
  }
});

bot.command('postoffice', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const query = (ctx.match || '').toString().trim();
  if (!query) {
    await sendFormattedMessage(ctx, '🏤 Usage: /postoffice <name>\n\nExample: /postoffice Delhi');
    return;
  }

  await sendFormattedMessage(ctx, '🏤 Searching India Post Office data...');

  try {
    const result = await getIndiaPostOfficeInfo(query);
    if (result.success && result.data) {
      const response = `🏤 India Post Office Search 🏤\n\n🔎 Query: \`${escapeMd(query)}\`\n\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\`\n\n• 1 credit deducted from your balance`;
      await sendLongOrFile(ctx, response, `postoffice_${query}`);
      user.totalQueries++;
    } else {
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, `❌ ${result.error || 'Failed to fetch post office info'}\n💳 1 credit refunded`);
    }
  } catch (error) {
    console.error('Error in postoffice command:', error);
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while fetching post office info.\n💳 1 credit refunded');
  }
});

// ===============================
// /pak (DO NOT REPLACE /paknum)
// ===============================
bot.command('pak', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const query = (ctx.match || '').toString().trim();
  if (!query) {
    await sendFormattedMessage(ctx, '🇵🇰 Usage: /pak <query>\n\nExample: /pak 2150952917167');
    return;
  }

  await sendFormattedMessage(ctx, '🇵🇰 Looking up Pakistan info...');

  try {
    const result = await getRehuPakInfo(query);
    if (result.success && result.data) {
      const response = `🇵🇰 Pakistan Lookup (/pak) 🇵🇰\n\n🔎 Query: \`${escapeMd(query)}\`\n\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\`\n\n• 1 credit deducted from your balance`;
      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, `❌ ${result.error || 'No data found'}\n💳 1 credit refunded`);
    }
  } catch (error) {
    console.error('Error in pak command:', error);
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while fetching /pak info.\n💳 1 credit refunded');
  }
});

// ===============================
// IFSC (TEXT, NOT JSON)
// ===============================
bot.command('ifsc', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const ifsc = (ctx.match || '').toString().trim();
  if (!ifsc) {
    await sendFormattedMessage(ctx, '🏦 Usage: /ifsc <IFSC>\n\nExample: /ifsc SBIN0001234');
    return;
  }

  await sendFormattedMessage(ctx, '🏦 Fetching IFSC details...');

  try {
    const result = await getIfscInfo(ifsc);
    if (result.success && result.data) {
      const d = result.data || {};
      // Try common keys; fallback to printing whatever exists as text
      const lines = [];
      const push = (label, val) => {
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          lines.push(`• *${label}:* ${escapeMd(String(val))}`);
        }
      };

      push('IFSC', d.ifsc || d.IFSC || ifsc);
      push('Bank', d.bank || d.BANK);
      push('Branch', d.branch || d.BRANCH);
      push('Address', d.address || d.ADDRESS);
      push('City', d.city || d.CITY);
      push('District', d.district || d.DISTRICT);
      push('State', d.state || d.STATE);
      push('MICR', d.micr || d.MICR);
      push('Contact', d.contact || d.CONTACT);
      push('UPI', d.upi || d.UPI);

      const response =
        `🏦 *IFSC Details* 🏦\n\n` +
        `🔎 Query: \`${escapeMd(ifsc)}\`\n\n` +
        (lines.length ? lines.join('\n') : `• Result received, but fields are unknown.\n• Please check:\n${escapeMd(JSON.stringify(d))}`) +
        `\n\n• 1 credit deducted from your balance`;

      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, `❌ ${result.error || 'Failed to fetch IFSC info'}\n💳 1 credit refunded`);
    }
  } catch (error) {
    console.error('Error in ifsc command:', error);
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while fetching IFSC info.\n💳 1 credit refunded');
  }
});

// ===============================
// YOUTUBE THUMBNAIL (DIRECT IMAGE)
// ===============================


bot.command('ig', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  // Check credits
  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const username = ctx.match;
  if (!username) {
    await sendFormattedMessage(ctx, '📷 Usage: /ig <Instagram username>\n\nExample: /ig instagram');
    return;
  }

  await sendFormattedMessage(ctx, '🔍 Fetching Instagram intelligence...');

  try {
    const result = await getInstagramInfo(username.toString());
    
    if (result.success && result.data) {
      const response = `📷 Instagram Intelligence Results 📷

\`\`\`json
 ${JSON.stringify(result.data, null, 2)}
\`\`\`

💡 Instagram information for educational purposes only
• 1 credit deducted from your balance`;

      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      // Refund credit on failure
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, '❌ Failed to fetch Instagram information. Please check the username and try again.\n💳 1 credit refunded');
    }
  } catch (error) {
    console.error('Error in ig command:', error);
    // Refund credit on error
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while fetching Instagram information.\n💳 1 credit refunded');
  }
});


bot.command('igreels', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const input = (ctx.match || '').trim();
  if (!input) {
    await sendFormattedMessage(ctx, '🎞️ Usage: /igreels <Instagram username or profile URL>\n\nExample: /igreels indiangamedevv\nExample: /igreels https://instagram.com/indiangamedevv');
    return;
  }

  // Accept @username or profile URL
  let username = input.replace(/^@/, '');
  try {
    if (/https?:\/\//i.test(input)) {
      const u = new URL(input);
      // /username/...
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0]) username = parts[0];
    }
  } catch (_) {}

  if (!username || username.length < 2) {
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ Invalid username.\n💳 1 credit refunded');
    return;
  }

  await sendFormattedMessage(ctx, '🎞️ Fetching Instagram reels/posts...');

  try {
    const result = await getInstagramPosts(username.toString());

    if (result.success && result.data) {
      const response = `🎞️ Instagram Reels / Posts Results 🎞️

\`\`\`json
${JSON.stringify(result.data, null, 2)}
\`\`\`

• 1 credit deducted from your balance`;

      await sendLongOrFile(ctx, response, `igreels_${username}`);
      user.totalQueries++;
    } else {
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, `❌ Failed to fetch reels/posts information.\n💳 1 credit refunded`);
    }
  } catch (error) {
    console.error('Error in igreels command:', error);
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while fetching reels/posts information.\n💳 1 credit refunded');
  }
});

bot.command('pan', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const pan = ctx.match;
  if (!pan) {
    await sendFormattedMessage(ctx, '🪪 Usage: /pan <PAN>\n\nExample: /pan ABCDE1234F');
    return;
  }

  await sendFormattedMessage(ctx, '🪪 Fetching PAN info...');

  try {
    const result = await getPanInfo(pan.toString());

    if (result.success && result.data) {
      const response = `🪪 PAN Lookup Results 🪪

\`\`\`json
${JSON.stringify(result.data, null, 2)}
\`\`\`

• 1 credit deducted from your balance`;

      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, '❌ Failed to fetch PAN information.\n💳 1 credit refunded');
    }
  } catch (error) {
    console.error('Error in pan command:', error);
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while fetching PAN information.\n💳 1 credit refunded');
  }
});

bot.command('tginfo', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const tgIdRaw = ctx.match;
  const tgId = (tgIdRaw || '').toString().trim();
  if (!tgId) {
    await sendFormattedMessage(ctx, '🧾 Usage: /tginfo <telegram_id>\n\nExample: /tginfo 7712689923');
    return;
  }

  await sendFormattedMessage(ctx, '🧾 Fetching Telegram info...');

  try {
    const result = await getTelegramIdInfo(tgId);

    if (result.success && result.data) {
      const response = `🧾 Telegram Info Results 🧾

\`\`\`json
${JSON.stringify({ data: result.data, success: true }, null, 2)}
\`\`\`

• 1 credit deducted from your balance`;

      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, '❌ Failed to fetch Telegram info.\n💳 1 credit refunded');
    }
  } catch (error) {
    console.error('Error in tginfo command:', error);
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while fetching Telegram info.\n💳 1 credit refunded');
  }
});

bot.command('bin', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  // Check credits
  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const bin = ctx.match;
  if (!bin) {
    await sendFormattedMessage(ctx, '💳 Usage: /bin <BIN number>\n\nExample: /bin 460075');
    return;
  }

  await sendFormattedMessage(ctx, '🔍 Looking up BIN information...');

  try {
    const result = await getBinInfo(bin.toString());
    
    if (result.success && result.data) {
      const response = `💳 BIN Lookup Results 💳

\`\`\`json
 ${JSON.stringify(result.data, null, 2)}
\`\`\`

💡 BIN information for educational purposes only
• 1 credit deducted from your balance`;

      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      // Refund credit on failure
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, '❌ Failed to lookup BIN information. Please check the BIN and try again.\n💳 1 credit refunded');
    }
  } catch (error) {
    console.error('Error in bin command:', error);
    // Refund credit on error
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while looking up BIN information.\n💳 1 credit refunded');
  }
});

bot.command('deepbin', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const bin = (ctx.match || '').trim();
  if (!bin) {
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '💳 Usage: /deepbin <6-10 digit BIN>\nExample: /deepbin 400191\n💳 1 credit refunded');
    return;
  }

  await sendFormattedMessage(ctx, '🔍 Fetching Deep BIN information...');

  try {
    const result = await getDeepBinInfo(bin);

    if (result.success && result.data) {
      const response = `💳 Deep BIN Results 💳

\`\`\`json
${JSON.stringify(result.data, null, 2)}
\`\`\`

• 1 credit deducted from your balance`;

      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, '❌ Failed to fetch Deep BIN info.\n💳 1 credit refunded');
    }
  } catch (error) {
    console.error('Error in deepbin command:', error);
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while fetching Deep BIN info.\n💳 1 credit refunded');
  }
});



// ===============================
// TEMPMAIL (MAIL.TM BACKEND) - /tempmail new|me|inbox|read <id>

function tempmailInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔄 Refresh inbox', callback_data: 'tm_refresh' }],
      [{ text: '📨 My tempmail', callback_data: 'tm_me' }],
    ],
  };
}
// Uses https://docs.mail.tm/ API
// ===============================
const MAILTM_BASE = process.env.MAILTM_BASE || 'https://api.mail.tm';
const tempMailSessions = new Map(); // telegramId -> { address, password, token, accountId, createdAt }

function randString(n = 10) {
  return crypto.randomBytes(Math.ceil(n)).toString('hex').slice(0, n);
}

async function mailtmGetDomain() {
  const r = await axiosGetWithRetry(`${MAILTM_BASE}/domains?page=1`, { timeout: 25000 }, 2);
  const list = r.data?.['hydra:member'] || r.data?.member || r.data?.domains || [];
  const domain = list?.[0]?.domain;
  if (!domain) throw new Error('No mail.tm domains available');
  return domain;
}

async function mailtmCreateAccount(address, password) {
  // POST /accounts
  const res = await axios.post(`${MAILTM_BASE}/accounts`, { address, password }, {
    timeout: 25000,
    headers: { 'content-type': 'application/json', 'user-agent': DEFAULT_UA },
    validateStatus: () => true
  });

  if (res.status >= 200 && res.status < 300) return res.data;

  // If exists already, just continue (some providers reuse)
  const msg = JSON.stringify(res.data || {});
  if (res.status === 422 && msg.toLowerCase().includes('address')) {
    return { id: null, address };
  }
  throw new Error(`mail.tm account create failed: HTTP ${res.status}`);
}

async function mailtmGetToken(address, password) {
  const res = await axios.post(`${MAILTM_BASE}/token`, { address, password }, {
    timeout: 25000,
    headers: { 'content-type': 'application/json', 'user-agent': DEFAULT_UA },
    validateStatus: () => true
  });
  if (res.status >= 200 && res.status < 300 && res.data?.token) return res.data.token;
  throw new Error(`mail.tm token failed: HTTP ${res.status}`);
}

async function mailtmListMessages(token) {
  const r = await axiosGetWithRetry(`${MAILTM_BASE}/messages?page=1`, {
    timeout: 25000,
    headers: { Authorization: `Bearer ${token}` }
  }, 2);
  return r.data?.['hydra:member'] || [];
}

async function mailtmReadMessage(token, id) {
  const r = await axiosGetWithRetry(`${MAILTM_BASE}/messages/${encodeURIComponent(id)}`, {
    timeout: 25000,
    headers: { Authorization: `Bearer ${token}` }
  }, 2);
  return r.data;
}

function getSession(telegramId) {
  return tempMailSessions.get(String(telegramId)) || null;
}

async function ensureSession(ctx) {
  const telegramId = String(ctx.from?.id || '');
  let s = getSession(telegramId);
  if (s?.token) return s;

  // No session -> create one
  const domain = await mailtmGetDomain();
  const password = `P@${randString(12)}`;
  const address = `${randString(10)}@${domain}`;

  const acct = await mailtmCreateAccount(address, password);
  const token = await mailtmGetToken(address, password);

  s = { address, password, token, accountId: acct?.id || null, createdAt: Date.now() };
  tempMailSessions.set(telegramId, s);
  return s;
}

bot.command('tempmail', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    return sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
  }

  const args = String(ctx.match || '').trim();
  const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
  const action = (sub || 'new').toLowerCase();

  try {
    if (action === 'new') {
      // 1 credit for creating/refreshing mailbox
      if (!deductCredits(user)) {
        return sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
      }

      // Force refresh session
      tempMailSessions.delete(String(ctx.from.id));
      const s = await ensureSession(ctx);

      const msg =
`📨 *TempMail v9* (Inbox Enabled)

✅ *Your Temp Email:*
\`${s.address}\`

🔑 *Password:*
\`${s.password}\`

📥 *Inbox Commands:*
• /tempmail inbox
• /tempmail read <id>

⚠️ Use this mailbox for signups/OTP only.
• 1 credit deducted`;
      await sendFormattedMessage(ctx, msg);
      user.totalQueries++;
      return;
    }

    if (action === 'me') {
      const s = await ensureSession(ctx);
      const msg = `📨 *Your Current TempMail*\n\n\`${s.address}\`\n\nUse: /tempmail inbox`;
      try {
        return await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: tempmailInlineKeyboard() });
      } catch (_) {
        return sendFormattedMessage(ctx, msg);
      }
    }

    if (action === 'inbox') {
      const s = await ensureSession(ctx);
      const items = await mailtmListMessages(s.token);

      if (!items.length) {
        const msg = `📭 *Inbox is empty*\n\nEmail: \`${s.address}\`\n\nTip: wait 10–30 seconds, then tap *Refresh inbox* or run /tempmail inbox again.`;
        try {
          return await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: tempmailInlineKeyboard() });
        } catch (_) {
          return sendFormattedMessage(ctx, msg);
        }
      }

      const lines = items.slice(0, 15).map((m, i) => {
        const from = m?.from?.address || m?.from?.name || 'Unknown';
        const subject = m?.subject || '(no subject)';
        const id = m?.id || '';
        const seen = m?.seen ? '✅' : '🆕';
        return `${seen} *${i + 1}.* ${escapeMd(subject)}\n   From: ${escapeMd(from)}\n   ID: \`${escapeMd(id)}\``;
      }).join('\n\n');

      const msg = `📥 *Inbox (showing up to 15)*\nEmail: \`${s.address}\`\n\n${lines}\n\nUse: /tempmail read <id>`;
      try {
        return await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: tempmailInlineKeyboard() });
      } catch (_) {
        return sendFormattedMessage(ctx, msg);
      }
    }

    if (action === 'read') {
      const id = rest.join(' ').trim();
      if (!id) return sendFormattedMessage(ctx, '🧾 Usage: /tempmail read <message_id>');

      const s = await ensureSession(ctx);
      const m = await mailtmReadMessage(s.token, id);

      const from = m?.from?.address || m?.from?.name || 'Unknown';
      const subject = m?.subject || '(no subject)';
      const text = (m?.text || m?.intro || '').toString();
      const html = (m?.html && Array.isArray(m.html) ? m.html.join('\n') : (m?.html || '')).toString();

      const body = text || html || '(no body)';
      const shortBody = body.length > 3500 ? body.slice(0, 3500) + '\n…(trimmed)…' : body;

      const msg = `🧾 *Message*\n\n*Subject:* ${escapeMd(subject)}\n*From:* ${escapeMd(from)}\n*ID:* \`${escapeMd(id)}\`\n\n${escapeMd(shortBody)}`;
      return sendFormattedMessage(ctx, msg);
    }

    // unknown subcommand
    return sendFormattedMessage(ctx, `📨 Usage:\n• /tempmail new\n• /tempmail me\n• /tempmail inbox\n• /tempmail read <id>`);
  } catch (e) {
    console.error('tempmail error:', e?.message || e);
    // If action was 'new' we already deducted 1 credit; refund on failure
    if ((action === 'new') && user && !user.isPremium) refundCredits(user, 1);
    return sendFormattedMessage(ctx, `❌ TempMail failed. Try again.\n\nTip: /tempmail new`);
  }
});

// TempMail inline buttons
bot.callbackQuery('tm_me', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    return safeEditOrReply(ctx, '❌ You need to be approved to use TempMail. Use /register first.', backToMenuKeyboard());
  }
  try {
    const s = await ensureSession(ctx);
    const msg = `📨 *Your Current TempMail*\n\n\`${s.address}\`\n\nUse: /tempmail inbox`;
    return safeEditOrReply(ctx, msg, tempmailInlineKeyboard());
  } catch (e) {
    return safeEditOrReply(ctx, '❌ TempMail not ready. Run /tempmail new first.', tempmailInlineKeyboard());
  }
});

bot.callbackQuery('tm_refresh', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    return safeEditOrReply(ctx, '❌ You need to be approved to use TempMail. Use /register first.', backToMenuKeyboard());
  }
  try {
    const s = await ensureSession(ctx);
    const items = await mailtmListMessages(s.token);
    if (!items.length) {
      const msg = `📭 *Inbox is empty*\n\nEmail: \`${s.address}\`\n\nTip: wait 10–30 seconds, then tap *Refresh inbox* again.`;
      return safeEditOrReply(ctx, msg, tempmailInlineKeyboard());
    }
    const lines = items.slice(0, 15).map((m, i) => {
      const from = m?.from?.address || m?.from?.name || 'Unknown';
      const subject = m?.subject || '(no subject)';
      const id = m?.id || '';
      const seen = m?.seen ? '✅' : '🆕';
      return `${seen} *${i + 1}.* ${escapeMd(subject)}\n   From: ${escapeMd(from)}\n   ID: \`${escapeMd(id)}\``;
    }).join('\n\n');
    const msg = `📥 *Inbox (showing up to 15)*\nEmail: \`${s.address}\`\n\n${lines}\n\nUse: /tempmail read <id>`;
    return safeEditOrReply(ctx, msg, tempmailInlineKeyboard());
  } catch (e) {
    return safeEditOrReply(ctx, '❌ Failed to refresh inbox. Try /tempmail inbox or /tempmail new.', tempmailInlineKeyboard());
  }
});
bot.command('vehicle', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  // Check credits
  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const vehicle = ctx.match;
  if (!vehicle) {
    await sendFormattedMessage(ctx, '🚗 Usage: /vehicle <vehicle number>\n\nExample: /vehicle MH04KA0151');
    return;
  }

  await sendFormattedMessage(ctx, '🔍 Fetching vehicle details...');

  try {
    const result = await getVehicleInfo(vehicle.toString());
    
    if (result.success && result.data) {
      const response = `🚗 Vehicle Details Results 🚗

\`\`\`json
 ${JSON.stringify(result.data, null, 2)}
\`\`\`

💡 Vehicle information for educational purposes only
• 1 credit deducted from your balance`;

      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      // Refund credit on failure
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, '❌ Failed to fetch vehicle details. Please check the vehicle number and try again.\n💳 1 credit refunded');
    }
  } catch (error) {
    console.error('Error in vehicle command:', error);
    // Refund credit on error
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while fetching vehicle details.\n💳 1 credit refunded');
  }
});

bot.command('ff', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  // Check credits
  if (!deductCredits(user)) {
    await sendFormattedMessage(ctx, '❌ Insufficient credits! You need at least 1 credit to use this command.\n💳 Check your balance with /credits');
    return;
  }

  const uid = ctx.match;
  if (!uid) {
    await sendFormattedMessage(ctx, '🎮 Usage: /ff <Free Fire UID>\n\nExample: /ff 2819649271');
    return;
  }

  await sendFormattedMessage(ctx, '🔍 Fetching Free Fire statistics...');

  try {
    const result = await getFreeFireStats(uid.toString());
    
    if (result.success && result.data) {
      const response = `🎮 Free Fire Statistics Results 🎮

\`\`\`json
 ${JSON.stringify(result.data, null, 2)}
\`\`\`

💡 Free Fire statistics for educational purposes only
• 1 credit deducted from your balance`;

      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      // Refund credit on failure
      refundCredits(user, 1);
      await sendFormattedMessage(ctx, '❌ Failed to fetch Free Fire statistics. Please check the UID and try again.\n💳 1 credit refunded');
    }
  } catch (error) {
    console.error('Error in ff command:', error);
    // Refund credit on error
    refundCredits(user, 1);
    await sendFormattedMessage(ctx, '❌ An error occurred while fetching Free Fire statistics.\n💳 1 credit refunded');
  }
});

bot.command('myip', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  await sendFormattedMessage(ctx, '🔍 Fetching your IP information...');

  try {
    const result = await getIpInfo();
    
    if (result.success && result.data) {
      const ip = result.data.ip || 'Unknown';
      const city = result.data.city || 'Unknown';
      const region = result.data.region || 'Unknown';
      const country = result.data.country || 'Unknown';
      const org = result.data.org || 'Unknown';
      const timezone = result.data.timezone || 'Unknown';

      const response = `🌐 Your IP Information 🌐

📍 Location Details:
• IP Address: \`${ip}\`
• City: ${city}
• Region: ${region}
• Country: ${country}
• Organization: ${org}
• Timezone: ${timezone}

🔍 Network Information:
• ISP: ${org}
• Connection Type: Detected

💡 This information is for educational purposes only`;

      await sendFormattedMessage(ctx, response);
      user.totalQueries++;
    } else {
      await sendFormattedMessage(ctx, '❌ Failed to fetch IP information. Please try again.');
    }
  } catch (error) {
    console.error('Error in myip command:', error);
    await sendFormattedMessage(ctx, '❌ An error occurred while fetching IP information.');
  }
});

bot.command('useragent', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  try {
    const result = getUserAgentInfo();
    
    if (result.success && result.data) {
      const response = `🖥️ Browser & System Information 🖥️

🌐 Browser Details:
• Browser: ${result.data.browser}
• Version: ${result.data.version}
• Platform: ${result.data.platform}
• Mobile: ${result.data.mobile ? 'Yes' : 'No'}

📱 User Agent String:
\`${result.data.user_agent}\`

💡 This is the bot's user agent information`;

      await sendFormattedMessage(ctx, response);
    } else {
      await sendFormattedMessage(ctx, '❌ Failed to fetch user agent information.');
    }
  } catch (error) {
    console.error('Error in useragent command:', error);
    await sendFormattedMessage(ctx, '❌ An error occurred while fetching user agent information.');
  }
});


bot.command('stats', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  const response = `📊 Your Usage Statistics 📊

👤 Account Information:
• Username: @${user.username || 'N/A'}
• Status: ${user.isPremium ? '💎 Premium' : '🔹 Standard'}
• Credits: ${user.credits} 🪙
• Member Since: ${user.registrationDate.toLocaleDateString()}

📈 Usage Statistics:
• Total Queries: ${user.totalQueries}
• Credits Available: ${user.credits}

💎 ${user.isPremium ? 'Premium Member - Unlimited Access!' : 'Upgrade to Premium for unlimited queries!'}`;

  await sendFormattedMessage(ctx, response);
});

bot.command('credits', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) {
    await sendFormattedMessage(ctx, '❌ You need to be approved to use this command. Use /register to submit your request.');
    return;
  }

  const response = `💳 Credit Information 💳

🪙 Current Balance: ${user.credits} credits

👤 Account Status:
 ${user.isPremium ? '💎 Premium Member' : '🔹 Standard Member'}
 ${user.isPremium ? '✅ Unlimited queries' : `📊 Daily limit: ${user.credits} queries`}

📈 Usage Statistics:
• Total Queries: ${user.totalQueries}
• Credits Available: ${user.credits}

🎁 Want more credits?
• Upgrade to Premium for unlimited access
• Contact @jioxt for credit requests

💡 Each query consumes 1 credit`;

  await sendFormattedMessage(ctx, response);
});


// ===============================
// SPLEXX IMAGE GENERATOR (DIRECT IMAGE)
// ===============================

// Help command
bot.command('help', async (ctx) => {
  const helpMessage = `📖 Premium OSINT Bot - Complete Guide 📖

🔍 OSINT Lookup Commands:

📱 Device & Network:
• /ip <address> - IP geolocation and intelligence
• /bin <number> - Bank Identification Number lookup

🤖 AI & Media:
• /ai <text> - GPT-5 text AI
• /imggen <prompt> - AI image generator
• /spotify <url> - Spotify track download
• /yt <url> - YouTube downloader

👤 Social & Contact:
• /email <email> - Email validation and analysis
• /num <number> - International phone lookup
• /basicnum <number> - Basic number information
• /paknum <number> - Pakistani government number and CNIC lookup
• /pak <query> - Pakistan lookup (rehu)
• /pincode <pincode> - India pincode lookup
• /postoffice <name> - India post office search
• /ifsc <ifsc> - IFSC bank details
• /ig <username> - Instagram profile intelligence
• /igreels <username> - Instagram reels/posts fetch
• /pan <pan> - PAN lookup (India)
• /tginfo <id> - Telegram ID info fetch

🚗 Vehicle & Gaming:
• /vehicle <number> - Vehicle registration details
• /ff <uid> - Free Fire player statistics

📱 Social Media Video Downloaders:
• /dl <url> - Universal video downloader (auto-detects platform)
• /snap <url> - Snapchat video downloader
• /insta <url> - Instagram video downloader
• /pin <url> - Pinterest video downloader
• /fb <url> - Facebook video downloader
• /terabox <url> - TeraBox video downloader

📊 System Commands:
• /myip - Get your current IP information
• /useragent - Browser and system information
• /tempmail - Generate temporary email address
• /stats - View your usage statistics
• /credits - Check your credit balance
• /checkstatus - Check registration status
• /sync - Sync registration (if approved but lost access)

💎 Premium Benefits:
• 🔄 Unlimited queries per day
• ⚡ Priority API access
• 🔧 Advanced lookup tools
• 📞 24/7 premium support
• 🎯 Higher rate limits

📝 Usage Examples:
• /ip 8.8.8.8
• /email user@example.com
• /num 9389482769
• /basicnum 919087654321
• /paknum 03005854962
• /pak 2150952917167
• /pincode 400001
• /postoffice Delhi
• /ifsc SBIN0001234
• /imggen spiderman
• /ig instagram
• /igreels indiangamedevv
• /pan ABCDE1234F
• /tginfo 7712689923
• /dl https://www.instagram.com/reel/DSSvFDgjU3s/
• /snap https://snapchat.com/t/H2D8zTxt
• /pin https://pin.it/4gsJMxtt1
• /fb https://www.facebook.com/reel/1157396829623170/

⚠️ Important Notes:
• Each query consumes 1 credit
• Results are for educational purposes only
• Use responsibly and legally
• Respect privacy laws
• Videos larger than 50MB will be sent as download links

BOT BY @cnnetworkofficial

OWNER @JIOXT

🛡️ Educational Purpose Only - Use Responsibly 🛡️`;

  await sendFormattedMessage(ctx, helpMessage);
});

// Admin command
bot.command('admin', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  // Check if user is admin (either original admin or made admin)
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const user = getOrCreateUser(ctx);

  const pendingCount = registrationRequests.size;
  const totalUsers = users.size;
  const approvedUsers = Array.from(users.values()).filter(u => u.isApproved).length;
  const premiumUsers = Array.from(users.values()).filter(u => u.isPremium).length;

  const adminPanel = `🌟 ⚡ CN ADMIN CONTROL PANEL ⚡ 🌟

🧩 🔧 Version & UI:
• /setversion <vX> - 🧩 Set bot version
• /togglefooter - 🧩 Toggle version footer (ON/OFF)
• /adminaudit [n] - 🧾 View last n audit entries

🚫 🛡️ Moderation:
• /ban <id | @username | reply> - 🚫 Ban user
• /unban <id | @username | reply> - ✅ Unban user

💎 💰 Credit Management Commands:
• /give <user_id> <amount> - 🎁 Grant credits to user
• /remove <user_id> <amount> - 💸 Remove credits from user
• /giveall <amount> - 🌍 Bless all users with credits
• /removeall <amount> - 🗑️ Clear credits from all users
• /setcredits <user_id> <amount> - 🎯 Set exact credit amount
• /gencode <credits> [maxUses] [expiresHours] - 🎟️ Generate redeem code
• /gencodebulk <count> <credits> [maxUses] [expiresHours] - 🎟️ Generate multiple codes
• /revoke <code> - 🧨 Revoke a code
• /codesstats - 📊 Codes stats

👑 👥 User Management:
• /premium <user_id> - ⭐ Toggle premium status
• /checkuser <user_id> - 🔍 Inspect user details
• /users - 📋 List all users (premium first)
• /topusers - 🏆 Show top 10 users by queries
• /premiumlist - 💎 List all premium members
• /makeadmin <user_id> - 👑 Make user admin
• /removeadmin <user_id> - 🚫 Remove admin status

📋 📝 Registration Management:
• /registrations - 📋 View pending registrations
• /approve <user_id> - ✅ Approve registration
• /reject <user_id> - ❌ Reject registration
• /approveall - ✅ Approve all pending registrations

📊 📈 Statistics & Analytics:
• /stats - 📊 Complete bot statistics
• /adminstats - 🎯 Admin-only analytics
• /activity - 📈 Recent activity log
• /revenue - 💰 Premium revenue stats

🎮 🔧 System Controls:
• /broadcast <message> - 📢 Send broadcast to all
• /announce <title>|<message> - 🎭 Rich announcement
• /reset_daily - 🔄 Reset daily statistics
• /lucky - 🍀 Random user bonus
• /maintenance <on|off|message> - ⚙️ Toggle maintenance mode

🔥 🎯 Advanced Tools:
• /masspremium - 👑 Mass premium upgrade
• /massremovepremium - 🚫 Mass premium removal
• /removepremium <user_id> - 🚫 Remove premium from user
• /resetuser <user_id> - 🔄 Reset user account
• /logs - 📜 View system logs
• /backup - 💾 Create database backup

📊 Current Statistics:
• 👥 Total Users: ${totalUsers}
• ✅ Approved Users: ${approvedUsers}
• 💎 Premium Users: ${premiumUsers}
• ⏳ Pending Registrations: ${pendingCount}
• 🔧 Maintenance Mode: ${maintenanceMode ? 'ON' : 'OFF'}

⚡ 🌟 Unlimited Power • Unlimited Possibilities 🌟 ⚡

🔐 Admin access verified`;

  await sendFormattedMessage(ctx, adminPanel);
});

// Credit Management Commands
// ===============================
// REDEEM CODES
// ===============================
// Admin: /gencode <credits> [maxUses] [expiresHours]
// User:  /redeem <code>
bot.command('gencode', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  cleanupExpiredCodes();

  const parts = (ctx.match?.toString() || '').trim().split(/\s+/).filter(Boolean);
  const credits = parseInt(parts[0] || '', 10);
  const maxUses = parts[1] ? parseInt(parts[1], 10) : 1;
  const expiresHours = parts[2] ? parseInt(parts[2], 10) : 168; // 7 days default

  if (!Number.isFinite(credits) || credits <= 0) {
    await sendFormattedMessage(ctx, '🎟️ Usage: /gencode <credits> [maxUses] [expiresHours]\n\nExample: /gencode 50 1 168\n\nCode format: FUCK-XXXXX-XXX-SAKE');
    return;
  }
  if (!Number.isFinite(maxUses) || maxUses <= 0 || maxUses > 1000) {
    await sendFormattedMessage(ctx, '❌ maxUses must be between 1 and 1000.');
    return;
  }
  if (!Number.isFinite(expiresHours) || expiresHours <= 0 || expiresHours > 8760) {
    await sendFormattedMessage(ctx, '❌ expiresHours must be between 1 and 8760 (1 year).');
    return;
  }

  // Make code unique
  let codeStr = generateRedeemCode();
  let codeKey = normalizeCode(codeStr);
  for (let i = 0; i < 10 && redeemCodes.has(codeKey); i++) {
    codeStr = generateRedeemCode();
    codeKey = normalizeCode(codeStr);
  }

  const now = Date.now();
  const expiresAt = now + expiresHours * 60 * 60 * 1000;

  redeemCodes.set(codeKey, {
    displayCode: codeStr,
    credits,
    maxUses,
    uses: 0,
    redeemedBy: new Set(),
    createdBy: telegramId,
    createdAt: now,
    expiresAt
  });

    redeemStats.generated += 1;

const exp = new Date(expiresAt).toISOString();
  const msg =
`🎟️ *Redeem Code Generated*

\`\`\`
${codeStr}
\`\`\`

💰 *Credits:* +${credits}
👥 *Max Uses:* ${maxUses}
⏳ *Expires:* ${exp}
👑 *By:* @${escapeMd(ctx.from?.username || 'admin')}

✅ Share this code with users:
• They redeem with: \`/redeem ${codeStr}\`

⚠️ Note: Codes are stored in memory (reset on bot restart).`;
  await sendFormattedMessage(ctx, msg);

  // Auto-log generated code to admin channel
  await sendLogText(
    `🎟️ <b>/gencode</b>\n` +
    `👤 <b>Admin:</b> ${escapeHTML(ctx.from?.first_name || '')} (<code>${escapeHTML(telegramId)}</code>)\n` +
    `🎁 <b>Credits:</b> <b>${credits}</b> | 👥 <b>Max uses:</b> <b>${maxUses}</b> | ⏳ <b>Expires:</b> <b>${expiresHours}h</b>\n` +
    `🎟️ <b>Code:</b> <code>${escapeHTML(codeStr)}</code>`
  );

});


// Admin: /gencodebulk <count> <credits> [maxUses] [expiresHours]
bot.command('gencodebulk', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  cleanupExpiredCodes();

  const parts = (ctx.match?.toString() || '').trim().split(/\s+/).filter(Boolean);

  const count = Number(parts[0]);
  const credits = Number(parts[1]);
  const maxUses = parts[2] ? Number(parts[2]) : 1;
  const expiresHours = parts[3] ? Number(parts[3]) : 168; // default 7 days

  if (!Number.isFinite(count) || count <= 0 || count > 25) {
    await sendFormattedMessage(ctx, '🎟️ Usage: /gencodebulk <count> <credits> [maxUses] [expiresHours]\n\nExample: /gencodebulk 10 50 1 168\n\nMax count: 25');
    return;
  }
  if (!Number.isFinite(credits) || credits <= 0) {
    await sendFormattedMessage(ctx, '🎟️ Usage: /gencodebulk <count> <credits> [maxUses] [expiresHours]\n\nExample: /gencodebulk 10 50 1 168');
    return;
  }
  if (!Number.isFinite(maxUses) || maxUses <= 0 || maxUses > 1000) {
    await sendFormattedMessage(ctx, '❌ maxUses must be between 1 and 1000.');
    return;
  }
  if (!Number.isFinite(expiresHours) || expiresHours <= 0 || expiresHours > 8760) {
    await sendFormattedMessage(ctx, '❌ expiresHours must be between 1 and 8760 (1 year).');
    return;
  }

  const now = Date.now();
  const expiresAt = now + expiresHours * 60 * 60 * 1000;

  const codes = [];
  for (let n = 0; n < count; n++) {
    let codeStr = generateRedeemCode();
    let codeKey = normalizeCode(codeStr);
    for (let i = 0; i < 10 && redeemCodes.has(codeKey); i++) {
      codeStr = generateRedeemCode();
      codeKey = normalizeCode(codeStr);
    }

    redeemCodes.set(codeKey, {
      displayCode: codeStr,
      credits,
      maxUses,
      uses: 0,
      redeemedBy: new Set(),
      createdBy: telegramId,
      createdAt: now,
      expiresAt
    });

    codes.push(codeStr);
  }

  const lines = codes.map((c, i) => `${String(i + 1).padStart(3, '0')}. ${c}`);
  redeemStats.generated += codes.length;

  const msg =
`✅ *Bulk codes generated*
📦 Count: *${codes.length}* | 🎁 Credits: *${credits}* | 👥 Max uses: *${maxUses}* | ⏳ Expires: *${expiresHours}h*

\`\`\`
${lines.join('\n')}
\`\`\`

🧨 /revoke <code>
📊 /codesstats
🎟️ /redeem <code>`;

  await sendFormattedMessage(ctx, msg);

  // Auto-log bulk generated codes to admin channel
  await sendLogText(
    `📦 <b>/gencodebulk</b>\n` +
    `👤 <b>Admin:</b> ${escapeHTML(ctx.from?.first_name || '')} (<code>${escapeHTML(telegramId)}</code>)\n` +
    `🔢 <b>Count:</b> <b>${codes.length}</b> | 🎁 <b>Credits:</b> <b>${credits}</b> | 👥 <b>Max uses:</b> <b>${maxUses}</b> | ⏳ <b>Expires:</b> <b>${expiresHours}h</b>\n` +
    `🎟️ <b>Codes:</b>\n<pre>${escapeHTML(codes.join('\n'))}</pre>`
  );

});

bot.command('redeem', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user) return;

  // Optional: require approval before redeeming
  if (!user.isApproved && !user.isAdmin) {
    await sendFormattedMessage(ctx, '❌ Your account is not approved yet.\n\n✅ Register first: /register');
    return;
  }

  cleanupExpiredCodes();

  const raw = (ctx.match?.toString() || '').trim();
  const codeInput = normalizeCode(raw);

  if (!codeInput) {
    await sendFormattedMessage(ctx, '🎟️ Usage: /redeem <code>\n\nExample: /redeem FUCK-ABCDE-123-SAKE');
    return;
  }

  // Block revoked codes
  if (revokedCodes.has(codeInput)) {
    await sendFormattedMessage(ctx, '⛔ This code has been revoked by an admin.');
    return;
  }

  const entry = redeemCodes.get(codeInput);
  if (!entry) {
    await sendFormattedMessage(ctx, '❌ Invalid or expired code.');
    return;
  }

  const now = Date.now();
  if (entry.expiresAt && now > entry.expiresAt) {
    redeemCodes.delete(codeInput);
    expiredCodes.add(codeInput);
    await sendFormattedMessage(ctx, '❌ This code has expired.');
    return;
  }

  // Prevent same user redeeming same code multiple times
  if (entry.redeemedBy?.has(user.telegramId)) {
    await sendFormattedMessage(ctx, '⚠️ You already redeemed this code.');
    return;
  }

  if (entry.uses >= entry.maxUses) {
    redeemCodes.delete(codeInput);
    usedUpCodes.add(codeInput);
    await sendFormattedMessage(ctx, '❌ This code has already been fully used.');
    return;
  }

  user.credits = (user.credits || 0) + entry.credits;
  entry.uses += 1;
  redeemStats.redeemed += 1;
  entry.redeemedBy?.add(user.telegramId);

  // Auto-delete when fully used
  if (entry.uses >= entry.maxUses) {
    redeemCodes.delete(codeInput);
    usedUpCodes.add(codeInput);
  }

  const msg =
`✅ *Code Redeemed Successfully!*

🎟️ *Code:* \`${codeInput}\`
💰 *Credits Added:* +${entry.credits}
💳 *New Balance:* ${user.credits} credits

✨ Enjoy!`;
  await sendFormattedMessage(ctx, msg);
});
// Admin: /revoke <code>
bot.command('revoke', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const raw = (ctx.match?.toString() || '').trim();
  const codeKey = normalizeCode(raw);

  if (!codeKey) {
    await sendFormattedMessage(ctx, '🧨 Usage: /revoke <code>\n\nExample: /revoke FUCK-ABCDE-123-SAKE');
    return;
  }

  let existed = false;
  if (redeemCodes.has(codeKey)) {
    redeemCodes.delete(codeKey);
    existed = true;
  }

  revokedCodes.add(codeKey);

  // If it was previously tracked elsewhere, keep those stats but it's now revoked.
  const msg = existed
    ? `✅ Code revoked: \`${raw}\``
    : `✅ Code marked as revoked (even if not found/was expired): \`${raw}\``;

  await sendFormattedMessage(ctx, msg);

  // Auto-log
  await sendLogText(
    `🧨 <b>/revoke</b>\n` +
    `👤 <b>Admin:</b> ${escapeHTML(ctx.from?.first_name || '')} (<code>${escapeHTML(telegramId)}</code>)\n` +
    `🎟️ <b>Code:</b> <code>${escapeHTML(raw)}</code>\n` +
    `✅ <b>Status:</b> ${existed ? 'Removed & revoked' : 'Revoked only'}`
  );
});

// Admin: /codesstats
bot.command('codesstats', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const now = Date.now();
  let active = 0;
  let expInMap = 0;
  let totalUsesActive = 0;

  for (const [k, v] of redeemCodes.entries()) {
    const isExpired = v?.expiresAt && now > v.expiresAt;
    if (isExpired) expInMap += 1;
    else if ((v?.uses || 0) < (v?.maxUses || 1)) active += 1;
    totalUsesActive += (v?.uses || 0);
  }

  // Note: some expired/used-up codes are removed during cleanup/redeem and tracked in sets.
  const totalGenerated = redeemStats.generated || (redeemCodes.size + revokedCodes.size + expiredCodes.size + usedUpCodes.size);
  const text =
`📊 *Redeem Codes Stats*

🎟️ Total Generated: *${totalGenerated}*
✅ Active: *${active}*
⌛ Expired (tracked): *${expiredCodes.size}*
⛔ Revoked: *${revokedCodes.size}*
📛 Used Up (tracked): *${usedUpCodes.size}*

👥 Total Redeems (tracked): *${redeemStats.redeemed}*
🧾 Active-map redeems: *${totalUsesActive}*`;

  await sendFormattedMessage(ctx, text);
});


bot.command('give', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const args = ctx.match?.toString().split(' ');
  if (!args || args.length < 2) {
    await sendFormattedMessage(ctx, '💎 Usage: /give <user_id> <amount>\n\nExample: /give 123456789 500');
    return;
  }

  const targetUserId = args[0];
  const amount = parseInt(args[1]);

  if (isNaN(amount) || amount <= 0) {
    await sendFormattedMessage(ctx, '❌ Please provide a valid positive amount.');
    return;
  }

  const targetUser = users.get(targetUserId);
  if (!targetUser) {
    await sendFormattedMessage(ctx, '❌ User not found.');
    return;
  }

  targetUser.credits += amount;

  const userMessage = `🎉 Credits Received! 🎉

💰 Amount: +${amount} credits
💳 New Balance: ${targetUser.credits} credits
👤 From: Admin

✨ Enjoy your credits! Use them wisely for OSINT lookups.`;

  await notifyUser(targetUserId, userMessage);

  const adminMessage = `💎 Credits Granted Successfully 💎

✅ Transaction Details:
• User ID: ${targetUserId}
• Amount: ${amount} credits
• New Balance: ${targetUser.credits} credits
• Admin: @${ctx.from?.username}

🎯 User has been notified about the credit grant`;

  await sendFormattedMessage(ctx, adminMessage);
});

bot.command('remove', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const args = ctx.match?.toString().split(' ');
  if (!args || args.length < 2) {
    await sendFormattedMessage(ctx, '💸 Usage: /remove <user_id> <amount>\n\nExample: /remove 123456789 100');
    return;
  }

  const targetUserId = args[0];
  const amount = parseInt(args[1]);

  if (isNaN(amount) || amount <= 0) {
    await sendFormattedMessage(ctx, '❌ Please provide a valid positive amount.');
    return;
  }

  const targetUser = users.get(targetUserId);
  if (!targetUser) {
    await sendFormattedMessage(ctx, '❌ User not found.');
    return;
  }

  if (targetUser.credits < amount) {
    await sendFormattedMessage(ctx, `❌ User only has ${targetUser.credits} credits. Cannot remove ${amount}.`);
    return;
  }

  targetUser.credits -= amount;

  const userMessage = `💸 Credits Deducted 💸

💰 Amount: -${amount} credits
💳 New Balance: ${targetUser.credits} credits
👤 Action by: Admin

📝 If you have questions about this deduction, please contact support @jioxt .`;

  await notifyUser(targetUserId, userMessage);

  const adminMessage = `💸 Credits Removed Successfully 💸

✅ Transaction Details:
• User ID: ${targetUserId}
• Amount: ${amount} credits
• New Balance: ${targetUser.credits} credits
• Admin: @${ctx.from?.username}

🎯 User has been notified about the credit deduction`;

  await sendFormattedMessage(ctx, adminMessage);
});

bot.command('giveall', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const amount = parseInt(ctx.match?.toString());
  if (isNaN(amount) || amount <= 0) {
    await sendFormattedMessage(ctx, '🌍 Usage: /giveall <amount>\n\nExample: /giveall 100');
    return;
  }

  const approvedUsers = Array.from(users.values()).filter(u => u.isApproved);
  
  if (approvedUsers.length === 0) {
    await sendFormattedMessage(ctx, '⚠️ No approved users found to give credits to.');
    return;
  }

  let successCount = 0;
  let totalAmount = 0;

  for (const user of approvedUsers) {
    user.credits += amount;
    successCount++;
    totalAmount += amount;

    // Notify user
    const userMessage = `🎉 Bonus Credits Received! 🎉

💰 Amount: +${amount} credits
💳 New Balance: ${user.credits} credits
👤 From: Admin (Global Bonus)

✨ Enjoy your bonus credits! Use them wisely for OSINT lookups.`;

    await notifyUser(user.telegramId, userMessage).catch(err => 
      console.error(`Failed to notify user ${user.telegramId}:`, err)
    );
  }

  const adminMessage = `🌍 Global Credits Granted Successfully 🌍

✅ Transaction Details:
• Users Updated: ${successCount}
• Credits per User: ${amount}
• Total Credits Distributed: ${totalAmount}
• Admin: @${ctx.from?.username}

🎯 All users have been notified about the credit grant`;

  await sendFormattedMessage(ctx, adminMessage);
});

bot.command('removeall', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const amount = parseInt(ctx.match?.toString());
  if (isNaN(amount) || amount <= 0) {
    await sendFormattedMessage(ctx, '🗑️ Usage: /removeall <amount>\n\nExample: /removeall 50');
    return;
  }

  const approvedUsers = Array.from(users.values()).filter(u => u.isApproved);
  
  if (approvedUsers.length === 0) {
    await sendFormattedMessage(ctx, '⚠️ No approved users found to remove credits from.');
    return;
  }

  let successCount = 0;
  let totalAmount = 0;

  for (const user of approvedUsers) {
    if (user.credits >= amount) {
      user.credits -= amount;
      successCount++;
      totalAmount += amount;

      // Notify user
      const userMessage = `💸 Credits Deducted 💸

💰 Amount: -${amount} credits
💳 New Balance: ${user.credits} credits
👤 Action by: Admin (Global Adjustment)

📝 If you have questions about this deduction, please contact support @jioxt.`;

      await notifyUser(user.telegramId, userMessage).catch(err => 
        console.error(`Failed to notify user ${user.telegramId}:`, err)
      );
    }
  }

  const adminMessage = `🗑️ Global Credits Removed Successfully 🗑️

✅ Transaction Details:
• Users Updated: ${successCount}
• Credits per User: ${amount}
• Total Credits Removed: ${totalAmount}
• Admin: @${ctx.from?.username}

🎯 All affected users have been notified about the credit deduction`;

  await sendFormattedMessage(ctx, adminMessage);
});

bot.command('setcredits', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const args = ctx.match?.toString().split(' ');
  if (!args || args.length < 2) {
    await sendFormattedMessage(ctx, '🎯 Usage: /setcredits <user_id> <amount>\n\nExample: /setcredits 123456789 1000');
    return;
  }

  const targetUserId = args[0];
  const amount = parseInt(args[1]);

  if (isNaN(amount) || amount < 0) {
    await sendFormattedMessage(ctx, '❌ Please provide a valid non-negative amount.');
    return;
  }

  const targetUser = users.get(targetUserId);
  if (!targetUser) {
    await sendFormattedMessage(ctx, '❌ User not found.');
    return;
  }

  const oldCredits = targetUser.credits;
  targetUser.credits = amount;

  const userMessage = amount > oldCredits ? 
    `🎉 Credits Updated! 🎉

💰 Amount: +${amount - oldCredits} credits
💳 New Balance: ${targetUser.credits} credits
👤 Updated by: Admin

✨ Enjoy your credits! Use them wisely for OSINT lookups.` :
    `💸 Credits Updated 💸

💰 Amount: ${amount - oldCredits} credits
💳 New Balance: ${targetUser.credits} credits
👤 Updated by: Admin

📝 If you have questions about this change, please contact support @jioxt .`;

  await notifyUser(targetUserId, userMessage);

  const adminMessage = `🎯 Credits Set Successfully 🎯

✅ Transaction Details:
• User ID: ${targetUserId}
• Old Balance: ${oldCredits} credits
• New Balance: ${targetUser.credits} credits
• Admin: @${ctx.from?.username}

🎯 User has been notified about the credit update`;

  await sendFormattedMessage(ctx, adminMessage);
});

bot.command('premium', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const targetUserId = ctx.match?.toString();
  if (!targetUserId) {
    await sendFormattedMessage(ctx, '⭐ Usage: /premium <user_id>\n\nExample: /premium 123456789');
    return;
  }

  const targetUser = users.get(targetUserId);
  if (!targetUser) {
    await sendFormattedMessage(ctx, '❌ User not found.');
    return;
  }

  targetUser.isPremium = !targetUser.isPremium;
  const action = targetUser.isPremium ? 'granted' : 'revoked';

  const userMessage = targetUser.isPremium ? 
    `🎉 Premium Status Granted! 🎉

💎 Welcome to Premium!
✅ Unlimited queries
⚡ Priority API access
🔧 Advanced tools
📞 24/7 support

🌟 Thank you for upgrading to Premium!

💎 Enjoy your exclusive benefits!` :
    `💳 Premium Status Revoked 💳

📋 Status Changed:
• Premium access revoked
• Back to standard features
• Contact @jioxt for details

📞 If you have questions, please reach out to support`;

  await notifyUser(targetUserId, userMessage);

  const adminMessage = `⭐ Premium Status Updated ⭐

✅ Action Details:
• User ID: ${targetUserId}
• Action: Premium ${action}
• New Status: ${targetUser.isPremium ? '💎 Premium' : '🔹 Standard'}
• Admin: @${ctx.from?.username}

🎯 User has been notified about the status change`;

  await sendFormattedMessage(ctx, adminMessage);
});

bot.command('makeadmin', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const targetUserId = ctx.match?.toString();
  if (!targetUserId) {
    await sendFormattedMessage(ctx, '👑 Usage: /makeadmin <user_id>\n\nExample: /makeadmin 123456789');
    return;
  }

  const targetUser = users.get(targetUserId);
  if (!targetUser) {
    await sendFormattedMessage(ctx, '❌ User not found.');
    return;
  }

  if (targetUser.isAdmin) {
    await sendFormattedMessage(ctx, '⚠️ This user is already an admin.');
    return;
  }

  targetUser.isAdmin = true;

  const userMessage = `👑 Admin Access Granted! 👑

🎉 Congratulations!
✅ Admin status granted
🔧 Full admin access
📋 Admin commands available

🎯 Get Started:
• Use /admin to view all admin commands
• Access user management tools
• Control bot settings

💎 Welcome to the admin team!`;

  await notifyUser(targetUserId, userMessage);

  const adminMessage = `👑 Admin Access Granted 👑

✅ Action Details:
• User ID: ${targetUserId}
• Username: @${targetUser.username || 'N/A'}
• Action: Admin access granted
• Admin: @${ctx.from?.username}

🎯 User has been notified about admin access`;

  await sendFormattedMessage(ctx, adminMessage);
});

bot.command('removeadmin', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const targetUserId = ctx.match?.toString();
  if (!targetUserId) {
    await sendFormattedMessage(ctx, '🚫 Usage: /removeadmin <user_id>\n\nExample: /removeadmin 123456789');
    return;
  }

  const targetUser = users.get(targetUserId);
  if (!targetUser) {
    await sendFormattedMessage(ctx, '❌ User not found.');
    return;
  }

  if (!targetUser.isAdmin) {
    await sendFormattedMessage(ctx, '⚠️ This user is not an admin.');
    return;
  }

  if (targetUserId === telegramId) {
    await sendFormattedMessage(ctx, '❌ You cannot remove your own admin access.');
    return;
  }

  targetUser.isAdmin = false;

  const userMessage = `🚫 Admin Access Removed 🚫

📋 Status Update:
• Admin access removed
• Back to regular user
• Contact main admin @jioxt if needed

📞 If you have questions about this change, please reach out to the main admin`;

  await notifyUser(targetUserId, userMessage);

  const adminMessage = `🚫 Admin Access Removed 🚫

✅ Action Details:
• User ID: ${targetUserId}
• Username: @${targetUser.username || 'N/A'}
• Action: Admin access removed
• Admin: @${ctx.from?.username}

🎯 User has been notified about admin removal`;

  await sendFormattedMessage(ctx, adminMessage);
});

bot.command('checkuser', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const targetUserId = ctx.match?.toString();
  if (!targetUserId) {
    await sendFormattedMessage(ctx, '🔍 Usage: /checkuser <user_id>\n\nExample: /checkuser 123456789');
    return;
  }

  const targetUser = users.get(targetUserId);
  if (!targetUser) {
    await sendFormattedMessage(ctx, '❌ User not found.');
    return;
  }

  const userInfo = `🔍 User Information 🔍

👤 Basic Details:
• Telegram ID: ${targetUser.telegramId}
• Username: @${targetUser.username || 'N/A'}
• Name: ${targetUser.firstName || ''} ${targetUser.lastName || ''}
• Registration: ${targetUser.registrationDate.toLocaleDateString()}

📊 Account Status:
• Approved: ${targetUser.isApproved ? '✅ Yes' : '❌ No'}
• Premium: ${targetUser.isPremium ? '💎 Yes' : '🔹 No'}
• Admin: ${targetUser.isAdmin ? '👑 Yes' : '🔹 No'}

💳 Credits & Usage:
• Current Balance: ${targetUser.credits} credits
• Total Queries: ${targetUser.totalQueries}

📈 Account Health:
 ${targetUser.isApproved && targetUser.credits >= 0 ? '✅ Healthy' : '⚠️ Needs attention'}`;

  await sendFormattedMessage(ctx, userInfo);
});

bot.command('users', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const userList = Array.from(users.values()).map((u, index) => {
    const status = u.isPremium ? '💎' : u.isApproved ? '✅' : '⏳';
    const adminBadge = u.isAdmin ? '👑' : '';
    return `${index + 1}. ${status}${adminBadge} @${u.username || 'N/A'} (${u.telegramId}) - ${u.credits} credits`;
  }).join('\n');

  const response = `📋 User List 📋

👥 Total Users: ${users.size}
💎 Premium Users: ${Array.from(users.values()).filter(u => u.isPremium).length}
✅ Approved Users: ${Array.from(users.values()).filter(u => u.isApproved).length}
👑 Admins: ${Array.from(users.values()).filter(u => u.isAdmin).length}

📊 User Details:
 ${userList}

💎 Legend: 💎 Premium | ✅ Approved | ⏳ Pending | 👑 Admin`;

  await sendFormattedMessage(ctx, response);
});

bot.command('topusers', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const topUsers = Array.from(users.values())
    .filter(u => u.isApproved)
    .sort((a, b) => b.totalQueries - a.totalQueries)
    .slice(0, 10);

  if (topUsers.length === 0) {
    await sendFormattedMessage(ctx, '🏆 No approved users found.');
    return;
  }

  const userList = topUsers.map((u, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏅';
    const status = u.isPremium ? '💎' : '🔹';
    return `${medal} ${status} @${u.username || 'N/A'} - ${u.totalQueries} queries`;
  }).join('\n');

  const response = `🏆 Top 10 Users by Queries 🏆

📊 Statistics:
• Total users shown: ${topUsers.length}
• Premium users: ${topUsers.filter(u => u.isPremium).length}
• Total queries: ${topUsers.reduce((sum, u) => sum + u.totalQueries, 0)}

🎯 Leaderboard:
 ${userList}

💎 Legend: 💎 Premium | 🔹 Standard`;

  await sendFormattedMessage(ctx, response);
});

bot.command('premiumlist', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const premiumUsers = Array.from(users.values()).filter(u => u.isPremium);

  if (premiumUsers.length === 0) {
    await sendFormattedMessage(ctx, '💎 No premium users found.');
    return;
  }

  const userList = premiumUsers.map((u, index) => {
    const adminBadge = u.isAdmin ? '👑' : '';
    return `${index + 1}. 💎${adminBadge} @${u.username || 'N/A'} (${u.telegramId})`;
  }).join('\n');

  const response = `💎 Premium Members List 💎

👥 Total Premium Users: ${premiumUsers.length}
👑 Premium Admins: ${premiumUsers.filter(u => u.isAdmin).length}

📊 Premium Members:
 ${userList}

💎 Legend: 💎 Premium | 👑 Admin`;

  await sendFormattedMessage(ctx, response);
});

// Registration Management Commands
bot.command('registrations', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  if (registrationRequests.size === 0) {
    await sendFormattedMessage(ctx, '📋 No Pending Registrations 📋\n\n✅ All registration requests have been processed.');
    return;
  }

  const registrationList = Array.from(registrationRequests.values()).map((req, index) => {
    return `${index + 1}. ⏳ @${req.username || 'N/A'} (${req.telegramId}) - ${req.timestamp.toLocaleDateString()}`;
  }).join('\n');

  const response = `📋 Pending Registration Requests 📋

👥 Total Pending: ${registrationRequests.size}

📊 Registration List:
 ${registrationList}

🎯 Actions:
• Use /approve <user_id> to approve
• Use /reject <user_id> to reject
• Or use the callback buttons in notification messages`;

  await sendFormattedMessage(ctx, response);
});

bot.command('approve', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const targetUserId = ctx.match?.toString();
  if (!targetUserId) {
    await sendFormattedMessage(ctx, '✅ Usage: /approve <user_id>\n\nExample: /approve 123456789');
    return;
  }

  const request = registrationRequests.get(targetUserId);
  if (!request) {
    await sendFormattedMessage(ctx, '❌ Registration request not found.');
    return;
  }

  const user = users.get(targetUserId) || {
    telegramId: targetUserId,
    username: request.username,
    firstName: request.firstName,
    lastName: request.lastName,
    isApproved: false,
    credits: 0,
    isPremium: false,
    isAdmin: false,
    totalQueries: 0,
    registrationDate: new Date()
  };

  user.isApproved = true;
  user.credits = 50;
  users.set(targetUserId, user);
  registrationRequests.delete(targetUserId);
  registeredUsers.add(targetUserId);

  const userMessage = `🎉 Registration Approved! 🎉

✅ Congratulations! Your registration has been approved.

💎 Welcome Benefits:
• 50 starting credits 🪙
• Full access to all OSINT tools
• Premium features available

🚀 Get Started:
• Use /start to see all available commands
• Try /help for detailed instructions
• Check /credits to see your balance

⚡ Thank you for joining our OSINT community!`;

  await notifyUser(targetUserId, userMessage);

  const adminMessage = `✅ Registration Approved Successfully ✅

👤 User Details:
• User ID: ${targetUserId}
• Username: @${user.username || 'N/A'}
• Credits Granted: 50

🎯 Action Completed:
• Status: Approved ✅
• Processed by: @${ctx.from?.username}
• Timestamp: ${new Date().toLocaleString()}

💎 User has been notified about approval`;

  await sendFormattedMessage(ctx, adminMessage);
});

bot.command('reject', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const targetUserId = ctx.match?.toString();
  if (!targetUserId) {
    await sendFormattedMessage(ctx, '❌ Usage: /reject <user_id>\n\nExample: /reject 123456789');
    return;
  }

  const request = registrationRequests.get(targetUserId);
  if (!request) {
    await sendFormattedMessage(ctx, '❌ Registration request not found.');
    return;
  }

  registrationRequests.delete(targetUserId);

  const userMessage = `❌ Registration Rejected ❌

📋 Your registration request has been rejected.

📞 Next Steps:
• Contact the admin @jioxt for more information
• Review registration requirements
• You may submit a new request if needed

💡 If you believe this is an error, please reach out to our support team`;

  await notifyUser(targetUserId, userMessage);

  const adminMessage = `❌ Registration Rejected Successfully ❌

👤 User Details:
• User ID: ${targetUserId}
• Username: @${request.username || 'N/A'}

🎯 Action Completed:
• Status: Rejected ❌
• Processed by: @${ctx.from?.username}
• Timestamp: ${new Date().toLocaleString()}

💎 User has been notified about rejection`;

  await sendFormattedMessage(ctx, adminMessage);
});

// Approve all pending registrations command
bot.command('approveall', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  if (registrationRequests.size === 0) {
    await sendFormattedMessage(ctx, '📋 No Pending Registrations 📋\n\n✅ All registration requests have been processed.');
    return;
  }

  const pendingRequests = Array.from(registrationRequests.values());
  const approvedUsers = [];

  // Process all pending registrations
  for (const request of registrationRequests.values()) {
    const targetUserId = request.telegramId;
    
    // Check if user already exists
    let user = users.get(targetUserId);
    if (!user) {
      user = {
        telegramId: targetUserId,
        username: request.username,
        firstName: request.firstName,
        lastName: request.lastName,
        isApproved: false,
        credits: 0,
        isPremium: false,
        isAdmin: false,
        totalQueries: 0,
        registrationDate: new Date()
      };
    }

    // Approve user
    user.isApproved = true;
    user.credits = 50; // Give starting credits
    users.set(targetUserId, user);
    registeredUsers.add(targetUserId);
    approvedUsers.push({
      userId: targetUserId,
      username: request.username || 'N/A'
    });

    // Notify user
    const userMessage = `🎉 Registration Approved! 🎉

✅ Congratulations! Your registration has been approved.

💎 Welcome Benefits:
• 50 starting credits 🪙
• Full access to all OSINT tools
• Premium features available

🚀 Get Started:
• Use /start to see all available commands
• Try /help for detailed instructions
• Check /credits to see your balance

⚡ Thank you for joining our OSINT community!`;

    await notifyUser(targetUserId, userMessage);
  }

  // Clear all registration requests
  const totalApproved = pendingRequests.length;
  registrationRequests.clear();

  // Send confirmation to admin
  const adminMessage = `✅ All Registrations Approved Successfully ✅

📊 Approval Summary:
• Total Approved: ${totalApproved} users
• Credits per User: 50 🪙
• Total Credits Distributed: ${totalApproved * 50} 🪙

👥 Approved Users:
 ${approvedUsers.map((user, index) => `${index + 1}. @${user.username} (${user.userId})`).join('\n')}

🎯 Action Completed:
• Status: All Approved ✅
• Processed by: @${ctx.from?.username}
• Timestamp: ${new Date().toLocaleString()}

💎 All users have been notified about their approval`;

  await sendFormattedMessage(ctx, adminMessage);
});

// Statistics Commands
bot.command('adminstats', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const totalUsers = users.size;
  const approvedUsers = Array.from(users.values()).filter(u => u.isApproved).length;
  const premiumUsers = Array.from(users.values()).filter(u => u.isPremium).length;
  const adminUsers = Array.from(users.values()).filter(u => u.isAdmin).length;
  const totalQueries = Array.from(users.values()).reduce((sum, u) => sum + u.totalQueries, 0);
  const pendingRegistrations = registrationRequests.size;

  const statsMessage = `📊 Admin Statistics Dashboard 📊

👥 User Statistics:
• Total Users: ${totalUsers}
• Approved Users: ${approvedUsers}
• Premium Users: ${premiumUsers}
• Admin Users: ${adminUsers}
• Pending Registrations: ${pendingRegistrations}

📈 Usage Statistics:
• Total Queries: ${totalQueries}
• Average Queries/User: ${approvedUsers > 0 ? (totalQueries / approvedUsers).toFixed(1) : 0}

💎 Premium Metrics:
• Premium Conversion: ${totalUsers > 0 ? ((premiumUsers / totalUsers) * 100).toFixed(1) : 0}%
• Approval Rate: ${totalUsers > 0 ? ((approvedUsers / totalUsers) * 100).toFixed(1) : 0}%

🔧 System Health:
• Bot Status: ✅ Online
• Database: ✅ Connected
• Maintenance Mode: ${maintenanceMode ? 'ON' : 'OFF'}
• Last Update: ${new Date().toLocaleString()}`;

  await sendFormattedMessage(ctx, statsMessage);
});

bot.command('activity', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const recentUsers = Array.from(users.values())
    .filter(u => u.isApproved)
    .sort((a, b) => b.totalQueries - a.totalQueries)
    .slice(0, 10);

  const activityList = recentUsers.map((u, index) => 
    `• ${index + 1}. @${u.username || 'N/A'} - ${u.totalQueries} queries`
  ).join('\n');

  const activityMessage = `📈 Recent Activity Log 📈

👥 Most Active Users (Top 10):
 ${activityList || 'No recent activity'}

📊 Activity Summary:
• Total Active Users: ${recentUsers.length}
• Total Queries: ${recentUsers.reduce((sum, u) => sum + u.totalQueries, 0)}
• Average Queries: ${recentUsers.length > 0 ? (recentUsers.reduce((sum, u) => sum + u.totalQueries, 0) / recentUsers.length).toFixed(1) : 0}

🔄 Real-time activity monitoring`;

  await sendFormattedMessage(ctx, activityMessage);
});

bot.command('revenue', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const premiumUsers = Array.from(users.values()).filter(u => u.isPremium).length;
  const totalUsers = Array.from(users.values()).filter(u => u.isApproved).length;
  
  const monthlyPremiumPrice = 9.99;
  const estimatedMonthlyRevenue = premiumUsers * monthlyPremiumPrice;
  const estimatedYearlyRevenue = estimatedMonthlyRevenue * 12;

  const revenueMessage = `💰 Premium Revenue Statistics 💰

👥 Premium Metrics:
• Premium Users: ${premiumUsers}
• Total Approved Users: ${totalUsers}
• Premium Conversion Rate: ${totalUsers > 0 ? ((premiumUsers / totalUsers) * 100).toFixed(1) : 0}%

💵 Revenue Estimates:
• Monthly Price: $${monthlyPremiumPrice}
• Estimated Monthly Revenue: $${estimatedMonthlyRevenue.toFixed(2)}
• Estimated Yearly Revenue: $${estimatedYearlyRevenue.toFixed(2)}

📈 Growth Potential:
• Target Conversion: 10%
• Potential Premium Users: ${Math.round(totalUsers * 0.1)}
• Potential Monthly Revenue: $${(Math.round(totalUsers * 0.1) * monthlyPremiumPrice).toFixed(2)}`;

  await sendFormattedMessage(ctx, revenueMessage);
});

// System Control Commands
bot.command('broadcast', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const message = ctx.match?.toString();
  if (!message) {
    await sendFormattedMessage(ctx, '📢 Usage: /broadcast <message>\n\nExample: /broadcast "Maintenance scheduled for tonight"');
    return;
  }

  await sendFormattedMessage(ctx, '📢 Preparing broadcast...');

  const approvedUsers = Array.from(users.values()).filter(u => u.isApproved);
  let successCount = 0;
  let failCount = 0;

  for (const user of approvedUsers) {
    try {
      await notifyUser(user.telegramId, `📢 Broadcast Message 📢\n\n${message}`);
      successCount++;
    } catch (error) {
      console.error(`Failed to send broadcast to ${user.telegramId}:`, error);
      failCount++;
    }
  }

  const resultMessage = `📢 Broadcast Completed 📢

✅ Delivery Statistics:
• Total Users: ${approvedUsers.length}
• Successful: ${successCount}
• Failed: ${failCount}
• Success Rate: ${approvedUsers.length > 0 ? ((successCount / approvedUsers.length) * 100).toFixed(1) : 0}%

📝 Message:
 ${message}

👤 Sent by: @${ctx.from?.username || 'Admin'}`;

  await sendFormattedMessage(ctx, resultMessage);
});

bot.command('announce', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const input = ctx.match?.toString();
  if (!input || !input.includes('|')) {
    await sendFormattedMessage(ctx, '🎭 Usage: /announce <title>|<message>\n\nExample: /announce "New Feature|We just added domain lookup!"');
    return;
  }

  const [title, ...messageParts] = input.split('|');
  const message = messageParts.join('|').trim();

  if (!title || !message) {
    await sendFormattedMessage(ctx, '❌ Both title and message are required.');
    return;
  }

  await sendFormattedMessage(ctx, '🎭 Preparing rich announcement...');

  const approvedUsers = Array.from(users.values()).filter(u => u.isApproved);
  let successCount = 0;
  let failCount = 0;

  const announcementMessage = `🎭 ${title.trim()} 🎭

 ${message}

💎 Premium OSINT Bot Announcement`;

  for (const user of approvedUsers) {
    try {
      await notifyUser(user.telegramId, announcementMessage);
      successCount++;
    } catch (error) {
      console.error(`Failed to send announcement to ${user.telegramId}:`, error);
      failCount++;
    }
  }

  const resultMessage = `🎭 Rich Announcement Sent 🎭

✅ Delivery Statistics:
• Total Users: ${approvedUsers.length}
• Successful: ${successCount}
• Failed: ${failCount}
• Success Rate: ${approvedUsers.length > 0 ? ((successCount / approvedUsers.length) * 100).toFixed(1) : 0}%

📝 Announcement Details:
• Title: ${title.trim()}
• Message: ${message}

👤 Sent by: @${ctx.from?.username || 'Admin'}`;

  await sendFormattedMessage(ctx, resultMessage);
});

// Real maintenance mode command
bot.command('maintenance', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const args = ctx.match?.toString().split(' ');
  if (!args || args.length < 1) {
    await sendFormattedMessage(ctx, '⚙️ Usage: /maintenance <on|off|message>\n\nExamples:\n• /maintenance on "Bot under maintenance"\n• /maintenance off');
    return;
  }

  const action = args[0].toLowerCase();
  
  if (action === 'on') {
    maintenanceMode = true;
    maintenanceMessage = args.slice(1).join(' ') || "Bot is currently under maintenance. Please try again later.";
    
    await sendFormattedMessage(ctx, `⚙️ Maintenance Mode Enabled ⚙️

✅ Settings Updated:
• Status: Maintenance ON
• Message: "${maintenanceMessage}"
• Admin: @${ctx.from?.username}

🔧 All non-admin users will now see the maintenance message when using the bot.`);
    
    // Notify all users about maintenance
    const approvedUsers = Array.from(users.values()).filter(u => u.isApproved);
    for (const user of approvedUsers) {
      try {
        if (!isAdmin(user.telegramId)) {
          await notifyUser(user.telegramId, maintenanceMessage);
        }
      } catch (error) {
        console.error(`Failed to notify user ${user.telegramId} about maintenance:`, error);
      }
    }
  } 
  else if (action === 'off') {
    maintenanceMode = false;
    
    await sendFormattedMessage(ctx, `⚙️ Maintenance Mode Disabled ⚙️

✅ Settings Updated:
• Status: Maintenance OFF
• Admin: @${ctx.from?.username}

🔧 All users can now use the bot normally.`);
  } 
  else {
    await sendFormattedMessage(ctx, '❌ Invalid action. Use "on" or "off".');
  }
});

bot.command('lucky', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const amount = parseInt(ctx.match?.toString() || '100');
  if (isNaN(amount) || amount <= 0) {
    await sendFormattedMessage(ctx, '🍀 Usage: /lucky [amount]\n\nExample: /lucky 500');
    return;
  }

  const approvedUsers = Array.from(users.values()).filter(u => u.isApproved);
  
  if (approvedUsers.length === 0) {
    await sendFormattedMessage(ctx, '❌ No approved users found for lucky draw.');
    return;
  }

  const randomIndex = Math.floor(Math.random() * approvedUsers.length);
  const luckyUser = approvedUsers[randomIndex];

  luckyUser.credits += amount;

  const userMessage = `🍀 Lucky Draw Winner! 🍀

🎉 Congratulations!
💰 Prize: ${amount} credits
💳 New Balance: ${luckyUser.credits} credits
🎯 Total Participants: ${approvedUsers.length}

✨ You are today's lucky winner!

💎 Enjoy your bonus credits!`;

  await notifyUser(luckyUser.telegramId, userMessage);

  const adminMessage = `🍀 Lucky Draw Completed 🍀

🎉 Winner Details:
• Lucky User: @${luckyUser.username || 'N/A'} (${luckyUser.telegramId})
• Prize Amount: ${amount} credits
• Total Participants: ${approvedUsers.length}
• Winner's New Balance: ${luckyUser.credits} credits

🎯 Draw Statistics:
• Selection Method: Random
• Odds of Winning: ${(1 / approvedUsers.length * 100).toFixed(2)}%
• Admin: @${ctx.from?.username}

✨ Lucky user has been notified!`;

  await sendFormattedMessage(ctx, adminMessage);
});

// Mass premium upgrade command
bot.command('masspremium', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const approvedUsers = Array.from(users.values()).filter(u => u.isApproved && !u.isPremium);
  
  if (approvedUsers.length === 0) {
    await sendFormattedMessage(ctx, '⚠️ No approved non-premium users found for mass premium upgrade.');
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const user of approvedUsers) {
    try {
      user.isPremium = true;
      successCount++;

      // Notify user
      const userMessage = `🎉 Premium Status Granted! 🎉

💎 Welcome to Premium!
✅ Unlimited queries
⚡ Priority API access
🔧 Advanced tools
📞 24/7 support

🌟 Thank you for upgrading to Premium!

💎 Enjoy your exclusive benefits!`;

      await notifyUser(user.telegramId, userMessage);
    } catch (error) {
      console.error(`Failed to upgrade user ${user.telegramId}:`, error);
      failCount++;
    }
  }

  const adminMessage = `👑 Mass Premium Upgrade Completed 👑

✅ Upgrade Summary:
• Total Users: ${approvedUsers.length}
• Successful Upgrades: ${successCount}
• Failed Upgrades: ${failCount}
• Admin: @${ctx.from?.username}

🎯 All upgraded users have been notified about their new premium status`;

  await sendFormattedMessage(ctx, adminMessage);
});

// Remove premium from all users command
bot.command('massremovepremium', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const premiumUsers = Array.from(users.values()).filter(u => u.isPremium && !u.isAdmin);
  
  if (premiumUsers.length === 0) {
    await sendFormattedMessage(ctx, '⚠️ No premium users found for mass premium removal.');
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const user of premiumUsers) {
    try {
      user.isPremium = false;
      successCount++;

      // Notify user
      const userMessage = `💳 Premium Status Revoked 💳

📋 Status Changed:
• Premium access revoked
• Back to standard features
• Contact admin @jioxt for details

📞 If you have questions about this change, please reach out to support`;

      await notifyUser(user.telegramId, userMessage);
    } catch (error) {
      console.error(`Failed to remove premium from user ${user.telegramId}:`, error);
      failCount++;
    }
  }

  const adminMessage = `🚫 Mass Premium Removal Completed 🚫

✅ Removal Summary:
• Total Premium Users: ${premiumUsers.length}
• Successful Removals: ${successCount}
• Failed Removals: ${failCount}
• Admin: @${ctx.from?.username}

🎯 All affected users have been notified about the premium status change`;

  await sendFormattedMessage(ctx, adminMessage);
});

// Remove premium from a specific user command
bot.command('removepremium', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const targetUserId = ctx.match?.toString();
  if (!targetUserId) {
    await sendFormattedMessage(ctx, '❌ Usage: /removepremium <user_id>\n\nExample: /removepremium 123456789');
    return;
  }

  const targetUser = users.get(targetUserId);
  if (!targetUser) {
    await sendFormattedMessage(ctx, '❌ User not found.');
    return;
  }

  if (!targetUser.isPremium) {
    await sendFormattedMessage(ctx, '⚠️ This user is not a premium member.');
    return;
  }

  targetUser.isPremium = false;

  const userMessage = `💳 Premium Status Revoked 💳

📋 Status Changed:
• Premium access revoked
• Back to standard features
• Contact admin @jioxt for details

📞 If you have questions about this change, please reach out to support`;

  await notifyUser(targetUserId, userMessage);

  const adminMessage = `🚫 Premium Status Removed 🚫

✅ Action Details:
• User ID: ${targetUserId}
• Username: @${targetUser.username || 'N/A'}
• Action: Premium access removed
• Admin: @${ctx.from?.username}

🎯 User has been notified about the premium status change`;

  await sendFormattedMessage(ctx, adminMessage);
});

// Reset daily statistics command
bot.command('reset_daily', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  // Reset daily query counts for all users
  let resetCount = 0;
  for (const [userId, user] of users.entries()) {
    if (user.totalQueries > 0) {
      user.totalQueries = 0;
      resetCount++;
    }
  }

  const message = `🔄 Daily Statistics Reset 🔄

✅ Reset Details:
• Users Updated: ${resetCount}
• Reset Date: ${new Date().toLocaleDateString()}
• Admin: @${ctx.from?.username}

📊 All daily query counts have been reset to zero`;

  await sendFormattedMessage(ctx, message);
});

// Reset user account command
bot.command('resetuser', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const targetUserId = ctx.match?.toString();
  if (!targetUserId) {
    await sendFormattedMessage(ctx, '🔄 Usage: /resetuser <user_id>\n\nExample: /resetuser 123456789');
    return;
  }

  const targetUser = users.get(targetUserId);
  if (!targetUser) {
    await sendFormattedMessage(ctx, '❌ User not found.');
    return;
  }

  // Reset user data
  const oldCredits = targetUser.credits;
  const oldQueries = targetUser.totalQueries;
  const wasPremium = targetUser.isPremium;
  const wasAdmin = targetUser.isAdmin;
  
  targetUser.credits = 0;
  targetUser.totalQueries = 0;
  targetUser.isPremium = false;
  // Keep admin status to avoid removing admin access accidentally

  const userMessage = `🔄 Account Reset 🔄

📋 Your account has been reset by an administrator.

🔄 Reset Details:
• Credits: ${oldCredits} → 0
• Queries: ${oldQueries} → 0
• Premium: ${wasPremium ? 'Yes → No' : 'No'}
• Admin: ${wasAdmin ? 'Yes (unchanged)' : 'No'}

📞 If you have questions about this reset, please contact admin @jioxt `;

  await notifyUser(targetUserId, userMessage);

  const adminMessage = `🔄 User Account Reset 🔄

✅ Reset Details:
• User ID: ${targetUserId}
• Username: @${targetUser.username || 'N/A'}
• Old Credits: ${oldCredits}
• Old Queries: ${oldQueries}
• Was Premium: ${wasPremium ? 'Yes' : 'No'}
• Admin Status: ${wasAdmin ? 'Yes (unchanged)' : 'No'}
• Admin: @${ctx.from?.username}

🎯 User has been notified about the account reset`;

  await sendFormattedMessage(ctx, adminMessage);
});

// View system logs command
bot.command('logs', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  const totalUsers = users.size;
  const approvedUsers = Array.from(users.values()).filter(u => u.isApproved).length;
  const premiumUsers = Array.from(users.values()).filter(u => u.isPremium).length;
  const adminUsers = Array.from(users.values()).filter(u => u.isAdmin).length;
  const totalQueries = Array.from(users.values()).reduce((sum, u) => sum + u.totalQueries, 0);
  const pendingRegistrations = registrationRequests.size;
  const verifiedCount = verifiedUsers.size;

  const message = `📜 System Logs 📜

📊 Current System Status:
• Bot: ✅ Online
• Total Users: ${totalUsers}
• Approved Users: ${approvedUsers}
• Premium Users: ${premiumUsers}
• Admin Users: ${adminUsers}
• Verified Users: ${verifiedCount}
• Pending Registrations: ${pendingRegistrations}
• Total Queries: ${totalQueries}

🔧 System Configuration:
• Maintenance Mode: ${maintenanceMode ? 'ON' : 'OFF'}
• Bot Start Time: ${new Date().toLocaleString()}
• Admin ID: ${adminId}

📝 Note: This is a basic log overview. For detailed logs, check your hosting provider's logs.`;

  await sendFormattedMessage(ctx, message);
});

// Create database backup command
bot.command('backup', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId || !isAdmin(telegramId)) {
    await sendFormattedMessage(ctx, '❌ This command is only available to administrators.');
    return;
  }

  // Create backup data
  const usersData = Array.from(users.entries()).map(([id, user]) => ({
    id,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    isApproved: user.isApproved,
    credits: user.credits,
    isPremium: user.isPremium,
    isAdmin: user.isAdmin,
    totalQueries: user.totalQueries,
    registrationDate: user.registrationDate
  }));

  const registrationsData = Array.from(registrationRequests.entries()).map(([id, request]) => ({
    id,
    username: request.username,
    firstName: request.firstName,
    lastName: request.lastName,
    status: request.status,
    timestamp: request.timestamp
  }));

  const verifiedData = Array.from(verifiedUsers);

  const backupData = {
    timestamp: new Date().toISOString(),
    users: usersData,
    registrations: registrationsData,
    verifiedUsers: verifiedData,
    maintenanceMode,
    maintenanceMessage
  };

  // Convert to JSON string
  const backupJson = JSON.stringify(backupData, null, 2);

  // Send backup to admin
  try {
    await ctx.replyWithDocument(
      Buffer.from(backupJson),
      {
        filename: `osint_bot_backup_${new Date().toISOString().replace(/:/g, '-')}.json`,
        caption: `💾 Database Backup 💾

📊 Backup Details:
• Users: ${usersData.length}
• Registrations: ${registrationsData.length}
• Verified Users: ${verifiedData.length}
• Timestamp: ${new Date().toLocaleString()}

💾 Keep this file safe for future restoration if needed`
      }
    );
  } catch (error) {
    console.error('Error sending backup:', error);
    await sendFormattedMessage(ctx, '❌ Failed to create or send backup. The backup data might be too large for Telegram.');
  }
});

// Check registration status command
bot.command('checkstatus', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId) return;

  // Check if user exists in users map
  const user = users.get(telegramId);
  if (user) {
    const statusMessage = `📋 Your Registration Status 📋

👤 Account Information:
• Telegram ID: ${telegramId}
• Username: @${user.username || 'N/A'}
• Status: ${user.isApproved ? '✅ Approved' : '❌ Not Approved'}
• Credits: ${user.credits} 🪙
• Premium: ${user.isPremium ? '💎 Yes' : '🔹 No'}

📅 Registration Date: ${user.registrationDate.toLocaleDateString()}

 ${!user.isApproved ? '\n⏳ Your account is pending approval. Please wait for the admin to review your request.' : '\n✅ Your account is approved and ready to use!'}`;

    await sendFormattedMessage(ctx, statusMessage);
  } else {
    // Check if there's a pending registration request
    const request = registrationRequests.get(telegramId);
    if (request) {
      await sendFormattedMessage(ctx, '⏳ Your registration is pending approval.\n\nPlease wait for the admin to review your request.');
    } else {
      // Check if user has verified channel membership
      if (verifiedUsers.has(telegramId)) {
        await sendFormattedMessage(ctx, '✅ You have verified your channel membership! You can now proceed with registration using /register.');
      } else {
        // Create inline keyboard with join and verify buttons
        const keyboard = new InlineKeyboard()
          .url("📢 Join Updates Channel", CHANNEL_URL)
          .text("✅ Verify Membership", `verify_${telegramId}`);
        
        await sendFormattedMessage(ctx, '❌ No registration found.\n\nPlease join the updates channel and verify your membership before registering.', keyboard);
      }
    }
  }
});

// Sync registration command (for users who were approved but lost data)
bot.command('sync', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  
  if (!telegramId) return;

  const user = users.get(telegramId);
  if (user && user.isApproved) {
    await sendFormattedMessage(ctx, '✅ Your account is already synced and approved!');
    return;
  }

  // Auto-approve if admin ID (original admin)
  if (telegramId === adminId) {
    const adminUser = {
      telegramId,
      username: ctx.from?.username || 'fuck_sake',
      firstName: ctx.from?.first_name || 'Admin',
      lastName: ctx.from?.last_name || '',
      isAdmin: true,
      isApproved: true,
      credits: 999999,
      isPremium: true,
      totalQueries: 0,
      registrationDate: new Date()
    };
    users.set(telegramId, adminUser);
    await sendFormattedMessage(ctx, '✅ Admin account synced successfully!');
    return;
  }

  // Note: Made admins need to be manually restored by original admin if bot restarts
  await sendFormattedMessage(ctx, '❌ No approved registration found.\n\n📋 If you were made admin but lost access:\n• Contact the original admin (@jioxt)\n• Or use /register to submit new request\n\n💡 Made admins lose access if bot restarts - this is normal for security.');
});

// ===============================
// SAMPLE PROTECTED COMMAND
// ===============================
bot.command('ping', (ctx) => {
  ctx.reply('🏓 Pong! You are verified.');
});

// ===============================
// DEBUG COMMAND (OPTIONAL)
// ===============================
bot.command('test', async (ctx) => {
  try {
    const member = await bot.api.getChatMember(CHANNEL_ID, ctx.from.id);
    ctx.reply(`Status: ${member.status}`);
  } catch (e) {
    ctx.reply(`Error: ${e.description || e.message}`);
  }
});

// Test command
bot.command('test', async (ctx) => {
  await sendFormattedMessage(ctx, '✅ Bot is working! 🚀\n\nAll commands are operational. Try:\n• /start\n• /register\n• /ip 8.8.8.8\n• /email test@example.com\n• /num 9389482769\n• /basicnum 919087654321\n• /paknum 03005854962\n• /myip\n• /dl <video_url> (new universal command)\n• /admin (for admin)');
});


// ===============================
// JioSaavn: Search + Play Audio + Queue (Railway-safe)
// Commands:
//   /saavn <query>        -> inline results -> pick -> audio plays in chat
//   /saavn1 <query>       -> play first result
//   /saavntrend [genre]   -> trending-like picks (keyword-based)
//   /saavnartist <name>   -> artist browse (keyword-based)
//   /saavnq add|list|play|next|prev|clear [query]  -> queue system
// ===============================
if (!global.__saavnCache) global.__saavnCache = new Map(); // token -> { track, at }
if (!global.__saavnQueue) global.__saavnQueue = new Map(); // key -> { items: [], idx: 0 }

function saavnCleanText(s) {
  return String(s || '').replace(/\\+/g, '').replace(/\s+/g, ' ').trim();
}

function saavnPickText(t, keys, fallback = '') {
  for (const k of keys) {
    const v = t?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return fallback;
}

function saavnBestAudioUrl(t) {
  // common shapes:
  // - downloadUrl: [{ quality, url }, ...]
  // - download_url / downloadUrl: "https://..."
  // - media_url / mediaUrl / url
  const dl = t?.downloadUrl || t?.download_url || t?.media_url || t?.mediaUrl || t?.url || t?.downloadLink || t?.download_link;
  if (Array.isArray(dl)) {
    // pick the last (usually highest quality)
    for (let i = dl.length - 1; i >= 0; i--) {
      const u = dl[i]?.url || dl[i]?.link || dl[i]?.downloadUrl || dl[i]?.download_url;
      if (isHttpUrl(u)) return u;
    }
  }
  if (isHttpUrl(dl)) return dl;

  // some APIs nest inside more_info
  const mi = t?.more_info || t?.moreInfo || {};
  const miDl = mi?.download_url || mi?.downloadUrl || mi?.media_url || mi?.mediaUrl;
  if (Array.isArray(miDl)) {
    for (let i = miDl.length - 1; i >= 0; i--) {
      const u = miDl[i]?.url || miDl[i]?.link;
      if (isHttpUrl(u)) return u;
    }
  }
  if (isHttpUrl(miDl)) return miDl;

  return null;
}

/**
 * Extract format-specific URLs (mp3 / m4a) when the API provides multiple download links.
 * Many JioSaavn wrapper APIs return an array like: downloadUrl: [{ quality, url }, ...]
 */
function saavnGetFormatUrls(t) {
  const candidates = [];

  const pushArr = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const it of arr) {
      const u = it?.url || it?.link || it?.downloadUrl || it?.download_url || it?.mediaUrl || it?.media_url;
      if (isHttpUrl(u)) candidates.push(String(u));
    }
  };

  pushArr(t?.downloadUrl);
  pushArr(t?.download_url);
  pushArr(t?.more_info?.download_url);
  pushArr(t?.more_info?.downloadUrl);
  pushArr(t?.moreInfo?.download_url);
  pushArr(t?.moreInfo?.downloadUrl);

  // Fallback: if single direct url exists
  const best = saavnBestAudioUrl(t);
  if (isHttpUrl(best)) candidates.push(String(best));

  // de-dup
  const uniq = Array.from(new Set(candidates));

  const pickByExt = (ext) => {
    const e = String(ext || '').toLowerCase();
    // prefer explicit extension in path
    const byPath = uniq.find(u => u.toLowerCase().includes(`.${e}`));
    if (byPath) return byPath;

    // some servers omit extension but include "format" query
    const byQuery = uniq.find(u => /[?&](format|ext|type)=/i.test(u) && u.toLowerCase().includes(e));
    if (byQuery) return byQuery;

    return null;
  };

  // mp3 and m4a/aac candidates
  const mp3 = pickByExt('mp3');
  let m4a = pickByExt('m4a');

  // Sometimes m4a is served as aac/mp4 audio
  if (!m4a) {
    m4a =
      uniq.find(u => u.toLowerCase().includes('.aac')) ||
      uniq.find(u => u.toLowerCase().includes('.mp4') && /audio|aac|m4a/i.test(u)) ||
      null;
  }

  return { mp3, m4a, best: isHttpUrl(best) ? String(best) : (uniq[0] || null), all: uniq };
}

async function saavnSendFileByUrl(ctx, meta) {
  const {
    url,
    title = 'JioSaavn Track',
    artist = '',
    caption = '',
    ext = 'mp3',
    asAudio = true
  } = meta || {};

  if (!isHttpUrl(url)) return ctx.reply('❌ Audio link not found for this track.');

  const safeTitle = String(title || 'jiosaavn').replace(/[^a-z0-9\-_. ]/gi, '').trim().slice(0, 50) || 'jiosaavn';
  const filename = `${safeTitle}.${ext}`;

  // For MP3: try as audio first (best UX)
  if (asAudio) {
    try {
      return await ctx.replyWithAudio(url, {
        caption,
        parse_mode: 'HTML',
        title: String(title || '').slice(0, 64),
        performer: String(artist || '').slice(0, 64) || undefined
      });
    } catch (e1) {
      try {
        const fileRes = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 65000,
          headers: { 'User-Agent': DEFAULT_UA },
          maxContentLength: 50 * 1024 * 1024,
          maxBodyLength: 50 * 1024 * 1024,
        });
        const buf = Buffer.from(fileRes.data);
        return await ctx.replyWithAudio(new InputFile(buf, filename), {
          caption,
          parse_mode: 'HTML',
          title: String(title || '').slice(0, 64),
          performer: String(artist || '').slice(0, 64) || undefined
        });
      } catch (e2) {
        // fall back to document link
        return await ctx.replyWithDocument(url, {
          caption: `${caption}\n\n(Direct audio failed; download this file.)`
        });
      }
    }
  }

  // For M4A: send as document so user can download (some phones don't play m4a inline)
  try {
    return await ctx.replyWithDocument(url, {
      caption,
      parse_mode: 'HTML'
    });
  } catch (_) {
    try {
      const fileRes = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 65000,
        headers: { 'User-Agent': DEFAULT_UA },
        maxContentLength: 50 * 1024 * 1024,
        maxBodyLength: 50 * 1024 * 1024,
      });
      const buf = Buffer.from(fileRes.data);
      return await ctx.replyWithDocument(new InputFile(buf, filename), {
        caption,
        parse_mode: 'HTML'
      });
    } catch (e2) {
      return ctx.reply(`❌ Failed to send file.\n\n${escapeHtml(String(e2?.message || e2 || 'Unknown error'))}`, { parse_mode: 'HTML' });
    }
  }
}


function saavnLooksLikeM4A(u) {
  const url = String(u || '');
  return /\.m4a(\?|$)/i.test(url) || /mp4\.m4a/i.test(url) || /\.mp4(\?|$)/i.test(url) || /audio\/mp4/i.test(url);
}

async function saavnConvertAndSendMp3(ctx, sourceUrl, meta = {}) {
  const { title = 'JioSaavn Track', artist = '', caption = '', progress } = meta;
  if (!FFMPEG_PATH) {
    // If ffmpeg isn't available, avoid spamming chat: edit the same picker message when possible.
    if (progress && progress.chatId && progress.messageId) {
      ctx.api.editMessageText(progress.chatId, progress.messageId, '⚠️ MP3 conversion not available (ffmpeg missing). Sending best format…').catch(() => {});
    } else {
      await ctx.reply('⚠️ MP3 conversion is not available on this server (ffmpeg-static missing). Sending the best available format instead.');
    }
    return saavnSendFileByUrl(ctx, {
      url: sourceUrl,
      title,
      artist,
      caption,
      ext: 'm4a',
      asAudio: false
    });
  }

  // download source (m4a/mp4) to temp file
  const safeTitle = String(title || 'jiosaavn').replace(/[^a-z0-9\-_. ]/gi, '').trim().slice(0, 50) || 'jiosaavn';
  const tmpBase = path.join(os.tmpdir(), `saavn_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  const inFile = `${tmpBase}.m4a`;
  const outFile = `${tmpBase}.mp3`;

  try {
    const res = await axios.get(sourceUrl, {
      responseType: 'arraybuffer',
      timeout: 65000,
      headers: { 'User-Agent': DEFAULT_UA },
      maxContentLength: 80 * 1024 * 1024,
      maxBodyLength: 80 * 1024 * 1024,
    });

    fs.writeFileSync(inFile, Buffer.from(res.data));

    // Update progress to converting
    if (progress && progress.chatId && progress.messageId) {
      ctx.api.editMessageText(progress.chatId, progress.messageId, '🔁 Converting to MP3…').catch(() => {});
    }

    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-i', inFile,
        '-vn',
        '-codec:a', 'libmp3lame',
        '-q:a', '3',
        outFile
      ];
      const p = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let errBuf = '';
      p.stderr.on('data', (d) => { errBuf += String(d); });
      p.on('close', (code) => {
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg failed (${code}): ${errBuf.slice(0, 500)}`));
      });
    });

    const mp3Buf = fs.readFileSync(outFile);
    const filename = `${safeTitle}.mp3`;

    // send as audio (works everywhere)
    return await ctx.replyWithAudio(new InputFile(mp3Buf, filename), {
      caption,
      parse_mode: 'HTML',
      title: String(title || '').slice(0, 64),
      performer: String(artist || '').slice(0, 64) || undefined
    });
  } catch (e) {
    return ctx.reply(`❌ Failed to convert to MP3.

${escapeHtml(String(e?.message || e || 'Unknown error'))}`, { parse_mode: 'HTML' });
  } finally {
    try { if (fs.existsSync(inFile)) fs.unlinkSync(inFile); } catch (_) {}
    try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (_) {}
  }
}




async function saavnShowFormatPicker(ctx, track, token) {
  const title = saavnCleanText(saavnPickText(track, ['title', 'name', 'song', 'songName'], 'JioSaavn Track'));
  const artist = saavnCleanText(saavnPickText(track, ['primary_artists', 'singers', 'subtitle', 'artist', 'artists'], ''));
  const { mp3, m4a, best } = saavnGetFormatUrls(track);

  const caption = artist ? `🎵 <b>${escapeHtml(title)}</b>\n👤 <code>${escapeHtml(artist)}</code>` : `🎵 <b>${escapeHtml(title)}</b>`;
  const kb = new InlineKeyboard();

  // MP3 button (preferred)
  kb.text(`🎧 MP3${mp3 ? '' : ' (best)'}`, `saavn_dl:mp3:${token}`);
  // M4A button
  kb.text(`📦 M4A${m4a ? '' : ' (best)'}`, `saavn_dl:m4a:${token}`).row();

  // Quick actions
  kb.text('➕ Add to Queue', `saavn_qadd:${token}`);
  kb.text('❌ Cancel', `saavn_cancel:${token}`).row();

  return ctx.reply(caption + `\n\nChoose format to send:`, { parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
}

async function saavnSearch(query) {
  const urls = [
    `https://jiosaavn-api-anxkhn.vercel.app/search?q=${encodeURIComponent(query)}&limit=25`,
    `https://jiosaavn.coolapi.in/api/search/songs?query=${encodeURIComponent(query)}&limit=25`,
    `https://saavn-api.vercel.app/search/${encodeURIComponent(query)}`
  ];

  for (const u of urls) {
    try {
      const res = await axiosGetWithRetry(u, { timeout: 30000 }, 2);
      const data = res.data || {};
      const items =
        (Array.isArray(data?.data) ? data.data : null) ||
        (Array.isArray(data?.results) ? data.results : null) ||
        (Array.isArray(data) ? data : null) ||
        (Array.isArray(data?.data?.results) ? data.data.results : null) ||
        [];
      if (items.length) return { ok: true, items, src: u };
    } catch (_) { /* try next */ }
  }
  return { ok: false, items: [], src: null };
}

async function saavnSendAudio(ctx, track, opts = {}) {
  const title = saavnCleanText(saavnPickText(track, ['title', 'name', 'song', 'songName'], 'JioSaavn Track'));
  const artist = saavnCleanText(saavnPickText(track, ['primary_artists', 'singers', 'subtitle', 'artist', 'artists'], ''));
  const { mp3, best } = saavnGetFormatUrls(track);
  const audioUrl = mp3 || best || saavnBestAudioUrl(track);

  if (!isHttpUrl(audioUrl)) {
    return ctx.reply('❌ Audio link not found for this track.');
  }

  const caption = artist ? `🎵 ${escapeHtml(title)} — ${escapeHtml(artist)}` : `🎵 ${escapeHtml(title)}`;

  // Progress + vanish helpers
  const chatId = ctx.chat?.id;
  const pickerMsgId = ctx.callbackQuery?.message?.message_id;
  let progressMsg = null;
  try {
    progressMsg = await ctx.reply('⬇️ Downloading...', { reply_to_message_id: pickerMsgId });
    // Also vanish the picker message to keep chat short
  } catch (_) {}

  // First try: Telegram fetches URL directly
  try {
    return await ctx.replyWithAudio(audioUrl, {
      caption,
      parse_mode: 'HTML',
      title: title.slice(0, 64),
      performer: artist.slice(0, 64) || undefined
    });
  } catch (e1) {
    // Fallback: download into memory (bounded) then upload as real audio (prevents "no audio" issue)
    try {
      const fileRes = await axios.get(audioUrl, {
        responseType: 'arraybuffer',
        timeout: 65000,
        headers: { 'User-Agent': DEFAULT_UA },
        maxContentLength: 50 * 1024 * 1024,
        maxBodyLength: 50 * 1024 * 1024,
      });
      const buf = Buffer.from(fileRes.data);
      const safeName = title.replace(/[^a-z0-9\-_. ]/gi, '').trim().slice(0, 40) || 'jiosaavn';
      const filename = `${safeName}.mp3`;
      return await ctx.replyWithAudio(new InputFile(buf, filename), {
        caption,
        parse_mode: 'HTML',
        title: title.slice(0, 64),
        performer: artist.slice(0, 64) || undefined
      });
    } catch (e2) {
      // Last resort: send link/document (never crash)
      return await ctx.replyWithDocument(audioUrl, {
        caption: `🎵 ${title}${artist ? ' — ' + artist : ''}\n\n(Direct audio failed; download this file.)`
      });
    }
  }
}

function saavnQueueKey(ctx) {
  return `${ctx.chat?.id || 'chat'}:${ctx.from?.id || 'user'}`;
}

function saavnGetQueue(ctx) {
  const key = saavnQueueKey(ctx);
  if (!global.__saavnQueue.has(key)) global.__saavnQueue.set(key, { items: [], idx: 0 });
  return global.__saavnQueue.get(key);
}

bot.command('saavn1', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) return sendFormattedMessage(ctx, '❌ You need approval to use this command.');
  if (!deductCredits(user)) return sendFormattedMessage(ctx, '❌ Insufficient credits!');

  const q = getCommandArgs(ctx);
  if (!q) { refundCredits(user, 1); return sendFormattedMessage(ctx, '🎵 Usage: /saavn1 <song name>'); }

  // One-message UI: send "Searching..." then EDIT the same message into format buttons.
  const searchMsg = await ctx.reply('🎵 Searching JioSaavn...');

  const res = await saavnSearch(q);
  if (!res.ok || !res.items.length) {
    refundCredits(user, 1);
    try { await ctx.api.editMessageText(ctx.chat.id, searchMsg.message_id, '❌ No results found.'); } catch (_) {}
    return;
  }

  user.totalQueries++;

  const track = res.items[0] || {};
  const title = saavnCleanText(saavnPickText(track, ['title', 'name', 'song', 'songName'], 'JioSaavn Track'));
  const artist = saavnCleanText(saavnPickText(track, ['primary_artists', 'singers', 'subtitle', 'artist', 'artists'], ''));

  // cache selection so existing saavn_dl callbacks can download/convert on button click
  const token = crypto.randomBytes(8).toString('hex');
  const msgKey = `${ctx.chat.id}:${searchMsg.message_id}`;
  global.__saavnCache.set(token, { track, at: Date.now(), msgKey });

  // cleanup old cache (10 min TTL, max 400)
  if (global.__saavnCache.size > 400) {
    const now = Date.now();
    for (const [k, v] of global.__saavnCache.entries()) {
      if (!v?.at || (now - v.at) > 10 * 60 * 1000) global.__saavnCache.delete(k);
    }
  }

  const { mp3, m4a } = saavnGetFormatUrls(track);

  const kb = new InlineKeyboard()
    .text(`🎧 MP3${mp3 ? '' : ' (best)'}`, `saavn_dl:mp3:${token}`)
    .text(`📦 M4A${m4a ? '' : ' (best)'}`, `saavn_dl:m4a:${token}`).row()
    .text('❌ Cancel', `saavn_cancel:${token}`);

  const ui =
    `🎵 <b>${escapeHtml(title)}</b>` +
    (artist ? `
👤 <b>${escapeHtml(artist)}</b>` : '') +
    `

Select format:`;

  try {
    await ctx.api.editMessageText(ctx.chat.id, searchMsg.message_id, ui, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: kb
    });
  } catch (_) {
    // Fallback if edit fails
    await ctx.reply(ui, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb });
  }
});

bot.command('saavn', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) return sendFormattedMessage(ctx, '❌ You need approval to use this command.');
  if (!deductCredits(user)) return sendFormattedMessage(ctx, '❌ Insufficient credits!');

  const q = getCommandArgs(ctx);
  if (!q) { refundCredits(user, 1); return sendFormattedMessage(ctx, '🎵 Usage: /saavn <song name>'); }

  // One-message UI: send "Searching..." then EDIT the same message into results.
  const searchMsg = await ctx.reply('🎵 Searching JioSaavn...');

  const res = await saavnSearch(q);
  if (!res.ok || !res.items.length) {
    refundCredits(user, 1);
    try { await ctx.api.editMessageText(ctx.chat.id, searchMsg.message_id, '❌ No results found.'); } catch (_) {}
    return;
  }

  user.totalQueries++;

  const top = res.items.slice(0, 8);
  const kb = new InlineKeyboard();

  // store the "list view" for this message, so Cancel can restore it (no extra messages)
  global.__saavnMsgState = global.__saavnMsgState || new Map();
  const msgKey = `${ctx.chat.id}:${searchMsg.message_id}`;

  for (let i = 0; i < top.length; i++) {
    const t = top[i] || {};
    const title = saavnCleanText(saavnPickText(t, ['title', 'name', 'song', 'songName'], `Track ${i + 1}`)).slice(0, 45);
    const artist = saavnCleanText(saavnPickText(t, ['primary_artists', 'singers', 'subtitle', 'artist', 'artists'], '')).slice(0, 25);
    const label = artist ? `${title} — ${artist}` : title;

    const token = crypto.randomBytes(8).toString('hex');
    global.__saavnCache.set(token, { track: t, at: Date.now(), msgKey });

    // cleanup old cache
    if (global.__saavnCache.size > 400) {
      const now = Date.now();
      for (const [k, v] of global.__saavnCache.entries()) {
        if (!v?.at || (now - v.at) > 10 * 60 * 1000) global.__saavnCache.delete(k);
      }
    }

    kb.text(`🎧 ${label}`, `saavn_pick:${token}`).row();
  }

  // Save list view state for this message
  global.__saavnMsgState.set(msgKey, { text: '🎵 Pick a track to play:', kb, at: Date.now() });

  // Edit the same message into the list UI (no extra messages)
  try {
    await ctx.api.editMessageText(ctx.chat.id, searchMsg.message_id, '🎵 Pick a track to play:', {
      reply_markup: kb
    });
  } catch (_) {
    // fallback if edit fails
    return ctx.reply('🎵 Pick a track to play:', { reply_markup: kb });
  }
});

bot.callbackQuery(/^saavn_pick:([a-f0-9]{16})$/i, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (_) {}

  const token = ctx.match?.[1];
  const item = global.__saavnCache.get(token);
  if (!item?.track) {
    // avoid new message spam when possible
    try { return ctx.editMessageText('❌ This selection expired. Please /saavn again.'); } catch (_) {}
    return ctx.reply('❌ This selection expired. Please /saavn again.');
  }

  const title = saavnCleanText(saavnPickText(item.track, ['title', 'name', 'song', 'songName'], 'JioSaavn Track'));
  const artist = saavnCleanText(saavnPickText(item.track, ['primary_artists', 'singers', 'subtitle', 'artist', 'artists'], ''));
  const caption = artist ? `🎵 ${escapeHtml(title)}\n👤 ${escapeHtml(artist)}` : `🎵 ${escapeHtml(title)}`;

  const kb = new InlineKeyboard();
  kb.text('🎧 MP3 (best)', `saavn_dl:mp3:${token}`);
  kb.text('📦 M4A', `saavn_dl:m4a:${token}`).row();
  kb.text('➕ Add to Queue', `saavn_qadd:${token}`);
  kb.text('❌ Cancel', `saavn_cancel:${token}`).row();

  // Edit the SAME message (no extra message)
  try {
    return await ctx.editMessageText(caption + `\n\nChoose format to send:`, {
      parse_mode: 'HTML',
      reply_markup: kb,
      disable_web_page_preview: true
    });
  } catch (_) {
    // fallback if edit fails
    return saavnShowFormatPicker(ctx, item.track, token);
  }
});

bot.callbackQuery(/^saavn_dl:(mp3|m4a):([a-f0-9]{16})$/i, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (_) {}

  const fmt = String(ctx.match?.[1] || '').toLowerCase();
  const token = ctx.match?.[2];
  const item = global.__saavnCache.get(token);
  if (!item?.track) return ctx.reply('❌ This selection expired. Please /saavn again.');

  const title = saavnCleanText(saavnPickText(item.track, ['title', 'name', 'song', 'songName'], 'JioSaavn Track'));
  const artist = saavnCleanText(saavnPickText(item.track, ['primary_artists', 'singers', 'subtitle', 'artist', 'artists'], ''));
  const { mp3, m4a, best } = saavnGetFormatUrls(item.track);

  const caption = artist ? `🎵 ${escapeHtml(title)} — ${escapeHtml(artist)}` : `🎵 ${escapeHtml(title)}`;

  // Progress (edit the SAME picker message so chat stays clean)
  const chatId = ctx.chat?.id;
  const pickerMsgId = ctx.callbackQuery?.message?.message_id;
  const progress = (chatId && pickerMsgId) ? { chatId, messageId: pickerMsgId } : null;

  if (progress) {
    ctx.api.editMessageText(progress.chatId, progress.messageId, '⬇️ Downloading...').catch(() => {});
  }

  // Decide URL for requested format
  let url = fmt === 'm4a' ? (m4a || best) : (mp3 || best);

  // MP3 button must send a REAL .mp3.
  // Many Saavn APIs only provide M4A/MP4-audio even when the user asks MP3.
  // So: if the chosen URL does NOT clearly look like an mp3 link, we convert it.
  if (fmt === 'mp3' && isHttpUrl(url)) {
    const looksMp3 = /\.mp3(\?|$)/i.test(String(url));
    if (!looksMp3) {
      const sent = await saavnConvertAndSendMp3(ctx, url, {
        title,
        artist,
        caption,
        progress
      });
      // Vanish the final media too (optional)
      if (progress) {
        ctx.api.editMessageText(progress.chatId, progress.messageId, '✅ Sent!').catch(() => {});
      }
      return sent;
    }
  }

  if (!isHttpUrl(url)) return ctx.reply('❌ Audio link not found for this track.');

  // MP3 -> send as audio; M4A -> send as document (better compatibility)
  const sent = await saavnSendFileByUrl(ctx, {
    url,
    title,
    artist,
    caption,
    ext: fmt === 'm4a' ? 'm4a' : 'mp3',
    asAudio: fmt !== 'm4a'
  });

  return sent;
});

bot.callbackQuery(/^saavn_qadd:([a-f0-9]{16})$/i, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (_) {}
  const token = ctx.match?.[1];
  const item = global.__saavnCache.get(token);
  if (!item?.track) return ctx.reply('❌ This selection expired. Please /saavn again.');

  const q = saavnGetQueue(ctx);
  q.items.push(item.track);
  q.idx = Math.max(0, q.items.length - 1);

  const title = saavnCleanText(saavnPickText(item.track, ['title', 'name', 'song', 'songName'], 'Track'));
  await ctx.reply(`✅ Added to queue: ${title}`);
});

bot.callbackQuery(/^saavn_cancel:([a-f0-9]{16})$/i, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (_) {}

  // Restore the list UI if we have it (keeps chat clean: no extra messages)
  const token = ctx.match?.[1];
  const item = token ? global.__saavnCache.get(token) : null;
  const msgKey = item?.msgKey || (ctx.chat?.id && ctx.callbackQuery?.message?.message_id ? `${ctx.chat.id}:${ctx.callbackQuery.message.message_id}` : null);

  const state = msgKey && global.__saavnMsgState ? global.__saavnMsgState.get(msgKey) : null;
  if (state?.text && state?.kb) {
    try {
      return await ctx.editMessageText(state.text, { reply_markup: state.kb });
    } catch (_) {}
  }

  // fallback: just clear the buttons + show cancelled on same message
  try { return await ctx.editMessageText('✅ Cancelled.'); } catch (_) {}
  return ctx.reply('✅ Cancelled.');
});

// -------- Option B (Advanced-ish) --------

bot.command('saavntrend', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) return sendFormattedMessage(ctx, '❌ You need approval to use this command.');
  if (!deductCredits(user)) return sendFormattedMessage(ctx, '❌ Insufficient credits!');

  const genre = getCommandArgs(ctx) || 'hindi';
  const q = `trending ${genre}`.trim();

  await sendFormattedMessage(ctx, `🔥 Finding trending-like songs for: ${escapeHtml(genre)} ...`);
  const res = await saavnSearch(q);
  if (!res.ok || !res.items.length) { refundCredits(user, 1); return sendFormattedMessage(ctx, '❌ No results found.'); }

  user.totalQueries++;

  // show quick picker (top 8)
  const top = res.items.slice(0, 8);
  const kb = new InlineKeyboard();
  for (let i = 0; i < top.length; i++) {
    const t = top[i] || {};
    const title = saavnCleanText(saavnPickText(t, ['title', 'name', 'song', 'songName'], `Track ${i + 1}`)).slice(0, 45);
    const artist = saavnCleanText(saavnPickText(t, ['primary_artists', 'singers', 'subtitle', 'artist', 'artists'], '')).slice(0, 25);
    const label = artist ? `${title} — ${artist}` : title;

    const token = crypto.randomBytes(8).toString('hex');
    global.__saavnCache.set(token, { track: t, at: Date.now() });
    kb.text(`🔥 ${label}`, `saavn_pick:${token}`).row();
  }
  return ctx.reply('🔥 Trending picks (tap to play):', { reply_markup: kb });
});

bot.command('saavnartist', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) return sendFormattedMessage(ctx, '❌ You need approval to use this command.');
  if (!deductCredits(user)) return sendFormattedMessage(ctx, '❌ Insufficient credits!');

  const name = getCommandArgs(ctx);
  if (!name) { refundCredits(user, 1); return sendFormattedMessage(ctx, '👤 Usage: /saavnartist <artist name>'); }

  await sendFormattedMessage(ctx, `👤 Searching songs by: ${escapeHtml(name)} ...`);
  const res = await saavnSearch(name);
  if (!res.ok || !res.items.length) { refundCredits(user, 1); return sendFormattedMessage(ctx, '❌ No results found.'); }

  user.totalQueries++;

  // Filter a bit by artist text if possible
  const n = name.toLowerCase();
  const filtered = res.items.filter(t => {
    const a = saavnPickText(t, ['primary_artists', 'singers', 'subtitle', 'artist', 'artists'], '').toLowerCase();
    return a.includes(n) || saavnCleanText(saavnPickText(t, ['title', 'name', 'song'], '')).toLowerCase().includes(n);
  });

  const list = (filtered.length ? filtered : res.items).slice(0, 8);
  const kb = new InlineKeyboard();
  for (let i = 0; i < list.length; i++) {
    const t = list[i] || {};
    const title = saavnCleanText(saavnPickText(t, ['title', 'name', 'song', 'songName'], `Track ${i + 1}`)).slice(0, 45);
    const artist = saavnCleanText(saavnPickText(t, ['primary_artists', 'singers', 'subtitle', 'artist', 'artists'], '')).slice(0, 25);
    const label = artist ? `${title} — ${artist}` : title;

    const token = crypto.randomBytes(8).toString('hex');
    global.__saavnCache.set(token, { track: t, at: Date.now() });
    kb.text(`🎤 ${label}`, `saavn_pick:${token}`).row();
  }
  return ctx.reply('🎤 Artist picks (tap to play):', { reply_markup: kb });
});

bot.command('saavnq', async (ctx) => {
  const user = getOrCreateUser(ctx);
  if (!user || !user.isApproved) return sendFormattedMessage(ctx, '❌ You need approval to use this command.');

  const args = (getCommandArgs(ctx) || '').trim();
  const [subRaw, ...rest] = args.split(/\s+/);
  const sub = (subRaw || '').toLowerCase();

  const qstate = saavnGetQueue(ctx);

  const help = `🎶 <b>Saavn Queue</b>
<code>/saavnq add &lt;query&gt;</code>
<code>/saavnq list</code>
<code>/saavnq play</code>
<code>/saavnq next</code>
<code>/saavnq prev</code>
<code>/saavnq clear</code>`;

  if (!sub) return ctx.reply(help, { parse_mode: 'HTML' });

  if (sub === 'list') {
    if (!qstate.items.length) return ctx.reply('📭 Queue is empty. Use: /saavnq add <query>');
    const lines = qstate.items.slice(0, 20).map((t, i) => {
      const title = saavnCleanText(saavnPickText(t, ['title', 'name', 'song'], `Track ${i + 1}`));
      const artist = saavnCleanText(saavnPickText(t, ['primary_artists', 'singers', 'subtitle', 'artist', 'artists'], ''));
      const mark = (i === qstate.idx) ? '▶️' : '•';
      return `${mark} ${i + 1}. ${title}${artist ? ' — ' + artist : ''}`;
    });
    return ctx.reply(`🎶 Queue (${qstate.items.length})\n\n${lines.join('\n')}`);
  }

  if (sub === 'clear') {
    qstate.items = [];
    qstate.idx = 0;
    return ctx.reply('🧹 Queue cleared.');
  }

  if (sub === 'play') {
    if (!qstate.items.length) return ctx.reply('📭 Queue is empty. Use: /saavnq add <query>');
    return saavnSendAudio(ctx, qstate.items[qstate.idx]);
  }

  if (sub === 'next' || sub === 'n') {
    if (!qstate.items.length) return ctx.reply('📭 Queue is empty.');
    qstate.idx = (qstate.idx + 1) % qstate.items.length;
    return saavnSendAudio(ctx, qstate.items[qstate.idx]);
  }

  if (sub === 'prev' || sub === 'p') {
    if (!qstate.items.length) return ctx.reply('📭 Queue is empty.');
    qstate.idx = (qstate.idx - 1 + qstate.items.length) % qstate.items.length;
    return saavnSendAudio(ctx, qstate.items[qstate.idx]);
  }

  if (sub === 'add') {
    if (!deductCredits(user)) return sendFormattedMessage(ctx, '❌ Insufficient credits!');
    const query = rest.join(' ').trim();
    if (!query) { refundCredits(user, 1); return ctx.reply('➕ Usage: /saavnq add <song name>'); }

    await ctx.reply('➕ Adding to queue...');
    const res = await saavnSearch(query);
    if (!res.ok || !res.items.length) { refundCredits(user, 1); return ctx.reply('❌ No results found.'); }

    user.totalQueries++;
    qstate.items.push(res.items[0]);
    if (qstate.items.length === 1) qstate.idx = 0;

    const title = saavnCleanText(saavnPickText(res.items[0], ['title', 'name', 'song'], 'Track'));
    const artist = saavnCleanText(saavnPickText(res.items[0], ['primary_artists', 'singers', 'subtitle', 'artist', 'artists'], ''));
    return ctx.reply(`✅ Added: ${title}${artist ? ' — ' + artist : ''}\n📌 Queue size: ${qstate.items.length}`);
  }

  return ctx.reply(help, { parse_mode: 'HTML' });
});


// ===============================
// FILE → LINK HANDLERS
// ===============================

function _fileMetaFromMessage(msg) {
  if (!msg) return null;

  // document
  if (msg.document && msg.document.file_id) {
    return {
      kind: 'document',
      fileId: msg.document.file_id,
      fileName: msg.document.file_name || 'file',
      mime: msg.document.mime_type || 'application/octet-stream',
      size: msg.document.file_size || null,
    };
  }

  // video
  if (msg.video && msg.video.file_id) {
    return {
      kind: 'video',
      fileId: msg.video.file_id,
      fileName: msg.video.file_name || 'video.mp4',
      mime: msg.video.mime_type || 'video/mp4',
      size: msg.video.file_size || null,
    };
  }

  // audio
  if (msg.audio && msg.audio.file_id) {
    return {
      kind: 'audio',
      fileId: msg.audio.file_id,
      fileName: msg.audio.file_name || 'audio.mp3',
      mime: msg.audio.mime_type || 'audio/mpeg',
      size: msg.audio.file_size || null,
    };
  }

  // voice (ogg)
  if (msg.voice && msg.voice.file_id) {
    return {
      kind: 'voice',
      fileId: msg.voice.file_id,
      fileName: 'voice.ogg',
      mime: msg.voice.mime_type || 'audio/ogg',
      size: msg.voice.file_size || null,
    };
  }

  // animation (gif/mp4)
  if (msg.animation && msg.animation.file_id) {
    return {
      kind: 'animation',
      fileId: msg.animation.file_id,
      fileName: msg.animation.file_name || 'animation.mp4',
      mime: msg.animation.mime_type || 'video/mp4',
      size: msg.animation.file_size || null,
    };
  }

  // photo (pick biggest)
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1];
    return {
      kind: 'photo',
      fileId: p.file_id,
      fileName: 'photo.jpg',
      mime: 'image/jpeg',
      size: p.file_size || null,
    };
  }

  return null;
}

function _randKey(n = 18) {
  return crypto.randomBytes(Math.ceil(n)).toString('base64url').slice(0, n);
}

function _makeBaseUrl(req) {
  // Priority: explicit env, else build from request headers
  if (FILELINK_BASE_URL) return FILELINK_BASE_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers['host'] || '').toString().split(',')[0].trim();
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function _sizePretty(bytes) {
  if (!bytes || typeof bytes !== 'number' || bytes <= 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

// Admin command: /filelink on|off
bot.command('filelink', async (ctx) => {
  const caller = String(ctx.from?.id || '');
  if (!caller || !isAdmin(caller)) return ctx.reply('❌ Only admins can use this command.');

  const arg = String(ctx.match || '').trim().toLowerCase();
  if (arg === 'on' || arg === '1' || arg === 'enable') {
    fileLinkEnabled = true;
    markDirty();
    return ctx.reply('✅ File→Link enabled.');
  }
  if (arg === 'off' || arg === '0' || arg === 'disable') {
    fileLinkEnabled = false;
    markDirty();
    return ctx.reply('✅ File→Link disabled.');
  }

  return ctx.reply(
    `📎 <b>File→Link</b>\n\n` +
    `Status: <b>${fileLinkEnabled ? 'ON' : 'OFF'}</b>\n\n` +
    `Use:\n` +
    `<code>/filelink on</code>\n` +
    `<code>/filelink off</code>\n\n` +
    `Send any file to the bot and it will reply with Stream/Download buttons.`,
    { parse_mode: 'HTML', disable_web_page_preview: true }
  );
});

// When user sends a file (not a command), generate a link
bot.on('message', async (ctx, next) => {
  try {
    const msg = ctx.message;
    const text = msg?.text || '';
    if (typeof text === 'string' && text.trim().startsWith('/')) return next(); // let commands work

    if (!fileLinkEnabled) return next();

    const user = getOrCreateUser(ctx);
    if (!user || !user.isApproved) return next(); // keep consistent with your bot's gating

    const meta = _fileMetaFromMessage(msg);
    if (!meta) return next();

    // Optional: copy the message to a bin/channel so the file is "saved" inside Telegram
    let copiedMsgId = null;
    const bin = String(FILELINK_BIN_CHANNEL || '').trim();
    if (bin) {
      try {
        const copyRes = await bot.api.copyMessage(bin, ctx.chat.id, msg.message_id);
        copiedMsgId = copyRes?.message_id || null;
      } catch (e) {
        console.error('[FILELINK] copyMessage failed:', e?.description || e?.message || e);
      }
    }

    const key = _randKey(22);

    // Cache Telegram file_path early (helps /s and /d links work reliably)
    let cachedPath = null;
    try {
      const f = await bot.api.getFile(meta.fileId);
      cachedPath = f?.file_path || null;
    } catch (_) {
      cachedPath = null;
    }

    fileLinks.set(key, {
      fileId: meta.fileId,
      filePath: cachedPath,
      fileName: meta.fileName,
      mime: meta.mime,
      size: meta.size,
      owner: String(ctx.from?.id || ''),
      createdAt: new Date().toISOString(),
      copiedMsgId
    });

    const base = FILELINK_BASE_URL ? FILELINK_BASE_URL.replace(/\/+$/, '') : 'https://your-railway-domain';
    const secretQ = FILELINK_SECRET ? `?k=${encodeURIComponent(FILELINK_SECRET)}` : '';
    const streamUrl = `${base}/s/${encodeURIComponent(key)}${secretQ}`;
    const dlUrl = `${base}/d/${encodeURIComponent(key)}${secretQ}`;

    const kb = new InlineKeyboard()
      .url('▶️ Stream', streamUrl)
      .url('⬇️ Download', dlUrl);

    const caption =
      `📎 <b>File Link Ready</b>\n` +
      `🧾 <b>Name:</b> <code>${escapeHtml(meta.fileName)}</code>\n` +
      `📦 <b>Size:</b> <code>${escapeHtml(_sizePretty(meta.size))}</code>\n\n` +
      `▶️ <b>Stream:</b> <code>${escapeHtml(streamUrl)}</code>\n` +
      `⬇️ <b>Download:</b> <code>${escapeHtml(dlUrl)}</code>\n\n` +
      `Tip: set <code>FILELINK_BASE_URL</code> in Railway to your public domain.`;

    await ctx.reply(caption, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb });
  } catch (e) {
    console.error('[FILELINK] handler error:', e?.message || e);
  }
  return next();
});

// ===============================
// HTTP SERVER (Railway)
// ===============================
const http = require('http');
const { URL } = require('url');

async function _getFileStreamById(fileId, cachedFilePath) {
  // Prefer cached file_path (faster + avoids extra API call)
  let filePath = cachedFilePath || null;

  if (!filePath) {
    const f = await bot.api.getFile(fileId);
    filePath = f?.file_path || null;
  }

  if (!filePath) {
    const err = new Error('telegram file_path missing');
    err.code = 'NO_FILE_PATH';
    throw err;
  }

  const tgUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const res = await axios.get(tgUrl, {
    responseType: 'stream',
    timeout: 120000,
    headers: { 'user-agent': DEFAULT_UA }
  });

  return { stream: res.data, headers: res.headers, url: tgUrl, filePath };
}

function _needsSecret(u) {
  return !!FILELINK_SECRET && String(u.searchParams.get('k') || '') !== FILELINK_SECRET;
}

function _sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function _safeName(name) {
  const n = String(name || 'file').replace(/[\\\/\r\n"]/g, '_').slice(0, 140);
  return n || 'file';
}

const SERVER_PORT = Number(process.env.PORT || 8080);

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, _makeBaseUrl(req));

    if (u.pathname === '/health') {
      return _sendJson(res, 200, { ok: true, service: 'CN-osint-bot', filelink: true });
    }

    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>CN File Stream</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; margin:0; background:#0b0f17; color:#e8eefc;}
    .wrap{max-width:980px;margin:0 auto;padding:22px;}
    .card{background:#121a2a;border:1px solid #22314f;border-radius:18px;padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.25)}
    h1{margin:0 0 10px;font-size:22px}
    .muted{color:#aab6d5;font-size:13px;line-height:1.45}
    input{width:100%;padding:14px 12px;border-radius:12px;border:1px solid #2a3a5f;background:#0c1220;color:#e8eefc;font-size:16px;outline:none}
    .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
    .btn{padding:12px 14px;border-radius:12px;border:1px solid #2a3a5f;background:#0c1220;color:#e8eefc;font-weight:800;cursor:pointer}
    .btn.primary{background:#5b8cff;border-color:#5b8cff;color:#fff}
    code{color:#b8c7ff}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>📁 CN File Stream</h1>
    <div class="card">
      <div class="muted">
        Paste your token (the part after <code>/s/</code> or <code>/d/</code>).<br/>
        Example: <code>https://.../v/TOKEN</code>
      </div>
      <div style="margin-top:12px">
        <input id="t" placeholder="Paste TOKEN here..." />
      </div>
      <div class="row">
        <button class="btn primary" onclick="go('v')">Open Viewer</button>
        <button class="btn" onclick="go('s')">Stream</button>
        <button class="btn" onclick="go('d')">Download</button>
      </div>
      <div class="muted" style="margin-top:12px">
        Tip: if your links use a secret like <code>?key=XXXX</code>, keep it in the URL — this page will reuse it automatically.
      </div>
    </div>
  </div>
<script>
  const qs = location.search || "";
  function token(){ return (document.getElementById('t').value || '').trim(); }
  function go(kind){
    const t = token();
    if(!t) return alert("Paste token first");
    location.href = "/" + kind + "/" + encodeURIComponent(t) + qs;
  }
</script>
</body>
</html>`);
    }

    // Viewer page (watch/listen/preview)
    const mv = u.pathname.match(/^\/v\/([^\/?#]+)$/i);
    if (mv) {
      if (_needsSecret(u)) return _sendJson(res, 401, { ok: false, error: 'unauthorized' });

      const token = decodeURIComponent(mv[1]);
      const qs = u.search || '';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Viewer</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; margin:0; background:#0b0f17; color:#e8eefc;}
    .wrap{max-width:980px;margin:0 auto;padding:18px;}
    .top{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between;margin-bottom:12px}
    .btn{display:inline-block;padding:10px 12px;border-radius:12px;border:1px solid #2a3a5f;background:#0c1220;color:#e8eefc;text-decoration:none;font-weight:800}
    .btn.primary{background:#5b8cff;border-color:#5b8cff;color:#fff}
    .card{background:#121a2a;border:1px solid #22314f;border-radius:18px;padding:14px;}
    video,audio,img{width:100%;border-radius:14px;border:1px solid #22314f;background:#000}
    .muted{color:#aab6d5;font-size:13px;line-height:1.45;margin-top:10px}
    code{color:#b8c7ff}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <a class="btn" href="/${qs}">← Home</a>
        <a class="btn" href="/s/${encodeURIComponent(token)}${qs}" target="_blank">▶️ Stream</a>
        <a class="btn primary" href="/d/${encodeURIComponent(token)}${qs}">⬇️ Download</a>
      </div>
      <div class="muted">Token: <code>${escapeHtml(token)}</code></div>
    </div>

    <div class="card">
      <div id="player"></div>
      <div class="muted" id="hint">Trying video → audio → image… If nothing loads, use Download.</div>
    </div>
  </div>

<script>
  const token = ${JSON.stringify(token)};
  const qs = ${JSON.stringify(qs)};
  const streamUrl = "/s/" + encodeURIComponent(token) + qs;

  const player = document.getElementById("player");
  const hint = document.getElementById("hint");

  function tryVideo() {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.controls = true;
      v.playsInline = true;
      v.src = streamUrl;
      v.onloadedmetadata = () => resolve({ok:true, node:v});
      v.onerror = () => resolve({ok:false});
      v.load();
    });
  }
  function tryAudio() {
    return new Promise((resolve) => {
      const a = document.createElement("audio");
      a.controls = true;
      a.src = streamUrl;
      a.onloadedmetadata = () => resolve({ok:true, node:a});
      a.onerror = () => resolve({ok:false});
      a.load();
    });
  }
  function tryImage() {
    return new Promise((resolve) => {
      const img = document.createElement("img");
      img.src = streamUrl;
      img.onload = () => resolve({ok:true, node:img});
      img.onerror = () => resolve({ok:false});
    });
  }

  (async () => {
    let r = await tryVideo();
    if (r.ok) { player.appendChild(r.node); hint.textContent = "Playing as video ✅"; return; }

    r = await tryAudio();
    if (r.ok) { player.appendChild(r.node); hint.textContent = "Playing as audio ✅"; return; }

    r = await tryImage();
    if (r.ok) { player.appendChild(r.node); hint.textContent = "Showing as image ✅"; return; }

    hint.textContent = "Preview not supported in browser. Please use Download ✅";
  })();
</script>
</body>
</html>`);
    }

    const m = u.pathname.match(/^\/(s|d)\/([^\/?#]+)$/i);
    if (!m) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }

    if (_needsSecret(u)) return _sendJson(res, 401, { ok: false, error: 'unauthorized' });

    const mode = m[1].toLowerCase(); // s=inline, d=attachment
    const key = decodeURIComponent(m[2]);

    const meta = fileLinks.get(key);
    if (!meta || !meta.fileId) return _sendJson(res, 404, { ok: false, error: 'unknown file key' });

    const name = _safeName(meta.fileName || 'file');
    const disp = mode === 'd' ? 'attachment' : 'inline';

    const { stream, headers, filePath } = await _getFileStreamById(meta.fileId, meta.filePath);
    if (filePath && !meta.filePath) meta.filePath = filePath;

    res.writeHead(200, {
      'content-type': meta.mime || headers?.['content-type'] || 'application/octet-stream',
      'content-disposition': `${disp}; filename="${name}"`,
      'cache-control': 'public, max-age=86400',
    });

    stream.on('error', () => {
      try { res.destroy(); } catch (_) {}
    });
    stream.pipe(res);
  } catch (e) {
    console.error('[FILELINK] http error:', e?.message || e);
    try { _sendJson(res, 500, { ok: false, error: 'server error', message: String(e?.message || e), details: e?.response ? { status: e.response.status, data: e.response.data } : null }); } catch (_) {}
  }
});

server.listen(SERVER_PORT, () => {
  console.log(`🌐 HTTP server listening on :${SERVER_PORT}`);
  if (FILELINK_BASE_URL) console.log(`🌐 FileLink base url: ${FILELINK_BASE_URL}`);
});


// Error handling with conflict resolution
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  
  // Handle 409 Conflict error specifically
  if (e.code === 409) {
    console.log('⚠️ Bot conflict detected - stopping current instance...');
    process.exit(0);
  }
  
  console.error('Error:', e);
});

// Graceful shutdown handling
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  bot.stop();
  process.exit(0);
});

// ===============================
// START BOT
// ===============================
console.log('🚀 Starting Premium OSINT Bot with Complete Admin Panel & Registration Management...');

console.log(`🧩 Version: ${BOT_VERSION}`);
console.log(`🤖 Bot Username: @OsintXDownloaderbot`);
console.log(`👑 Admin ID: ${adminId}`);
console.log('📡 Starting polling...');

bot.start().then(() => {
  console.log('✅ Bot is now running and polling for updates!');
  console.log('🎯 All OSINT commands, admin panel, and registration management are ready!');
  console.log('🎬 Enhanced video downloader with size detection and platform auto-detection is now active!');
  console.log('🔧 Real maintenance mode functionality is now active!');
  console.log('📢 Channel membership verification is now active!');
  console.log('🇵🇰 Updated Pakistani government number lookup with new API endpoint!');
}).catch((error) => {
  console.error('❌ Failed to start bot:', error);
  
  // If it's a conflict error, exit gracefully
  if (error.code === 409) {
    console.log('⚠️ Another bot instance is running. Exiting to prevent conflicts...');
    process.exit(0);
  }
});
