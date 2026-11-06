// Tempo API (Cloudflare Worker). Static app files are served from /public by Workers Assets.
import { json, fail, HttpError, uid, token, sha256, normName, cleanName, nowIso, str, int, oneOf, url as urlField, currency, toMinor,
  createSession, getUser, destroySession, notify, getVapid } from './lib.js';
import { BLOCK, freeStarts, weekCount, getRules, makeBooking, bookingStatements, isConflict, generateSeries, settle, balances, blocksFor, resolveRoom, feeFor } from './schedule.js';
import { localToUtc, localDate, localMinutes, weekdayOf, addDays, isDate, iso } from './time.js';

const routes = [];
const on = (method, path, handler, auth = 'any') => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth });
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      // CSRF: every state-changing call must carry a custom header, which other sites cannot send without CORS.
      if (req.method !== 'GET' && req.headers.get('x-tempo') !== '1') fail(403, 'Missing request header');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const user = await getUser(env, req);
        if (r.auth !== 'any' && !user) fail(401, 'Please sign in');
        if (r.auth === 'teacher' && user.kind !== 'teacher') fail(403, 'Teachers only');
        if (r.auth === 'student' && user.kind !== 'student') fail(403, 'Students only');
        let body = {};
        if (req.method !== 'GET') {
          const text = await req.text();
          if (text.trim()) { try { body = JSON.parse(text); } catch { fail(400, 'Invalid JSON'); } }
          if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Invalid JSON');
        }
        const c = { req, env, ctx, url, params, user, body, q: url.searchParams };
        if (r.auth === 'teacher' && params.sid) c.studio = await ownStudio(c, params.sid);
        if (r.auth === 'student') c.m = await studentMembership(c);
        return await r.handler(c);
      }
      fail(404, 'Not found');
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
      console.log(e.stack || e);
      return json({ error: 'Something went wrong' }, 500);
    }
  },
};

// ---------- context helpers ----------
async function ownStudio(c, sid) {
  const s = await c.env.DB.prepare('SELECT * FROM studios WHERE id = ? AND owner_user_id = ?').bind(sid, c.user.id).first();
  if (!s) fail(404, 'Studio not found');
  return s;
}
async function studentMembership(c) {
  const wanted = c.q.get('studio');
  const m = await c.env.DB.prepare(`SELECT m.*, s.name studio_name, s.timezone, s.default_currency, s.change_notice_hours, s.booking_notice_hours,
      s.booking_horizon_days, s.studio_address, s.student_cancel_credit, s.makeup_expiry_days, s.owner_user_id, s.slug, s.id studio_id
      FROM memberships m JOIN studios s ON s.id = m.studio_id
      WHERE m.user_id = ? AND m.role = 'student' AND m.status <> 'removed' ${wanted ? 'AND s.id = ?' : ''} ORDER BY m.created_at LIMIT 1`)
    .bind(...(wanted ? [c.user.id, wanted] : [c.user.id])).first();
  if (!m) fail(404, 'No studio membership');
  return m;
}
const studioOf = (m) => ({ id: m.studio_id, timezone: m.timezone, default_currency: m.default_currency, booking_notice_hours: m.booking_notice_hours,
  booking_horizon_days: m.booking_horizon_days, studio_address: m.studio_address });
function requireActive(c) { if (c.m.status !== 'active') fail(403, 'Your account is waiting for approval'); }
async function myLearner(c, learnerId) {
  const l = await c.env.DB.prepare('SELECT * FROM learners WHERE id = ? AND membership_id = ? AND active = 1').bind(learnerId, c.m.id).first();
  if (!l) fail(404, 'Learner not found on this account');
  return l;
}
async function studioLearner(c, learnerId) {
  const l = await c.env.DB.prepare(`SELECT l.*, m.user_id, m.status member_status FROM learners l JOIN memberships m ON m.id = l.membership_id
     WHERE l.id = ? AND l.studio_id = ?`).bind(learnerId, c.studio.id).first();
  if (!l) fail(404, 'Learner not found');
  return l;
}
const horizonDate = (studio) => addDays(localDate(Date.now(), studio.timezone), Math.max(28, studio.booking_horizon_days || 28));
const fmtWhen = (isoStr, tz) => new Date(isoStr).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

// =====================================================================
// Session, identity, notifications
// =====================================================================
on('GET', '/api/me', async (c) => {
  if (!c.user) return json({ user: null, dev: c.env.DEV_MODE === '1', google: !!c.env.GOOGLE_CLIENT_ID });
  const studios = (await c.env.DB.prepare(`SELECT s.id, s.name, s.slug, s.join_code, m.role, m.status, m.id membership_id, m.username, m.is_shared
      FROM memberships m JOIN studios s ON s.id = m.studio_id WHERE m.user_id = ? AND m.status <> 'removed' ORDER BY m.created_at`).bind(c.user.id).all()).results;
  const unread = (await c.env.DB.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').bind(c.user.id).first()).n;
  return json({ user: { id: c.user.id, kind: c.user.kind, name: c.user.display_name, email: c.user.email }, studios, unread, vapid: (await getVapid(c.env)).publicKey });
});
on('POST', '/api/logout', async (c) => json({ ok: true }, 200, { 'set-cookie': await destroySession(c.env, c.req) }));

on('GET', '/api/notifications', async (c) => json({ items: (await c.env.DB.prepare(
  'SELECT id, title, body, url, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(c.user.id).all()).results }), 'user');
on('POST', '/api/notifications/read', async (c) => {
  await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(nowIso(), c.user.id).run();
  return json({ ok: true });
}, 'user');
on('POST', '/api/push/subscribe', async (c) => {
  const s = c.body;
  const endpoint = urlField(s.endpoint, 'endpoint');
  const p256dh = str(s.keys?.p256dh, 'p256dh', { max: 200 }), auth = str(s.keys?.auth, 'auth', { max: 100 });
  await c.env.DB.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`).bind(endpoint, c.user.id, p256dh, auth).run();
  return json({ ok: true });
}, 'user');

// =====================================================================
// Teacher sign-in (Google). DEV_MODE adds a local-only shortcut for testing.
// =====================================================================
on('GET', '/api/auth/google', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) fail(501, 'Google sign-in is not configured');
  const state = token();
  await c.env.DB.prepare('INSERT INTO oauth_states (state) VALUES (?)').bind(state).run();
  const p = new URLSearchParams({ client_id: c.env.GOOGLE_CLIENT_ID, redirect_uri: `${c.url.origin}/api/auth/google/callback`, response_type: 'code',
    scope: 'openid email profile', state, prompt: 'select_account' });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`, 302);
});
on('GET', '/api/auth/google/callback', async (c) => {
  const state = c.q.get('state'), code = c.q.get('code');
  const row = state && await c.env.DB.prepare("SELECT * FROM oauth_states WHERE state = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')").bind(state).first();
  await c.env.DB.prepare('DELETE FROM oauth_states WHERE state = ? OR created_at < strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\',\'-1 day\')').bind(state || '').run();
  if (!row || !code) return Response.redirect(`${c.url.origin}/?error=signin`, 302);
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET, redirect_uri: `${c.url.origin}/api/auth/google/callback`, grant_type: 'authorization_code' }) });
  const tok = await res.json();
  if (!tok.id_token) return Response.redirect(`${c.url.origin}/?error=signin`, 302);
  // The ID token came straight from Google's token endpoint over TLS, so its claims can be read directly.
  const claims = JSON.parse(atob(tok.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  if (claims.aud !== c.env.GOOGLE_CLIENT_ID || !claims.email_verified) return Response.redirect(`${c.url.origin}/?error=signin`, 302);
  const allowed = (c.env.TEACHER_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(claims.email.toLowerCase())) return Response.redirect(`${c.url.origin}/?error=not_teacher`, 302);
  const user = await upsertTeacher(c.env, { sub: claims.sub, email: claims.email, name: claims.name || claims.email });
  return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': await createSession(c.env, user.id, c.req.headers.get('user-agent')) } });
});
async function upsertTeacher(env, { sub, email, name }) {
  let u = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ? OR email = ?').bind(sub, email).first();
  if (!u) {
    u = { id: uid('u') };
    await env.DB.prepare("INSERT INTO users (id, kind, display_name, email, google_sub) VALUES (?, 'teacher', ?, ?, ?)").bind(u.id, name, email, sub).run();
  }
  return u;
}
on('POST', '/api/dev/teacher', async (c) => {
  if (c.env.DEV_MODE !== '1') fail(404, 'Not found');
  const email = str(c.body.email, 'email'), name = str(c.body.name, 'name');
  const user = await upsertTeacher(c.env, { sub: `dev:${email}`, email, name });
  return json({ ok: true }, 200, { 'set-cookie': await createSession(c.env, user.id, 'dev') });
});

// =====================================================================
// Public studio info + student onboarding (install-gated) + device sign-in
// =====================================================================
async function studioByCode(env, code) {
  const c = String(code || '').trim();
  return env.DB.prepare('SELECT s.*, u.display_name teacher_name FROM studios s JOIN users u ON u.id = s.owner_user_id WHERE s.join_code = ? OR s.slug = ?')
    .bind(c.toUpperCase(), c.toLowerCase()).first();
}
on('GET', '/api/studio/:code', async (c) => {
  const s = await studioByCode(c.env, c.params.code);
  if (!s) fail(404, 'No studio with that code');
  return json({ id: s.id, name: s.name, slug: s.slug, join_code: s.join_code, teacher_name: s.teacher_name, join_open: !!s.join_open });
});

on('POST', '/api/join', async (c) => {
  if (c.req.headers.get('x-tempo-installed') !== '1') fail(412, 'Install Tempo on your home screen first, then join from the installed app.');
  const s = await studioByCode(c.env, c.body.code);
  if (!s) fail(404, 'No studio with that code');
  if (!s.join_open) fail(403, `${s.name} is not accepting new students right now`);
  const fullName = cleanName(str(c.body.full_name, 'Full name', { min: 3, max: 80 }));
  if (!fullName.includes(' ')) fail(400, 'Please enter your full name (first and last)');
  const shared = !!c.body.shared;
  let names = [fullName];
  if (shared) {
    const extra = (Array.isArray(c.body.learners) ? c.body.learners : []).map((n) => cleanName(n)).filter(Boolean);
    names = [...new Set([fullName, ...extra].map((n) => str(n, 'Learner name', { min: 2, max: 80 })))];
    if (names.length < 2) fail(400, 'A shared account needs at least two learners');
    if (names.length > 8) fail(400, 'A shared account can have up to 8 learners');
    if (c.body.confirm_shared !== true) fail(400, 'Please confirm who shares this account');
  }
  const taken = await c.env.DB.prepare("SELECT 1 FROM memberships WHERE studio_id = ? AND username_norm = ? AND status <> 'removed'").bind(s.id, normName(fullName)).first();
  if (taken) fail(409, 'That name is already registered in this studio. If it is you, choose “I already have an account”.');
  const userId = uid('u'), mid = uid('m');
  const stmts = [
    c.env.DB.prepare("INSERT INTO users (id, kind, display_name) VALUES (?, 'student', ?)").bind(userId, fullName),
    c.env.DB.prepare(`INSERT INTO memberships (id, studio_id, user_id, role, username, username_norm, is_shared, currency, status)
      VALUES (?,?,?, 'student', ?, ?, ?, ?, 'pending')`).bind(mid, s.id, userId, fullName, normName(fullName), shared ? 1 : 0, s.default_currency),
  ];
  for (const n of names) {
    const lid = uid('l');
    stmts.push(c.env.DB.prepare('INSERT INTO learners (id, membership_id, studio_id, name) VALUES (?,?,?,?)').bind(lid, mid, s.id, n));
    stmts.push(c.env.DB.prepare('INSERT INTO learner_rules (learner_id) VALUES (?)').bind(lid));
  }
  try { await c.env.DB.batch(stmts); } catch (e) { if (isConflict(e)) fail(409, 'That name was just registered. Try “I already have an account”.'); throw e; }
  await notify(c.env, c.ctx, s.id, [s.owner_user_id], { title: 'New student waiting', body: `${fullName}${shared ? ` · shared by ${names.length}` : ''} wants to join ${s.name}`, url: '/students' });
  return json({ ok: true, status: 'pending' }, 200, { 'set-cookie': await createSession(c.env, userId, c.req.headers.get('user-agent')) });
});

on('POST', '/api/signin', async (c) => {
  if (c.req.headers.get('x-tempo-installed') !== '1') fail(412, 'Open Tempo from your home screen to sign in.');
  const s = await studioByCode(c.env, c.body.code);
  if (!s) fail(404, 'No studio with that code');
  const m = await c.env.DB.prepare("SELECT * FROM memberships WHERE studio_id = ? AND username_norm = ? AND status <> 'removed'").bind(s.id, normName(c.body.full_name)).first();
  if (!m) fail(404, 'No account with that full name in this studio');
  const recent = await c.env.DB.prepare("SELECT COUNT(*) n FROM signin_requests WHERE membership_id = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')").bind(m.id).first();
  if (recent.n >= 5) fail(429, 'Too many sign-in requests. Please ask your teacher.');
  const id = uid('sr'), secret = token();
  await c.env.DB.prepare('INSERT INTO signin_requests (id, studio_id, membership_id, secret_hash, device) VALUES (?,?,?,?,?)')
    .bind(id, s.id, m.id, await sha256(secret), (c.req.headers.get('user-agent') || '').slice(0, 120)).run();
  await notify(c.env, c.ctx, s.id, [s.owner_user_id], { title: 'Sign-in request', body: `${m.username} is signing in on a new device`, url: '/students' });
  return json({ id, secret, teacher_name: s.teacher_name });
});
on('POST', '/api/signin/:id/poll', async (c) => {
  const r = await c.env.DB.prepare('SELECT r.*, m.user_id FROM signin_requests r JOIN memberships m ON m.id = r.membership_id WHERE r.id = ?').bind(c.params.id).first();
  if (!r || r.secret_hash !== await sha256(String(c.body.secret || ''))) fail(404, 'Request not found');
  if (r.status !== 'approved') return json({ status: r.status });
  await c.env.DB.prepare("UPDATE signin_requests SET status = 'used' WHERE id = ?").bind(r.id).run();
  return json({ status: 'approved' }, 200, { 'set-cookie': await createSession(c.env, r.user_id, r.device) });
});

// =====================================================================
// Teacher: studio
// =====================================================================
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
on('POST', '/api/studios', async (c) => {
  const name = str(c.body.name, 'Studio name', { max: 60 });
  const teacherName = c.body.teacher_name ? cleanName(str(c.body.teacher_name, 'Your name', { max: 80 })) : null;
  const slug = String(c.body.slug || name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!SLUG.test(slug)) fail(400, 'Studio link must be 3-40 letters, numbers or dashes');
  const code = (c.body.join_code ? String(c.body.join_code) : slug.replace(/-/g, '')).toUpperCase().slice(0, 12);
  if (!/^[A-Z0-9]{4,12}$/.test(code)) fail(400, 'Studio code must be 4-12 letters or numbers');
  const tz = c.body.timezone || 'Asia/Singapore';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { fail(400, 'Unknown time zone'); }
  const cur = currency(c.body.currency || 'SGD');
  const id = uid('s');
  const stmts = [
    c.env.DB.prepare('INSERT INTO studios (id, owner_user_id, name, slug, join_code, timezone, default_currency, studio_address) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, c.user.id, name, slug, code, tz, cur, c.body.studio_address ? str(c.body.studio_address, 'Address', { max: 200 }) : null),
    c.env.DB.prepare("INSERT INTO memberships (id, studio_id, user_id, role, status, approved_at) VALUES (?,?,?, 'teacher', 'active', ?)").bind(uid('m'), id, c.user.id, nowIso()),
  ];
  if (teacherName) stmts.push(c.env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(teacherName, c.user.id));
  try { await c.env.DB.batch(stmts); } catch (e) { if (isConflict(e)) fail(409, 'That studio link or code is taken. Try another.'); throw e; }
  return json({ id, slug, join_code: code, link: `${c.url.origin}/s/${slug}` });
}, 'teacher');

on('GET', '/api/t/:sid', async (c) => json({ studio: c.studio, link: `${c.url.origin}/s/${c.studio.slug}`,
  availability: (await c.env.DB.prepare('SELECT weekday, start_min, end_min FROM availability WHERE studio_id = ? ORDER BY weekday, start_min').bind(c.studio.id).all()).results,
  rooms: (await c.env.DB.prepare('SELECT id, provider, kind, label, url, passcode, is_default, active FROM meeting_rooms WHERE studio_id = ? AND active = 1 ORDER BY is_default DESC, created_at').bind(c.studio.id).all()).results,
}), 'teacher');

on('PATCH', '/api/t/:sid', async (c) => {
  const b = c.body, s = c.studio, sets = [], vals = [];
  const put = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
  if (b.name !== undefined) put('name', str(b.name, 'Studio name', { max: 60 }));
  if (b.join_open !== undefined) put('join_open', b.join_open ? 1 : 0);
  if (b.default_currency !== undefined) put('default_currency', currency(b.default_currency));
  if (b.studio_address !== undefined) put('studio_address', str(b.studio_address, 'Address', { max: 200, optional: true }));
  if (b.change_notice_hours !== undefined) put('change_notice_hours', int(b.change_notice_hours, 'Change notice', { min: 0, max: 168 }));
  if (b.booking_notice_hours !== undefined) put('booking_notice_hours', int(b.booking_notice_hours, 'Booking notice', { min: 0, max: 168 }));
  if (b.booking_horizon_days !== undefined) put('booking_horizon_days', int(b.booking_horizon_days, 'Booking horizon', { min: 1, max: 120 }));
  if (b.student_cancel_credit !== undefined) put('student_cancel_credit', b.student_cancel_credit ? 1 : 0);
  if (b.makeup_expiry_days !== undefined) put('makeup_expiry_days', int(b.makeup_expiry_days, 'Make-up expiry', { min: 1, max: 365, optional: true }));
  if (!sets.length) fail(400, 'Nothing to update');
  await c.env.DB.prepare(`UPDATE studios SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, s.id).run();
  return json({ ok: true });
}, 'teacher');

on('PUT', '/api/t/:sid/availability', async (c) => {
  const rows = Array.isArray(c.body.windows) ? c.body.windows : fail(400, 'windows must be a list');
  const clean = rows.map((w, i) => {
    const wd = int(w.weekday, `Day ${i + 1}`, { min: 0, max: 6 });
    const a = int(w.start_min, 'Start', { min: 0, max: 1440 }), b = int(w.end_min, 'End', { min: 0, max: 1440 });
    if (a % BLOCK || b % BLOCK) fail(400, 'Times must be on the hour or half hour');
    if (b <= a) fail(400, 'End must be after start');
    return [wd, a, b];
  });
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM availability WHERE studio_id = ?').bind(c.studio.id),
    ...clean.map(([wd, a, b]) => c.env.DB.prepare('INSERT INTO availability (id, studio_id, weekday, start_min, end_min) VALUES (?,?,?,?,?)').bind(uid('av'), c.studio.id, wd, a, b))]);
  return json({ ok: true });
}, 'teacher');

// Online classrooms (fixed links in v1; generated Zoom/Meet/Teams come with account connections)
on('POST', '/api/t/:sid/rooms', async (c) => {
  const id = uid('r');
  const label = str(c.body.label, 'Name', { max: 60 }), link = urlField(c.body.url, 'Meeting link');
  const first = !(await c.env.DB.prepare('SELECT 1 FROM meeting_rooms WHERE studio_id = ? AND active = 1').bind(c.studio.id).first());
  await c.env.DB.prepare("INSERT INTO meeting_rooms (id, studio_id, provider, kind, label, url, passcode, is_default) VALUES (?,?, 'fixed_link', 'fixed', ?, ?, ?, ?)")
    .bind(id, c.studio.id, label, link, str(c.body.passcode, 'Passcode', { max: 40, optional: true }), first || c.body.is_default ? 1 : 0).run();
  if (c.body.is_default && !first) await c.env.DB.prepare('UPDATE meeting_rooms SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE studio_id = ?').bind(id, c.studio.id).run();
  return json({ id });
}, 'teacher');
on('DELETE', '/api/t/:sid/rooms/:rid', async (c) => {
  await c.env.DB.prepare('UPDATE meeting_rooms SET active = 0, is_default = 0 WHERE id = ? AND studio_id = ?').bind(c.params.rid, c.studio.id).run();
  return json({ ok: true });
}, 'teacher');

// =====================================================================
// Teacher: students, approvals, permissions
// =====================================================================
on('GET', '/api/t/:sid/students', async (c) => {
  await settle(c.env, c.studio);
  const members = (await c.env.DB.prepare(`SELECT id, username, is_shared, currency, status, created_at, approved_at FROM memberships
      WHERE studio_id = ? AND role = 'student' AND status <> 'removed' ORDER BY status = 'active', created_at DESC`).bind(c.studio.id).all()).results;
  const learners = (await c.env.DB.prepare(`SELECT l.id, l.membership_id, l.name, l.active, r.*, lr.room_id,
      (SELECT COUNT(*) FROM bookings b WHERE b.learner_id = l.id AND b.status IN ('completed','no_show')) AS classes_done,
      (SELECT COUNT(*) FROM makeup_credits mc WHERE mc.learner_id = l.id AND mc.status = 'open') AS open_credits
      FROM learners l JOIN learner_rules r ON r.learner_id = l.id LEFT JOIN learner_rooms lr ON lr.learner_id = l.id
      WHERE l.studio_id = ? ORDER BY l.created_at`).bind(c.studio.id).all()).results;
  const bal = await balances(c.env, c.studio.id);
  const series = (await c.env.DB.prepare('SELECT * FROM class_series WHERE studio_id = ? AND active = 1').bind(c.studio.id).all()).results;
  const requests = (await c.env.DB.prepare(`SELECT r.id, r.created_at, r.device, m.username FROM signin_requests r JOIN memberships m ON m.id = r.membership_id
      WHERE r.studio_id = ? AND r.status = 'pending' AND r.created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') ORDER BY r.created_at DESC`).bind(c.studio.id).all()).results;
  return json({
    members: members.map((m) => ({ ...m, learners: learners.filter((l) => l.membership_id === m.id).map((l) => ({ ...l, series: series.filter((s) => s.learner_id === l.id) })),
      balances: bal.filter((b) => b.membership_id === m.id) })),
    signin_requests: requests,
  });
}, 'teacher');

on('PATCH', '/api/t/:sid/members/:mid', async (c) => {
  const m = await c.env.DB.prepare("SELECT * FROM memberships WHERE id = ? AND studio_id = ? AND role = 'student'").bind(c.params.mid, c.studio.id).first();
  if (!m) fail(404, 'Student not found');
  const b = c.body, stmts = [];
  if (b.currency !== undefined) stmts.push(c.env.DB.prepare('UPDATE memberships SET currency = ? WHERE id = ?').bind(currency(b.currency), m.id));
  if (b.is_shared !== undefined) stmts.push(c.env.DB.prepare('UPDATE memberships SET is_shared = ? WHERE id = ?').bind(b.is_shared ? 1 : 0, m.id));
  if (b.status === 'active' && m.status === 'pending') stmts.push(c.env.DB.prepare("UPDATE memberships SET status = 'active', approved_at = ? WHERE id = ?").bind(nowIso(), m.id));
  if (b.status === 'removed') {
    stmts.push(c.env.DB.prepare("UPDATE memberships SET status = 'removed' WHERE id = ?").bind(m.id));
    stmts.push(c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(m.user_id));
    stmts.push(c.env.DB.prepare('UPDATE class_series SET active = 0 WHERE learner_id IN (SELECT id FROM learners WHERE membership_id = ?)').bind(m.id));
    stmts.push(c.env.DB.prepare('DELETE FROM booking_blocks WHERE booking_id IN (SELECT id FROM bookings WHERE membership_id = ? AND status = \'confirmed\' AND starts_at > ?)').bind(m.id, nowIso()));
    stmts.push(c.env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_by = 'teacher', updated_at = ? WHERE membership_id = ? AND status = 'confirmed' AND starts_at > ?").bind(nowIso(), m.id, nowIso()));
  }
  if (!stmts.length) fail(400, 'Nothing to update');
  await c.env.DB.batch(stmts);
  if (b.status === 'active' && m.status === 'pending') {
    await notify(c.env, c.ctx, c.studio.id, [m.user_id], { title: "You're in!", body: `${c.studio.name} approved your account.`, url: '/' });
  }
  return json({ ok: true });
}, 'teacher');

on('POST', '/api/t/:sid/members/:mid/learners', async (c) => {
  const m = await c.env.DB.prepare("SELECT * FROM memberships WHERE id = ? AND studio_id = ? AND role = 'student'").bind(c.params.mid, c.studio.id).first();
  if (!m) fail(404, 'Student not found');
  const lid = uid('l');
  await c.env.DB.batch([c.env.DB.prepare('INSERT INTO learners (id, membership_id, studio_id, name) VALUES (?,?,?,?)').bind(lid, m.id, c.studio.id, cleanName(str(c.body.name, 'Name', { max: 80 }))),
    c.env.DB.prepare('INSERT INTO learner_rules (learner_id) VALUES (?)').bind(lid), c.env.DB.prepare('UPDATE memberships SET is_shared = 1 WHERE id = ?').bind(m.id)]);
  return json({ id: lid });
}, 'teacher');

on('PATCH', '/api/t/:sid/learners/:lid', async (c) => {
  const l = await studioLearner(c, c.params.lid);
  const b = c.body, stmts = [];
  if (b.name !== undefined) stmts.push(c.env.DB.prepare('UPDATE learners SET name = ? WHERE id = ?').bind(cleanName(str(b.name, 'Name', { max: 80 })), l.id));
  if (b.active !== undefined) stmts.push(c.env.DB.prepare('UPDATE learners SET active = ? WHERE id = ?').bind(b.active ? 1 : 0, l.id));
  if (b.rules) {
    const r = b.rules, cur = await c.env.DB.prepare('SELECT currency FROM memberships WHERE id = ?').bind(l.membership_id).first();
    const sets = [], vals = [];
    const put = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
    if (r.max_class_minutes !== undefined) { const v = int(r.max_class_minutes, 'Class length', { min: 30, max: 240 }); if (v % BLOCK) fail(400, 'Class length must be in 30-minute steps'); put('max_class_minutes', v); }
    if (r.classes_per_week !== undefined) put('classes_per_week', int(r.classes_per_week, 'Extra classes per week', { min: 0, max: 14 }));
    if (r.fee !== undefined) put('fee_minor', toMinor(r.fee, cur.currency, 'Fee'));
    if (r.fee_basis !== undefined) put('fee_basis', oneOf(r.fee_basis, 'Fee basis', ['per_class', 'per_30min']));
    if (r.group_eligible !== undefined) put('group_eligible', r.group_eligible ? 1 : 0);
    for (const k of ['can_reschedule', 'can_book_extra', 'can_book_makeup']) if (r[k] !== undefined) put(k, r[k] ? 1 : 0);
    if (r.allowed_modes !== undefined) {
      const modes = [...new Set(String(r.allowed_modes).split(',').filter(Boolean))];
      if (!modes.length || modes.some((m) => !['physical', 'virtual'].includes(m))) fail(400, 'Modes must be physical and/or virtual');
      put('allowed_modes', modes.join(','));
    }
    if (r.default_mode !== undefined) put('default_mode', oneOf(r.default_mode, 'Default mode', ['physical', 'virtual']));
    if (sets.length) stmts.push(c.env.DB.prepare(`UPDATE learner_rules SET ${sets.join(', ')}, updated_at = ? WHERE learner_id = ?`).bind(...vals, nowIso(), l.id));
  }
  if (b.room_id !== undefined) {
    if (b.room_id) {
      const room = await c.env.DB.prepare('SELECT id FROM meeting_rooms WHERE id = ? AND studio_id = ? AND active = 1').bind(b.room_id, c.studio.id).first();
      if (!room) fail(404, 'Room not found');
      stmts.push(c.env.DB.prepare('INSERT INTO learner_rooms (learner_id, room_id) VALUES (?,?) ON CONFLICT(learner_id) DO UPDATE SET room_id = excluded.room_id').bind(l.id, room.id));
    } else stmts.push(c.env.DB.prepare('DELETE FROM learner_rooms WHERE learner_id = ?').bind(l.id));
  }
  if (!stmts.length) fail(400, 'Nothing to update');
  await c.env.DB.batch(stmts);
  return json({ ok: true });
}, 'teacher');

on('POST', '/api/t/:sid/signin-requests/:rid', async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM signin_requests WHERE id = ? AND studio_id = ? AND status = 'pending'").bind(c.params.rid, c.studio.id).first();
  if (!r) fail(404, 'Request not found');
  await c.env.DB.prepare('UPDATE signin_requests SET status = ? WHERE id = ?').bind(c.body.approve ? 'approved' : 'denied', r.id).run();
  return json({ ok: true });
}, 'teacher');

// =====================================================================
// Teacher: timetable and classes
// =====================================================================
function parseLocal(b, studio) {
  const date = isDate(b.date) ? b.date : fail(400, 'date must be YYYY-MM-DD');
  const start = int(b.start_min, 'Start time', { min: 0, max: 1439 });
  if (start % BLOCK) fail(400, 'Classes start on the hour or half hour');
  return { date, start_min: start };
}
function parseMinutes(v, max = 240) {
  const m = int(v, 'Length', { min: BLOCK, max });
  if (m % BLOCK) fail(400, 'Length must be in 30-minute blocks');
  return m;
}

on('POST', '/api/t/:sid/series', async (c) => {
  const l = await studioLearner(c, c.body.learner_id);
  if (l.member_status !== 'active') fail(409, 'Approve this student first');
  const weekday = int(c.body.weekday, 'Day', { min: 0, max: 6 });
  const start = int(c.body.start_min, 'Start time', { min: 0, max: 1439 });
  if (start % BLOCK) fail(400, 'Classes start on the hour or half hour');
  const minutes = parseMinutes(c.body.minutes);
  const mode = oneOf(c.body.mode, 'Mode', ['physical', 'virtual'], 'physical');
  if (mode === 'virtual') await resolveRoom(c.env, c.studio, l.id, c.body.room_id);
  const startsOn = isDate(c.body.starts_on) ? c.body.starts_on : localDate(Date.now(), c.studio.timezone);
  const endsOn = c.body.ends_on ? (isDate(c.body.ends_on) ? c.body.ends_on : fail(400, 'ends_on must be YYYY-MM-DD')) : null;
  const id = uid('cs');
  await c.env.DB.prepare('INSERT INTO class_series (id, studio_id, learner_id, weekday, start_min, minutes, mode, room_id, starts_on, ends_on) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, c.studio.id, l.id, weekday, start, minutes, mode, c.body.room_id || null, startsOn, endsOn).run();
  const skipped = await generateSeries(c.env, c.studio, horizonDate(c.studio));
  const when = `${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][weekday]} at ${hm(start)}`;
  await notify(c.env, c.ctx, c.studio.id, [l.user_id], { title: 'Class timetable set', body: `${l.name}: ${when}, ${minutes} min${mode === 'virtual' ? ', online' : ''}`, url: '/' });
  return json({ id, skipped: skipped.filter((s) => s.series_id === id) });
}, 'teacher');

on('DELETE', '/api/t/:sid/series/:id', async (c) => {
  const s = await c.env.DB.prepare('SELECT * FROM class_series WHERE id = ? AND studio_id = ?').bind(c.params.id, c.studio.id).first();
  if (!s) fail(404, 'Timetable slot not found');
  const now = nowIso();
  await c.env.DB.batch([c.env.DB.prepare('UPDATE class_series SET active = 0 WHERE id = ?').bind(s.id),
    c.env.DB.prepare("DELETE FROM booking_blocks WHERE booking_id IN (SELECT id FROM bookings WHERE series_id = ? AND status = 'confirmed' AND starts_at > ?)").bind(s.id, now),
    c.env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_by = 'teacher', updated_at = ? WHERE series_id = ? AND status = 'confirmed' AND starts_at > ?").bind(now, s.id, now)]);
  return json({ ok: true });
}, 'teacher');

on('GET', '/api/t/:sid/calendar', async (c) => {
  const from = isDate(c.q.get('from')) ? c.q.get('from') : localDate(Date.now(), c.studio.timezone);
  const days = Math.min(42, Math.max(1, Number(c.q.get('days')) || 7));
  await generateSeries(c.env, c.studio, horizonDate(c.studio));
  await settle(c.env, c.studio);
  const a = iso(localToUtc(from, 0, c.studio.timezone)), b = iso(localToUtc(addDays(from, days), 0, c.studio.timezone));
  const classes = (await c.env.DB.prepare(`SELECT b.id, b.starts_at, b.ends_at, b.minutes, b.kind, b.status, b.mode, b.meeting_url, b.location, b.moved_from, b.cancelled_by,
      l.name learner, l.id learner_id, m.username account FROM bookings b JOIN learners l ON l.id = b.learner_id JOIN memberships m ON m.id = b.membership_id
      WHERE b.studio_id = ? AND b.starts_at >= ? AND b.starts_at < ? ORDER BY b.starts_at`).bind(c.studio.id, a, b).all()).results;
  const groups = (await c.env.DB.prepare(`SELECT g.*, (SELECT COUNT(*) FROM group_signups s WHERE s.group_id = g.id AND s.status = 'joined') joined
      FROM group_classes g WHERE g.studio_id = ? AND g.starts_at >= ? AND g.starts_at < ? ORDER BY g.starts_at`).bind(c.studio.id, a, b).all()).results;
  const off = (await c.env.DB.prepare('SELECT * FROM time_off WHERE studio_id = ? AND ends_at > ? AND starts_at < ?').bind(c.studio.id, a, b).all()).results;
  return json({ from, days, timezone: c.studio.timezone, classes, groups, time_off: off });
}, 'teacher');

on('GET', '/api/t/:sid/free', async (c) => {
  const date = isDate(c.q.get('date')) ? c.q.get('date') : fail(400, 'date required');
  return json({ starts: await freeStarts(c.env, c.studio, date, parseMinutes(c.q.get('minutes') || 30), { ignoreBookingId: c.q.get('ignore') || undefined }) });
}, 'teacher');

on('POST', '/api/t/:sid/classes', async (c) => {
  const l = await studioLearner(c, c.body.learner_id);
  const { date, start_min } = parseLocal(c.body, c.studio);
  const minutes = parseMinutes(c.body.minutes);
  const kind = oneOf(c.body.kind, 'Kind', ['regular', 'extra', 'makeup'], 'regular');
  const mode = oneOf(c.body.mode, 'Mode', ['physical', 'virtual'], 'physical');
  const b = await makeBooking(c.env, c.studio, l, { date, start_min, minutes, kind, mode, room_id: c.body.room_id, created_by: c.user.id });
  try { await c.env.DB.batch(bookingStatements(c.env, b)); } catch (e) { if (isConflict(e)) fail(409, 'That time overlaps another class'); throw e; }
  await notify(c.env, c.ctx, c.studio.id, [l.user_id], { title: 'Class scheduled', body: `${l.name}: ${fmtWhen(b.starts_at, c.studio.timezone)}, ${minutes} min`, url: '/' });
  return json({ id: b.id });
}, 'teacher');

on('PATCH', '/api/t/:sid/classes/:bid', async (c) => {
  const b = await c.env.DB.prepare(`SELECT b.*, l.name learner, m.user_id FROM bookings b JOIN learners l ON l.id = b.learner_id JOIN memberships m ON m.id = b.membership_id
     WHERE b.id = ? AND b.studio_id = ?`).bind(c.params.bid, c.studio.id).first();
  if (!b) fail(404, 'Class not found');
  const action = oneOf(c.body.action, 'Action', ['cancel', 'move', 'no_show', 'completed']);
  const now = nowIso(), tz = c.studio.timezone;
  if (action === 'cancel') {
    if (b.status !== 'confirmed') fail(409, 'Only upcoming classes can be cancelled');
    const stmts = [c.env.DB.prepare('DELETE FROM booking_blocks WHERE booking_id = ?').bind(b.id),
      c.env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_by = 'teacher', updated_at = ? WHERE id = ?").bind(now, b.id)];
    const credit = c.body.credit !== false;
    if (credit) stmts.push(creditStmt(c.env, c.studio, b, c.body.reason || 'Cancelled by teacher'));
    await c.env.DB.batch(stmts);
    await notify(c.env, c.ctx, c.studio.id, [b.user_id], { title: 'Class cancelled', body: `${b.learner}: ${fmtWhen(b.starts_at, tz)} is cancelled${credit ? '. A make-up credit was added.' : '.'}`, url: '/' });
  } else if (action === 'move') {
    if (b.status !== 'confirmed') fail(409, 'Only upcoming classes can be moved');
    const { date, start_min } = parseLocal(c.body, c.studio);
    await moveBooking(c, b, date, start_min);
    await notify(c.env, c.ctx, c.studio.id, [b.user_id], { title: 'Class moved', body: `${b.learner}: now ${fmtWhen(iso(localToUtc(date, start_min, tz)), tz)}`, url: '/' });
  } else {
    if (b.starts_at > now) fail(409, 'This class has not happened yet');
    await c.env.DB.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').bind(action, now, b.id).run();
    if (action === 'no_show') {
      const rules = await getRules(c.env, b.learner_id), m = await c.env.DB.prepare('SELECT currency FROM memberships WHERE id = ?').bind(b.membership_id).first();
      const amt = feeFor(rules, b.minutes);
      if (amt > 0) await c.env.DB.prepare(`INSERT OR IGNORE INTO ledger (id, studio_id, membership_id, learner_id, kind, amount_minor, currency, booking_id, note, created_by)
        VALUES (?,?,?,?, 'charge', ?, ?, ?, 'Missed class', ?)`).bind(uid('lg'), c.studio.id, b.membership_id, b.learner_id, amt, m.currency || c.studio.default_currency, b.id, c.user.id).run();
    }
  }
  return json({ ok: true });
}, 'teacher');

function creditStmt(env, studio, b, reason) {
  const expires = studio.makeup_expiry_days ? addDays(localDate(Date.now(), studio.timezone), studio.makeup_expiry_days) : null;
  return env.DB.prepare('INSERT INTO makeup_credits (id, studio_id, learner_id, source_booking, reason, expires_on) VALUES (?,?,?,?,?,?)')
    .bind(uid('mc'), studio.id, b.learner_id, b.id, reason, expires);
}

/** Move a booking atomically: free old blocks, claim new ones; any clash rolls the whole move back. */
async function moveBooking(c, b, date, start_min) {
  const tz = c.studio?.timezone || c.m.timezone, studioId = b.studio_id;
  const startMs = localToUtc(date, start_min, tz);
  const stmts = [c.env.DB.prepare('DELETE FROM booking_blocks WHERE booking_id = ?').bind(b.id),
    c.env.DB.prepare('UPDATE bookings SET starts_at = ?, ends_at = ?, moved_from = COALESCE(moved_from, ?), updated_at = ? WHERE id = ?')
      .bind(iso(startMs), iso(startMs + b.minutes * 60000), b.starts_at, nowIso(), b.id)];
  for (const blk of blocksFor(startMs, b.minutes)) stmts.push(c.env.DB.prepare('INSERT INTO booking_blocks (studio_id, block_start, booking_id) VALUES (?,?,?)').bind(studioId, blk, b.id));
  try { await c.env.DB.batch(stmts); } catch (e) { if (isConflict(e)) fail(409, 'That time was just taken. Pick another.'); throw e; }
}

on('POST', '/api/t/:sid/time-off', async (c) => {
  const tz = c.studio.timezone;
  const date = isDate(c.body.date) ? c.body.date : fail(400, 'date required');
  const endDate = isDate(c.body.end_date) ? c.body.end_date : date;
  const a = localToUtc(date, c.body.start_min != null ? int(c.body.start_min, 'Start', { min: 0, max: 1440 }) : 0, tz);
  const b = c.body.end_min != null ? localToUtc(endDate, int(c.body.end_min, 'End', { min: 0, max: 1440 }), tz) : localToUtc(addDays(endDate, 1), 0, tz);
  if (b <= a) fail(400, 'End must be after start');
  await c.env.DB.prepare('INSERT INTO time_off (id, studio_id, starts_at, ends_at, reason) VALUES (?,?,?,?,?)').bind(uid('to'), c.studio.id, iso(a), iso(b), str(c.body.reason, 'Reason', { max: 120, optional: true })).run();
  // Cancel and credit every class inside the blocked time, then tell each family.
  const hit = (await c.env.DB.prepare(`SELECT b.*, l.name learner, m.user_id FROM bookings b JOIN learners l ON l.id = b.learner_id JOIN memberships m ON m.id = b.membership_id
      WHERE b.studio_id = ? AND b.status = 'confirmed' AND b.starts_at < ? AND b.ends_at > ?`).bind(c.studio.id, iso(b), iso(a)).all()).results;
  const credit = c.body.credit !== false, now = nowIso(), stmts = [];
  for (const x of hit) {
    stmts.push(c.env.DB.prepare('DELETE FROM booking_blocks WHERE booking_id = ?').bind(x.id));
    stmts.push(c.env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_by = 'teacher', updated_at = ? WHERE id = ?").bind(now, x.id));
    if (credit) stmts.push(creditStmt(c.env, c.studio, x, c.body.reason || 'Teacher unavailable'));
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  for (const x of hit) {
    await notify(c.env, c.ctx, c.studio.id, [x.user_id], { title: 'Class cancelled', body: `${x.learner}: ${fmtWhen(x.starts_at, tz)} is cancelled${credit ? '. A make-up credit was added, book any open slot.' : '.'}`, url: '/' });
  }
  return json({ cancelled: hit.length });
}, 'teacher');

// Group classes: no seat limit; who can join = eligible learners, or an invite list.
on('POST', '/api/t/:sid/groups', async (c) => {
  const { date, start_min } = parseLocal(c.body, c.studio);
  const minutes = parseMinutes(c.body.minutes);
  const mode = oneOf(c.body.mode, 'Mode', ['physical', 'virtual'], 'physical');
  const eligibility = oneOf(c.body.eligibility, 'Who can join', ['eligible', 'invited'], 'eligible');
  const startMs = localToUtc(date, start_min, c.studio.timezone), id = uid('g');
  let room = null;
  if (mode === 'virtual') room = await resolveRoom(c.env, c.studio, null, c.body.room_id);
  const fee = c.body.fee ? toMinor(c.body.fee, c.studio.default_currency, 'Fee') : null;
  const stmts = [c.env.DB.prepare(`INSERT INTO group_classes (id, studio_id, title, starts_at, ends_at, notes, mode, location, room_id, meeting_url, eligibility, fee_minor)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, c.studio.id, str(c.body.title, 'Title', { max: 80 }), iso(startMs), iso(startMs + minutes * 60000),
      str(c.body.notes, 'Notes', { max: 500, optional: true }), mode, mode === 'physical' ? c.studio.studio_address : null, room?.id || null, room?.url || null, eligibility, fee)];
  for (const blk of blocksFor(startMs, minutes)) stmts.push(c.env.DB.prepare('INSERT INTO booking_blocks (studio_id, block_start, group_id) VALUES (?,?,?)').bind(c.studio.id, blk, id));
  const invited = eligibility === 'invited' ? (Array.isArray(c.body.learner_ids) ? c.body.learner_ids : []) : [];
  for (const lid of invited) { await studioLearner(c, lid); stmts.push(c.env.DB.prepare('INSERT INTO group_invites (group_id, learner_id) VALUES (?,?)').bind(id, lid)); }
  try { await c.env.DB.batch(stmts); } catch (e) { if (isConflict(e)) fail(409, 'That time overlaps another class'); throw e; }
  const who = eligibility === 'invited'
    ? (await c.env.DB.prepare(`SELECT DISTINCT m.user_id FROM group_invites gi JOIN learners l ON l.id = gi.learner_id JOIN memberships m ON m.id = l.membership_id WHERE gi.group_id = ?`).bind(id).all()).results
    : (await c.env.DB.prepare(`SELECT DISTINCT m.user_id FROM learners l JOIN learner_rules r ON r.learner_id = l.id JOIN memberships m ON m.id = l.membership_id
        WHERE l.studio_id = ? AND r.group_eligible = 1 AND l.active = 1 AND m.status = 'active'`).bind(c.studio.id).all()).results;
  await notify(c.env, c.ctx, c.studio.id, who.map((r) => r.user_id), { title: 'New group class', body: `${c.body.title}: ${fmtWhen(iso(startMs), c.studio.timezone)}`, url: '/' });
  return json({ id });
}, 'teacher');

// =====================================================================
// Teacher: fees, practice, events
// =====================================================================
on('GET', '/api/t/:sid/fees', async (c) => {
  await settle(c.env, c.studio);
  const rows = (await c.env.DB.prepare(`SELECT l.*, m.username FROM ledger l JOIN memberships m ON m.id = l.membership_id WHERE l.studio_id = ? ${c.q.get('membership') ? 'AND l.membership_id = ?' : ''}
      ORDER BY l.created_at DESC LIMIT 200`).bind(...(c.q.get('membership') ? [c.studio.id, c.q.get('membership')] : [c.studio.id])).all()).results;
  return json({ balances: await balances(c.env, c.studio.id), entries: rows });
}, 'teacher');
on('POST', '/api/t/:sid/payments', async (c) => {
  const m = await c.env.DB.prepare("SELECT * FROM memberships WHERE id = ? AND studio_id = ? AND role = 'student'").bind(c.body.membership_id, c.studio.id).first();
  if (!m) fail(404, 'Student not found');
  const cur = m.currency || c.studio.default_currency;
  const kind = oneOf(c.body.kind, 'Kind', ['payment', 'adjustment'], 'payment');
  let amount = toMinor(String(c.body.amount).replace(/^-/, ''), cur);
  if (kind === 'adjustment' && String(c.body.amount).startsWith('-')) amount = -amount;
  if (amount === 0) fail(400, 'Amount must be more than zero');
  await c.env.DB.prepare('INSERT INTO ledger (id, studio_id, membership_id, kind, amount_minor, currency, method, note, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(uid('lg'), c.studio.id, m.id, kind, amount, cur, str(c.body.method, 'Method', { max: 30, optional: true }), str(c.body.note, 'Note', { max: 200, optional: true }), c.user.id).run();
  return json({ ok: true });
}, 'teacher');

on('GET', '/api/t/:sid/practice', async (c) => {
  const lid = c.q.get('learner');
  const rows = (await c.env.DB.prepare(`SELECT p.day, p.minutes, p.notes, p.updated_at, l.name learner, l.id learner_id FROM practice_logs p JOIN learners l ON l.id = p.learner_id
      WHERE p.studio_id = ? ${lid ? 'AND p.learner_id = ?' : ''} ORDER BY p.day DESC LIMIT 200`).bind(...(lid ? [c.studio.id, lid] : [c.studio.id])).all()).results;
  return json({ logs: rows });
}, 'teacher');

on('POST', '/api/t/:sid/events', async (c) => {
  const b = c.body, id = uid('e');
  const { date, start_min } = parseLocal(b, c.studio);
  const startMs = localToUtc(date, start_min, c.studio.timezone);
  const fields = Array.isArray(b.piece_fields) && b.piece_fields.length ? b.piece_fields.map((f) => str(f, 'Field', { max: 30 })).slice(0, 8) : ['composition', 'raga', 'tala', 'composer'];
  const audience = oneOf(b.audience, 'Audience', ['all', 'group_eligible'], 'all');
  await c.env.DB.prepare(`INSERT INTO events (id, studio_id, title, kind, starts_at, ends_at, location, description, collect_rsvp, collect_pieces, piece_fields, audience)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, c.studio.id, str(b.title, 'Title', { max: 100 }), oneOf(b.kind, 'Type', ['lecdem', 'competition', 'presentation', 'concert', 'other'], 'other'),
      iso(startMs), b.minutes ? iso(startMs + parseMinutes(b.minutes, 1440) * 60000) : null, str(b.location, 'Location', { max: 200, optional: true }),
      str(b.description, 'Details', { max: 2000, optional: true }), b.collect_rsvp === false ? 0 : 1, b.collect_pieces ? 1 : 0, JSON.stringify(fields), audience).run();
  const who = (await c.env.DB.prepare(`SELECT DISTINCT m.user_id FROM memberships m JOIN learners l ON l.membership_id = m.id JOIN learner_rules r ON r.learner_id = l.id
      WHERE m.studio_id = ? AND m.status = 'active' AND m.role = 'student' ${audience === 'group_eligible' ? 'AND r.group_eligible = 1' : ''}`).bind(c.studio.id).all()).results;
  await notify(c.env, c.ctx, c.studio.id, who.map((r) => r.user_id), { title: `New event: ${b.title}`, body: `${fmtWhen(iso(startMs), c.studio.timezone)}${b.collect_pieces ? '. Tell us what you will sing.' : ''}`, url: `/events/${id}` });
  return json({ id, notified: who.length });
}, 'teacher');
on('GET', '/api/t/:sid/events', async (c) => json({ events: (await c.env.DB.prepare(`SELECT e.*,
    (SELECT COUNT(*) FROM event_responses r WHERE r.event_id = e.id AND r.attending = 'yes') going,
    (SELECT COUNT(*) FROM event_responses r WHERE r.event_id = e.id AND r.piece IS NOT NULL) pieces
    FROM events e WHERE e.studio_id = ? ORDER BY e.starts_at DESC LIMIT 50`).bind(c.studio.id).all()).results }), 'teacher');
on('GET', '/api/t/:sid/events/:eid', async (c) => {
  const e = await c.env.DB.prepare('SELECT * FROM events WHERE id = ? AND studio_id = ?').bind(c.params.eid, c.studio.id).first();
  if (!e) fail(404, 'Event not found');
  const responses = (await c.env.DB.prepare(`SELECT r.*, l.name learner FROM event_responses r JOIN learners l ON l.id = r.learner_id WHERE r.event_id = ? ORDER BY r.updated_at DESC`).bind(e.id).all()).results;
  return json({ event: e, responses });
}, 'teacher');

// =====================================================================
// Student
// =====================================================================
on('GET', '/api/s/home', async (c) => {
  const m = c.m, studio = studioOf(m);
  if (m.status !== 'active') return json({ membership: { status: m.status, username: m.username, studio_name: m.studio_name } });
  await generateSeries(c.env, { ...studio, booking_horizon_days: m.booking_horizon_days }, horizonDate(m));
  await settle(c.env, studio);
  const learners = (await c.env.DB.prepare(`SELECT l.id, l.name, r.max_class_minutes, r.classes_per_week, r.fee_minor, r.fee_basis, r.group_eligible, r.can_reschedule,
      r.can_book_extra, r.can_book_makeup, r.allowed_modes, r.default_mode,
      (SELECT COUNT(*) FROM bookings b WHERE b.learner_id = l.id AND b.status IN ('completed','no_show')) classes_done,
      (SELECT COUNT(*) FROM makeup_credits mc WHERE mc.learner_id = l.id AND mc.status = 'open' AND (mc.expires_on IS NULL OR mc.expires_on >= date('now'))) open_credits
      FROM learners l JOIN learner_rules r ON r.learner_id = l.id WHERE l.membership_id = ? AND l.active = 1 ORDER BY l.created_at`).bind(m.id).all()).results;
  const upcoming = (await c.env.DB.prepare(`SELECT b.id, b.learner_id, b.starts_at, b.ends_at, b.minutes, b.kind, b.mode, b.meeting_url, b.location, b.moved_from
      FROM bookings b WHERE b.membership_id = ? AND b.status = 'confirmed' AND b.ends_at > ? ORDER BY b.starts_at LIMIT 20`).bind(m.id, nowIso()).all()).results;
  const room = await c.env.DB.prepare('SELECT passcode FROM meeting_rooms WHERE studio_id = ? AND is_default = 1').bind(m.studio_id).first();
  return json({ membership: { id: m.id, status: m.status, username: m.username, is_shared: !!m.is_shared, currency: m.currency || m.default_currency, studio_name: m.studio_name,
      timezone: m.timezone, change_notice_hours: m.change_notice_hours, studio_address: m.studio_address, room_passcode: room?.passcode || null },
    learners, upcoming, balances: await balances(c.env, m.studio_id, m.id) });
}, 'student');

on('GET', '/api/s/slots', async (c) => {
  requireActive(c);
  const l = await myLearner(c, c.q.get('learner'));
  const rules = await getRules(c.env, l.id);
  const date = isDate(c.q.get('date')) ? c.q.get('date') : fail(400, 'date required');
  const minutes = parseMinutes(c.q.get('minutes') || 30, rules.max_class_minutes);
  return json({ starts: await freeStarts(c.env, studioOf(c.m), date, minutes, { student: true, ignoreBookingId: c.q.get('ignore') || undefined }) });
}, 'student');

on('POST', '/api/s/classes', async (c) => {
  requireActive(c);
  const l = await myLearner(c, c.body.learner_id), rules = await getRules(c.env, l.id), studio = studioOf(c.m);
  const kind = oneOf(c.body.kind, 'Kind', ['extra', 'makeup']);
  if (kind === 'extra' && !rules.can_book_extra) fail(403, 'Extra classes are not enabled for this learner');
  if (kind === 'makeup' && !rules.can_book_makeup) fail(403, 'Make-up classes are not enabled for this learner');
  const { date, start_min } = parseLocal(c.body, studio);
  const minutes = parseMinutes(c.body.minutes, rules.max_class_minutes);
  const mode = oneOf(c.body.mode, 'Mode', ['physical', 'virtual'], rules.default_mode);
  if (!rules.allowed_modes.split(',').includes(mode)) fail(403, `${mode === 'virtual' ? 'Online' : 'In-person'} classes are not enabled for this learner`);
  if (!(await freeStarts(c.env, studio, date, minutes, { student: true })).includes(start_min)) fail(409, 'That time is no longer available');
  if (kind === 'extra' && rules.classes_per_week > 0 && await weekCount(c.env, studio, l.id, date, ['extra']) >= rules.classes_per_week) {
    fail(409, `${l.name} has already booked the extra classes allowed this week`);
  }
  let creditId = null;
  if (kind === 'makeup') {
    const cr = await c.env.DB.prepare("SELECT id FROM makeup_credits WHERE learner_id = ? AND status = 'open' AND (expires_on IS NULL OR expires_on >= ?) ORDER BY created_at LIMIT 1")
      .bind(l.id, localDate(Date.now(), c.m.timezone)).first();
    if (!cr) fail(409, 'No make-up credits available');
    creditId = cr.id;
  }
  const b = await makeBooking(c.env, studio, l, { date, start_min, minutes, kind, mode, makeup_credit_id: creditId, created_by: c.user.id });
  const stmts = bookingStatements(c.env, b);
  if (creditId) stmts.push(c.env.DB.prepare("UPDATE makeup_credits SET status = 'used', used_booking = ? WHERE id = ? AND status = 'open'").bind(b.id, creditId));
  try { await c.env.DB.batch(stmts); } catch (e) { if (isConflict(e)) fail(409, 'That time was just taken. Pick another.'); throw e; }
  await notify(c.env, c.ctx, c.m.studio_id, [c.m.owner_user_id], { title: kind === 'makeup' ? 'Make-up class booked' : 'Extra class booked',
    body: `${l.name}: ${fmtWhen(b.starts_at, c.m.timezone)}, ${minutes} min${mode === 'virtual' ? ', online' : ''}`, url: '/calendar' });
  return json({ id: b.id, meeting_url: b.meeting_url, location: b.location });
}, 'student');

async function myBooking(c) {
  const b = await c.env.DB.prepare('SELECT b.*, l.name learner FROM bookings b JOIN learners l ON l.id = b.learner_id WHERE b.id = ? AND b.membership_id = ?').bind(c.params.bid, c.m.id).first();
  if (!b) fail(404, 'Class not found');
  if (b.status !== 'confirmed') fail(409, 'This class can no longer be changed');
  const cutoff = Date.parse(b.starts_at) - c.m.change_notice_hours * 3600000;
  if (Date.now() > cutoff) fail(409, `Changes close ${c.m.change_notice_hours} hours before class. Please message your teacher.`);
  return b;
}
on('POST', '/api/s/classes/:bid/move', async (c) => {
  requireActive(c);
  const b = await myBooking(c), rules = await getRules(c.env, b.learner_id), studio = studioOf(c.m);
  if (!rules.can_reschedule) fail(403, 'Rescheduling is not enabled for this learner. Please message your teacher.');
  const { date, start_min } = parseLocal(c.body, studio);
  if (!(await freeStarts(c.env, studio, date, b.minutes, { student: true, ignoreBookingId: b.id })).includes(start_min)) fail(409, 'That time is not available');
  await moveBooking(c, b, date, start_min);
  await notify(c.env, c.ctx, c.m.studio_id, [c.m.owner_user_id], { title: 'Class rescheduled', body: `${b.learner}: ${fmtWhen(b.starts_at, c.m.timezone)} → ${fmtWhen(iso(localToUtc(date, start_min, c.m.timezone)), c.m.timezone)}`, url: '/calendar' });
  return json({ ok: true });
}, 'student');
on('POST', '/api/s/classes/:bid/cancel', async (c) => {
  requireActive(c);
  const b = await myBooking(c);
  const stmts = [c.env.DB.prepare('DELETE FROM booking_blocks WHERE booking_id = ?').bind(b.id),
    c.env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_by = 'student', updated_at = ? WHERE id = ?").bind(nowIso(), b.id)];
  const credit = !!c.m.student_cancel_credit && b.kind !== 'extra';
  if (credit) stmts.push(creditStmt(c.env, { id: c.m.studio_id, timezone: c.m.timezone, makeup_expiry_days: c.m.makeup_expiry_days }, b, 'Cancelled by student in time'));
  if (b.makeup_credit_id) stmts.push(c.env.DB.prepare("UPDATE makeup_credits SET status = 'open', used_booking = NULL WHERE id = ?").bind(b.makeup_credit_id));
  await c.env.DB.batch(stmts);
  await notify(c.env, c.ctx, c.m.studio_id, [c.m.owner_user_id], { title: 'Class cancelled by student', body: `${b.learner}: ${fmtWhen(b.starts_at, c.m.timezone)}`, url: '/calendar' });
  return json({ ok: true, credit });
}, 'student');

on('GET', '/api/s/history', async (c) => json({ classes: (await c.env.DB.prepare(`SELECT b.id, b.learner_id, b.starts_at, b.minutes, b.kind, b.status, b.mode, b.cancelled_by
    FROM bookings b WHERE b.membership_id = ? AND (b.status <> 'confirmed' OR b.ends_at <= ?) ORDER BY b.starts_at DESC LIMIT 100`).bind(c.m.id, nowIso()).all()).results }), 'student');

on('GET', '/api/s/fees', async (c) => {
  requireActive(c);
  await settle(c.env, studioOf(c.m));
  const entries = (await c.env.DB.prepare(`SELECT g.kind, g.amount_minor, g.currency, g.note, g.method, g.created_at, l.name learner FROM ledger g LEFT JOIN learners l ON l.id = g.learner_id
      WHERE g.membership_id = ? ORDER BY g.created_at DESC LIMIT 100`).bind(c.m.id).all()).results;
  return json({ balances: await balances(c.env, c.m.studio_id, c.m.id), entries, currency: c.m.currency || c.m.default_currency });
}, 'student');

on('GET', '/api/s/practice', async (c) => {
  const l = await myLearner(c, c.q.get('learner'));
  return json({ logs: (await c.env.DB.prepare('SELECT day, minutes, notes FROM practice_logs WHERE learner_id = ? ORDER BY day DESC LIMIT 60').bind(l.id).all()).results,
    today: localDate(Date.now(), c.m.timezone) });
}, 'student');
on('PUT', '/api/s/practice', async (c) => {
  requireActive(c);
  const l = await myLearner(c, c.body.learner_id);
  const today = localDate(Date.now(), c.m.timezone);
  const day = isDate(c.body.day) ? c.body.day : today;
  if (day > today || day < addDays(today, -14)) fail(400, 'You can log today or the last 14 days');
  await c.env.DB.prepare(`INSERT INTO practice_logs (id, studio_id, learner_id, membership_id, day, minutes, notes) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(learner_id, day) DO UPDATE SET minutes = excluded.minutes, notes = excluded.notes, updated_at = ?`)
    .bind(uid('p'), c.m.studio_id, l.id, c.m.id, day, int(c.body.minutes, 'Minutes', { min: 0, max: 1440 }), str(c.body.notes, 'Notes', { max: 500, optional: true }), nowIso()).run();
  return json({ ok: true });
}, 'student');

on('GET', '/api/s/events', async (c) => {
  requireActive(c);
  const learners = (await c.env.DB.prepare('SELECT l.id, r.group_eligible FROM learners l JOIN learner_rules r ON r.learner_id = l.id WHERE l.membership_id = ?').bind(c.m.id).all()).results;
  const anyEligible = learners.some((l) => l.group_eligible);
  const events = (await c.env.DB.prepare(`SELECT * FROM events WHERE studio_id = ? AND starts_at > ? ${anyEligible ? '' : "AND audience = 'all'"} ORDER BY starts_at`)
    .bind(c.m.studio_id, iso(Date.now() - 86400000)).all()).results;
  const mine = (await c.env.DB.prepare(`SELECT r.* FROM event_responses r JOIN learners l ON l.id = r.learner_id WHERE l.membership_id = ?`).bind(c.m.id).all()).results;
  const groups = (await c.env.DB.prepare(`SELECT g.id, g.title, g.starts_at, g.ends_at, g.mode, g.location, g.meeting_url, g.notes, g.eligibility, g.fee_minor
      FROM group_classes g WHERE g.studio_id = ? AND g.ends_at > ? ORDER BY g.starts_at`).bind(c.m.studio_id, nowIso()).all()).results;
  const invites = (await c.env.DB.prepare('SELECT gi.* FROM group_invites gi JOIN learners l ON l.id = gi.learner_id WHERE l.membership_id = ?').bind(c.m.id).all()).results;
  const signups = (await c.env.DB.prepare("SELECT gs.* FROM group_signups gs JOIN learners l ON l.id = gs.learner_id WHERE l.membership_id = ? AND gs.status = 'joined'").bind(c.m.id).all()).results;
  const visibleGroups = groups.map((g) => ({ ...g,
    eligible_learners: learners.filter((l) => g.eligibility === 'invited' ? invites.some((i) => i.group_id === g.id && i.learner_id === l.id) : l.group_eligible).map((l) => l.id),
    joined: signups.filter((s) => s.group_id === g.id).map((s) => s.learner_id) })).filter((g) => g.eligible_learners.length);
  return json({ events: events.map((e) => ({ ...e, piece_fields: JSON.parse(e.piece_fields), responses: mine.filter((r) => r.event_id === e.id).map((r) => ({ ...r, piece: r.piece ? JSON.parse(r.piece) : null })) })),
    groups: visibleGroups });
}, 'student');
on('PUT', '/api/s/events/:eid', async (c) => {
  requireActive(c);
  const e = await c.env.DB.prepare('SELECT * FROM events WHERE id = ? AND studio_id = ?').bind(c.params.eid, c.m.studio_id).first();
  if (!e) fail(404, 'Event not found');
  const l = await myLearner(c, c.body.learner_id);
  const attending = e.collect_rsvp ? oneOf(c.body.attending, 'RSVP', ['yes', 'no', 'maybe']) : null;
  let piece = null;
  if (e.collect_pieces && c.body.piece) {
    const fields = JSON.parse(e.piece_fields);
    piece = JSON.stringify(Object.fromEntries(fields.map((f) => [f, str(c.body.piece[f], f, { max: 120, optional: true })]).filter(([, v]) => v)));
  }
  await c.env.DB.prepare(`INSERT INTO event_responses (event_id, learner_id, attending, piece) VALUES (?,?,?,?)
      ON CONFLICT(event_id, learner_id) DO UPDATE SET attending = excluded.attending, piece = excluded.piece, updated_at = ?`).bind(e.id, l.id, attending, piece, nowIso()).run();
  return json({ ok: true });
}, 'student');
on('POST', '/api/s/groups/:gid', async (c) => {
  requireActive(c);
  const l = await myLearner(c, c.body.learner_id);
  const g = await c.env.DB.prepare('SELECT * FROM group_classes WHERE id = ? AND studio_id = ? AND starts_at > ?').bind(c.params.gid, c.m.studio_id, nowIso()).first();
  if (!g) fail(404, 'Group class not found');
  const rules = await getRules(c.env, l.id);
  const ok = g.eligibility === 'invited' ? await c.env.DB.prepare('SELECT 1 FROM group_invites WHERE group_id = ? AND learner_id = ?').bind(g.id, l.id).first() : rules.group_eligible;
  if (!ok) fail(403, `${l.name} is not eligible for this group class`);
  await c.env.DB.prepare(`INSERT INTO group_signups (group_id, learner_id, status) VALUES (?,?,?) ON CONFLICT(group_id, learner_id) DO UPDATE SET status = excluded.status`)
    .bind(g.id, l.id, c.body.join === false ? 'left' : 'joined').run();
  return json({ ok: true });
}, 'student');

const hm = (min) => { const h = Math.floor(min / 60), m = min % 60; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };
