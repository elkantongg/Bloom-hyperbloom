// Shared UI pieces: toasts, avatars, the flower, the side panel, milestones.
import { $, $$, esc, reduceMotion } from './util.js';
import { dayLong, dayShort, fmtRange } from './dates.js';
import { allPlaces, placeTitle, votedCount } from './data.js';
import { people, state, total } from './state.js';
import { bloomScore, computeRuns, lockedRun, personProgress, rankPlaces } from './derive.js';
import { render, updateStepper } from './router.js';
import { renderBest, updateAllCells } from './times.js';
import { dragActive, renderDeck, renderRanking, updateCardFriends, vote, voting } from './places.js';
import { bloomView, renderPlanCard, renderWaiting } from './bloom.js';
import { renderWeatherPanel } from './weather.js';

export function announce(msg) {
  const live = $('#live');
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 60);
}
export function toast(person, msg) {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = (person ? avatar(person, 'sm') : '') + '<span>' + esc(msg) + '</span>';
  wrap.appendChild(el);
  // Phones show one notice at a time (the newest), so they never cover the screen.
  const keep = window.matchMedia('(max-width: 600px)').matches ? 1 : 3;
  while (wrap.children.length > keep) wrap.firstChild.remove();
  setTimeout(() => el.remove(), 3300);
}
export function avatar(p, size) {
  const waiting = !p.joined ? ' waiting' : '';
  return '<span class="av ' + (size || '') + waiting + '" style="--c:' + p.color + '" title="' + esc(p.name) + '" aria-hidden="true">' + esc(p.name.trim().charAt(0).toUpperCase() || '?') + '</span>';
}
export function avatarStack(list, size) {
  return '<span class="av-stack">' + list.map((p) => avatar(p, size || 'sm')).join('') + '</span>';
}
export function displayName(p) { return p === state.me && p.name !== 'You' ? p.name + ' (you)' : p.name; }
export function namesList(list) {
  const n = list.map((p) => (p === state.me ? 'you' : p.name));
  if (n.length <= 1) return n.join('');
  return n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
}

// The couch: one seat per friend. Someone "sits down" (their circle grows into the
// seat) as they add hours and vote; an empty dashed seat means they haven't joined yet.
export function couchSVG(opts) {
  opts = opts || {};
  const ps = people();
  const inner = 176, x0 = -88, seat = inner / ps.length;
  const r = Math.min(17, seat * 0.38);
  let sitters = '';
  ps.forEach((p, i) => {
    const cx = (x0 + seat * (i + 0.5)).toFixed(1);
    sitters += '<g class="seat" transform="translate(' + cx + ',-8)" style="--i:' + i + '">' +
      '<circle class="seat-empty" r="' + r.toFixed(1) + '"/>' +
      '<g class="sitter" data-pid="' + p.id + '"><circle r="' + r.toFixed(1) + '" fill="' + p.color + '"/>' +
        (r >= 9 ? '<text y="' + (r * 0.36).toFixed(1) + '" font-size="' + (r * 0.95).toFixed(1) + '">' + esc(p.name.trim().charAt(0).toUpperCase() || '?') + '</text>' : '') +
      '</g></g>';
  });
  // The final reveal ("party"): sparkles that burst around the couch once everyone's sat down.
  // (The wrapper holds the position; the animation only scales/spins the star inside it.)
  const sparkle = (x, y, sz, i, c) => '<g transform="translate(' + x + ',' + y + ') scale(' + sz + ')">' +
    '<path class="c-spark" style="--i:' + i + '" d="M0 -10 L2.5 -2.5 L10 0 L2.5 2.5 L0 10 L-2.5 2.5 L-10 0 L-2.5 -2.5 Z" fill="' + c + '"/></g>';
  const sparks = opts.party ? [[-104, -54, 1.1, 0, '#FFD25E'], [100, -50, 0.9, 1, '#FF8A4C'], [-60, -70, 0.7, 2, '#7C5CFF'],
    [56, -72, 1, 3, '#FFD25E'], [0, -80, 1.2, 4, '#2DD4A7'], [-118, -4, 0.6, 5, '#FF7A7A'], [116, -2, 0.7, 6, '#7EA8FF']]
    .map((x) => sparkle.apply(null, x)).join('') : '';
  return '<svg class="couch' + (opts.party ? ' party' : '') + '" data-big="' + (opts.big ? 1 : 0) + '" data-party="' + (opts.party ? 1 : 0) + '" ' +
      'viewBox="' + (opts.party ? '-124 -86 248 136' : '-112 -62 224 112') + '" role="img" aria-label="' + esc(couchLabel()) + '">' +
    '<g class="c-body">' +
      '<rect class="c-back" x="-94" y="-46" width="188" height="52" rx="18"/>' +
      '<rect class="c-arm" x="-110" y="-20" width="26" height="50" rx="11"/>' +
      '<rect class="c-arm" x="84" y="-20" width="26" height="50" rx="11"/>' +
      '<rect class="c-seat" x="-90" y="4" width="180" height="26" rx="10"/>' +
      '<rect class="c-leg" x="-96" y="30" width="8" height="12" rx="2"/><rect class="c-leg" x="88" y="30" width="8" height="12" rx="2"/>' +
      sitters +
    '</g>' + sparks +
    '</svg>';
}
export function couchLabel() {
  const seated = people().filter((p) => personProgress(p) >= 1).length;
  return 'The couch: ' + bloomScore() + '% ready. One seat per person; people sit down as they add times and vote. ' + seated + ' of ' + total() + ' done.';
}
export function updateCouch() {
  const score = bloomScore();
  $$('.couch').forEach((svg) => {
    if (svg.querySelectorAll('.sitter').length !== people().length) {
      const fresh = document.createElement('div');
      fresh.innerHTML = couchSVG({ big: svg.dataset.big === '1', party: svg.dataset.party === '1' });
      svg.replaceWith(fresh.firstChild);
    }
  });
  $$('.couch').forEach((svg) => {
    people().forEach((p) => {
      const s = svg.querySelector('.sitter[data-pid="' + p.id + '"]');
      if (!s) return;
      // On the final plan, everyone who's coming is fully seated; anyone who can't leaves an empty seat.
      const going = svg.dataset.party === '1' && lockedRun() ? lockedRun().who.indexOf(p) !== -1 : null;
      s.style.setProperty('--s', going !== null ? (going ? '1' : '0') : p.joined ? (0.35 + personProgress(p) * 0.65).toFixed(3) : '0');
    });
    svg.setAttribute('aria-label', couchLabel());
  });
  $$('[data-bloom-score]').forEach((el) => { el.textContent = score ? score + '%' : '👋'; });
  $$('[data-bloom-label]').forEach((el) => { el.textContent = score ? 'ready' : 'just started'; });
}

export function sidebarHTML() {
  return '<aside class="side" aria-label="Your group">' +
    '<div class="panel group">' +
      '<div class="couch-wrap">' + couchSVG() + '</div>' +
      '<div>' +
        '<div class="bloom-meter"><strong data-bloom-score>👋</strong><span data-bloom-label>just started</span></div>' +
        '<h2 class="sr-only">Who’s in</h2>' +
        '<ul class="people" id="people"></ul>' +
      '</div>' +
    '</div>' +
    '<p class="demo-note">' + (state.mode === 'live'
      ? '🟢 Live group · changes from everyone appear within a few seconds.'
      : 'Demo mode: Maya, Jun, Priya and Sam are simulated friends so you can see Lepak update live.') + '</p>' +
  '</aside>';
}
export function statusOf(p) {
  if (!p.joined) return 'Invite sent';
  const v = votedCount(p);
  // Done means hours painted and every place voted on (a new group has no places yet).
  if (p.avail.size && allPlaces().length && v >= allPlaces().length) return 'All done ✓';
  if (v > 0) return 'Voted ' + v + ' of ' + allPlaces().length;
  if (p.avail.size) return 'Added ' + p.avail.size + ' free hours';
  return p === state.me ? 'Paint your free times' : 'Adding times…';
}
export function updatePeople() {
  const ul = $('#people');
  if (!ul) return;
  ul.innerHTML = people().map((p) =>
    '<li>' + avatar(p) + '<div><div class="who">' + esc(displayName(p)) + '</div>' +
    '<div class="status">' + esc(statusOf(p)) + '</div>' +
    '<div class="progress" aria-hidden="true"><i style="--p:' + Math.round(personProgress(p) * 100) + '%;--c:' + p.color + '"></i></div></div></li>'
  ).join('');
}

export let refreshQueued = false;
export function refresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    updateCouch();
    updatePeople();
    updateStepper();
    if (state.step === 'times') { updateAllCells(); renderBest(); }
    if (state.step === 'places') {
      renderRanking(); updateCardFriends(); renderWeatherPanel();
      // A friend's new suggestion should appear in the deck without interrupting a swipe.
      const shown = $$('#deck .card').map((c) => c.dataset.id).join(',');
      const want = allPlaces().slice(state.deckIndex, state.deckIndex + 3).map((p) => p.id).reverse().join(',');
      if (!dragActive && !voting && shown !== want) renderDeck();
    }
    if (state.step === 'bloom') {
      // The host locked (or reopened) the plan while you were looking: switch views.
      const stage = $('#main [data-view]');
      if (stage && stage.dataset.view !== bloomView()) render();
      else { renderPlanCard(); renderWaiting(); }
    }
    checkMilestones();
  });
}

export function checkMilestones() {
  if (state.step === 'home' || state.step === 'join') return;
  const m = state.milestones;
  const best = computeRuns()[0];
  if (!m.match && best && best.who.length >= 2 && best.who.includes(state.me)) {
    m.match = true;
    celebrate('✨ First match! ' + namesList(best.who.filter((p) => p !== state.me)) + ' can do ' + dayShort(best.d) + ' ' + fmtRange(best.start, best.end));
  }
  if (!m.all && best && total() > 1 && best.who.length === total()) {
    m.all = true;
    celebrate('🎉 Everyone’s free ' + dayLong(best.d) + ' ' + fmtRange(best.start, best.end) + '!');
  }
  const top = rankPlaces()[0];
  if (!m.fav && top && top.yes.length >= Math.max(2, Math.ceil(total() * 0.6))) {
    m.fav = true;
    celebrate('🔥 ' + placeTitle(top) + ' is the group favourite');
  }
}
export function celebrate(msg) {
  toast(null, msg);
  announce(msg);
  buzz([12, 50, 12]);
}
export function buzz(pattern) {
  if (reduceMotion || !navigator.vibrate) return;
  // Browsers only allow vibration after the person has tapped the page.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try { navigator.vibrate(pattern); } catch (e) { /* unsupported */ }
}

// Copy text, and only say "copied" if it really was. If the browser blocks the
// clipboard, show the text so the person can copy it themselves.
export function copy(text, msg) {
  const done = () => { toast(null, msg); announce(msg); };
  const fallback = () => {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    t.remove();
    if (ok) done(); else window.prompt('Copy this:', text);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}
