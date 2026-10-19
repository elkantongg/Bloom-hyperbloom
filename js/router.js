// Which screen is showing, navigation, and batched re-renders.
import { $, $$ } from './util.js';
import { allPlaces } from './data.js';
import { state } from './state.js';
import { updateFlowers, updatePeople } from './ui.js';
import { bindHome, homeHTML } from './home.js';
import { bindTimes, timesHTML } from './times.js';
import { bindPlaces, placesHTML } from './places.js';
import { bindBloom, bloomHTML } from './bloom.js';
import { bindJoin, joinHTML, openInvite, sessions } from './live.js';

export function canGo(step) {
  if (step === 'home' || step === 'join') return true;
  if (step === 'times') return state.mode === 'demo' || !!state.session;
  if (step === 'places') return state.me.avail.size > 0;
  if (step === 'bloom') return allPlaces().length > 0 && state.deckIndex >= allPlaces().length;
  return false;
}
export function go(step, push) {
  if (!canGo(step)) step = !canGo('times') ? 'home' : canGo('places') ? 'places' : 'times';
  state.step = step;
  if (push !== false) {
    const h = step === 'home' ? '#/' : step === 'join' ? '#/join/' + state.joinId : '#/' + step;
    if (location.hash !== h) history.pushState(null, '', h);
  }
  render();
}
export function route(push) {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'join' && parts[1]) {
    openInvite(decodeURIComponent(parts[1]));
    return;
  }
  const s = parts[0] || 'home';
  go(['home', 'times', 'places', 'bloom'].indexOf(s) > -1 ? s : 'home', push);
}

export function updateStepper() {
  const order = ['times', 'places', 'bloom'];
  $('.topbar').classList.toggle('is-home', state.step === 'home' || state.step === 'join');
  $$('#stepper button').forEach((b) => {
    const s = b.dataset.step;
    b.disabled = !canGo(s);
    if (s === state.step) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    b.classList.toggle('done', order.indexOf(s) < order.indexOf(state.step));
  });
}
export function initRouter() {
  window.addEventListener('popstate', () => route(false));
  $('#stepper').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-step]');
    if (b && !b.disabled) go(b.dataset.step);
  });
}

export function render() {
  clearTimers('deck');
  const main = $('#main');
  if (state.step === 'home') main.innerHTML = homeHTML();
  if (state.step === 'join') main.innerHTML = joinHTML();
  if (state.step === 'times') main.innerHTML = timesHTML();
  if (state.step === 'places') main.innerHTML = placesHTML();
  if (state.step === 'bloom') main.innerHTML = bloomHTML();
  document.title = {
    home: 'Bloom — plans that actually happen',
    join: 'You’re invited · Bloom',
    times: 'When are you free? · Bloom',
    places: 'Where should we go? · Bloom',
    bloom: 'Your plan · Bloom',
  }[state.step];
  if (state.step === 'home') bindHome();
  $('#navGroups').hidden = !(state.step === 'home' && Object.keys(sessions()).length);
  if (state.step === 'join') bindJoin();
  if (state.step === 'times') bindTimes();
  if (state.step === 'places') bindPlaces();
  if (state.step === 'bloom') bindBloom();
  updateStepper();
  updatePeople();
  updateFlowers();
  window.scrollTo(0, 0);
  const h1 = $('#main h1');
  if (h1 && state.step !== 'home') { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); }
}

export const timers = { sim: [], deck: [] };
export function later(group, fn, ms) { timers[group].push(setTimeout(fn, ms)); }
export function clearTimers(group) { timers[group].forEach(clearTimeout); timers[group] = []; }
