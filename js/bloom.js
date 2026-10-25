// Step 3: the final plan card, calendar file and nudges.
import { $, $$, esc, reduceMotion, store } from './util.js';
import { dateLong, dayLong, DAYS, dayShort, fmtHour, fmtRange, setWeek, ymd } from './dates.js';
import { allPlaces, googleLink, placeTitle, votedCount } from './data.js';
import { FRIENDS, people, state, total } from './state.js';
import { chosenRun, computeRuns, isHost, lockedRun, MIN_GROUP, maxStops, nextStop, planStops, rankPlaces, timeVotes } from './derive.js';
import { announce, avatar, avatarStack, copy, displayName, couchSVG, namesList, toast, updateCouch } from './ui.js';
import { clearTimers, go, render } from './router.js';
import { slug } from './times.js';
import { api, applyState, invite, inviteLink, stopSync } from './live.js';
import { useMyLocation, WEATHER, weatherAt, wxIcon } from './weather.js';

// Step 3 looks different for each person. Nobody waits for anybody before this: the host
// looks at everyone's times and ideas and locks in the plan; until then everyone else sees
// "waiting for the host"; once it's locked, everyone sees the same final plan.
export function bloomView() { return state.plan ? 'locked' : isHost() ? 'decide' : 'wait'; }
export const hostName = () => (state.group && state.group.host) || 'The host';

export function bloomHTML() {
  const view = bloomView();
  if (view === 'wait') return waitHTML();
  const locked = view === 'locked';
  if (!locked) {
    const runs = computeRuns().slice(0, 4);
    if (!runs.find((r) => r.id === state.pickRun)) state.pickRun = runs[0] ? runs[0].id : null;
  }
  return '<section class="bloom-stage" data-view="' + view + '">' +
    '<div><div>' + couchSVG({ big: true, party: locked }) + '</div>' +
      '<h1 class="bloom-title' + (locked ? ' reveal' : '') + '">' + (locked
        // The words rise in one after another.
        ? 'All set! You’re good to go 🎉'.split(' ').map((w, i) => '<span class="w" style="--i:' + i + '">' + w + '</span>').join(' ')
        : 'Pick the plan') + '</h1>' +
      '<p class="bloom-sub">' + (locked
        ? (isHost() ? 'You locked it in — everyone in the group can see it now.' : esc(hostName()) + ' locked it in. See you there!')
        : 'Look through everyone’s times and ideas, chat it out in the group, then lock it in. Until you do, friends see “waiting for the host”.') + '</p>' +
      (locked ? '' : '<div id="waitingBox">' + waitingHTML() + '</div>') +
    '</div>' +
    '<div>' +
      // Host: choose first, then check the draft, then lock it in.
      (locked ? '' : '<div class="decide" id="decide">' + decideHTML() + '</div>') +
      '<article class="plan-card' + (locked ? '' : ' draft') + '" id="planCard" aria-labelledby="planTitle"></article>' +
      (locked ? '' : tieHTML()) +
    '</div>' +
  '</section>';
}

// The host's choices: the best times (with date votes) and every place (with swipes).
function decideHTML() {
  const runs = computeRuns().slice(0, 4);
  if (!runs.length) return '';
  return (runs[0].who.length < 2 ? '<p class="best-hint">No shared time yet — nudge friends to add more hours.</p>' : '') +
    '<fieldset class="choice-group"><legend>When</legend><div class="choices">' +
      runs.map((r) => {
        const v = timeVotes(r).length;
        return '<label><input type="radio" name="run" value="' + r.id + '"' + (r.id === state.pickRun ? ' checked' : '') + '>' +
          esc(dayShort(r.d) + ' ' + fmtRange(r.start, r.end)) + ' · ' + r.who.length + '/' + total() + ' free' +
          (v ? ' · ' + v + (v === 1 ? ' vote' : ' votes') : '') + '</label>';
      }).join('') +
    '</div></fieldset>' +
    '<div id="stopChoices">' + stopChoicesHTML() + '</div>';
}

// Everyone but the host, until the plan is locked: you're done, here's how it's going.
function waitHTML() {
  return '<section class="wait-stage" data-view="wait">' +
    '<div class="wait-couch">' + couchSVG({ big: true }) + '</div>' +
    '<h1 class="bloom-title">Waiting for ' + esc(hostName()) + ' to pick the plan</h1>' +
    '<p class="bloom-sub">You’re done for now 🙌 This page updates by itself — the plan appears here as soon as it’s locked in.</p>' +
    '<div class="panel front" id="frontRunners">' + frontRunnersHTML() + '</div>' +
    '<div class="wait-actions"><a class="btn ghost" href="#/places">Suggest another place</a><a class="btn ghost" href="#/times">Change your times</a></div>' +
  '</section>';
}
function frontRunnersHTML() {
  const top = computeRuns()[0], place = rankPlaces()[0];
  const run = top && top.who.length >= 2 ? top : null; // one person alone isn't a match
  return '<h2 class="sub-title">So far</h2><ul class="front-list">' +
    '<li><span class="ico" aria-hidden="true">🗓️</span><span>' + (run
      ? esc(dayLong(run.d) + ' ' + fmtRange(run.start, run.end)) + '<small>' + run.who.length + ' of ' + total() + ' free</small>'
      : 'No shared time yet<small>Waiting for more hours</small>') + '</span></li>' +
    '<li><span class="ico" aria-hidden="true">📍</span><span>' + (place
      ? esc(placeTitle(place)) + '<small>' + (place.voters ? place.yes.length + ' love it · ' + place.maybe.length + ' maybe' : 'No swipes yet') + '</small>'
      : 'No ideas yet<small>Suggest one!</small>') + '</span></li>' +
  '</ul><p class="hint">These can still change — ' + esc(hostName()) + ' has the final say.</p>';
}
export function renderFrontRunners() {
  const box = $('#frontRunners');
  if (!box) return;
  const html = frontRunnersHTML();
  if (box.innerHTML !== html) box.innerHTML = html;
}

// Still level after every tie-break? Say so, and let the group pick.
export function tieHTML() {
  const r = rankPlaces();
  if (r.length < 2 || !r[0].voters) return '';
  const same = (a, b) => a.points === b.points && a.yes.length === b.yes.length && a.no.length === b.no.length;
  const tied = r.filter((p) => same(p, r[0]));
  if (tied.length < 2) return '';
  // A long plan may already include every tied place, so there's nothing to break.
  const inPlan = planStops(chosenRun()).filter((s) => tied.some((p) => p.id === s.id));
  if (inPlan.length === tied.length) return '';
  const names = (list) => list.length < 3 ? list.join(' and ') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  return '<p class="tie-note">🤝 It’s a tie between ' + esc(names(tied.map(placeTitle))) + '. ' +
    esc(names(inPlan.map(placeTitle))) + ' is in the draft — pick another under <strong>Where</strong> to swap.</p>';
}
export function renderWaiting() {
  const box = $('#waitingBox');
  if (!box) return;
  const html = waitingHTML();
  if (box.innerHTML !== html) box.innerHTML = html;
}
export function waitingHTML() {
  const waiting = state.friends.filter((f) => !f.avail.size || votedCount(f) < allPlaces().length);
  if (!waiting.length) return '';
  return '<div class="waiting"><p>' + avatarStack(waiting) + ' Waiting on <strong>' + esc(namesList(waiting)) + '</strong></p>' +
    (state.mode === 'live' ? '<button type="button" class="btn small ghost" id="nudgeBtn">💌 Copy a friendly nudge</button>' : '') + '</div>';
}

export function weatherRow(run, stops) {
  // The whole slot, not just its first hour: warmest/coolest and the highest chance of rain.
  const hours = [];
  for (let h = run.start; h < run.end; h++) { const x = weatherAt(run.d, h); if (x) hours.push(x); }
  let v, sub;
  if (hours.length) {
    const temps = hours.map((x) => Math.round(x.temp));
    const pop = Math.max.apply(null, hours.map((x) => x.pop || 0));
    const lo = Math.min.apply(null, temps), hi = Math.max.apply(null, temps);
    v = wxIcon(hours[0].code) + ' ' + (lo === hi ? lo : lo + '–' + hi) + '°C · ' + (hours.length > 1 ? 'up to ' : '') + pop + '% chance of rain';
    // Warn about the outdoor stop itself, at its own time.
    const wet = stops.filter((s) => s.outdoor).find((s) => {
      for (let h = Math.floor(s.start); h < Math.ceil(s.end); h++) { const x = weatherAt(run.d, h); if (x && x.pop >= 50) return true; }
      return false;
    });
    sub = (wet ? 'Rain likely during ' + placeTitle(wet) + ' — consider an indoor pick. ' : '') + 'Forecast for ' + WEATHER.place + ' · ';
  } else if (WEATHER.status === 'loading' || WEATHER.status === 'idle') {
    v = 'Checking the forecast…'; sub = '';
  } else {
    v = 'Forecast not available yet'; sub = 'Forecasts cover the next 7 days · ';
  }
  return '<div class="plan-row"><span class="ico" aria-hidden="true">🌦️</span><div><div class="k">Weather</div>' +
    '<div class="v">' + esc(v) + '</div><div class="sub">' + esc(sub) +
    '<button type="button" class="link-btn" id="useLoc">Use my location</button> · data by <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a></div></div></div>';
}

// "2pm", "3:30pm": stops can start on the half hour.
export function fmtTime(t) {
  const h = Math.floor(t);
  if (t === h) return fmtHour(h);
  const half = fmtHour(h);
  return half.replace(/(am|pm)$/, ':30$1');
}
export const fmtSpan = (a, b) => fmtTime(a) + '–' + fmtTime(b);

// Swap the plan's main place for another favourite (extra stops are added on the card).
export function stopChoicesHTML() {
  const run = chosenRun();
  if (!run) return '';
  const main = (planStops(run)[0] || {}).id;
  return '<fieldset class="choice-group"><legend>Where</legend><div class="choices">' +
    rankPlaces().map((p) => '<label><input type="radio" name="stop" value="' + p.id + '"' +
      (p.id === main ? ' checked' : '') + '>' + p.emoji + ' ' + esc(placeTitle(p)) +
      (p.yes.length ? ' · ♥ ' + p.yes.length : '') + '</label>').join('') +
    '</div></fieldset>';
}

// The message people paste into the group chat once the plan is set.
export function inviteText(run, stops) {
  const out = people().filter((p) => run.who.indexOf(p) === -1 && p.avail.size);
  const where = stops.length === 1
    ? ['📍 ' + [placeTitle(stops[0]), stops[0].dist].filter(Boolean).join(' · '), '🔗 ' + googleLink(stops[0])]
    : stops.map((s, i) => (i + 1) + '. ' + fmtSpan(s.start, s.end) + ' ' + s.emoji + ' ' +
        [placeTitle(s), s.dist].filter(Boolean).join(' · ') + '\n   🔗 ' + googleLink(s));
  const lines = [
    '🛋️ ' + state.title + ' — Time to Lepak!',
    '🗓️ ' + dateLong(run.d) + ', ' + fmtSpan(stops[0].start, stops[stops.length - 1].end),
  ].concat(where, [
    '👯 ' + run.who.map((p) => p.name).join(', ') + (out.length ? ' (' + out.map((p) => p.name).join(', ') + ' can’t make it)' : ''),
  ]);
  if (state.mode === 'live') lines.push('Plan with us on Lepak: ' + inviteLink());
  return lines.join('\n');
}

export function renderPlanCard() {
  const view = bloomView();
  if (view === 'wait') return renderFrontRunners();
  const locked = view === 'locked';
  // The locked plan for everyone, or the host's draft while they decide.
  const run = locked ? lockedRun() : computeRuns().find((r) => r.id === state.pickRun) || chosenRun();
  const stops = locked ? planStops(run, state.plan.stops) : planStops(run);
  const pl = stops[0];
  const card = $('#planCard');
  if (!card) return;
  if (!run) {
    card.innerHTML = '<div class="plan-rows"><p class="empty" style="padding:20px 0">Paint at least one free hour so Lepak can find a time. <a class="link-btn" href="#/times">Add your times</a></p></div>';
    return;
  }
  if (!pl) {
    card.innerHTML = '<div class="plan-rows"><p class="empty" style="padding:20px 0">Add a place to swipe on so Lepak can plan where to go. <a class="link-btn" href="#/places">Pick places</a></p></div>';
    return;
  }
  const sig = [view, run.id, stops.map((s) => s.id + '@' + s.start + '-' + s.end + ':' + s.name + ':' + s.hoursToday + ':' + s.website).join(','), run.who.map((p) => p.id).join(','), people().map((p) => p.id + ':' + p.avail.size).join(','), WEATHER.status, WEATHER.place].join('|');
  if (card.dataset.sig === sig) return;
  card.dataset.sig = sig;
  const out = people().filter((p) => run.who.indexOf(p) === -1);
  const cant = out.filter((p) => p.avail.size), pending = out.filter((p) => !p.avail.size);
  card.innerHTML =
    '<header><div class="tiny">' + (locked ? 'You’re all set' : 'Draft · only you see this until you lock it in') + '</div><h2 id="planTitle">' + esc(state.title) + '</h2></header>' +
    '<div class="plan-rows">' +
      '<div class="plan-row"><span class="ico" aria-hidden="true">🗓️</span><div><div class="k">When</div>' +
        '<div class="v">' + dateLong(run.d) + '</div><div class="sub">' + fmtTime(stops[0].start) + ' – ' + fmtTime(stops[stops.length - 1].end) +
          (stops[0].start > run.start || stops[stops.length - 1].end < run.end ? ' · everyone’s free ' + fmtHour(run.start) + '–' + fmtHour(run.end) : '') + '</div></div></div>' +
      (stops.length === 1
        ? '<div class="plan-row"><span class="ico" aria-hidden="true">📍</span><div><div class="k">Where</div>' +
            '<div class="v">' + esc(placeTitle(pl)) + '</div><div class="sub">' + placeDetails(pl) + '</div>' + (locked ? '' : addStopHTML(run)) + '</div></div>'
        : '<div class="plan-row"><span class="ico" aria-hidden="true">📍</span><div><div class="k">Where · ' + stops.length + ' stops</div>' +
            '<ol class="stops">' + stops.map((s) =>
              '<li' + (s.id === justAdded ? ' class="stop-new"' : '') + '><span class="stop-time">' + fmtSpan(s.start, s.end) + '</span>' +
              '<div><div class="v"><span aria-hidden="true">' + s.emoji + '</span> ' + esc(placeTitle(s)) +
                (locked ? '' : '<button type="button" class="stop-remove" data-remove-stop="' + esc(s.id) + '" aria-label="Remove ' + esc(placeTitle(s)) + ' from the plan">✕</button>') + '</div>' +
              '<div class="sub">' + placeDetails(s) + '</div></div></li>').join('') +
            '</ol>' + (locked ? '' : addStopHTML(run)) + '</div></div>') +
      '<div class="plan-row"><span class="ico" aria-hidden="true">👯</span><div><div class="k">Who’s coming · ' + run.who.length + ' of ' + total() + '</div>' +
        '<div class="going">' +
          run.who.map((p) => '<span class="pill">' + avatar(p, 'sm') + esc(displayName(p)) + '</span>').join('') +
          cant.map((p) => '<span class="pill out">' + avatar(p, 'sm') + esc(p.name) + '<span class="sr-only"> can’t make this time</span></span>').join('') +
          pending.map((p) => '<span class="pill pending">' + avatar(p, 'sm') + esc(p.name) + ' · hasn’t replied</span>').join('') +
        '</div></div></div>' +
      weatherRow(run, stops) +
    '</div>' +
    '<div class="plan-actions">' + (locked
      ? '<button type="button" class="btn" id="addCal">📅 Add to calendar</button>' +
        '<button type="button" class="btn ghost" id="copyInvite">Copy invite</button>' +
        (isHost() ? '<button type="button" class="btn ghost" id="unlockPlan">Change plan</button>' : '')
      : total() < MIN_GROUP
        // Plans are for 3+ people: until then, the lock waits and the invite is one tap away.
        ? '<p class="lock-hint">Invite ' + (MIN_GROUP - total()) + ' more ' + (MIN_GROUP - total() === 1 ? 'friend' : 'friends') + ' to lock it in</p>' +
          '<button type="button" class="btn" id="lockPlan" disabled>🔒 Lock it in for everyone</button>' +
          (state.mode === 'live' ? '<button type="button" class="btn ghost" id="copyLinkPlan">Copy invite link</button>' : '')
        : '<button type="button" class="btn" id="lockPlan">🔒 Lock it in for everyone</button>') +
      (state.mode === 'demo' ? '<button type="button" class="btn ghost" id="restart">New plan</button>' : '') +
    '</div>';
  if (locked) {
    $('#addCal').addEventListener('click', () => downloadICS(run, stops));
    $('#copyInvite').addEventListener('click', () => copy(inviteText(run, stops), 'Invite copied — paste it in the group chat'));
    if ($('#unlockPlan')) $('#unlockPlan').addEventListener('click', unlockPlan);
  } else {
    $('#lockPlan').addEventListener('click', () => lockPlan(run, stops));
    if ($('#copyLinkPlan')) $('#copyLinkPlan').addEventListener('click', () => copy(inviteLink(), 'Invite link copied'));
  }
  $('#useLoc').addEventListener('click', useMyLocation);
  if ($('#restart')) $('#restart').addEventListener('click', restart);
}

// "＋ Add a stop: Echo Box Karaoke" — only when the free time fits another stop.
let justAdded = null; // the stop that was just added, so it can slide in
// A small dropdown of every place in the deck (Lepak's suggestion first), only while
// the free time fits another stop.
function addStopHTML(run) {
  const have = planStops(run).map((s) => s.id);
  if (have.length >= maxStops(run.end - run.start)) return '';
  const next = nextStop(run);
  const options = rankPlaces().filter((p) => have.indexOf(p.id) === -1)
    .sort((a, b) => (next && b.id === next.id) - (next && a.id === next.id));
  if (!options.length) return '';
  return '<label class="add-stop"><span class="sr-only">Add another stop</span>' +
    '<select data-add-stop><option value="">+ Add a stop</option>' +
    options.map((p) => '<option value="' + esc(p.id) + '">' + p.emoji + ' ' + esc(placeTitle(p)) + (next && p.id === next.id ? ' (suggested)' : '') + '</option>').join('') +
    '</select></label>';
}

// The host locks the plan in for the whole group (saved on the server in a real group).
async function lockPlan(run, stops) {
  if (!run || !stops.length) return;
  const plan = { date: ymd(DAYS[run.d]), start: run.start, end: run.end, stops: stops.map((s) => s.id) };
  if (state.mode === 'live') {
    try {
      const data = await api('PUT', '/groups/' + encodeURIComponent(state.group.id) + '/plan', { plan: plan });
      state.plan = data.group.plan; // so it isn't announced back to the host as news
      applyState(data, false);
    } catch (e) {
      toast(null, e.message || 'Couldn’t lock it in — try again');
      return;
    }
  } else {
    state.plan = Object.assign({ lockedAt: Date.now() }, plan);
  }
  render(); // shows "All set!" (with confetti)
  toast(null, '🎉 Locked in! Everyone can see the plan now.');
  announce('Plan locked in. Everyone in the group can see it now.');
}
// Reopen it to change something (the draft starts from the locked plan).
async function unlockPlan() {
  const was = state.plan;
  if (state.mode === 'live') {
    try {
      const data = await api('PUT', '/groups/' + encodeURIComponent(state.group.id) + '/plan', { plan: null });
      state.plan = null;
      applyState(data, false);
    } catch (e) {
      toast(null, e.message || 'Couldn’t reopen the plan — try again');
      return;
    }
  }
  state.plan = null;
  state.pickStops = was.stops;
  const r = computeRuns().find((x) => ymd(DAYS[x.d]) === was.date && x.start === was.start && x.end === was.end);
  if (r) state.pickRun = r.id;
  render();
  announce('Plan reopened. Change it, then lock it in again.');
}

// Type, price, area, today's hours and links for one stop.
function placeDetails(pl) {
  return esc([pl.kind, pl.price, pl.dist].concat(pl.tags || []).filter(Boolean).join(' · ')) +
    (pl.hoursToday ? '<br>🕒 Hours: ' + esc(pl.hoursToday) : '') +
    (pl.website ? '<br><a href="' + esc(pl.website) + '" target="_blank" rel="noopener">Quick Search ↗</a>' : '') + '<br>' +
    '<a href="' + esc(googleLink(pl)) + '" target="_blank" rel="noopener">' + (pl.linkLabel || 'Look it up on Google') + ' ↗</a>';
}

export function bindBloom() {
  renderPlanCard();
  if ($('#waitingBox')) $('#waitingBox').addEventListener('click', (e) => {
    if (!e.target.closest('#nudgeBtn')) return;
    const waiting = state.friends.filter((f) => !f.avail.size || votedCount(f) < allPlaces().length);
    copy('Hey ' + waiting.map((f) => f.name).join(' & ') + '! 🛋️ We’re almost done planning “' + state.title + '” — tap to add your times and votes (takes 1 min): ' + inviteLink(),
      'Nudge copied — paste it in the group chat');
  });
  $$('input[name="run"]').forEach((r) => r.addEventListener('change', () => {
    state.pickRun = r.value;
    renderPlanCard();
    $('#stopChoices').innerHTML = stopChoicesHTML();
    const stops = planStops(chosenRun());
    announce('Time changed. The plan has ' + stops.length + (stops.length === 1 ? ' stop.' : ' stops.'));
  }));
  // Swap the main place; any extra stops stay.
  if ($('#stopChoices')) $('#stopChoices').addEventListener('change', (e) => {
    if (e.target.name !== 'stop') return;
    const ids = planStops(chosenRun()).map((s) => s.id).filter((id) => id !== e.target.value);
    state.pickStops = [e.target.value].concat(ids.slice(1));
    renderPlanCard();
    announce('Place changed to ' + placeTitle(planStops(chosenRun()).find((s) => s.id === e.target.value)) + '.');
  });
  // ＋ Add a stop (pick from the dropdown) / ✕ remove one, right on the plan card.
  const changeStops = (e) => {
    const add = e.type === 'change' ? e.target.closest('select[data-add-stop]') : null;
    const del = e.type === 'click' ? e.target.closest('[data-remove-stop]') : null;
    if ((!add || !add.value) && !del) return;
    const ids = planStops(chosenRun()).map((s) => s.id);
    if (add) {
      justAdded = add.value;
      state.pickStops = ids.concat(justAdded);
    } else {
      justAdded = null;
      state.pickStops = ids.filter((id) => id !== del.dataset.removeStop);
    }
    renderPlanCard();
    $('#stopChoices').innerHTML = stopChoicesHTML();
    const now = planStops(chosenRun());
    announce((add ? 'Added a stop. ' : 'Removed a stop. ') + 'The plan: ' + now.map((s) => placeTitle(s) + ' at ' + fmtTime(s.start)).join(', then ') + '.');
    const focus = $('#planCard [data-add-stop]') || $('#planCard .stops li:last-child .stop-remove') || $('#addCal');
    if (focus) focus.focus();
  };
  if ($('#planCard')) {
    $('#planCard').addEventListener('change', changeStops);
    $('#planCard').addEventListener('click', changeStops);
  }
  // Everyone sits down on the couch for the big reveal.
  if (!reduceMotion) {
    $$('.bloom-stage .sitter').forEach((p) => p.style.setProperty('--s', '0'));
    requestAnimationFrame(() => requestAnimationFrame(() => { updateCouch(); }));
    if (bloomView() === 'locked') setTimeout(confetti, 450); // the big reveal
  }
}

export function restart() {
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
  state.pickRun = state.pickStops = state.week = state.plan = null;
  go('home');
}

export function confetti() {
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

export function downloadICS(run, stops) {
  const d = DAYS[run.d];
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (t) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' + pad(Math.floor(t)) + (t % 1 ? '30' : '00') + '00';
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const icsText = (t) => String(t).replace(/\\/g, '\\\\').replace(/[;,]/g, '\\$&').replace(/\r?\n/g, '\\n');
  const who = 'With ' + run.who.map((p) => p.name).join(', ') + '. Planned with Lepak.';
  // One calendar event per stop, so each shows at its own time.
  const events = stops.map((s, i) => [
    'BEGIN:VEVENT', 'UID:' + Date.now() + '-' + i + '@lepak.plan', 'DTSTAMP:' + now,
    'DTSTART:' + stamp(s.start), 'DTEND:' + stamp(s.end),
    'SUMMARY:' + icsText(stops.length === 1 ? state.title : state.title + ' · ' + placeTitle(s)),
    'LOCATION:' + icsText(s.name),
    'DESCRIPTION:' + icsText((stops.length > 1 ? 'Stop ' + (i + 1) + ' of ' + stops.length + '. ' : '') + who),
    'END:VEVENT'].join('\r\n'));
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lepak//Group Plans//EN'].concat(events, ['END:VCALENDAR']).join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url; a.download = slug(state.title) + '.ics';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(null, '📅 Calendar event downloaded');
  announce('Calendar event downloaded.');
}
