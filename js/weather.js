// Forecast for the plan card (Open-Meteo, free, no key).
import { $$ } from './util.js';
import { DAYS, dayShort, fmtHour, pad2 } from './dates.js';
import { state } from './state.js';
import { computeRuns } from './derive.js';
import { announce, toast } from './ui.js';
import { renderPlanCard } from './bloom.js';
import { api } from './live.js';

export const WEATHER = { lat: 1.2897, lon: 103.8501, place: 'Singapore', hourly: null, status: 'idle' };
export async function loadWeather() {
  WEATHER.status = 'loading';
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + WEATHER.lat + '&longitude=' + WEATHER.lon +
      '&hourly=temperature_2m,precipitation_probability,weather_code&forecast_days=8&timezone=auto';
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const map = {};
    j.hourly.time.forEach((t, i) => {
      map[t] = { temp: j.hourly.temperature_2m[i], pop: j.hourly.precipitation_probability[i], code: j.hourly.weather_code[i] };
    });
    WEATHER.hourly = map;
    WEATHER.status = 'ok';
  } catch (e) {
    WEATHER.status = 'error';
  }
  updateWeatherEls();
  if (state.step === 'bloom') renderPlanCard();
}
export function weatherAt(di, h) {
  if (!WEATHER.hourly) return null;
  const d = DAYS[di];
  return WEATHER.hourly[d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(h) + ':00'] || null;
}
export function wxIcon(c) {
  if (c === 0) return '☀️';
  if (c <= 2) return '🌤️';
  if (c === 3) return '☁️';
  if (c === 45 || c === 48) return '🌫️';
  if (c >= 95) return '⛈️';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return '❄️';
  return '🌧️';
}
export function wxText(w) { return wxIcon(w.code) + ' ' + Math.round(w.temp) + '°C · ' + w.pop + '% chance of rain'; }
export function updateWeatherEls() {
  const run = computeRuns()[0];
  $$('[data-wx]').forEach((el) => {
    const w = run && weatherAt(run.d, run.start);
    if (!w) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle('warn', w.pop >= 50);
    el.textContent = 'Forecast ' + dayShort(run.d) + ' ' + fmtHour(run.start) + ': ' + wxText(w) + (w.pop >= 50 ? ' — maybe bring a plan B' : '');
  });
}
export function useMyLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((pos) => {
    WEATHER.lat = pos.coords.latitude.toFixed(3);
    WEATHER.lon = pos.coords.longitude.toFixed(3);
    WEATHER.place = 'your location';
    announce('Updating the forecast for your location.');
    loadWeather();
  }, () => toast(null, 'Location not shared — showing Singapore weather'));
}
