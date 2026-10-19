// Step 2: swiping on places and suggesting new ones.
import { $, $$, esc, reduceMotion } from './util.js';
import { allPlaces, commonsImage, commonsPage, currentVotes, FRIEND_VOTES, googleLink, KINDS, PLACES, votedCount } from './data.js';
import { people, state, total } from './state.js';
import { rankPlaces } from './derive.js';
import { announce, avatarStack, buzz, namesList, refresh, sidebarHTML, toast } from './ui.js';
import { go, later } from './router.js';
import { simulateTimes } from './times.js';
import { bindSearch, searchHTML } from './search.js';
import { editButton, openEditor } from './edit.js';
import { api, applyState, saveSoon } from './live.js';
import { updateWeatherEls } from './weather.js';

export function placesHTML() {
  return '<div class="page-top"><div class="page-head"><h1>Where should we go?</h1>' +
      '<p></p></div></div>' +
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
      searchHTML() +
      '<div class="panel"><h2 class="sub-title">Group favourites</h2>' +
        '<ol class="rank-list" id="rankList" aria-live="polite"></ol>' +
      '</div>' +
      '</div>' +
    '</div>' +
  '</section>' + sidebarHTML() + '</div>' +
  '<div class="actionbar"><button type="button" class="btn ghost small" id="undoVote">↶ Undo</button>' +
    '<p class="ab-status" id="toBloomHint"></p>' +
    '<button type="button" class="btn" id="toBloom">See the plan bloom →</button></div>';
}

export function cardHTML(pl, depth) {
  const top = depth === 0;
  const photo = pl.photoUrl ? { src: pl.photoUrl, credit: pl.photoCredit, href: pl.photoCreditUrl }
    : pl.photo ? { src: commonsImage(pl.photo), credit: 'Photo: Wikimedia Commons', href: commonsPage(pl.photo) } : {};
  return '<article class="card" data-id="' + pl.id + '" data-depth="' + depth + '" style="--depth:' + depth + ';--hue:' + pl.hue + '"' +
    (top ? ' tabindex="0" aria-label="' + esc([pl.name, pl.kind, pl.price, pl.dist].filter(Boolean).join(', ') + '. ' + pl.blurb + ' ' + pl.tags.join(', ')) + '"' : ' aria-hidden="true"') + '>' +
    '<span class="stamp yes" aria-hidden="true">LOVE IT</span><span class="stamp no" aria-hidden="true">PASS</span><span class="stamp maybe" aria-hidden="true">MAYBE</span>' +
    // Photo on top of a coloured gradient + emoji, which shows if the photo can't load.
    '<div class="card-art"><span aria-hidden="true">' + pl.emoji + '</span>' +
      (photo.src ? '<img class="card-photo" src="' + esc(photo.src) + '" alt="" loading="lazy" draggable="false">' +
        (photo.href ? '<a class="photo-credit" href="' + esc(photo.href) + '" target="_blank" rel="noopener"' + (top ? '' : ' tabindex="-1"') + '>' + esc(photo.credit) + '<span class="sr-only"> (opens in a new tab)</span></a>'
          : '<span class="photo-credit">' + esc(photo.credit) + '</span>')
        : pl.map ? mapHTML(pl.map, top) : '') +
      '<span class="kind">' + esc(pl.kind) + '</span></div>' +
    '<div class="card-body"><h3 style="font-size:' + Math.max(18, 24 - Math.max(0, pl.name.length - 35) * 0.12) + 'px">' + esc(pl.name) + '</h3>' +
      (pl.price || pl.dist ? '<div class="meta">' + [pl.price, pl.dist].filter(Boolean).map((t) => '<span>' + esc(t) + '</span>').join('') + '</div>' : '') +
      (pl.blurb ? '<p class="blurb">' + esc(pl.blurb) + '</p>' : '') +
      (pl.suggestedBy ? '<p class="by">' + esc(pl.suggestedBy) + '</p>' : '') +
      (pl.hoursToday ? '<p class="hours">🕒 Hours: ' + esc(pl.hoursToday) + '</p>' : '') +

      '<div class="meta-row">' +
        (pl.tags.length ? '<div class="tags">' + pl.tags.map((t) => '<span class="tag">' + (t === 'Step-free' ? '♿ ' : '') + esc(t) + '</span>').join('') + '</div>' : '') +
        (pl.website ? '<a class="g-link" href="' + esc(pl.website) + '" target="_blank" rel="noopener"' + (top ? '' : ' tabindex="-1"') + '>Quick link <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a>' : '') +
        '<a class="g-link" href="' + esc(googleLink(pl)) + '" target="_blank" rel="noopener"' + (top ? '' : ' tabindex="-1"') + '>' + (pl.linkLabel || 'Look it up on Google') + ' <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a>' +
      '</div>' +
      (pl.outdoor ? '<div class="wx" data-wx hidden></div>' : '') +
      '<div class="card-footer"><div class="card-friends" data-friends="' + pl.id + '"></div>' +
      (pl.custom ? editButton(state.custom.find((x) => x.id === pl.id), pl.name) : '') + '</div>' +
    '</div></article>';
}

// A small street map centred on the exact spot (OpenStreetMap tiles, free).
// 3×2 tiles are laid out so the place sits in the middle, under a pin.
export function mapHTML(pt, top) {
  const z = 17, n = Math.pow(2, z);
  const fx = (pt.lon + 180) / 360 * n;
  const lat = pt.lat * Math.PI / 180;
  const fy = (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * n;
  const tx = Math.floor(fx), ty = Math.floor(fy);
  const ox = (fx - tx) * 256, oy = (fy - ty) * 256; // where the place is inside its tile
  let tiles = '';
  for (let dy = -1; dy <= 0; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      tiles += '<img src="https://tile.openstreetmap.org/' + z + '/' + (tx + dx) + '/' + (ty + dy + (oy > 128 ? 1 : 0)) + '.png" alt="" loading="lazy" draggable="false" ' +
        'style="left:' + ((dx + 1) * 256) + 'px;top:' + ((dy + 1) * 256) + 'px">';
    }
  }
  // Shift the tile block so the place lands in the centre of the card art.
  const px = 256 + ox, py = (oy > 128 ? oy - 256 : oy) + 256;
  return '<div class="card-map" style="--px:' + px + 'px;--py:' + py + 'px">' + tiles + '</div>' +
    '<span class="map-pin" aria-hidden="true">📍</span>' +
    '<a class="photo-credit" href="https://www.openstreetmap.org/?mlat=' + pt.lat + '&mlon=' + pt.lon + '#map=18/' + pt.lat + '/' + pt.lon + '" target="_blank" rel="noopener"' + (top ? '' : ' tabindex="-1"') +
    '>Map © OpenStreetMap<span class="sr-only"> (opens in a new tab)</span></a>';
}

export function renderDeck() {
  const deck = $('#deck');
  if (!deck) return;
  const rest = allPlaces().slice(state.deckIndex);
  $$('#voteBtns button').forEach((b) => { b.disabled = !rest.length; });
  if (!rest.length) {
    deck.innerHTML = allPlaces().length
      ? '<div class="deck-done"><div class="big" aria-hidden="true">✓</div><h3>All swiped!</h3><p class="empty">Check the group favourites, then see your plan bloom. New ideas from friends will pop up here.</p></div>'
      : '<div class="deck-done"><div class="big" aria-hidden="true">💡</div><h3>No ideas yet</h3><p class="empty">Add the first place or activity in <strong>Got another idea?</strong> — everyone in the group will be able to swipe on it.</p></div>';
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
  $$('#deck .card-photo').forEach((img) => img.addEventListener('error', () => img.remove()));
  bindDrag(deck.querySelector('.card[data-depth="0"]'));
}

export function updateCardFriends() {
  $$('[data-friends]').forEach((el) => {
    const id = el.dataset.friends;
    const yes = state.friends.filter((f) => f.votes[id] === 1);
    el.innerHTML = yes.length ? avatarStack(yes) + '<span>' + esc(namesList(yes)) + (yes.length === 1 ? ' loves' : ' love') + ' this</span>' : '<span>Be the first to vote on this one</span>';
  });
}

export function bindDrag(card) {
  if (!card) return;
  let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false;
  const yes = card.querySelector('.stamp.yes'), no = card.querySelector('.stamp.no'), maybe = card.querySelector('.stamp.maybe');
  card.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || e.target.closest('a, button')) return; // let links and buttons be clicked
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

export let voting = false;
export let dragActive = false;
export function vote(v) {
  if (voting || state.deckIndex >= allPlaces().length) return;
  voting = true;
  const pl = allPlaces()[state.deckIndex];
  const card = $('#deck .card[data-depth="0"]');
  state.me.votes[pl.id] = v;
  if (state.mode === 'live') saveSoon({ votes: currentVotes(state.me) });
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

export function undoVote() {
  if (voting) return;
  const lastIdx = (state.deckIndex >= allPlaces().length ? allPlaces().length : state.deckIndex) - 1;
  const pl = allPlaces()[lastIdx];
  if (!pl || !(pl.id in state.me.votes)) return;
  delete state.me.votes[pl.id];
  if (state.mode === 'live') saveSoon({ votes: currentVotes(state.me) });
  state.deckIndex = lastIdx;
  renderDeck();
  refresh();
  announce('Undone. ' + pl.name + ' is back on top.');
  const top = $('#deck .card[data-depth="0"]');
  if (top) top.focus({ preventScroll: true });
}

// Look the idea up, then ALWAYS ask the person to confirm which place they mean
// (e.g. which Din Tai Fung branch), so nothing wrong sneaks into the deck.
// Add a place to the deck. `details` = what the search or link preview found (or null for "as typed").
export async function saveSuggestion(name, kind, _unused, details) {
  const err = $('#sgError');
  let label = (name || '').trim();
  if (!label) { if (err) err.textContent = 'Type a place or idea first.'; return; }
  if (details && details.source === 'manual' && details.area) {
    const branch = ' (' + details.area + ')';
    label += branch;
  }
  if (allPlaces().some((p) => p.name.toLowerCase() === label.toLowerCase())) { if (err) err.textContent = '“' + label + '” is already in the deck.'; return; }
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
  return true;
}

export function renderRanking() {
  const ol = $('#rankList');
  if (!ol) return;
  const ranked = rankPlaces().filter((p) => p.voters);
  if (!ranked.length) {
    ol.innerHTML = '<li class="empty" style="display:block">Votes will appear here as people swipe.</li>';
  } else {
    ol.innerHTML = ranked.map((p) =>
      '<li><span class="emoji" aria-hidden="true">' + p.emoji + '</span>' +
      '<div><div class="name">' + esc(p.name) + (p.custom ? ' ' + editButton(state.custom.find((x) => x.id === p.id), p.name) : '') + '</div>' +
      '<div class="bar" aria-hidden="true"><i style="--w:' + Math.round((p.points / (2 * total())) * 100) + '%"></i></div>' +
      '<span class="sr-only">' + p.yes.length + ' yes, ' + p.maybe.length + ' maybe, ' + p.no.length + ' no.</span></div>' +
      avatarStack(p.yes) + '</li>').join('');
  }
  const btn = $('#toBloom'), hint = $('#toBloomHint');
  if (btn) {
    const count = allPlaces().length;
    const done = votedCount(state.me);
    const left = count - done;
    btn.disabled = !count || left > 0;
    hint.innerHTML = !count ? '<span>💡 Add the first idea to get the deck going</span>'
      : '<span class="ab-progress" aria-hidden="true"><i style="--w:' + Math.round(done / count * 100) + '%"></i></span>' +
        '<span>' + (left > 0 ? done + ' of ' + count + ' swiped' + (done && left <= 2 ? ' — almost there!' : '') : '✓ All swiped — ready when you are') + '</span>';
    const undo = $('#undoVote');
    if (undo) undo.disabled = !done;
  }
}

export function bindPlaces() {
  renderDeck();
  renderRanking();
  // ✏️ Edit buttons on cards and in Group favourites
  ['#deck', '#rankList'].forEach((sel) => $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]');
    if (b) openEditor(b.dataset.edit);
  }));
  $('#voteBtns').addEventListener('click', (e) => {
    const b = e.target.closest('[data-vote]');
    if (b) vote(+b.dataset.vote);
  });
  $('#toBloom').addEventListener('click', () => go('bloom'));
  $('#undoVote').addEventListener('click', undoVote);
  bindSearch();
  simulateTimes(); // in case someone jumps straight here
  simulateVotes();
}

export function initPlaces() {
  // Arrow keys vote on the top card (outside text fields and the time grid).
  document.addEventListener('keydown', (e) => {
    if (state.step !== 'places') return;
    if (e.target.matches && e.target.matches('input, textarea')) return;
    if (e.target.closest && e.target.closest('#grid')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); vote(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); vote(-1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); vote(0); }
  });
}

export function simulateVotes() {
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
