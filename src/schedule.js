// Scheduling engine: 30-minute blocks, availability, timetable generation, fees.
import { localToUtc, localDate, localMinutes, weekdayOf, addDays, weekBounds, iso } from './time.js';
import { uid, fail, nowIso } from './lib.js';

export const BLOCK = 30;

export function blocksFor(startMs, minutes) {
  const out = [];
  for (let m = 0; m < minutes; m += BLOCK) out.push(iso(startMs + m * 60000));
  return out;
}

export async function getRules(env, learnerId) {
  return env.DB.prepare('SELECT * FROM learner_rules WHERE learner_id = ?').bind(learnerId).first();
}

/** Blocks already taken in [fromMs, toMs), excluding one booking (used when moving it). */
async function takenBlocks(env, studioId, fromMs, toMs, ignoreBookingId) {
  const rows = (await env.DB.prepare('SELECT block_start, booking_id FROM booking_blocks WHERE studio_id = ? AND block_start >= ? AND block_start < ?')
    .bind(studioId, iso(fromMs), iso(toMs)).all()).results;
  return new Set(rows.filter((r) => !ignoreBookingId || r.booking_id !== ignoreBookingId).map((r) => r.block_start));
}
async function timeOff(env, studioId, fromMs, toMs) {
  return (await env.DB.prepare('SELECT starts_at, ends_at FROM time_off WHERE studio_id = ? AND ends_at > ? AND starts_at < ?')
    .bind(studioId, iso(fromMs), iso(toMs)).all()).results.map((r) => [Date.parse(r.starts_at), Date.parse(r.ends_at)]);
}

/**
 * Start times (local minutes) on `date` where a class of `minutes` fits:
 * inside the teacher's weekly free time, no taken blocks, no time off.
 * studentRules adds the student-side limits (notice, horizon).
 */
export async function freeStarts(env, studio, date, minutes, { ignoreBookingId, student = false } = {}) {
  const tz = studio.timezone;
  const windows = (await env.DB.prepare('SELECT start_min, end_min FROM availability WHERE studio_id = ? AND weekday = ? ORDER BY start_min')
    .bind(studio.id, weekdayOf(date)).all()).results;
  if (!windows.length) return [];
  const dayStart = localToUtc(date, 0, tz), dayEnd = localToUtc(addDays(date, 1), 0, tz);
  const taken = await takenBlocks(env, studio.id, dayStart, dayEnd, ignoreBookingId);
  const off = await timeOff(env, studio.id, dayStart, dayEnd);
  const now = Date.now();
  const earliest = student ? now + studio.booking_notice_hours * 3600000 : now;
  const latest = student ? now + studio.booking_horizon_days * 86400000 : Infinity;
  const out = [];
  for (const w of windows) {
    const first = Math.ceil(w.start_min / BLOCK) * BLOCK;
    for (let s = first; s + minutes <= w.end_min; s += BLOCK) {
      const startMs = localToUtc(date, s, tz), endMs = startMs + minutes * 60000;
      if (startMs < earliest || startMs > latest) continue;
      if (blocksFor(startMs, minutes).some((b) => taken.has(b))) continue;
      if (off.some(([a, b]) => startMs < b && endMs > a)) continue;
      out.push(s);
    }
  }
  return out;
}

/** Weekly cap for student-initiated extra classes. Regular timetable classes don't count against it. */
export async function weekCount(env, studio, learnerId, date, kinds) {
  const [a, b] = weekBounds(date, studio.timezone);
  const r = await env.DB.prepare(`SELECT COUNT(*) n FROM bookings WHERE learner_id = ? AND status IN ('confirmed','completed','no_show')
     AND starts_at >= ? AND starts_at < ? AND kind IN (${kinds.map(() => '?').join(',')})`)
    .bind(learnerId, iso(a), iso(b), ...kinds).first();
  return r.n;
}

/** Which link a virtual class uses: learner override, else the requested room, else the studio default. */
export async function resolveRoom(env, studio, learnerId, roomId) {
  let room = null;
  if (roomId) room = await env.DB.prepare('SELECT * FROM meeting_rooms WHERE id = ? AND studio_id = ? AND active = 1').bind(roomId, studio.id).first();
  if (!room) room = await env.DB.prepare('SELECT r.* FROM learner_rooms lr JOIN meeting_rooms r ON r.id = lr.room_id WHERE lr.learner_id = ? AND r.active = 1').bind(learnerId).first();
  if (!room) room = await env.DB.prepare('SELECT * FROM meeting_rooms WHERE studio_id = ? AND active = 1 ORDER BY is_default DESC, created_at LIMIT 1').bind(studio.id).first();
  if (!room) fail(409, 'No online classroom is set up yet. The teacher needs to add one in Settings.');
  if (room.kind !== 'fixed') fail(501, `${room.label} needs its account connection, which is coming in phase 2. Use a fixed room for now.`);
  return room;
}

/** Statements that create a booking and claim its blocks atomically (run inside env.DB.batch). */
export function bookingStatements(env, b) {
  const stmts = [env.DB.prepare(`INSERT INTO bookings (id, studio_id, learner_id, membership_id, starts_at, ends_at, minutes, kind, series_id, makeup_credit_id,
      mode, location, room_id, meeting_url, status, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'confirmed', ?)`)
    .bind(b.id, b.studio_id, b.learner_id, b.membership_id, b.starts_at, b.ends_at, b.minutes, b.kind, b.series_id || null, b.makeup_credit_id || null,
      b.mode, b.location || null, b.room_id || null, b.meeting_url || null, b.created_by)];
  for (const blk of blocksFor(Date.parse(b.starts_at), b.minutes)) {
    stmts.push(env.DB.prepare('INSERT INTO booking_blocks (studio_id, block_start, booking_id) VALUES (?,?,?)').bind(b.studio_id, blk, b.id));
  }
  return stmts;
}
export const isConflict = (e) => /UNIQUE|PRIMARY KEY|constraint/i.test(String(e?.message || e));

/** Build a booking record for a learner at local date + start minute. */
export async function makeBooking(env, studio, learner, { date, start_min, minutes, kind, mode, room_id, series_id, makeup_credit_id, created_by }) {
  const startMs = localToUtc(date, start_min, studio.timezone);
  const b = {
    id: uid('b'), studio_id: studio.id, learner_id: learner.id, membership_id: learner.membership_id,
    starts_at: iso(startMs), ends_at: iso(startMs + minutes * 60000), minutes, kind, mode,
    series_id, makeup_credit_id, created_by,
  };
  if (mode === 'virtual') {
    const room = await resolveRoom(env, studio, learner.id, room_id);
    b.room_id = room.id;
    b.meeting_url = room.url;
  } else {
    b.location = studio.studio_address || null;
  }
  return b;
}

/** Create the teacher's recurring classes up to `untilDate`. Dates that clash are skipped and reported. */
export async function generateSeries(env, studio, untilDate) {
  const series = (await env.DB.prepare(`SELECT s.*, l.membership_id FROM class_series s JOIN learners l ON l.id = s.learner_id
     WHERE s.studio_id = ? AND s.active = 1 AND (s.generated_to IS NULL OR s.generated_to < ?)`).bind(studio.id, untilDate).all()).results;
  const skipped = [];
  const today = localDate(Date.now(), studio.timezone);
  for (const s of series) {
    let d = s.generated_to ? addDays(s.generated_to, 1) : s.starts_on;
    if (d < today) d = today;
    const last = s.ends_on && s.ends_on < untilDate ? s.ends_on : untilDate;
    while (d <= last) {
      if (weekdayOf(d) === s.weekday) {
        const exists = await env.DB.prepare('SELECT 1 FROM bookings WHERE series_id = ? AND starts_at = ?')
          .bind(s.id, iso(localToUtc(d, s.start_min, studio.timezone))).first();
        const off = await timeOff(env, studio.id, localToUtc(d, s.start_min, studio.timezone), localToUtc(d, s.start_min + s.minutes, studio.timezone));
        if (!exists && !off.length) {
          try {
            const b = await makeBooking(env, studio, { id: s.learner_id, membership_id: s.membership_id },
              { date: d, start_min: s.start_min, minutes: s.minutes, kind: 'regular', mode: s.mode, room_id: s.room_id, series_id: s.id, created_by: 'timetable' });
            await env.DB.batch(bookingStatements(env, b));
          } catch (e) {
            if (isConflict(e)) skipped.push({ series_id: s.id, date: d }); else throw e;
          }
        }
      }
      d = addDays(d, 1);
    }
    await env.DB.prepare('UPDATE class_series SET generated_to = ? WHERE id = ?').bind(last, s.id).run();
  }
  return skipped;
}

export function feeFor(rules, minutes) {
  if (!rules) return 0;
  return rules.fee_basis === 'per_30min' ? rules.fee_minor * Math.ceil(minutes / BLOCK) : rules.fee_minor;
}

/** Mark finished classes completed and post their charges (idempotent). */
export async function settle(env, studio) {
  const now = nowIso();
  const due = (await env.DB.prepare(`SELECT b.*, m.currency, r.fee_minor, r.fee_basis FROM bookings b
      JOIN memberships m ON m.id = b.membership_id LEFT JOIN learner_rules r ON r.learner_id = b.learner_id
      WHERE b.studio_id = ? AND b.status = 'confirmed' AND b.ends_at <= ?`).bind(studio.id, now).all()).results;
  const stmts = [];
  for (const b of due) {
    stmts.push(env.DB.prepare("UPDATE bookings SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'confirmed'").bind(now, b.id));
    const amount = feeFor(b, b.minutes);
    if (amount > 0) {
      stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO ledger (id, studio_id, membership_id, learner_id, kind, amount_minor, currency, booking_id, note, created_by)
        VALUES (?,?,?,?, 'charge', ?, ?, ?, ?, 'system')`).bind(uid('lg'), studio.id, b.membership_id, b.learner_id, amount,
        b.currency || studio.default_currency, b.id, `${b.minutes} min class`));
    }
  }
  // Group classes with a fee: charge everyone who joined once the class has ended.
  const groups = (await env.DB.prepare(`SELECT g.id, g.fee_minor, gs.learner_id, l.membership_id, m.currency FROM group_classes g
      JOIN group_signups gs ON gs.group_id = g.id AND gs.status = 'joined'
      JOIN learners l ON l.id = gs.learner_id JOIN memberships m ON m.id = l.membership_id
      WHERE g.studio_id = ? AND g.ends_at <= ? AND g.fee_minor > 0`).bind(studio.id, now).all()).results;
  for (const g of groups) {
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO ledger (id, studio_id, membership_id, learner_id, kind, amount_minor, currency, group_ref, note, created_by)
      VALUES (?,?,?,?, 'charge', ?, ?, ?, 'Group class', 'system')`).bind(uid('lg'), studio.id, g.membership_id, g.learner_id, g.fee_minor,
      g.currency || studio.default_currency, `${g.id}:${g.learner_id}`));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

/** Balance per membership+currency: charges + positive adjustments - payments. */
export async function balances(env, studioId, membershipId) {
  const where = membershipId ? 'AND membership_id = ?' : '';
  const binds = membershipId ? [studioId, membershipId] : [studioId];
  return (await env.DB.prepare(`SELECT membership_id, currency,
      SUM(CASE WHEN kind = 'payment' THEN -amount_minor ELSE amount_minor END) AS due_minor,
      SUM(CASE WHEN kind = 'charge' THEN 1 ELSE 0 END) AS charges
      FROM ledger WHERE studio_id = ? ${where} GROUP BY membership_id, currency`).bind(...binds).all()).results;
}

export { localDate, localMinutes, addDays };
