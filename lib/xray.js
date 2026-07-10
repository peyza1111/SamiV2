const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const XRAY_BIN = process.env.XRAY_BIN || path.join(__dirname, '..', 'bin', 'xray');
const CONFIG_PATH = path.join(os.tmpdir(), 'xray-config.json');
const PUBLIC_PORT = Number(process.env.PORT) || 3000; // Node این را می‌گیرد
let WS_INTERNAL_PORT = 10001; // اینباند WebSocket داخلی Xray
let API_PORT = 10085; // اینباند API آمار Xray
if (WS_INTERNAL_PORT === PUBLIC_PORT) WS_INTERNAL_PORT = PUBLIC_PORT + 7;
if (API_PORT === PUBLIC_PORT) API_PORT = PUBLIC_PORT + 9;

let proc = null;
let currentState = null;
let stopping = false;

// کانفیگ Xray: اینباند VLESS+WS + اینباند API برای آمار مصرف هر کاربر
function buildConfig(state) {
  let clients = state.users
    .filter((u) => u.enabled)
    .map((u) => ({ id: u.uuid, level: 0, email: u.id })); // email = شناسه‌ی یکتا برای آمار
  if (!clients.length) clients = [{ id: crypto.randomUUID(), level: 0, email: '_none' }];

  return {
    log: { loglevel: 'warning' },
    api: { tag: 'api', services: ['HandlerService', 'StatsService'] },
    stats: {},
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true },
    },
    inbounds: [
      {
        tag: 'proxy',
        listen: '127.0.0.1',
        port: WS_INTERNAL_PORT,
        protocol: 'vless',
        settings: { clients, decryption: 'none' },
        streamSettings: { network: 'ws', security: 'none', wsSettings: { path: state.wsPath } },
      },
      {
        tag: 'api',
        listen: '127.0.0.1',
        port: API_PORT,
        protocol: 'dokodemo-door',
        settings: { address: '127.0.0.1' },
      },
    ],
    routing: { rules: [{ type: 'field', inboundTag: ['api'], outboundTag: 'api' }] },
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
    ],
  };
}

function start(state) {
  currentState = state;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(buildConfig(state), null, 2));

  if (!fs.existsSync(XRAY_BIN)) {
    console.warn(`[xray] باینری در ${XRAY_BIN} پیدا نشد — پروکسی غیرفعال است (حالت توسعه‌ی محلی).`);
    return;
  }
  if (proc) {
    proc.removeAllListeners();
    try { proc.kill('SIGKILL'); } catch (_) {}
    proc = null;
  }
  proc = spawn(XRAY_BIN, ['run', '-c', CONFIG_PATH], { stdio: 'inherit' });
  proc.on('exit', (code) => {
    if (stopping) return;
    console.error(`[xray] با کد ${code} بسته شد؛ ۲ ثانیه دیگر دوباره اجرا می‌شود.`);
    setTimeout(() => start(currentState), 2000);
  });
  console.log(`[xray] اجرا شد روی 127.0.0.1:${WS_INTERNAL_PORT} (مسیر WS: ${state.wsPath})`);
}

function restart(state) {
  start(state);
}

// خواندن مصرف هر کاربر (uplink+downlink) از API آمار Xray
function readStats() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(XRAY_BIN)) return resolve(new Map());
    execFile(
      XRAY_BIN,
      ['api', 'statsquery', `--server=127.0.0.1:${API_PORT}`, '-pattern', 'user>>>'],
      { timeout: 8000 },
      (err, stdout) => {
        if (err) return reject(err);
        const map = new Map();
        try {
          const data = JSON.parse(stdout || '{}');
          for (const s of data.stat || []) {
            const m = /^user>>>(.+)>>>traffic>>>(uplink|downlink)$/.exec(s.name || '');
            if (!m) continue;
            map.set(m[1], (map.get(m[1]) || 0) + Number(s.value || 0));
          }
        } catch (_) {}
        resolve(map);
      }
    );
  });
}

module.exports = { start, restart, readStats, PUBLIC_PORT, WS_INTERNAL_PORT, API_PORT };
