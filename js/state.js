// The single shared app state, plus the demo friends.

// Free-time patterns by weekday (0 = Sun). Everyone overlaps on Saturday afternoon.
export const FRIENDS = [
  { id: 'maya', name: 'Maya', color: '#E03131', pattern: { 1: [[18, 22]], 2: [[18, 22]], 3: [[18, 22]], 4: [[18, 22]], 5: [[18, 22]], 6: [[12, 20]], 0: [[10, 14]] } },
  { id: 'jun', name: 'Jun', color: '#D9831A', pattern: { 5: [[19, 22]], 6: [[14, 22]], 0: [[14, 18]] } },
  { id: 'priya', name: 'Priya', color: '#7C5CFF', pattern: { 1: [[19, 21]], 2: [[19, 21]], 4: [[19, 21]], 5: [[19, 22]], 6: [[10, 18]], 0: [[10, 22]] } },
  { id: 'sam', name: 'Sam', color: '#11966A', pattern: { 2: [[17, 22]], 4: [[17, 22]], 6: [[15, 19]], 0: [[11, 13]] } },
];

export const state = {
  step: 'home',
  mode: 'demo',        // 'demo' (simulated friends) or 'live' (real group on the server)
  group: null,         // { id, title, host, startDate } in live mode
  session: null,       // { memberId, token } in live mode
  joinId: null,        // group id from an invite link
  title: 'Weekend hangout',
  me: { id: 'me', name: 'You', color: '#2F6FEB', avail: new Set(), votes: {}, joined: true },
  friends: FRIENDS.map((f) => Object.assign({}, f, { avail: new Set(), votes: {}, joined: false })),
  sim: { times: false, votes: false },
  deckIndex: 0,
  custom: [],          // places the group suggested: { id, name, kind, addedBy }
  milestones: {},
  coachDone: { grid: false, deck: false },
  pickRun: null,
  pickPlace: null,
};
export const people = () => [state.me].concat(state.friends);
export const total = () => people().length;
