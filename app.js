/* Bloom — group plans that actually happen.
   Live mode: groups, invites and votes are stored by server.py (SQLite).
   Demo mode: friends are simulated so one person can try the whole flow. */
(function () {
  'use strict';

  // ---------- Helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const motionMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduceMotion = motionMQ.matches;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  // ---------- Calendar setup ----------
  const HOURS = Array.from({ length: 12 }, (_, i) => 10 + i); // 10am .. 9pm slots
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const todayYmd = () => ymd(new Date());
  let DAYS = [];
  // A group plans one week, starting on the day it was created.
  function setWeek(startYmd) {
    const p = (startYmd || todayYmd()).split('-').map(Number);
    DAYS = Array.from({ length: 7 }, (_, i) => new Date(p[0], p[1] - 1, p[2] + i));
  }
  setWeek(null);
  const key = (di, h) => ymd(DAYS[di]) + '@' + h;
  const relDay = (di) => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return Math.round((DAYS[di] - t) / 86400000);
  };
  const fmtHour = (h) => (h % 12 || 12) + (h < 12 || h === 24 ? 'am' : 'pm');
  const fmtRange = (a, b) => {
    const sameHalf = (a < 12) === (b < 12 || b === 24);
    return (sameHalf ? String(a % 12 || 12) : fmtHour(a)) + '–' + fmtHour(b);
  };
  const dayShort = (di) => (relDay(di) === 0 ? 'Today' : DAYS[di].toLocaleDateString(undefined, { weekday: 'short' }));
  const dayLong = (di) => (relDay(di) === 0 ? 'Today' : relDay(di) === 1 ? 'Tomorrow' : DAYS[di].toLocaleDateString(undefined, { weekday: 'long' }));
  const dateLong = (di) => DAYS[di].toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  // ---------- Demo data ----------
  // Free-time patterns by weekday (0 = Sun). Everyone overlaps on Saturday afternoon.
  const FRIENDS = [
    { id: 'maya', name: 'Maya', color: '#E03131', pattern: { 1: [[18, 22]], 2: [[18, 22]], 3: [[18, 22]], 4: [[18, 22]], 5: [[18, 22]], 6: [[12, 20]], 0: [[10, 14]] } },
    { id: 'jun', name: 'Jun', color: '#D9831A', pattern: { 5: [[19, 22]], 6: [[14, 22]], 0: [[14, 18]] } },
    { id: 'priya', name: 'Priya', color: '#7C5CFF', pattern: { 1: [[19, 21]], 2: [[19, 21]], 4: [[19, 21]], 5: [[19, 22]], 6: [[10, 18]], 0: [[10, 22]] } },
    { id: 'sam', name: 'Sam', color: '#11966A', pattern: { 2: [[17, 22]], 4: [[17, 22]], 6: [[15, 19]], 0: [[11, 13]] } },
  ];

  const PLACES = [
    { id: 'noodle', name: 'Lantern Noodle Bar', kind: 'Dinner', emoji: '🍜', price: '$$', dist: '1.2 km', blurb: 'Hand-pulled noodles and big shared tables.', tags: ['Step-free', 'Veg options'], hue: '#FFC48A' },
    { id: 'bowling', name: 'Strike Social', kind: 'Bowling', emoji: '🎳', price: '$$', dist: '3.4 km', blurb: 'Retro lanes, arcade machines and milkshakes.', tags: ['Step-free', 'Groups of 6+'], hue: '#A9C4FF' },
    { id: 'picnic', name: 'Botanic Gardens Picnic', kind: 'Outdoors', emoji: '🧺', price: 'Free', dist: '2.0 km', blurb: 'Bring snacks, find a shady lawn, stay till sunset.', tags: ['Free', 'Weather-dependent'], hue: '#A8E6B4', outdoor: true },
    { id: 'escape', name: 'Clockwork Escape Room', kind: 'Activity', emoji: '🔐', price: '$$$', dist: '4.1 km', blurb: '60 minutes to escape a locked inventor’s study.', tags: ['Max 6 people', 'Book ahead'], hue: '#D2B8FF' },
    { id: 'karaoke', name: 'Echo Box Karaoke', kind: 'Karaoke', emoji: '🎤', price: '$$', dist: '2.7 km', blurb: 'Private rooms, 5,000+ songs, zero judgement.', tags: ['Private room', 'Open late'], hue: '#FFB0D2' },
    { id: 'cafe', name: 'Paper Crane Board Game Café', kind: 'Café', emoji: '🎲', price: '$', dist: '0.8 km', blurb: '300 board games, waffles and quiet corners.', tags: ['Quiet', 'Step-free'], hue: '#FFE08A' },
  ];

  // Types for places the group suggests themselves.
  const KINDS = {
    food: { label: 'Food', emoji: '🍽️', hue: '#FFC48A' },
    drinks: { label: 'Drinks', emoji: '🧋', hue: '#FFB0D2' },
    activity: { label: 'Activity', emoji: '🎯', hue: '#A9C4FF' },
    other: { label: 'Something else', emoji: '✨', hue: '#D2B8FF' },
  };
  function customPlace(c) {
    const k = KINDS[c.kind === 'outdoors' ? 'activity' : c.kind] || KINDS.other;
    const by = c.addedBy === state.me.id ? 'you' : ((state.friends.find((f) => f.id === c.addedBy) || {}).name || 'a friend');
    const d = c.details || null; // the place the person confirmed from the list, if any
    return { id: c.id, q: c.name, name: c.name, kind: (d && d.category) || k.label, emoji: k.emoji, hue: k.hue,
      price: (d && d.price) || '', dist: (d && d.area) || '',
      hoursToday: d ? (todaysHours(d.hours) || d.hoursText || '') : '',
      website: d && /^https?:\/\//.test(d.website || '') ? d.website : '',
      blurb: d && d.address ? d.address + ' · Suggested by ' + by + '.' : 'Suggested by ' + by + '. Tap the Google link to check hours, prices and reviews.',
      tags: [], custom: true, addedBy: c.addedBy };
  }
  // Map hours are listed Monday-first: "Monday: 08:30 – 18:00".
  function todaysHours(lines) {
    if (!lines || lines.length !== 7) return '';
    return (lines[(new Date().getDay() + 6) % 7] || '').replace(/^[^:]+:\s*/, '');
  }
  // Everything in the deck: built-in ideas first, then the group's own suggestions.
  function allPlaces() { return PLACES.concat(state.custom.map(customPlace)); }
  const googleLink = (pl) => 'https://www.google.com/search?q=' + encodeURIComponent(pl.q || pl.name);

  const FRIEND_VOTES = {
    maya: { noodle: 1, bowling: 0, picnic: 1, escape: -1, karaoke: 1, cafe: 1 },
    jun: { noodle: 1, bowling: 1, picnic: -1, escape: 1, karaoke: 1, cafe: 0 },
    priya: { noodle: 0, bowling: -1, picnic: 1, escape: 1, karaoke: 0, cafe: 1 },
    sam: { noodle: 1, bowling: 1, picnic: 0, escape: -1, karaoke: 1, cafe: 1 },
  };

  // ---------- State ----------
  const state = {
    step: 'home',
    mode: 'demo',        // 'demo' (simulated friends) or 'live' (real group on the server)
    group: null,         // { id, title, host, startDate } in live mode
    session: null,       // { memberId, token } in live mode
    joinId: null,        // group id from an invite link
    title: 'Weekend hangout',
    me: { id: 'me', name: 'You', color: '#2F6FEB', avail: new Set(), votes: {}, joined: true },
    friends: FRIENDS.map((f) => Object.assign({}, f, { avail: new Set(), votes: {}, joined: false })),
    sim: { times: false, votes: false },
    deckIndex: 0,
    custom: [],          // places the group suggested: { id, name, kind, addedBy }
    milestones: {},
    coachDone: { grid: false, deck: false },
    pickRun: null,
    pickPlace: null,
  };
  const people = () => [state.me].concat(state.friends);
  const total = () => people().length;

  // ---------- Derived data ----------
  function freeAt(di, h) {
    const k = key(di, h);
    return people().filter((p) => p.joined && p.avail.has(k));
  }

  // Consecutive same-day hours where exactly the same people are free.
  // Cache derived data for the current task only, so one screen update
  // doesn't recompute the same thing several times.
  const memo = {};
  function cached(name, fn) {
    if (!(name in memo)) {
      memo[name] = fn();
      queueMicrotask(() => { delete memo[name]; });
    }
    return memo[name];
  }
  function computeRuns() { return cached('runs', computeRunsFresh); }
  function rankPlaces() { return cached('places', rankPlacesFresh); }

  function computeRunsFresh() {
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

  function rankPlacesFresh() {
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

  function personProgress(p) {
    if (!p.joined) return 0;
    const voted = Object.keys(p.votes).length / allPlaces().length;
    return 0.2 + (p.avail.size ? 0.4 : 0) + 0.4 * voted;
  }

  function bloomScore() {
    const runs = computeRuns();
    const t = runs[0] ? runs[0].who.length / total() : 0;
    const top = rankPlaces()[0];
    const pl = top && top.voters ? top.points / (2 * total()) : 0;
    return Math.round((t * 0.5 + pl * 0.5) * 100);
  }

  function chosenRun() {
    const runs = computeRuns();
    return runs.find((r) => r.id === state.pickRun) || runs[0] || null;
  }
  function chosenPlace() {
    const ranked = rankPlaces();
    return ranked.find((p) => p.id === state.pickPlace) || ranked[0];
  }

  // ---------- Feedback ----------
  function announce(msg) {
    const live = $('#live');
    live.textContent = '';
    setTimeout(() => { live.textContent = msg; }, 60);
  }
  function toast(person, msg) {
    const wrap = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = (person ? avatar(person, 'sm') : '') + '<span>' + esc(msg) + '</span>';
    wrap.appendChild(el);
    while (wrap.children.length > 3) wrap.firstChild.remove();
    setTimeout(() => el.remove(), 3300);
  }
  function avatar(p, size) {
    const waiting = !p.joined ? ' waiting' : '';
    return '<span class="av ' + (size || '') + waiting + '" style="--c:' + p.color + '" title="' + esc(p.name) + '" aria-hidden="true">' + esc(p.name.trim().charAt(0).toUpperCase() || '?') + '</span>';
  }
  function avatarStack(list, size) {
    return '<span class="av-stack">' + list.map((p) => avatar(p, size || 'sm')).join('') + '</span>';
  }
  function displayName(p) { return p === state.me && p.name !== 'You' ? p.name + ' (you)' : p.name; }
  function namesList(list) {
    const n = list.map((p) => (p === state.me ? 'you' : p.name));
    if (n.length <= 1) return n.join('');
    return n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
  }

  // ---------- Flower ----------
  const PETAL = 'M0,0 C-26,-22 -24,-70 0,-86 C24,-70 26,-22 0,0 Z';
  function flowerSVG(opts) {
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
  function flowerLabel() {
    return 'Plan flower: ' + bloomScore() + '% in bloom. One petal per person; petals open as people add times and vote.';
  }
  function updateFlowers() {
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

  // ---------- Sidebar ----------
  function sidebarHTML() {
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
  function statusOf(p) {
    if (!p.joined) return 'Invite sent';
    const v = Object.keys(p.votes).length;
    if (v >= allPlaces().length) return 'All done ✓';
    if (v > 0) return 'Voted ' + v + ' of ' + allPlaces().length;
    if (p.avail.size) return 'Added ' + p.avail.size + ' free hours';
    return p === state.me ? 'Paint your free times' : 'Adding times…';
  }
  function updatePeople() {
    const ul = $('#people');
    if (!ul) return;
    ul.innerHTML = people().map((p) =>
      '<li>' + avatar(p) + '<div><div class="who">' + esc(displayName(p)) + '</div>' +
      '<div class="status">' + esc(statusOf(p)) + '</div>' +
      '<div class="progress" aria-hidden="true"><i style="--p:' + Math.round(personProgress(p) * 100) + '%;--c:' + p.color + '"></i></div></div></li>'
    ).join('');
  }

  let refreshQueued = false;
  function refresh() {
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

  // ---------- Router ----------
  function canGo(step) {
    if (step === 'home' || step === 'join') return true;
    if (step === 'times') return state.mode === 'demo' || !!state.session;
    if (step === 'places') return state.me.avail.size > 0;
    if (step === 'bloom') return state.deckIndex >= allPlaces().length;
    return false;
  }
  function go(step, push) {
    if (!canGo(step)) step = !canGo('times') ? 'home' : canGo('places') ? 'places' : 'times';
    state.step = step;
    if (push !== false) {
      const h = step === 'home' ? '#/' : step === 'join' ? '#/join/' + state.joinId : '#/' + step;
      if (location.hash !== h) history.pushState(null, '', h);
    }
    render();
  }
  window.addEventListener('popstate', () => route(false));
  function route(push) {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    if (parts[0] === 'join' && parts[1]) {
      openInvite(decodeURIComponent(parts[1]));
      return;
    }
    const s = parts[0] || 'home';
    go(['home', 'times', 'places', 'bloom'].indexOf(s) > -1 ? s : 'home', push);
  }

  function updateStepper() {
    const order = ['times', 'places', 'bloom'];
    $('.topbar').classList.toggle('is-home', state.step === 'home' || state.step === 'join');
    $$('#stepper button').forEach((b) => {
      const s = b.dataset.step;
      b.disabled = !canGo(s);
      if (s === state.step) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.classList.toggle('done', order.indexOf(s) < order.indexOf(state.step));
    });
  }
  $('#stepper').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-step]');
    if (b && !b.disabled) go(b.dataset.step);
  });

  function render() {
    clearTimers('deck');
    const main = $('#main');
    if (state.step === 'home') main.innerHTML = homeHTML();
    if (state.step === 'join') main.innerHTML = joinHTML();
    if (state.step === 'times') main.innerHTML = timesHTML();
    if (state.step === 'places') main.innerHTML = placesHTML();
    if (state.step === 'bloom') main.innerHTML = bloomHTML();
    document.title = {
      home: 'Bloom — plans that actually happen',
      join: 'You’re invited · Bloom',
      times: 'When are you free? · Bloom',
      places: 'Where should we go? · Bloom',
      bloom: 'Your plan · Bloom',
    }[state.step];
    if (state.step === 'home') bindHome();
    $('#navGroups').hidden = !(state.step === 'home' && Object.keys(sessions()).length);
    if (state.step === 'join') bindJoin();
    if (state.step === 'times') bindTimes();
    if (state.step === 'places') bindPlaces();
    if (state.step === 'bloom') bindBloom();
    updateStepper();
    updatePeople();
    updateFlowers();
    window.scrollTo(0, 0);
    const h1 = $('#main h1');
    if (h1 && state.step !== 'home') { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); }
  }

  // ---------- Timers (so simulations survive, but per-view animations don't) ----------
  const timers = { sim: [], deck: [] };
  function later(group, fn, ms) { timers[group].push(setTimeout(fn, ms)); }
  function clearTimers(group) { timers[group].forEach(clearTimeout); timers[group] = []; }

  // ---------- Home ----------
  function homeHTML() {
    return '' +
      '<section class="hero">' +
        '<div>' +
          '<h1>Watch your plan <em>Bloom</em></h1>' +
          '<p class="lede">Paint when you’re free, swipe on where to go. Plans that actually happen.</p>' +
          myGroupsHTML() +
          '<form class="start-card" id="startForm" novalidate>' +
            '<div class="field"><label for="planTitle">What’s the plan?</label>' +
              '<input id="planTitle" name="title" placeholder="e.g. Weekend hangout" maxlength="40" autocomplete="off" required></div>' +
            '<div class="field"><label for="myName">Your name</label>' +
              '<input id="myName" name="name" placeholder="e.g. John" maxlength="20" autocomplete="given-name" required></div>' +
            '<div class="field"><label for="groupPw">Group password</label>' +
              '<input id="groupPw" name="password" type="password" minlength="4" maxlength="64" autocomplete="new-password" required aria-describedby="pwHint">' +
              '<span class="hint" id="pwHint">Friends need this to join. Share it separately from the link (at least 4 characters).</span></div>' +
            '<p class="form-error" id="startError" role="alert"></p>' +
            '<button class="btn" type="submit" id="createBtn">Create group & get invite link →</button>' +
            '<button class="btn ghost" type="button" id="demoBtn">Just looking? Try a demo (nothing is saved)</button>' +
            '<p class="reassure"><span>✓ No sign-ups</span><span>✓ Free</span><span>✓ About 2 minutes</span></p>' +
          '</form>' +
        '</div>' +
        '<div class="hero-art" aria-hidden="true">' +
          heroMark() +
          '<div class="floating f3">✨<div>Everyone’s free!<small>Sat 3–6pm</small></div></div>' +
        '</div>' +
      '</section>' +
      versusHTML() +
      '<section class="how-section" id="how" aria-labelledby="howTitle">' +
      '<p class="section-label">How it works</p>' +
      '<h2 class="section-title" id="howTitle">Three steps. Zero arguments.</h2>' +
      '<ol class="how">' +
        '<li><span class="step-n" aria-hidden="true">1</span><span class="ico" aria-hidden="true">🖌️</span><h3>Paint your time</h3><p>Drag across the hours you’re free. The brighter a square, the more friends can make it.</p></li>' +
        '<li><span class="step-n" aria-hidden="true">2</span><span class="ico" aria-hidden="true">👆</span><h3>Swipe on places</h3><p>Love it, maybe, or pass. No debates, no “idk, you pick”. Step-free access is shown on every card.</p></li>' +
        '<li><span class="step-n" aria-hidden="true">3</span><span class="ico" aria-hidden="true">🌸</span><h3>Watch it bloom</h3><p>Every friend is a petal. When everyone’s in, you get one plan to add to your calendar.</p></li>' +
      '</ol></section>';
  }
  function versusHTML() {
    const chat = [
      ['L', '#7C5CFF', 'anyone free this weekend??'],
      ['M', '#E03131', 'maybe sat? not morning tho'],
      ['J', '#D9831A', 'i can do sun… or sat night'],
      ['L', '#7C5CFF', 'ok where do we go'],
      ['S', '#11966A', 'idk you pick 😅'],
      ['M', '#E03131', 'wait which day did we say'],
    ];
    return '<section class="versus" id="versus" aria-labelledby="versusTitle">' +
      '<p class="section-label">Why Bloom?</p>' +
      '<h2 class="section-title" id="versusTitle">Sound familiar?</h2>' +
      '<div class="versus-grid">' +
        '<figure class="vs-card before"><figcaption><span class="vs-tag">Before</span> The group chat</figcaption>' +
          '<ul class="chat">' + chat.map((c, i) => '<li style="--i:' + i + '"><span class="av sm" style="--c:' + c[1] + '" aria-hidden="true">' + c[0] + '</span><span class="bubble">' + c[2] + '</span></li>').join('') + '</ul>' +
          '<p class="vs-foot">Scroll, scroll… still no plan. 😮‍💨</p></figure>' +
        '<div class="vs-arrow" aria-hidden="true">→</div>' +
        '<figure class="vs-card after"><figcaption><span class="vs-tag good">With Bloom</span> One clear answer</figcaption>' +
          '<div class="mini-plan">' +
            '<div class="mini-grid" aria-hidden="true">' + Array.from({ length: 21 }, (_, i) => '<i style="--h:' + [0, .2, .4, 1, 1, .6, .2][i % 7] * (i > 6 && i < 14 ? 1 : .55) + '"></i>').join('') + '</div>' +
            '<p class="mp-when">⭐ Saturday 3–6pm</p><p class="mp-where">🍜 Lantern Noodle Bar</p>' +
            '<p class="mp-who"><span class="av-stack">' + ['#2F6FEB', '#E03131', '#D9831A', '#7C5CFF', '#11966A'].map((c, i) => '<span class="av sm" style="--c:' + c + '" aria-hidden="true">' + 'YMJPS'[i] + '</span>').join('') + '</span> 5 of 5 coming</p>' +
          '</div>' +
          '<p class="vs-foot">Decided in minutes, not days. 🌸</p></figure>' +
      '</div></section>';
  }
  function myGroupsHTML() {
    const all = sessions();
    const ids = Object.keys(all);
    if (!ids.length) return '';
    return '<section class="my-groups" aria-labelledby="myGroupsTitle"><h2 id="myGroupsTitle">Your groups</h2><ul>' +
      ids.map((id) => '<li><span class="mg-title">' + esc(all[id].title || 'Group ' + id) + '</span>' +
        '<span class="mg-actions"><a class="btn small" href="#/join/' + encodeURIComponent(id) + '">Continue →</a>' +
        '<button type="button" class="icon-btn sm" data-forget="' + esc(id) + '" aria-label="Remove ' + esc(all[id].title || 'group') + ' from this device">✕</button></span></li>').join('') +
      '</ul><p class="hint">Saved on this device. Removing a group here doesn’t delete it for your friends. ' +
      '<button type="button" class="link-btn" id="startFresh">Start fresh</button></p></section>';
  }
  function heroMark() {
    // Three schedules drifting together; the spark is where everyone overlaps.
    return '<svg class="hero-mark" viewBox="-150 -150 300 300">' +
      '<defs><radialGradient id="glow"><stop offset="0" stop-color="#FFD25E" stop-opacity=".9"/><stop offset="1" stop-color="#FFD25E" stop-opacity="0"/></radialGradient></defs>' +
      '<circle class="ring r1" cx="0" cy="-42" r="80" fill="#FF7A3D"/>' +
      '<circle class="ring r2" cx="-37" cy="24" r="80" fill="#14B8A6"/>' +
      '<circle class="ring r3" cx="37" cy="24" r="80" fill="#3B82F6"/>' +
      '<circle class="glow" cx="0" cy="2" r="46" fill="url(#glow)"/>' +
      '<path class="spark" d="M0 -26 L7 -6 L27 2 L7 9 L0 30 L-7 9 L-27 2 L-7 -6 Z" fill="#FFD25E"/>' +
      '</svg>';
  }
  function bindHome() {
    const art = $('.hero-art');
    if (art && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => art.classList.toggle('paused', !en.isIntersecting));
      });
      io.observe(art);
    }
    $$('[data-forget]').forEach((b) => b.addEventListener('click', () => {
      saveSession(b.dataset.forget, null);
      render();
      announce('Group removed from this device.');
      const next = $('[data-forget]') || $('#planTitle');
      if (next) next.focus();
    }));
    const fresh = $('#startFresh');
    if (fresh) fresh.addEventListener('click', () => {
      store.set('bloom.sessions', '{}');
      store.set('bloom.current', '');
      store.set('bloom.name', '');
      state.title = 'Weekend hangout';
      state.me.name = 'You';
      render();
      announce('Started fresh. Saved groups and your name were cleared from this device.');
      $('#planTitle').focus();
    });
    $('#startForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = $('#planTitle').value.trim() || 'Weekend hangout';
      const n = $('#myName').value.trim();
      const pw = $('#groupPw').value;
      const err = $('#startError');
      if (!n) { err.textContent = 'Add your name so friends know who’s inviting them.'; $('#myName').focus(); return; }
      if (pw.length < 4) { err.textContent = 'Pick a group password with at least 4 characters.'; $('#groupPw').focus(); return; }
      const btn = $('#createBtn');
      btn.disabled = true; btn.textContent = 'Creating your group…';
      try {
        const res = await api('POST', '/groups', { title: t, name: n, password: pw, startDate: todayYmd() });
        store.set('bloom.name', n);
        startLive(res);
        go('times');
        toast(null, 'Group created — copy the invite link to share');
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false; btn.textContent = 'Create group & get invite link →';
      }
    });
    $('#demoBtn').addEventListener('click', () => {
      const t = $('#planTitle').value.trim();
      const n = $('#myName').value.trim();
      startDemo(t || 'Weekend hangout', n || 'You');
      go('times');
    });
  }

  // ---------- Step 1: times ----------
  function timesHTML() {
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
        '<p id="gridHelp">Drag across the hours that work for you. The brighter a square, the more friends are free. ' +
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
      '<div class="actionbar"><p class="ab-status" id="toPlacesHint"></p>' +
        '<button type="button" class="btn" id="toPlaces">Next: pick places →</button></div>' +
    '</section>' + sidebarHTML() + '</div>';
  }
  function slug(s) { return (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plan').slice(0, 24); }

  function cellLabel(di, h) {
    const k = key(di, h);
    const who = freeAt(di, h);
    const mine = state.me.avail.has(k);
    const others = who.filter((p) => p !== state.me);
    return dayLong(di) + ' ' + fmtHour(h) + '. ' + (mine ? 'You’re free.' : 'You’re not marked free.') + ' ' +
      who.length + ' of ' + total() + ' free' + (others.length ? ': ' + others.map((p) => p.name).join(', ') : '') + '.';
  }
  let bestKeys = new Set();
  function updateCell(el) {
    const di = +el.dataset.d, h = +el.dataset.h;
    const k = key(di, h);
    const n = freeAt(di, h).length;
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
  function updateAllCells() {
    const runs = computeRuns();
    bestKeys = new Set();
    const top = runs[0];
    if (top && top.who.length > 1) {
      for (let h = top.start; h < top.end; h++) bestKeys.add(key(top.d, h));
    }
    $$('#grid .cell').forEach(updateCell);
  }
  function renderBest() {
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

  function setMine(k, on) {
    if (on) state.me.avail.add(k); else state.me.avail.delete(k);
  }

  function bindTimes() {
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
  function dismissCoach() {
    state.coachDone.grid = true;
    const c = $('#coach');
    if (c) { c.classList.add('gone'); setTimeout(() => c.remove(), 300); }
  }
  function focusCell(el, focus) {
    if (!el) return;
    $$('#grid .cell[tabindex="0"]').forEach((c) => c.setAttribute('tabindex', '-1'));
    el.setAttribute('tabindex', '0');
    if (focus) el.focus();
  }
  function afterMineChanged() {
    if (state.mode === 'live') saveSoon({ avail: Array.from(state.me.avail) });
    refresh();
  }

  function simulateTimes() {
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

  // ---------- Step 2: places ----------
  function placesHTML() {
    return '<div class="page-top"><div class="page-head"><h1>Where should we go?</h1>' +
        '<p>Swipe right if you’d love it, left to pass, up for maybe. There are no wrong answers — your friends are voting too.</p></div></div>' +
      '<div class="layout"><section>' +
      '<div class="places-layout">' +
        '<div class="deck-wrap">' +
          '<div class="deck" id="deck"></div>' +
          '<div class="vote-btns" id="voteBtns">' +
            '<button type="button" class="vote no" data-vote="-1"><span class="v-ico" aria-hidden="true">✕</span><span class="v-lbl">Pass</span></button>' +
            '<button type="button" class="vote maybe" data-vote="0"><span class="v-ico" aria-hidden="true">?</span><span class="v-lbl">Maybe</span></button>' +
            '<button type="button" class="vote yes" data-vote="1"><span class="v-ico" aria-hidden="true">♥</span><span class="v-lbl">Love it</span></button>' +
          '</div>' +
          '<p class="kbd-hint">Keyboard: <kbd>←</kbd> pass · <kbd>↑</kbd> maybe · <kbd>→</kbd> love it</p>' +
        '</div>' +
        '<div class="places-side">' +
        '<form class="panel suggest" id="suggestForm" novalidate>' +
          '<h2 class="sub-title">Got another idea?</h2>' +
          '<p class="suggest-sub">Add it to everyone’s deck. Pick the type first — we’ll ask you to confirm the exact place. Add an area for a specific branch, like “Din Tai Fung Tampines”.</p>' +
          '<div class="suggest-row">' +
            '<label class="sr-only" for="sgName">Place or idea</label>' +
            '<input id="sgName" maxlength="40" placeholder="e.g. Din Tai Fung Tampines" autocomplete="off">' +
            '<label class="sr-only" for="sgKind">Type</label>' +
            '<select id="sgKind">' + Object.keys(KINDS).map((k) => '<option value="' + k + '">' + KINDS[k].emoji + ' ' + KINDS[k].label + '</option>').join('') + '</select>' +
            '<button type="submit" class="btn small">＋ Add</button>' +
          '</div>' +
          '<p class="form-error" id="sgError" role="alert"></p>' +
          '<div class="picker" id="sgPicker" hidden></div>' +
        '</form>' +
        '<div class="panel"><h2 class="sub-title">Group favourites</h2>' +
          '<ol class="rank-list" id="rankList" aria-live="polite"></ol>' +
        '</div>' +
        '</div>' +
      '</div>' +
      '<div class="actionbar"><button type="button" class="btn ghost small" id="undoVote">↶ Undo</button>' +
        '<p class="ab-status" id="toBloomHint"></p>' +
        '<button type="button" class="btn" id="toBloom">See the plan bloom →</button></div>' +
    '</section>' + sidebarHTML() + '</div>';
  }

  function cardHTML(pl, depth) {
    const top = depth === 0;
    return '<article class="card" data-id="' + pl.id + '" data-depth="' + depth + '" style="--depth:' + depth + ';--hue:' + pl.hue + '"' +
      (top ? ' tabindex="0" aria-label="' + esc(pl.name + ', ' + pl.kind + ', ' + pl.price + ', ' + pl.dist + ' away. ' + pl.blurb + ' ' + pl.tags.join(', ')) + '"' : ' aria-hidden="true"') + '>' +
      '<span class="stamp yes" aria-hidden="true">LOVE IT</span><span class="stamp no" aria-hidden="true">PASS</span><span class="stamp maybe" aria-hidden="true">MAYBE</span>' +
      '<div class="card-art"><span aria-hidden="true">' + pl.emoji + '</span><span class="kind">' + esc(pl.kind) + '</span></div>' +
      '<div class="card-body"><h3>' + esc(pl.name) + '</h3>' +
        (pl.price || pl.dist ? '<div class="meta">' + [pl.price, pl.dist].filter(Boolean).map((t) => '<span>' + esc(t) + '</span>').join('') + '</div>' : '') +
        '<p class="blurb">' + esc(pl.blurb) + '</p>' +
        (pl.hoursToday ? '<p class="hours">🕒 Today: ' + esc(pl.hoursToday) + '</p>' : '') +

        '<div class="meta-row">' +
          (pl.tags.length ? '<div class="tags">' + pl.tags.map((t) => '<span class="tag">' + (t === 'Step-free' ? '♿ ' : '') + esc(t) + '</span>').join('') + '</div>' : '') +
          (pl.website ? '<a class="g-link" href="' + esc(pl.website) + '" target="_blank" rel="noopener"' + (top ? '' : ' tabindex="-1"') + '>Website &amp; tickets <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a>' : '') +
          '<a class="g-link" href="' + googleLink(pl) + '" target="_blank" rel="noopener"' + (top ? '' : ' tabindex="-1"') + '>Look it up on Google <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a>' +
        '</div>' +
        (pl.outdoor ? '<div class="wx" data-wx hidden></div>' : '') +
        '<div class="card-friends" data-friends="' + pl.id + '"></div>' +
      '</div></article>';
  }

  function renderDeck() {
    const deck = $('#deck');
    if (!deck) return;
    const rest = allPlaces().slice(state.deckIndex);
    $$('#voteBtns button').forEach((b) => { b.disabled = !rest.length; });
    if (!rest.length) {
      deck.innerHTML = '<div class="deck-done"><div class="big" aria-hidden="true">🌸</div><h3>All swiped!</h3><p class="empty">Check the group favourites, then see your plan bloom.</p></div>';
      return;
    }
    deck.innerHTML = rest.slice(0, 3).map((pl, i) => cardHTML(pl, i)).reverse().join('');
    if (!state.coachDone.deck && !reduceMotion) {
      state.coachDone.deck = true;
      const t = deck.querySelector('.card[data-depth="0"]');
      if (t) t.classList.add('hint-wiggle');
    }
    updateCardFriends();
    updateWeatherEls();
    bindDrag(deck.querySelector('.card[data-depth="0"]'));
  }

  function updateCardFriends() {
    $$('[data-friends]').forEach((el) => {
      const id = el.dataset.friends;
      const yes = state.friends.filter((f) => f.votes[id] === 1);
      el.innerHTML = yes.length ? avatarStack(yes) + '<span>' + esc(namesList(yes)) + (yes.length === 1 ? ' loves' : ' love') + ' this</span>' : '<span>Be the first to vote on this one</span>';
    });
  }

  function bindDrag(card) {
    if (!card) return;
    let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false;
    const yes = card.querySelector('.stamp.yes'), no = card.querySelector('.stamp.no'), maybe = card.querySelector('.stamp.maybe');
    card.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || e.target.closest('a')) return; // let links be clicked
      card.classList.remove('hint-wiggle');
      dragActive = true;
      dragging = true; sx = e.clientX; sy = e.clientY; dx = dy = 0;
      card.setPointerCapture(e.pointerId);
      card.classList.add('dragging');
    });
    card.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dx = e.clientX - sx; dy = e.clientY - sy;
      card.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(' + dx / 14 + 'deg)';
      yes.style.opacity = Math.max(0, Math.min(1, dx / 100));
      no.style.opacity = Math.max(0, Math.min(1, -dx / 100));
      maybe.style.opacity = Math.abs(dx) < 60 ? Math.max(0, Math.min(1, -dy / 100)) : 0;
    });
    const up = () => {
      if (!dragging) return;
      dragging = false;
      dragActive = false;
      card.classList.remove('dragging');
      if (dx > 110) vote(1);
      else if (dx < -110) vote(-1);
      else if (dy < -110 && Math.abs(dx) < 80) vote(0);
      else { card.style.transform = ''; yes.style.opacity = no.style.opacity = maybe.style.opacity = 0; }
    };
    card.addEventListener('pointerup', up);
    card.addEventListener('pointercancel', up);
  }

  let voting = false;
  let dragActive = false;
  function vote(v) {
    if (voting || state.deckIndex >= allPlaces().length) return;
    voting = true;
    const pl = allPlaces()[state.deckIndex];
    const card = $('#deck .card[data-depth="0"]');
    state.me.votes[pl.id] = v;
    if (state.mode === 'live') saveSoon({ votes: Object.assign({}, state.me.votes) });
    const word = v === 1 ? 'Love it' : v === 0 ? 'Maybe' : 'Pass';
    buzz(v === 1 ? [10, 40, 10] : 8);
    if (card) {
      card.style.transform = '';
      card.classList.add(v === 1 ? 'fly-yes' : v === 0 ? 'fly-maybe' : 'fly-no');
      const st = card.querySelector('.stamp.' + (v === 1 ? 'yes' : v === 0 ? 'maybe' : 'no'));
      if (st) st.style.opacity = 1;
    }
    later('deck', () => {
      voting = false;
      const nextIdx = allPlaces().findIndex((p) => !(p.id in state.me.votes));
      state.deckIndex = nextIdx === -1 ? allPlaces().length : nextIdx;
      renderDeck();
      refresh();
      const next = allPlaces()[state.deckIndex];
      announce(word + ' to ' + pl.name + '. ' + (next ? 'Next: ' + next.name + ', ' + next.kind + '.' : 'That was the last place.'));
      const top = $('#deck .card[data-depth="0"]');
      if (top && !(document.activeElement && document.activeElement.closest('#voteBtns'))) top.focus({ preventScroll: true });
    }, reduceMotion ? 10 : 320);
  }

  function undoVote() {
    if (voting) return;
    const lastIdx = (state.deckIndex >= allPlaces().length ? allPlaces().length : state.deckIndex) - 1;
    const pl = allPlaces()[lastIdx];
    if (!pl || !(pl.id in state.me.votes)) return;
    delete state.me.votes[pl.id];
    if (state.mode === 'live') saveSoon({ votes: Object.assign({}, state.me.votes) });
    state.deckIndex = lastIdx;
    renderDeck();
    refresh();
    announce('Undone. ' + pl.name + ' is back on top.');
    const top = $('#deck .card[data-depth="0"]');
    if (top) top.focus({ preventScroll: true });
  }

  // Look the idea up, then ALWAYS ask the person to confirm which place they mean
  // (e.g. which Din Tai Fung branch), so nothing wrong sneaks into the deck.
  async function addSuggestion(e) {
    e.preventDefault();
    const input = $('#sgName'), err = $('#sgError');
    const name = input.value.trim(), kind = $('#sgKind').value;
    err.textContent = '';
    hidePicker();
    if (!name) { err.textContent = 'Type a place or idea first.'; input.focus(); return; }
    if (allPlaces().some((p) => p.name.toLowerCase() === name.toLowerCase())) { err.textContent = '“' + name + '” is already in the deck.'; return; }
    const btn = $('#suggestForm button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Searching…';
    let found = null, approx = false;
    try {
      const res = await fetch('/api/lookup?q=' + encodeURIComponent(name) + '&kind=' + encodeURIComponent(kind));
      if (res.ok) { const data = await res.json(); found = data.results || []; approx = !!data.approximate; }
    } catch (ex) { /* no server (static hosting): skip straight to adding */ }
    btn.disabled = false; btn.textContent = '＋ Add';
    if (found === null) return saveSuggestion(name, kind, null);
    showPicker(name, kind, found, approx);
  }

  function showPicker(name, kind, found, approx) {
    const box = $('#sgPicker');
    const type = (KINDS[kind] || KINDS.other).label.toLowerCase();
    const missingNote = 'Our map doesn’t list every shop — especially ones inside malls. Add it anyway and the Google link on the card will find it.';
    const title = !found.length ? 'We couldn’t find “' + esc(name) + '” on our map'
      : approx ? 'No exact match — closest ' + esc(type) + ' places on the map'
      : found.length === 1 ? 'Is this the one?' : 'Which one did you mean?';
    box.innerHTML = '<p class="pick-title">' + title + '</p>' +
      (!found.length || approx ? '<p class="pick-hint">' + missingNote + '</p>' : '') +
      '<ul' + (approx ? ' class="approx"' : '') + '>' + found.map((r, i) => '<li><button type="button" class="pick" data-i="' + i + '">' +
        '<strong>' + esc(r.name || name) + (r.area ? ' · ' + esc(r.area) : '') + '</strong>' +
        '<span>' + esc([r.category, r.price, r.address].filter(Boolean).join(' · ')) + '</span></button></li>').join('') +
      '<li><button type="button" class="pick plain" data-i="-1"><strong>' + (found.length && !approx ? 'None of these' : 'Add it anyway') + '</strong>' +
        '<span>Add “' + esc(name) + '” as typed</span></button></li></ul>';
    box.hidden = false;
    box.onclick = (ev) => {
      const b = ev.target.closest('.pick');
      if (!b) return;
      const i = +b.dataset.i;
      hidePicker();
      saveSuggestion(name, kind, i >= 0 ? found[i] : null);
    };
    const first = box.querySelector('.pick');
    if (first) first.focus();
    announce(found.length ? found.length + ' matches for ' + name + '. Pick one.' : 'No matches. You can add it as typed.');
  }
  function hidePicker() {
    const box = $('#sgPicker');
    if (box) { box.hidden = true; box.innerHTML = ''; }
  }

  async function saveSuggestion(name, kind, match) {
    const err = $('#sgError');
    let label = match ? (match.name || name) + (match.area ? ' (' + match.area + ')' : '') : name;
    if (label.length > 40) label = label.slice(0, 39) + '…';
    if (allPlaces().some((p) => p.name.toLowerCase() === label.toLowerCase())) { if (err) err.textContent = '“' + label + '” is already in the deck.'; return; }
    const details = match ? { area: match.area, address: match.address, category: match.category, price: match.price,
      hours: match.hours, hoursText: match.hoursText, website: match.website, phone: match.phone } : null;
    if (state.mode === 'live') {
      try {
        const data = await api('POST', '/groups/' + encodeURIComponent(state.group.id) + '/places', { name: label, kind: kind, details: details });
        applyState(data, false);
      } catch (ex) { if (err) err.textContent = ex.message; return; }
    } else {
      state.custom.push({ id: 'p_demo' + Date.now(), name: label, kind: kind, addedBy: state.me.id, details: details });
      const idx = allPlaces().findIndex((p) => !(p.id in state.me.votes));
      state.deckIndex = idx === -1 ? allPlaces().length : idx;
    }
    const input = $('#sgName');
    if (input) input.value = '';
    renderDeck();
    refresh();
    toast(null, '✨ Added “' + label + '” to everyone’s deck');
    announce(label + ' added to the deck.');
  }

  function renderRanking() {
    const ol = $('#rankList');
    if (!ol) return;
    const ranked = rankPlaces().filter((p) => p.voters);
    if (!ranked.length) {
      ol.innerHTML = '<li class="empty" style="display:block">Votes will appear here as people swipe.</li>';
    } else {
      ol.innerHTML = ranked.map((p) =>
        '<li><span class="emoji" aria-hidden="true">' + p.emoji + '</span>' +
        '<div><div class="name">' + esc(p.name) + '</div>' +
        '<div class="bar" aria-hidden="true"><i style="--w:' + Math.round((p.points / (2 * total())) * 100) + '%"></i></div>' +
        '<span class="sr-only">' + p.yes.length + ' yes, ' + p.maybe.length + ' maybe, ' + p.no.length + ' no.</span></div>' +
        avatarStack(p.yes) + '</li>').join('');
    }
    const btn = $('#toBloom'), hint = $('#toBloomHint');
    if (btn) {
      const done = Object.keys(state.me.votes).length;
      const left = allPlaces().length - done;
      btn.disabled = left > 0;
      hint.innerHTML = '<span class="ab-progress" aria-hidden="true"><i style="--w:' + Math.round(done / allPlaces().length * 100) + '%"></i></span>' +
        '<span>' + (left > 0 ? done + ' of ' + allPlaces().length + ' swiped' + (left <= 2 ? ' — almost there!' : '') : '✓ All swiped — ready when you are') + '</span>';
      const undo = $('#undoVote');
      if (undo) undo.disabled = !done;
    }
  }

  function bindPlaces() {
    renderDeck();
    renderRanking();
    $('#voteBtns').addEventListener('click', (e) => {
      const b = e.target.closest('[data-vote]');
      if (b) vote(+b.dataset.vote);
    });
    $('#toBloom').addEventListener('click', () => go('bloom'));
    $('#undoVote').addEventListener('click', undoVote);
    $('#suggestForm').addEventListener('submit', addSuggestion);
    simulateTimes(); // in case someone jumps straight here
    simulateVotes();
  }

  document.addEventListener('keydown', (e) => {
    if (state.step !== 'places') return;
    if (e.target.matches && e.target.matches('input, textarea')) return;
    if (e.target.closest && e.target.closest('#grid')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); vote(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); vote(-1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); vote(0); }
  });

  function simulateVotes() {
    if (state.mode !== 'demo' || state.sim.votes) return;
    state.sim.votes = true;
    state.friends.forEach((f, i) => {
      PLACES.forEach((pl, j) => {
        later('sim', () => {
          f.joined = true;
          f.votes[pl.id] = FRIEND_VOTES[f.id][pl.id];
          if (j === PLACES.length - 1) toast(f, f.name + ' finished voting');
          refresh();
        }, 900 + i * 650 + j * 1100);
      });
    });
  }

  // ---------- Step 3: bloom ----------
  function bloomHTML() {
    const score = bloomScore();
    const runs = computeRuns().filter((r) => r.who.includes(state.me)).slice(0, 3);
    const places = rankPlaces().slice(0, 3);
    if (!runs.find((r) => r.id === state.pickRun)) state.pickRun = runs[0] ? runs[0].id : null;
    if (!places.find((p) => p.id === state.pickPlace)) state.pickPlace = places[0].id;

    return '<section class="bloom-stage">' +
      '<div><div>' + flowerSVG({ stem: true }) + '</div>' +
        '<h1 class="bloom-title">' + (score >= 80 ? 'It’s a plan! 🌸' : score >= 50 ? 'Almost in bloom 🌷' : 'Still budding 🌱') + '</h1>' +
        '<p class="bloom-sub"><strong data-bloom-score>' + score + '%</strong> in bloom · ' +
          (score >= 80 ? 'Everyone’s on board.' : 'A few people are still deciding — you can lock it in anyway.') + '</p>' +
        tieHTML() +
        '<div id="waitingBox">' + waitingHTML() + '</div>' +
      '</div>' +
      '<div><article class="plan-card" id="planCard" aria-labelledby="planTitle"></article>' +
        '<details class="tweak"><summary>Change the time or place</summary>' +
          '<fieldset class="choice-group"><legend>Time</legend><div class="choices">' +
            runs.map((r) => '<label><input type="radio" name="run" value="' + r.id + '"' + (r.id === state.pickRun ? ' checked' : '') + '>' +
              dayShort(r.d) + ' ' + fmtRange(r.start, r.end) + ' · ' + r.who.length + '/' + total() + '</label>').join('') +
          '</div></fieldset>' +
          '<fieldset class="choice-group"><legend>Place</legend><div class="choices">' +
            places.map((p) => '<label><input type="radio" name="place" value="' + p.id + '"' + (p.id === state.pickPlace ? ' checked' : '') + '>' +
              p.emoji + ' ' + esc(p.name) + '</label>').join('') +
          '</div></fieldset>' +
        '</details>' +
      '</div>' +
    '</section>';
  }

  // Still level after every tie-break? Say so, and let the group pick.
  function tieHTML() {
    const r = rankPlaces();
    if (r.length < 2 || !r[0].voters) return '';
    const same = (a, b) => a.points === b.points && a.yes.length === b.yes.length && a.no.length === b.no.length;
    const tied = r.filter((p) => same(p, r[0]));
    if (tied.length < 2) return '';
    return '<p class="tie-note">🤝 It’s a tie between ' + esc(tied.map((p) => p.name).join(' and ')) +
      '. We picked one — use <strong>Change the time or place</strong> to swap.</p>';
  }
  function renderWaiting() {
    const box = $('#waitingBox');
    if (!box) return;
    const html = waitingHTML();
    if (box.innerHTML !== html) box.innerHTML = html;
  }
  function waitingHTML() {
    const waiting = state.friends.filter((f) => !f.avail.size || Object.keys(f.votes).length < allPlaces().length);
    if (!waiting.length) return '';
    return '<div class="waiting"><p>' + avatarStack(waiting) + ' Waiting on <strong>' + esc(namesList(waiting)) + '</strong></p>' +
      (state.mode === 'live' ? '<button type="button" class="btn small ghost" id="nudgeBtn">💌 Copy a friendly nudge</button>' : '') + '</div>';
  }

  function weatherRow(run, pl) {
    const w = weatherAt(run.d, run.start);
    let v, sub;
    if (w) {
      v = wxText(w);
      sub = (pl.outdoor && w.pop >= 50 ? 'Rain likely for an outdoor plan — consider an indoor pick. ' : '') + 'Forecast for ' + WEATHER.place + ' · ';
    } else if (WEATHER.status === 'loading' || WEATHER.status === 'idle') {
      v = 'Checking the forecast…'; sub = '';
    } else {
      v = 'Forecast not available yet'; sub = 'Forecasts cover the next 7 days · ';
    }
    return '<div class="plan-row"><span class="ico" aria-hidden="true">🌦️</span><div><div class="k">Weather</div>' +
      '<div class="v">' + esc(v) + '</div><div class="sub">' + esc(sub) +
      '<button type="button" class="link-btn" id="useLoc">Use my location</button> · data by <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a></div></div></div>';
  }

  function renderPlanCard() {
    const run = computeRuns().find((r) => r.id === state.pickRun) || chosenRun();
    const pl = chosenPlace();
    const card = $('#planCard');
    if (!card) return;
    if (!run) {
      card.innerHTML = '<div class="plan-rows"><p class="empty" style="padding:20px 0">Paint at least one free hour so Bloom can find a time. <a class="link-btn" href="#/times">Add your times</a></p></div>';
      return;
    }
    const sig = [run.id, pl.id, pl.name, pl.hoursToday, pl.website, run.who.map((p) => p.id).join(','), people().map((p) => p.id + ':' + p.avail.size).join(','), WEATHER.status, WEATHER.place].join('|');
    if (card.dataset.sig === sig) return;
    card.dataset.sig = sig;
    const out = people().filter((p) => run.who.indexOf(p) === -1);
    const cant = out.filter((p) => p.avail.size), pending = out.filter((p) => !p.avail.size);
    card.innerHTML =
      '<header><div class="tiny">You’re all set</div><h2 id="planTitle">' + esc(state.title) + '</h2></header>' +
      '<div class="plan-rows">' +
        '<div class="plan-row"><span class="ico" aria-hidden="true">🗓️</span><div><div class="k">When</div>' +
          '<div class="v">' + dateLong(run.d) + '</div><div class="sub">' + fmtHour(run.start) + ' – ' + fmtHour(run.end) + '</div></div></div>' +
        '<div class="plan-row"><span class="ico" aria-hidden="true">' + pl.emoji + '</span><div><div class="k">Where</div>' +
          '<div class="v">' + esc(pl.name) + '</div><div class="sub">' + esc([pl.kind, pl.price, pl.dist].concat(pl.tags).filter(Boolean).join(' · ')) +
          (pl.hoursToday ? '<br>🕒 Today: ' + esc(pl.hoursToday) : '') +
          (pl.website ? '<br><a href="' + esc(pl.website) + '" target="_blank" rel="noopener">Website &amp; tickets ↗</a> · ' : ' · ') +
          '<a href="' + googleLink(pl) + '" target="_blank" rel="noopener">Look it up on Google ↗</a></div></div></div>' +
        weatherRow(run, pl) +
        '<div class="plan-row"><span class="ico" aria-hidden="true">👯</span><div><div class="k">Who’s coming · ' + run.who.length + ' of ' + total() + '</div>' +
          '<div class="going">' +
            run.who.map((p) => '<span class="pill">' + avatar(p, 'sm') + esc(displayName(p)) + '</span>').join('') +
            cant.map((p) => '<span class="pill out">' + avatar(p, 'sm') + esc(p.name) + '<span class="sr-only"> can’t make this time</span></span>').join('') +
            pending.map((p) => '<span class="pill pending">' + avatar(p, 'sm') + esc(p.name) + ' · hasn’t replied</span>').join('') +
          '</div></div></div>' +
      '</div>' +
      '<div class="plan-actions">' +
        '<button type="button" class="btn" id="addCal">📅 Add to calendar</button>' +
        '<button type="button" class="btn ghost" id="copyInvite">Copy invite</button>' +
        '<button type="button" class="btn ghost" id="restart">New plan</button>' +
      '</div>';
    $('#addCal').addEventListener('click', () => downloadICS(run, pl));
    $('#useLoc').addEventListener('click', useMyLocation);
    $('#copyInvite').addEventListener('click', () => copy(
      '🌸 ' + state.title + '\n🗓️ ' + dateLong(run.d) + ', ' + fmtHour(run.start) + '–' + fmtHour(run.end) +
      '\n📍 ' + pl.name + ' (' + pl.dist + ')\n👯 ' + run.who.map((p) => p.name).join(', ') + '\nPlanned with Bloom', 'Invite copied — paste it in the group chat'));
    $('#restart').addEventListener('click', restart);
  }

  function bindBloom() {
    renderPlanCard();
    $('#waitingBox').addEventListener('click', (e) => {
      if (!e.target.closest('#nudgeBtn')) return;
      const waiting = state.friends.filter((f) => !f.avail.size || Object.keys(f.votes).length < allPlaces().length);
      copy('Hey ' + waiting.map((f) => f.name).join(' & ') + '! 🌸 We’re almost done planning “' + state.title + '” — tap to add your times and votes (takes 1 min): ' + inviteLink(),
        'Nudge copied — paste it in the group chat');
    });
    $$('input[name="run"]').forEach((r) => r.addEventListener('change', () => { state.pickRun = r.value; renderPlanCard(); announce('Time changed.'); }));
    $$('input[name="place"]').forEach((r) => r.addEventListener('change', () => { state.pickPlace = r.value; renderPlanCard(); announce('Place changed.'); }));
    // Let the flower open from a bud for the big reveal.
    if (!reduceMotion) {
      $$('.bloom-stage .petal').forEach((p) => p.style.setProperty('--s', '0.1'));
      requestAnimationFrame(() => requestAnimationFrame(() => { updateFlowers(); }));
      if (bloomScore() >= 80) setTimeout(confetti, 450);
    }
  }

  function restart() {
    stopSync();
    state.mode = 'demo'; state.group = null; state.session = null;
    store.set('bloom.current', '');
    setWeek(null);
    state.friends = FRIENDS.map((f) => Object.assign({}, f, { avail: new Set(), votes: {}, joined: false }));
    state.me = { id: 'me', name: state.me.name, color: '#2F6FEB', avail: new Set(), votes: {}, joined: true };
    clearTimers('sim');
    state.me.avail.clear();
    state.me.votes = {};
    state.friends.forEach((f) => { f.avail.clear(); f.votes = {}; f.joined = false; });
    state.sim = { times: false, votes: false };
    state.deckIndex = 0;
    state.custom = [];
    state.milestones = {};
    state.coachDone = { grid: false, deck: false };
    state.pickRun = state.pickPlace = null;
    go('home');
  }

  function confetti() {
    const layer = document.createElement('div');
    layer.className = 'confetti';
    layer.setAttribute('aria-hidden', 'true');
    const colors = people().map((p) => p.color).concat(['#F5A524']);
    for (let i = 0; i < 40; i++) {
      const p = document.createElement('i');
      p.style.left = Math.random() * 100 + 'vw';
      p.style.setProperty('--c', colors[i % colors.length]);
      p.style.setProperty('--d', (2.2 + Math.random() * 1.6) + 's');
      p.style.setProperty('--delay', (Math.random() * 0.6) + 's');
      p.style.setProperty('--x', (Math.random() * 160 - 80) + 'px');
      p.style.setProperty('--r', (Math.random() * 720 - 360) + 'deg');
      layer.appendChild(p);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 4500);
  }

  // ---------- Milestones (small rewards keep momentum going) ----------
  function checkMilestones() {
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
  function celebrate(msg) {
    toast(null, msg);
    announce(msg);
    buzz([12, 50, 12]);
  }
  function buzz(pattern) {
    if (reduceMotion || !navigator.vibrate) return;
    // Browsers only allow vibration after the person has tapped the page.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    try { navigator.vibrate(pattern); } catch (e) { /* unsupported */ }
  }

  // ---------- Accessibility preferences ----------
  const prefs = { counts: false, calm: false, contrast: false };
  try { Object.assign(prefs, JSON.parse(store.get('bloom.prefs') || '{}')); } catch (e) { /* ignore */ }
  function applyPrefs() {
    const root = document.documentElement;
    ['counts', 'calm', 'contrast'].forEach((k) => root.classList.toggle('pref-' + k, !!prefs[k]));
    reduceMotion = motionMQ.matches || prefs.calm;
    $$('#a11yPanel input[data-pref]').forEach((i) => { i.checked = !!prefs[i.dataset.pref]; });
    if (state.step === 'times') updateAllCells();
  }
  const a11yBtn = $('#a11yBtn'), a11yPanel = $('#a11yPanel');
  function setA11yOpen(open) {
    a11yPanel.hidden = !open;
    a11yBtn.setAttribute('aria-expanded', String(open));
    if (open) { const first = a11yPanel.querySelector('input'); if (first) first.focus(); }
  }
  a11yBtn.addEventListener('click', () => setA11yOpen(a11yPanel.hidden));
  a11yPanel.addEventListener('change', (e) => {
    const k = e.target.dataset.pref;
    if (!k) return;
    prefs[k] = e.target.checked;
    store.set('bloom.prefs', JSON.stringify(prefs));
    applyPrefs();
    announce(e.target.closest('label').querySelector('strong').textContent + (e.target.checked ? ' on' : ' off'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !a11yPanel.hidden) { setA11yOpen(false); a11yBtn.focus(); }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!a11yPanel.hidden && !e.target.closest('.a11y-wrap')) setA11yOpen(false);
  });
  applyPrefs();

  // ---------- Page size (− 100% +) ----------
  const ZOOM_MIN = 0.7, ZOOM_MAX = 1.5, ZOOM_STEP = 0.1;
  let zoom = parseFloat(store.get('bloom.zoom')) || 1;
  let zoomShown = zoom, zoomAnim = null;
  function showZoom(z) {
    document.documentElement.style.zoom = z === 1 ? '' : String(z);
    $('#zoomReset').textContent = Math.round(z * 100) + '%';
  }
  function setZoom(target) {
    zoom = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, target)) * 10) / 10;
    store.set('bloom.zoom', String(zoom));
    $('#zoomOut').disabled = zoom <= ZOOM_MIN;
    $('#zoomIn').disabled = zoom >= ZOOM_MAX;
    $('#zoomReset').setAttribute('aria-label', 'Page size ' + Math.round(zoom * 100) + '%. Click to reset');
    announce('Page size ' + Math.round(zoom * 100) + '%');
    cancelAnimationFrame(zoomAnim);
    if (reduceMotion) { zoomShown = zoom; showZoom(zoom); return; }
    // Ease smoothly to the new size instead of jumping.
    const from = zoomShown, to = zoom, t0 = performance.now(), dur = 420;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      zoomShown = from + (to - from) * e;
      showZoom(k === 1 ? to : zoomShown);
      if (k < 1) zoomAnim = requestAnimationFrame(step);
    };
    zoomAnim = requestAnimationFrame(step);
  }
  $('#zoomIn').addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
  $('#zoomOut').addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
  $('#zoomReset').addEventListener('click', () => setZoom(1));
  showZoom(zoom);
  $('#zoomOut').disabled = zoom <= ZOOM_MIN;
  $('#zoomIn').disabled = zoom >= ZOOM_MAX;

  // Home navigation bar
  $('.home-nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-scroll]');
    if (!b) return;
    const doScroll = () => {
      const el = document.getElementById(b.dataset.scroll);
      if (el) el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      if (b.dataset.focus) setTimeout(() => { const f = document.getElementById(b.dataset.focus); if (f) f.focus({ preventScroll: true }); }, reduceMotion ? 0 : 450);
    };
    if (state.step !== 'home') { go('home'); setTimeout(doScroll, 50); } else doScroll();
  });
  $('#navDemo').addEventListener('click', () => {
    const t = $('#planTitle'), n = $('#myName');
    startDemo((t && t.value.trim()) || 'Weekend hangout', (n && n.value.trim()) || state.me.name || 'You');
    go('times');
  });

  // ---------- Utilities ----------
  function downloadICS(run, pl) {
    const d = DAYS[run.d];
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = (h) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' + pad(h) + '0000';
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const icsText = (t) => String(t).replace(/\\/g, '\\\\').replace(/[;,]/g, '\\$&').replace(/\r?\n/g, '\\n');
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bloom//Group Plans//EN', 'BEGIN:VEVENT',
      'UID:' + Date.now() + '@bloom.plan', 'DTSTAMP:' + now,
      'DTSTART:' + stamp(run.start), 'DTEND:' + stamp(run.end),
      'SUMMARY:' + icsText(state.title), 'LOCATION:' + icsText(pl.name),
      'DESCRIPTION:' + icsText('With ' + run.who.map((p) => p.name).join(', ') + '. Planned with Bloom.'),
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    const a = document.createElement('a');
    a.href = url; a.download = slug(state.title) + '.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(null, '📅 Calendar event downloaded');
    announce('Calendar event downloaded.');
  }

  function copy(text, msg) {
    const done = () => { toast(null, msg); announce(msg); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      done();
    }
  }

  // ---------- Theme ----------
  const themeBtn = $('#themeToggle');
  function currentTheme() {
    const set = document.documentElement.getAttribute('data-theme');
    if (set) return set;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function syncThemeBtn() {
    const t = currentTheme();
    themeBtn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    themeBtn.innerHTML = t === 'dark'
      ? '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></g></svg>'
      : '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  }
  const savedTheme = store.get('bloom.theme');
  if (savedTheme === 'dark' || savedTheme === 'light') document.documentElement.setAttribute('data-theme', savedTheme);
  themeBtn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.set('bloom.theme', next);
    syncThemeBtn();
  });
  syncThemeBtn();

  // ---------- Live groups (server.py + SQLite) ----------
  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.session) headers.Authorization = 'Bearer ' + state.session.token;
    let res;
    try {
      res = await fetch('/api' + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw Object.assign(new Error('Can’t reach the Bloom server. Is it running? (npm start)'), { status: 0 });
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !data) {
      const msg = data && data.error ? data.error
        : res.status === 404 || res.status === 501 ? 'The Bloom server isn’t running — start it with npm start.'
        : 'Something went wrong (' + res.status + ').';
      throw Object.assign(new Error(msg), { status: res.status });
    }
    return data;
  }

  function sessions() {
    try { return JSON.parse(store.get('bloom.sessions') || '{}') || {}; } catch (e) { return {}; }
  }
  function saveSession(groupId, sess) {
    const all = sessions();
    if (sess) all[groupId] = sess; else delete all[groupId];
    store.set('bloom.sessions', JSON.stringify(all));
  }
  function inviteLink() {
    return location.origin + location.pathname + '#/join/' + encodeURIComponent(state.group ? state.group.id : '');
  }

  function startLive(res) {
    clearTimers('sim');
    state.mode = 'live';
    state.session = { memberId: res.memberId, token: res.token };
    saveSession(res.groupId, state.session);
    store.set('bloom.current', res.groupId);
    state.friends = [];
    state.custom = [];
    state.me = { id: res.memberId, name: 'You', color: '#2F6FEB', avail: new Set(), votes: {}, joined: true };
    state.pickRun = state.pickPlace = null;
    state.milestones = {};
    applyState(res.state, true);
    saveSession(res.groupId, Object.assign({}, state.session, { title: state.group.title }));
    startSync();
  }

  function startDemo(title, name) {
    stopSync();
    state.mode = 'demo'; state.group = null; state.session = null;
    store.set('bloom.current', '');
    setWeek(null);
    state.title = title;
    state.me = { id: 'me', name: name, color: '#2F6FEB', avail: new Set(), votes: {}, joined: true };
    state.friends = FRIENDS.map((f) => Object.assign({}, f, { avail: new Set(), votes: {}, joined: false }));
    state.sim = { times: false, votes: false };
    state.deckIndex = 0;
    state.custom = [];
    state.milestones = {};
    state.coachDone = { grid: false, deck: false };
    state.pickRun = state.pickPlace = null;
  }

  // Merge the server's copy of the group into local state.
  let pendingSave = null;
  function applyState(data, first) {
    const g = data.group;
    if (!state.group || state.group.startDate !== g.startDate) setWeek(g.startDate);
    state.group = g;
    state.title = g.title;
    const known = new Set(state.friends.map((f) => f.id));
    const toPerson = (m) => ({ id: m.id, name: m.name, color: m.color, avail: new Set(m.avail), votes: m.votes, joined: true, isHost: m.isHost });
    const mine = data.members.find((m) => m.id === data.me);
    if (mine) {
      const me = toPerson(mine);
      // Don't let an older server copy overwrite edits that are still being saved.
      // This device is the source of truth for your own answers once loaded.
      if (!first && state.me.id === me.id) { me.avail = state.me.avail; me.votes = state.me.votes; }
      if (first) { me.avail = new Set(mine.avail); me.votes = mine.votes; }
      state.me = me;
    }
    state.friends = data.members.filter((m) => m.id !== data.me).map(toPerson);
    const knownPlaces = new Set(state.custom.map((c) => c.id));
    state.custom = data.places || [];
    if (!first) {
      state.custom.filter((c) => !knownPlaces.has(c.id) && c.addedBy !== state.me.id).forEach((c) => {
        const who = state.friends.find((f) => f.id === c.addedBy);
        toast(who || null, (who ? who.name : 'Someone') + ' suggested ' + c.name);
      });
    }
    if (!first) {
      state.friends.filter((f) => !known.has(f.id)).forEach((f) => {
        toast(f, f.name + ' joined ' + state.title);
        announce(f.name + ' joined the group.');
      });
    }
    const firstUnvoted = allPlaces().findIndex((p) => !(p.id in state.me.votes));
    state.deckIndex = firstUnvoted === -1 ? allPlaces().length : firstUnvoted;
  }

  let saveTimer = null;
  function saveSoon(patch) {
    pendingSave = Object.assign(pendingSave || {}, patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
  }
  let saving = false;
  async function flushSave() {
    if (!pendingSave || !state.group) return;
    if (saving) { saveTimer = setTimeout(flushSave, 300); return; }
    const patch = pendingSave;
    pendingSave = null; // edits made while this request is in flight start a fresh patch
    saving = true;
    try {
      await api('PUT', '/groups/' + encodeURIComponent(state.group.id) + '/me', patch);
    } catch (e) {
      pendingSave = Object.assign({}, patch, pendingSave || {}); // newer edits win
      toast(null, 'Couldn’t save — retrying…');
      saveTimer = setTimeout(flushSave, 3000);
    } finally {
      saving = false;
    }
  }

  // Poll every 3s while the tab is visible; pause when hidden to save battery/CPU.
  let syncTimer = null;
  async function pull() {
    if (state.mode !== 'live' || !state.group || document.hidden) return;
    try {
      const data = await api('GET', '/groups/' + encodeURIComponent(state.group.id) + '/state');
      applyState(data, false);
      refresh();
    } catch (e) {
      if (e.status === 401 || e.status === 404) { stopSync(); toast(null, e.message); }
    }
  }
  function startSync() {
    stopSync();
    syncTimer = setInterval(pull, 3000);
  }
  function stopSync() {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });

  async function resumeLive() {
    const gid = store.get('bloom.current');
    const sess = gid && sessions()[gid];
    if (!sess) return;
    state.session = sess;
    try {
      const data = await api('GET', '/groups/' + encodeURIComponent(gid) + '/state');
      startLive({ groupId: gid, memberId: sess.memberId, token: sess.token, state: data });
    } catch (e) {
      state.session = null;
      if (e.status === 401 || e.status === 404) { saveSession(gid, null); store.set('bloom.current', ''); }
    }
  }

  // ---------- Invite / join ----------
  let invite = null;
  async function openInvite(gid) {
    state.joinId = gid;
    const sess = sessions()[gid];
    if (sess) {
      if (state.mode === 'live' && state.group && state.group.id === gid) { go('times', false); return; }
      state.session = sess;
      try {
        const data = await api('GET', '/groups/' + encodeURIComponent(gid) + '/state');
        startLive({ groupId: gid, memberId: sess.memberId, token: sess.token, state: data });
        go('times');
        return;
      } catch (e) {
        state.session = null;
        if (e.status === 401 || e.status === 404) saveSession(gid, null);
        else if (e.status === 0) { invite = { error: e.message }; state.step = 'join'; render(); return; }
      }
    }
    invite = { loading: true };
    state.step = 'join';
    render();
    try {
      invite = await api('GET', '/groups/' + encodeURIComponent(gid) + '/invite');
    } catch (e) {
      invite = { error: e.message };
    }
    if (state.step === 'join') render();
  }

  function joinHTML() {
    if (!invite || invite.loading) {
      return '<section class="join-wrap"><div class="join-card"><p class="empty">Opening your invite…</p></div></section>';
    }
    if (invite.error) {
      return '<section class="join-wrap"><div class="join-card">' +
        '<div class="join-mark" aria-hidden="true">🔗</div><h1>Invite not found</h1>' +
        '<p class="join-sub">' + esc(invite.error) + '</p>' +
        '<a class="btn" href="#/">Go to Bloom</a></div></section>';
    }
    return '<section class="join-wrap"><form class="join-card" id="joinForm" novalidate>' +
      '<img class="join-mark" src="icon.svg" width="64" height="64" alt="">' +
      '<p class="eyebrow">You’re invited</p>' +
      '<h1><span class="host">' + esc(invite.host) + '</span> is inviting you to <span class="grp">' + esc(invite.title) + '</span></h1>' +
      '<p class="join-sub">' + invite.memberCount + (invite.memberCount === 1 ? ' person has' : ' people have') + ' joined so far. Enter the group password to see who’s in and start planning together.</p>' +
      '<div class="field"><label for="joinName">Your name</label>' +
        '<input id="joinName" maxlength="20" autocomplete="given-name" required value="' + (state.me.name === 'You' ? '' : esc(state.me.name)) + '"></div>' +
      '<div class="field"><label for="joinPw">Group password</label>' +
        '<input id="joinPw" type="password" maxlength="64" autocomplete="current-password" required aria-describedby="joinPwHint">' +
        '<span class="hint" id="joinPwHint">Ask ' + esc(invite.host) + ' if you don’t have it.</span></div>' +
      '<p class="form-error" id="joinError" role="alert"></p>' +
      '<button class="btn" type="submit" id="joinBtn">Join the group →</button>' +
    '</form></section>';
  }

  function bindJoin() {
    const form = $('#joinForm');
    if (!form) return;
    (state.me.name === 'You' ? $('#joinName') : $('#joinPw')).focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#joinName').value.trim();
      const pw = $('#joinPw').value;
      const err = $('#joinError');
      if (!name) { err.textContent = 'Add your name so the group knows who you are.'; $('#joinName').focus(); return; }
      if (!pw) { err.textContent = 'Enter the group password.'; $('#joinPw').focus(); return; }
      const btn = $('#joinBtn');
      btn.disabled = true; btn.textContent = 'Checking…';
      try {
        const res = await api('POST', '/groups/' + encodeURIComponent(state.joinId) + '/join', { name: name, password: pw });
        store.set('bloom.name', name);
        startLive(res);
        go('times');
        toast(null, 'You’re in! Paint when you’re free.');
      } catch (ex) {
        err.textContent = ex.status === 403 && /password/.test(ex.message) ? 'That password doesn’t match. Ask ' + invite.host + ' to double-check it.' : ex.message;
        btn.disabled = false; btn.textContent = 'Join the group →';
        $('#joinPw').select();
      }
    });
  }

  // ---------- Weather (Open-Meteo, free, no API key) ----------
  const WEATHER = { lat: 1.2897, lon: 103.8501, place: 'Singapore', hourly: null, status: 'idle' };
  async function loadWeather() {
    WEATHER.status = 'loading';
    try {
      const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + WEATHER.lat + '&longitude=' + WEATHER.lon +
        '&hourly=temperature_2m,precipitation_probability,weather_code&forecast_days=8&timezone=auto';
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const map = {};
      j.hourly.time.forEach((t, i) => {
        map[t] = { temp: j.hourly.temperature_2m[i], pop: j.hourly.precipitation_probability[i], code: j.hourly.weather_code[i] };
      });
      WEATHER.hourly = map;
      WEATHER.status = 'ok';
    } catch (e) {
      WEATHER.status = 'error';
    }
    updateWeatherEls();
    if (state.step === 'bloom') renderPlanCard();
  }
  function weatherAt(di, h) {
    if (!WEATHER.hourly) return null;
    const d = DAYS[di];
    return WEATHER.hourly[d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(h) + ':00'] || null;
  }
  function wxIcon(c) {
    if (c === 0) return '☀️';
    if (c <= 2) return '🌤️';
    if (c === 3) return '☁️';
    if (c === 45 || c === 48) return '🌫️';
    if (c >= 95) return '⛈️';
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return '❄️';
    return '🌧️';
  }
  function wxText(w) { return wxIcon(w.code) + ' ' + Math.round(w.temp) + '°C · ' + w.pop + '% chance of rain'; }
  function updateWeatherEls() {
    const run = computeRuns()[0];
    $$('[data-wx]').forEach((el) => {
      const w = run && weatherAt(run.d, run.start);
      if (!w) { el.hidden = true; return; }
      el.hidden = false;
      el.classList.toggle('warn', w.pop >= 50);
      el.textContent = 'Forecast ' + dayShort(run.d) + ' ' + fmtHour(run.start) + ': ' + wxText(w) + (w.pop >= 50 ? ' — maybe bring a plan B' : '');
    });
  }
  function useMyLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      WEATHER.lat = pos.coords.latitude.toFixed(3);
      WEATHER.lon = pos.coords.longitude.toFixed(3);
      WEATHER.place = 'your location';
      announce('Updating the forecast for your location.');
      loadWeather();
    }, () => toast(null, 'Location not shared — showing Singapore weather'));
  }

  // ---------- Boot ----------
  const savedName = store.get('bloom.name');
  if (savedName) state.me.name = savedName;

  loadWeather();
  resumeLive().then(() => route(false));
})();
