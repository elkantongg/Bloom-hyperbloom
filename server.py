#!/usr/bin/env python3
"""Bloom server: serves the website and a small JSON API backed by PostgreSQL (Supabase).

Needs DATABASE_URL in .env and the packages in requirements.txt (psycopg).
Run:  python3 server.py   (or: npm start)
"""
import hashlib
import html
import ipaddress
import socket
from html.parser import HTMLParser
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import parse_qs, urlparse

import placesearch
from bloomdb import Database, DatabaseConfigError, Jsonb, database_url, psycopg, redact

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
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "5178"))

# Only these files are served, so the database and server code are never exposed.
JS_FILE = re.compile(r"/js/[a-z]+\.js")  # only plain module names, so no ../ tricks
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
    "/favicon.ico": ("icon.svg", "image/svg+xml"),
}

COLORS = ["#2F6FEB", "#E03131", "#D9831A", "#7C5CFF", "#11966A", "#0E8E9C", "#B4469B", "#8A6D1F", "#C2410C", "#4F46E5", "#0F766E", "#BE185D"]
KINDS = {"food", "drinks", "activity", "shopping", "other"}
MAX_CUSTOM_PLACES = 20
MAX_PLACE_NAME = 80  # e.g. "Escape Room (Orchard Gateway)"
MAX_MEMBERS = 12
MAX_BODY = 16 * 1024
SLOT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}@\d{1,2}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---------- Free place search (no key, no sign-up) ----------
# Photon (built on OpenStreetMap) gives search-as-you-type with typo tolerance.
# Picking a result loads its OpenStreetMap details, plus a Wikimedia photo of that
# exact place when one exists (otherwise the card shows a map pinned on it).
UA = "Bloom-hackathon-prototype/1.0 (https://github.com/elkantongg/hyperbloom)"
REGION = os.environ.get("BLOOM_REGION", "sg")
SG_BBOX = os.environ.get("BLOOM_BBOX", "103.59,1.15,104.10,1.48")  # minLon,minLat,maxLon,maxLat
PHOTON = os.environ.get("BLOOM_PHOTON", "https://photon.komoot.io/api/")
LOOKUP_CACHE = {}          # query -> (time, results)
LOOKUP_LOCK = threading.Lock()
LAST_OSM_CALL = [0.0]      # OpenStreetMap asks for at most 1 request per second
LOOKUP_HITS = {}           # (ip, bucket) -> [timestamps], simple rate limit
OSM_ID = re.compile(r"osm:([NWR])(\d{1,15})")
SKIP_KEYS = {"highway", "railway", "power", "waterway", "route", "public_transport", "landuse"}

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
OSM_DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]


def osm_hours_to_week(spec):
    """'Mo-Th 10:00-19:00; Fr-Sa 10:00-22:00' -> ['Monday: 10:00 – 19:00', ...].
    Returns [] for formats we don't understand (the raw text is shown instead)."""
    if not spec:
        return []
    if spec.strip() == "24/7":
        return [f"{d}: Open 24 hours" for d in DAY_NAMES]
    week = [None] * 7
    for rule in spec.split(";"):
        rule = rule.strip()
        if re.fullmatch(r"[0-9:\-, ]+", rule):  # times only = every day
            rule = "Mo-Su " + rule
        m = re.fullmatch(r"([A-Za-z,\- ]+?)\s+([0-9:\-, ]+|off|closed)", rule)
        if not m:
            return []
        idx = []
        for part in m.group(1).replace(" ", "").split(","):
            if "-" in part:
                a, b = part.split("-", 1)
                if a not in OSM_DAYS or b not in OSM_DAYS:
                    return []
                i, j = OSM_DAYS.index(a), OSM_DAYS.index(b)
                idx += list(range(i, j + 1)) if i <= j else list(range(i, 7)) + list(range(0, j + 1))
            elif part in OSM_DAYS:
                idx.append(OSM_DAYS.index(part))
            else:
                return []
        times = m.group(2).strip()
        label = "Closed" if times in ("off", "closed") else times.replace("-", " – ").replace(",", ", ")
        for i in idx:
            week[i] = label
    return [f"{DAY_NAMES[i]}: {week[i] or 'Closed'}" for i in range(7)]


def price_text(e):
    """A rough price tier, not an exact price (map prices go out of date):
    free / $ (under S$15) / $$ (S$15–40) / $$$ (over S$40). None if unknown."""
    if e.get("fee") == "no":
        return "Free"
    m = re.search(r"(\d+(?:\.\d+)?)", e.get("charge") or "")
    if not m or "SGD" not in (e.get("charge") or "").upper():
        return None
    amount = float(m.group(1))
    return "Free" if amount == 0 else "$" if amount < 15 else "$$" if amount <= 40 else "$$$"


PHOTO_CACHE = {}  # wikidata id -> Commons file name (or "")


def wikidata_photos(ids):
    """Main photo (Wikidata P18, hosted on Wikimedia Commons) for each id. Free, no key."""
    want = [i for i in dict.fromkeys(ids) if i and re.fullmatch(r"Q\d+", i) and i not in PHOTO_CACHE]
    if want:
        qs = urllib.parse.urlencode({"action": "wbgetentities", "ids": "|".join(want[:50]),
                                     "props": "claims", "format": "json"})
        req = urllib.request.Request("https://www.wikidata.org/w/api.php?" + qs, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=6) as r:
                entities = json.loads(r.read()).get("entities", {})
        except (urllib.error.URLError, ValueError, TimeoutError, OSError) as e:
            print(f"Photo lookup failed: {e}")
            entities = {}
        for i in want:
            claims = (entities.get(i) or {}).get("claims", {}).get("P18", [])
            snak = claims[0]["mainsnak"] if claims else {}
            PHOTO_CACHE[i] = (snak.get("datavalue") or {}).get("value") or ""
    return {i: PHOTO_CACHE.get(i, "") for i in ids if i}


def osm_get(url):
    """GET from OpenStreetMap services, at most one request per second (their usage policy)."""
    with LOOKUP_LOCK:
        wait = 1.1 - (time.time() - LAST_OSM_CALL[0])
        if wait > 0:
            time.sleep(wait)
        LAST_OSM_CALL[0] = time.time()
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=6) as r:
        return json.loads(r.read())


def maps_url(name, address):
    """Google Maps link for a place (official public URL format, no key needed)."""
    q = ", ".join(x for x in (name, address) if x)
    return "https://www.google.com/maps/search/?api=1&query=" + urllib.parse.quote(q)


# Types, category words and name matching live in placesearch.py (shared with the index).
kind_of, matches_kind, nice_label = placesearch.kind_of, placesearch.matches_kind, placesearch.nice_label
PAGE = 10                  # suggestions shown at a time ("Show more results" loads the next 10)
PHOTON_MODE = os.environ.get("BLOOM_PHOTON_MODE", "auto")  # auto | always | off
PHOTON_PAUSE = [0.0, 30.0]  # [paused until, next pause length]: back off when Photon is busy


def photon_query(text, kind):
    """Photon (free OpenStreetMap geocoder): up to 25 named places, Singapore only."""
    if time.time() < PHOTON_PAUSE[0]:
        raise TimeoutError("Photon paused after errors")
    qs = urllib.parse.urlencode({"q": text, "limit": 25, "lang": "en", "bbox": SG_BBOX,
                                 "lat": 1.3521, "lon": 103.8198})
    try:
        with urllib.request.urlopen(urllib.request.Request(PHOTON + "?" + qs, headers={"User-Agent": UA}), timeout=5) as r:
            features = json.loads(r.read()).get("features") or []
        PHOTON_PAUSE[1] = 30.0
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        # Busy or down: stop asking for a while (30 s, doubling to 15 min).
        PHOTON_PAUSE[0] = time.time() + PHOTON_PAUSE[1]
        PHOTON_PAUSE[1] = min(PHOTON_PAUSE[1] * 2, 900.0)
        raise
    out, seen = [], set()
    for f in features:
        p = f.get("properties") or {}
        key, value = p.get("osm_key"), p.get("osm_value")
        if not p.get("name") or key in SKIP_KEYS or not p.get("osm_id"):
            continue
        # The search box is a rectangle, which also covers bits of Johor and Riau.
        if (p.get("countrycode") or "SG").upper() != "SG":
            continue
        street = " ".join(x for x in (p.get("housenumber"), p.get("street")) if x)
        area = p.get("district") or p.get("locality") or p.get("city")
        where = ", ".join(x for x in (street, area) if x and x != p["name"])
        dup = (p["name"].casefold(), where.casefold())
        if dup in seen:
            continue
        seen.add(dup)
        lon, lat = ((f.get("geometry") or {}).get("coordinates") or [None, None])[:2]
        out.append({"placeId": f"osm:{p.get('osm_type')}{p['osm_id']}", "main": p["name"],
                    "category": nice_label(value), "secondary": where,
                    "categoryMatch": matches_kind(key, value, kind),
                    "_key": key, "_value": value, "_lat": lat, "_lon": lon})
    return out


def index_result(idx, pi, kind):
    p = idx.places[pi]
    return {"placeId": "osm:" + p["i"], "main": p["n"], "category": placesearch.category_text(p) or "",
            "secondary": placesearch.where_text(p), "categoryMatch": matches_kind(p.get("k"), p.get("v"), kind)}


def ranked_search(text, kind):
    """Every match, best first: the local index (typo-tolerant, all branches) merged with
    Photon (live, covers what the index doesn't). Cached for an hour."""
    key = (placesearch.norm(text), kind)
    hit = LOOKUP_CACHE.get(key)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    idx = placesearch.load()
    ranked, did_you_mean, branches, q, confident = [], None, None, None, False
    if idx:
        q, found = idx.search(text, kind)
        for s, pi, how, alias, loc in found:
            ranked.append((s, index_result(idx, pi, kind), idx.places[pi]))
        if found:
            s, pi, how, alias, loc = found[0]
            p = idx.places[pi]
            # A category search ("cafe", "bubble tea Bugis") is a real answer, not a near miss.
            confident = s >= placesearch.CONFIDENT or how == "category"
            # "McDonald's · 148 branches in Singapore"
            main = idx.main_brand(found)
            if main:
                # "area": the location they typed, so the tip doesn't ask for one again
                branches = {"name": main[0], "count": main[1], "area": loc[0].title() if loc else None}
            # A confident correction ("macdonalds" -> McDonald's), never a weak guess. Suggest the
            # chain's name rather than one oddly spelled outlet.
            if how == "fuzzy" and s >= 0.8 and alias:
                guess = ((main[0] if main else alias) + (" " + loc[0].title() if loc else "")).strip()
                if placesearch.norm(guess) != placesearch.norm(text):
                    did_you_mean = guess
    # Photon fills gaps (blocks, buildings, places the index doesn't keep). In "auto" mode
    # it's skipped when the index already answered well, to stay within its fair use.
    strong = sum(1 for r in ranked if r[0] >= 0.9)
    if PHOTON_MODE == "always" or (PHOTON_MODE == "auto" and (not idx or strong < PAGE)):
        try:
            extra = photon_query(text, kind)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
            if not idx:
                raise
            print(f"Photon unavailable, using the local index only: {e}")
            extra = []
        have = {r[1]["placeId"] for r in ranked}
        points = [(placesearch.norm(r[2]["n"]), r[2]["y"], r[2]["x"]) for r in ranked[:MAX_MERGE]]
        for rank, r in enumerate(extra):
            if r["placeId"] in have:
                continue
            n = placesearch.norm(r["main"])
            if r["_lat"] is not None and any(n == pn and placesearch.meters(r["_lat"], r["_lon"], py, px) < 80 for pn, py, px in points):
                continue  # same venue, already listed from the index
            if idx:
                s = idx.score_external(q, r["main"], r["secondary"], r["_lat"], r["_lon"], r["_key"], r["_value"], kind)
                # Photon also matches addresses and areas, so keep its order for weak name matches.
                s = s if s >= placesearch.KEEP else 0.6 - rank * 0.005
            else:
                s = 1.0 - rank * 0.01 + (0.05 if r["categoryMatch"] else 0)
            ranked.append((s, {k: v for k, v in r.items() if not k.startswith("_")}, None))
        ranked.sort(key=lambda r: -r[0])
    confident = confident or bool(ranked) and ranked[0][0] >= placesearch.CONFIDENT
    result = {"ranked": [(round(s, 3), r) for s, r, _p in ranked[:placesearch.MAX_RESULTS]],
              "didYouMean": did_you_mean, "branches": branches, "confident": confident}
    LOOKUP_CACHE[key] = (time.time(), result)
    if len(LOOKUP_CACHE) > 3000:
        LOOKUP_CACHE.pop(next(iter(LOOKUP_CACHE)))
    return result


MAX_MERGE = 400  # index results checked when spotting Photon duplicates


def free_autocomplete(text, kind="other", offset=0):
    """One page of suggestions. Same fields as before ("results", "approximate", "used")
    plus "total", "more", "offset", "didYouMean" and "branches"."""
    found = ranked_search(text, kind)
    ranked = found["ranked"]
    page = [r for _s, r in ranked[offset:offset + PAGE]]
    return {"results": page, "approximate": bool(ranked) and not found["confident"], "used": text,
            "total": len(ranked), "offset": offset, "more": offset + PAGE < len(ranked),
            "didYouMean": found["didYouMean"], "branches": found["branches"]}


def index_details(place_id):
    """A card's details straight from the local index (no Nominatim call needed)."""
    idx = placesearch.load()
    m = OSM_ID.fullmatch(place_id or "")
    pi = idx.by_id.get(m.group(1) + m.group(2)) if idx and m else None
    if pi is None:
        return None
    p = idx.places[pi]
    unit = p.get("u") or (("Level " + p["lv"]) if p.get("lv") and p["lv"].lstrip("-").isdigit() else None)
    address = ", ".join(x for x in (unit, " ".join(x for x in (p.get("h"), p.get("s")) if x), p.get("p")) if x) or None
    tags = {"fee": p.get("f"), "charge": p.get("ch")}
    photo = wikidata_photos([p["wd"]]).get(p["wd"], "") if p.get("wd") else ""
    return {
        "source": "osm", "placeId": place_id, "name": p["n"],
        # Branch label for the card: "Din Tai Fung (Tampines Mall)"
        "area": p.get("m") or p.get("hn") or p.get("r") or p.get("a"), "address": address,
        "category": placesearch.category_text(p), "kind": kind_of(p.get("k"), p.get("v")),
        "price": price_text({k: v for k, v in tags.items() if v}),
        "hours": osm_hours_to_week(p.get("o")), "hoursText": p.get("o"),
        "website": p.get("w"), "phone": p.get("t"),
        "stepFree": {"yes": True, "no": False}.get(p.get("wc")),
        "photo": photo or None,  # only this place's own photo, never the brand's
        "lat": p["y"], "lon": p["x"],
        "mapsUrl": maps_url(p["n"], ", ".join(x for x in (p.get("m"), address) if x)),
    }


def osm_details(place_id):
    """Everything OpenStreetMap knows about one place, ready for a card."""
    m = OSM_ID.fullmatch(place_id)
    if not m:
        return None
    hit = LOOKUP_CACHE.get(place_id)
    if hit and time.time() - hit[0] < 86400:
        return hit[1]
    qs = urllib.parse.urlencode({"osm_ids": m.group(1) + m.group(2), "format": "jsonv2",
                                 "extratags": 1, "addressdetails": 1})
    rows = osm_get("https://nominatim.openstreetmap.org/lookup?" + qs)
    if not rows:
        return None
    row = rows[0]
    a = row.get("address") or {}
    e = row.get("extratags") or {}
    name = row.get("name") or (row.get("display_name") or "").split(",")[0]
    street = " ".join(x for x in (a.get("house_number"), a.get("road")) if x)
    area = a.get("suburb") or a.get("city_district") or a.get("neighbourhood") or a.get("quarter")
    address = ", ".join(x for x in (street, area, a.get("postcode")) if x) or None
    cuisine = (e.get("cuisine") or "").split(";")[0].replace("_", " ").strip()
    value = (row.get("type") or "").replace("_", " ")
    if value in ("yes", "no"):  # e.g. building=yes says nothing useful
        value = (row.get("category") or "").replace("_", " ")
    photo = wikidata_photos([e.get("wikidata")]).get(e.get("wikidata"), "") if e.get("wikidata") else ""
    out = {
        "source": "osm", "placeId": place_id, "name": name, "area": area, "address": address,
        "category": (cuisine.title() + " " + value).strip() if cuisine else value.capitalize() or None,
        "kind": kind_of(row.get("category"), row.get("type")),
        "price": price_text(e),
        "hours": osm_hours_to_week(e.get("opening_hours")), "hoursText": e.get("opening_hours"),
        "website": e.get("website") or e.get("contact:website") or e.get("url"),
        "phone": e.get("phone") or e.get("contact:phone"),
        "stepFree": {"yes": True, "no": False}.get(e.get("wheelchair")),
        # Only a photo of THIS place (its own Wikidata entry), never a brand's or a generic one.
        "photo": photo or None,
        "lat": round(float(row["lat"]), 6) if row.get("lat") else None,
        "lon": round(float(row["lon"]), 6) if row.get("lon") else None,
        "mapsUrl": maps_url(name, address),
    }
    LOOKUP_CACHE[place_id] = (time.time(), out)
    return out


# ---------- Link previews ("Can't find it? Add a link") ----------
# Reads a page's title / image / description (Open Graph tags) to build a card.
# Fetching URLs that strangers paste is risky, so: public http(s) hosts only (no
# private or local addresses, checked on every redirect), small size and time limits,
# HTML pages only, and a per-person rate limit.
LINK_MAX_BYTES = 600_000


def public_host(host):
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    return bool(infos) and all(ipaddress.ip_address(i[4][0].split("%")[0]).is_global for i in infos)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # we follow redirects ourselves so every hop gets checked


class _Meta(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta, self.title, self._in_title = {}, "", False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta":
            k = (a.get("property") or a.get("name") or "").lower()
            if k and a.get("content") and k not in self.meta:
                self.meta[k] = a["content"]
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and len(self.title) < 300:
            self.title += data


LINK_UA = "Mozilla/5.0 (compatible; BloomLinkPreview/1.0; +https://github.com/elkantongg/hyperbloom)"
GMAPS_PLACE = re.compile(r"/maps/place/([^/?]+)")
GMAPS_AT = re.compile(r"@(-?\d+\.\d+),(-?\d+\.\d+)")


def host_name(url):
    return (urllib.parse.urlparse(url).hostname or "").removeprefix("www.")


def slug_name(url):
    """'https://www.klook.com/activity/1593-laser-tag-singapore/' -> 'Laser Tag Singapore'."""
    path = urllib.parse.urlparse(url).path
    if "-Reviews-" in path:  # TripAdvisor: ...-Reviews-Laser_Quest-Singapore.html
        path = path.split("-Reviews-", 1)[1]
    parts = [p for p in path.split("/") if p]
    for p in reversed(parts):
        words = re.sub(r"[-_+]+", " ", urllib.parse.unquote(p)).split()
        words = [w for w in re.sub(r"\.html?$", "", " ".join(words)).split()
                 if not re.fullmatch(r"[a-z]?\d+|[a-z]{2}(-[a-z]{2})?|html?|index|en", w, re.I)]
        if len(" ".join(words)) >= 3:
            return " ".join(w if w.isupper() else w.capitalize() for w in words)[:80]
    return host_name(url)


def google_maps_link(url):
    """Google Maps links carry the place name and position in the URL itself."""
    u = urllib.parse.urlparse(url)
    if not (u.hostname or "").endswith(("google.com", "google.com.sg")) or "/maps" not in u.path:
        return None
    m = GMAPS_PLACE.search(u.path)
    name = urllib.parse.unquote_plus(m.group(1)) if m else (urllib.parse.parse_qs(u.query).get("q") or [""])[0]
    at = GMAPS_AT.search(url)
    return {"source": "link", "name": name[:80] or "Place on Google Maps", "description": None,
            "siteName": "Google Maps", "image": None, "website": url,
            "lat": float(at.group(1)) if at else None, "lon": float(at.group(2)) if at else None}


GENERIC = re.compile(r"^(home|homepage|welcome|official (web)?site|index)$", re.I)


def nice_title(title, site):
    """'Home - Superbowl' -> 'Superbowl'; 'Name (@handle) • Instagram photos and videos' -> 'Name'."""
    t = re.sub(r"\s*[•|·]\s*Instagram.*$", "", title or "").strip()
    handle = re.search(r"\(@([\w.]+)\)", t)
    t = re.sub(r"\s*\(@[\w.]+\)\s*", " ", t).strip()
    parts = [p.strip() for p in re.split(r"\s[|\-–—·•:]\s", t) if p.strip()]
    parts = [p for p in parts if not GENERIC.match(p)] or parts
    best = parts[0] if parts else ""
    return best or (handle.group(1) if handle else "") or site or ""


def link_preview(url):
    """Build a card from a link. Never fails on a normal public link: if the site
    blocks robots (Klook, TripAdvisor...), the name comes from the link's own words
    and people can edit it before adding."""
    opener = urllib.request.build_opener(_NoRedirect)
    original = url
    fallback = {"source": "link", "name": slug_name(url), "description": None, "siteName": host_name(url),
                "image": None, "website": url, "partial": True}
    for _ in range(5):
        u = urllib.parse.urlparse(url)
        if u.scheme not in ("http", "https") or not u.hostname or not public_host(u.hostname):
            raise ApiError(400, "That link can't be opened. Use a normal public website link.")
        gm = google_maps_link(url)
        if gm:
            gm["website"] = original  # keep the link the person shared
            return gm
        req = urllib.request.Request(url, headers={"User-Agent": LINK_UA, "Accept": "text/html",
                                                   "Accept-Language": "en-SG,en;q=0.9"})
        try:
            resp = opener.open(req, timeout=6)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                url = urllib.parse.urljoin(url, e.headers["Location"])
                continue
            return fallback  # the site blocked us; use the link's own words
        except (urllib.error.URLError, TimeoutError, OSError):
            return fallback
        with resp:
            if "html" not in (resp.headers.get("Content-Type") or ""):
                return fallback
            body = resp.read(LINK_MAX_BYTES).decode(resp.headers.get_content_charset() or "utf-8", "replace")
            final = resp.geturl()
        break
    else:
        return fallback
    parser = _Meta()
    try:
        parser.feed(body)
    except Exception:
        pass
    m = parser.meta
    clean = lambda t, n: html.unescape(" ".join((t or "").split()))[:n] or None
    image = m.get("og:image") or m.get("og:image:url") or m.get("twitter:image")
    image = urllib.parse.urljoin(final, image) if image else None
    return {
        "source": "link",
        "name": nice_title(clean(m.get("og:title") or m.get("twitter:title") or parser.title, 120),
                           clean(m.get("og:site_name"), 60))[:80] or slug_name(original),
        "description": clean(m.get("og:description") or m.get("description") or m.get("twitter:description"), 200),
        "siteName": clean(m.get("og:site_name"), 60) or urllib.parse.urlparse(final).hostname,
        "image": image if image and image.startswith("https://") else None,
        "website": original,
    }


# ---------- Google Places (optional, needs GOOGLE_PLACES_API_KEY in .env) ----------
# Works like a mini Google Maps: autocomplete (with typo correction), then the
# exact place's details and photo. The key never leaves the server.
GOOGLE_KEY = os.environ.get("GOOGLE_PLACES_API_KEY", "").strip()
GOOGLE_BASE = os.environ.get("GOOGLE_PLACES_BASE", "https://places.googleapis.com/v1").rstrip("/")
GOOGLE_PRICE = {"PRICE_LEVEL_FREE": "Free", "PRICE_LEVEL_INEXPENSIVE": "$", "PRICE_LEVEL_MODERATE": "$$",
                "PRICE_LEVEL_EXPENSIVE": "$$$", "PRICE_LEVEL_VERY_EXPENSIVE": "$$$$"}
GOOGLE_BIAS = {"circle": {"center": {"latitude": 1.3521, "longitude": 103.8198}, "radius": 50000.0}}
DETAIL_FIELDS = ",".join([
    "id", "displayName", "formattedAddress", "shortFormattedAddress", "location", "primaryType",
    "primaryTypeDisplayName", "priceLevel", "rating", "userRatingCount", "regularOpeningHours.weekdayDescriptions",
    "currentOpeningHours.openNow", "googleMapsUri", "websiteUri", "reservable",
    "accessibilityOptions.wheelchairAccessibleEntrance", "photos",
])
PHOTO_URIS = {}  # photo name -> (time, short-lived image URL)
PLACE_ID = re.compile(r"[A-Za-z0-9_-]{10,300}")
PHOTO_NAME = re.compile(r"places/[A-Za-z0-9_-]{10,300}/photos/[A-Za-z0-9_-]{10,600}")
SESSION = re.compile(r"[A-Za-z0-9-]{8,64}")


def google(path, body=None, fields=None, params=None):
    url = GOOGLE_BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 method="POST" if body is not None else "GET")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Goog-Api-Key", GOOGLE_KEY)
    if fields:
        req.add_header("X-Goog-FieldMask", fields)
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read() or b"{}")


GOOGLE_TYPES = {"food": ["restaurant", "bakery", "meal_takeaway", "food_court"], "drinks": ["cafe", "bar", "coffee_shop"]}


def google_autocomplete(text, session, kind="other"):
    data = google("/places:autocomplete", {
        "input": text, "includedRegionCodes": [REGION], "languageCode": "en",
        "locationBias": GOOGLE_BIAS, **({"sessionToken": session} if session else {}),
        **({"includedPrimaryTypes": GOOGLE_TYPES[kind]} if kind in GOOGLE_TYPES else {}),
    })
    out = []
    for s_ in data.get("suggestions") or []:
        p = s_.get("placePrediction")
        if not p or not p.get("placeId"):
            continue
        fmt = p.get("structuredFormat") or {}
        out.append({"placeId": p["placeId"],
                    "main": (fmt.get("mainText") or {}).get("text") or (p.get("text") or {}).get("text"),
                    "secondary": (fmt.get("secondaryText") or {}).get("text")})
    return out[:6]


def kind_from_type(t):
    t = t or ""
    if t in ("cafe", "coffee_shop", "bar", "pub", "wine_bar", "tea_house", "juice_shop", "night_club") or "bar" in t:
        return "drinks"
    if t.endswith("restaurant") or t in ("bakery", "meal_takeaway", "food_court", "dessert_shop", "ice_cream_shop", "food"):
        return "food"
    return "activity"


def google_details(place_id, session):
    p = google("/places/" + place_id, fields=DETAIL_FIELDS, params={"sessionToken": session} if session else None)
    photo = (p.get("photos") or [{}])[0]
    author = (photo.get("authorAttributions") or [{}])[0]
    loc = p.get("location") or {}
    return {
        "source": "google", "placeId": p.get("id") or place_id,
        "name": (p.get("displayName") or {}).get("text"),
        "address": p.get("formattedAddress"), "area": p.get("shortFormattedAddress"),
        "category": (p.get("primaryTypeDisplayName") or {}).get("text"),
        "kind": kind_from_type(p.get("primaryType")),
        "price": GOOGLE_PRICE.get(p.get("priceLevel")),
        "rating": p.get("rating"), "reviews": p.get("userRatingCount"),
        "hours": (p.get("regularOpeningHours") or {}).get("weekdayDescriptions") or [],
        "openNow": (p.get("currentOpeningHours") or {}).get("openNow"),
        "mapsUrl": p.get("googleMapsUri"), "website": p.get("websiteUri"),
        "reservable": p.get("reservable"),
        "stepFree": (p.get("accessibilityOptions") or {}).get("wheelchairAccessibleEntrance"),
        "lat": loc.get("latitude"), "lon": loc.get("longitude"),
        "photoRef": photo.get("name"),
        # Google asks apps to credit the photo's author.
        "photoBy": author.get("displayName"), "photoByUrl": author.get("uri"),
    }


def google_photo_uri(name):
    hit = PHOTO_URIS.get(name)
    if hit and time.time() - hit[0] < 1800:
        return hit[1]
    data = google("/" + name + "/media", params={"maxWidthPx": 800, "skipHttpRedirect": "true"})
    uri = data.get("photoUri")
    if uri:
        PHOTO_URIS[name] = (time.time(), uri)
        if len(PHOTO_URIS) > 3000:
            PHOTO_URIS.pop(next(iter(PHOTO_URIS)))
    return uri


def rate_ok(ip, bucket, limit):
    """Simple per-person limit so nobody can run up the Google bill."""
    k = (ip, bucket)
    recent = [t for t in LOOKUP_HITS.get(k, []) if t > time.time() - 60]
    if len(recent) >= limit:
        return False
    LOOKUP_HITS[k] = recent + [time.time()]
    if len(LOOKUP_HITS) > 5000:
        LOOKUP_HITS.clear()
    return True


def clean_details(d):
    """The confirmed match arrives from the browser, so keep only short plain-text fields."""
    if not isinstance(d, dict):
        return None
    def s(v, n):
        return v.strip()[:n] if isinstance(v, str) and v.strip() else None
    def url(v):
        return v.strip()[:300] if isinstance(v, str) and re.match(r"https?://[^\s\"'<>]+$", v.strip()) else None
    def coord(v, limit):
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and -limit <= v <= limit else None
    hours = d.get("hours") if isinstance(d.get("hours"), list) else []
    out = {"area": s(d.get("area"), 60), "address": s(d.get("address"), 200), "category": s(d.get("category"), 60),
           "price": d.get("price") if d.get("price") in ("Free", "$", "$$", "$$$") else None, "hours": [h for h in (s(x, 60) for x in hours[:7]) if h],
           "hoursText": s(d.get("hoursText"), 120), "website": url(d.get("website")), "phone": s(d.get("phone"), 30),
           # A Wikimedia Commons file name; the browser builds the image URL from it.
           "photo": s(d.get("photo"), 200) if isinstance(d.get("photo"), str) and "/" not in d.get("photo") else None,
           "lat": coord(d.get("lat"), 90), "lon": coord(d.get("lon"), 180)}
    def b(v):
        return v if isinstance(v, bool) else None
    def num(v, hi):
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= hi else None
    if d.get("source") == "manual":
        out.update({"source": "manual", "name": s(d.get("name"), 80), "area": s(d.get("area"), 60), "description": s(d.get("description"), 200)})
    if d.get("source") == "link":
        out.update({"source": "link", "name": s(d.get("name"), 80), "description": s(d.get("description"), 200),
                    "siteName": s(d.get("siteName"), 60), "website": url(d.get("website")),
                    "image": d.get("image")[:500] if isinstance(d.get("image"), str) and re.match(r"https://[^\s\"'<>]+$", d["image"]) else None})
    if d.get("source") == "osm":
        out.update({"source": "osm", "name": s(d.get("name"), 80), "mapsUrl": url(d.get("mapsUrl")),
                    "stepFree": b(d.get("stepFree")),
                    "placeId": d.get("placeId") if isinstance(d.get("placeId"), str) and OSM_ID.fullmatch(d["placeId"]) else None})
    if d.get("source") == "google":
        out.update({
            "source": "google",
            "placeId": d.get("placeId") if isinstance(d.get("placeId"), str) and PLACE_ID.fullmatch(d["placeId"]) else None,
            "name": s(d.get("name"), 80), "price": d.get("price") if d.get("price") in GOOGLE_PRICE.values() else None,
            "rating": num(d.get("rating"), 5), "reviews": num(d.get("reviews"), 10_000_000),
            "openNow": b(d.get("openNow")), "reservable": b(d.get("reservable")), "stepFree": b(d.get("stepFree")),
            "mapsUrl": url(d.get("mapsUrl")),
            "photoRef": d.get("photoRef") if isinstance(d.get("photoRef"), str) and PHOTO_NAME.fullmatch(d["photoRef"]) else None,
            "photoBy": s(d.get("photoBy"), 80), "photoByUrl": url(d.get("photoByUrl")),
        })
    return out if any(out.values()) else None

# The tables live in db/schema.sql. DB is set by init_database() (main, or the tests).
DB = None


def init_database(url=None, **options):
    """Connect to PostgreSQL and create any missing tables. Raises DatabaseConfigError
    with a clear, password-free message if DATABASE_URL is missing or unusable."""
    global DB
    db = Database(url or database_url(), **options).open()
    try:
        db.apply_schema()
    except psycopg.Error as e:
        db.close()
        raise DatabaseConfigError("Couldn't set up the Bloom tables: " + redact(e, db.url)) from None
    DB = db
    return db


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


def new_member(conn, group_id, name, color, is_host):
    token = secrets.token_urlsafe(24)
    member_id = secrets.token_urlsafe(8)
    conn.execute(
        "INSERT INTO members (id, group_id, name, color, token_hash, is_host, joined_at, updated_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
        (member_id, group_id, name, color, hash_token(token), bool(is_host), now(), now()),
    )
    return member_id, token


def group_state(conn, group_id, member_id):
    g = conn.execute("SELECT id, title, host_name, start_date FROM groups WHERE id=%s", (group_id,)).fetchone()
    rows = conn.execute(
        "SELECT id, name, color, avail, votes, is_host FROM members WHERE group_id=%s ORDER BY joined_at, seq",
        (group_id,),
    ).fetchall()
    places = conn.execute(
        "SELECT id, name, kind, added_by, details FROM places WHERE group_id=%s ORDER BY created_at, seq", (group_id,)
    ).fetchall()
    return {
        "group": {"id": g["id"], "title": g["title"], "host": g["host_name"], "startDate": g["start_date"]},
        "me": member_id,
        "places": [{"id": p["id"], "name": p["name"], "kind": p["kind"], "addedBy": p["added_by"],
                    "details": p["details"] or None} for p in places],
        "members": [
            {
                "id": r["id"], "name": r["name"], "color": r["color"], "isHost": bool(r["is_host"]),
                "avail": r["avail"], "votes": r["votes"],
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

    # Sent with every response: no embedding in other sites, no MIME sniffing, limited
    # referrer info, and a content policy that only allows our own scripts.
    CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
           "font-src https://fonts.gstatic.com; img-src 'self' data: https:; "
           "connect-src 'self' https://api.open-meteo.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

    def client_ip(self):
        """Who's asking, for rate limits and the wrong-password lockout. On Vercel every
        request arrives from its proxy, which puts the visitor's real address in
        X-Forwarded-For (and overwrites any value the visitor sent). Elsewhere that header
        could be faked, so it's only trusted on Vercel."""
        if os.environ.get("VERCEL"):
            fwd = (self.headers.get("X-Forwarded-For") or self.headers.get("X-Real-IP") or "").split(",")[0].strip()
            if fwd:
                return fwd[:64]
        return self.client_address[0]

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Content-Security-Policy", self.CSP)
        super().end_headers()

    def send_json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "Bad request")
        if length < 0 or length > MAX_BODY:
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

    def auth(self, conn, group_id):
        header = self.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        if not token:
            raise ApiError(401, "Join the group first")
        row = conn.execute(
            "SELECT id FROM members WHERE group_id=%s AND token_hash=%s", (group_id, hash_token(token))
        ).fetchone()
        if not row:
            raise ApiError(401, "Your session for this group has expired. Open the invite link again.")
        return row["id"]

    # ----- HTTP verbs -----
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        q = parse_qs(parsed.query)
        arg = lambda k: q.get(k, [""])[0]
        if path == "/api/link-preview":
            return self.link_route(arg("url"))
        if path == "/api/config":
            return self.send_json(200, {"placeSearch": "google" if GOOGLE_KEY else "free"})
        if path in ("/api/places/autocomplete", "/api/places/details", "/api/places/photo"):
            return self.places_route(path.rsplit("/", 1)[1], arg)
        if path.startswith("/api/"):
            return self.api("GET", path)
        if path in STATIC:
            name, ctype = STATIC[path]
        elif JS_FILE.fullmatch(path) and os.path.isfile(os.path.join(ROOT, path.lstrip("/"))):
            name, ctype = path.lstrip("/"), "text/javascript; charset=utf-8"  # front-end modules in js/
        else:
            return self.send_json(404, {"error": "Not found"})
        with open(os.path.join(ROOT, name), "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
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
            # Each request's database work is one transaction: it all commits, or (on any
            # error) none of it does. Password hashing is deliberately slow, so it runs
            # outside transactions and never holds a connection or a lock.
            if method == "POST" and parts == ["groups"]:
                return self.create_group()
            if len(parts) >= 2 and parts[0] == "groups":
                gid = parts[1]
                with DB.transaction() as conn:
                    exists = conn.execute("SELECT 1 FROM groups WHERE id=%s", (gid,)).fetchone()
                if not exists:
                    raise ApiError(404, "This invite link doesn't exist or has been deleted")
                rest = parts[2:]
                if method == "GET" and rest == ["invite"]:
                    return self.invite(gid)
                if method == "POST" and rest == ["join"]:
                    return self.join(gid)
                if method == "GET" and rest == ["state"]:
                    with DB.transaction() as conn:
                        payload = group_state(conn, gid, self.auth(conn, gid))
                    return self.send_json(200, payload)
                if method == "PUT" and rest == ["me"]:
                    return self.update_me(gid)
                if method == "POST" and rest == ["places"]:
                    return self.add_place(gid)
                if method == "PUT" and len(rest) == 2 and rest[0] == "places":
                    return self.edit_place(gid, rest[1])
            raise ApiError(404, "Not found")
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except psycopg.Error as e:
            # The transaction was rolled back, so nothing was half-saved. Log the kind of
            # failure (redacted), never the connection string.
            self.log_error("Database error (%s): %s", type(e).__name__, redact(e, DB.url if DB else "").strip()[:300])
            self.send_json(503, {"error": "Bloom couldn't reach its database, so nothing was saved. Try again in a moment."})
        except Exception as e:  # pragma: no cover - last-resort safety net
            self.log_error("API error: %r", e)
            self.send_json(500, {"error": "Something went wrong on the server"})

    def create_group(self):
        if not rate_ok(self.client_ip(), "create", 20):
            raise ApiError(429, "You've created a lot of groups just now — try again in a minute")
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
        with DB.transaction() as conn:
            conn.execute(
                "INSERT INTO groups (id, title, host_name, start_date, pw_salt, pw_hash, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (gid, title, name, start, salt, pw_hash, now()),
            )
            member_id, token = new_member(conn, gid, name, COLORS[0], True)
            payload = group_state(conn, gid, member_id)
        self.send_json(201, {"groupId": gid, "memberId": member_id, "token": token, "state": payload})

    def invite(self, gid):
        with DB.transaction() as conn:
            g = conn.execute("SELECT title, host_name FROM groups WHERE id=%s", (gid,)).fetchone()
            count = conn.execute("SELECT COUNT(*) AS n FROM members WHERE group_id=%s", (gid,)).fetchone()["n"]
        self.send_json(200, {"title": g["title"], "host": g["host_name"], "memberCount": count})

    def join(self, gid):
        ip = self.client_ip()
        key = (gid, ip)
        with FAILS_LOCK:
            count, until = FAILS.get(key, (0, 0))
            if until > time.time():
                raise ApiError(429, f"Too many wrong tries. Wait {int(until - time.time()) + 1} seconds.")
        body = self.read_body()
        name = text(body, "name", 1, 20)
        password = body.get("password") if isinstance(body.get("password"), str) else ""
        with DB.transaction() as conn:
            g = conn.execute("SELECT pw_salt, pw_hash FROM groups WHERE id=%s", (gid,)).fetchone()
        # Slow on purpose (makes guessing passwords impractical); outside any transaction.
        if not hmac.compare_digest(hash_password(password, bytes(g["pw_salt"])), bytes(g["pw_hash"])):
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
        with DB.transaction() as conn:
            # Lock the group row so two people joining at once can't take the same name
            # or push the group past its size limit.
            conn.execute("SELECT 1 FROM groups WHERE id=%s FOR UPDATE", (gid,))
            names = [r["name"].casefold() for r in conn.execute("SELECT name FROM members WHERE group_id=%s", (gid,)).fetchall()]
            if name.casefold() in names:
                raise ApiError(409, f"Someone called {name} is already in this group. Add an initial, like “{name} T”.")
            if len(names) >= MAX_MEMBERS:
                raise ApiError(403, f"This group is full ({MAX_MEMBERS} people max)")
            member_id, token = new_member(conn, gid, name, COLORS[len(names) % len(COLORS)], False)
            payload = group_state(conn, gid, member_id)
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
        with DB.transaction() as conn:
            member_id = self.auth(conn, gid)
            if votes is not None:
                # Real groups only vote on places their members suggested.
                allowed = {r["id"] for r in conn.execute("SELECT id FROM places WHERE group_id=%s", (gid,))}
                if not set(votes) <= allowed:
                    raise ApiError(400, "Invalid votes")
            if avail is not None:
                conn.execute("UPDATE members SET avail=%s, updated_at=%s WHERE id=%s", (Jsonb(sorted(set(avail))), now(), member_id))
            if votes is not None:
                conn.execute("UPDATE members SET votes=%s, updated_at=%s WHERE id=%s", (Jsonb(votes), now(), member_id))
            payload = group_state(conn, gid, member_id)
        self.send_json(200, payload)

    def link_route(self, url):
        url = (url or "").strip()[:500]
        if not url:
            return self.send_json(400, {"error": "Paste a link first"})
        if not url.startswith(("http://", "https://")):
            url = "https://" + url
        if not rate_ok(self.client_ip(), "link", 10):
            return self.send_json(429, {"error": "Too many links — try again in a minute"})
        try:
            self.send_json(200, {"place": link_preview(url)})
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except (urllib.error.URLError, ValueError, TimeoutError, OSError, UnicodeError):
            self.send_json(502, {"error": "That page didn't load. You can still add it with the link."})

    def places_route(self, which, arg):
        """Place search: Google Places if a key is set, otherwise free (Photon + OpenStreetMap)."""
        ip = self.client_ip()
        if not GOOGLE_KEY:
            return self.free_places_route(which, arg, ip)
        session = arg("session") if SESSION.fullmatch(arg("session") or "") else None
        try:
            if which == "autocomplete":
                text = arg("q").strip()[:80]
                if len(text) < 2:
                    return self.send_json(200, {"results": []})
                if not rate_ok(ip, "ac", 120):
                    return self.send_json(429, {"error": "Too many searches — try again in a minute"})
                kind = arg("kind") if arg("kind") in KINDS else "other"
                return self.send_json(200, {"results": google_autocomplete(text, session, kind)})
            if which == "details":
                pid = arg("id")
                if not PLACE_ID.fullmatch(pid or ""):
                    return self.send_json(400, {"error": "Unknown place"})
                if not rate_ok(ip, "details", 30):
                    return self.send_json(429, {"error": "Too many lookups — try again in a minute"})
                return self.send_json(200, {"place": google_details(pid, session)})
            # photo: redirect the browser to a short-lived image URL (the key stays here)
            name = arg("name")
            if not PHOTO_NAME.fullmatch(name or ""):
                return self.send_json(400, {"error": "Unknown photo"})
            if not rate_ok(ip, "photo", 120):
                return self.send_json(429, {"error": "Too many photos — try again in a minute"})
            uri = google_photo_uri(name)
            if not uri or not uri.startswith("https://"):
                return self.send_json(404, {"error": "No photo"})
            self.send_response(302)
            self.send_header("Location", uri)
            self.send_header("Cache-Control", "private, max-age=1500")
            self.end_headers()
        except (urllib.error.URLError, ValueError, TimeoutError, OSError) as e:
            print(f"Google Places request failed: {e}")
            self.send_json(502, {"error": "Couldn't reach Google right now"})

    def free_places_route(self, which, arg, ip):
        try:
            if which == "autocomplete":
                text = arg("q").strip()[:80]
                if len(text) < 2:
                    return self.send_json(200, {"results": []})
                if not rate_ok(ip, "ac", 120):
                    return self.send_json(429, {"error": "Too many searches — try again in a minute"})
                kind = arg("kind") if arg("kind") in KINDS else "other"
                offset = int(arg("offset")) if (arg("offset") or "").isdigit() else 0
                return self.send_json(200, free_autocomplete(text, kind, min(offset, placesearch.MAX_RESULTS)))
            if which == "details":
                if not OSM_ID.fullmatch(arg("id") or ""):
                    return self.send_json(400, {"error": "Unknown place"})
                if not rate_ok(ip, "details", 30):
                    return self.send_json(429, {"error": "Too many lookups — try again in a minute"})
                # The local index has the details already; only ask Nominatim for the rest.
                place = index_details(arg("id")) or osm_details(arg("id"))
                return self.send_json(200, {"place": place}) if place else self.send_json(404, {"error": "Couldn’t find that place"})
            return self.send_json(404, {"error": "No photo"})
        except (urllib.error.URLError, ValueError, TimeoutError, OSError) as e:
            print(f"Free place search failed: {e}")
            self.send_json(502, {"error": "Search isn’t reachable right now — you can still add it as typed"})

    def edit_place(self, gid, pid):
        """The person who suggested a place (or the host) can fix its name, type and details."""
        if not rate_ok(self.client_ip(), "editplace", 30):
            raise ApiError(429, "Slow down a little — try again in a minute")
        body = self.read_body()
        name = text(body, "name", 1, MAX_PLACE_NAME)
        kind = body.get("kind")
        if kind not in KINDS:
            raise ApiError(400, "Pick a type: food, drinks, activity or something else")
        e = body.get("edits") if isinstance(body.get("edits"), dict) else {}
        with DB.transaction() as conn:
            member_id = self.auth(conn, gid)
            conn.execute("SELECT 1 FROM groups WHERE id=%s FOR UPDATE", (gid,))  # one deck change at a time
            row = conn.execute("SELECT added_by, details FROM places WHERE id=%s AND group_id=%s", (pid, gid)).fetchone()
            if not row:
                raise ApiError(404, "That idea isn't in this group any more")
            is_host = conn.execute("SELECT is_host FROM members WHERE id=%s", (member_id,)).fetchone()["is_host"]
            if row["added_by"] != member_id and not is_host:
                raise ApiError(403, "Only the person who suggested this (or the host) can edit it")
            if conn.execute("SELECT 1 FROM places WHERE group_id=%s AND id<>%s AND lower(name)=lower(%s)", (gid, pid, name)).fetchone():
                raise ApiError(409, f"“{name}” is already in the deck")
            details = dict(row["details"]) if row["details"] else {"source": "manual"}
            def s(v, n):
                return v.strip()[:n] if isinstance(v, str) else None
            if "category" in e:
                details["category"] = s(e["category"], 60) or None
            if "price" in e:
                details["price"] = e["price"] if e["price"] in ("Free", "$", "$$", "$$$", "$$$$") else None
            if "area" in e:
                details["area"] = s(e["area"], 60) or None
            if "address" in e:
                details["address"] = s(e["address"], 200) or None
            if "hoursText" in e:
                details["hoursText"] = s(e["hoursText"], 120) or None
                details["hours"] = []  # the typed hours replace the map's
            if "description" in e:
                details["description"] = s(e["description"], 200) or None
            if "website" in e:
                w = s(e["website"], 500) or ""
                if w and not re.match(r"https?://[^\s\"'<>]+$", w):
                    w = "https://" + w if re.match(r"[\w.-]+\.[a-z]{2,}([/?#][^\s\"'<>]*)?$", w, re.I) else ""
                details["website"] = w or None
            conn.execute("UPDATE places SET name=%s, kind=%s, details=%s WHERE id=%s", (name, kind, Jsonb(details), pid))
            payload = group_state(conn, gid, member_id)
        self.send_json(200, payload)

    def add_place(self, gid):
        if not rate_ok(self.client_ip(), "addplace", 30):
            raise ApiError(429, "Slow down a little — try again in a minute")
        body = self.read_body()
        details = clean_details(body.get("details"))
        name = text(body, "name", 1, MAX_PLACE_NAME)
        kind = body.get("kind")
        if kind not in KINDS:
            raise ApiError(400, "Pick a type: food, drinks, activity, outdoors or other")
        with DB.transaction() as conn:
            member_id = self.auth(conn, gid)
            conn.execute("SELECT 1 FROM groups WHERE id=%s FOR UPDATE", (gid,))  # no duplicate or 21st idea in a race
            existing = [r["name"].casefold() for r in conn.execute("SELECT name FROM places WHERE group_id=%s", (gid,))]
            if name.casefold() in existing:
                raise ApiError(409, f"“{name}” is already in the deck")
            if len(existing) >= MAX_CUSTOM_PLACES:
                raise ApiError(403, f"This group already has {MAX_CUSTOM_PLACES} suggestions")
            conn.execute(
                "INSERT INTO places (id, group_id, name, kind, added_by, created_at, details) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                ("p_" + secrets.token_urlsafe(6), gid, name, kind, member_id, now(), Jsonb(details) if details else None),
            )
            payload = group_state(conn, gid, member_id)
        self.send_json(201, payload)


def main():
    try:
        init_database()
    except DatabaseConfigError as e:
        sys.exit(f"Bloom can't start: {e}")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Bloom is running at http://localhost:{PORT}  (database: PostgreSQL at {DB.describe()})")
    idx = None if GOOGLE_KEY else placesearch.load()
    print("Place search: " + ("Google Places" if GOOGLE_KEY else "free (Photon + OpenStreetMap, no key needed)"))
    if not GOOGLE_KEY:
        print(f"Local place index: {len(idx.places)} Singapore places (built {idx.built})" if idx
              else "Local place index: not built yet, so search uses Photon only (run: python3 placesearch.py build)")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
        DB.close()


if __name__ == "__main__":
    main()
