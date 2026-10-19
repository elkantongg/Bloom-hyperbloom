#!/usr/bin/env python3
"""Bloom server: serves the website and a small JSON API backed by SQLite.

Only uses Python's standard library, so there is nothing to install.
Run:  python3 server.py   (or: npm start)
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.request
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))


def load_dotenv(path):
    """Read KEY=value lines from a local .env file (kept out of git) into the environment."""
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_dotenv(os.path.join(ROOT, ".env"))
DB_PATH = os.environ.get("BLOOM_DB", os.path.join(ROOT, "data", "bloom.db"))
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "5178"))

# Only these files are served, so the database and server code are never exposed.
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
    "/favicon.ico": ("icon.svg", "image/svg+xml"),
}

COLORS = ["#2F6FEB", "#E03131", "#D9831A", "#7C5CFF", "#11966A", "#0E8E9C", "#B4469B", "#8A6D1F", "#C2410C", "#4F46E5", "#0F766E", "#BE185D"]
PLACE_IDS = {"noodle", "bowling", "picnic", "escape", "karaoke", "cafe"}  # built-in suggestions
KINDS = {"food", "drinks", "activity", "outdoors", "other"}
MAX_CUSTOM_PLACES = 20

# Optional: Google Places API (New) fills in real details for suggested places.
# Without a key, suggestions still work, just without hours/prices/ratings.
PLACES_KEY = os.environ.get("GOOGLE_PLACES_API_KEY", "").strip()
PLACES_REGION = os.environ.get("BLOOM_REGION", "SG")
PLACES_BIAS = {"circle": {"center": {"latitude": float(os.environ.get("BLOOM_LAT", "1.3521")),
                                     "longitude": float(os.environ.get("BLOOM_LON", "103.8198"))},
                          "radius": 30000.0}}
PRICE_SYMBOLS = {"PRICE_LEVEL_FREE": "Free", "PRICE_LEVEL_INEXPENSIVE": "$", "PRICE_LEVEL_MODERATE": "$$",
                 "PRICE_LEVEL_EXPENSIVE": "$$$", "PRICE_LEVEL_VERY_EXPENSIVE": "$$$$"}
PLACES_FIELDS = ",".join([
    "places.displayName", "places.formattedAddress", "places.priceLevel", "places.rating",
    "places.userRatingCount", "places.regularOpeningHours.weekdayDescriptions",
    "places.currentOpeningHours.openNow", "places.googleMapsUri", "places.reservable", "places.websiteUri",
])


def parse_place(data):
    """Turn a Places API (New) searchText response into the small summary Bloom stores."""
    places = (data or {}).get("places") or []
    if not places:
        return None
    p = places[0]
    return {
        "name": (p.get("displayName") or {}).get("text"),
        "address": p.get("formattedAddress"),
        "price": PRICE_SYMBOLS.get(p.get("priceLevel")),
        "rating": p.get("rating"),
        "reviews": p.get("userRatingCount"),
        "hours": (p.get("regularOpeningHours") or {}).get("weekdayDescriptions") or [],
        "openNow": (p.get("currentOpeningHours") or {}).get("openNow"),
        "mapsUrl": p.get("googleMapsUri"),
        "website": p.get("websiteUri"),
        "reservable": p.get("reservable"),
    }


def lookup_place(query):
    """Ask Google Places for the best match. Returns None if there's no key or anything fails."""
    if not PLACES_KEY:
        return None
    body = json.dumps({"textQuery": query, "maxResultCount": 1, "regionCode": PLACES_REGION,
                       "languageCode": "en", "locationBias": PLACES_BIAS}).encode()
    req = urllib.request.Request("https://places.googleapis.com/v1/places:searchText", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Goog-Api-Key", PLACES_KEY)
    req.add_header("X-Goog-FieldMask", PLACES_FIELDS)
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            return parse_place(json.loads(r.read()))
    except (urllib.error.URLError, ValueError, TimeoutError) as e:
        print(f"Places lookup failed for {query!r}: {e}")
        return None
MAX_MEMBERS = 12
MAX_BODY = 16 * 1024
SLOT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}@\d{1,2}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS groups (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    host_name   TEXT NOT NULL,
    start_date  TEXT NOT NULL,
    pw_salt     BLOB NOT NULL,
    pw_hash     BLOB NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL,
    token_hash  TEXT NOT NULL,
    avail       TEXT NOT NULL DEFAULT '[]',
    votes       TEXT NOT NULL DEFAULT '{}',
    is_host     INTEGER NOT NULL DEFAULT 0,
    joined_at   INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS members_by_group ON members(group_id);
CREATE TABLE IF NOT EXISTS places (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    added_by    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS places_by_group ON places(group_id);
"""


def open_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # Write straight into bloom.db so viewers (e.g. VS Code SQLite Viewer) always see the latest data.
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    # Upgrade older databases in place.
    if "details" not in {r[1] for r in conn.execute("PRAGMA table_info(places)")}:
        conn.execute("ALTER TABLE places ADD COLUMN details TEXT")
    return conn


DB = open_db()
DB_LOCK = threading.Lock()

# Wrong-password protection: after 5 misses from one address, wait 60 seconds.
FAILS = {}
FAILS_LOCK = threading.Lock()


def hash_password(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)


def hash_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


def now():
    return int(time.time())


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def text(body, field, lo, hi):
    value = body.get(field)
    if not isinstance(value, str) or not (lo <= len(value.strip()) <= hi):
        raise ApiError(400, f"{field} must be {lo}-{hi} characters")
    return value.strip()


def new_member(group_id, name, color, is_host):
    token = secrets.token_urlsafe(24)
    member_id = secrets.token_urlsafe(8)
    DB.execute(
        "INSERT INTO members (id, group_id, name, color, token_hash, is_host, joined_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        (member_id, group_id, name, color, hash_token(token), 1 if is_host else 0, now(), now()),
    )
    return member_id, token


def group_state(group_id, member_id):
    g = DB.execute("SELECT id, title, host_name, start_date FROM groups WHERE id=?", (group_id,)).fetchone()
    rows = DB.execute(
        "SELECT id, name, color, avail, votes, is_host FROM members WHERE group_id=? ORDER BY joined_at, rowid",
        (group_id,),
    ).fetchall()
    places = DB.execute(
        "SELECT id, name, kind, added_by, details FROM places WHERE group_id=? ORDER BY created_at, rowid", (group_id,)
    ).fetchall()
    return {
        "group": {"id": g["id"], "title": g["title"], "host": g["host_name"], "startDate": g["start_date"]},
        "me": member_id,
        "places": [{"id": p["id"], "name": p["name"], "kind": p["kind"], "addedBy": p["added_by"],
                    "details": json.loads(p["details"]) if p["details"] else None} for p in places],
        "lookups": bool(PLACES_KEY),
        "members": [
            {
                "id": r["id"], "name": r["name"], "color": r["color"], "isHost": bool(r["is_host"]),
                "avail": json.loads(r["avail"]), "votes": json.loads(r["votes"]),
            }
            for r in rows
        ],
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "Bloom/1.0"

    # ----- plumbing -----
    def log_message(self, fmt, *args):
        # Keep the terminal quiet: only log API writes and errors.
        if self.command != "GET" or (len(args) > 1 and str(args[1])[:1] in "45"):
            super().log_message(fmt, *args)

    def send_json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(413, "Request too large")
        if not length:
            return {}
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            raise ApiError(400, "Invalid JSON")
        if not isinstance(body, dict):
            raise ApiError(400, "Invalid JSON")
        return body

    def auth(self, group_id):
        header = self.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        if not token:
            raise ApiError(401, "Join the group first")
        row = DB.execute(
            "SELECT id FROM members WHERE group_id=? AND token_hash=?", (group_id, hash_token(token))
        ).fetchone()
        if not row:
            raise ApiError(401, "Your session for this group has expired. Open the invite link again.")
        return row["id"]

    # ----- HTTP verbs -----
    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self.api("GET", path)
        if path not in STATIC:
            return self.send_json(404, {"error": "Not found"})
        name, ctype = STATIC[path]
        with open(os.path.join(ROOT, name), "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self.api("POST", urlparse(self.path).path)

    def do_PUT(self):
        self.api("PUT", urlparse(self.path).path)

    # ----- API -----
    def api(self, method, path):
        try:
            parts = [p for p in path.split("/") if p][1:]  # drop "api"
            # The DB lock is only held around database work. Password hashing is
            # deliberately slow, so it runs outside the lock and never blocks others.
            if method == "POST" and parts == ["groups"]:
                return self.create_group()
            if len(parts) >= 2 and parts[0] == "groups":
                gid = parts[1]
                with DB_LOCK:
                    exists = DB.execute("SELECT 1 FROM groups WHERE id=?", (gid,)).fetchone()
                if not exists:
                    raise ApiError(404, "This invite link doesn't exist or has been deleted")
                rest = parts[2:]
                if method == "GET" and rest == ["invite"]:
                    return self.invite(gid)
                if method == "POST" and rest == ["join"]:
                    return self.join(gid)
                if method == "GET" and rest == ["state"]:
                    with DB_LOCK:
                        payload = group_state(gid, self.auth(gid))
                    return self.send_json(200, payload)
                if method == "PUT" and rest == ["me"]:
                    return self.update_me(gid)
                if method == "POST" and rest == ["places"]:
                    return self.add_place(gid)
            raise ApiError(404, "Not found")
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except Exception as e:  # pragma: no cover - last-resort safety net
            self.log_error("API error: %r", e)
            self.send_json(500, {"error": "Something went wrong on the server"})

    def create_group(self):
        body = self.read_body()
        title = text(body, "title", 1, 40)
        name = text(body, "name", 1, 20)
        password = body.get("password")
        if not isinstance(password, str) or not (4 <= len(password) <= 64):
            raise ApiError(400, "Password must be 4-64 characters")
        start = body.get("startDate")
        if not isinstance(start, str) or not DATE_RE.match(start):
            start = date.today().isoformat()
        gid = secrets.token_urlsafe(6)
        salt = secrets.token_bytes(16)
        pw_hash = hash_password(password, salt)  # slow on purpose; outside the lock
        with DB_LOCK:
            DB.execute(
                "INSERT INTO groups (id, title, host_name, start_date, pw_salt, pw_hash, created_at) VALUES (?,?,?,?,?,?,?)",
                (gid, title, name, start, salt, pw_hash, now()),
            )
            member_id, token = new_member(gid, name, COLORS[0], True)
            DB.commit()
            payload = group_state(gid, member_id)
        self.send_json(201, {"groupId": gid, "memberId": member_id, "token": token, "state": payload})

    def invite(self, gid):
        with DB_LOCK:
            g = DB.execute("SELECT title, host_name FROM groups WHERE id=?", (gid,)).fetchone()
            count = DB.execute("SELECT COUNT(*) FROM members WHERE group_id=?", (gid,)).fetchone()[0]
        self.send_json(200, {"title": g["title"], "host": g["host_name"], "memberCount": count})

    def join(self, gid):
        ip = self.client_address[0]
        key = (gid, ip)
        with FAILS_LOCK:
            count, until = FAILS.get(key, (0, 0))
            if until > time.time():
                raise ApiError(429, f"Too many wrong tries. Wait {int(until - time.time()) + 1} seconds.")
        body = self.read_body()
        name = text(body, "name", 1, 20)
        password = body.get("password") if isinstance(body.get("password"), str) else ""
        with DB_LOCK:
            g = DB.execute("SELECT pw_salt, pw_hash FROM groups WHERE id=?", (gid,)).fetchone()
        # Slow on purpose (makes guessing passwords impractical); outside the lock.
        if not hmac.compare_digest(hash_password(password, g["pw_salt"]), g["pw_hash"]):
            with FAILS_LOCK:
                if len(FAILS) > 5000:  # forget stale entries so memory can't grow forever
                    stale = [k for k, (_, u) in FAILS.items() if u < time.time()]
                    for k in stale:
                        FAILS.pop(k, None)
                count += 1
                FAILS[key] = (0, time.time() + 60) if count >= 5 else (count, 0)
            raise ApiError(403, "That password doesn't match")
        with FAILS_LOCK:
            FAILS.pop(key, None)
        with DB_LOCK:
            names = [r[0].casefold() for r in DB.execute("SELECT name FROM members WHERE group_id=?", (gid,)).fetchall()]
            if name.casefold() in names:
                raise ApiError(409, f"Someone called {name} is already in this group. Add an initial, like “{name} T”.")
            if len(names) >= MAX_MEMBERS:
                raise ApiError(403, f"This group is full ({MAX_MEMBERS} people max)")
            member_id, token = new_member(gid, name, COLORS[len(names) % len(COLORS)], False)
            DB.commit()
            payload = group_state(gid, member_id)
        self.send_json(201, {"groupId": gid, "memberId": member_id, "token": token, "state": payload})

    def update_me(self, gid):
        body = self.read_body()
        avail = votes = None
        if "avail" in body:
            avail = body["avail"]
            if not isinstance(avail, list) or len(avail) > 200 or not all(isinstance(s, str) and SLOT_RE.match(s) for s in avail):
                raise ApiError(400, "Invalid availability")
        if "votes" in body:
            votes = body["votes"]
            # type() check rejects true/false, which Python would otherwise treat as 1/0.
            if not isinstance(votes, dict) or not all(isinstance(k, str) and type(v) is int and v in (-1, 0, 1) for k, v in votes.items()):
                raise ApiError(400, "Invalid votes")
        with DB_LOCK:
            member_id = self.auth(gid)
            if votes is not None:
                allowed = PLACE_IDS | {r[0] for r in DB.execute("SELECT id FROM places WHERE group_id=?", (gid,))}
                if not set(votes) <= allowed:
                    raise ApiError(400, "Invalid votes")
            if avail is not None:
                DB.execute("UPDATE members SET avail=?, updated_at=? WHERE id=?", (json.dumps(sorted(set(avail))), now(), member_id))
            if votes is not None:
                DB.execute("UPDATE members SET votes=?, updated_at=? WHERE id=?", (json.dumps(votes), now(), member_id))
            DB.commit()
            payload = group_state(gid, member_id)
        self.send_json(200, payload)

    def add_place(self, gid):
        body = self.read_body()
        name = text(body, "name", 1, 40)
        kind = body.get("kind")
        if kind not in KINDS:
            raise ApiError(400, "Pick a type: food, drinks, activity, outdoors or other")
        with DB_LOCK:
            self.auth(gid)  # check membership before spending an API call
        details = lookup_place(name)  # network call, so it runs outside the lock
        with DB_LOCK:
            member_id = self.auth(gid)
            existing = [r[0].casefold() for r in DB.execute("SELECT name FROM places WHERE group_id=?", (gid,))]
            if name.casefold() in existing:
                raise ApiError(409, f"“{name}” is already in the deck")
            if len(existing) >= MAX_CUSTOM_PLACES:
                raise ApiError(403, f"This group already has {MAX_CUSTOM_PLACES} suggestions")
            DB.execute(
                "INSERT INTO places (id, group_id, name, kind, added_by, created_at, details) VALUES (?,?,?,?,?,?,?)",
                ("p_" + secrets.token_urlsafe(6), gid, name, kind, member_id, now(), json.dumps(details) if details else None),
            )
            DB.commit()
            payload = group_state(gid, member_id)
        self.send_json(201, payload)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Bloom is running at http://localhost:{PORT}  (database: {os.path.relpath(DB_PATH, ROOT)})")
    print("Google Places lookups: " + ("ON" if PLACES_KEY else "off (add GOOGLE_PLACES_API_KEY to .env to turn on)"))
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
