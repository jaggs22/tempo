// Tempo app: one installable PWA, two roles. Vanilla JS, no build step.

// ---------------------------------------------------------------- platform
const params = new URLSearchParams(location.search);
if (['localhost', '127.0.0.1'].includes(location.hostname) && params.get('installed') === '1') sessionStorage.setItem('tempo_installed', '1');
const INSTALLED = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true || sessionStorage.getItem('tempo_installed') === '1';
const UA = navigator.userAgent;
const IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const ANDROID = /Android/.test(UA);
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; document.querySelectorAll('[data-act="install"]').forEach((b) => (b.hidden = false)); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---------------------------------------------------------------- helpers
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const G = { me: null, studio: null, learner: null, cal: null };
let A = {}; // click actions for the current screen

async function api(method, path, body) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-tempo': '1', ...(INSTALLED ? { 'x-tempo-installed': '1' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong'); e.status = res.status; throw e; }
  return data;
}
function toast(msg, err = false) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), err ? 4500 : 2600);
}
const busy = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };
const render = (html) => { $('#app').innerHTML = html; scrollTo(0, 0); };
function vals(root) {
  const o = {};
  root.querySelectorAll('[name]').forEach((el) => {
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else o[el.name] = el.value;
  });
  return o;
}
function sheet(html) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet" role="dialog"><div class="grab"></div>${html}</div>`;
  const close = () => scrim.remove();
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  document.body.append(scrim);
  return { el: scrim.firstElementChild, close };
}
document.addEventListener('click', (e) => {
  const seg = e.target.closest('.seg button[data-v]');
  if (seg) {
    const box = seg.parentElement;
    box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === seg));
    const hidden = box.nextElementSibling;
    if (hidden && hidden.type === 'hidden') { hidden.value = seg.dataset.v; hidden.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  const el = e.target.closest('[data-act]');
  if (el && A[el.dataset.act]) { e.preventDefault(); busy(A[el.dataset.act])(el, e); }
});
addEventListener('popstate', () => route());
addEventListener('keydown', (e) => { if (e.key === 'Escape') { const all = document.querySelectorAll('.scrim'); all[all.length - 1]?.remove(); } });
function go(path) { history.pushState({}, '', path); route(); }

// ---------------------------------------------------------------- time + money
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WDL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const tzNow = () => G.studio?.studio?.timezone || G.home?.membership?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
const localDateOf = (iso, tz = tzNow()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const today = (tz) => localDateOf(new Date().toISOString(), tz);
const addDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const wdOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const dayLabel = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const fmtDay = (iso, tz = tzNow()) => new Date(iso).toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (iso, tz = tzNow()) => new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).toLowerCase();
const hm = (min) => { const h = Math.floor(min / 60), m = min % 60; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };
const minOf = (iso, tz = tzNow()) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).split(':'); return +p[0] * 60 + +p[1]; };
const digits = (cur) => new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits;
const SYM = { SGD: 'S$', INR: '₹', USD: 'US$', GBP: '£', EUR: '€', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', MYR: 'RM', AED: 'AED ' };
const money = (minor, cur) => {
  const d = digits(cur), v = (minor || 0) / 10 ** d;
  const n = new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : d, maximumFractionDigits: d }).format(Math.abs(v));
  return `${v < 0 ? '−' : ''}${SYM[cur] || cur + ' '}${n}`;
};
const major = (minor, cur) => ((minor || 0) / 10 ** digits(cur)).toFixed(digits(cur));
const timeOptions = (sel, from = 6 * 60, to = 22 * 60) => { let o = ''; for (let m = from; m <= to; m += 30) o += `<option value="${m}" ${m === sel ? 'selected' : ''}>${hm(m)}</option>`; return o; };
const CURRENCIES = ['SGD', 'INR', 'USD', 'GBP', 'EUR', 'AUD', 'CAD', 'MYR', 'AED', 'NZD'];
const curOptions = (sel) => CURRENCIES.map((c) => `<option ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
const initials = (n) => String(n || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const first = (n) => String(n || '').split(' ')[0];
const seg = (name, options, value) => `<div class="seg">${options.map(([v, l]) => `<button type="button" data-v="${esc(v)}" class="${String(v) === String(value) ? 'on' : ''}">${l}</button>`).join('')}</div><input type="hidden" name="${name}" value="${esc(value)}">`;
const KIND = { regular: '', extra: '<span class="chip">Extra</span>', makeup: '<span class="chip">Make-up</span>' };
const modeChip = (m) => (m === 'virtual' ? '<span class="chip info">Online</span>' : '<span class="chip">In person</span>');

// ---------------------------------------------------------------- tabs
const ICONS = {
  cal: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.7-3.3 3-5 6-5s5.3 1.7 6 5"/><path d="M16 5.5a3 3 0 0 1 0 5.6M18 14.4c1.6.8 2.6 2.4 3 4.6"/>',
  money: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.6M12 18.6v2.6M4.2 7.5l2.3 1.3M17.5 15.2l2.3 1.3M4.2 16.5l2.3-1.3M17.5 8.8l2.3-1.3"/>',
  home: '<path d="M4 11l8-6.5 8 6.5v8.5a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
  plus: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M12 10v6M9 13h6"/>',
  note: '<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="16" r="2.2"/>',
};
function tabs(list, active) {
  $('#tabs').innerHTML = `<nav class="tabs"><div>${list.map(([path, label, icon, dot]) =>
    `<button data-act="tab" data-path="${path}" class="${path === active ? 'on' : ''}"><svg viewBox="0 0 24 24">${ICONS[icon]}</svg>${label}${dot ? '<i class="dot"></i>' : ''}</button>`).join('')}</div></nav>`;
}
const noTabs = () => { $('#tabs').innerHTML = ''; };

// ---------------------------------------------------------------- push
function b64ToBytes(s) { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }
const pushPossible = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!G.me?.vapid;
const pushOn = () => pushPossible() && Notification.permission === 'granted';
async function enablePush() {
  if (!pushPossible()) return toast(IOS && !INSTALLED ? 'Open Tempo from your home screen to turn on notifications.' : 'Notifications are not available on this device.', true);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Notifications are blocked. Turn them on in your phone settings for Tempo.', true);
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(G.me.vapid) });
  await api('POST', '/api/push/subscribe', sub.toJSON());
  toast('Notifications are on');
  route();
}
const pushCard = () => (pushPossible() && !pushOn() ? `<div class="card"><div class="top"><div><b>Turn on notifications</b><div class="sub">Get class changes and events on this device.</div></div>
  <button class="btn sm pri" data-act="push">Turn on</button></div></div>` : '');

// =================================================================== ROUTER
async function route() {
  A = { tab: (el) => go(el.dataset.path), push: enablePush, install: async () => { if (installPrompt) { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; } } };
  const path = location.pathname;
  const studioLink = path.match(/^\/s\/([^/]+)/);
  if (studioLink) return studioLanding(decodeURIComponent(studioLink[1]));
  try { G.me = await api('GET', '/api/me'); } catch (e) { return render(`<div class="empty">Can't reach Tempo. Check your connection.</div>`); }
  if (params.get('error')) toast(params.get('error') === 'not_teacher' ? 'That Google account is not set up as a teacher.' : 'Sign-in did not complete. Please try again.', true);
  const u = G.me.user;
  if (!u) return INSTALLED ? welcome() : browserLanding();
  if (u.kind === 'teacher') {
    const own = G.me.studios.find((s) => s.role === 'teacher');
    if (!own) return teacherSetup();
    if (!G.studio || G.studio.studio.id !== own.id) G.studio = await api('GET', `/api/t/${own.id}`);
    return teacherApp(path);
  }
  return studentApp(path);
}

// =================================================================== PUBLIC
function installSteps() {
  if (IOS) return `<div class="step"><b>1</b><div>Tap <b>Share</b> <span class="sub">(the square with an arrow)</span></div></div>
    <div class="step"><b>2</b><div>Choose <b>Add to Home Screen</b>, then <b>Add</b></div></div>
    <div class="step"><b>3</b><div>Open <b>Tempo</b> from your home screen</div></div>`;
  if (ANDROID) return `<button class="btn pri" data-act="install" ${installPrompt ? '' : 'hidden'}>Install Tempo</button>
    <div class="step"><b>1</b><div>Tap the <b>⋮</b> menu in Chrome</div></div>
    <div class="step"><b>2</b><div>Choose <b>Install app</b> or <b>Add to Home screen</b></div></div>
    <div class="step"><b>3</b><div>Open <b>Tempo</b> from your home screen</div></div>`;
  return `<div class="step"><b>1</b><div>Open this link on your <b>phone or iPad</b></div></div>
    <div class="step"><b>2</b><div>Add Tempo to the home screen</div></div><div class="step"><b>3</b><div>Open Tempo from the home screen to join</div></div>
    <button class="btn" data-act="install" ${installPrompt ? '' : 'hidden'}>Install on this computer</button>`;
}
async function studioLanding(code) {
  noTabs();
  let s;
  try { s = await api('GET', `/api/studio/${encodeURIComponent(code)}`); } catch { return render(`<div class="empty" style="padding-top:30vh">This studio link isn't valid. Check with your teacher.</div>`); }
  localStorage.setItem('tempo_code', s.join_code);
  if (INSTALLED) { history.replaceState({}, '', '/'); return welcome('join'); }
  render(`<div style="padding-top:20px"><img class="appicon" src="/icons/icon-192.png" alt=""></div>
    <div class="eyb">You're invited to</div><div class="h">${esc(s.name)}</div><div class="sub">${esc(s.teacher_name)} · on Tempo</div>
    <div class="card" style="background:var(--warnb);border-color:transparent"><b style="color:var(--warn)">Install Tempo to join</b>
      <div class="sub" style="color:var(--warn)">You can only join ${esc(s.name)} from the installed app.</div></div>
    <div class="card">${installSteps()}</div>
    <div class="card"><div class="sub">Studio code</div><div class="code" style="margin-top:4px">${esc(s.join_code)}</div>
      <div class="sub small" style="margin-top:6px">You'll enter this in the app. No password, no email needed.</div></div>
    ${s.join_open ? '' : '<div class="card"><span class="chip warn">This studio is not taking new students right now</span></div>'}`);
}

function browserLanding() {
  noTabs();
  A.google = () => { location.href = '/api/auth/google'; };
  A.dev = devLogin;
  render(`<div style="padding-top:40px"><img class="appicon" src="/icons/icon-192.png" alt=""></div>
    <div class="h" style="margin-top:16px">Tempo</div><div class="sub">Classes, fees, practice and events for your music studio.</div>
    <div class="eyb" style="margin-top:28px">Teachers</div>
    ${G.me.google ? '<button class="btn pri" data-act="google">Continue with Google</button>' : ''}
    ${G.me.dev ? '<button class="btn" data-act="dev">Developer sign-in</button>' : ''}
    <div class="eyb" style="margin-top:28px">Students and families</div>
    <div class="card"><div class="sub">Open the studio link your teacher sent you, then add Tempo to your home screen.</div></div>
    <div class="card">${installSteps()}</div>`);
}
function devLogin() {
  const s = sheet(`<div class="h2">Developer sign-in</div><div class="sub">Local testing only (DEV_MODE).</div>
    <label class="f"><span>Name</span><input class="in" name="name" value="Aparna Dharwada"></label>
    <label class="f"><span>Email</span><input class="in" name="email" value="teacher@example.com"></label>
    <button class="btn pri" data-act="devgo">Sign in as teacher</button>`);
  A.devgo = async () => { await api('POST', '/api/dev/teacher', vals(s.el)); s.close(); route(); };
}

// ---------------------------------------------------------------- welcome (installed, signed out)
function welcome(mode) {
  noTabs();
  const code = localStorage.getItem('tempo_code') || '';
  A.google = () => { location.href = '/api/auth/google'; };
  A.dev = devLogin;
  A.joinmode = () => welcome('join');
  A.signinmode = () => welcome('signin');
  A.back = () => welcome();
  if (!mode) {
    return render(`<div style="padding-top:48px"><img class="appicon" src="/icons/icon-192.png" alt=""></div>
      <div class="h" style="margin-top:16px">Welcome to Tempo</div><div class="sub">Your studio's classes, fees and events in one place.</div>
      <button class="btn pri" style="margin-top:28px" data-act="joinmode">Join a studio</button>
      <button class="btn" data-act="signinmode">I already have an account</button>
      <hr><div class="sub center">Teaching?</div>
      ${G.me.google ? '<button class="btn" data-act="google">Teachers: continue with Google</button>' : ''}
      ${G.me.dev ? '<button class="btn ghost" data-act="dev">Developer sign-in</button>' : ''}`);
  }
  if (mode === 'signin') {
    A.signin = async () => {
      const v = vals($('#app'));
      const r = await api('POST', '/api/signin', { code: v.code, full_name: v.full_name });
      localStorage.setItem('tempo_code', v.code.toUpperCase());
      waitForApproval(r);
    };
    return render(`<button class="btn sm ghost" data-act="back">‹ Back</button><div class="h" style="margin-top:8px">Sign in</div>
      <div class="sub">Type your full name exactly as you registered. Your teacher approves new devices.</div>
      <label class="f"><span>Studio code</span><input class="in" name="code" value="${esc(code)}" autocapitalize="characters" autocomplete="off"></label>
      <label class="f"><span>Full name</span><input class="in" name="full_name" autocomplete="name"></label>
      <button class="btn pri" data-act="signin">Send sign-in request</button>`);
  }
  // join
  const state = { studio: null };
  A.find = async () => {
    const v = vals($('#app'));
    const name = v.full_name.trim().replace(/\s+/g, ' ');
    if (!name.includes(' ')) throw new Error('Please enter your full name (first and last)');
    state.studio = await api('GET', `/api/studio/${encodeURIComponent(v.code.trim())}`);
    if (!state.studio.join_open) throw new Error(`${state.studio.name} is not taking new students right now`);
    state.name = name;
    whoLearns();
  };
  render(`<button class="btn sm ghost" data-act="back">‹ Back</button><div class="eyb">Join a studio · step 1 of 2</div><div class="h">Your details</div>
    <label class="f"><span>Studio code</span><input class="in" name="code" value="${esc(code)}" autocapitalize="characters" autocomplete="off"></label>
    <label class="f"><span>Your full name · this is your username</span><input class="in" name="full_name" autocomplete="name" placeholder="First and last name"></label>
    <div class="sub small" style="margin-top:8px">No password. On a new phone you type your name and your teacher approves the device.</div>
    <button class="btn pri" data-act="find">Continue</button>`);

  function whoLearns() {
    const s = state.studio;
    let shared = false;
    const draw = () => render(`<button class="btn sm ghost" data-act="joinmode">‹ Back</button><div class="eyb">${esc(s.name)} · step 2 of 2</div><div class="h">Who learns on this account?</div>
      <label class="opt ${!shared ? 'on' : ''}" data-act="solo"><input type="radio" name="w" ${!shared ? 'checked' : ''}><div>Just me<div class="sub">One learner</div></div></label>
      <label class="opt ${shared ? 'on' : ''}" data-act="shared"><input type="radio" name="w" ${shared ? 'checked' : ''}><div>Shared account<div class="sub">Siblings or a group sharing one login</div></div></label>
      ${shared ? `<div class="card"><div class="lrow"><div class="av">${esc(initials(state.name))}</div><div class="m"><div>${esc(state.name)}</div><div>You</div></div></div>
        ${[0, 1, 2].map((i) => `<label class="f"><span>${i === 0 ? 'Other learner' : 'Another learner (optional)'}</span><input class="in" name="l${i}" placeholder="Full name"></label>`).join('')}</div>
        <label class="opt" style="align-items:center"><input type="checkbox" name="confirm"><div class="small">We confirm these learners share this account</div></label>` : ''}
      <button class="btn pri" data-act="join">Join ${esc(s.name)}</button>`);
    A.solo = () => { shared = false; draw(); };
    A.shared = () => { shared = true; draw(); };
    A.join = async () => {
      const v = vals($('#app'));
      const learners = shared ? [v.l0, v.l1, v.l2].filter((x) => x && x.trim()) : [];
      if (shared && !learners.length) throw new Error('Add at least one more learner, or choose “Just me”');
      if (shared && !v.confirm) throw new Error('Please confirm who shares this account');
      await api('POST', '/api/join', { code: s.join_code, full_name: state.name, shared, learners, confirm_shared: shared ? !!v.confirm : undefined });
      route();
    };
    draw();
  }
}
function waitForApproval(req) {
  let stop = false;
  A.back = () => { stop = true; welcome(); };
  render(`<div style="padding-top:22vh" class="center"><div class="h">Waiting for ${esc(first(req.teacher_name))}</div>
    <div class="sub">Your teacher will see a sign-in request. Keep this screen open.</div><button class="btn" data-act="back">Cancel</button></div>`);
  const poll = async () => {
    if (stop) return;
    try {
      const r = await api('POST', `/api/signin/${req.id}/poll`, { secret: req.secret });
      if (r.status === 'approved') return route();
      if (r.status === 'denied') { toast('Your teacher declined this sign-in.', true); return welcome(); }
    } catch (e) { toast(e.message, true); return welcome(); }
    setTimeout(poll, 3000);
  };
  setTimeout(poll, 2000);
}

// =================================================================== TEACHER
function teacherSetup() {
  noTabs();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Singapore';
  const zones = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [tz]);
  A.create = async () => {
    const v = vals($('#app'));
    const r = await api('POST', '/api/studios', { name: v.name, teacher_name: v.teacher_name, slug: v.slug || v.name, join_code: v.code || undefined, timezone: v.tz, currency: v.cur, studio_address: v.address || undefined });
    G.me = await api('GET', '/api/me');
    G.studio = await api('GET', `/api/t/${r.id}`);
    studioReady(r);
  };
  const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  render(`<div style="padding-top:12px"><img class="appicon" src="/icons/icon-192.png" alt="" style="width:56px;height:56px"></div>
    <div class="eyb">Set up</div><div class="h">Your studio</div><div class="sub">Students join with your studio link. You approve everyone.</div>
    <label class="f"><span>Your name</span><input class="in" name="teacher_name" value="${esc(G.me.user.name)}"></label>
    <label class="f"><span>Studio name</span><input class="in" name="name" id="sname" placeholder="e.g. SuSwara"></label>
    <label class="f"><span>Studio link</span><div style="display:flex;align-items:center;gap:6px"><span class="sub">${esc(location.host)}/s/</span><input class="in" name="slug" id="sslug"></div></label>
    <label class="f"><span>Studio code (students type this in the app)</span><input class="in" name="code" id="scode" autocapitalize="characters"></label>
    <div class="grid2"><label class="f"><span>Time zone</span><select class="in" name="tz">${zones.map((z) => `<option ${z === tz ? 'selected' : ''}>${z}</option>`).join('')}</select></label>
    <label class="f"><span>Default currency</span><select class="in" name="cur">${curOptions(tz === 'Asia/Kolkata' ? 'INR' : 'SGD')}</select></label></div>
    <label class="f"><span>Studio address for in-person classes (optional)</span><input class="in" name="address"></label>
    <button class="btn pri" data-act="create">Create studio</button>`);
  $('#sname').addEventListener('input', (e) => { const s = slugify(e.target.value); $('#sslug').value = s; $('#scode').value = s.replace(/-/g, '').toUpperCase().slice(0, 12); });
}
function studioReady(r) {
  A.share = () => shareStudio();
  A.done = () => go('/settings');
  render(`<div class="center" style="padding-top:30px"><div class="av" style="width:56px;height:56px;margin:0 auto;background:var(--okb);color:var(--ok);font-size:24px">✓</div>
    <div class="h" style="margin-top:12px">${esc(G.studio.studio.name)} is ready</div></div>
    <div class="card"><div class="sub">Studio link</div><div class="link" style="margin-top:6px">${esc(G.studio.link)}</div>
      <div class="sub" style="margin-top:12px">Studio code</div><div class="code" style="margin-top:4px">${esc(r.join_code)}</div></div>
    <button class="btn pri" data-act="share">Share link with students</button>
    <button class="btn" data-act="done">Next: set your teaching hours</button>`);
}
async function shareStudio() {
  const s = G.studio.studio;
  const text = `Join ${s.name} on Tempo: ${G.studio.link}\nInstall the app from the link, then enter code ${s.join_code}.`;
  if (navigator.share) { try { await navigator.share({ title: `Join ${s.name}`, text }); return; } catch { return; } }
  await navigator.clipboard.writeText(text); toast('Invite copied');
}
const sid = () => G.studio.studio.id;

function teacherApp(path) {
  const p = path.startsWith('/events') ? '/events' : path;
  tabs([['/', 'Calendar', 'cal'], ['/students', 'Students', 'people', G.me.unread > 0], ['/fees', 'Fees', 'money'], ['/events', 'Events', 'star'], ['/settings', 'Settings', 'gear']], p);
  if (p === '/students') return tStudents();
  if (p === '/fees') return tFees();
  if (p === '/events') return tEvents();
  if (p === '/settings') return tSettings();
  return tCalendar();
}

// ---------------------------------------------------------------- teacher: calendar
async function tCalendar() {
  const tz = G.studio.studio.timezone;
  G.cal = G.cal || today(tz);
  const d = G.cal;
  const [cal, roster] = await Promise.all([api('GET', `/api/t/${sid()}/calendar?from=${d}&days=1`), api('GET', `/api/t/${sid()}/students`)]);
  G.roster = roster;
  const pending = roster.members.filter((m) => m.status === 'pending').length + roster.signin_requests.length;
  A.prev = () => { G.cal = addDays(d, -1); tCalendar(); };
  A.next = () => { G.cal = addDays(d, 1); tCalendar(); };
  A.todaybtn = () => { G.cal = today(tz); tCalendar(); };
  A.cls = (el) => classSheet(cal.classes.find((c) => c.id === el.dataset.id));
  A.add = () => addMenu(d);
  A.pend = () => go('/students');
  const items = [
    ...cal.time_off.map((o) => ({ t: o.starts_at, html: `<div class="ev off"><div class="tm">${fmtTime(o.starts_at, tz)} – ${fmtTime(o.ends_at, tz)}</div><div>Time off${o.reason ? ` · ${esc(o.reason)}` : ''}</div></div>` })),
    ...cal.classes.map((c) => ({ t: c.starts_at, html: `<div class="ev ${c.status === 'cancelled' ? 'cancelled' : ''}" data-act="cls" data-id="${c.id}">
      <div class="tm">${fmtTime(c.starts_at, tz)} – ${fmtTime(c.ends_at, tz)} · ${c.minutes} min</div><div class="nm">${esc(c.learner)}</div>
      <div class="meta">${modeChip(c.mode)}${KIND[c.kind]}${c.moved_from ? '<span class="chip">Moved</span>' : ''}${c.status === 'cancelled' ? `<span class="chip bad">Cancelled by ${c.cancelled_by === 'student' ? 'student' : 'you'}</span>` : ''}${c.status === 'no_show' ? '<span class="chip warn">No-show</span>' : ''}${c.status === 'completed' ? '<span class="chip ok">Done</span>' : ''}</div></div>` })),
    ...cal.groups.map((g) => ({ t: g.starts_at, html: `<div class="ev group"><div class="tm">${fmtTime(g.starts_at, tz)} – ${fmtTime(g.ends_at, tz)} · Group</div><div>${esc(g.title)}</div><div class="meta">${modeChip(g.mode)}<span class="chip info">${g.joined} joined</span></div></div>` })),
  ].sort((a, b) => a.t.localeCompare(b.t));
  render(`<div class="eyb">${esc(G.studio.studio.name)}</div>
    <div class="nav"><button data-act="prev" aria-label="Previous day">‹</button><div class="center" data-act="todaybtn" style="cursor:pointer"><div class="h" style="margin:0">${d === today(tz) ? 'Today' : esc(dayLabel(d))}</div><div class="sub">${esc(dayLabel(d))}</div></div><button data-act="next" aria-label="Next day">›</button></div>
    ${pending ? `<div class="card" data-act="pend" style="cursor:pointer"><span class="chip warn">${pending} waiting for you</span> <span class="sub">New students or sign-in requests</span></div>` : ''}
    ${items.length ? items.map((i) => i.html).join('') : '<div class="empty">No classes this day.</div>'}
    <button class="btn" data-act="add">＋ Add class, group class or time off</button>`);
  // swipe between days
  let x0 = null;
  $('#app').ontouchstart = (e) => { x0 = e.touches[0].clientX; };
  $('#app').ontouchend = (e) => { if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 70) { G.cal = addDays(d, dx < 0 ? 1 : -1); tCalendar(); } x0 = null; };
}
const activeLearners = () => (G.roster?.members || []).filter((m) => m.status === 'active').flatMap((m) => m.learners.filter((l) => l.active).map((l) => ({ ...l, account: m.username })));
const roomOptions = (sel) => `<option value="">Default room</option>${G.studio.rooms.map((r) => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}`;

function addMenu(d) {
  const s = sheet(`<div class="h2">Add to ${esc(dayLabel(d))}</div>
    <button class="btn" data-act="m1">One-off class</button><button class="btn" data-act="m2">Group class</button><button class="btn" data-act="m3">Time off (cancels classes inside it)</button>
    <div class="sub small" style="margin-top:12px">Weekly classes are set per student in Students.</div>`);
  A.m1 = () => { s.close(); classForm(d); };
  A.m2 = () => { s.close(); groupForm(d); };
  A.m3 = () => { s.close(); timeOffForm(d); };
}
function classForm(d) {
  const ls = activeLearners();
  if (!ls.length) return toast('Approve a student first', true);
  const s = sheet(`<div class="h2">One-off class</div>
    <label class="f"><span>Learner</span><select class="in" name="learner_id">${ls.map((l) => `<option value="${l.learner_id}">${esc(l.name)}</option>`).join('')}</select></label>
    <div class="grid2"><label class="f"><span>Date</span><input class="in" type="date" name="date" value="${d}"></label>
    <label class="f"><span>Start</span><select class="in" name="start_min">${timeOptions(17 * 60)}</select></label></div>
    <label class="f"><span>Length</span>${seg('minutes', [[30, '30 min'], [60, '60 min'], [90, '90 min']], 60)}</label>
    <label class="f"><span>Type</span>${seg('kind', [['regular', 'Regular'], ['extra', 'Extra'], ['makeup', 'Make-up']], 'regular')}</label>
    <label class="f"><span>Where</span>${seg('mode', [['physical', 'In person'], ['virtual', 'Online']], 'physical')}</label>
    <button class="btn pri" data-act="save">Schedule and notify</button>`);
  A.save = async () => { const v = vals(s.el); await api('POST', `/api/t/${sid()}/classes`, { ...v, start_min: +v.start_min, minutes: +v.minutes }); s.close(); toast('Class scheduled'); G.cal = v.date; tCalendar(); };
}
function groupForm(d) {
  const ls = activeLearners();
  const s = sheet(`<div class="h2">Group class</div><div class="sub">No seat limit. Choose who can join.</div>
    <label class="f"><span>Title</span><input class="in" name="title" placeholder="e.g. Pancharatna practice"></label>
    <div class="grid2"><label class="f"><span>Date</span><input class="in" type="date" name="date" value="${d}"></label>
    <label class="f"><span>Start</span><select class="in" name="start_min">${timeOptions(10 * 60)}</select></label></div>
    <label class="f"><span>Length</span>${seg('minutes', [[60, '60 min'], [90, '90 min'], [120, '2 hours']], 60)}</label>
    <label class="f"><span>Where</span>${seg('mode', [['physical', 'In person'], ['virtual', 'Online']], 'physical')}</label>
    <label class="f"><span>Who can join</span>${seg('eligibility', [['eligible', 'Group-eligible learners'], ['invited', 'Only those I pick']], 'eligible')}</label>
    <div id="picks" hidden>${ls.map((l) => `<label class="opt" style="align-items:center"><input type="checkbox" data-l="${l.learner_id}"><div>${esc(l.name)}</div></label>`).join('')}</div>
    <label class="f"><span>Fee per learner (${esc(G.studio.studio.default_currency)}, optional)</span><input class="in" name="fee" inputmode="decimal"></label>
    <label class="f"><span>Notes</span><textarea class="in" name="notes"></textarea></label>
    <button class="btn pri" data-act="save">Create and notify</button>`);
  s.el.querySelector('[name=eligibility]').addEventListener('change', (e) => { s.el.querySelector('#picks').hidden = e.target.value !== 'invited'; });
  A.save = async () => {
    const v = vals(s.el);
    const learner_ids = [...s.el.querySelectorAll('[data-l]')].filter((c) => c.checked).map((c) => c.dataset.l);
    await api('POST', `/api/t/${sid()}/groups`, { ...v, start_min: +v.start_min, minutes: +v.minutes, fee: v.fee || undefined, learner_ids });
    s.close(); toast('Group class created'); G.cal = v.date; tCalendar();
  };
}
function timeOffForm(d) {
  const s = sheet(`<div class="h2">Time off</div><div class="sub">Classes inside this time are cancelled and students are told.</div>
    <div class="grid2"><label class="f"><span>From</span><input class="in" type="date" name="date" value="${d}"></label><label class="f"><span>To</span><input class="in" type="date" name="end_date" value="${d}"></label></div>
    <label class="opt" style="align-items:center"><input type="checkbox" name="allday" checked><div>All day</div></label>
    <div class="grid2" id="hrs" hidden><label class="f"><span>Start</span><select class="in" name="start_min">${timeOptions(9 * 60, 0, 23 * 60 + 30)}</select></label>
    <label class="f"><span>End</span><select class="in" name="end_min">${timeOptions(13 * 60, 0, 24 * 60)}</select></label></div>
    <label class="f"><span>Reason (shown to students)</span><input class="in" name="reason" placeholder="e.g. Unwell, concert travel"></label>
    <label class="opt" style="align-items:center"><input type="checkbox" name="credit" checked><div>Give make-up credits for cancelled classes</div></label>
    <button class="btn pri" data-act="save">Block time</button>`);
  s.el.querySelector('[name=allday]').addEventListener('change', (e) => { s.el.querySelector('#hrs').hidden = e.target.checked; });
  A.save = async () => {
    const v = vals(s.el);
    const r = await api('POST', `/api/t/${sid()}/time-off`, { date: v.date, end_date: v.end_date, start_min: v.allday ? undefined : +v.start_min, end_min: v.allday ? undefined : +v.end_min, reason: v.reason, credit: v.credit });
    s.close(); toast(r.cancelled ? `${r.cancelled} class${r.cancelled > 1 ? 'es' : ''} cancelled, students notified` : 'Time blocked'); tCalendar();
  };
}
function classSheet(c) {
  const tz = G.studio.studio.timezone;
  const future = Date.parse(c.starts_at) > Date.now();
  const s = sheet(`<div class="h2">${esc(c.learner)}</div><div class="sub">${esc(fmtDay(c.starts_at, tz))} · ${fmtTime(c.starts_at, tz)} – ${fmtTime(c.ends_at, tz)}</div>
    <div class="meta" style="display:flex;gap:6px;margin-top:8px">${modeChip(c.mode)}${KIND[c.kind]}</div>
    <div class="card flush">${c.mode === 'virtual' ? `<div class="row"><span class="k">Link</span><a class="v" href="${esc(c.meeting_url)}" target="_blank" rel="noopener">Open</a></div>` : `<div class="row"><span class="k">Where</span><span class="v">${esc(c.location || 'Studio')}</span></div>`}
      ${c.moved_from ? `<div class="row"><span class="k">Originally</span><span class="v">${esc(fmtDay(c.moved_from, tz))} ${fmtTime(c.moved_from, tz)}</span></div>` : ''}
      <div class="row"><span class="k">Account</span><span class="v">${esc(c.account)}</span></div></div>
    ${c.status === 'confirmed' && future ? `<div class="btns"><button class="btn" data-act="mv">Move</button><button class="btn danger" data-act="cx">Cancel</button></div>` : ''}
    ${!future && c.status !== 'cancelled' ? `<div class="btns"><button class="btn" data-act="done">Mark done</button><button class="btn" data-act="ns">Mark no-show</button></div><div class="sub small" style="margin-top:6px">No-shows are charged.</div>` : ''}`);
  A.mv = () => { s.close(); pickTime({ title: `Move ${first(c.learner)}'s class`, minutes: c.minutes, from: localDateOf(c.starts_at, tz), teacher: true, ignore: c.id,
    onPick: async (date, start_min) => { await api('PATCH', `/api/t/${sid()}/classes/${c.id}`, { action: 'move', date, start_min }); toast('Moved, student notified'); G.cal = date; tCalendar(); } }); };
  A.cx = async () => {
    const credit = confirm('Give a make-up credit for this class?\nOK = yes, Cancel = no credit');
    await api('PATCH', `/api/t/${sid()}/classes/${c.id}`, { action: 'cancel', credit }); s.close(); toast('Cancelled, student notified'); tCalendar();
  };
  A.done = async () => { await api('PATCH', `/api/t/${sid()}/classes/${c.id}`, { action: 'completed' }); s.close(); tCalendar(); };
  A.ns = async () => { await api('PATCH', `/api/t/${sid()}/classes/${c.id}`, { action: 'no_show' }); s.close(); toast('Marked no-show'); tCalendar(); };
}

/** Shared slot picker: day strip + 30-minute starts. */
function pickTime({ title, minutes, from, teacher, ignore, learner, onPick }) {
  const tz = tzNow();
  const start = teacher ? today(tz) : addDays(today(tz), 0);
  let day = from && from >= start ? from : start, chosen = null;
  const s = sheet(`<div class="h2">${esc(title)}</div><div class="sub">${minutes} min · 30-minute blocks</div><div class="days" id="pdays"></div><div id="pslots"></div>
    ${teacher ? `<label class="f"><span>Or any time (outside your hours is fine)</span><select class="in" id="pany"><option value="">Choose…</option>${timeOptions(-1, 6 * 60, 22 * 60)}</select></label>` : ''}
    <button class="btn pri" data-act="pick" disabled id="pgo">Confirm</button>`);
  const days = [...Array(28)].map((_, i) => addDays(start, i));
  const drawDays = () => { s.el.querySelector('#pdays').innerHTML = days.map((d) => `<div class="day ${d === day ? 'on' : ''}" data-act="pday" data-d="${d}">${WD[wdOf(d)]}<b>${+d.slice(8)}</b></div>`).join(''); };
  const load = async () => {
    drawDays(); chosen = null; s.el.querySelector('#pgo').disabled = true;
    const box = s.el.querySelector('#pslots');
    box.innerHTML = '<div class="empty">Loading…</div>';
    const q = teacher ? `/api/t/${sid()}/free?date=${day}&minutes=${minutes}${ignore ? `&ignore=${ignore}` : ''}` : `/api/s/slots?learner=${learner}&date=${day}&minutes=${minutes}${ignore ? `&ignore=${ignore}` : ''}`;
    const r = await api('GET', q);
    box.innerHTML = `<div class="eyb">${esc(dayLabel(day))}</div>` + (r.starts.length ? `<div class="slots">${r.starts.map((m) => `<button class="slot" data-act="pslot" data-m="${m}">${hm(m).replace(' ', '')}</button>`).join('')}</div>` : '<div class="empty">No free times this day.</div>');
  };
  A.pday = (el) => { day = el.dataset.d; busy(load)(); };
  A.pslot = (el) => { s.el.querySelectorAll('.slot').forEach((b) => b.classList.toggle('on', b === el)); chosen = +el.dataset.m; s.el.querySelector('#pgo').disabled = false; };
  if (teacher) s.el.querySelector('#pany').addEventListener('change', (e) => { if (e.target.value) { s.el.querySelectorAll('.slot').forEach((b) => b.classList.remove('on')); chosen = +e.target.value; s.el.querySelector('#pgo').disabled = false; } });
  A.pick = async () => { if (chosen === null) return; await onPick(day, chosen); s.close(); };
  busy(load)();
  setTimeout(() => s.el.querySelector('.day.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }), 50);
}

// ---------------------------------------------------------------- teacher: students
async function tStudents() {
  const r = G.roster = await api('GET', `/api/t/${sid()}/students`);
  if (G.me.unread) { api('POST', '/api/notifications/read').catch(() => {}); G.me.unread = 0; }
  document.querySelectorAll('.tabs .dot').forEach((d) => d.remove());
  const pending = r.members.filter((m) => m.status === 'pending'), active = r.members.filter((m) => m.status === 'active');
  A.open = (el) => studentSheet(r.members.find((m) => m.id === el.dataset.id));
  A.sr = async (el) => { await api('POST', `/api/t/${sid()}/signin-requests/${el.dataset.id}`, { approve: el.dataset.ok === '1' }); toast(el.dataset.ok === '1' ? 'Device approved' : 'Request declined'); tStudents(); };
  A.share = shareStudio;
  const due = (m) => m.balances.filter((b) => b.due_minor > 0).map((b) => money(b.due_minor, b.currency)).join(' · ');
  render(`<div class="eyb">${esc(G.studio.studio.name)}</div><div class="top"><div class="h">Students</div><button class="btn sm" data-act="share">Invite</button></div>
    ${r.signin_requests.length ? `<div class="eyb">Sign-in requests</div><div class="card flush">${r.signin_requests.map((q) => `<div class="lrow" style="cursor:default"><div class="av">${esc(initials(q.username))}</div>
      <div class="m"><div>${esc(q.username)}</div><div>New device · ${esc(fmtTime(q.created_at))}</div></div><button class="btn sm" data-act="sr" data-id="${q.id}" data-ok="0">Decline</button><button class="btn sm pri" data-act="sr" data-id="${q.id}" data-ok="1">Approve</button></div>`).join('')}</div>` : ''}
    ${pending.length ? `<div class="eyb">Waiting for approval</div><div class="card flush">${pending.map((m) => `<div class="lrow" data-act="open" data-id="${m.id}"><div class="av">${esc(initials(m.username))}</div>
      <div class="m"><div>${esc(m.username)}</div><div>${m.is_shared ? `Shared account · ${m.learners.length} learners: ${m.learners.map((l) => esc(first(l.name))).join(', ')}` : 'One learner'}</div></div><span class="chip warn">Review</span></div>`).join('')}</div>` : ''}
    <div class="eyb">Active · ${active.length}</div>
    ${active.length ? `<div class="card flush">${active.map((m) => `<div class="lrow" data-act="open" data-id="${m.id}"><div class="av">${esc(initials(m.username))}</div>
      <div class="m"><div>${esc(m.username)}${m.is_shared ? ' <span class="chip">Shared</span>' : ''}</div><div>${m.learners.filter((l) => l.active).map((l) => `${esc(first(l.name))} · ${l.classes_done} done`).join(' · ')}</div></div>
      ${due(m) ? `<span class="small" style="font-weight:600">${due(m)}</span>` : ''}</div>`).join('')}</div>` : '<div class="empty">No students yet. Share your studio link.</div>'}`);
}

function studentSheet(m) {
  const cur = m.currency || G.studio.studio.default_currency;
  const learnerCard = (l) => {
    const modes = l.allowed_modes.split(',');
    return `<div class="lcard" data-lid="${l.learner_id}"><div class="top" style="padding-top:6px"><b>${esc(l.name)}</b><span class="sub small">${l.classes_done} done${l.open_credits ? ` · ${l.open_credits} make-up` : ''}</span></div>
    <label class="f"><span>Class length (max a student can book)</span>${seg('max_class_minutes', [[30, '30'], [60, '60'], [90, '90'], [120, '120']], l.max_class_minutes)}</label>
    <div class="grid2"><label class="f"><span>Fee (${esc(cur)})</span><input class="in" name="fee" inputmode="decimal" value="${l.fee_minor ? major(l.fee_minor, cur) : ''}" placeholder="0"></label>
    <label class="f"><span>Charged</span><select class="in" name="fee_basis"><option value="per_class" ${l.fee_basis === 'per_class' ? 'selected' : ''}>Per class</option><option value="per_30min" ${l.fee_basis === 'per_30min' ? 'selected' : ''}>Per 30 min</option></select></label></div>
    <div class="card flush" style="margin-top:12px">
      <div class="row"><span class="k">Group classes</span><input type="checkbox" class="tog" name="group_eligible" ${l.group_eligible ? 'checked' : ''}></div>
      <div class="row"><span class="k">Can reschedule classes</span><input type="checkbox" class="tog" name="can_reschedule" ${l.can_reschedule ? 'checked' : ''}></div>
      <div class="row"><span class="k">Can book make-ups</span><input type="checkbox" class="tog" name="can_book_makeup" ${l.can_book_makeup ? 'checked' : ''}></div>
      <div class="row"><span class="k">Can book extra classes</span><input type="checkbox" class="tog" name="can_book_extra" ${l.can_book_extra ? 'checked' : ''}></div>
      <div class="row"><span class="k">Extra classes per week</span><input class="in" style="width:70px;min-height:34px" name="classes_per_week" inputmode="numeric" value="${l.classes_per_week}"></div>
      <div class="row"><span class="k">In person</span><input type="checkbox" class="tog" name="m_physical" ${modes.includes('physical') ? 'checked' : ''}></div>
      <div class="row"><span class="k">Online</span><input type="checkbox" class="tog" name="m_virtual" ${modes.includes('virtual') ? 'checked' : ''}></div>
      ${G.studio.rooms.length ? `<div class="row"><span class="k">Online room</span><select class="in" style="width:auto;min-height:34px" name="room_id">${roomOptions(l.room_id)}</select></div>` : ''}
    </div>
    <div class="eyb">Weekly classes</div>
    ${l.series.length ? l.series.map((x) => `<div class="row"><span>${WDL[x.weekday]} · ${hm(x.start_min)} · ${x.minutes} min ${x.mode === 'virtual' ? '<span class="chip info">Online</span>' : ''}</span><button class="btn sm danger" data-act="rmseries" data-id="${x.id}">Stop</button></div>`).join('') : '<div class="sub small">None yet.</div>'}
    <div class="btns"><button class="btn sm" style="flex:1" data-act="addseries" data-lid="${l.learner_id}">＋ Weekly class</button><button class="btn sm" style="flex:1" data-act="practice" data-lid="${l.learner_id}">Practice log</button></div>
    <button class="btn" data-act="savel" data-lid="${l.learner_id}">Save ${esc(first(l.name))}'s settings</button></div>`;
  };
  const s = sheet(`<div class="top"><div><div class="h2">${esc(m.username)}</div><div class="sub">${m.is_shared ? `Shared account · ${m.learners.length} learners` : 'Individual account'} · signs in as “${esc(m.username)}”</div></div>${m.status === 'pending' ? '<span class="chip warn">Pending</span>' : ''}</div>
    <label class="f"><span>Currency for this account</span><select class="in" name="currency" id="mcur">${curOptions(cur)}</select></label>
    ${m.learners.filter((l) => l.active).map(learnerCard).join('')}
    <button class="btn sm" style="margin-top:12px" data-act="addl">＋ Add learner to this account</button>
    ${m.status === 'pending' ? '<button class="btn pri" data-act="approve">Save all and approve</button>' : ''}
    <button class="btn danger ghost" data-act="remove">Remove from studio</button>`);
  const saveLearner = async (lid) => {
    const card = s.el.querySelector(`[data-lid="${lid}"].lcard`), v = vals(card);
    const allowed = [v.m_physical && 'physical', v.m_virtual && 'virtual'].filter(Boolean);
    if (!allowed.length) throw new Error('Allow in person, online, or both');
    await api('PATCH', `/api/t/${sid()}/learners/${lid}`, { rules: { max_class_minutes: +v.max_class_minutes, fee: v.fee || '0', fee_basis: v.fee_basis, group_eligible: v.group_eligible,
      can_reschedule: v.can_reschedule, can_book_makeup: v.can_book_makeup, can_book_extra: v.can_book_extra, classes_per_week: +v.classes_per_week || 0, allowed_modes: allowed.join(','),
      default_mode: allowed[0] }, ...(v.room_id !== undefined ? { room_id: v.room_id || null } : {}) });
  };
  const saveCurrency = async () => { const c = s.el.querySelector('#mcur').value; if (c !== m.currency) await api('PATCH', `/api/t/${sid()}/members/${m.id}`, { currency: c }); };
  A.savel = async (el) => { await saveCurrency(); await saveLearner(el.dataset.lid); toast('Saved'); };
  A.approve = async () => { await saveCurrency(); for (const l of m.learners.filter((x) => x.active)) await saveLearner(l.learner_id); await api('PATCH', `/api/t/${sid()}/members/${m.id}`, { status: 'active' }); s.close(); toast(`${m.username} approved and notified`); tStudents(); };
  A.remove = async () => { if (!confirm(`Remove ${m.username}? Their future classes are cancelled and they are signed out.`)) return; await api('PATCH', `/api/t/${sid()}/members/${m.id}`, { status: 'removed' }); s.close(); tStudents(); };
  A.addl = async () => { const name = prompt('Full name of the learner'); if (!name) return; await api('POST', `/api/t/${sid()}/members/${m.id}/learners`, { name }); s.close(); await tStudents(); studentSheet(G.roster.members.find((x) => x.id === m.id)); };
  A.rmseries = async (el) => { if (!confirm('Stop this weekly class? Future classes are cancelled.')) return; await api('DELETE', `/api/t/${sid()}/series/${el.dataset.id}`); s.close(); await tStudents(); studentSheet(G.roster.members.find((x) => x.id === m.id)); };
  A.addseries = (el) => { if (m.status !== 'active') return toast('Approve the account first', true); seriesForm(m, m.learners.find((l) => l.learner_id === el.dataset.lid), s); };
  A.practice = (el) => practiceSheet(m.learners.find((l) => l.learner_id === el.dataset.lid));
}
function seriesForm(m, l, parent) {
  const tz = G.studio.studio.timezone;
  const s = sheet(`<div class="h2">Weekly class · ${esc(l.name)}</div><div class="sub">Tempo books it every week and notifies the family.</div>
    <div class="grid2"><label class="f"><span>Day</span><select class="in" name="weekday">${WDL.map((d, i) => `<option value="${i}" ${i === wdOf(today(tz)) ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
    <label class="f"><span>Start</span><select class="in" name="start_min">${timeOptions(17 * 60)}</select></label></div>
    <label class="f"><span>Length</span>${seg('minutes', [[30, '30 min'], [60, '60 min'], [90, '90 min']], Math.min(l.max_class_minutes, 60))}</label>
    <label class="f"><span>Where</span>${seg('mode', [['physical', 'In person'], ['virtual', 'Online']], l.default_mode)}</label>
    <div class="grid2"><label class="f"><span>Starting</span><input class="in" type="date" name="starts_on" value="${today(tz)}"></label><label class="f"><span>Until (optional)</span><input class="in" type="date" name="ends_on"></label></div>
    <button class="btn pri" data-act="saves">Add weekly class</button>`);
  A.saves = async () => {
    const v = vals(s.el);
    const r = await api('POST', `/api/t/${sid()}/series`, { learner_id: l.learner_id, weekday: +v.weekday, start_min: +v.start_min, minutes: +v.minutes, mode: v.mode, starts_on: v.starts_on, ends_on: v.ends_on || undefined });
    s.close(); parent.close();
    toast(r.skipped.length ? `Added. ${r.skipped.length} week${r.skipped.length > 1 ? 's' : ''} skipped because of a clash.` : 'Weekly class added');
    await tStudents(); studentSheet(G.roster.members.find((x) => x.id === m.id));
  };
}
async function practiceSheet(l) {
  const r = await api('GET', `/api/t/${sid()}/practice?learner=${l.learner_id}`);
  const week = r.logs.filter((x) => x.day >= addDays(today(G.studio.studio.timezone), -6));
  const total = week.reduce((a, x) => a + x.minutes, 0);
  sheet(`<div class="h2">Practice · ${esc(l.name)}</div><div class="sub">${week.filter((x) => x.minutes > 0).length} of 7 days · ${Math.floor(total / 60)}h ${total % 60}m this week · only you can see this</div>
    <div class="card flush">${r.logs.length ? r.logs.map((x) => `<div class="lrow" style="cursor:default"><div class="av">${x.minutes}</div><div class="m"><div>${esc(dayLabel(x.day))} · ${x.minutes} min</div><div>${esc(x.notes || '')}</div></div></div>`).join('') : '<div class="empty">No practice logged yet.</div>'}</div>`);
}

// ---------------------------------------------------------------- teacher: fees
async function tFees() {
  const r = await api('GET', `/api/t/${sid()}/fees`);
  const roster = G.roster = await api('GET', `/api/t/${sid()}/students`);
  const name = (mid) => roster.members.find((m) => m.id === mid)?.username || 'Former student';
  const totals = {};
  r.balances.forEach((b) => { if (b.due_minor > 0) totals[b.currency] = (totals[b.currency] || 0) + b.due_minor; });
  A.pay = (el) => paySheet(roster.members.find((m) => m.id === el.dataset.id), r);
  render(`<div class="eyb">Fees</div><div class="big">${Object.keys(totals).length ? Object.entries(totals).map(([c, v]) => money(v, c)).join('<br>') : money(0, G.studio.studio.default_currency)}</div>
    <div class="sub">Outstanding across ${new Set(r.balances.filter((b) => b.due_minor > 0).map((b) => b.membership_id)).size} accounts</div>
    <div class="card flush">${roster.members.filter((m) => m.status === 'active').map((m) => {
      const bs = r.balances.filter((b) => b.membership_id === m.id);
      const due = bs.filter((b) => b.due_minor > 0);
      return `<div class="lrow" data-act="pay" data-id="${m.id}"><div class="av">${esc(initials(m.username))}</div><div class="m"><div>${esc(m.username)}</div><div>${esc(m.currency || G.studio.studio.default_currency)} account</div></div>
        ${due.length ? `<b>${due.map((b) => money(b.due_minor, b.currency)).join(' · ')}</b>` : '<span class="chip ok">Paid up</span>'}</div>`;
    }).join('') || '<div class="empty">No students yet.</div>'}</div>
    <div class="sub small" style="margin-top:10px">Fees are added automatically when a class is done or marked no-show.</div>`);
}
function paySheet(m, r) {
  const cur = m.currency || G.studio.studio.default_currency;
  const entries = r.entries.filter((e) => e.membership_id === m.id).slice(0, 12);
  const s = sheet(`<div class="h2">${esc(m.username)}</div>
    <div class="grid2"><label class="f"><span>Amount received (${esc(cur)})</span><input class="in" name="amount" inputmode="decimal"></label>
    <label class="f"><span>Method</span><select class="in" name="method"><option>PayNow</option><option>UPI</option><option>Cash</option><option>Bank transfer</option><option>Card</option><option>Other</option></select></label></div>
    <label class="f"><span>Note (optional)</span><input class="in" name="note"></label>
    <button class="btn pri" data-act="rec">Record payment</button>
    <div class="eyb">Recent</div><div class="card flush">${entries.map((e) => `<div class="row"><span class="k">${esc(e.kind === 'charge' ? e.note || 'Class' : e.kind === 'payment' ? `Payment${e.method ? ` · ${e.method}` : ''}` : e.note || 'Adjustment')}<div class="sub small">${esc(fmtDay(e.created_at))}</div></span>
      <span class="v">${e.kind === 'payment' ? '−' : ''}${money(Math.abs(e.amount_minor), e.currency)}</span></div>`).join('') || '<div class="empty">Nothing yet.</div>'}</div>`);
  A.rec = async () => { const v = vals(s.el); await api('POST', `/api/t/${sid()}/payments`, { membership_id: m.id, amount: v.amount, method: v.method, note: v.note || undefined }); s.close(); toast('Payment recorded'); tFees(); };
}

// ---------------------------------------------------------------- teacher: events
async function tEvents() {
  const r = await api('GET', `/api/t/${sid()}/events`);
  const tz = G.studio.studio.timezone;
  A.newev = eventForm;
  A.ev = (el) => eventSheet(el.dataset.id);
  render(`<div class="eyb">${esc(G.studio.studio.name)}</div><div class="top"><div class="h">Events</div><button class="btn sm pri" data-act="newev">New event</button></div>
    ${r.events.length ? r.events.map((e) => `<div class="ev group" data-act="ev" data-id="${e.id}"><div class="tm">${esc(fmtDay(e.starts_at, tz))} · ${fmtTime(e.starts_at, tz)} · ${esc(e.kind)}</div><div>${esc(e.title)}</div>
      <div class="meta"><span class="chip ok">${e.going} going</span>${e.collect_pieces ? `<span class="chip">${e.pieces} pieces in</span>` : ''}</div></div>`).join('') : '<div class="empty">No events yet. Lecdems, competitions and presentations go here, and every student gets a notification.</div>'}`);
}
function eventForm() {
  const tz = G.studio.studio.timezone;
  const s = sheet(`<div class="h2">New event</div>
    <label class="f"><span>Type</span>${seg('kind', [['lecdem', 'Lecdem'], ['competition', 'Competition'], ['presentation', 'Presentation'], ['concert', 'Concert'], ['other', 'Other']], 'lecdem')}</label>
    <label class="f"><span>Title</span><input class="in" name="title"></label>
    <div class="grid2"><label class="f"><span>Date</span><input class="in" type="date" name="date" value="${addDays(today(tz), 7)}"></label><label class="f"><span>Time</span><select class="in" name="start_min">${timeOptions(16 * 60)}</select></label></div>
    <label class="f"><span>Where</span><input class="in" name="location" value="${esc(G.studio.studio.studio_address || '')}"></label>
    <label class="f"><span>Details</span><textarea class="in" name="description"></textarea></label>
    <div class="card flush"><div class="row"><span class="k">Ask for RSVP</span><input type="checkbox" class="tog" name="collect_rsvp" checked></div>
      <div class="row"><span class="k">Ask what they'll sing</span><input type="checkbox" class="tog" name="collect_pieces"></div>
      <div class="row"><span class="k">Who</span><select class="in" style="width:auto;min-height:34px" name="audience"><option value="all">All students</option><option value="group_eligible">Group-eligible only</option></select></div></div>
    <label class="f" id="pf" hidden><span>Fields to ask (comma separated)</span><input class="in" name="fields" value="Composition, Raga, Tala, Composer"></label>
    <button class="btn pri" data-act="pub">Publish and notify</button>`);
  s.el.querySelector('[name=collect_pieces]').addEventListener('change', (e) => { s.el.querySelector('#pf').hidden = !e.target.checked; });
  A.pub = async () => {
    const v = vals(s.el);
    const r = await api('POST', `/api/t/${sid()}/events`, { ...v, start_min: +v.start_min, piece_fields: v.fields.split(',').map((x) => x.trim()).filter(Boolean) });
    s.close(); toast(`Sent to ${r.notified} account${r.notified === 1 ? '' : 's'}`); tEvents();
  };
}
async function eventSheet(id) {
  const r = await api('GET', `/api/t/${sid()}/events/${id}`);
  const e = r.event, tz = G.studio.studio.timezone;
  const label = { yes: 'Going', no: "Can't come", maybe: 'Maybe' };
  sheet(`<div class="eyb">${esc(e.kind)} · ${esc(fmtDay(e.starts_at, tz))} ${fmtTime(e.starts_at, tz)}</div><div class="h2">${esc(e.title)}</div>${e.location ? `<div class="sub">${esc(e.location)}</div>` : ''}
    ${e.description ? `<div class="card">${esc(e.description)}</div>` : ''}
    <div class="eyb">Responses · ${r.responses.length}</div><div class="card flush">${r.responses.map((x) => { const p = x.piece ? JSON.parse(x.piece) : null;
      return `<div class="lrow" style="cursor:default"><div class="av">${esc(initials(x.learner))}</div><div class="m"><div>${esc(x.learner)}${x.attending ? ` · ${label[x.attending]}` : ''}</div><div>${p ? Object.values(p).map(esc).join(' · ') : 'No piece yet'}</div></div></div>`; }).join('') || '<div class="empty">No responses yet.</div>'}</div>`);
}

// ---------------------------------------------------------------- teacher: settings
async function tSettings() {
  G.studio = await api('GET', `/api/t/${sid()}`);
  const st = G.studio.studio;
  const byDay = WD.map((_, i) => G.studio.availability.find((a) => a.weekday === i));
  A.share = shareStudio;
  A.copy = async () => { await navigator.clipboard.writeText(G.studio.link); toast('Link copied'); };
  A.hours = async () => {
    const windows = [];
    WD.forEach((_, i) => { const on = $(`#d${i}`).checked; if (on) windows.push({ weekday: i, start_min: +$(`#a${i}`).value, end_min: +$(`#b${i}`).value }); });
    await api('PUT', `/api/t/${sid()}/availability`, { windows }); toast('Hours saved');
  };
  A.policy = async () => {
    const v = vals($('#policy'));
    await api('PATCH', `/api/t/${sid()}`, { name: v.name, studio_address: v.studio_address, join_open: v.join_open, booking_notice_hours: +v.booking_notice_hours, change_notice_hours: +v.change_notice_hours,
      booking_horizon_days: +v.booking_horizon_days, student_cancel_credit: v.student_cancel_credit, makeup_expiry_days: v.makeup_expiry_days ? +v.makeup_expiry_days : null });
    toast('Saved');
  };
  A.addroom = () => {
    const s = sheet(`<div class="h2">Add online classroom</div><div class="sub">Paste your personal meeting room or a classroom link from Zoom, Google Meet, Teams or any app. It is used for every online class.</div>
      <label class="f"><span>Name</span><input class="in" name="label" placeholder="e.g. My Zoom room"></label>
      <label class="f"><span>Link</span><input class="in" name="url" type="url" placeholder="https://"></label>
      <label class="f"><span>Passcode (optional)</span><input class="in" name="passcode"></label>
      <label class="opt" style="align-items:center"><input type="checkbox" name="is_default"><div>Make this the default</div></label>
      <button class="btn pri" data-act="saveroom">Add</button>
      <div class="sub small" style="margin-top:12px">Auto-generated Zoom, Meet and Teams links per class come with account connections in the next phase.</div>`);
    A.saveroom = async () => { await api('POST', `/api/t/${sid()}/rooms`, vals(s.el)); s.close(); toast('Classroom added'); tSettings(); };
  };
  A.rmroom = async (el) => { await api('DELETE', `/api/t/${sid()}/rooms/${el.dataset.id}`); tSettings(); };
  A.logout = async () => { await api('POST', '/api/logout'); G.studio = null; go('/'); };
  render(`<div class="eyb">Settings</div><div class="h">${esc(st.name)}</div>
    <div class="card"><div class="sub">Studio link</div><div class="link" style="margin-top:6px">${esc(G.studio.link)}</div>
      <div class="top" style="margin-top:12px"><div><div class="sub">Studio code</div><div class="code">${esc(st.join_code)}</div></div><div class="btns" style="width:auto"><button class="btn sm" data-act="copy">Copy</button><button class="btn sm pri" data-act="share">Share</button></div></div></div>
    ${pushCard()}
    <div class="eyb">Teaching hours</div><div class="sub">Students only see free 30-minute blocks inside these hours.</div>
    <div class="card flush">${WD.map((d, i) => `<div class="row"><label style="display:flex;gap:10px;align-items:center;min-width:70px"><input type="checkbox" class="tog" id="d${i}" ${byDay[i] ? 'checked' : ''}>${d}</label>
      <select class="in" style="min-height:34px" id="a${i}">${timeOptions(byDay[i]?.start_min ?? 16 * 60, 0, 23 * 60 + 30)}</select><span class="sub">to</span><select class="in" style="min-height:34px" id="b${i}">${timeOptions(byDay[i]?.end_min ?? 20 * 60, 30, 24 * 60)}</select></div>`).join('')}</div>
    <button class="btn" data-act="hours">Save hours</button>
    <div class="eyb">Online classrooms</div>
    <div class="card flush">${G.studio.rooms.map((r) => `<div class="row"><span><b>${esc(r.label)}</b>${r.is_default ? ' <span class="chip ok">Default</span>' : ''}<div class="sub small">${esc(r.url)}</div></span><button class="btn sm danger" data-act="rmroom" data-id="${r.id}">Remove</button></div>`).join('') || '<div class="empty">None yet. Add one to offer online classes.</div>'}</div>
    <button class="btn" data-act="addroom">＋ Add online classroom</button>
    <div class="eyb">Studio rules</div>
    <div id="policy"><label class="f"><span>Studio name</span><input class="in" name="name" value="${esc(st.name)}"></label>
      <label class="f"><span>Address for in-person classes</span><input class="in" name="studio_address" value="${esc(st.studio_address || '')}"></label>
      <div class="card flush">
        <div class="row"><span class="k">Accept new students</span><input type="checkbox" class="tog" name="join_open" ${st.join_open ? 'checked' : ''}></div>
        <div class="row"><span class="k">Students book at least (hours ahead)</span><input class="in" style="width:70px;min-height:34px" name="booking_notice_hours" inputmode="numeric" value="${st.booking_notice_hours}"></div>
        <div class="row"><span class="k">Changes close (hours before class)</span><input class="in" style="width:70px;min-height:34px" name="change_notice_hours" inputmode="numeric" value="${st.change_notice_hours}"></div>
        <div class="row"><span class="k">Bookable up to (days ahead)</span><input class="in" style="width:70px;min-height:34px" name="booking_horizon_days" inputmode="numeric" value="${st.booking_horizon_days}"></div>
        <div class="row"><span class="k">On-time cancellations earn a make-up</span><input type="checkbox" class="tog" name="student_cancel_credit" ${st.student_cancel_credit ? 'checked' : ''}></div>
        <div class="row"><span class="k">Make-ups expire after (days, blank = never)</span><input class="in" style="width:70px;min-height:34px" name="makeup_expiry_days" inputmode="numeric" value="${st.makeup_expiry_days || ''}"></div>
      </div><button class="btn" data-act="policy">Save rules</button></div>
    <button class="btn ghost danger" data-act="logout">Sign out</button>`);
}

// =================================================================== STUDENT
async function studentApp(path) {
  const home = G.home = await api('GET', '/api/s/home');
  if (home.membership.status !== 'active') return pendingScreen(home);
  const p = path.startsWith('/events') ? '/events' : path;
  const L = home.learners;
  if (!G.learner || !L.find((l) => l.id === G.learner)) G.learner = L[0]?.id;
  tabs([['/', 'Home', 'home', G.me.unread > 0], ['/book', 'Book', 'plus'], ['/fees', 'Fees', 'money'], ['/practice', 'Practice', 'note'], ['/events', 'Events', 'star']], p);
  if (p === '/book') return sBook();
  if (p === '/fees') return sFees();
  if (p === '/practice') return sPractice();
  if (p === '/events') return sEvents();
  return sHome();
}
function pendingScreen(home) {
  noTabs();
  A.refresh = () => route();
  render(`<div class="center" style="padding-top:20vh"><div class="av" style="width:56px;height:56px;margin:0 auto;background:var(--warnb);color:var(--warn);font-size:20px">…</div>
    <div class="h" style="margin-top:14px">Waiting for approval</div><div class="sub">${esc(home.membership.studio_name)} will set up your classes, fees and access. You'll get a notification.</div></div>
    <div class="card flush"><div class="row"><span class="k">Username</span><span class="v">${esc(home.membership.username)}</span></div><div class="row"><span class="k">Installed</span><span class="v">✓ This device</span></div></div>
    ${pushCard()}<button class="btn" data-act="refresh">Check again</button>`);
}
const learnerSeg = () => {
  const L = G.home.learners;
  if (L.length < 2) return '';
  A.pickl = (el) => { G.learner = el.dataset.id; route(); };
  return `<div class="seg" style="margin-top:8px">${L.map((l) => `<button type="button" class="${l.id === G.learner ? 'on' : ''}" data-act="pickl" data-id="${l.id}">${esc(first(l.name))}</button>`).join('')}</div>`;
};
const curL = () => G.home.learners.find((l) => l.id === G.learner);

async function sHome() {
  const h = G.home, m = h.membership, l = curL(), tz = m.timezone;
  const mine = h.upcoming.filter((b) => b.learner_id === l.id);
  const next = mine[0];
  const due = h.balances.filter((b) => b.due_minor > 0);
  const notes = G.me.unread ? (await api('GET', '/api/notifications')).items.filter((n) => !n.read_at).slice(0, 4) : [];
  if (notes.length) { api('POST', '/api/notifications/read').catch(() => {}); G.me.unread = 0; }
  setTimeout(() => document.querySelectorAll('.tabs .dot').forEach((d) => d.remove()), 0);
  const canChange = (b) => Date.parse(b.starts_at) - m.change_notice_hours * 3600000 > Date.now();
  A.mv = (el) => { const b = h.upcoming.find((x) => x.id === el.dataset.id); pickTime({ title: `Reschedule ${fmtDay(b.starts_at, tz)}`, minutes: b.minutes, from: localDateOf(b.starts_at, tz), ignore: b.id, learner: l.id,
    onPick: async (date, start_min) => { await api('POST', `/api/s/classes/${b.id}/move`, { date, start_min }); toast('Rescheduled. Your teacher has been told.'); route(); } }); };
  A.cx = async (el) => {
    if (!confirm('Cancel this class?')) return;
    const r = await api('POST', `/api/s/classes/${el.dataset.id}/cancel`); toast(r.credit ? 'Cancelled. You have a make-up credit to book.' : 'Cancelled'); route();
  };
  A.book = () => go('/book');
  const classCard = (b, big) => `<div class="${big ? 'card' : 'ev'}" style="${big ? '' : 'cursor:default'}">
    ${big ? '<div class="sub small">Next class</div>' : ''}<div class="${big ? 'serif' : ''}" style="${big ? 'font-size:21px;margin-top:2px' : ''}">${esc(fmtDay(b.starts_at, tz))} · ${fmtTime(b.starts_at, tz)}</div>
    <div class="meta" style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">${modeChip(b.mode)}<span class="chip">${b.minutes} min</span>${KIND[b.kind]}${b.moved_from ? '<span class="chip">Moved</span>' : ''}</div>
    ${b.mode === 'virtual' && b.meeting_url ? `<a class="btn pri" href="${esc(b.meeting_url)}" target="_blank" rel="noopener">Join online class</a>${m.room_passcode ? `<div class="sub small" style="margin-top:6px">Passcode ${esc(m.room_passcode)}</div>` : ''}` : (b.location ? `<div class="sub" style="margin-top:6px">${esc(b.location)}</div>` : '')}
    ${canChange(b) ? `<div class="btns">${l.can_reschedule ? `<button class="btn sm" style="flex:1;margin-top:10px" data-act="mv" data-id="${b.id}">Reschedule</button>` : ''}<button class="btn sm" style="flex:1;margin-top:10px" data-act="cx" data-id="${b.id}">Cancel</button></div>` : '<div class="sub small" style="margin-top:8px">Changes are closed for this class. Message your teacher if needed.</div>'}</div>`;
  render(`<div class="eyb">${esc(m.studio_name)}</div><div class="h">Hi ${esc(first(l.name))}</div>${learnerSeg()}
    ${notes.map((n) => `<div class="card" style="border-color:var(--info)"><b>${esc(n.title)}</b><div class="sub">${esc(n.body || '')}</div></div>`).join('')}
    ${next ? classCard(next, true) : `<div class="card"><div class="sub">No upcoming classes.</div>${l.open_credits && l.can_book_makeup ? '<button class="btn pri" data-act="book">Book a make-up</button>' : ''}</div>`}
    <div class="card flush"><div class="row"><span class="k">Classes done</span><span class="v">${l.classes_done}</span></div>
      ${l.open_credits ? `<div class="row"><span class="k">Make-up credits</span><span class="v">${l.open_credits}</span></div>` : ''}
      <div class="row"><span class="k">Fees due</span><span class="v">${due.length ? due.map((b) => money(b.due_minor, b.currency)).join(' · ') : money(0, m.currency)}</span></div>
      <div class="row"><span class="k">Changes allowed until</span><span class="v">${m.change_notice_hours}h before class</span></div></div>
    ${pushCard()}
    ${mine.length > 1 ? `<div class="eyb">Coming up</div>${mine.slice(1, 8).map((b) => classCard(b, false)).join('')}` : ''}`);
}

async function sBook() {
  const l = curL(), tz = G.home.membership.timezone;
  const kinds = [l.can_book_makeup && l.open_credits ? ['makeup', `Make-up (${l.open_credits})`] : null, l.can_book_extra ? ['extra', 'Extra class'] : null].filter(Boolean);
  if (!kinds.length) {
    return render(`<div class="eyb">Book</div><div class="h">Book a class</div>${learnerSeg()}<div class="card"><div class="sub">${esc(first(l.name))} has no make-up credits${l.can_book_extra ? '' : ', and extra classes are not enabled'}. Your teacher sets your regular classes.</div></div>`);
  }
  const modes = l.allowed_modes.split(',');
  const st = G.bk = { kind: G.bk?.kind && kinds.some((k) => k[0] === G.bk.kind) ? G.bk.kind : kinds[0][0], minutes: Math.min(G.bk?.minutes || l.max_class_minutes, l.max_class_minutes), mode: modes.includes(G.bk?.mode) ? G.bk.mode : l.default_mode };
  const lengths = []; for (let x = 30; x <= l.max_class_minutes; x += 30) lengths.push([x, `${x} min`]);
  render(`<div class="eyb">Book</div><div class="h">Book a class</div>${learnerSeg()}
    <label class="f"><span>Type</span>${seg('kind', kinds, st.kind)}</label>
    <label class="f"><span>Length</span>${seg('minutes', lengths, st.minutes)}</label>
    ${modes.length > 1 ? `<label class="f"><span>Where</span>${seg('mode', [['physical', 'In person'], ['virtual', 'Online']], st.mode)}</label>` : ''}
    <button class="btn pri" data-act="choose">Choose a time</button>
    <div class="sub small" style="margin-top:10px">${st.kind === 'extra' && l.classes_per_week ? `Up to ${l.classes_per_week} extra class${l.classes_per_week > 1 ? 'es' : ''} a week. ` : ''}Extra and make-up classes are charged like regular classes.</div>`);
  $('#app').querySelectorAll('input[type=hidden]').forEach((i) => i.addEventListener('change', () => { const v = vals($('#app')); G.bk = { kind: v.kind, minutes: +v.minutes, mode: v.mode || st.mode }; }));
  A.choose = () => {
    const v = vals($('#app')), kind = v.kind, minutes = +v.minutes, mode = v.mode || st.mode;
    pickTime({ title: kind === 'makeup' ? 'Book a make-up' : 'Book an extra class', minutes, learner: l.id, onPick: async (date, start_min) => {
      const r = await api('POST', '/api/s/classes', { learner_id: l.id, kind, date, start_min, minutes, mode });
      toast(r.meeting_url ? 'Booked. The join link is on your home screen.' : 'Booked'); go('/');
    } });
  };
}

async function sFees() {
  const r = await api('GET', '/api/s/fees');
  const due = r.balances.filter((b) => b.due_minor !== 0);
  render(`<div class="eyb">Fees · ${esc(G.home.membership.username)}</div>
    <div class="big">${due.length ? due.map((b) => `${money(Math.max(0, b.due_minor), b.currency)} due`).join('<br>') : `${money(0, r.currency)} due`}</div>
    <div class="sub">${due.some((b) => b.due_minor < 0) ? 'You have credit with your teacher.' : 'Fees are added after each class.'}</div>
    <div class="eyb">History</div><div class="card flush">${r.entries.map((e) => `<div class="row"><span class="k">${e.kind === 'payment' ? `Payment${e.method ? ` · ${esc(e.method)}` : ''}` : `${esc(e.learner ? first(e.learner) : '')} · ${esc(e.note || 'Class')}`}<div class="sub small">${esc(fmtDay(e.created_at))}</div></span>
      <span class="v" style="${e.kind === 'payment' ? 'color:var(--ok)' : ''}">${e.kind === 'payment' ? '−' : ''}${money(Math.abs(e.amount_minor), e.currency)}</span></div>`).join('') || '<div class="empty">No fees yet.</div>'}</div>`);
}

async function sPractice() {
  const l = curL();
  const r = await api('GET', `/api/s/practice?learner=${l.id}`);
  const todayLog = r.logs.find((x) => x.day === r.today);
  let minutes = todayLog?.minutes ?? 30;
  const week = [...Array(7)].map((_, i) => addDays(r.today, i - 6));
  const total = r.logs.filter((x) => x.day >= week[0]).reduce((a, x) => a + x.minutes, 0);
  const max = Math.max(30, ...r.logs.filter((x) => x.day >= week[0]).map((x) => x.minutes));
  A.minus = () => { minutes = Math.max(0, minutes - 5); $('#mins').textContent = minutes; };
  A.plus = () => { minutes = Math.min(600, minutes + 5); $('#mins').textContent = minutes; };
  A.save = async () => { await api('PUT', '/api/s/practice', { learner_id: l.id, minutes, notes: $('#pnotes').value }); toast('Practice saved'); sPractice(); };
  render(`<div class="eyb">Practice</div><div class="h">Today</div>${learnerSeg()}
    <label class="f"><span>Minutes practised</span><div class="stepper"><button data-act="minus">−</button><b><span id="mins">${minutes}</span> min</b><button data-act="plus">＋</button></div></label>
    <label class="f"><span>What did you work on?</span><textarea class="in" id="pnotes" placeholder="e.g. Varnam in two speeds">${esc(todayLog?.notes || '')}</textarea></label>
    <div class="sub small" style="margin-top:8px">🔒 Only your teacher can see this</div>
    <button class="btn pri" data-act="save">${todayLog ? 'Update' : 'Save'}</button>
    <div class="eyb">Last 7 days · ${Math.floor(total / 60)}h ${total % 60}m</div>
    <div class="bars">${week.map((d) => { const x = r.logs.find((y) => y.day === d); return `<i class="${x?.minutes ? '' : 'z'}" style="height:${x?.minutes ? Math.max(6, (x.minutes / max) * 100) : 4}%"></i>`; }).join('')}</div>
    <div class="blab">${week.map((d) => `<span>${WD[wdOf(d)][0]}</span>`).join('')}</div>
    ${r.logs.length ? `<div class="card flush" style="margin-top:14px">${r.logs.slice(0, 10).map((x) => `<div class="row"><span class="k">${esc(dayLabel(x.day))}<div class="sub small">${esc(x.notes || '')}</div></span><span class="v">${x.minutes} min</span></div>`).join('')}</div>` : ''}`);
}

async function sEvents() {
  const r = await api('GET', '/api/s/events');
  const tz = G.home.membership.timezone, L = G.home.learners;
  const nameOf = (id) => first(L.find((l) => l.id === id)?.name);
  A.gj = async (el) => { await api('POST', `/api/s/groups/${el.dataset.g}`, { learner_id: el.dataset.l, join: el.dataset.j === '1' }); toast(el.dataset.j === '1' ? 'Joined' : 'Left the group class'); sEvents(); };
  A.rsvp = async (el) => {
    const card = el.closest('[data-e]'), e = r.events.find((x) => x.id === card.dataset.e), v = vals(card);
    const piece = e.collect_pieces ? Object.fromEntries(e.piece_fields.map((f) => [f, v[`p_${f}`]])) : undefined;
    await api('PUT', `/api/s/events/${e.id}`, { learner_id: v.learner, attending: v.att, piece }); toast('Sent to your teacher'); sEvents();
  };
  render(`<div class="eyb">${esc(G.home.membership.studio_name)}</div><div class="h">Events</div>
    ${r.groups.length ? `<div class="eyb">Group classes</div>${r.groups.map((g) => `<div class="ev group" style="cursor:default"><div class="tm">${esc(fmtDay(g.starts_at, tz))} · ${fmtTime(g.starts_at, tz)} – ${fmtTime(g.ends_at, tz)}</div><div>${esc(g.title)}</div>
      ${g.notes ? `<div class="sub small">${esc(g.notes)}</div>` : ''}<div class="meta">${modeChip(g.mode)}${g.fee_minor ? `<span class="chip">${money(g.fee_minor, G.home.membership.currency)}</span>` : ''}</div>
      ${g.eligible_learners.map((id) => { const j = g.joined.includes(id); return `<div class="row"><span>${esc(nameOf(id))}${j ? ' <span class="chip ok">Joined</span>' : ''}</span><button class="btn sm ${j ? '' : 'pri'}" data-act="gj" data-g="${g.id}" data-l="${id}" data-j="${j ? 0 : 1}">${j ? 'Leave' : 'Join'}</button></div>`; }).join('')}
      ${g.mode === 'virtual' && g.meeting_url && g.joined.length ? `<a class="btn" href="${esc(g.meeting_url)}" target="_blank" rel="noopener">Join online</a>` : ''}</div>`).join('')}` : ''}
    <div class="eyb">Events</div>
    ${r.events.length ? r.events.map((e) => {
      const resp = e.responses.find((x) => x.learner_id === G.learner) || e.responses[0] || {};
      return `<div class="card" data-e="${e.id}"><div class="sub small">${esc(e.kind)} · ${esc(fmtDay(e.starts_at, tz))} · ${fmtTime(e.starts_at, tz)}</div><div class="h2" style="margin-top:2px">${esc(e.title)}</div>
        ${e.location ? `<div class="sub">${esc(e.location)}</div>` : ''}${e.description ? `<div style="margin-top:6px">${esc(e.description)}</div>` : ''}
        ${L.length > 1 ? `<label class="f"><span>Responding for</span><select class="in" name="learner">${L.map((l) => `<option value="${l.id}" ${l.id === (resp.learner_id || G.learner) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>` : `<input type="hidden" name="learner" value="${L[0].id}">`}
        ${e.collect_rsvp ? `<label class="f"><span>Are you coming?</span>${seg('att', [['yes', 'Going'], ['maybe', 'Maybe'], ['no', "Can't"]], resp.attending || 'yes')}</label>` : ''}
        ${e.collect_pieces ? e.piece_fields.map((f) => `<label class="f"><span>${esc(f)}</span><input class="in" name="p_${esc(f)}" value="${esc(resp.piece?.[f] || '')}"></label>`).join('') : ''}
        ${e.collect_rsvp || e.collect_pieces ? `<button class="btn pri" data-act="rsvp">${resp.updated_at ? 'Update' : 'Send'}</button>` : ''}</div>`;
    }).join('') : '<div class="empty">No upcoming events.</div>'}`);
}

route();
