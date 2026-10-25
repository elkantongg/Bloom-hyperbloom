// Step 1: painting free hours, one week at a time, across about a month.
import { $, $$, esc, reduceMotion } from './util.js';
import { dayLong, DAYS, dayShort, fmtHour, fmtRange, fmtWeek, HOURS, isPast, key, relDay, weekDays, weekOf, weekOver, WEEKS } from './dates.js';
import { people, state, total } from './state.js';
import { computeRuns, freeAt, timeKey, timeVotes } from './derive.js';
import { currentVotes } from './data.js';
import { announce, avatarStack, buzz, copy, namesList, refresh, sidebarHTML, toast } from './ui.js';
import { go, later } from './router.js';
import { prefs } from './settings.js';
import { invite, inviteLink, saveSoon } from './live.js';

// The week the grid shows: the one chosen, else the first week that isn't over yet.
export function viewWeek() {
  if (state.week === null || state.week === undefined) {
    const open = DAYS.findIndex((_, di) => !isPast(di, HOURS[HOURS.length - 1]));
    state.week = open < 0 ? WEEKS - 1 : weekOf(open);
  }
  return Math.max(0, Math.min(WEEKS - 1, state.week));
}

// One week of the painting grid (header row + hour rows).
export function gridRowsHTML(w) {
  const days = weekDays(w);
  let html = '<div class="g-row" role="row"><div role="columnheader"><span class="sr-only">Time</span></div>';
  days.forEach((di) => {
    const d = DAYS[di];
    const wk = d.getDay() === 0 || d.getDay() === 6 ? ' weekend' : '';
    html += '<div class="g-day' + wk + '" role="columnheader">' +
      (relDay(di) === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' })) + '<span class="dom">' + d.getDate() + '</span></div>';
  });
  html += '</div>';
  HOURS.forEach((h, r) => {
    html += '<div class="g-row" role="row"><div class="g-time" role="rowheader">' + fmtHour(h) + '</div>';
    days.forEach((di, c) => {
      html += '<div class="cell" role="gridcell" tabindex="' + (r === 0 && c === 0 ? 0 : -1) + '" data-d="' + di + '" data-h="' + h + '" aria-selected="false"></div>';
    });
    html += '</div>';
  });
  return html;
}

// Pick a month, then a week of it. Each week belongs to the month most of its days are in.
const weekMonth = (w) => { const d = DAYS[w * 7 + 3]; return d.getFullYear() * 12 + d.getMonth(); };
const monthName = (m) => new Date(Math.floor(m / 12), m % 12, 1).toLocaleDateString(undefined, { month: 'long' });
const weekWhen = (w) => (w === 0 ? 'This week' : w === 1 ? 'Next week' : 'In ' + w + ' weeks');
export function weekPickerHTML(w) {
  const months = Array.from(new Set(Array.from({ length: WEEKS }, (_, i) => weekMonth(i))));
  const m = weekMonth(w);
  const weeks = Array.from({ length: WEEKS }, (_, i) => i).filter((i) => weekMonth(i) === m);
  return '<div class="month-tabs" role="tablist" aria-label="Month">' + months.map((x) =>
      '<button type="button" role="tab" class="month-tab" data-month="' + x + '" aria-selected="' + (x === m) + '">' + monthName(x) + '</button>').join('') +
    '</div>' +
    '<div class="week-flow" id="weekFlow" role="radiogroup" aria-label="Week of ' + monthName(m) + '">' + weeks.map((i) =>
      '<button type="button" role="radio" class="week-card" data-week="' + i + '" aria-checked="' + (i === w) + '" tabindex="' + (i === w ? 0 : -1) + '">' +
        '<small>' + weekWhen(i) + '</small><strong>' + fmtWeek(i) + '</strong></button>').join('') +
    '</div>';
}

export function timesHTML() {
  const w = viewWeek();
  const grid = '<div class="grid" id="grid" role="grid" aria-label="Your availability, ' + fmtWeek(w) + '" aria-describedby="gridHelp" style="--cols:7">' +
    gridRowsHTML(w) + '</div>';

  return '<div class="page-top"><div class="page-head"><h1>When are you free?</h1>' +
      (weekOver() ? '<p class="week-over" role="status">⏰ This plan’s dates are over. <a href="#/" class="link-btn">Start a new plan</a> to pick new dates.</p>' : '') +
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
      '<div class="week-picker" id="weekPicker">' + weekPickerHTML(w) + '</div>' +
      '<div class="legend" aria-hidden="true">' +
        '<span class="lg-item"><span class="ramp"></span><span class="lg-ends"><span>Nobody free</span><span>Everyone free</span></span></span>' +
        '<span class="lg-item"><span class="me-swatch"></span>Your hours</span>' +
        '<span class="lg-item"><span class="best-swatch"></span>Best time</span>' +
      '</div>' +
      '<div class="grid-wrap">' + grid +
        (!state.me.avail.size && !state.coachDone.grid ? '<div class="coach" id="coach" aria-hidden="true"><span class="hand">👆</span><span>Drag down a column to paint when you’re free</span></div>' : '') +
      '</div>' +
      '<div class="grid-foot"><button type="button" class="chip-btn quiet" id="clearWeek">Clear this week</button></div>' +
    '</div>' +
    '<div class="best-wrap"><h2 class="sub-title" id="bestTitle">Best times so far</h2><div id="bestNote" aria-live="polite"></div><ul class="best-list" id="bestList" aria-live="polite"></ul></div>' +
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
// Times with the same, highest number of people free. The group picks one by voting.
export function tiedTimes() {
  const all = computeRuns().filter((r) => r.who.length > 1);
  if (all.length < 2 || all[1].who.length !== all[0].who.length) return [];
  // Shown in date order and never re-sorted, so rows stay put while votes come in.
  return all.filter((r) => r.who.length === all[0].who.length).slice(0, 5).sort((a, b) => a.d - b.d || a.start - b.start);
}

export function renderBest() {
  const ul = $('#bestList');
  if (!ul) return;
  const tied = tiedTimes();
  const runs = computeRuns().filter((r) => r.who.length > 1).slice(0, 3);
  if (tied.length) {
    // "Multiple dates available": tap one to vote. One vote each; tap another to move it.
    ul.setAttribute('role', 'radiogroup');
    ul.setAttribute('aria-label', 'Pick your preferred date');
    ul.innerHTML = tied.map((r) => {
      const voters = timeVotes(r), n = voters.length, mine = state.me.votes[timeKey(r)] === 1;
      return '<li class="date-option-wrap"><button type="button" role="radio" class="date-option" data-time-vote="' + timeKey(r) + '" aria-checked="' + mine + '">' +
        '<span class="radio-dot" aria-hidden="true"></span>' +
        '<span class="grow"><span class="when">' + esc(dayLong(r.d) + ' ' + fmtRange(r.start, r.end)) + '</span>' +
        '<span class="count">' + esc(whoCanCome(r)) + '</span></span>' +
        '<span class="votes">' + (n ? avatarStack(voters) : '') +
          '<span aria-label="' + esc(n + (n === 1 ? ' vote' : ' votes') + (n ? ': ' + namesList(voters) : '')) + '">' + n + (n === 1 ? ' vote' : ' votes') + '</span></span>' +
        '</button></li>';
    }).join('');
    simulateDateVotes(tied);
  } else if (!runs.length) {
    ul.removeAttribute('role');
    // Everyone's hours may not overlap (yet) when people fill in on different days.
    ul.innerHTML = '<li class="empty">' + (people().filter((p) => p.avail.size).length >= 2
      ? 'No shared time yet. Try adding a few more hours.'
      : 'Paint a few hours — matches with your friends show up here.') + '</li>';
  } else {
    ul.removeAttribute('role');
    ul.innerHTML = runs.map((r, i) =>
      '<li class="' + (i === 0 ? 'top' : '') + '">' + (i === 0 ? '<span aria-hidden="true">⭐</span>' : '') +
        '<div class="grow"><button type="button" class="when" data-week="' + weekOf(r.d) + '" aria-label="' + esc(dayLong(r.d) + ' ' + fmtRange(r.start, r.end) + '. Show this week') + '">' +
          esc(dayLong(r.d) + ' ' + fmtRange(r.start, r.end)) + '</button>' +
        '<div class="count">' + esc(whoCanCome(r)) + '</div></div>' +
        avatarStack(r.who) + '</li>').join('');
  }
  renderBestNote(runs[0], tied);
  const btn = $('#toPlaces'), hint = $('#toPlacesHint');
  if (btn) {
    btn.disabled = !state.me.avail.size; // voting on a tied date is optional; nobody waits
    const best = runs[0];
    hint.innerHTML = !state.me.avail.size ? '<span class="ab-ico">👆</span> Paint at least one hour to continue'
      : '<span class="ab-ico ok">✓</span> ' + state.me.avail.size + ' hour' + (state.me.avail.size === 1 ? '' : 's') + ' painted' +
        (best ? '<span class="ab-sub">Best so far: ' + esc(dayShort(best.d) + ' ' + fmtRange(best.start, best.end)) + '</span>' : '<span class="ab-sub">You can change these anytime</span>');
  }
}

// Who can and can't make a time, naming whichever side is smaller:
// "4 of 5 free · Sam can't make it" or "Only Maya and Jun are free".
export function whoCanCome(r) {
  if (r.who.length === total()) return 'Everyone’s free 🎉';
  const replied = people().filter((p) => p.avail.size);
  const cant = replied.filter((p) => r.who.indexOf(p) === -1);
  const pending = people().filter((p) => !p.avail.size && p !== state.me); // you already know you haven't
  const main = !cant.length ? r.who.length + ' of ' + total() + ' free'
    : cant.length <= r.who.length ? r.who.length + ' of ' + total() + ' free · ' + namesList(cant) + ' can’t make it'
    : 'Only ' + namesList(r.who) + (r.who.length === 1 ? ' is' : ' are') + ' free';
  return main + (pending.length ? ' · waiting on ' + namesList(pending) : '');
}

// Demo friends pick a date too (one they can make), a few seconds apart, so the vote
// fills up like it would in a real group. Real friends vote on their own phones.
const dateVoteQueued = new Map(); // friend|date -> when queued (expires, e.g. after "New plan")
function simulateDateVotes(tied) {
  if (state.mode !== 'demo') return;
  state.friends.forEach((f, i) => {
    if (!f.joined || tied.some((r) => f.votes[timeKey(r)] === 1)) return;
    const can = tied.filter((r) => r.who.indexOf(f) !== -1);
    const pick = (can.length ? can : tied)[(i * 7 + f.name.length) % (can.length || tied.length)];
    const k = f.id + '|' + timeKey(pick);
    if (Date.now() - (dateVoteQueued.get(k) || 0) < 15000) return;
    dateVoteQueued.set(k, Date.now());
    later('sim', () => {
      dateVoteQueued.delete(k);
      const now = tiedTimes();
      if (!now.some((r) => timeKey(r) === timeKey(pick)) || now.some((r) => f.votes[timeKey(r)] === 1)) return; // the tie changed
      f.votes[timeKey(pick)] = 1;
      toast(f, f.name + ' picked ' + dayShort(pick.d) + ' ' + fmtRange(pick.start, pick.end));
      refresh();
    }, 1800 + i * 1400);
  });
}

// The line above the list: a tie to vote on, or no time that suits everyone yet.
export function renderBestNote(best, tied) {
  const box = $('#bestNote');
  if (!box) return;
  const replied = people().filter((p) => p.avail.size);
  let html = '';
  const title = $('#bestTitle');
  if (title) title.textContent = tied.length ? 'Pick your preferred date' : 'Best times so far';
  if (tied.length) {
    const voters = people().filter((p) => tied.some((r) => p.votes[timeKey(r)] === 1));
    const waiting = people().filter((p) => p.joined && voters.indexOf(p) === -1);
    html = '<p class="best-hint">Multiple dates work for ' + tied[0].who.length + ' of ' + total() + '. Vote for the one you prefer — the host sees the votes when picking the plan.</p>' +
      '<p class="vote-progress"><strong>' + voters.length + ' of ' + total() + ' have picked</strong>' +
        (waiting.length ? ' · waiting on ' + esc(namesList(waiting)) : ' · everyone’s voted 🎉') + '</p>';
  } else if (best && replied.length >= 2 && replied.some((p) => best.who.indexOf(p) === -1)) {
    html = '<p class="best-note"><strong>No time works for everyone yet.</strong> Here are the closest.</p>';
  }
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
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
      if (weekOf(di) !== viewWeek()) showWeek(weekOf(di)); // arrow past Sunday goes to next week
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

  // Clear only the week on screen (other weeks keep their hours).
  $('#clearWeek').addEventListener('click', () => {
    dismissCoach();
    weekDays(viewWeek()).forEach((di) => HOURS.forEach((h) => setMine(key(di, h), false)));
    afterMineChanged();
    announce('Cleared your hours for ' + fmtWeek(viewWeek()) + '. ' + state.me.avail.size + ' hours still marked free.');
  });

  if ($('#copyLink')) $('#copyLink').addEventListener('click', () => copy(inviteLink(), 'Invite link copied — remember to share the password'));
  $('#toPlaces').addEventListener('click', () => go('places'));

  // Month tabs, then swipe or tap a week. The centred week is the one shown.
  const picker = $('#weekPicker');
  picker.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-month]'), card = e.target.closest('[data-week]');
    if (tab) {
      const first = Array.from({ length: WEEKS }, (_, i) => i).find((i) => weekMonth(i) === +tab.dataset.month);
      if (first !== undefined) showWeek(first);
    } else if (card) showWeek(+card.dataset.week);
  });
  picker.addEventListener('keydown', (e) => {
    const card = e.target.closest('[data-week]');
    if (!card || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const cards = $$('#weekFlow [data-week]');
    const next = cards[cards.indexOf(card) + (e.key === 'ArrowRight' ? 1 : -1)];
    if (next) { showWeek(+next.dataset.week); const again = $('#weekFlow [data-week="' + next.dataset.week + '"]'); if (again) again.focus(); }
  });
  bindWeekFlow();
  // Arrow keys move between the date options, like any radio group.
  $('#bestList').addEventListener('keydown', (e) => {
    const opt = e.target.closest('[data-time-vote]');
    if (!opt || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const all = $$('#bestList [data-time-vote]');
    const next = all[(all.indexOf(opt) + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
    next.click();
  });
  $('#bestList').addEventListener('click', (e) => {
    const vote = e.target.closest('[data-time-vote]');
    if (vote) {
      // One vote each: picking a date moves your vote there. Rows stay where they are.
      const k = vote.dataset.timeVote;
      if (state.me.votes[k] === 1) return;
      Object.keys(state.me.votes).forEach((x) => { if (x.startsWith('t:')) delete state.me.votes[x]; });
      state.me.votes[k] = 1;
      if (state.mode === 'live') saveSoon({ votes: currentVotes(state.me) });
      renderBest();
      refresh();
      const again = $('#bestList [data-time-vote="' + k + '"]');
      if (again) again.focus();
      announce('Voted for ' + vote.querySelector('.when').textContent + '.');
      return;
    }
    const b = e.target.closest('[data-week]');
    if (b) showWeek(+b.dataset.week);
  });

  updateAllCells();
  renderBest();
  simulateTimes();
}
// Show another week of the grid (same listeners; only the cells change), sliding in
// from the side it came from.
export function showWeek(w) {
  w = Math.max(0, Math.min(WEEKS - 1, w));
  const from = viewWeek();
  if (w === from && $('#grid .cell[data-d="' + w * 7 + '"]')) return centreWeek(true);
  state.week = w;
  const grid = $('#grid');
  if (!grid) return;
  grid.innerHTML = gridRowsHTML(w);
  grid.setAttribute('aria-label', 'Your availability, ' + fmtWeek(w));
  if (!reduceMotion) {
    grid.classList.remove('slide-l', 'slide-r');
    void grid.offsetWidth;
    grid.classList.add(w > from ? 'slide-l' : 'slide-r');
  }
  if (weekMonth(w) === weekMonth(from) && $('#weekFlow [data-week="' + w + '"]')) {
    // Same month: just move the highlight and glide to it (no rebuild mid-swipe).
    $$('#weekFlow [data-week]').forEach((c) => {
      const on = +c.dataset.week === w;
      c.setAttribute('aria-checked', String(on));
      c.tabIndex = on ? 0 : -1;
    });
    centreWeek(true);
  } else {
    $('#weekPicker').innerHTML = weekPickerHTML(w);
    bindWeekFlow();
  }
  updateAllCells();
  announce('Showing ' + fmtWeek(w) + '.');
}

// Coverflow: the centred week faces you; the others tilt away. Swiping snaps to a week
// and shows it. Calm mode / reduced motion keeps the cards flat.
let flowTimer = null;
let gliding = 0; // while we scroll the carousel ourselves (after a tap), don't treat it as a swipe
function bindWeekFlow() {
  const flow = $('#weekFlow');
  if (!flow) return;
  flow.addEventListener('scroll', () => {
    tiltCards();
    clearTimeout(flowTimer);
    flowTimer = setTimeout(() => {
      if (Date.now() < gliding) return;
      const mid = flow.scrollLeft + flow.clientWidth / 2;
      const cards = $$('#weekFlow [data-week]');
      const near = cards.reduce((a, c) => (Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid) < Math.abs(a.offsetLeft + a.offsetWidth / 2 - mid) ? c : a), cards[0]);
      if (near && +near.dataset.week !== viewWeek()) showWeek(+near.dataset.week);
    }, 140);
  }, { passive: true });
  centreWeek(false);
}
function centreWeek(smooth) {
  const flow = $('#weekFlow'), card = flow && flow.querySelector('[aria-checked="true"]');
  if (!card) return;
  gliding = Date.now() + (smooth && !reduceMotion ? 700 : 50);
  flow.scrollTo({ left: card.offsetLeft + card.offsetWidth / 2 - flow.clientWidth / 2, behavior: smooth && !reduceMotion ? 'smooth' : 'auto' });
  tiltCards();
}
function tiltCards() {
  const flow = $('#weekFlow');
  if (!flow) return;
  const mid = flow.scrollLeft + flow.clientWidth / 2;
  $$('#weekFlow .week-card').forEach((c) => {
    const d = Math.max(-2, Math.min(2, (c.offsetLeft + c.offsetWidth / 2 - mid) / c.offsetWidth));
    c.style.transform = reduceMotion ? '' : 'rotateY(' + (-d * 32).toFixed(1) + 'deg) scale(' + (1 - Math.abs(d) * 0.1).toFixed(3) + ')';
    c.style.opacity = (1 - Math.abs(d) * 0.28).toFixed(2);
  });
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
      const shown = new Set(weekDays(viewWeek()).map((di) => ymdKey(di)));
      const now = reduceMotion ? cells : cells.filter((c) => !shown.has(c.split('@')[0]));
      now.forEach((c) => f.avail.add(c));
      refresh();
      if (reduceMotion) return;
      cells.filter((c) => shown.has(c.split('@')[0])).forEach((c, j) => later('sim', () => { f.avail.add(c); refresh(); }, j * 45));
    }, 1200 + i * 2200);
  });
}

const ymdKey = (di) => key(di, 0).split('@')[0];
