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

// ---------- وضعیت (کاربران + مسیر مخفی WS) ----------
function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    const state = {
      wsPath: '/' + crypto.randomBytes(6).toString('hex'),
      users: [
        {
          id: crypto.randomBytes(4).toString('hex'),
          name: 'default',
          uuid: process.env.INIT_UUID || crypto.randomUUID(),
        },
      ],
    };
    saveState(state);
    return state;
  }
}

const state = loadState();
xray.start(state);

// ---------- کمکی‌ها ----------
function domainOf(req) {
  return (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
}
function linkFor(user, domain, wsPath, remark) {
  const name = remark || user.name;
  const p = new URLSearchParams();
  p.set('type', 'ws');
  p.set('security', 'tls');
  p.set('encryption', 'none');
  p.set('host', domain);
  p.set('sni', domain);
  p.set('fp', 'chrome');
  p.set('path', wsPath);
  return `vless://${user.uuid}@${domain}:443?${p.toString()}#${encodeURIComponent(name)}`;
}

// ---------- اپلیکیشن ----------
const app = express();
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  if ((req.headers['x-admin-token'] || '') !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'دسترسی غیرمجاز' });
  }
  next();
}

app.post('/api/login', (req, res) => {
  if ((req.body && req.body.password) !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'رمز اشتباه است' });
  }
  res.json({ token: ADMIN_PASSWORD });
});

app.get('/api/state', auth, (req, res) => {
  const domain = domainOf(req);
  res.json({
    domain,
    wsPath: state.wsPath,
    users: state.users.map((u) => ({
      id: u.id,
      name: u.name,
      uuid: u.uuid,
      link: linkFor(u, domain, state.wsPath),
      sub: `https://${req.headers.host}/sub/${u.uuid}`,
    })),
  });
});

app.post('/api/users', auth, (req, res) => {
  const name = ((req.body && req.body.name) || 'user').toString().trim().slice(0, 32) || 'user';
  const user = { id: crypto.randomBytes(4).toString('hex'), name, uuid: crypto.randomUUID() };
  state.users.push(user);
  saveState(state);
  const domain = domainOf(req);
  // اول پاسخ را می‌فرستیم (پنل مستقل از Xray است) بعد Xray را ری‌استارت می‌کنیم
  res.json({
    id: user.id,
    name: user.name,
    uuid: user.uuid,
    link: linkFor(user, domain, state.wsPath),
    sub: `https://${req.headers.host}/sub/${user.uuid}`,
  });
  xray.restart(state);
});

app.delete('/api/users/:id', auth, (req, res) => {
  const i = state.users.findIndex((u) => u.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  if (state.users.length <= 1) return res.status(400).json({ error: 'حداقل یک کاربر باید باقی بماند' });
  state.users.splice(i, 1);
  saveState(state);
  res.json({ ok: true });
  xray.restart(state);
});

// ساب متنی یک کاربر: پیش‌فرض base64، با ?raw=1 متن خام vless
app.get('/sub/:uuid', (req, res) => {
  const u = state.users.find((x) => x.uuid === req.params.uuid);
  if (!u) return res.status(404).send('not found');
  const link = linkFor(u, domainOf(req), state.wsPath);
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(req.query.raw ? link : Buffer.from(link, 'utf8').toString('base64'));
});

// ساب متنی همه‌ی کاربران
app.get('/sub', (req, res) => {
  const domain = domainOf(req);
  const links = state.users.map((u) => linkFor(u, domain, state.wsPath));
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(req.query.raw ? links.join('\n') : Buffer.from(links.join('\n'), 'utf8').toString('base64'));
});

app.get('/healthz', (_req, res) => res.send('ok'));

// ---------- سرور HTTP + پراکسی WebSocket به Xray ----------
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const reqPath = (req.url || '').split('?')[0];
  if (reqPath !== state.wsPath) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(xray.WS_INTERNAL_PORT, '127.0.0.1', () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
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
  console.log('  (برای رمز ثابت، متغیر محیطی ADMIN_PASSWORD را ست کنید)');
  console.log('====================================================');
});
