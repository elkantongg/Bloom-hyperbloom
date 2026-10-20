// Calculations from state: best times, place rankings, bloom score.
import { DAYS, HOURS, isPast, key } from './dates.js';
import { allPlaces, votedCount } from './data.js';
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
      const who = isPast(di, h) ? [] : freeAt(di, h); // past hours can't be planned
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
  const n = allPlaces().length;
  const voted = n ? votedCount(p) / n : 0;
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
  return planStops(chosenRun())[0] || rankPlaces()[0];
}

// ---------- Multi-stop plans ----------
// The longer everyone is free, the more the plan can fit: one meal or activity for a
// short slot, back-to-back stops (eat, then cycle, then drinks) for a long one.
export const maxStops = (hours) => (hours < 2 ? 1 : hours < 4 ? 2 : hours < 6 ? 3 : 4);
const WEIGHT = { food: 1.5, drinks: 1.25, activity: 2, shopping: 1.5, other: 1.5 }; // rough hours each

// Places the group is keen on: someone loved it or said maybe, and more yes than no.
export function likedPlaces() {
  return rankPlaces().filter((p) => p.points > 0 && p.yes.length + p.maybe.length > p.no.length);
}

// The plan's stops for a time slot, in visiting order, each with its own start and end.
export function planStops(run) {
  if (!run) return [];
  const hours = run.end - run.start;
  const max = maxStops(hours);
  const ranked = rankPlaces();
  const byId = (id) => ranked.find((p) => p.id === id);
  let picks;
  if (state.pickStops) {
    picks = state.pickStops.map(byId).filter(Boolean).slice(0, max);
  } else {
    // Bloom's pick: the favourite first, then the next favourites of other types
    // (a meal, an activity, drinks...), then any other favourites if there's still time.
    const liked = likedPlaces();
    const pool = liked.length ? liked : ranked.slice(0, 1);
    picks = [];
    pool.forEach((p) => { if (picks.length < max && !picks.some((q) => q.type === p.type)) picks.push(p); });
    pool.forEach((p) => { if (picks.length < max && picks.indexOf(p) === -1) picks.push(p); });
  }
  if (!picks.length) return [];
  // Visiting order: drinks wind things down at the end, and a meal goes wherever it lands
  // closest to lunch (12pm) or dinner (6pm); everything else keeps the group's order.
  const food = picks.filter((p) => p.type === 'food');
  const rest = picks.filter((p) => p.type !== 'food' && p.type !== 'drinks');
  const drinks = picks.filter((p) => p.type === 'drinks');
  let ordered = rest.concat(food, drinks);
  if (food.length) {
    let best = null;
    for (let i = 0; i <= rest.length; i++) {
      const tryOrder = rest.slice(0, i).concat(food, rest.slice(i), drinks);
      const at = timed(tryOrder, run)[i].start;
      const miss = Math.min(Math.abs(at - 12), Math.abs(at - 18));
      if (!best || miss < best.miss) best = { miss: miss, order: tryOrder };
    }
    ordered = best.order;
  }
  return timed(ordered, run);
}

// Back-to-back times for stops in a slot, shared by how long each kind of stop usually
// takes (in half hours). A stop never stretches past 1.5x its usual length, so a few
// stops on a long free day finish early instead of a 3-hour lunch.
function timed(ordered, run) {
  const hours = run.end - run.start;
  const w = ordered.map((p) => WEIGHT[p.type] || 1.5);
  const sum = w.reduce((a, b) => a + b, 0);
  const scale = Math.min(hours / sum, 1.5);
  let prev = run.start;
  return ordered.map((p, i) => {
    const left = ordered.length - 1 - i; // stops still to fit after this one
    let end = prev + Math.max(0.5, Math.round(w[i] * scale * 2) / 2);
    if (scale === hours / sum && !left) end = run.end; // a full slot ends exactly on time
    end = Math.min(end, run.end - 0.5 * left);
    const stop = Object.assign({}, p, { start: prev, end: end });
    prev = end;
    return stop;
  });
}
