const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const XRAY_BIN = process.env.XRAY_BIN || path.join(__dirname, '..', 'bin', 'xray');
const CONFIG_PATH = path.join(os.tmpdir(), 'xray-config.json');
const PUBLIC_PORT = Number(process.env.PORT) || 3000; // پورتی که Railway بیرون می‌دهد (Node آن را می‌گیرد)
let WS_INTERNAL_PORT = 10001; // اینباند WebSocket داخلی Xray (فقط localhost)
if (WS_INTERNAL_PORT === PUBLIC_PORT) WS_INTERNAL_PORT = PUBLIC_PORT + 7;

let proc = null;
let currentState = null;
let stopping = false;

// کانفیگ Xray: فقط یک اینباند VLESS+WS روی localhost. TLS را Railway هندل می‌کند،
// و Node درخواست‌های WebSocket را به این اینباند پاس می‌دهد.
function buildConfig(state) {
  const clients = state.users.map((u) => ({ id: u.uuid, level: 0, email: u.name }));
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'proxy',
        listen: '127.0.0.1',
        port: WS_INTERNAL_PORT,
        protocol: 'vless',
        settings: { clients, decryption: 'none' },
        streamSettings: {
          network: 'ws',
          security: 'none',
          wsSettings: { path: state.wsPath },
        },
      },
    ],
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

module.exports = { start, restart, PUBLIC_PORT, WS_INTERNAL_PORT };
