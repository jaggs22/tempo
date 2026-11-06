// Shared helpers: HTTP, ids, hashing, sessions, notifications.
import { b64u, sendPush, generateVapidKeys } from './push.js';

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export const uid = (prefix) => `${prefix}_${b64u(crypto.getRandomValues(new Uint8Array(12)))}`;
export const token = () => b64u(crypto.getRandomValues(new Uint8Array(32)));
export async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const normName = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
export const cleanName = (s) => String(s || '').trim().replace(/\s+/g, ' ');
export const nowIso = () => new Date().toISOString();

// ---------- validation ----------
export function str(v, name, { min = 1, max = 200, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    fail(400, `${name} is required`);
  }
  const s = String(v).trim();
  if (s.length < min || s.length > max) fail(400, `${name} must be ${min}-${max} characters`);
  return s;
}
export function int(v, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    fail(400, `${name} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${name} must be a whole number between ${min} and ${max}`);
  return n;
}
export function oneOf(v, name, options, fallback) {
  if (v === undefined || v === null || v === '') { if (fallback !== undefined) return fallback; fail(400, `${name} is required`); }
  if (!options.includes(v)) fail(400, `${name} must be one of ${options.join(', ')}`);
  return v;
}
export function url(v, name, optional = false) {
  const s = str(v, name, { max: 500, optional });
  if (s === null) return null;
  let u;
  try { u = new URL(s); } catch { fail(400, `${name} must be a full link starting with https://`); }
  if (u.protocol !== 'https:') fail(400, `${name} must start with https://`);
  return u.toString();
}
export const currencyDigits = (cur) => {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; }
  catch { fail(400, `Unknown currency ${cur}`); }
};
export function currency(v, name = 'currency') {
  const c = String(v || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) fail(400, `${name} must be a 3-letter code like SGD`);
  currencyDigits(c);
  return c;
}
/** "45" or "45.50" in major units -> minor units for that currency. */
export function toMinor(amount, cur, name = 'amount') {
  const s = String(amount ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) fail(400, `${name} must be a positive number`);
  const digits = currencyDigits(cur);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > digits) fail(400, `${name} has too many decimal places for ${cur}`);
  return Number(whole) * 10 ** digits + Number((frac + '0'.repeat(digits)).slice(0, digits) || 0);
}

// ---------- sessions ----------
const COOKIE = 'tempo_session';
const MAX_AGE = 400 * 24 * 3600; // browsers cap cookie lifetime at 400 days
export function readCookie(req, name) {
  const h = req.headers.get('cookie') || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
export async function createSession(env, userId, device) {
  const t = token();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, device, expires_at) VALUES (?,?,?,?)')
    .bind(await sha256(t), userId, (device || '').slice(0, 120), new Date(Date.now() + MAX_AGE * 1000).toISOString()).run();
  return `${COOKIE}=${t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}
export async function getUser(env, req) {
  const t = readCookie(req, COOKIE);
  if (!t) return null;
  return env.DB.prepare(`SELECT u.*, s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id
                         WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await sha256(t), nowIso()).first();
}
export async function destroySession(env, req) {
  const t = readCookie(req, COOKIE);
  if (t) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(t)).run();
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ---------- notifications ----------
/** VAPID keys: from Worker secrets if set, otherwise generated once and kept in D1. */
let vapidCache = null;
export async function getVapid(env) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  if (vapidCache) return vapidCache;
  let row = await env.DB.prepare("SELECT value FROM app_config WHERE key = 'vapid'").first();
  if (!row) {
    const k = await generateVapidKeys();
    await env.DB.prepare("INSERT OR IGNORE INTO app_config (key, value) VALUES ('vapid', ?)").bind(JSON.stringify(k)).run();
    row = await env.DB.prepare("SELECT value FROM app_config WHERE key = 'vapid'").first();
  }
  vapidCache = JSON.parse(row.value);
  return vapidCache;
}

/** In-app notification for each user, plus Web Push to every device they enabled. */
export async function notify(env, ctx, studioId, userIds, { title, body, url: link }) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  await env.DB.batch(ids.map((u) => env.DB.prepare('INSERT INTO notifications (id, studio_id, user_id, title, body, url) VALUES (?,?,?,?,?,?)')
    .bind(uid('n'), studioId, u, title, body || null, link || null)));
  const vapid = { ...(await getVapid(env)), subject: env.VAPID_SUBJECT || 'https://tempo.app' };
  const subs = (await env.DB.prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results;
  const work = Promise.all(subs.map(async (s) => {
    try {
      const status = await sendPush(s, { title, body, url: link || '/' }, vapid);
      if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(s.endpoint).run();
    } catch (e) { console.log('push failed', e.message); }
  }));
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
}
