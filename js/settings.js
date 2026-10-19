// Accessibility options, page size (zoom), home nav and theme.
import { $, $$, motionMQ, reduceMotion, setReduceMotion, store } from './util.js';
import { state } from './state.js';
import { announce } from './ui.js';
import { go } from './router.js';
import { updateAllCells } from './times.js';
import { startDemo } from './live.js';

export const prefs = { counts: false, calm: false, contrast: false };
try { Object.assign(prefs, JSON.parse(store.get('bloom.prefs') || '{}')); } catch (e) { /* ignore */ }
export function applyPrefs() {
  const root = document.documentElement;
  ['counts', 'calm', 'contrast'].forEach((k) => root.classList.toggle('pref-' + k, !!prefs[k]));
  setReduceMotion(motionMQ.matches || prefs.calm);
  $$('#a11yPanel input[data-pref]').forEach((i) => { i.checked = !!prefs[i.dataset.pref]; });
  if (state.step === 'times') updateAllCells();
}
export function setA11yOpen(open) {
  const a11yBtn = $('#a11yBtn'), a11yPanel = $('#a11yPanel');
  a11yPanel.hidden = !open;
  a11yBtn.setAttribute('aria-expanded', String(open));
  if (open) { const first = a11yPanel.querySelector('input'); if (first) first.focus(); }
}
export function initPrefs() {
  const a11yBtn = $('#a11yBtn'), a11yPanel = $('#a11yPanel');
  a11yBtn.addEventListener('click', () => setA11yOpen(a11yPanel.hidden));
  a11yPanel.addEventListener('change', (e) => {
    const k = e.target.dataset.pref;
    if (!k) return;
    prefs[k] = e.target.checked;
    store.set('bloom.prefs', JSON.stringify(prefs));
    applyPrefs();
    announce(e.target.closest('label').querySelector('strong').textContent + (e.target.checked ? ' on' : ' off'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !a11yPanel.hidden) { setA11yOpen(false); a11yBtn.focus(); }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!a11yPanel.hidden && !e.target.closest('.a11y-wrap')) setA11yOpen(false);
  });
  applyPrefs();
}

export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.5;
export const ZOOM_STEP = 0.1;
export let zoom = 1;
export let zoomShown = 1;
export let zoomAnim = null;
export function showZoom(z) {
  document.documentElement.style.zoom = z === 1 ? '' : String(z);
  $('#zoomReset').textContent = Math.round(z * 100) + '%';
}
export function setZoom(target) {
  zoom = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, target)) * 10) / 10;
  store.set('bloom.zoom', String(zoom));
  $('#zoomOut').disabled = zoom <= ZOOM_MIN;
  $('#zoomIn').disabled = zoom >= ZOOM_MAX;
  $('#zoomReset').setAttribute('aria-label', 'Page size ' + Math.round(zoom * 100) + '%. Click to reset');
  announce('Page size ' + Math.round(zoom * 100) + '%');
  cancelAnimationFrame(zoomAnim);
  if (reduceMotion) { zoomShown = zoom; showZoom(zoom); return; }
  // Ease smoothly to the new size instead of jumping.
  const from = zoomShown, to = zoom, t0 = performance.now(), dur = 420;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    zoomShown = from + (to - from) * e;
    showZoom(k === 1 ? to : zoomShown);
    if (k < 1) zoomAnim = requestAnimationFrame(step);
  };
  zoomAnim = requestAnimationFrame(step);
}
export function initZoom() {
  zoom = parseFloat(store.get('bloom.zoom')) || 1;
  zoomShown = zoom;
  $('#zoomIn').addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
  $('#zoomOut').addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
  $('#zoomReset').addEventListener('click', () => setZoom(1));
  showZoom(zoom);
  $('#zoomOut').disabled = zoom <= ZOOM_MIN;
  $('#zoomIn').disabled = zoom >= ZOOM_MAX;
}

// Home navigation bar
export function initHomeNav() {
  $('.home-nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-scroll]');
    if (!b) return;
    const doScroll = () => {
      const el = document.getElementById(b.dataset.scroll);
      if (el) el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      if (b.dataset.focus) setTimeout(() => { const f = document.getElementById(b.dataset.focus); if (f) f.focus({ preventScroll: true }); }, reduceMotion ? 0 : 450);
    };
    if (state.step !== 'home') { go('home'); setTimeout(doScroll, 50); } else doScroll();
  });
  $('#navDemo').addEventListener('click', () => {
    const t = $('#planTitle'), n = $('#myName');
    startDemo((t && t.value.trim()) || 'Weekend hangout', (n && n.value.trim()) || state.me.name || 'You');
    go('times');
  });
}

export function currentTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set) return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
export function syncThemeBtn() {
  const themeBtn = $('#themeToggle');
  const t = currentTheme();
  themeBtn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  themeBtn.innerHTML = t === 'dark'
    ? '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></g></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
}
export function initTheme() {
  const savedTheme = store.get('bloom.theme');
  if (savedTheme === 'dark' || savedTheme === 'light') document.documentElement.setAttribute('data-theme', savedTheme);
  $('#themeToggle').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.set('bloom.theme', next);
    syncThemeBtn();
  });
  syncThemeBtn();
}
