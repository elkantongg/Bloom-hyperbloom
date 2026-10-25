// Calculations from state: best times, place rankings, bloom score.
import { DAYS, HOURS, isPast, key, ymd } from './dates.js';
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
  // Most people free first; among equally good times, the one the group voted for.
  runs.sort((a, b) =>
    b.who.length - a.who.length ||
    timeVotes(b).length - timeVotes(a).length ||
    (b.who.includes(state.me) - a.who.includes(state.me)) ||
    (b.end - b.start) - (a.end - a.start) ||
    a.d - b.d || a.start - b.start);
  runs.forEach((r) => { r.id = r.d + '-' + r.start + '-' + r.end; });
  return runs;
}

// Votes on a time ("t:2026-10-27@19-21"), used when several times have the same number free.
export const timeKey = (r) => 't:' + ymd(DAYS[r.d]) + '@' + r.start + '-' + r.end;
export const timeVotes = (r) => people().filter((p) => p.votes[timeKey(r)] === 1);

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
// Where someone coming back should land: the locked plan, or wherever they left off.
// (People fill in on different days, so nobody should have to find their place again.)
export function resumeStep() {
  if (state.plan) return 'bloom';
  if (!state.me.avail.size) return 'times';
  return allPlaces().some((p) => !(p.id in state.me.votes)) ? 'places' : 'bloom';
}

// Plans are for groups of 3 or more.
export const MIN_GROUP = 3;

// The host decides the plan; in demo mode that's you.
export const isHost = () => state.mode === 'demo' || !!state.me.isHost;

// The time slot of the plan the host locked in, with who can make all of it.
export function lockedRun() {
  const p = state.plan;
  if (!p) return null;
  const d = DAYS.findIndex((x) => ymd(x) === p.date);
  if (d < 0) return null;
  const who = people().filter((q) => {
    for (let h = p.start; h < p.end; h++) if (!q.avail.has(key(d, h))) return false;
    return true;
  });
  return { d: d, start: p.start, end: p.end, who: who, id: 'locked' };
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
// Suggested stops for a time slot, best first: the favourite, then favourites of
// other types (a meal, an activity, drinks...). Two meals only when the time covers
// both lunch and dinner, so nobody eats twice in a row.
export function suggestedStops(run) {
  const max = maxStops(run.end - run.start);
  const meals = run.start <= 13 && run.end >= 19 ? 2 : 1;
  const liked = likedPlaces();
  const pool = liked.length ? liked : rankPlaces().slice(0, 1);
  const picks = [];
  const fits = (p) => p.type !== 'food' || picks.filter((q) => q.type === 'food').length < meals;
  pool.forEach((p) => { if (picks.length < max && fits(p) && !picks.some((q) => q.type === p.type)) picks.push(p); });
  pool.forEach((p) => { if (picks.length < max && fits(p) && picks.indexOf(p) === -1) picks.push(p); });
  return picks;
}

// The plan's stops in visiting order, each with its own start and end. One place unless
// the host adds more ("+ Add a stop"), up to what the free time fits. `ids` = a locked plan's places.
export function planStops(run, ids) {
  if (!run) return [];
  const max = maxStops(run.end - run.start);
  const ranked = rankPlaces();
  let picks = (ids || state.pickStops || []).map((id) => ranked.find((p) => p.id === id)).filter(Boolean).slice(0, ids ? 4 : max);
  if (!picks.length) picks = suggestedStops(run).slice(0, 1);
  return picks.length ? arrange(picks, run) : [];
}

// What "＋ Add a stop" would add next (null if the time is full or nothing else fits).
export function nextStop(run) {
  if (!run) return null;
  const have = planStops(run);
  if (have.length >= maxStops(run.end - run.start)) return null;
  const meals = run.start <= 13 && run.end >= 19 ? 2 : 1;
  const ok = (p) => have.every((s) => s.id !== p.id) &&
    (p.type !== 'food' || have.filter((s) => s.type === 'food').length < meals);
  return suggestedStops(run).find(ok) || likedPlaces().find(ok) || null;
}

// Visiting order and times. Drinks wind things down at the end; meals go as close as they
// can to lunch (12pm) or dinner (6pm) and not back to back; otherwise the group's order.
// On a long free day the plan may start a little later so meals land at meal times.
function arrange(picks, run) {
  const drinks = picks.filter((p) => p.type === 'drinks');
  const main = picks.filter((p) => p.type !== 'drinks');
  const need = picks.reduce((a, p) => a + (WEIGHT[p.type] || 1.5), 0);
  const slack = Math.max(0, run.end - run.start - need); // free time the stops don't need
  let bestPlan = null, best = Infinity;
  permutations(main).forEach((perm) => {
    const order = perm.concat(drinks);
    for (let off = 0; off <= slack; off += 0.5) {
      const times = timed(order, { start: run.start + off, end: run.end });
      let cost = off * 0.6; // start later only to fix a really odd mealtime, not to fine-tune it
      order.forEach((p, i) => {
        if (p.type === 'food') cost += Math.min(Math.abs(times[i].start - 12), Math.abs(times[i].start - 18));
        if (p.type === 'food' && i && order[i - 1].type === 'food') cost += 5; // two meals in a row
        cost += 0.05 * Math.abs(i - picks.indexOf(p)); // small nudge to keep the favourite first
      });
      if (cost < best) { best = cost; bestPlan = times; }
    }
  });
  return bestPlan;
}

// Every ordering of a few stops (at most 4, so at most 24 orders).
function permutations(list) {
  if (list.length <= 1) return [list.slice()];
  const out = [];
  list.forEach((x, i) => permutations(list.slice(0, i).concat(list.slice(i + 1))).forEach((rest) => out.push([x].concat(rest))));
  return out;
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
