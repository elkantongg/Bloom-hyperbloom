// Entry point: starts everything in the right order.
import { store } from './util.js';
import { state } from './state.js';
import { initRouter, route } from './router.js';
import { initPlaces } from './places.js';
import { initHomeNav, initPrefs, initTheme, initZoom } from './settings.js';
import { initLive, resumeLive } from './live.js';
import { loadWeather } from './weather.js';
import { render } from './router.js';

export function boot() {
  initTheme();
  initPrefs();
  initZoom();
  initHomeNav();
  initRouter();
  initPlaces();
  initLive();
  const savedName = store.get('bloom.name');
  if (savedName) state.me.name = savedName;
  loadWeather();
  // Does the server have Google Places? Then "Got another idea?" becomes a Maps-style search.
  fetch('/api/config').then((r) => r.json()).then((c) => {
    state.googlePlaces = !!c.googlePlaces;
    if (state.googlePlaces && state.step === 'places') render();
  }).catch(() => { /* static hosting or offline: keep the free search */ });
  resumeLive().then(() => route(false));
}
boot();
