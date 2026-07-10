const express = require('express');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const xray = require('./lib/xray');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('hex');
const GB = 1024 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

// ---------- وضعیت ----------
function normalizeUser(u = {}) {
  return {
    id: u.id || crypto.randomBytes(4).toString('hex'),
    name: u.name || 'user',
    uuid: u.uuid || crypto.randomUUID(),
    enabled: u.enabled !== false,
    createdAt: u.createdAt || Date.now(),
    expireAt: u.expireAt || 0, // 0 = نامحدود
    quotaBytes: u.quotaBytes || 0, // 0 = نامحدود
    usedBytes: u.usedBytes || 0, // مصرف ذخیره‌شده (پایه)
    baseSession: u.baseSession || 0,
  };
}
function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function loadState() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    state = { wsPath: '/' + crypto.randomBytes(6).toString('hex'), users: [{ name: 'default', uuid: process.env.INIT_UUID }] };
  }
  if (!state.wsPath) state.wsPath = '/' + crypto.randomBytes(6).toString('hex');
  state.users = (state.users || []).map(normalizeUser);
  if (!state.users.length) state.users.push(normalizeUser({ name: 'default' }));
  saveState(state);
  return state;
}

const state = loadState();
xray.start(state);

// ---------- آمار مصرف ----------
let sessionBytes = new Map();
const sessionOf = (u) => Math.max(0, (sessionBytes.get(u.id) || 0) - (u.baseSession || 0));
const usedOf = (u) => (u.usedBytes || 0) + sessionOf(u);
const daysLeft = (u) => (u.expireAt ? Math.ceil((u.expireAt - Date.now()) / DAY) : null);
function statusOf(u) {
  if (u.enabled) return 'active';
  if (u.expireAt && Date.now() > u.expireAt) return 'expired';
  if (u.quotaBytes && usedOf(u) >= u.quotaBytes) return 'quota';
  return 'disabled';
}

// جمع‌کردن مصرف نشست فعلی در پایه (چون ری‌استارت Xray شمارنده را صفر می‌کند)
async function rebuild() {
  try {
    const fresh = await xray.readStats();
    for (const u of state.users) {
      u.usedBytes = (u.usedBytes || 0) + Math.max(0, (fresh.get(u.id) || 0) - (u.baseSession || 0));
      u.baseSession = 0;
    }
  } catch (_) {}
  sessionBytes = new Map();
  saveState(state);
  xray.restart(state);
}

// هر ۲۰ ثانیه: خواندن مصرف + اعمال محدودیت حجم/انقضا
async function poll() {
  try {
    sessionBytes = await xray.readStats();
  } catch (_) {}
  let changed = false;
  const now = Date.now();
  for (const u of state.users) {
    if (!u.enabled) continue;
    if ((u.expireAt && now > u.expireAt) || (u.quotaBytes && usedOf(u) >= u.quotaBytes)) {
      u.enabled = false;
      changed = true;
    }
  }
  if (changed) await rebuild();
  else saveState(state);
}
setInterval(poll, 20000);
setTimeout(poll, 5000);

// ---------- کمکی‌ها ----------
function domainOf(req) {
  return (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
}
function linkFor(user, domain, wsPath) {
  const p = new URLSearchParams();
  p.set('type', 'ws');
  p.set('security', 'tls');
  p.set('encryption', 'none');
  p.set('host', domain);
  p.set('sni', domain);
  p.set('fp', 'chrome');
  p.set('path', wsPath);
  return `vless://${user.uuid}@${domain}:443?${p.toString()}#${encodeURIComponent(user.name)}`;
}
function pubUser(u, req) {
  return {
    id: u.id,
    name: u.name,
    uuid: u.uuid,
    enabled: u.enabled,
    link: linkFor(u, domainOf(req), state.wsPath),
    sub: `https://${req.headers.host}/sub/${u.uuid}`,
    used: usedOf(u),
    quota: u.quotaBytes,
    expireAt: u.expireAt,
    daysLeft: daysLeft(u),
    status: statusOf(u),
  };
}

// ---------- اپلیکیشن ----------
const app = express();
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  if ((req.headers['x-admin-token'] || '') !== ADMIN_PASSWORD) return res.status(401).json({ error: 'دسترسی غیرمجاز' });
  next();
}

app.post('/api/login', (req, res) => {
  if ((req.body && req.body.password) !== ADMIN_PASSWORD) return res.status(401).json({ error: 'رمز اشتباه است' });
  res.json({ token: ADMIN_PASSWORD });
});

app.get('/api/state', auth, (req, res) => {
  res.json({ domain: domainOf(req), users: state.users.map((u) => pubUser(u, req)) });
});

app.post('/api/users', auth, (req, res) => {
  const b = req.body || {};
  const days = Number(b.days) || 0;
  const quotaGB = Number(b.quotaGB) || 0;
  const user = normalizeUser({ name: (b.name || 'user').toString().trim().slice(0, 32) || 'user' });
  user.expireAt = days > 0 ? Date.now() + days * DAY : 0;
  user.quotaBytes = quotaGB > 0 ? Math.round(quotaGB * GB) : 0;
  state.users.push(user);
  saveState(state);
  res.json(pubUser(user, req));
  rebuild();
});

app.patch('/api/users/:id', auth, (req, res) => {
  const u = state.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  const b = req.body || {};
  if (b.name !== undefined) u.name = (b.name || 'user').toString().trim().slice(0, 32) || 'user';
  if (b.days !== undefined) {
    const d = Number(b.days) || 0;
    u.expireAt = d > 0 ? Date.now() + d * DAY : 0;
  }
  if (b.quotaGB !== undefined) {
    const q = Number(b.quotaGB) || 0;
    u.quotaBytes = q > 0 ? Math.round(q * GB) : 0;
  }
  if (b.resetUsage) {
    u.usedBytes = 0;
    u.baseSession = sessionBytes.get(u.id) || 0;
  }
  if (b.enabled !== undefined) u.enabled = !!b.enabled;
  saveState(state);
  res.json(pubUser(u, req));
  rebuild();
});

app.delete('/api/users/:id', auth, (req, res) => {
  const i = state.users.findIndex((u) => u.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  if (state.users.length <= 1) return res.status(400).json({ error: 'حداقل یک کاربر باید باقی بماند' });
  state.users.splice(i, 1);
  saveState(state);
  res.json({ ok: true });
  rebuild();
});

// ساب متنی (base64) — فقط کاربران فعال؛ ?raw=1 خروجی خام
app.get('/sub/:uuid', (req, res) => {
  const u = state.users.find((x) => x.uuid === req.params.uuid);
  if (!u) return res.status(404).send('not found');
  const link = linkFor(u, domainOf(req), state.wsPath);
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(req.query.raw ? link : Buffer.from(link, 'utf8').toString('base64'));
});
app.get('/sub', (req, res) => {
  const links = state.users.filter((u) => u.enabled).map((u) => linkFor(u, domainOf(req), state.wsPath));
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(req.query.raw ? links.join('\n') : Buffer.from(links.join('\n'), 'utf8').toString('base64'));
});

app.get('/healthz', (_req, res) => res.send('ok'));

// ---------- سرور HTTP + پراکسی WebSocket ----------
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').split('?')[0] !== state.wsPath) return socket.destroy();
  const upstream = net.connect(xray.WS_INTERNAL_PORT, '127.0.0.1', () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(xray.PUBLIC_PORT, '0.0.0.0', () => {
  console.log('====================================================');
  console.log(` myx روی پورت ${xray.PUBLIC_PORT} بالا آمد`);
  console.log(` رمز ورود پنل (ADMIN PASSWORD): ${ADMIN_PASSWORD}`);
  console.log('====================================================');
});
