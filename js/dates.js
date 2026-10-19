// The planning week: days, hour slots and date formatting.

export const HOURS = Array.from({ length: 12 }, (_, i) => 10 + i); // 10am .. 9pm slots
export const pad2 = (n) => String(n).padStart(2, '0');
export const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
export const todayYmd = () => ymd(new Date());
export let DAYS = [];
// A group plans one week, starting on the day it was created.
export function setWeek(startYmd) {
  const p = (startYmd || todayYmd()).split('-').map(Number);
  DAYS = Array.from({ length: 7 }, (_, i) => new Date(p[0], p[1] - 1, p[2] + i));
}
setWeek(null);
export const key = (di, h) => ymd(DAYS[di]) + '@' + h;
export const relDay = (di) => {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((DAYS[di] - t) / 86400000);
};
export const fmtHour = (h) => (h % 12 || 12) + (h < 12 || h === 24 ? 'am' : 'pm');
export const fmtRange = (a, b) => {
  const sameHalf = (a < 12) === (b < 12 || b === 24);
  return (sameHalf ? String(a % 12 || 12) : fmtHour(a)) + '–' + fmtHour(b);
};
export const dayShort = (di) => (relDay(di) === 0 ? 'Today' : DAYS[di].toLocaleDateString(undefined, { weekday: 'short' }));
export const dayLong = (di) => (relDay(di) === 0 ? 'Today' : relDay(di) === 1 ? 'Tomorrow' : DAYS[di].toLocaleDateString(undefined, { weekday: 'long' }));
export const dateLong = (di) => DAYS[di].toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
