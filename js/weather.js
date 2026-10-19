// Forecasts for the chosen time: on the Where step (to help pick an activity) and
// on the plan card (Open-Meteo, free, no key).
import { $, $$, esc } from './util.js';
import { DAYS, dayShort, fmtHour, fmtRange, pad2 } from './dates.js';
import { state } from './state.js';
import { chosenRun, computeRuns } from './derive.js';
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
  renderWeatherPanel();
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
  const run = chosenRun();
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

// ---------- Weather card (Where step) ----------
// The weather can decide the activity (picnic or karaoke?), so a short card under the
// deck shows the forecast for the chosen time while people swipe.
function advice(maxPop) {
  if (maxPop >= 50) return { cls: 'warn', text: 'Rain likely — indoor ideas are the safer bet.' };
  if (maxPop >= 25) return { cls: 'maybe', text: 'Some chance of showers — keep an indoor backup in mind.' };
  return { cls: 'ok', text: 'Looks dry — outdoor plans should work too.' };
}

export function weatherPanelHTML() {
  return '<div class="wx-card" id="wxPanel" aria-live="polite"></div>';
}

export function renderWeatherPanel() {
  const box = $('#wxPanel');
  if (!box) return;
  const run = chosenRun();
  const known = [];
  if (run) for (let h = run.start; h < run.end; h++) { const w = weatherAt(run.d, h); if (w) known.push(w); }
  let html = '';
  if (known.length) {
    const temps = known.map((w) => Math.round(w.temp));
    const maxPop = Math.max.apply(null, known.map((w) => w.pop || 0));
    const lo = Math.min.apply(null, temps), hi = Math.max.apply(null, temps);
    const tip = advice(maxPop);
    html = '<p class="wx-head">Weather on ' + esc(dayShort(run.d) + ', ' + fmtRange(run.start, run.end)) + '</p>' +
      '<p class="wx-line">' + wxIcon(known[0].code) + ' ' + (lo === hi ? lo : lo + '–' + hi) + '°C · up to ' + maxPop + '% chance of rain</p>' +
      '<p class="wx-tip">' + tip.text + '</p>';
    box.className = 'wx-card ' + tip.cls;
  }
  box.hidden = !html;  // no time painted yet, or no forecast for that day
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
}
