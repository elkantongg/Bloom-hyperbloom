// The planning window (about a month, shown a week at a time), hour slots and date formatting.

export const HOURS = Array.from({ length: 12 }, (_, i) => 10 + i); // 10am .. 9pm slots
export const pad2 = (n) => String(n).padStart(2, '0');
export const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
export const todayYmd = () => ymd(new Date());
export let DAYS = [];
export const WEEKS = 5; // 35 days: a month from the day the group was created
// A group plans about a month ahead, starting on the day it was created.
export function setWeek(startYmd) {
  const p = (startYmd || todayYmd()).split('-').map(Number);
  DAYS = Array.from({ length: WEEKS * 7 }, (_, i) => new Date(p[0], p[1] - 1, p[2] + i));
}
// Weeks count from the start date, so week 1 is "today and the next 6 days".
export const weekOf = (di) => Math.floor(di / 7);
export const weekDays = (w) => Array.from({ length: 7 }, (_, i) => w * 7 + i);
const MONTH = { month: 'short' };
// "22 – 28 Oct" or "29 Oct – 4 Nov"
export function fmtWeek(w) {
  const a = DAYS[w * 7], b = DAYS[w * 7 + 6];
  return a.getMonth() === b.getMonth()
    ? a.getDate() + ' – ' + b.getDate() + ' ' + b.toLocaleDateString(undefined, MONTH)
    : a.getDate() + ' ' + a.toLocaleDateString(undefined, MONTH) + ' – ' + b.getDate() + ' ' + b.toLocaleDateString(undefined, MONTH);
}
setWeek(null);
export const key = (di, h) => ymd(DAYS[di]) + '@' + h;
export const relDay = (di) => {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((DAYS[di] - t) / 86400000);
};
// An hour slot is in the past once it has ended (e.g. the 3pm slot after 4pm today).
export const isPast = (di, h) => {
  const end = new Date(DAYS[di]); end.setHours(h + 1, 0, 0, 0);
  return end <= new Date();
};
// The whole planning week is over.
export const weekOver = () => isPast(DAYS.length - 1, HOURS[HOURS.length - 1]);
export const fmtHour = (h) => (h % 12 || 12) + (h < 12 || h === 24 ? 'am' : 'pm');
export const fmtRange = (a, b) => {
  const sameHalf = (a < 12) === (b < 12 || b === 24);
  return (sameHalf ? String(a % 12 || 12) : fmtHour(a)) + '–' + fmtHour(b);
};
// Within the next 7 days a weekday is enough ("Sat"); further out it needs the date ("Sat 8 Nov").
const withDate = (di, weekday) => DAYS[di].toLocaleDateString(undefined, { weekday: weekday }) + ' ' + DAYS[di].getDate() + ' ' + DAYS[di].toLocaleDateString(undefined, MONTH);
export const dayShort = (di) => (relDay(di) === 0 ? 'Today' : relDay(di) < 7 ? DAYS[di].toLocaleDateString(undefined, { weekday: 'short' }) : withDate(di, 'short'));
export const dayLong = (di) => (relDay(di) === 0 ? 'Today' : relDay(di) === 1 ? 'Tomorrow' : relDay(di) < 7 ? DAYS[di].toLocaleDateString(undefined, { weekday: 'long' }) : withDate(di, 'long'));
export const dateLong = (di) => DAYS[di].toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
