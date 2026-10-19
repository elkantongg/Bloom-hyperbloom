// Edit a suggested place: fix its name or type, or fill in details yourself
// (useful when the map doesn't know a place). Only the person who suggested it,
// or the group's host, can edit it.
import { $, esc } from './util.js';
import { KINDS } from './data.js';
import { state } from './state.js';
import { announce, refresh, toast } from './ui.js';
import { api, applyState } from './live.js';
import { renderDeck, renderRanking } from './places.js';

// Same choices as the add form. Names stay short enough to fit a card.
export const PRICES = ['', 'Free', '$', '$$', '$$$'];
export const NAME_MAX = 50;
export const VENUE_MAX = 28;

export function canEdit(c) {
  if (!c) return false;
  if (state.mode === 'demo') return c.addedBy === state.me.id;
  return c.addedBy === state.me.id || !!state.me.isHost;
}

export function editButton(c, label) {
  return canEdit(c) ? '<button type="button" class="edit-btn" data-edit="' + esc(c.id) + '" aria-label="Edit ' + esc(label || c.name) + '">✏️ Edit</button>' : '';
}

export function openEditor(id) {
  const c = state.custom.find((x) => x.id === id);
  if (!c || !canEdit(c)) return;
  const d = c.details || {};
  const venue = d.area || '';
  // The card name is "Name (Venue)"; edit the two parts separately, like when adding.
  const suffix = venue ? ' (' + venue + ')' : '';
  const base = suffix && c.name.endsWith(suffix) ? c.name.slice(0, -suffix.length) : c.name;
  let dlg = $('#editDialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'editDialog';
    dlg.className = 'edit-dialog';
    document.body.appendChild(dlg);
  }
  const kind = c.kind === 'outdoors' ? 'activity' : c.kind;
  // Same fields, labels and order as "Add a custom place or activity" (search.js).
  dlg.innerHTML =
    '<form method="dialog" class="edit-form" id="editForm" novalidate>' +
      '<h2>Edit idea</h2>' +
      '<p class="hint">Friends will see your changes on their card.</p>' +
      field('edName', 'Name *', '<input id="edName" required maxlength="' + NAME_MAX + '" value="' + esc(base) + '">') +
      field('edKind', 'Type', '<select id="edKind">' + Object.keys(KINDS).map((k) =>
        '<option value="' + k + '"' + (k === kind ? ' selected' : '') + '>' + KINDS[k].label + '</option>').join('') + '</select>') +
      field('edVenue', 'Venue or branch (optional)', '<input id="edVenue" maxlength="' + VENUE_MAX + '" placeholder="e.g. mall name or studio" value="' + esc(venue) + '">') +
      field('edPrice', 'Price', '<select id="edPrice">' + PRICES.map((p) =>
        '<option value="' + p + '"' + ((d.price || '') === p ? ' selected' : '') + '>' + (p || 'Not sure') + '</option>').join('') + '</select>') +
      field('edHours', 'Opening hours (optional)', '<input id="edHours" maxlength="120" placeholder="e.g. Weekdays 10am–8pm; weekends 11am–10pm" value="' + esc(d.hoursText || '') + '">') +
      field('edDesc', 'Notes (optional)', '<textarea id="edDesc" maxlength="200" rows="2" placeholder="Booking details, meeting point or anything friends should know">' + esc(d.description || '') + '</textarea>') +
      '<p class="form-error" id="edError" role="alert"></p>' +
      '<div class="edit-actions"><button type="submit" class="btn">Save changes</button>' +
        '<button type="button" class="btn ghost" id="edCancel">Cancel</button></div>' +
    '</form>';
  $('#edCancel').addEventListener('click', () => dlg.close());
  $('#editForm').addEventListener('submit', (e) => { e.preventDefault(); save(c, dlg); });
  dlg.showModal();
  $('#edName').focus();
}

function field(id, label, control) {
  return '<div class="field"><label for="' + id + '">' + label + '</label>' + control + '</div>';
}

async function save(c, dlg) {
  const err = $('#edError');
  const base = $('#edName').value.trim();
  const venue = $('#edVenue').value.trim();
  const kind = $('#edKind').value;
  if (!base) { err.textContent = 'Give it a name.'; $('#edName').focus(); return; }
  const name = venue ? base + ' (' + venue + ')' : base;
  const taken = state.custom.some((x) => x.id !== c.id && x.name.toLowerCase() === name.toLowerCase());
  if (taken) { err.textContent = '“' + name + '” is already in the deck.'; return; }
  const edits = {
    area: venue, price: $('#edPrice').value,
    hoursText: $('#edHours').value.trim(), description: $('#edDesc').value.trim(),
  };
  if (state.mode === 'live') {
    try {
      const data = await api('PUT', '/groups/' + encodeURIComponent(state.group.id) + '/places/' + encodeURIComponent(c.id), { name: name, kind: kind, edits: edits });
      applyState(data, false);
    } catch (ex) { err.textContent = ex.message; return; }
  } else {
    const d = Object.assign({ source: 'manual' }, c.details || {});
    Object.keys(edits).forEach((k) => { d[k] = edits[k] || null; });
    if (edits.hoursText) d.hours = [];
    c.name = name; c.kind = kind; c.details = d;
  }
  dlg.close();
  renderDeck();
  renderRanking();
  refresh();
  toast(null, '✏️ Saved changes to “' + name + '”');
  announce('Saved changes to ' + name + '.');
}
