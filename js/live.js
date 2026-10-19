// Live groups: talking to server.py, syncing, invites and joining.
import { $, esc, store } from './util.js';
import { setWeek } from './dates.js';
import { allPlaces } from './data.js';
import { FRIENDS, people, state } from './state.js';
import { announce, refresh, toast } from './ui.js';
import { clearTimers, go, render } from './router.js';

export async function api(method, path, body) {
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

export function sessions() {
  try { return JSON.parse(store.get('bloom.sessions') || '{}') || {}; } catch (e) { return {}; }
}
export function saveSession(groupId, sess) {
  const all = sessions();
  if (sess) all[groupId] = sess; else delete all[groupId];
  store.set('bloom.sessions', JSON.stringify(all));
}
export function inviteLink() {
  return location.origin + location.pathname + '#/join/' + encodeURIComponent(state.group ? state.group.id : '');
}

export function startLive(res) {
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

export function startDemo(title, name) {
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
export let pendingSave = null;
export function applyState(data, first) {
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

export let saveTimer = null;
export function saveSoon(patch) {
  pendingSave = Object.assign(pendingSave || {}, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
export let saving = false;
export async function flushSave() {
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
export let syncTimer = null;
export async function pull() {
  if (state.mode !== 'live' || !state.group || document.hidden) return;
  try {
    const data = await api('GET', '/groups/' + encodeURIComponent(state.group.id) + '/state');
    applyState(data, false);
    refresh();
  } catch (e) {
    if (e.status === 401 || e.status === 404) { stopSync(); toast(null, e.message); }
  }
}
export function startSync() {
  stopSync();
  syncTimer = setInterval(pull, 3000);
}
export function stopSync() {
  clearInterval(syncTimer);
  syncTimer = null;
}
export function initLive() {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
}

export async function resumeLive() {
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

export let invite = null;
export async function openInvite(gid) {
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

export function joinHTML() {
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

export function bindJoin() {
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
