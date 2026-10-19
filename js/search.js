// Google Maps-style place search: suggestions as you type (with typo correction),
// a preview of the exact place with its real photo, then "Add to deck".
// Only used when the server has a Google Places key; otherwise places.js uses the free map search.
import { $, esc } from './util.js';
import { commonsImage, todaysHours } from './data.js';
import { announce } from './ui.js';
import { saveSuggestion } from './places.js';

let session = '';      // groups keystrokes + the final details call into one Google billing session
let timer = null;
let seq = 0;           // ignore slow responses for older keystrokes
let results = [];
let active = -1;
let preview = null;

const newSession = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));

export function searchHTML() {
  return '<div class="panel suggest" id="gSearch">' +
    '<h2 class="sub-title">Got another idea?</h2>' +
    '<p class="suggest-sub">Search any place like on Google Maps — a restaurant branch, a beach, an activity — and add it to everyone’s deck.</p>' +
    '<div class="gs-box">' +
      '<label class="sr-only" for="gsInput">Search for a place</label>' +
      '<input id="gsInput" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="gsList" ' +
        'autocomplete="off" maxlength="80" placeholder="Search places, e.g. Din Tai Fung Tampines">' +
      '<ul id="gsList" class="gs-list" role="listbox" aria-label="Matching places" hidden></ul>' +
    '</div>' +
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
  input.addEventListener('blur', () => setTimeout(closeList, 150));
  $('#gsList').addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-i]');
    if (!li) return;
    e.preventDefault(); // keep focus in the box
    choose(+li.dataset.i);
  });
}

async function fetchSuggestions() {
  const q = $('#gsInput').value.trim();
  const mine = ++seq;
  $('#sgError').textContent = '';
  if (q.length < 2) { results = []; closeList(); return; }
  try {
    const res = await fetch('/api/places/autocomplete?q=' + encodeURIComponent(q) + '&session=' + encodeURIComponent(session));
    const data = await res.json();
    if (mine !== seq) return;
    results = res.ok ? data.results || [] : [];
    if (!res.ok) $('#sgError').textContent = data.error || 'Search isn’t available right now.';
  } catch (e) {
    if (mine !== seq) return;
    results = [];
  }
  active = -1;
  renderList();
}

function renderList() {
  const list = $('#gsList'), input = $('#gsInput');
  const q = input.value.trim();
  if (q.length < 2) return closeList();
  const items = results.map((r, i) =>
    '<li role="option" id="gs-' + i + '" data-i="' + i + '" aria-selected="' + (i === active) + '">' +
      '<span class="gs-icon" aria-hidden="true">📍</span>' +
      '<span><strong>' + esc(r.main || '') + '</strong><small>' + esc(r.secondary || '') + '</small></span></li>');
  items.push('<li role="option" id="gs-typed" data-i="-1" class="gs-typed" aria-selected="' + (active === results.length) + '">' +
    '<span class="gs-icon" aria-hidden="true">✏️</span>' +
    '<span><strong>Add “' + esc(q) + '” as typed</strong><small>Without map details</small></span></li>');
  list.innerHTML = items.join('');
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
    await saveSuggestion(q, 'other', null);
    return reset();
  }
  const r = results[i];
  const box = $('#gsPreview');
  box.hidden = false;
  box.innerHTML = '<p class="empty">Loading ' + esc(r.main || 'place') + '…</p>';
  try {
    const res = await fetch('/api/places/details?id=' + encodeURIComponent(r.placeId) + '&session=' + encodeURIComponent(session));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Couldn’t load that place');
    preview = data.place;
    session = newSession(); // the details call closes this search session
    renderPreview();
  } catch (ex) {
    box.innerHTML = '<p class="form-error">' + esc(ex.message) + '</p>';
  }
}

function renderPreview() {
  const p = preview, box = $('#gsPreview');
  const facts = [
    p.category, p.price,
    p.rating ? '⭐ ' + Number(p.rating).toFixed(1) + (p.reviews ? ' (' + Number(p.reviews).toLocaleString() + ')' : '') : '',
    p.openNow === true ? 'Open now' : p.openNow === false ? 'Closed now' : '',
  ].filter(Boolean);
  const today = todaysHours(p.hours);
  box.innerHTML =
    (p.photoRef ? '<img class="gs-photo" src="/api/places/photo?name=' + encodeURIComponent(p.photoRef) + '" alt="Photo of ' + esc(p.name || '') + '">'
      : p.photo ? '<img class="gs-photo" src="' + esc(commonsImage(p.photo)) + '" alt="Photo of ' + esc(p.name || '') + '">' : '') +
    '<div class="gs-info"><strong>' + esc(p.name || '') + '</strong>' +
      (facts.length ? '<span>' + esc(facts.join(' · ')) + '</span>' : '') +
      (p.address ? '<span>' + esc(p.address) + '</span>' : '') +
      (today ? '<span>🕒 Today: ' + esc(today) + '</span>' : '') +
    '</div>' +
    '<div class="gs-actions"><button type="button" class="btn small" id="gsAdd">＋ Add to deck</button>' +
      '<button type="button" class="btn small ghost" id="gsCancel">Cancel</button></div>';
  const img = box.querySelector('.gs-photo');
  if (img) img.addEventListener('error', () => img.remove());
  $('#gsAdd').addEventListener('click', async () => {
    // Free results can share a name across branches, so add the area: "Din Tai Fung (Tampines)".
    const label = p.source === 'osm' && p.area ? p.name + ' (' + p.area + ')' : p.name;
    await saveSuggestion(label || $('#gsInput').value.trim(), p.kind || 'activity', null, p);
    reset();
  });
  $('#gsCancel').addEventListener('click', reset);
  $('#gsAdd').focus();
  announce((p.name || 'Place') + '. ' + facts.join(', ') + '. Press Add to deck to add it.');
}

function reset() {
  preview = null;
  results = [];
  const box = $('#gsPreview');
  if (box) { box.hidden = true; box.innerHTML = ''; }
  const input = $('#gsInput');
  if (input) { input.value = ''; input.focus(); }
}
