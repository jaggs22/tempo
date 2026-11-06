// Time-zone helpers built on Intl (no dependencies). All instants are epoch ms.

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}
export function partsAt(ms, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
export function offsetMin(ms, tz) {
  const p = partsAt(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}
/** Local wall time (date + minutes after midnight) in tz -> epoch ms. */
export function localToUtc(dateStr, minutes, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const off = offsetMin(guess, tz);
  let ms = guess - off * 60000;
  const off2 = offsetMin(ms, tz);
  if (off2 !== off) ms = guess - off2 * 60000;
  return ms;
}
export function localDate(ms, tz) {
  const p = partsAt(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}
export function localMinutes(ms, tz) {
  const p = partsAt(ms, tz);
  return +p.hour * 60 + +p.minute;
}
export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** Monday..next Monday (local) containing dateStr, as UTC ms bounds. */
export function weekBounds(dateStr, tz) {
  const wd = weekdayOf(dateStr);
  const monday = addDays(dateStr, -((wd + 6) % 7));
  return [localToUtc(monday, 0, tz), localToUtc(addDays(monday, 7), 0, tz)];
}
export const iso = (ms) => new Date(ms).toISOString();
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
