# Bloom — Plans That Actually Happen

**Don't leave your plans in the bud. Make room for Bloom.**

*Because “we should hang out sometime” deserves to become “see you there!”*

Bloom is a collaborative group-planning platform that helps friends find common free time, discover places to go, and turn endless group-chat discussions into actual plans.

No more scheduling headaches, unanswered messages, or forgotten hangouts.

---

## The Problem

Planning a group outing should be exciting. Instead, it often looks something like this:

- “When is everyone free leh?”
- “I'm ok with anything.”
- “Where should we go?”
- “Let's decide another day bah.”

And somehow, another day never comes.
Traditional scheduling tools focus on availability, while polls focus on preferences. But planning a successful outing requires both.

**Bloom brings everything together in one place.**

## How Bloom Works

Bloom simplifies group planning into three steps.

### 1. WHEN — Find Your Common Free Time

- Paint your available hours onto an interactive weekly calendar.
- See everyone's availability through a collaborative heatmap.
- Identify overlapping time slots automatically.
- Find suitable meeting times without endless messages.

### 2. WHERE — Discover and Decide Together

- Search for restaurants, cafés, shops, and activities across Singapore.
- Discover venues through an OpenStreetMap-powered search engine.
- Swipe right to **Love It**, left to **Pass**, or up for **Maybe**.
- Suggest custom places and activities.
- See which places your friends prefer.
- Identify group favourites through collective voting.

### 3. BLOOM — Watch Your Plans Come Together

- See your group's planning progress represented by a blooming flower.
- Receive a suggested plan based on availability and preferences.
- View the confirmed date, time, venue, and participants.
- Check the weather forecast for your outing.
- Export the plan to your calendar.
- Copy and share the final invitation.

**Less back-and-forth. More getting together.**

---

## Key Features

| Feature | Description |
|---|---|
| Collaborative availability | Interactive calendar showing overlapping free time |
| Group voting | Swipe-based decisions for restaurants and activities |
| Smart place discovery | Singapore venue search with typo tolerance |
| Branch discovery | Find different outlets of restaurants and retail chains |
| Group favourites | Rank suggestions using everyone's preferences |
| Bloom progress | Visualise group participation through an animated flower |
| Weather forecasts | View conditions for your planned outing |
| Group invitations | Share private invitation links and group passwords |
| Calendar integration | Export confirmed plans as calendar events |
| Accessibility | Keyboard support, contrast settings, reduced motion and more |
| Demo mode | Explore Bloom with simulated friends without saving data |

---

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, Vanilla JavaScript |
| Backend | Python |
| Database | Supabase PostgreSQL |
| Database driver | psycopg |
| Place discovery | OpenStreetMap, Overpass API, Photon |
| Place search | Local searchable index, fuzzy matching and RapidFuzz (optional) |
| Place details | OpenStreetMap / Nominatim |
| Weather | Open-Meteo API |
| Version control | Git and GitHub |

Bloom uses native JavaScript modules without requiring a frontend framework or build step.

### System Architecture

```text
                 BLOOM
              Web Frontend
           HTML / CSS / JS
                    |
                    v
              Python Server
                server.py
                    |
          +---------+---------+
          |                   |
          v                   v
    Supabase PostgreSQL   Place Discovery
          |                   |
    Groups & members    Local OSM Index
    Availability        Photon
    Votes & places      Nominatim
                              |
                         OpenStreetMap

    Weather forecasts: Open-Meteo
```

The Python backend manages group authentication, application logic, database access, and place-search endpoints.

Supabase provides the hosted PostgreSQL database for persistent group data.

---

## Getting Started

### Prerequisites

- Python 3
- A Supabase PostgreSQL project
- Git
- Node.js and npm (optional, for the `npm start` shortcut)

### 1. Clone the Repository

```bash
git clone https://github.com/elkantongg/Bloom-hyperbloom.git
cd Bloom-hyperbloom
```

### 2. Create a Python Virtual Environment

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 3. Install Dependencies

```bash
pip install -r requirements.txt
```

PostgreSQL support requires `psycopg`, including connection-pooling support.

RapidFuzz is used to accelerate fuzzy place-name matching when installed.

### 4. Configure Supabase

Create a `.env` file in the project root.

```env
DATABASE_URL=your-supabase-postgresql-connection-string
```

Replace the placeholder with your PostgreSQL connection URI from the Supabase dashboard.

For IPv4 networks, Supabase's Session Pooler is an available alternative to a direct database connection.

**Security:** Never commit `.env`, database passwords, or credentials to GitHub. Each developer should configure their own database connection.

### 5. Start Bloom

```bash
npm start
```

Alternatively:

```bash
python3 server.py
```

Open:

**http://localhost:5178**

On initial startup, the PostgreSQL backend initialises the required database tables if they do not already exist.

The application requires a valid `DATABASE_URL`; it does not silently fall back to SQLite.

---

## Database — Supabase PostgreSQL

Bloom uses Supabase's hosted PostgreSQL database to store information for real groups.

### Database Tables

| Table | Purpose |
|---|---|
| `groups` | Group details, planning dates and hashed passwords |
| `members` | Member information, session-token hashes, availability and votes |
| `places` | User-added venues, categories and place details |

### Database Security

- Group passwords use PBKDF2 hashing.
- Session tokens are validated by the backend, with token hashes stored in the database.
- Database credentials remain on the Python server.
- Database operations use parameterised queries.
- Transactions help prevent partially saved operations.
- Concurrent operations are handled with appropriate database locking.
- Row Level Security (RLS) is enabled on application tables without public access policies.
- Browser users do not require direct access to Supabase database tables.

Bloom currently uses its own group-password and session-token system rather than Supabase Auth.

### SQLite Migration

Bloom originally used SQLite for local data storage.
The repository includes `migrate_sqlite_to_postgres.py` for copying data from the previous SQLite database to PostgreSQL.

A dry run can be performed with:

```bash
python3 migrate_sqlite_to_postgres.py
```

The script supports an explicitly confirmed `--apply` mode for performing the migration.
Existing SQLite databases should be retained as backups until migration results have been verified.

---

## 🔎 Singapore Place Discovery

Bloom uses free and open-source geographic data to help groups discover venues across Singapore.

### 1. Local OpenStreetMap Place Index

`placesearch.py` provides a searchable index of venues mapped in OpenStreetMap.
The index is built from data retrieved using the Overpass API and stored locally in:

```text
search/sg-places.json.gz
```

It supports:

- Fuzzy matching and common spelling variations
- Case-insensitive searching
- Punctuation and spacing normalisation
- Restaurant and retail-chain branch discovery
- Location-aware ranking
- Category-based venue searches
- Paginated search results

For example:

| Search | Intended matching behaviour |
|---|---|
| `Macdonalds` | Match McDonald's |
| `McDonalds Tampines` | Prioritise Tampines branches |
| `Sephora Orchard` | Prioritise relevant Orchard outlets |
| `Din Tai Fung` | Find indexed branches |
| `Bubble tea Bugis` | Find relevant beverage shops |

Results depend on the coverage and freshness of the underlying OpenStreetMap data. Bloom does not guarantee a complete directory of Singapore businesses.

### 2. Photon API

Photon supplements the local index with live OpenStreetMap-based search where needed.
This can help with locations or features not covered by the locally indexed venue data.

### 3. Nominatim

Nominatim retrieves additional details for supported OpenStreetMap results.
Requests must respect the public service's usage policy and rate limits.

### Refreshing the Place Index

To rebuild the local venue index:

```bash
python3 placesearch.py build
```

To test a venue search:

```bash
python3 placesearch.py search "macdonalds tampines"
```

The index can be refreshed periodically to incorporate updated OpenStreetMap information.

Public Overpass, Photon, and Nominatim instances are shared services with usage restrictions. Larger deployments may require a separately hosted or appropriately provisioned service.

### Optional Google Places Integration

The backend includes optional Google Places functionality, but it is not required for Bloom's free OpenStreetMap search.
Google Places requires separate API credentials and may incur usage charges.

---

## 🌦️ Weather Integration

Bloom uses the **Open-Meteo API** to display weather forecasts for planned outings.

Features include:

- Hourly temperature forecasts
- Probability of precipitation
- Weather condition indicators
- Warnings for outdoor activities when rain is likely
- Optional location-based forecasts

Weather information is displayed alongside the final group plan.
Weather data is provided by Open-Meteo.
Forecast accuracy and availability depend on the API and forecast horizon.

---

## ♿ Accessibility and Inclusive Design

Bloom aims to make group planning approachable and accessible.

Features include:

- Light and dark themes
- Adjustable text sizes
- High-contrast settings
- Reduced-motion options
- Keyboard navigation
- Screen-reader announcements
- Accessible calendar interaction
- Visual progress indicators
- Touch-friendly controls
- Responsive layouts for mobile devices

Bloom also incorporates interaction-design principles including Hick's Law, social proof, goal-gradient effects, progressive disclosure, and feedback through visual cues.
These features aim to reduce cognitive load and encourage group participation.

---

## Testing

Bloom includes automated tests for its backend and place-search functionality.

Run:

```bash
python3 -m unittest discover tests
```

Database integration tests require a dedicated PostgreSQL test database configured through `TEST_DATABASE_URL`.

Tests cover areas including:

- Group creation and joining
- Password verification
- Session validation
- Availability updates
- Place suggestions and voting
- Database persistence
- Transaction rollback
- Concurrent group membership
- SQLite migration safety
- Fuzzy search and branch matching

Tests should run against a dedicated test database, never the production Supabase database.

---

## 📁 Project Structure

```text
Bloom-hyperbloom/
│
├── index.html
├── styles.css
├── server.py
├── bloomdb.py
├── placesearch.py
├── migrate_sqlite_to_postgres.py
│
├── db/
│   └── schema.sql
│
├── js/
│   ├── main.js
│   ├── home.js
│   ├── times.js
│   ├── places.js
│   ├── bloom.js
│   ├── search.js
│   ├── live.js
│   ├── state.js
│   ├── router.js
│   ├── derive.js
│   ├── weather.js
│   └── ...other modules
│
├── search/
│   └── sg-places.json.gz
│
├── tests/
│
├── requirements.txt
├── package.json
├── .gitignore
├── README.md
│
└── .env
    (local only, not committed)
```

### Important Files

| File | Purpose |
|---|---|
| `server.py` | HTTP server and application API |
| `bloomdb.py` | PostgreSQL connections and database utilities |
| `db/schema.sql` | PostgreSQL database schema |
| `placesearch.py` | Singapore venue index and fuzzy search |
| `migrate_sqlite_to_postgres.py` | Migration from SQLite |
| `js/times.js` | Availability selection |
| `js/places.js` | Place cards and voting |
| `js/bloom.js` | Final plan generation |
| `js/search.js` | Place-search interface |
| `js/weather.js` | Weather forecasts |

---

## 🔐 Security Considerations

Bloom uses group passwords and private session tokens to restrict access to group information.
The Python backend handles authorization, while Supabase provides persistent database storage.
Before production deployment, database credentials, group-access controls, rate limiting, API permissions, and privacy requirements should be reviewed and tested.
A production deployment should also use HTTPS and appropriate operational monitoring.

---

## 🌷 Future Improvements

Potential future developments include:

- User accounts and saved groups
- Push notifications
- More personalised activity recommendations
- Enhanced place and location filtering
- Improved map integration
- More sophisticated weather-aware recommendations
- Calendar-service integration
- Expanded search coverage beyond Singapore

---

## 📚 Data Sources and Acknowledgements

- **OpenStreetMap contributors** — geographic and venue information, licensed under the Open Database License (ODbL)
- **Photon** — OpenStreetMap-based place search
- **Overpass API** — OpenStreetMap data queries
- **Nominatim** — additional OpenStreetMap place details
- **Open-Meteo** — weather forecasts
- **Supabase** — hosted PostgreSQL infrastructure

Map data © OpenStreetMap contributors.

---

### Bloom

**Don't leave your plans in the bud. Make room for Bloom.**

*Because the best memories begin when plans actually happen.*
