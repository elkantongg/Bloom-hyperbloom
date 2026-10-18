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

## APIs
- **[Open-Meteo](https://open-meteo.com/)** weather forecast API (free, no key, no sign-in). The plan card shows the forecast for the chosen time, and outdoor places warn you when rain is likely. Weather data by Open-Meteo.com (CC BY 4.0).

## Tech
Plain HTML, CSS and JavaScript — no build step, no backend. Friends are simulated in demo mode so a single person can experience the live, multi-person flow.

Run locally:
```
python3 -m http.server 5178
```
then open http://localhost:5178.
