// Step 1: painting free hours on the week grid.
import { $, $$, esc, reduceMotion } from './util.js';
import { dayLong, DAYS, dayShort, fmtHour, fmtRange, HOURS, isPast, key, weekOver } from './dates.js';
import { state, total } from './state.js';
import { computeRuns, freeAt } from './derive.js';
import { announce, avatarStack, buzz, copy, refresh, sidebarHTML, toast } from './ui.js';
import { go, later } from './router.js';
import { prefs } from './settings.js';
import { invite, inviteLink, saveSoon } from './live.js';

export function timesHTML() {
  let grid = '<div class="grid" id="grid" role="grid" aria-label="Your availability this week" aria-describedby="gridHelp" style="--cols:' + DAYS.length + '">';
  grid += '<div class="g-row" role="row"><div role="columnheader"><span class="sr-only">Time</span></div>';
  DAYS.forEach((d, di) => {
    const wk = d.getDay() === 0 || d.getDay() === 6 ? ' weekend' : '';
    grid += '<div class="g-day' + wk + '" role="columnheader">' + dayShort(di) + '<span class="dom">' + d.getDate() + '</span></div>';
  });
  grid += '</div>';
  HOURS.forEach((h, r) => {
    grid += '<div class="g-row" role="row"><div class="g-time" role="rowheader">' + fmtHour(h) + '</div>';
    DAYS.forEach((_, di) => {
      grid += '<div class="cell" role="gridcell" tabindex="' + (r === 0 && di === 0 ? 0 : -1) + '" data-d="' + di + '" data-h="' + h + '" aria-selected="false"></div>';
    });
    grid += '</div>';
  });
  grid += '</div>';

  return '<div class="page-top"><div class="page-head"><h1>When are you free?</h1>' +
      (weekOver() ? '<p class="week-over" role="status">⏰ This plan’s week is over. <a href="#/" class="link-btn">Start a new plan</a> to pick new dates.</p>' : '') +
      '<p id="gridHelp" class="one-line">Drag across the hours that work for you. The brighter a square, the more friends are free. ' +
      '<span class="sr-only">Keyboard: arrow keys move, Space or Enter toggles an hour, Shift plus an arrow paints as you move.</span></p></div>' +
    (state.mode === 'live'
      ? '<div class="invite"><span aria-hidden="true">🔗</span><span class="grow">Invite friends to <strong>' + esc(state.title) + '</strong> <code>' + esc(inviteLink()) + '</code>' +
          '<small class="invite-note">Send the password separately — they’ll need it to join.</small></span>' +
          '<button type="button" class="btn small ghost" id="copyLink">Copy link</button></div>'
      : '<div class="invite"><span aria-hidden="true">🔗</span><span class="grow">Demo group <strong>' + esc(state.title) + '</strong> — <a href="#/" class="link-btn">create a real group</a> to invite friends.</span></div>') +
    '</div>' +
    '<div class="layout"><section>' +
    '<div class="panel">' +
      '<div class="grid-tools">' +
        '<span class="tools-label">Quick fill</span>' +
        '<button type="button" class="chip-btn" data-fill="evenings">🌙 Evenings</button>' +
        '<button type="button" class="chip-btn" data-fill="weekend">☀️ Weekend</button>' +
        '<button type="button" class="chip-btn quiet" data-fill="clear">Clear</button>' +
      '</div>' +
      '<div class="legend" aria-hidden="true">' +
        '<span class="lg-item"><span class="ramp"></span><span class="lg-ends"><span>Nobody free</span><span>Everyone free</span></span></span>' +
        '<span class="lg-item"><span class="me-swatch"></span>Your hours</span>' +
        '<span class="lg-item"><span class="best-swatch"></span>Best time</span>' +
      '</div>' +
      '<div class="grid-wrap">' + grid +
        (!state.me.avail.size && !state.coachDone.grid ? '<div class="coach" id="coach" aria-hidden="true"><span class="hand">👆</span><span>Drag down a column to paint when you’re free</span></div>' : '') +
      '</div>' +
    '</div>' +
    '<div class="best-wrap"><h2 class="sub-title">Best times so far</h2><ul class="best-list" id="bestList" aria-live="polite"></ul></div>' +
  '</section>' + sidebarHTML() + '</div>' +
  '<div class="actionbar"><p class="ab-status" id="toPlacesHint"></p>' +
    '<button type="button" class="btn" id="toPlaces">Next: pick places →</button></div>';
}
export function slug(s) { return (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plan').slice(0, 24); }

export function cellLabel(di, h) {
  const k = key(di, h);
  const who = freeAt(di, h);
  const mine = state.me.avail.has(k);
  const others = who.filter((p) => p !== state.me);
  return dayLong(di) + ' ' + fmtHour(h) + '. ' + (mine ? 'You’re free.' : 'You’re not marked free.') + ' ' +
    who.length + ' of ' + total() + ' free' + (others.length ? ': ' + others.map((p) => p.name).join(', ') : '') + '.';
}
export let bestKeys = new Set();
export function updateCell(el) {
  const di = +el.dataset.d, h = +el.dataset.h;
  const k = key(di, h);
  const n = freeAt(di, h).length;
  const past = isPast(di, h);
  el.classList.toggle('past', past);
  el.setAttribute('aria-disabled', String(past));
  el.style.setProperty('--heat', (n / total()).toFixed(3));
  const mine = state.me.avail.has(k);
  el.classList.toggle('mine', mine);
  el.setAttribute('aria-selected', String(mine));
  el.classList.toggle('best', bestKeys.has(k));
  el.classList.toggle('full', n === total());
  el.classList.toggle('hot', n / total() > 0.55);
  el.textContent = prefs.counts && n ? String(n) : '';
  el.setAttribute('aria-label', cellLabel(di, h));
}
export function updateAllCells() {
  const runs = computeRuns();
  bestKeys = new Set();
  const top = runs[0];
  if (top && top.who.length > 1) {
    for (let h = top.start; h < top.end; h++) bestKeys.add(key(top.d, h));
  }
  $$('#grid .cell').forEach(updateCell);
}
export function renderBest() {
  const ul = $('#bestList');
  if (!ul) return;
  const runs = computeRuns().filter((r) => r.who.length > 1).slice(0, 3);
  if (!runs.length) {
    ul.innerHTML = '<li class="empty">Paint a few hours — matches with your friends will show up here.</li>';
  } else {
    ul.innerHTML = runs.map((r, i) => {
      const everyone = r.who.length === total();
      return '<li class="' + (i === 0 ? 'top' : '') + '">' + (i === 0 ? '<span aria-hidden="true">⭐</span>' : '') +
        '<div class="grow"><div class="when">' + dayLong(r.d) + ' ' + fmtRange(r.start, r.end) + '</div>' +
        '<div class="count">' + (everyone ? 'Everyone’s free 🎉' : r.who.length + ' of ' + total() + ' free') + '</div></div>' +
        avatarStack(r.who) + '</li>';
    }).join('');
  }
  const btn = $('#toPlaces'), hint = $('#toPlacesHint');
  if (btn) {
    btn.disabled = !state.me.avail.size;
    const best = runs[0];
    hint.innerHTML = !state.me.avail.size ? '<span class="ab-ico">👆</span> Paint at least one hour to continue'
      : '<span class="ab-ico ok">✓</span> ' + state.me.avail.size + ' hour' + (state.me.avail.size === 1 ? '' : 's') + ' painted' +
        (best ? '<span class="ab-sub">Best so far: ' + esc(dayShort(best.d) + ' ' + fmtRange(best.start, best.end)) + '</span>' : '<span class="ab-sub">You can change these anytime</span>');
  }
}

export function setMine(k, on) {
  if (on) state.me.avail.add(k); else state.me.avail.delete(k);
}

export function bindTimes() {
  const grid = $('#grid');
  let painting = false, paintVal = true, last = null;

  const cellAt = (di, h) => grid.querySelector('.cell[data-d="' + di + '"][data-h="' + h + '"]');
  const applyTo = (el) => {
    if (!el || el === last) return;
    // Fill any cells skipped by a fast pointer movement.
    if (last) {
      const d0 = +last.dataset.d, h0 = +last.dataset.h, d1 = +el.dataset.d, h1 = +el.dataset.h;
      const steps = Math.max(Math.abs(d1 - d0), Math.abs(h1 - h0));
      for (let i = 1; i < steps; i++) {
        paintOne(cellAt(Math.round(d0 + (d1 - d0) * i / steps), Math.round(h0 + (h1 - h0) * i / steps)));
      }
    }
    last = el;
    paintOne(el);
  };
  const paintOne = (el) => {
    if (!el) return;
    if (isPast(+el.dataset.d, +el.dataset.h)) return; // can't plan for hours that are over
    const k = key(+el.dataset.d, +el.dataset.h);
    if (state.me.avail.has(k) === paintVal) return;
    setMine(k, paintVal);
    updateCell(el);
    if (!reduceMotion) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  };

  grid.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.cell');
    if (!el || e.button > 0) return;
    dismissCoach();
    buzz(8);
    e.preventDefault();
    painting = true; last = null;
    paintVal = !state.me.avail.has(key(+el.dataset.d, +el.dataset.h));
    grid.setPointerCapture(e.pointerId);
    focusCell(el, false);
    applyTo(el);
  });
  grid.addEventListener('pointermove', (e) => {
    if (!painting) return;
    const t = document.elementFromPoint(e.clientX, e.clientY);
    applyTo(t && t.closest ? t.closest('#grid .cell') : null);
  });
  const end = () => {
    if (!painting) return;
    painting = false;
    afterMineChanged();
  };
  grid.addEventListener('pointerup', end);
  grid.addEventListener('pointercancel', end);

  // Roving-tabindex keyboard support.
  grid.addEventListener('keydown', (e) => {
    const el = e.target.closest('.cell');
    if (!el) return;
    let di = +el.dataset.d, h = +el.dataset.h;
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (moves[e.key]) {
      e.preventDefault();
      di = Math.max(0, Math.min(DAYS.length - 1, di + moves[e.key][0]));
      h = Math.max(HOURS[0], Math.min(HOURS[HOURS.length - 1], h + moves[e.key][1]));
      const next = grid.querySelector('.cell[data-d="' + di + '"][data-h="' + h + '"]');
      if (e.shiftKey) { setMine(key(di, h), true); afterMineChanged(); }
      focusCell(next, true);
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      dismissCoach();
      if (isPast(di, h)) { announce(dayLong(di) + ' ' + fmtHour(h) + ' has already passed.'); return; }
      const k = key(di, h);
      setMine(k, !state.me.avail.has(k));
      afterMineChanged();
      announce(cellLabel(di, h));
    }
  });

  $$('[data-fill]').forEach((b) => b.addEventListener('click', () => {
    const mode = b.dataset.fill;
    dismissCoach();
    if (mode === 'clear') state.me.avail.clear();
    DAYS.forEach((d, di) => {
      const dow = d.getDay();
      HOURS.forEach((h) => {
        if (isPast(di, h)) return;
        if (mode === 'evenings' && h >= 18) setMine(key(di, h), true);
        if (mode === 'weekend' && (dow === 0 || dow === 6) && h >= 12) setMine(key(di, h), true);
      });
    });
    afterMineChanged();
    announce(mode === 'clear' ? 'Cleared your hours.' : 'Added ' + (mode === 'evenings' ? 'evenings' : 'weekend afternoons') + '. ' + state.me.avail.size + ' hours marked free.');
  }));

  if ($('#copyLink')) $('#copyLink').addEventListener('click', () => copy(inviteLink(), 'Invite link copied — remember to share the password'));
  $('#toPlaces').addEventListener('click', () => go('places'));

  updateAllCells();
  renderBest();
  simulateTimes();
}
export function dismissCoach() {
  state.coachDone.grid = true;
  const c = $('#coach');
  if (c) { c.classList.add('gone'); setTimeout(() => c.remove(), 300); }
}
export function focusCell(el, focus) {
  if (!el) return;
  $$('#grid .cell[tabindex="0"]').forEach((c) => c.setAttribute('tabindex', '-1'));
  el.setAttribute('tabindex', '0');
  if (focus) el.focus();
}
export function afterMineChanged() {
  if (state.mode === 'live') saveSoon({ avail: Array.from(state.me.avail) });
  refresh();
}

export function simulateTimes() {
  if (state.mode !== 'demo' || state.sim.times) return;
  state.sim.times = true;
  state.friends.forEach((f, i) => {
    later('sim', () => {
      f.joined = true;
      toast(f, f.name + ' joined ' + state.title);
      announce(f.name + ' joined the plan and is adding their free times.');
      const cells = [];
      DAYS.forEach((d, di) => {
        (f.pattern[d.getDay()] || []).forEach((range) => {
          for (let h = range[0]; h < range[1]; h++) if (HOURS.indexOf(h) > -1) cells.push(key(di, h));
        });
      });
      if (reduceMotion) { cells.forEach((c) => f.avail.add(c)); refresh(); return; }
      cells.forEach((c, j) => later('sim', () => { f.avail.add(c); refresh(); }, j * 45));
    }, 1200 + i * 2200);
  });
}
