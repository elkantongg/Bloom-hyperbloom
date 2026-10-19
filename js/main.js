// Entry point: starts everything in the right order.
import { store } from './util.js';
import { state } from './state.js';
import { initRouter, route } from './router.js';
import { initPlaces } from './places.js';
import { initHomeNav, initPrefs, initTheme, initZoom } from './settings.js';
import { initLive, resumeLive } from './live.js';
import { loadWeather } from './weather.js';

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
  resumeLive().then(() => route(false));
}
boot();
