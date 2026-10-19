// Shared UI pieces: toasts, avatars, the flower, the side panel, milestones.
import { $, $$, esc, reduceMotion } from './util.js';
import { dayLong, dayShort, fmtRange } from './dates.js';
import { allPlaces, votedCount } from './data.js';
import { people, state, total } from './state.js';
import { bloomScore, computeRuns, personProgress, rankPlaces } from './derive.js';
import { updateStepper } from './router.js';
import { renderBest, updateAllCells } from './times.js';
import { dragActive, renderDeck, renderRanking, updateCardFriends, vote, voting } from './places.js';
import { renderPlanCard, renderWaiting } from './bloom.js';

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
  while (wrap.children.length > 3) wrap.firstChild.remove();
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

export const PETAL = 'M0,0 C-26,-22 -24,-70 0,-86 C24,-70 26,-22 0,0 Z';
export function flowerSVG(opts) {
  opts = opts || {};
  const ps = people();
  let petals = '';
  ps.forEach((p, i) => {
    const a = (360 / ps.length) * i;
    petals += '<g transform="rotate(' + a + ')"><path class="petal" data-pid="' + p.id + '" d="' + PETAL + '" fill="' + p.color + '"/></g>';
  });
  const stem = opts.stem
    ? '<path class="stem" d="M0,20 C6,80 -6,120 0,170" fill="none" stroke-width="7" stroke-linecap="round"/>' +
      '<path class="leaf" d="M0,120 C30,100 58,108 70,92 C52,128 22,132 0,126 Z"/>' +
      '<path class="leaf" d="M0,140 C-30,124 -56,132 -66,118 C-50,152 -22,152 0,146 Z"/>'
    : '';
  const vb = opts.stem ? '-110 -110 220 290' : '-100 -100 200 200';
  return '<svg class="flower" data-stem="' + (opts.stem ? 1 : 0) + '" viewBox="' + vb + '" role="img" aria-label="' + esc(flowerLabel()) + '">' +
    stem + petals +
    '<circle class="core" r="18" fill="var(--gold)"/>' +
    '<circle r="6" fill="#fff" opacity=".55" cx="-5" cy="-5"/>' +
    '</svg>';
}
export function flowerLabel() {
  return 'Plan flower: ' + bloomScore() + '% in bloom. One petal per person; petals open as people add times and vote.';
}
export function updateFlowers() {
  const score = bloomScore();
  $$('.flower').forEach((svg) => {
    if (svg.querySelectorAll('.petal').length !== people().length) {
      const fresh = document.createElement('div');
      fresh.innerHTML = flowerSVG({ stem: svg.dataset.stem === '1' });
      svg.replaceWith(fresh.firstChild);
    }
  });
  $$('.flower').forEach((svg) => {
    people().forEach((p) => {
      const petal = svg.querySelector('.petal[data-pid="' + p.id + '"]');
      if (!petal) return;
      const prog = personProgress(p);
      petal.style.setProperty('--s', (0.18 + prog * 0.82).toFixed(3));
      petal.classList.toggle('bud', !p.joined);
    });
    const core = svg.querySelector('.core');
    if (core) core.setAttribute('r', String(14 + score * 0.12));
    svg.setAttribute('aria-label', flowerLabel());
  });
  $$('[data-bloom-score]').forEach((el) => { el.textContent = score ? score + '%' : '🌱'; });
  $$('[data-bloom-label]').forEach((el) => { el.textContent = score ? 'in bloom' : 'just planted'; });
}

export function sidebarHTML() {
  return '<aside class="side" aria-label="Your group">' +
    '<div class="panel group">' +
      '<div class="flower-wrap">' + flowerSVG() + '</div>' +
      '<div>' +
        '<div class="bloom-meter"><strong data-bloom-score>🌱</strong><span data-bloom-label>just planted</span></div>' +
        '<h2 class="sr-only">Who’s in</h2>' +
        '<ul class="people" id="people"></ul>' +
      '</div>' +
    '</div>' +
    '<p class="demo-note">' + (state.mode === 'live'
      ? '🟢 Live group · changes from everyone appear within a few seconds.'
      : 'Demo mode: Maya, Jun, Priya and Sam are simulated friends so you can see Bloom update live.') + '</p>' +
  '</aside>';
}
export function statusOf(p) {
  if (!p.joined) return 'Invite sent';
  const v = votedCount(p);
  if (v >= allPlaces().length) return 'All done ✓';
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
    updateFlowers();
    updatePeople();
    updateStepper();
    if (state.step === 'times') { updateAllCells(); renderBest(); }
    if (state.step === 'places') {
      renderRanking(); updateCardFriends();
      // A friend's new suggestion should appear in the deck without interrupting a swipe.
      const shown = $$('#deck .card').map((c) => c.dataset.id).join(',');
      const want = allPlaces().slice(state.deckIndex, state.deckIndex + 3).map((p) => p.id).reverse().join(',');
      if (!dragActive && !voting && shown !== want) renderDeck();
    }
    if (state.step === 'bloom') { renderPlanCard(); renderWaiting(); }
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
    celebrate('🔥 ' + top.name + ' is the group favourite');
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
