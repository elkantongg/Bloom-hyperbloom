// The landing page and the create-a-group form.
import { $, $$, esc, store } from './util.js';
import { todayYmd } from './dates.js';
import { state } from './state.js';
import { announce, copy, toast } from './ui.js';
import { go, render } from './router.js';
import { api, invite, saveSession, sessions, startDemo, startLive } from './live.js';

export function homeHTML() {
  return '' +
    '<section class="hero">' +
      '<div>' +
        '<h1>Time to <em>Lepak</em></h1>' +
        '<p class="lede">Don’t say never jio</p>' +
        myGroupsHTML() +
        '<form class="start-card" id="startForm" novalidate>' +
          '<div class="field"><label for="planTitle">What’s the plan?</label>' +
            '<input id="planTitle" name="title" placeholder="e.g. Weekend hangout" maxlength="40" autocomplete="off" required></div>' +
          '<div class="field"><label for="myName">Your name</label>' +
            '<input id="myName" name="name" placeholder="e.g. John" maxlength="20" autocomplete="given-name" required></div>' +
          '<div class="field"><label for="groupPw">Group password</label>' +
            '<input id="groupPw" name="password" type="password" minlength="4" maxlength="64" autocomplete="new-password" required aria-describedby="pwHint">' +
            '<span class="hint" id="pwHint">Friends need this to join. Share it separately from the link (at least 4 characters).</span></div>' +
          '<p class="form-error" id="startError" role="alert"></p>' +
          '<button class="btn" type="submit" id="createBtn">Create group & get invite link →</button>' +
          '<button class="btn ghost" type="button" id="demoBtn">Just looking? Try a demo (nothing is saved)</button>' +
          '<p class="reassure"><span>✓ No sign-ups</span><span>✓ Free</span><span>✓ For 3+ friends</span></p>' +
        '</form>' +
      '</div>' +
      '<div class="hero-art" aria-hidden="true">' +
        heroMark() +
        '<div class="floating f1">👋<div>Let’s meet up soon!<small>Who’s in?</small></div></div>' +
        '<div class="floating f2">🗓️<div>When are you free?<small>Paint your hours</small></div></div>' +
        '<div class="floating f3">✨<div>Let’s do this!<small>Sat 3–6pm</small></div></div>' +
      '</div>' +
    '</section>' +
    versusHTML() +
    '<section class="how-section" id="how" aria-labelledby="howTitle">' +
    '<p class="section-label">How it works</p>' +
    '<h2 class="section-title" id="howTitle">Three steps. Zero arguments.</h2>' +
    '<ol class="how">' +
      '<li><span class="step-n" aria-hidden="true">1</span><span class="ico" aria-hidden="true">🖌️</span><h3>Paint your time</h3><p>Drag across the hours you’re free. The brighter a square, the more friends can make it.</p></li>' +
      '<li><span class="step-n" aria-hidden="true">2</span><span class="ico" aria-hidden="true">👆</span><h3>Suggest &amp; swipe</h3><p>Add your ideas for food, drinks or things to do, and swipe on your friends’. No debates, no “idk, you pick”.</p></li>' +
      '<li><span class="step-n" aria-hidden="true">3</span><span class="ico" aria-hidden="true">🛋️</span><h3>Lock it in</h3><p>Everyone adds their bit whenever they’re free. The host picks the plan, and the whole group sees it: date, place, who’s coming and the weather.</p></li>' +
    '</ol></section>';
}
export function versusHTML() {
  const chat = [
    ['L', '#7C5CFF', 'anyone free this weekend??'],
    ['M', '#E03131', 'maybe sat? not morning tho'],
    ['J', '#D9831A', 'i can do sun… or sat night'],
    ['L', '#7C5CFF', 'ok where do we go'],
    ['S', '#11966A', 'idk you pick 😅'],
    ['M', '#E03131', 'wait which day did we say'],
  ];
  return '<section class="versus" id="versus" aria-labelledby="versusTitle">' +
    '<p class="section-label">Why Lepak?</p>' +
    '<h2 class="section-title" id="versusTitle">Sound familiar?</h2>' +
    '<div class="versus-grid">' +
      '<figure class="vs-card before"><figcaption><span class="vs-tag">Before</span> The group chat</figcaption>' +
        '<ul class="chat">' + chat.map((c, i) => '<li style="--i:' + i + '"><span class="av sm" style="--c:' + c[1] + '" aria-hidden="true">' + c[0] + '</span><span class="bubble">' + c[2] + '</span></li>').join('') + '</ul>' +
        '<p class="vs-foot">Scroll, scroll… still no plan. 😮‍💨</p></figure>' +
      '<div class="vs-arrow" aria-hidden="true">→</div>' +
      '<figure class="vs-card after"><figcaption><span class="vs-tag good">With Lepak</span> One clear answer</figcaption>' +
        '<div class="mini-plan">' +
          '<div class="mini-grid" aria-hidden="true">' + Array.from({ length: 21 }, (_, i) => '<i style="--h:' + [0, .2, .4, 1, 1, .6, .2][i % 7] * (i > 6 && i < 14 ? 1 : .55) + '"></i>').join('') + '</div>' +
          '<p class="mp-when">⭐ Saturday 3–6pm</p><p class="mp-where">🍜 Lantern Noodle Bar</p>' +
          '<p class="mp-who"><span class="av-stack">' + ['#2F6FEB', '#E03131', '#D9831A', '#7C5CFF', '#11966A'].map((c, i) => '<span class="av sm" style="--c:' + c + '" aria-hidden="true">' + 'YMJPS'[i] + '</span>').join('') + '</span> 5 of 5 coming</p>' +
        '</div>' +
        '<p class="vs-foot">Decided in minutes, not days. 🛋️</p></figure>' +
    '</div></section>';
}
export function myGroupsHTML() {
  const all = sessions();
  const ids = Object.keys(all);
  if (!ids.length) return '';
  return '<section class="my-groups" aria-labelledby="myGroupsTitle"><h2 id="myGroupsTitle">Your groups</h2><ul>' +
    ids.map((id) => '<li><span class="mg-title">' + esc(all[id].title || 'Group ' + id) + '</span>' +
      '<span class="mg-actions"><a class="btn small" href="#/join/' + encodeURIComponent(id) + '">Continue →</a>' +
      '<button type="button" class="icon-btn sm" data-forget="' + esc(id) + '" aria-label="Remove ' + esc(all[id].title || 'group') + ' from this device">✕</button></span></li>').join('') +
    '</ul><p class="hint">Saved on this device. Removing a group here doesn’t delete it for your friends. ' +
    '<button type="button" class="link-btn" id="startFresh">Start fresh</button></p></section>';
}
export function heroMark() {
  // L, E, P, A, K drop onto the couch one by one and bounce until they're comfy.
  const friends = [['L', '#2F6FEB'], ['E', '#E03131'], ['P', '#D9831A'], ['A', '#7C5CFF'], ['K', '#11966A']];
  const seats = friends.map((f, i) => '<g class="hm-friend f' + (i + 1) + '" transform="translate(' + (-112 + i * 56) + ',0)">' +
    '<g class="hm-body"><circle cy="-22" r="22" fill="' + f[1] + '"/>' +
    '<text y="-13" text-anchor="middle" font-size="23" font-weight="800" fill="#fff">' + f[0] + '</text></g></g>').join('');
  return '<svg class="hero-mark" viewBox="-190 -120 380 230" role="img" aria-label="Five friends, L, E, P, A and K, sitting down on a couch">' +
    '<g class="hm-couch">' +
      '<rect class="hm-back" x="-144" y="-44" width="288" height="66" rx="26"/>' +
      '<rect class="hm-arm" x="-176" y="-8" width="40" height="70" rx="16"/>' +
      '<rect class="hm-arm" x="136" y="-8" width="40" height="70" rx="16"/>' +
      '<rect class="hm-seat" x="-138" y="18" width="276" height="40" rx="12"/>' +
      '<rect class="hm-leg" x="-164" y="60" width="12" height="18" rx="4"/><rect class="hm-leg" x="152" y="60" width="12" height="18" rx="4"/>' +
    '</g>' +
    '<g transform="translate(0,20)">' + seats + '</g>' +
    '<path class="hm-spark" d="M0 -96 L6 -80 L22 -74 L6 -68 L0 -52 L-6 -68 L-22 -74 L-6 -80 Z" fill="#FFD25E"/>' +
    '</svg>';
}
export function bindHome() {
  const art = $('.hero-art');
  if (art && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => art.classList.toggle('paused', !en.isIntersecting));
    });
    io.observe(art);
  }
  $$('[data-forget]').forEach((b) => b.addEventListener('click', () => {
    saveSession(b.dataset.forget, null);
    render();
    announce('Group removed from this device.');
    const next = $('[data-forget]') || $('#planTitle');
    if (next) next.focus();
  }));
  const fresh = $('#startFresh');
  if (fresh) fresh.addEventListener('click', () => {
    store.set('bloom.sessions', '{}');
    store.set('bloom.current', '');
    store.set('bloom.name', '');
    state.title = 'Weekend hangout';
    state.me.name = 'You';
    render();
    announce('Started fresh. Saved groups and your name were cleared from this device.');
    $('#planTitle').focus();
  });
  $('#startForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = $('#planTitle').value.trim() || 'Weekend hangout';
    const n = $('#myName').value.trim();
    const pw = $('#groupPw').value;
    const err = $('#startError');
    if (!n) { err.textContent = 'Add your name so friends know who’s inviting them.'; $('#myName').focus(); return; }
    if (pw.length < 4) { err.textContent = 'Pick a group password with at least 4 characters.'; $('#groupPw').focus(); return; }
    const btn = $('#createBtn');
    btn.disabled = true; btn.textContent = 'Creating your group…';
    try {
      const res = await api('POST', '/groups', { title: t, name: n, password: pw, startDate: todayYmd() });
      store.set('bloom.name', n);
      startLive(res);
      go('times');
      toast(null, 'Group created — copy the invite link to share');
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false; btn.textContent = 'Create group & get invite link →';
    }
  });
  $('#demoBtn').addEventListener('click', () => {
    const t = $('#planTitle').value.trim();
    const n = $('#myName').value.trim();
    startDemo(t || 'Weekend hangout', n || 'You');
    go('times');
  });
}
