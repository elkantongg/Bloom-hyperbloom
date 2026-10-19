// Calculations from state: best times, place rankings, bloom score.
import { DAYS, HOURS, key } from './dates.js';
import { allPlaces } from './data.js';
import { people, state, total } from './state.js';

export function freeAt(di, h) {
  const k = key(di, h);
  return people().filter((p) => p.joined && p.avail.has(k));
}

// Consecutive same-day hours where exactly the same people are free.
// Cache derived data for the current task only, so one screen update
// doesn't recompute the same thing several times.
export const memo = {};
export function cached(name, fn) {
  if (!(name in memo)) {
    memo[name] = fn();
    queueMicrotask(() => { delete memo[name]; });
  }
  return memo[name];
}
export function computeRuns() { return cached('runs', computeRunsFresh); }
export function rankPlaces() { return cached('places', rankPlacesFresh); }

export function computeRunsFresh() {
  const runs = [];
  DAYS.forEach((_, di) => {
    let cur = null;
    HOURS.forEach((h) => {
      const who = freeAt(di, h);
      const sig = who.map((p) => p.id).join(',');
      if (who.length && cur && cur.sig === sig && cur.end === h) {
        cur.end = h + 1;
      } else {
        if (cur) runs.push(cur);
        cur = who.length ? { d: di, start: h, end: h + 1, who: who, sig: sig } : null;
      }
    });
    if (cur) runs.push(cur);
  });
  runs.sort((a, b) =>
    b.who.length - a.who.length ||
    (b.who.includes(state.me) - a.who.includes(state.me)) ||
    (b.end - b.start) - (a.end - a.start) ||
    a.d - b.d || a.start - b.start);
  runs.forEach((r) => { r.id = r.d + '-' + r.start + '-' + r.end; });
  return runs;
}

export function rankPlacesFresh() {
  return allPlaces().map((pl) => {
    const r = Object.assign({}, pl, { points: 0, voters: 0, yes: [], maybe: [], no: [] });
    people().forEach((p) => {
      const v = p.votes[pl.id];
      if (v === undefined) return;
      r.voters++;
      if (v === 1) { r.points += 2; r.yes.push(p); }
      else if (v === 0) { r.points += 1; r.maybe.push(p); }
      else r.no.push(p);
    });
    return r;
  // Most points (love it = 2, maybe = 1), then most "love it", then fewest passes.
  }).sort((a, b) => b.points - a.points || b.yes.length - a.yes.length || a.no.length - b.no.length);
}

export function personProgress(p) {
  if (!p.joined) return 0;
  const voted = Object.keys(p.votes).length / allPlaces().length;
  return 0.2 + (p.avail.size ? 0.4 : 0) + 0.4 * voted;
}

export function bloomScore() {
  const runs = computeRuns();
  const t = runs[0] ? runs[0].who.length / total() : 0;
  const top = rankPlaces()[0];
  const pl = top && top.voters ? top.points / (2 * total()) : 0;
  return Math.round((t * 0.5 + pl * 0.5) * 100);
}

export function chosenRun() {
  const runs = computeRuns();
  return runs.find((r) => r.id === state.pickRun) || runs[0] || null;
}
export function chosenPlace() {
  const ranked = rankPlaces();
  return ranked.find((p) => p.id === state.pickPlace) || ranked[0];
}
