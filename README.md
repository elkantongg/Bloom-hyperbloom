# Bloom 🌸 — plans that actually happen

Paint when you're free, swipe on where to go, and watch your group's plan bloom.

## The problem
Making plans with friends dies in the group chat: "when's everyone free?", "idk, you pick", 200 messages later, nothing happens. Existing tools (When2meet, polls) solve one piece, look dated, and don't make deciding *where* any easier.

## How it works
1. **When** — drag across a week grid to paint your free hours. The grid is a live heatmap: brighter = more friends free. The best overlapping time is highlighted automatically.
2. **Where** — swipe through place cards (right = yes, left = nope, up = maybe). Each card shows price, distance and accessibility info (e.g. step-free), plus which friends already said yes.
3. **Bloom** — each person is a petal that opens as they add times and vote. When the group agrees, you get one clear plan card: when, where, who's coming — add it to your calendar or copy the invite to the group chat.

## Accessibility & inclusive design
- Full keyboard support: roving-focus grid (arrow keys, Space to toggle, Shift+arrow to paint), ←/↑/→ to vote.
- Screen-reader labels on every grid cell ("Saturday 3pm. You're free. 5 of 5 free: Maya, Jun, Priya, Sam"), live announcements when friends join or votes change.
- Light and dark themes, respects `prefers-reduced-motion`, visible focus rings, colour is never the only signal (outline for "you", star for "best").
- Responsive down to 375px phones; touch drag-to-paint and swipe.

## Groups, invites & passwords
1. Create a group with a title, your name and a **group password**.
2. Copy the invite link (e.g. `http://localhost:5178/#/join/AbC123xy`) and send it to friends — send the password separately.
3. Friends opening the link see *"Alex is inviting you to Weekend hangout"*, enter their name + the password, and join.
4. Everyone in the group sees each other's availability and votes; changes sync every few seconds.

No user accounts are needed. Passwords are stored hashed (PBKDF2), each person gets a private session token, and 5 wrong passwords lock that device out for 60 seconds. There's also a **demo mode** with simulated friends for trying it alone.

## Backend & database
- `server.py` — a small Python server (standard library only, nothing to install). It serves the site and a JSON API.
- **SQLite** database at `data/bloom.db`, created automatically on first run. No sign-up or login needed.
  - Tables: `groups` (title, host, week, hashed password) and `members` (name, colour, availability, votes).
  - View it in VS Code with the **SQLite Viewer** extension (click `data/bloom.db`), or in the terminal: `sqlite3 data/bloom.db "SELECT name, avail, votes FROM members;"`
  - The database is git-ignored, so private group data is never committed.

| Method | Path | What it does |
|---|---|---|
| POST | `/api/groups` | Create a group (title, name, password) |
| GET | `/api/groups/{id}/invite` | Public invite preview: title, host, member count |
| POST | `/api/groups/{id}/join` | Join with name + password, returns a session token |
| GET | `/api/groups/{id}/state` | Everyone's availability and votes (members only) |
| PUT | `/api/groups/{id}/me` | Save your availability / votes (members only) |

## APIs
- **[Open-Meteo](https://open-meteo.com/)** weather forecast API (free, no key, no sign-in). The plan card shows the forecast for the chosen time, and outdoor places warn you when rain is likely. Weather data by Open-Meteo.com (CC BY 4.0).

## Tech
Plain HTML, CSS and JavaScript on the front end (no build step); Python + SQLite on the back end. Polling pauses when the tab is hidden to save battery and CPU.

Run locally (from this folder):
```
npm start
```
or, without npm:
```
python3 server.py
```
then open http://localhost:5178. Press Ctrl+C in the terminal to stop.
