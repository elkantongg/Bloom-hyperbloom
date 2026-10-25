// Built-in place ideas plus the group's own suggestions.
import { $, $$ } from './util.js';
import { people, state } from './state.js';

// Photos are free-licensed images from Wikimedia Commons (credited on each card).
// Sample places use illustrative photos; real suggestions only get a photo of that exact place.
export const commonsImage = (file, width) => 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file) + '?width=' + (width || 640);
export const commonsPage = (file) => 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(file.replace(/ /g, '_'));

export const PLACES = [
  { id: 'noodle', name: 'Lantern Noodle Bar', kind: 'Noodles', type: 'food', emoji: '🍜', price: '$$', dist: '1.2 km', blurb: 'Hand-pulled noodles and big shared tables.', tags: ['Step-free', 'Veg options'], hue: '#FFC48A', photo: 'Shoyu ramen, at Kasukabe Station (2014.05.05) 1.jpg' },
  { id: 'bowling', name: 'Strike Social', kind: 'Bowling', type: 'activity', emoji: '🎳', price: '$$', dist: '3.4 km', blurb: 'Retro lanes, arcade machines and milkshakes.', tags: ['Step-free', 'Groups of 6+'], hue: '#A9C4FF', photo: 'Bowlerbowling.JPG' },
  { id: 'picnic', name: 'Botanic Gardens Picnic', kind: 'Outdoors', type: 'activity', emoji: '🧺', price: 'Free', dist: '2.0 km', blurb: 'Bring snacks, find a shady lawn, stay till sunset.', tags: ['Free', 'Weather-dependent'], hue: '#A8E6B4', outdoor: true, photo: 'Picnic in Kincardine, Ontario.jpg' },
  { id: 'escape', name: 'Clockwork Escape Room', kind: 'Activity', type: 'activity', emoji: '🔐', price: '$$$', dist: '4.1 km', blurb: '60 minutes to escape a locked inventor’s study.', tags: ['Max 6 people', 'Book ahead'], hue: '#D2B8FF', photo: 'Padlock klódka ubt.JPG' },
  { id: 'karaoke', name: 'Echo Box Karaoke', kind: 'Karaoke', type: 'activity', emoji: '🎤', price: '$$', dist: '2.7 km', blurb: 'Private rooms, 5,000+ songs, zero judgement.', tags: ['Private room', 'Open late'], hue: '#FFB0D2', photo: 'Karaoke in Nha Trang.jpg' },
  { id: 'cafe', name: 'Paper Crane Board Game Café', kind: 'Café', type: 'drinks', emoji: '🎲', price: '$', dist: '0.8 km', blurb: '300 board games, waffles and quiet corners.', tags: ['Quiet', 'Step-free'], hue: '#FFE08A', photo: 'Playing-risk.jpg' },
];

// Types for places the group suggests themselves.
export const KINDS = {
  food: { label: 'Food', emoji: '🍽️', hue: '#FFC48A' },
  drinks: { label: 'Drinks', emoji: '🧋', hue: '#FFB0D2' },
  activity: { label: 'Activity', emoji: '🎯', hue: '#A9C4FF' },
  shopping: { label: 'Shopping', emoji: '🛍️', hue: '#A8E6B4' },
  other: { label: 'Something else', emoji: '✨', hue: '#D2B8FF' },
};
export function customPlace(c) {
  const k = KINDS[c.kind === 'outdoors' ? 'activity' : c.kind] || KINDS.other;
  const by = c.addedBy === state.me.id ? 'you' : ((state.friends.find((f) => f.id === c.addedBy) || {}).name || 'a friend');
  const d = c.details || null; // the place the person confirmed from the list, if any
  const g = !!(d && d.source === 'google');
  const ln = !!(d && d.source === 'link'); // added from a pasted link
  const suffix = d && d.area ? ' (' + d.area + ')' : '';
  const activityName = suffix && c.name.endsWith(suffix) ? c.name.slice(0, -suffix.length) : c.name;
  const dist = g ? '' : (d && d.area) || '';
  const type = KINDS[c.kind === 'outdoors' ? 'activity' : c.kind] ? (c.kind === 'outdoors' ? 'activity' : c.kind) : 'other';
  return { id: c.id, q: c.name, name: c.name, kind: (d && d.category) || k.label, type: type, emoji: k.emoji, hue: k.hue,
    // Shown on cards: drop the " (area)" we appended when the area already shows
    // underneath. Only that exact suffix goes, so brackets in real names stay.
    title: dist ? activityName : c.name,
    price: (d && d.price) || '', dist: dist,
    // Only a photo of this exact place (from Google, or the free map's own photo);
    // otherwise the card shows a map pinned on where it is.
    photo: (!g && d && d.photo) || '',
    photoUrl: g && d.photoRef ? '/api/places/photo?name=' + encodeURIComponent(d.photoRef) : ln && /^https:\/\//.test(d.image || '') ? d.image : '',
    photoCredit: g && d.photoRef ? 'Photo: ' + (d.photoBy || 'Google') + ' · Google' : ln && d.image ? 'Image: ' + (d.siteName || 'linked page') : '',
    photoCreditUrl: g && d.photoRef ? d.photoByUrl || d.mapsUrl || '' : ln ? d.website || '' : '',
    link: d && d.source === 'manual' ? (d.area ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(d.area) : 'https://www.google.com/search?q=' + encodeURIComponent(c.name)) : d && d.mapsUrl ? d.mapsUrl : ln && /^https?:\/\//.test(d.website || '') ? d.website : '',
    linkLabel: d && d.source === 'manual' ? (d.area ? 'Search venue in Google Maps' : 'Search on Google') : ln ? 'Open link' : d && d.mapsUrl ? 'Open in Google Maps' : '',
    map: d && typeof d.lat === 'number' && typeof d.lon === 'number' ? { lat: d.lat, lon: d.lon } : null,
    hoursToday: d ? (todaysHours(d.hours) || d.hoursText || '') : '',
    // Quick link: the link they typed, otherwise a Google search of the exact card name.
    website: d && d.source === 'manual' ? (/^https?:\/\//.test(d.website || '') ? d.website : 'https://www.google.com/search?q=' + encodeURIComponent(c.name)) : !ln && d && /^https?:\/\//.test(d.website || '') ? d.website : '',
    blurb: d && d.source === 'manual' ? [d.address, d.description].filter(Boolean).join(' · ') : d && d.description ? d.description : d && d.address && d.address !== d.area ? d.address : d ? '' : 'Tap the Google link to check hours, prices and reviews.',
    suggestedBy: 'Suggested by ' + by + '.',
    baseName: activityName, // the name without " (venue)", used by the editor
    tags: d ? [d.stepFree && 'Step-free', d.rating && '⭐ ' + Number(d.rating).toFixed(1) + (d.reviews ? ' (' + Number(d.reviews).toLocaleString() + ')' : ''),
      d.openNow === true && 'Open now', d.reservable && 'Takes reservations'].filter(Boolean) : [],
    custom: true, addedBy: c.addedBy };
}
// Map hours are listed Monday-first: "Monday: 08:30 – 18:00".
export function todaysHours(lines) {
  if (!lines || lines.length !== 7) return '';
  return (lines[(new Date().getDay() + 6) % 7] || '').replace(/^[^:]+:\s*/, '');
}
// The name to show for a place (stored names may end in " (area)").
export function placeTitle(pl) { return pl.title || pl.name; }
// Everything in the deck: built-in ideas first, then the group's own suggestions.
// Demo mode starts with sample ideas. Real groups start empty and build the
// deck from their own suggestions, so nothing made-up reaches real friends.
export function allPlaces() {
  const own = state.custom.map(customPlace);
  return state.mode === 'demo' ? PLACES.concat(own) : own;
}
// Votes only count for places that are in the deck right now.
export function votedCount(p) { return allPlaces().filter((pl) => pl.id in p.votes).length; }
export function currentVotes(p) {
  const ids = new Set(allPlaces().map((pl) => pl.id));
  // Place votes, plus votes on tied times ("t:2026-10-27@19-21").
  return Object.fromEntries(Object.entries(p.votes).filter(([id]) => ids.has(id) || id.startsWith('t:')));
}
// The exact Google Maps page when we have it; otherwise a Google search for the name.
export const googleLink = (pl) => pl.link || 'https://www.google.com/search?q=' + encodeURIComponent(pl.q || pl.name);

export const FRIEND_VOTES = {
  maya: { noodle: 1, bowling: 0, picnic: 1, escape: -1, karaoke: 1, cafe: 1 },
  jun: { noodle: 1, bowling: 1, picnic: -1, escape: 1, karaoke: 1, cafe: 0 },
  priya: { noodle: 0, bowling: -1, picnic: 1, escape: 1, karaoke: 0, cafe: 1 },
  sam: { noodle: 1, bowling: 1, picnic: 0, escape: -1, karaoke: 1, cafe: 1 },
};
