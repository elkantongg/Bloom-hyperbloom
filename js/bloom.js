// Step 3: the final plan card, calendar file and nudges.
import { $, $$, esc, reduceMotion, store } from './util.js';
import { dateLong, DAYS, dayShort, fmtHour, fmtRange, setWeek } from './dates.js';
import { allPlaces, googleLink, votedCount } from './data.js';
import { FRIENDS, people, state, total } from './state.js';
import { bloomScore, chosenPlace, chosenRun, computeRuns, rankPlaces } from './derive.js';
import { announce, avatar, avatarStack, copy, displayName, flowerSVG, namesList, toast, updateFlowers } from './ui.js';
import { clearTimers, go } from './router.js';
import { slug } from './times.js';
import { invite, inviteLink, stopSync } from './live.js';
import { useMyLocation, WEATHER, weatherAt, wxText } from './weather.js';

export function bloomHTML() {
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
export function tieHTML() {
  const r = rankPlaces();
  if (r.length < 2 || !r[0].voters) return '';
  const same = (a, b) => a.points === b.points && a.yes.length === b.yes.length && a.no.length === b.no.length;
  const tied = r.filter((p) => same(p, r[0]));
  if (tied.length < 2) return '';
  return '<p class="tie-note">🤝 It’s a tie between ' + esc(tied.map((p) => p.name).join(' and ')) +
    '. We picked one — use <strong>Change the time or place</strong> to swap.</p>';
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

export function weatherRow(run, pl) {
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

export function renderPlanCard() {
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
        '<a href="' + googleLink(pl) + '" target="_blank" rel="noopener">' + (pl.link ? 'Open in Google Maps' : 'Look it up on Google') + ' ↗</a></div></div></div>' +
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

export function bindBloom() {
  renderPlanCard();
  $('#waitingBox').addEventListener('click', (e) => {
    if (!e.target.closest('#nudgeBtn')) return;
    const waiting = state.friends.filter((f) => !f.avail.size || votedCount(f) < allPlaces().length);
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
  state.pickRun = state.pickPlace = null;
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

export function downloadICS(run, pl) {
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
