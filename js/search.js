// "Got another idea?": a Maps-style place search.
// Pick a type, type a name (typos are fine) and choose from the suggestions, see a preview
// of that exact place, then add it to everyone's deck. If a place can't be found,
// paste a link instead and we build the card from that page.
import { $, esc } from './util.js';
import { commonsImage, KINDS, todaysHours } from './data.js';
import { announce } from './ui.js';
import { saveSuggestion } from './places.js';

let session = '';      // groups keystrokes + the final details call (matters for Google billing)
let timer = null;
let seq = 0;           // ignore slow responses for older keystrokes
let results = [];
let approx = false;
let active = -1;
let preview = null;

const newSession = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
const kind = () => ($('#gsKind') || {}).value || 'food';

export function searchHTML() {
  return '<div class="panel suggest" id="gSearch">' +
    '<h2 class="sub-title">Got another idea?</h2>' +
    '<p class="suggest-sub">Pick a type, search it, add it.</p>' +
    '<div class="gs-row">' +
      '<label class="sr-only" for="gsKind">Type of place</label>' +
      '<select id="gsKind">' + Object.keys(KINDS).map((k) => '<option value="' + k + '">' + KINDS[k].emoji + ' ' + KINDS[k].label + '</option>').join('') + '</select>' +
      '<div class="gs-box">' +
        '<label class="sr-only" for="gsInput">Search for a place</label>' +
        '<input id="gsInput" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="gsList" ' +
          'autocomplete="off" maxlength="80" placeholder="e.g. Din Tai Fung Tampines">' +
        '<ul id="gsList" class="gs-list" role="listbox" aria-label="Matching places" hidden></ul>' +
      '</div>' +
    '</div>' +
    '<details class="gs-link" id="gsLinkBox"><summary>Can’t find it? Add a link instead</summary>' +
      '<form id="gsLinkForm" class="gs-row" novalidate>' +
        '<label class="sr-only" for="gsLink">Link to the place or activity</label>' +
        '<input id="gsLink" type="url" inputmode="url" maxlength="500" placeholder="Paste a website, Klook or Google Maps link">' +
        '<button type="submit" class="btn small">Preview</button>' +
      '</form>' +
    '</details>' +
    '<p class="form-error" id="sgError" role="alert"></p>' +
    '<div id="gsPreview" class="gs-preview" aria-live="polite" hidden></div>' +
  '</div>';
}

export function bindSearch() {
  const input = $('#gsInput');
  if (!input) return;
  session = newSession();
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(fetchSuggestions, 220); });
  input.addEventListener('keydown', onKey);
  input.addEventListener('focus', () => { if (results.length) renderList(); });
  input.addEventListener('blur', () => setTimeout(closeList, 150));
  $('#gsKind').addEventListener('change', () => { if (input.value.trim().length >= 2) fetchSuggestions(); });
  $('#gsList').addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-i]');
    if (!li) return;
    e.preventDefault(); // keep focus in the box
    choose(+li.dataset.i);
  });
  $('#gsLinkForm').addEventListener('submit', (e) => { e.preventDefault(); previewLink(); });
}

async function fetchSuggestions() {
  const q = $('#gsInput').value.trim();
  const mine = ++seq;
  $('#sgError').textContent = '';
  if (q.length < 2) { results = []; closeList(); return; }
  try {
    const res = await fetch('/api/places/autocomplete?q=' + encodeURIComponent(q) + '&kind=' + kind() + '&session=' + encodeURIComponent(session));
    const data = await res.json();
    if (mine !== seq) return;
    results = res.ok ? data.results || [] : [];
    approx = !!data.approximate;
    if (!res.ok) $('#sgError').textContent = data.error || 'Search isn’t available right now.';
  } catch (e) {
    if (mine !== seq) return;
    results = []; // no server (or offline): "add as typed" and links still work
  }
  active = -1;
  renderList();
}

function renderList() {
  const list = $('#gsList'), input = $('#gsInput');
  const q = input.value.trim();
  if (q.length < 2) return closeList();
  const typeName = (KINDS[kind()] || KINDS.other).label.toLowerCase();
  const head = !results.length
    ? '<li class="gs-note" role="presentation">No ' + esc(kind() === 'other' ? '' : typeName + ' ') + 'places called “' + esc(q) + '” on the map. Try another type, add the area, or use a link below.</li>'
    : approx ? '<li class="gs-note" role="presentation">No exact match — closest places:</li>' : '';
  const items = results.map((r, i) =>
    '<li role="option" id="gs-' + i + '" data-i="' + i + '" aria-selected="' + (i === active) + '">' +
      '<span class="gs-icon" aria-hidden="true">📍</span>' +
      '<span><strong>' + esc(r.main || '') + '</strong>' +
      '<small>' + esc([r.category, r.secondary].filter(Boolean).join(' · ')) + '</small></span></li>');
  items.push('<li role="option" id="gs-typed" data-i="-1" class="gs-typed" aria-selected="' + (active === results.length) + '">' +
    '<span class="gs-icon" aria-hidden="true">✏️</span>' +
    '<span><strong>Add “' + esc(q) + '” as typed</strong><small>' + esc((KINDS[kind()] || KINDS.other).label) + ' · without map details</small></span></li>');
  list.innerHTML = head + items.join('');
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  const id = active < 0 ? '' : active === results.length ? 'gs-typed' : 'gs-' + active;
  if (id) input.setAttribute('aria-activedescendant', id); else input.removeAttribute('aria-activedescendant');
}

function closeList() {
  const list = $('#gsList'), input = $('#gsInput');
  if (list) list.hidden = true;
  if (input) { input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
}

function onKey(e) {
  const n = results.length + 1; // + "add as typed"
  if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % n; renderList(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + n) % n; renderList(); }
  else if (e.key === 'Escape') closeList();
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (active >= 0) choose(active === results.length ? -1 : active);
    else if (results.length) choose(0);
  }
}

async function choose(i) {
  closeList();
  const q = $('#gsInput').value.trim();
  if (i < 0) {
    await saveSuggestion(q, kind(), null);
    return reset();
  }
  const r = results[i];
  await loadPreview('/api/places/details?id=' + encodeURIComponent(r.placeId) + '&session=' + encodeURIComponent(session), r.main);
  session = newSession(); // the details call closes this search session
}

async function previewLink() {
  const url = $('#gsLink').value.trim();
  $('#sgError').textContent = '';
  if (!url) { $('#sgError').textContent = 'Paste a link first.'; $('#gsLink').focus(); return; }
  await loadPreview('/api/link-preview?url=' + encodeURIComponent(url), 'that link', url);
}

async function loadPreview(endpoint, label, link) {
  const box = $('#gsPreview');
  box.hidden = false;
  box.innerHTML = '<p class="empty">Loading ' + esc(label || 'place') + '…</p>';
  try {
    const res = await fetch(endpoint);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Couldn’t load that');
    preview = data.place;
    renderPreview();
  } catch (ex) {
    // A link that can't be read can still be added — friends can open it themselves.
    box.innerHTML = '<p class="form-error">' + esc(ex.message) + '</p>' +
      (link ? '<div class="gs-actions"><button type="button" class="btn small" id="gsAddRaw">＋ Add with just the link</button></div>' : '');
    const raw = $('#gsAddRaw');
    if (raw) raw.addEventListener('click', async () => {
      const full = /^https?:\/\//.test(link) ? link : 'https://' + link;
      let host = full;
      try { host = new URL(full).hostname.replace(/^www\./, ''); } catch (e) { /* keep as typed */ }
      await saveSuggestion(host, kind(), null, { source: 'link', name: host, website: full, siteName: host });
      reset();
    });
  }
}

// "Best Tourist Attraction in Singapore | The Mandai Wildlife Reserve" -> the first part, max 40 chars.
function shortTitle(t) {
  const first = String(t || '').split(/\s[|\-–—·:]\s/)[0].trim();
  return (first || String(t || '')).slice(0, 40);
}

function photoFor(p) {
  if (p.photoRef) return '/api/places/photo?name=' + encodeURIComponent(p.photoRef);
  if (p.photo) return commonsImage(p.photo);
  if (p.image) return p.image;
  return '';
}

function renderPreview() {
  const p = preview, box = $('#gsPreview');
  const facts = [
    p.category, p.price,
    p.rating ? '⭐ ' + Number(p.rating).toFixed(1) + (p.reviews ? ' (' + Number(p.reviews).toLocaleString() + ')' : '') : '',
    p.openNow === true ? 'Open now' : p.openNow === false ? 'Closed now' : '',
    p.source === 'link' ? p.siteName : '',
  ].filter(Boolean);
  const today = todaysHours(p.hours);
  const src = photoFor(p);
  box.innerHTML =
    (src ? '<img class="gs-photo" src="' + esc(src) + '" alt="Photo of ' + esc(p.name || '') + '">' : '') +
    '<div class="gs-info">' +
      (p.source === 'link'
        // Page titles are often long ("Best Tourist Attraction in Singapore | ..."), so let people fix the name.
        ? '<label class="gs-name-label" for="gsName">Name on the card</label><input id="gsName" maxlength="40" value="' + esc(shortTitle(p.name)) + '">'
        : '<strong>' + esc(p.name || '') + '</strong>') +
      (facts.length ? '<span>' + esc(facts.join(' · ')) + '</span>' : '') +
      (p.address ? '<span>' + esc(p.address) + '</span>' : '') +
      (p.description ? '<span>' + esc(p.description) + '</span>' : '') +
      (p.partial ? '<span class="gs-partial">This site doesn’t let apps read it, so we guessed the name from the link — check it, and add details later with ✏️ Edit.</span>' : '') +
      (today ? '<span>🕒 Today: ' + esc(today) + '</span>' : '') +
    '</div>' +
    '<div class="gs-actions"><button type="button" class="btn small" id="gsAdd">＋ Add to deck</button>' +
      '<button type="button" class="btn small ghost" id="gsCancel">Cancel</button></div>';
  const img = box.querySelector('.gs-photo');
  if (img) img.addEventListener('error', () => img.remove());
  $('#gsAdd').addEventListener('click', async () => {
    // Free results can share a name across branches, so add the area: "Din Tai Fung (Tampines)".
    const typed = $('#gsName') ? $('#gsName').value.trim() : '';
    const label = typed || (p.source === 'osm' && p.area ? p.name + ' (' + p.area + ')' : p.name);
    // The type picked in the dropdown wins; otherwise use what the map says.
    const k = kind() !== 'other' ? kind() : p.kind || 'other';
    await saveSuggestion(label || $('#gsInput').value.trim(), k, null, p);
    reset();
  });
  $('#gsCancel').addEventListener('click', reset);
  ($('#gsName') || $('#gsAdd')).focus();
  announce((p.name || 'Place') + '. ' + facts.join(', ') + '. Press Add to deck to add it.');
}

function reset() {
  preview = null;
  results = [];
  const box = $('#gsPreview');
  if (box) { box.hidden = true; box.innerHTML = ''; }
  const link = $('#gsLink');
  if (link) link.value = '';
  const input = $('#gsInput');
  if (input) { input.value = ''; input.focus(); }
}
