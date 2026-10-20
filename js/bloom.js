// Step 3: the final plan card, calendar file and nudges.
import { $, $$, esc, reduceMotion, store } from './util.js';
import { dateLong, DAYS, dayShort, fmtHour, fmtRange, setWeek } from './dates.js';
import { allPlaces, googleLink, placeTitle, votedCount } from './data.js';
import { FRIENDS, people, state, total } from './state.js';
import { bloomScore, chosenRun, computeRuns, maxStops, planStops, rankPlaces } from './derive.js';
import { announce, avatar, avatarStack, copy, displayName, flowerSVG, namesList, toast, updateFlowers } from './ui.js';
import { clearTimers, go } from './router.js';
import { slug } from './times.js';
import { invite, inviteLink, stopSync } from './live.js';
import { useMyLocation, WEATHER, weatherAt, wxIcon } from './weather.js';

export function bloomHTML() {
  const score = bloomScore();
  const runs = computeRuns().filter((r) => r.who.includes(state.me)).slice(0, 3);
  if (!runs.find((r) => r.id === state.pickRun)) state.pickRun = runs[0] ? runs[0].id : null;

  return '<section class="bloom-stage">' +
    '<div><div>' + flowerSVG({ stem: true }) + '</div>' +
      '<h1 class="bloom-title">' + (score >= 80 ? 'It’s a plan! 🌸' : score >= 50 ? 'Almost in bloom 🌷' : 'Still budding 🌱') + '</h1>' +
      '<p class="bloom-sub"><strong data-bloom-score>' + score + '%</strong> in bloom · ' +
        (score >= 80 ? 'Everyone’s on board.' : 'A few people are still deciding — you can lock it in anyway.') + '</p>' +
      tieHTML() +
      '<div id="waitingBox">' + waitingHTML() + '</div>' +
    '</div>' +
    '<div><article class="plan-card" id="planCard" aria-labelledby="planTitle"></article>' +
      '<details class="tweak"><summary>Change the time or stops</summary>' +
        '<fieldset class="choice-group"><legend>Time</legend><div class="choices">' +
          runs.map((r) => '<label><input type="radio" name="run" value="' + r.id + '"' + (r.id === state.pickRun ? ' checked' : '') + '>' +
            dayShort(r.d) + ' ' + fmtRange(r.start, r.end) + ' · ' + r.who.length + '/' + total() + '</label>').join('') +
        '</div></fieldset>' +
        '<div id="stopChoices">' + stopChoicesHTML() + '</div>' +
      '</details>' +
    '</div>' +
  '</section>';
}

// Still level after every tie-break? Say so, and let the group pick.
export function tieHTML() {
  const r = rankPlaces();
  if (r.length < 2 || !r[0].voters) return '';
  const same = (a, b) => a.points === b.points && a.yes.length === b.yes.length && a.no.length === b.no.length;
  const tied = r.filter((p) => same(p, r[0]));
  if (tied.length < 2) return '';
  // A long plan may already include every tied place, so there's nothing to break.
  const inPlan = planStops(chosenRun()).map((s) => s.id);
  if (tied.every((p) => inPlan.indexOf(p.id) !== -1)) return '';
  return '<p class="tie-note">🤝 It’s a tie between ' + esc(tied.map(placeTitle).join(' and ')) +
    '. We picked one — use <strong>Change the time or stops</strong> to swap.</p>';
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

// Which favourites can be stops, and how many fit in this time.
export function stopChoicesHTML() {
  const run = chosenRun();
  if (!run) return '';
  const max = maxStops(run.end - run.start);
  const chosen = planStops(run).map((s) => s.id);
  const hours = run.end - run.start;
  return '<fieldset class="choice-group"><legend>' + (max === 1
      ? 'Place · ' + hours + (hours === 1 ? ' hour' : ' hours') + ' fits one stop'
      : 'Stops · ' + hours + ' hours fits up to ' + max) + '</legend><div class="choices">' +
    rankPlaces().slice(0, 6).map((p) => '<label><input type="' + (max === 1 ? 'radio' : 'checkbox') + '" name="stop" value="' + p.id + '"' +
      (chosen.indexOf(p.id) !== -1 ? ' checked' : '') + '>' + p.emoji + ' ' + esc(placeTitle(p)) + '</label>').join('') +
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
    '🌸 ' + state.title + ' — it’s a plan!',
    '🗓️ ' + dateLong(run.d) + ', ' + fmtSpan(run.start, stops[stops.length - 1].end),
  ].concat(where, [
    '👯 ' + run.who.map((p) => p.name).join(', ') + (out.length ? ' (' + out.map((p) => p.name).join(', ') + ' can’t make it)' : ''),
  ]);
  if (state.mode === 'live') lines.push('Plan with us on Bloom: ' + inviteLink());
  return lines.join('\n');
}

export function renderPlanCard() {
  const run = computeRuns().find((r) => r.id === state.pickRun) || chosenRun();
  const stops = planStops(run);
  const pl = stops[0];
  const card = $('#planCard');
  if (!card) return;
  if (!run) {
    card.innerHTML = '<div class="plan-rows"><p class="empty" style="padding:20px 0">Paint at least one free hour so Bloom can find a time. <a class="link-btn" href="#/times">Add your times</a></p></div>';
    return;
  }
  if (!pl) {
    card.innerHTML = '<div class="plan-rows"><p class="empty" style="padding:20px 0">Add a place to swipe on so Bloom can plan where to go. <a class="link-btn" href="#/places">Pick places</a></p></div>';
    return;
  }
  const sig = [run.id, stops.map((s) => s.id + '@' + s.start + '-' + s.end + ':' + s.name + ':' + s.hoursToday + ':' + s.website).join(','), run.who.map((p) => p.id).join(','), people().map((p) => p.id + ':' + p.avail.size).join(','), WEATHER.status, WEATHER.place].join('|');
  if (card.dataset.sig === sig) return;
  card.dataset.sig = sig;
  const out = people().filter((p) => run.who.indexOf(p) === -1);
  const cant = out.filter((p) => p.avail.size), pending = out.filter((p) => !p.avail.size);
  card.innerHTML =
    '<header><div class="tiny">You’re all set</div><h2 id="planTitle">' + esc(state.title) + '</h2></header>' +
    '<div class="plan-rows">' +
      '<div class="plan-row"><span class="ico" aria-hidden="true">🗓️</span><div><div class="k">When</div>' +
        '<div class="v">' + dateLong(run.d) + '</div><div class="sub">' + fmtTime(run.start) + ' – ' + fmtTime(stops[stops.length - 1].end) +
          (stops[stops.length - 1].end < run.end ? ' · everyone’s free till ' + fmtHour(run.end) : '') + '</div></div></div>' +
      (stops.length === 1
        ? '<div class="plan-row"><span class="ico" aria-hidden="true">' + pl.emoji + '</span><div><div class="k">Where</div>' +
            '<div class="v">' + esc(placeTitle(pl)) + '</div><div class="sub">' + placeDetails(pl) + '</div></div></div>'
        : '<div class="plan-row"><span class="ico" aria-hidden="true">🧭</span><div><div class="k">The plan · ' + stops.length + ' stops</div>' +
            '<ol class="stops">' + stops.map((s) =>
              '<li><span class="stop-time">' + fmtSpan(s.start, s.end) + '</span>' +
              '<div><div class="v"><span aria-hidden="true">' + s.emoji + '</span> ' + esc(placeTitle(s)) + '</div>' +
              '<div class="sub">' + placeDetails(s) + '</div></div></li>').join('') +
            '</ol></div></div>') +
      weatherRow(run, stops) +
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
  $('#addCal').addEventListener('click', () => downloadICS(run, stops));
  $('#useLoc').addEventListener('click', useMyLocation);
  $('#copyInvite').addEventListener('click', () => copy(inviteText(run, stops), 'Invite copied — paste it in the group chat'));
  $('#restart').addEventListener('click', restart);
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
  $('#waitingBox').addEventListener('click', (e) => {
    if (!e.target.closest('#nudgeBtn')) return;
    const waiting = state.friends.filter((f) => !f.avail.size || votedCount(f) < allPlaces().length);
    copy('Hey ' + waiting.map((f) => f.name).join(' & ') + '! 🌸 We’re almost done planning “' + state.title + '” — tap to add your times and votes (takes 1 min): ' + inviteLink(),
      'Nudge copied — paste it in the group chat');
  });
  $$('input[name="run"]').forEach((r) => r.addEventListener('change', () => {
    state.pickRun = r.value;
    $('#stopChoices').innerHTML = stopChoicesHTML(); // a longer or shorter time fits more or fewer stops
    renderPlanCard();
    const stops = planStops(chosenRun());
    announce('Time changed. The plan has ' + stops.length + (stops.length === 1 ? ' stop.' : ' stops.'));
  }));
  $('#stopChoices').addEventListener('change', (e) => {
    if (e.target.name !== 'stop') return;
    const run = chosenRun();
    const max = maxStops(run.end - run.start);
    const picked = $$('#stopChoices input[name="stop"]:checked').map((i) => i.value);
    if (picked.length > max) {
      e.target.checked = false;
      return announce('This time fits up to ' + max + ' stops. Untick one first.');
    }
    if (!picked.length) {
      e.target.checked = true;
      return announce('Keep at least one stop.');
    }
    state.pickStops = picked;
    renderPlanCard();
    announce('Plan updated: ' + planStops(run).map((s) => placeTitle(s)).join(', then ') + '.');
  });
  // Let the flower open from a bud for the big reveal.
  if (!reduceMotion) {
    $$('.bloom-stage .petal').forEach((p) => p.style.setProperty('--s', '0.1'));
    requestAnimationFrame(() => requestAnimationFrame(() => { updateFlowers(); }));
    if (bloomScore() >= 80) setTimeout(confetti, 450);
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
  state.pickRun = state.pickStops = null;
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
  const who = 'With ' + run.who.map((p) => p.name).join(', ') + '. Planned with Bloom.';
  // One calendar event per stop, so each shows at its own time.
  const events = stops.map((s, i) => [
    'BEGIN:VEVENT', 'UID:' + Date.now() + '-' + i + '@bloom.plan', 'DTSTAMP:' + now,
    'DTSTART:' + stamp(s.start), 'DTEND:' + stamp(s.end),
    'SUMMARY:' + icsText(stops.length === 1 ? state.title : state.title + ' · ' + placeTitle(s)),
    'LOCATION:' + icsText(s.name),
    'DESCRIPTION:' + icsText((stops.length > 1 ? 'Stop ' + (i + 1) + ' of ' + stops.length + '. ' : '') + who),
    'END:VEVENT'].join('\r\n'));
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bloom//Group Plans//EN'].concat(events, ['END:VCALENDAR']).join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url; a.download = slug(state.title) + '.ics';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(null, '📅 Calendar event downloaded');
  announce('Calendar event downloaded.');
}
