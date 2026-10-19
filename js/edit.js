// Edit a suggested place: fix its name or type, or fill in details yourself
// (useful when the map doesn't know a place). Only the person who suggested it,
// or the group's host, can edit it.
import { $, esc } from './util.js';
import { KINDS } from './data.js';
import { state } from './state.js';
import { announce, refresh, toast } from './ui.js';
import { api, applyState } from './live.js';
import { renderDeck, renderRanking } from './places.js';

const PRICES = ['', 'Free', '$', '$$', '$$$', '$$$$'];

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
  let dlg = $('#editDialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'editDialog';
    dlg.className = 'edit-dialog';
    document.body.appendChild(dlg);
  }
  const kind = c.kind === 'outdoors' ? 'activity' : c.kind;
  dlg.innerHTML =
    '<form method="dialog" class="edit-form" id="editForm" novalidate>' +
      '<h2>Edit idea</h2>' +
      '<p class="hint">Friends will see your changes on their card.</p>' +
      field('edName', 'Name', '<input id="edName" maxlength="40" required value="' + esc(c.name) + '">') +
      '<div class="edit-two">' +
        field('edKind', 'Type', '<select id="edKind">' + Object.keys(KINDS).map((k) =>
          '<option value="' + k + '"' + (k === kind ? ' selected' : '') + '>' + KINDS[k].emoji + ' ' + KINDS[k].label + '</option>').join('') + '</select>') +
        field('edPrice', 'Price', '<select id="edPrice">' + PRICES.map((p) =>
          '<option value="' + p + '"' + ((d.price || '') === p ? ' selected' : '') + '>' + (p || 'Not sure') + '</option>').join('') + '</select>') +
      '</div>' +
      field('edCategory', 'What is it?', '<input id="edCategory" maxlength="60" placeholder="e.g. Laser tag arena" value="' + esc(d.category || '') + '">') +
      field('edDesc', 'Notes', '<textarea id="edDesc" maxlength="200" rows="2" placeholder="e.g. Book 2 days ahead, groups of 6+">' + esc(d.description || '') + '</textarea>') +
      field('edAddress', 'Address or area', '<input id="edAddress" maxlength="200" value="' + esc(d.address || '') + '">') +
      field('edHours', 'Opening hours', '<input id="edHours" maxlength="120" placeholder="e.g. 10am – 10pm daily" value="' + esc(d.hoursText || '') + '">') +
      field('edLink', 'Link', '<input id="edLink" type="url" inputmode="url" maxlength="500" placeholder="Website, booking or Google Maps link" value="' + esc(d.website || '') + '">') +
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
  const name = $('#edName').value.trim();
  const kind = $('#edKind').value;
  if (!name) { err.textContent = 'Give it a name.'; $('#edName').focus(); return; }
  const taken = state.custom.some((x) => x.id !== c.id && x.name.toLowerCase() === name.toLowerCase());
  if (taken) { err.textContent = '“' + name + '” is already in the deck.'; return; }
  let link = $('#edLink').value.trim();
  if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
  const edits = {
    category: $('#edCategory').value.trim(), price: $('#edPrice').value,
    description: $('#edDesc').value.trim(), address: $('#edAddress').value.trim(),
    hoursText: $('#edHours').value.trim(), website: link,
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
