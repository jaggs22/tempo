// End-to-end API test. Run against `npx wrangler dev` with DEV_MODE=1 and a fresh local DB:
//   npm run db:reset && npx wrangler dev &  then  BASE=http://localhost:8787 node test/flow.test.mjs
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:8787';
const run = Date.now().toString(36);

function actor() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const res = await fetch(BASE + path, {
      method, redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-tempo': '1', cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
}
const ok = (r, msg) => { if (r.status >= 300) throw new Error(`${msg}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const step = (s) => console.log('✓', s);

// Dates in Singapore (UTC+8, no DST)
const sgDate = (offsetDays) => new Date(Date.now() + 8 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
const wd = (d) => new Date(d + 'T00:00:00Z').getUTCDay();

const T = actor(), S = actor(), S2 = actor(), DEV = actor();

// 1. Teacher + studio
ok(await T('POST', '/api/dev/teacher', { email: `t${run}@example.com`, name: 'Test Teacher' }), 'teacher login');
const slug = `studio-${run}`;
const studio = ok(await T('POST', '/api/studios', { name: 'SuSwara Test', teacher_name: 'Aparna Dharwada', slug, timezone: 'Asia/Singapore', currency: 'SGD', studio_address: '1 Test Road' }), 'create studio');
const sid = studio.id, code = studio.join_code;
ok(await T('PUT', `/api/t/${sid}/availability`, { windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start_min: 9 * 60, end_min: 21 * 60 })) }), 'availability');
ok(await T('POST', `/api/t/${sid}/rooms`, { label: 'My Meet room', url: 'https://meet.google.com/abc-defg-hij' }), 'room');
step('teacher created studio, hours and an online room');

// 2. CSRF + install gate
assert.equal((await fetch(`${BASE}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
assert.equal((await S('POST', '/api/join', { code, full_name: 'Ananya Krishnan' })).status, 412);
step('requests without the app header are refused; joining outside the installed app is refused');

// 3. Join as a shared account
const INST = { 'x-tempo-installed': '1' };
assert.equal((await S('POST', '/api/join', { code, full_name: 'Ananya Krishnan', shared: true, learners: ['Arjun Krishnan'] }, INST)).status, 400, 'needs confirmation');
ok(await S('POST', '/api/join', { code, full_name: 'Ananya Krishnan', shared: true, learners: ['Arjun Krishnan'], confirm_shared: true }, INST), 'join');
assert.equal((await S2('POST', '/api/join', { code: slug, full_name: 'ananya  krishnan' }, INST)).status, 409, 'duplicate name');
ok(await S2('POST', '/api/join', { code: slug, full_name: 'Meera Iyer' }, INST), 'join 2');
assert.equal((await S('GET', '/api/s/home')).data.membership.status, 'pending');
assert.equal((await S('GET', `/api/s/slots?learner=x&date=${sgDate(3)}`)).status, 403, 'pending cannot book');
step('shared account requires confirmation, names are unique per studio, pending students cannot book');

// 4. Approve + permissions
let roster = ok(await T('GET', `/api/t/${sid}/students`), 'students');
const fam = roster.members.find((m) => m.username === 'Ananya Krishnan');
const meera = roster.members.find((m) => m.username === 'Meera Iyer');
assert.equal(fam.learners.length, 2); assert.equal(fam.is_shared, 1);
const ananya = fam.learners.find((l) => l.name === 'Ananya Krishnan'), arjun = fam.learners.find((l) => l.name === 'Arjun Krishnan');
ok(await T('PATCH', `/api/t/${sid}/members/${fam.id}`, { status: 'active', currency: 'SGD' }), 'approve');
ok(await T('PATCH', `/api/t/${sid}/members/${meera.id}`, { status: 'active', currency: 'INR' }), 'approve 2');
ok(await T('PATCH', `/api/t/${sid}/learners/${ananya.learner_id}`, { rules: { max_class_minutes: 60, fee: '45', group_eligible: true, classes_per_week: 1 } }), 'rules');
ok(await T('PATCH', `/api/t/${sid}/learners/${arjun.learner_id}`, { rules: { max_class_minutes: 30, fee: '30', can_book_extra: false, allowed_modes: 'physical' } }), 'rules 2');
step('teacher approved both accounts and set per-learner rules and currency');
const A = ananya.learner_id, R = arjun.learner_id;

// 5. Teacher timetable
const seriesDay = sgDate(4);
const series = ok(await T('POST', `/api/t/${sid}/series`, { learner_id: A, weekday: wd(seriesDay), start_min: 17 * 60, minutes: 60, starts_on: sgDate(1) }), 'series');
let home = ok(await S('GET', '/api/s/home'), 'home');
const regular = home.upcoming.filter((b) => b.kind === 'regular');
assert.ok(regular.length >= 4, `expected weekly classes, got ${regular.length}`);
step(`teacher timetable generated ${regular.length} weekly classes`);

// 6. Extra class + race protection + weekly cap
const exDate = sgDate(2);
const slots = ok(await S('GET', `/api/s/slots?learner=${A}&date=${exDate}&minutes=60`), 'slots').starts;
assert.ok(slots.includes(10 * 60));
const extra = ok(await S('POST', '/api/s/classes', { learner_id: A, kind: 'extra', date: exDate, start_min: 600, minutes: 60, mode: 'virtual' }), 'extra');
assert.equal(extra.meeting_url, 'https://meet.google.com/abc-defg-hij');
assert.equal((await S2('GET', '/api/s/home')).status, 200);
const meeraL = (await S2('GET', '/api/s/home')).data.learners[0].id;
assert.equal((await S2('POST', '/api/s/classes', { learner_id: meeraL, kind: 'extra', date: exDate, start_min: 630, minutes: 30 })).status, 409, 'overlap refused');
assert.equal((await S('POST', '/api/s/classes', { learner_id: A, kind: 'extra', date: exDate, start_min: 13 * 60, minutes: 30 })).status, 409, 'weekly cap');
assert.equal((await S('POST', '/api/s/classes', { learner_id: R, kind: 'extra', date: exDate, start_min: 14 * 60, minutes: 30 })).status, 403, 'extras disabled');
assert.equal((await S('POST', '/api/s/classes', { learner_id: A, kind: 'extra', date: sgDate(9), start_min: 600, minutes: 90 })).status, 400, 'over max length');
step('extra online class booked with a join link; overlaps, weekly cap, disabled extras and over-length refused');

// 7. Student reschedules a regular class, then cancels one for a credit, then books a make-up
const first = regular[0];
ok(await S('POST', `/api/s/classes/${first.id}/move`, { date: first.starts_at.slice(0, 10) === sgDate(1) ? sgDate(1) : sgDate(5), start_min: 19 * 60 }), 'move');
home = ok(await S('GET', '/api/s/home'), 'home');
assert.ok(home.upcoming.find((b) => b.id === first.id).moved_from, 'moved_from recorded');
const second = regular[1];
const cancel = ok(await S('POST', `/api/s/classes/${second.id}/cancel`), 'cancel');
assert.equal(cancel.credit, true);
home = ok(await S('GET', '/api/s/home'), 'home');
assert.equal(home.learners.find((l) => l.id === A).open_credits, 1);
ok(await S('POST', '/api/s/classes', { learner_id: A, kind: 'makeup', date: sgDate(3), start_min: 11 * 60, minutes: 60 }), 'makeup');
home = ok(await S('GET', '/api/s/home'), 'home');
assert.equal(home.learners.find((l) => l.id === A).open_credits, 0);
step('student moved a class, cancelled one for a make-up credit, and used it');

// 8. Teacher blocks a day: classes inside are cancelled with credits
const blockDay = regular[2].starts_at; // ISO; convert to SG date
const bd = new Date(Date.parse(blockDay) + 8 * 3600000).toISOString().slice(0, 10);
const off = ok(await T('POST', `/api/t/${sid}/time-off`, { date: bd, reason: 'Unwell' }), 'time off');
assert.ok(off.cancelled >= 1);
home = ok(await S('GET', '/api/s/home'), 'home');
assert.equal(home.learners.find((l) => l.id === A).open_credits, 1);
assert.equal((await S('GET', `/api/s/slots?learner=${A}&date=${bd}&minutes=30`)).data.starts.length, 0, 'blocked day has no slots');
step('teacher time off cancelled affected classes and issued credits; that day shows no slots');

// 9. Fees: a past class settles into a charge in the account currency; payment clears it
ok(await T('POST', `/api/t/${sid}/classes`, { learner_id: A, date: sgDate(-1), start_min: 9 * 60, minutes: 60 }), 'past class');
ok(await T('POST', `/api/t/${sid}/classes`, { learner_id: meeraL, date: sgDate(-1), start_min: 10 * 60, minutes: 30 }), 'past class 2');
ok(await T('PATCH', `/api/t/${sid}/learners/${meeraL}`, { rules: { fee: '1500' } }), 'meera fee');
let fees = ok(await S('GET', '/api/s/fees'), 'fees');
assert.equal(fees.balances[0].due_minor, 4500); assert.equal(fees.balances[0].currency, 'SGD');
home = ok(await S('GET', '/api/s/home'), 'home');
assert.equal(home.learners.find((l) => l.id === A).classes_done, 1);
ok(await T('POST', `/api/t/${sid}/payments`, { membership_id: fam.id, amount: '45', method: 'PayNow' }), 'payment');
fees = ok(await S('GET', '/api/s/fees'), 'fees');
assert.equal(fees.balances[0].due_minor, 0);
const tf = ok(await T('GET', `/api/t/${sid}/fees`), 'teacher fees');
assert.ok(tf.balances.some((b) => b.currency === 'INR'), 'INR account');
step('completed class charged S$45 and counted; payment cleared it; second account bills in INR');

// 10. Practice is private
ok(await S('PUT', '/api/s/practice', { learner_id: A, minutes: 40, notes: 'Sami ninne varnam' }), 'practice');
assert.equal((await S2('GET', `/api/s/practice?learner=${A}`)).status, 404, 'other student cannot read');
const tp = ok(await T('GET', `/api/t/${sid}/practice?learner=${A}`), 'teacher practice');
assert.equal(tp.logs[0].minutes, 40);
step('practice log saved; visible to the teacher, hidden from other students');

// 11. Events with pieces
const ev = ok(await T('POST', `/api/t/${sid}/events`, { title: 'Pancharatna lecdem', kind: 'lecdem', date: sgDate(10), start_min: 16 * 60, collect_pieces: true, piece_fields: ['composition', 'raga', 'tala'] }), 'event');
assert.equal(ev.notified, 2);
ok(await S('PUT', `/api/s/events/${ev.id}`, { learner_id: A, attending: 'yes', piece: { composition: 'Jagadananda Karaka', raga: 'Nata', tala: 'Adi' } }), 'rsvp');
const er = ok(await T('GET', `/api/t/${sid}/events/${ev.id}`), 'responses');
assert.equal(JSON.parse(er.responses[0].piece).raga, 'Nata');
const notes = ok(await S('GET', '/api/notifications'), 'notifications');
assert.ok(notes.items.some((n) => n.title.includes('Pancharatna')));
step('event notified both accounts; RSVP and piece reached the teacher');

// 12. Group class eligibility (no seat limit)
const g = ok(await T('POST', `/api/t/${sid}/groups`, { title: 'Pancharatna practice', date: sgDate(6), start_min: 9 * 60, minutes: 60 }), 'group');
const sev = ok(await S('GET', '/api/s/events'), 'student events');
assert.deepEqual(sev.groups.find((x) => x.id === g.id).eligible_learners, [A]);
ok(await S('POST', `/api/s/groups/${g.id}`, { learner_id: A }), 'join group');
assert.equal((await S('POST', `/api/s/groups/${g.id}`, { learner_id: R })).status, 403, 'ineligible');
assert.ok(!(await S2('GET', '/api/s/events')).data.groups.length, 'not shown to ineligible account');
step('group class: eligible learner joined, ineligible learner refused and not shown');

// 13. New-device sign-in with teacher approval
const req = ok(await DEV('POST', '/api/signin', { code, full_name: 'ananya krishnan' }, INST), 'signin');
assert.equal((await DEV('POST', `/api/signin/${req.id}/poll`, { secret: req.secret })).data.status, 'pending');
roster = ok(await T('GET', `/api/t/${sid}/students`), 'students');
ok(await T('POST', `/api/t/${sid}/signin-requests/${roster.signin_requests[0].id}`, { approve: true }), 'approve device');
assert.equal((await DEV('POST', `/api/signin/${req.id}/poll`, { secret: 'wrong' })).status, 404);
assert.equal((await DEV('POST', `/api/signin/${req.id}/poll`, { secret: req.secret })).data.status, 'approved');
assert.equal((await DEV('GET', '/api/me')).data.user.name, 'Ananya Krishnan');
step('new device signed in by full name after teacher approval');

// 14. Teacher-side safety
assert.equal((await S('GET', `/api/t/${sid}/students`)).status, 403, 'students cannot use teacher API');
const T2 = actor(); ok(await T2('POST', '/api/dev/teacher', { email: `x${run}@example.com`, name: 'Other' }), 'other teacher');
assert.equal((await T2('GET', `/api/t/${sid}/students`)).status, 404, 'other teacher cannot see studio');
step('students and other teachers are locked out of this studio');
console.log('\nAll flows passed.');
