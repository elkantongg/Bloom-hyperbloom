// "Got another idea?": a Maps-style place search.
// Pick a type, type a name (typos are fine) and choose from the suggestions, see a preview
// of that exact place, then add it to everyone's deck. If a place can't be found,
// enter a custom name, venue, address and details.
import { $, esc } from './util.js';
import { commonsImage, KINDS, todaysHours } from './data.js';
import { announce } from './ui.js';
import { saveSuggestion } from './places.js';

let session = '';      // groups keystrokes + the final details call (matters for Google billing)
let timer = null;
let seq = 0;           // ignore slow responses for older keystrokes
let results = [];
let approx = false;
let total = 0;         // all matches; shown 10 at a time
let more = false;
let didYouMean = '';
let branches = null;   // { name, count } when the top match is a chain
let loadingMore = false;
let options = [];      // what each row in the list does, in keyboard order
let searchError = '';
let controller = null;
let active = -1;
let preview = null;

const newSession = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
const kind = () => ($('#gsKind') || {}).value || 'food';

export function searchHTML() {
  return '<div class="panel suggest" id="gSearch">' +
    '<h2 class="sub-title">Got another idea?</h2>' +
    '<p class="suggest-sub">Search Singapore places. Your type helps rank matches.</p>' +
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
    '<details class="gs-custom" id="gsCustom"><summary>Add a custom place or activity</summary>' +
      '<p class="hint">Missing a place or branch? Enter it here for your group to vote on.</p>' +
      '<form id="gsCustomForm" class="edit-form custom-form">' +
        '<div class="field"><label for="customName">Name *</label><input id="customName" required maxlength="50" placeholder="e.g. Yo Chi or pottery workshop"></div>' +
        '<div class="field"><label for="customKind">Type</label><select id="customKind">' + Object.keys(KINDS).map((k) => '<option value="' + k + '">' + KINDS[k].label + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="customVenue">Venue or branch (optional)</label><input id="customVenue" maxlength="28" placeholder="e.g. mall name or studio"></div>' +
        '<div class="field"><label for="customPrice">Price</label><select id="customPrice"><option value="">Not sure</option><option>Free</option><option>$</option><option>$$</option><option>$$$</option></select></div>' +
        '<div class="field"><label for="customHours">Opening hours (optional)</label><input id="customHours" maxlength="120" placeholder="e.g. Weekdays 10am–8pm; weekends 11am–10pm"></div>' +
        '<div class="field"><label for="customNotes">Notes (optional)</label><textarea id="customNotes" maxlength="200" rows="2" placeholder="Booking details, meeting point or anything friends should know"></textarea></div>' +
        '<button type="submit" class="btn small" id="customSave">Add to deck</button>' +
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
  input.addEventListener('input', () => {
    ++seq; // Invalidate the previous query immediately, including the debounce interval.
    if (controller) controller.abort();
    results = []; active = -1; closeList();
    clearTimeout(timer); timer = setTimeout(() => fetchSuggestions(), 350);
  });
  input.addEventListener('keydown', onKey);
  input.addEventListener('focus', () => { if (results.length) renderList(); });
  input.addEventListener('blur', () => setTimeout(closeList, 150));
  $('#gsKind').addEventListener('change', () => { if (input.value.trim().length >= 2) fetchSuggestions(); });
  // Keep focus in the box when the list is clicked (also for "Show more").
  $('#gsList').addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-o]');
    if (!li) return;
    e.preventDefault(); // keep focus in the box
    pick(+li.dataset.o);
  });
  $('#gsCustom').addEventListener('toggle', () => {
    if ($('#gsCustom').open && !$('#customName').value) {
      $('#customName').value = input.value.trim();
      $('#customKind').value = kind();
    }
  });
  $('#gsCustomForm').addEventListener('submit', saveCustom);
}

// offset 0 = a new search; otherwise the next 10 for "Show more results".
async function fetchSuggestions(offset) {
  const q = $('#gsInput').value.trim();
  const mine = offset ? seq : ++seq;
  $('#sgError').textContent = '';
  searchError = '';
  if (controller) controller.abort();
  controller = new AbortController();
  if (q.length < 2) { results = []; closeList(); return; }
  try {
    const res = await fetch('/api/places/autocomplete?q=' + encodeURIComponent(q) + '&kind=' + kind() +
      (offset ? '&offset=' + offset : '') + '&session=' + encodeURIComponent(session), { signal: controller.signal });
    const data = await res.json();
    if (mine !== seq) return;
    const page = res.ok ? data.results || [] : [];
    results = offset ? results.concat(page) : page;
    approx = !!data.approximate;
    total = data.total || results.length;
    more = !!data.more;
    didYouMean = data.didYouMean || '';
    branches = data.branches || null;
    if (!res.ok) searchError = data.error || 'Search isn’t available right now.';
  } catch (e) {
    if (mine !== seq || e.name === 'AbortError') return;
    if (!offset) {
      searchError = 'Search couldn’t connect. Try again, add a custom place or activity.';
      results = []; more = false; didYouMean = ''; branches = null; // offline: "add as typed" still works
    }
  } finally { loadingMore = false; }
  if (!offset) active = -1;
  renderList();
  if (offset) announce('Showing ' + results.length + ' of ' + total + ' places.');
}

function renderList() {
  const list = $('#gsList'), input = $('#gsInput');
  const q = input.value.trim();
  if (q.length < 2) return closeList();
  // Every row people can pick, in keyboard order.
  options = [];
  if (didYouMean && !searchError) options.push({ type: 'dym' });
  results.forEach((r, i) => options.push({ type: 'result', i: i }));
  if (more && !searchError) options.push({ type: 'more' });
  options.push({ type: 'typed' });
  const note = (t) => '<li class="gs-note" role="presentation">' + t + '</li>';
  const head = searchError ? note(esc(searchError))
    : !results.length
    ? note('No matches for “' + esc(q) + '” in Singapore. Check the spelling, try just the name (e.g. “Din Tai Fung”) or the name and area (“Din Tai Fung Tampines”), or add it as a custom place or activity.')
    : approx ? note('No exact match — closest places:')
    : branches && branches.count > 1 ? note(esc(branches.name) + ' · ' + branches.count + ' branches in Singapore. ' +
        (branches.area ? 'Closest to ' + esc(branches.area) + ' first.' : 'Add an area (e.g. “' + esc(branches.name) + ' Tampines”) to narrow it down.'))
    : '';
  const row = (o, n, icon, title, sub, cls) =>
    '<li role="option" id="gs-o' + n + '" data-o="' + n + '"' + (cls ? ' class="' + cls + '"' : '') + ' aria-selected="' + (n === active) + '">' +
      '<span class="gs-icon" aria-hidden="true">' + icon + '</span><span><strong>' + title + '</strong>' + (sub ? '<small>' + sub + '</small>' : '') + '</span></li>';
  const items = options.map((o, n) => {
    if (o.type === 'dym') return row(o, n, '💡', 'Did you mean “' + esc(didYouMean) + '”?', 'Search for this instead', 'gs-dym');
    if (o.type === 'more') return row(o, n, '⋯', loadingMore ? 'Loading…' : 'Show more results', 'Showing ' + results.length + ' of ' + total, 'gs-more');
    if (o.type === 'typed') return row(o, n, '✏️', 'Add “' + esc(q) + '” as a custom idea', esc((KINDS[kind()] || KINDS.other).label) + ' · enter venue, address and details', 'gs-typed');
    const r = results[o.i];
    return row(o, n, '📍', esc(r.main || ''), esc([r.category, r.secondary].filter(Boolean).join(' · ')));
  });
  list.innerHTML = head + items.join('');
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  if (active >= 0 && active < options.length) {
    input.setAttribute('aria-activedescendant', 'gs-o' + active);
    const el = $('#gs-o' + active);
    if (el) el.scrollIntoView({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}

function closeList() {
  const list = $('#gsList'), input = $('#gsInput');
  if (list) list.hidden = true;
  if (input) { input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
}

function onKey(e) {
  const n = options.length;
  if (!n && e.key !== 'Enter') return;
  if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % n; renderList(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + n) % n; renderList(); }
  else if (e.key === 'Escape') closeList();
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (active >= 0) pick(active);
    else if (results.length) choose(0);
  }
}

// A row was picked: a place, the spelling suggestion, "Show more" or "add as typed".
function pick(n) {
  const o = options[n];
  if (!o) return;
  if (o.type === 'result') return choose(o.i);
  if (o.type === 'typed') return choose(-1);
  if (o.type === 'dym') {
    $('#gsInput').value = didYouMean;
    announce('Searching for ' + didYouMean);
    active = -1;
    return fetchSuggestions();
  }
  if (o.type === 'more' && !loadingMore) {
    loadingMore = true;
    renderList();
    fetchSuggestions(results.length);
  }
}

async function choose(i) {
  closeList();
  const q = $('#gsInput').value.trim();
  if (i < 0) {
    $('#gsCustom').open = true;
    $('#customName').value = q;
    $('#customKind').value = kind();
    $('#customName').focus();
    return;
  }
  const r = results[i];
  await loadPreview('/api/places/details?id=' + encodeURIComponent(r.placeId) + '&session=' + encodeURIComponent(session), r.main);
  session = newSession(); // the details call closes this search session
}

async function saveCustom(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const name = $('#customName').value.trim();
  if (!name) { $('#customName').setCustomValidity('Enter a name.'); form.reportValidity(); $('#customName').setCustomValidity(''); return; }
  const venue = $('#customVenue').value.trim();
  const button = $('#customSave');
  button.disabled = true;
  $('#sgError').textContent = '';
  const details = {
    source: 'manual', name: name, area: venue,
    price: $('#customPrice').value, hoursText: $('#customHours').value.trim(),
    description: $('#customNotes').value.trim(),
  };
  try {
    const saved = await saveSuggestion(name, $('#customKind').value, null, details);
    if (saved) { form.reset(); $('#gsCustom').open = false; reset(); }
  } finally { button.disabled = false; }
}

async function loadPreview(endpoint, label) {
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
    box.innerHTML = '<p class="form-error">' + esc(ex.message) + ' You can add this place using the custom form below.</p>';

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
        ? '<label class="gs-name-label" for="gsName">Name on the card</label><input id="gsName" value="' + esc(shortTitle(p.name)) + '">'
        : '<strong>' + esc(p.name || '') + '</strong>') +
      (facts.length ? '<span>' + esc(facts.join(' · ')) + '</span>' : '') +
      (p.address ? '<span>' + esc(p.address) + '</span>' : '') +
      (p.description ? '<span>' + esc(p.description) + '</span>' : '') +
      (p.partial ? '<span class="gs-partial">This site doesn’t let apps read it, so we guessed the name from the link — check it, and add details later with ✏️ Edit.</span>' : '') +
      (today ? '<span>🕒 Hours: ' + esc(today) + '</span>' : '') +
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
  ++seq;
  clearTimeout(timer);
  if (controller) controller.abort();
  closeList();
  const input = $('#gsInput');
  if (input) { input.value = ''; input.focus(); }
}
