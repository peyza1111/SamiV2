const $ = (id) => document.getElementById(id);
let token = localStorage.getItem('adminToken') || '';
let usersCache = [];

// base64 امن برای متن یونیکد (ساب متنی)
function b64(s) {
  return btoa(unescape(encodeURIComponent(s)));
}

// خطاهای شبکه را به پیام فارسی تبدیل می‌کند
function friendly(e) {
  if (e && (e.message === 'Failed to fetch' || e.name === 'TypeError')) {
    return 'به سرور وصل نشد. پنل باید از روی سرورِ در حال اجرا باز شود، نه به‌صورت فایل استاتیک.';
  }
  return (e && e.message) || 'خطا';
}

// ---------- توست ----------
let toastTimer;
function toast(msg, type = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast ' + type), 2200);
}

// ---------- درخواست با توکن ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    logout();
    throw new Error('نیاز به ورود مجدد');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'خطا');
  return data;
}

// ---------- ورود / خروج ----------
async function login() {
  const password = $('password').value;
  $('loginErr').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'خطا');
    token = data.token;
    localStorage.setItem('adminToken', token);
    showDash();
  } catch (e) {
    $('loginErr').textContent = friendly(e);
  }
}

function logout() {
  token = '';
  localStorage.removeItem('adminToken');
  $('dashView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
}

// ---------- داشبورد ----------
async function showDash() {
  $('loginView').classList.add('hidden');
  $('dashView').classList.remove('hidden');
  await refresh();
}

async function refresh() {
  try {
    const data = await api('GET', '/api/state');
    $('domainVal').textContent = data.domain || '—';
    $('userCount').textContent = data.users.length;
    $('userBadge').textContent = data.users.length;
    renderUsers(data.users);
  } catch (_) {
    /* logout در api هندل شده */
  }
}

function renderUsers(users) {
  usersCache = users;
  const box = $('users');
  box.innerHTML = '';
  $('emptyState').classList.toggle('hidden', users.length > 0);
  $('copyAllSub').classList.toggle('hidden', users.length === 0);

  users.forEach((u) => {
    const node = $('userTpl').content.cloneNode(true);
    node.querySelector('.avatar').textContent = (u.name || 'U').charAt(0);
    node.querySelector('.user-name').textContent = u.name;
    node.querySelector('.user-uuid').textContent = u.uuid;
    node.querySelector('.user-link').textContent = u.link;

    node.querySelector('.copy-link').onclick = () => copy(u.link, 'لینک کانفیگ کپی شد');
    node.querySelector('.copy-sub').onclick = () => copy(b64(u.link), 'ساب متنی کپی شد');

    const qrBox = node.querySelector('.qr');
    node.querySelector('.toggle-qr').onclick = () => {
      if (qrBox.classList.contains('show')) {
        qrBox.classList.remove('show');
        qrBox.innerHTML = '';
      } else {
        qrBox.classList.add('show');
        new QRCode(qrBox, { text: u.link, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M });
      }
    };

    node.querySelector('.del').onclick = () => removeUser(u.id, u.name);
    box.appendChild(node);
  });
}

async function addUser() {
  const name = $('newName').value.trim() || 'user';
  $('addBtn').disabled = true;
  try {
    await api('POST', '/api/users', { name });
    $('newName').value = '';
    await refresh();
    toast('کاربر ساخته شد ✓');
  } catch (e) {
    toast(friendly(e), 'err');
  } finally {
    $('addBtn').disabled = false;
  }
}

async function removeUser(id, name) {
  if (!confirm(`کاربر «${name}» حذف شود؟`)) return;
  try {
    await api('DELETE', '/api/users/' + id);
    await refresh();
    toast('کاربر حذف شد');
  } catch (e) {
    toast(friendly(e), 'err');
  }
}

function copy(text, msg) {
  navigator.clipboard.writeText(text).then(
    () => toast(msg || 'کپی شد ✓'),
    () => toast('کپی ناموفق بود', 'err')
  );
}

// ---------- رویدادها ----------
$('loginBtn').addEventListener('click', login);
$('password').addEventListener('keydown', (e) => e.key === 'Enter' && login());
$('togglePass').addEventListener('click', () => {
  const p = $('password');
  p.type = p.type === 'password' ? 'text' : 'password';
});
$('logoutBtn').addEventListener('click', logout);
$('addBtn').addEventListener('click', addUser);
$('newName').addEventListener('keydown', (e) => e.key === 'Enter' && addUser());
$('copyDomain').addEventListener('click', () => {
  const d = $('domainVal').textContent;
  if (d && d !== '—') copy(d, 'دامنه کپی شد');
});
$('copyAllSub').addEventListener('click', () => {
  if (!usersCache.length) return toast('کاربری نیست', 'err');
  const text = b64(usersCache.map((u) => u.link).join('\n'));
  copy(text, 'ساب متنی همه کپی شد');
});

if (token) showDash();
