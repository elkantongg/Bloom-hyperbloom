"""Lepak's local place index: typo-tolerant, branch-aware search of Singapore venues.

Why this exists: Photon (the free geocoder) returns only a few results, ranked by
importance, and needs near-exact spelling. "Macdonalds" finds one McDonald's although
OpenStreetMap maps well over a hundred in Singapore. So Lepak keeps a compact copy of
Singapore's named venues, downloaded once from the Overpass API (inside Singapore's
real boundary, not a bounding box), and searches it in memory:

  * spelling:  "Macdonalds", "mac donalds", "MCDONALDS" -> McDonald's
  * branches:  every outlet, each with its mall / street / area
  * location:  "McDonalds Tampines", "Sephora Orchard", "Din Tai Fung at Paragon"
  * category:  "bubble tea Bugis", "pottery workshop", "ramen"

Data © OpenStreetMap contributors, available under the Open Database Licence (ODbL).

Build or refresh the index (one download, a few minutes; monthly is plenty):
    python3 placesearch.py build
Try a search from the terminal:
    python3 placesearch.py search "macdonalds tampines"

Standard library only. If RapidFuzz is installed (pip install rapidfuzz) it is used
for faster string similarity; results are the same either way.
"""
import array
import bisect
import gzip
import json
import math
import os
import re
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

try:  # optional speed-up, same scores
    from rapidfuzz.fuzz import ratio as _rf_ratio

    def ratio(a, b):
        return _rf_ratio(a, b) / 100.0
except ImportError:  # pragma: no cover - depends on the machine
    from difflib import SequenceMatcher

    def ratio(a, b):
        return SequenceMatcher(None, a, b, autojunk=False).ratio()

ROOT = os.path.dirname(os.path.abspath(__file__))
INDEX_PATH = os.environ.get("BLOOM_INDEX", os.path.join(ROOT, "search", "sg-places.json.gz"))
UA = "Lepak-hackathon-prototype/1.0 (https://github.com/elkantongg/hyperbloom)"
OVERPASS = [u for u in os.environ.get("BLOOM_OVERPASS", "").split(",") if u] or [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

KEEP = 0.62        # weakest match worth showing
CONFIDENT = 0.85   # below this the list is labelled "closest matches"
MAX_RESULTS = 200  # ranked results kept per query (shown 10 at a time)


# ---------- Text normalisation ----------
_APOS = re.compile(r"[’'`´ʼ]")
_NON_WORD = re.compile(r"[\W_]+")


def norm(s):
    """'McDonald's @ Tampines Mall' -> 'mcdonalds at tampines mall' (accents, case and punctuation go)."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = _APOS.sub("", s.casefold()).replace("&", " and ").replace("@", " at ")
    return " ".join(_NON_WORD.sub(" ", s).split())


def compact(n):
    """Spaces don't matter either: 'mac donalds' and 'macdonalds' compare equal."""
    return n.replace(" ", "")


def trigrams(c):
    c = "^" + c  # mark the start, so prefixes (what people type first) weigh more
    return {c[i:i + 3] for i in range(max(1, len(c) - 2))}


# ---------- Types (the "Got another idea?" dropdown) ----------
FOOD = {"amenity": {"restaurant", "fast_food", "food_court", "ice_cream"},
        "shop": {"bakery", "deli", "pastry", "confectionery", "chocolate", "cheese", "frozen_food"}}
DRINKS = {"amenity": {"cafe", "bar", "pub", "biergarten"},
          "shop": {"tea", "coffee", "beverages", "alcohol", "wine", "bubble_tea", "juice"}}
ACTIVITY_KEYS = {"leisure", "tourism", "natural", "craft", "sport", "historic", "place", "building", "club"}
ACTIVITY_AMENITY = {"cinema", "theatre", "arts_centre", "karaoke_box", "nightclub", "events_venue",
                    "community_centre", "casino", "library", "planetarium", "studio", "spa", "music_venue"}
ACTIVITY_SHOP = {"pottery", "craft", "massage", "games", "music"}
KIND_NAMES = ("food", "drinks", "activity", "shopping", "other")


def kind_of(key, value):
    """Which dropdown type an OpenStreetMap tag belongs to."""
    if value in FOOD.get(key, ()):
        return "food"
    if value in DRINKS.get(key, ()):
        return "drinks"
    if key in ACTIVITY_KEYS or (key == "amenity" and value in ACTIVITY_AMENITY) or (key == "shop" and value in ACTIVITY_SHOP):
        return "activity"
    if key == "shop" or (key == "amenity" and value == "marketplace"):
        return "shopping"
    return "other"


def matches_kind(key, value, kind):
    """Ranking hint only: other types still show (a cafe can be a dinner idea)."""
    return kind == "other" or kind_of(key, value) == kind


def nice_label(value):
    return (value or "").replace("_", " ").capitalize() if value not in ("yes", "no") else ""


# ---------- Category words people type ----------
# phrases -> rule. A place fits the rule if its tag, cuisine or (for "words") a word in
# its name matches. Name words only count for places of the listed types, so "tea"
# finds LiHO Tea but not a tea-coloured clothes shop.
CATEGORY_RULES = [
    (("restaurant", "restaurants", "dinner", "lunch", "eat", "makan"), {"tags": {"amenity": {"restaurant"}}}),
    (("food",), {"kinds": {"food"}}),
    (("fast food", "fastfood"), {"tags": {"amenity": {"fast_food"}}}),
    (("hawker", "hawker centre", "hawker center", "food court", "kopitiam"),
     {"tags": {"amenity": {"food_court"}}, "words": {"hawker", "kopitiam", "food centre"}, "word_kinds": {"food", "other", "shopping"}}),
    (("cafe", "cafes", "coffee", "coffee shop", "brunch"),
     {"tags": {"amenity": {"cafe"}, "shop": {"coffee"}}, "cuisine": {"coffee_shop", "coffee"}}),
    (("bubble tea", "boba", "milk tea", "bbt", "tea"),
     {"tags": {"shop": {"bubble_tea", "tea"}}, "cuisine": {"bubble_tea", "tea"},
      "words": {"boba", "bubble tea", "milk tea"}, "word_kinds": {"drinks"}}),
    (("dessert", "desserts", "ice cream", "gelato", "frozen yogurt"),
     {"tags": {"amenity": {"ice_cream"}, "shop": {"confectionery", "pastry"}},
      "cuisine": {"dessert", "ice_cream", "frozen_yogurt", "gelato"}, "words": {"dessert", "gelato"}, "word_kinds": {"food", "drinks"}}),
    (("bakery", "bakeries", "bread", "cake", "cakes", "pastry", "pastries"),
     {"tags": {"shop": {"bakery", "pastry"}}, "cuisine": {"cake", "bakery"}}),
    (("bar", "bars", "pub", "pubs", "beer", "cocktail", "cocktails", "drinks"),
     {"tags": {"amenity": {"bar", "pub", "biergarten"}}}),
    (("mall", "malls", "shopping mall", "shopping centre", "shopping center"),
     {"tags": {"shop": {"mall", "department_store"}}}),
    (("shopping", "shops", "retail"), {"kinds": {"shopping"}}),
    (("cinema", "cinemas", "movie", "movies", "film"), {"tags": {"amenity": {"cinema"}}}),
    (("karaoke", "ktv"), {"tags": {"amenity": {"karaoke_box"}}, "words": {"karaoke", "ktv"}, "word_kinds": {"activity", "other"}}),
    (("bowling",), {"tags": {"leisure": {"bowling_alley"}}, "words": {"bowling", "bowl"}, "word_kinds": {"activity", "other"}}),
    (("escape room", "escape rooms", "escape game"), {"tags": {"leisure": {"escape_game"}}, "words": {"escape"}, "word_kinds": {"activity", "other"}}),
    (("arcade", "arcades"), {"tags": {"leisure": {"amusement_arcade", "adult_gaming_centre"}}, "words": {"arcade"}, "word_kinds": {"activity", "other"}}),
    (("pottery", "ceramics", "ceramic", "clay"),
     {"tags": {"craft": {"pottery"}, "shop": {"pottery"}}, "words": {"pottery", "ceramic", "ceramics", "clay"},
      "word_kinds": {"activity", "shopping", "other"}}),
    (("workshop", "workshops", "art class", "art jamming", "art studio", "crafts", "craft"),
     {"tags": {"craft": {"pottery", "handicraft", "glass", "candle_maker", "leather"}, "amenity": {"arts_centre", "studio"},
              "leisure": {"escape_game"}}, "words": {"workshop", "studio", "jam", "atelier", "pottery", "craft"},
      "word_kinds": {"activity", "other"}}),
    (("museum", "museums"), {"tags": {"tourism": {"museum"}}}),
    (("gallery", "galleries", "art gallery"), {"tags": {"tourism": {"gallery"}, "shop": {"art"}}}),
    (("park", "parks", "garden", "gardens", "nature", "hike", "hiking", "outdoors", "picnic"),
     {"tags": {"leisure": {"park", "garden", "nature_reserve"}, "tourism": {"picnic_site"}}}),
    (("attraction", "attractions", "sightseeing", "tourist", "things to do"),
     {"tags": {"tourism": {"attraction", "theme_park", "zoo", "aquarium", "viewpoint"}}}),
    (("zoo",), {"tags": {"tourism": {"zoo"}}}),
    (("aquarium",), {"tags": {"tourism": {"aquarium"}}}),
    (("gym", "gyms", "fitness"), {"tags": {"leisure": {"fitness_centre"}}}),
    (("climbing", "bouldering", "rock climbing"),
     {"tags": {"leisure": {"climbing"}}, "sport": {"climbing", "bouldering"}, "words": {"boulder", "bouldering", "climb", "climbing"},
      "word_kinds": {"activity", "other"}}),
    (("trampoline", "trampoline park"), {"tags": {"leisure": {"trampoline_park"}}, "words": {"trampoline"}, "word_kinds": {"activity", "other"}}),
    (("ice skating", "skating", "ice rink"), {"tags": {"leisure": {"ice_rink"}}}),
    (("spa", "massage", "sauna"), {"tags": {"amenity": {"spa"}, "shop": {"massage"}, "leisure": {"sauna"}}}),
    (("books", "bookstore", "bookshop", "bookstores"), {"tags": {"shop": {"books"}}}),
    (("supermarket", "groceries", "grocery"), {"tags": {"shop": {"supermarket"}}}),
    (("beauty", "cosmetics", "makeup", "skincare", "perfume"), {"tags": {"shop": {"cosmetics", "beauty", "perfumery"}}}),
    (("clothes", "clothing", "fashion", "apparel"), {"tags": {"shop": {"clothes", "boutique", "fashion"}}}),
    (("electronics", "gadgets"), {"tags": {"shop": {"electronics", "mobile_phone", "computer"}}}),
    (("toys", "toy", "toy shop", "board games"), {"tags": {"shop": {"toys", "games"}}}),
    (("sports shop", "sportswear"), {"tags": {"shop": {"sports"}}}),
    (("nightclub", "club", "clubbing"), {"tags": {"amenity": {"nightclub"}}}),
]
# Cuisines: the word typed -> OpenStreetMap cuisine values (names count too).
CUISINES = {
    "ramen": {"ramen"}, "sushi": {"sushi"}, "japanese": {"japanese"}, "korean": {"korean"},
    "korean bbq": {"korean_bbq", "korean"}, "thai": {"thai"}, "indian": {"indian", "north_indian", "south_indian"},
    "chinese": {"chinese", "cantonese", "sichuan", "teochew", "hainanese"}, "western": {"western", "american"},
    "italian": {"italian", "pizza", "pasta"}, "pizza": {"pizza"}, "burger": {"burger"}, "burgers": {"burger"},
    "hotpot": {"hotpot", "hot_pot", "steamboat"}, "hot pot": {"hotpot", "hot_pot", "steamboat"},
    "steamboat": {"hotpot", "hot_pot", "steamboat"}, "dim sum": {"dim_sum", "dimsum"}, "bbq": {"barbecue", "bbq", "korean_bbq"},
    "seafood": {"seafood"}, "vegetarian": {"vegetarian"}, "vegan": {"vegan"}, "halal": {"halal"}, "mexican": {"mexican"},
    "vietnamese": {"vietnamese"}, "french": {"french"}, "noodles": {"noodle", "noodles", "ramen"}, "noodle": {"noodle", "noodles", "ramen"},
    "dumplings": {"dumpling", "dumplings"}, "chicken": {"chicken", "fried_chicken"}, "steak": {"steak_house", "steak"},
    "indonesian": {"indonesian"}, "malay": {"malay", "malaysian"}, "peranakan": {"peranakan"}, "taiwanese": {"taiwanese"},
    "hong kong": {"hong_kong", "cantonese"}, "mala": {"mala", "sichuan"}, "zi char": {"zi_char", "tze_char"}, "brunch": {"brunch"},
}
CATEGORIES = {}
for _phrases, _rule in CATEGORY_RULES:
    for _p in _phrases:
        CATEGORIES[norm(_p)] = _rule
for _p, _vals in CUISINES.items():
    CATEGORIES.setdefault(norm(_p), {"cuisine": _vals, "words": {norm(_p)}, "word_kinds": {"food", "drinks"}})

# Words that don't name a place: "pottery CLASS near me", "cafes IN Bugis".
FILLER = {"class", "classes", "lesson", "lessons", "course", "courses", "near", "me", "nearby",
          "around", "singapore", "sg", "best", "good", "cheap", "nice"}
GENERIC = {"food", "place", "places", "spot", "spots", "shop", "shops", "store", "stores", "restaurant", "restaurants"}
JOINERS = {"at", "in", "near", "around", "by"}
# Location words too common to mean a place on their own.
LOC_STOP = {"the", "of", "and", "at", "road", "rd", "street", "st", "avenue", "ave", "drive", "dr", "lane", "ln",
            "central", "north", "south", "east", "west", "new", "upper", "lower", "mall", "centre", "center",
            "plaza", "point", "park", "square", "city", "hub", "place", "block", "blk", "building", "tower",
            "singapore", "crescent", "close", "walk", "way", "link", "terrace", "hill", "view", "bt", "jln",
            "jalan", "lorong", "food", "court", "market", "estate", "industrial", "community", "club"}


def category_rule(phrase):
    """The category rule for typed words ('bubble tea', 'resturants'), or None."""
    n = norm(phrase)
    if n in CATEGORIES:
        return CATEGORIES[n]
    c = compact(n)
    if len(c) >= 5:
        best = max(CATEGORIES, key=lambda k: ratio(c, compact(k)))
        if ratio(c, compact(best)) >= 0.88:
            return CATEGORIES[best]
    return None


def category_rules(words):
    """['pottery', 'workshop'] -> [pottery rule, workshop rule] if every word is a category
    word (or a generic one like 'food'); None if any word looks like a name."""
    rules, i = [], 0
    while i < len(words):
        if i + 1 < len(words) and norm(words[i] + " " + words[i + 1]) in CATEGORIES:
            rules.append(CATEGORIES[norm(words[i] + " " + words[i + 1])])
            i += 2
            continue
        if words[i] in GENERIC or words[i] in FILLER:
            i += 1
            continue
        rule = category_rule(words[i])
        if not rule:
            return None
        rules.append(rule)
        i += 1
    if not rules and words:  # just "food" / "restaurants"
        rule = category_rule(" ".join(words))
        return [rule] if rule else None
    return rules or None


def fits_category(p, rule):
    """1.0 if the place's tags say so, 0.95 if only its name does, 0 if not."""
    key, value = p.get("k"), p.get("v")
    tags = rule.get("tags") or {}
    if key in tags and (tags[key] is None or value in tags[key]):
        return 1.0
    if rule.get("kinds") and kind_of(key, value) in rule["kinds"]:
        return 1.0
    if rule.get("cuisine") and set(p.get("c") or ()) & rule["cuisine"]:
        return 1.0
    if rule.get("sport") and p.get("sp") in rule["sport"]:
        return 1.0
    words = rule.get("words")
    if words and kind_of(key, value) in rule.get("word_kinds", ()):
        name = " " + p["_n"] + " "
        return 0.95 if any(" " + w + " " in name for w in words) else 0.0
    return 0.0


# ---------- Building the index (Overpass, run rarely) ----------
# Downloaded in small pieces (public Overpass servers time out on one huge query);
# each piece is cached in search/.cache, so a failed build resumes where it stopped.
SG = '[out:json][timeout:240];\narea["ISO3166-1"="SG"][admin_level=2]->.sg;\n'
STRIPS = [(103.55, 103.75), (103.75, 103.84), (103.84, 103.92), (103.92, 104.15)]  # west -> east
VENUE_QUERIES = [
    ("food-drink", 'nwr["name"]["amenity"~"^(restaurant|fast_food|cafe|bar|pub|biergarten|food_court|ice_cream)$"](area.sg);'),
    ("things-to-do", 'nwr["name"]["amenity"~"^(cinema|theatre|arts_centre|karaoke_box|nightclub|events_venue|community_centre|library|planetarium|studio|casino|marketplace|spa|music_venue)$"](area.sg);'),
    ("leisure", 'nwr["name"]["leisure"~"^(park|garden|nature_reserve|sports_centre|fitness_centre|bowling_alley|amusement_arcade|adult_gaming_centre|escape_game|stadium|water_park|ice_rink|miniature_golf|trampoline_park|climbing|horse_riding|golf_course|marina|beach_resort|dance|sauna|sports_hall|fishing)$"](area.sg);'),
    ("tourism-craft", '(nwr["name"]["tourism"~"^(attraction|museum|gallery|zoo|aquarium|theme_park|viewpoint|picnic_site)$"](area.sg);'
                      ' nwr["name"]["craft"](area.sg););'),
] + [(f"shops-{i + 1}", f'nwr["name"]["shop"]["shop"!~"^(vacant|no|yes)$"](area.sg)(1.1,{w},1.5,{e});')
     for i, (w, e) in enumerate(STRIPS)]
MALL_QUERY = SG + 'nwr["name"]["shop"="mall"](area.sg);\nout tags bb center;'
AREA_QUERY = SG + 'node["name"]["place"~"^(town|suburb|quarter|neighbourhood|village|island)$"](area.sg);\nout;'
CACHE_DIR = os.path.join(os.path.dirname(INDEX_PATH), ".cache")


def cached_overpass(query, label):
    path = os.path.join(CACHE_DIR, label + ".json")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < 86400:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    elements = overpass(query, label)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(elements, f)
    time.sleep(3)  # be gentle between requests
    return elements


def overpass(query, label):
    """POST a query, trying each Overpass server with exponential backoff (their usage policy)."""
    data = urllib.parse.urlencode({"data": query}).encode()
    wait = 10
    for attempt in range(8):
        for url in OVERPASS:
            print(f"  {label}: {url} (try {attempt + 1})", flush=True)
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=300) as r:
                    return json.loads(r.read()).get("elements") or []
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
                print(f"    failed: {e}", flush=True)
        print(f"  all servers busy, waiting {wait}s", flush=True)
        time.sleep(wait)
        wait = min(wait * 2, 300)
    raise RuntimeError("Overpass is unavailable right now. Try again later.")


def latin(s):
    return bool(re.search(r"[A-Za-z]", s or ""))


def split_list(v):
    return [x.strip() for x in (v or "").split(";") if x.strip()]


def element_point(e):
    if "lat" in e:
        return e["lat"], e["lon"]
    c = e.get("center") or {}
    return (c["lat"], c["lon"]) if "lat" in c else (None, None)


def meters(lat1, lon1, lat2, lon2):
    """Distance in metres (flat-earth approximation, plenty for one city)."""
    x = (lon2 - lon1) * 111_320 * math.cos(math.radians((lat1 + lat2) / 2))
    y = (lat2 - lat1) * 110_574
    return math.hypot(x, y)


TAG_KEYS = ("amenity", "shop", "craft", "leisure", "tourism")


def record(e):
    """One compact index entry from an Overpass element (None if unusable)."""
    t = e.get("tags") or {}
    lat, lon = element_point(e)
    if lat is None:
        return None
    name = t.get("name") or ""
    if not latin(name) and latin(t.get("name:en")):
        name = t["name:en"]  # e.g. a Chinese-only name with an English one alongside
    if not name.strip():
        return None
    key = next((k for k in TAG_KEYS if t.get(k)), None)
    if not key:
        return None
    aliases = []
    for k in ("name", "name:en", "brand", "brand:en", "alt_name", "short_name", "official_name", "alt_name:en"):
        for v in split_list(t.get(k)):
            if v != name and v not in aliases:
                aliases.append(v)
    brand = t.get("brand:en") if latin(t.get("brand:en")) else t.get("brand") if latin(t.get("brand")) else None
    unit = t.get("addr:unit") or (t.get("addr:housenumber") if (t.get("addr:housenumber") or "").startswith("#") else None)
    house = None if unit and unit == t.get("addr:housenumber") else t.get("addr:housenumber")
    r = {
        "i": {"node": "N", "way": "W", "relation": "R"}[e["type"]] + str(e["id"]),
        "n": name.strip(), "al": aliases[:6], "b": brand, "k": key, "v": t[key],
        "c": [c.strip().lower() for c in split_list(t.get("cuisine"))][:4],
        "y": round(lat, 6), "x": round(lon, 6),
        "s": t.get("addr:street"), "h": house, "u": unit, "p": t.get("addr:postcode"),
        "hn": t.get("addr:housename") or t.get("addr:place"), "r": t.get("branch"),
        "lv": t.get("level") or t.get("addr:floor"),
        "o": t.get("opening_hours"), "w": t.get("website") or t.get("contact:website") or t.get("url"),
        "t": t.get("phone") or t.get("contact:phone"), "wd": t.get("wikidata"),
        "wc": t.get("wheelchair"), "f": t.get("fee"), "ch": t.get("charge"), "sp": t.get("sport"),
    }
    return {k: v for k, v in r.items() if v not in (None, "", [])}


def dedupe(places):
    """Several OSM objects can map one venue (a node plus the building outline).
    Merge same-name objects within 40 m, unless their unit numbers differ (two outlets
    in one mall really are two outlets)."""
    cells = defaultdict(list)  # (name, ~100 m grid cell) -> kept places
    kept = []
    for p in sorted(places, key=lambda p: (-len(p), p["i"])):  # richest object first
        n = norm(p["n"])
        cx, cy = int(p["x"] * 900), int(p["y"] * 900)
        twin = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in cells.get((n, cx + dx, cy + dy), ()):
                    if meters(p["y"], p["x"], q["y"], q["x"]) <= 40 and not (p.get("u") and q.get("u") and compact(norm(p["u"])) != compact(norm(q["u"]))):
                        twin = q
                        break
        if twin:
            for k, v in p.items():
                twin.setdefault(k, v)  # fill gaps from the duplicate
            continue
        cells[(n, cx, cy)].append(p)
        kept.append(p)
    return kept


def attach_locations(places, malls, areas):
    """Give each place the mall it sits in (from the mall's outline) and its area
    (the nearest mapped town/suburb), so 'Tampines' or 'ION Orchard' can match."""
    boxes = []
    for m in malls:
        b = m.get("bounds")
        if b:
            pad = 0.00015  # ~15 m
            boxes.append((m["tags"]["name"], b["minlat"] - pad, b["minlon"] - pad, b["maxlat"] + pad, b["maxlon"] + pad,
                          (b["maxlat"] - b["minlat"]) * (b["maxlon"] - b["minlon"]), m["type"][0].upper() + str(m["id"])))
        elif "lat" in m:  # a mall mapped as a point: within ~60 m
            boxes.append((m["tags"]["name"], m["lat"] - 0.00055, m["lon"] - 0.00055, m["lat"] + 0.00055, m["lon"] + 0.00055,
                          1.0, "N" + str(m["id"])))
    mall_names = {norm(m["tags"]["name"]): m["tags"]["name"] for m in malls}
    towns = [a for a in areas if a[3] in ("town", "suburb", "quarter")]
    hoods = [a for a in areas if a[3] in ("neighbourhood", "village", "island")]
    for p in places:
        inside = [b for b in boxes if b[1] <= p["y"] <= b[3] and b[2] <= p["x"] <= b[4] and b[6] != p["i"]]
        if inside and p.get("v") not in ("mall", "department_store"):
            p["m"] = min(inside, key=lambda b: b[5])[0]
        elif p.get("v") != "mall":
            # The address may name the mall: "Tampines Mall, Tampines Central Rd, #02-01"
            for part in [p.get("hn")] + (p.get("s") or "").split(","):
                if part and norm(part) in mall_names:
                    p["m"] = mall_names[norm(part)]
                    break
        for group, field, limit in ((towns, "a", 3000), (hoods, "d", 900)):
            best = min(group, key=lambda a: meters(p["y"], p["x"], a[1], a[2]), default=None)
            if best and meters(p["y"], p["x"], best[1], best[2]) <= limit:
                p[field] = best[0]


def build(path=INDEX_PATH):
    print("Downloading Singapore venues from OpenStreetMap (Overpass API)...", flush=True)
    raw, seen = [], set()
    for label, body in VENUE_QUERIES:
        for e in cached_overpass(SG + body + "\nout tags center;", label):
            if (e["type"], e["id"]) not in seen:  # shop strips can overlap at the edges
                seen.add((e["type"], e["id"]))
                raw.append(e)
    malls = [m for m in cached_overpass(MALL_QUERY, "malls") if (m.get("tags") or {}).get("name") and m["tags"].get("shop") == "mall"]
    for m in malls:  # English name where the main one isn't
        if not latin(m["tags"]["name"]) and latin(m["tags"].get("name:en")):
            m["tags"]["name"] = m["tags"]["name:en"]
    areas = [[e["tags"]["name:en"] if latin(e["tags"].get("name:en")) and not latin(e["tags"]["name"]) else e["tags"]["name"],
              e["lat"], e["lon"], e["tags"]["place"]] for e in cached_overpass(AREA_QUERY, "areas")]
    places = dedupe([r for r in (record(e) for e in raw) if r])
    attach_locations(places, malls, areas)
    places.sort(key=lambda p: p["i"])
    mall_points = []
    for m in malls:
        lat, lon = element_point(m)
        if lat is not None:
            mall_points.append([m["tags"]["name"], round(lat, 6), round(lon, 6)])
    out = {"version": 1, "built": time.strftime("%Y-%m-%d"), "attribution": "© OpenStreetMap contributors, ODbL",
           "places": places, "areas": [[a[0], round(a[1], 6), round(a[2], 6), a[3]] for a in areas], "malls": mall_points}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)
    print(f"Saved {len(places)} places ({len(raw)} map objects before merging), {len(malls)} malls, "
          f"{len(areas)} areas -> {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)")


# ---------- Searching ----------
class Query:
    """What someone typed, split into possible (name, location) readings."""

    def __init__(self, text, index):
        self.text = text
        words = norm(text).split()
        self.readings = []  # (name words, location key or None, location coords)
        seen = set()

        def add(name_words, loc):
            core = [w for w in name_words if w not in FILLER] or name_words
            for nw in {tuple(name_words), tuple(core)}:
                if not nw or (nw, loc and loc[0]) in seen:
                    continue
                seen.add((nw, loc and loc[0]))
                self.readings.append((Words(" ".join(nw)), loc))

        add(words, None)
        # "Din Tai Fung at Paragon", "cafes in Bugis"
        for i, w in enumerate(words):
            if w in JOINERS and 0 < i < len(words) - 1:
                loc = index.location(" ".join(words[i + 1:]))
                if loc:
                    add(words[:i], loc)
        # "McDonalds Tampines" / "Tampines McDonalds"
        for k in range(1, min(3, len(words) - 1) + 1):
            for name_words, loc_words in ((words[:-k], words[-k:]), (words[k:], words[:k])):
                loc = index.location(" ".join(loc_words))
                if loc:
                    add(name_words, loc)


class Words:
    """A normalised string with the forms the scorer needs."""
    __slots__ = ("n", "c", "t")

    def __init__(self, n):
        self.n, self.c, self.t = n, compact(n), n.split()


def name_score(q, a):
    """How well typed words q match a place name a (0..1) and how ('exact', 'prefix', 'fuzzy')."""
    qc, ac = q.c, a.c
    if not qc or not ac:
        return 0.0, ""
    if qc == ac:
        return 1.0, "exact"
    best, how = ratio(qc, ac), "fuzzy"  # whole-name typo: macdonalds ~ mcdonalds
    if best < 0.8:  # loosely similar strings ("pottery workshop" ~ "the pets workshop") aren't a match
        best = 0.0
    if len(ac) > len(qc):
        if ac.startswith(qc):  # still typing: "din tai" -> din tai fung
            s = 0.9 + 0.08 * len(qc) / len(ac)
            if s > best:
                best, how = s, "prefix"
        elif len(qc) >= 4:  # typo while typing: "macdon" -> mcdonalds
            s = 0.92 * max(ratio(qc, ac[:n]) for n in (len(qc) - 1, len(qc), len(qc) + 1))
            if s > best:
                best, how = s, "fuzzy"
        if len(qc) >= 4 and qc in ac and 0.8 > best:  # "taifung"
            best, how = 0.8, "prefix"
    # word by word, any order: "fung din tai", "kaya toast ya kun"
    if q.t and a.t:
        total, used, exactish = 0.0, set(), True
        for i, w in enumerate(q.t):
            last = i == len(q.t) - 1
            top, top_j = 0.0, None
            for j, aw in enumerate(a.t):
                if j in used:
                    continue
                if aw == w:
                    s = 1.0
                elif aw.startswith(w) and (last or len(w) >= 3):
                    s = 0.95
                elif len(w) >= 4 and len(aw) >= 3:
                    r = ratio(w, aw)
                    s = r if r >= 0.8 else 0.0
                else:
                    s = 0.0
                if s > top:
                    top, top_j = s, j
            if top_j is not None:
                used.add(top_j)
            if top < 0.95:
                exactish = False
            total += top
        cover = len(used) / len(a.t)
        s = 0.97 * (total / len(q.t)) * (0.85 + 0.15 * cover)
        if s > best:
            best, how = s, ("prefix" if exactish else "fuzzy")
    return best, how


class PlaceIndex:
    def __init__(self, data):
        self.built = data.get("built")
        self.places = data["places"]
        self.by_id = {}
        alias_ids = {}
        self.aliases = []      # Words
        self.alias_display = []
        self.alias_places = []  # list of place indexes per alias
        self.brand_count = Counter()
        for pi, p in enumerate(self.places):
            self.by_id[p["i"]] = pi
            p["_n"] = norm(p["n"])
            names = [p["n"]] + p.get("al", [])
            for disp in names:
                for n in {norm(disp), re.sub(r"^the ", "", norm(disp))}:
                    if not n:
                        continue
                    ai = alias_ids.get(n)
                    if ai is None:
                        ai = alias_ids[n] = len(self.aliases)
                        self.aliases.append(Words(n))
                        self.alias_display.append(disp)
                        self.alias_places.append([])
                    if not self.alias_places[ai] or self.alias_places[ai][-1] != pi:
                        self.alias_places[ai].append(pi)
            self.brand_count[compact(norm(p.get("b") or p["n"]))] += 1
            loc = [p.get(k) for k in ("m", "hn", "r", "a", "d", "s", "p")]
            p["_loc"] = " " + norm(" ".join(x for x in loc if x)) + " "
        # Candidate lookup: trigrams of the squashed name, plus sorted names for prefixes.
        tri = defaultdict(list)
        for ai, a in enumerate(self.aliases):
            for g in trigrams(a.c):
                tri[g].append(ai)
        self.tri = {g: array.array("I", ids) for g, ids in tri.items()}
        self.sorted_names = sorted((a.c, ai) for ai, a in enumerate(self.aliases))
        self.sorted_words = sorted({(w, ai) for ai, a in enumerate(self.aliases) for w in a.t})
        self._build_locations(data)
        self.category_cache = {}

    def _build_locations(self, data):
        """Words that can mean 'where': areas, malls, branches, streets -> coordinates."""
        loc = defaultdict(list)

        def add(name, lat, lon, words=True):
            n = norm(name)
            if not n or n.isdigit():
                return
            loc[n].append((lat, lon))
            if words:
                for w in n.split():
                    if len(w) >= 4 and w not in LOC_STOP and not w.isdigit():
                        loc[w].append((lat, lon))

        for name, lat, lon, _kind in data.get("areas", []):
            add(name, lat, lon)
        for name, lat, lon in data.get("malls", []):
            add(name, lat, lon)
        for p in self.places:
            if p.get("r"):
                add(p["r"], p["y"], p["x"])
            if p.get("s"):
                street = re.sub(r"\d+", " ", p["s"].split(",")[0])
                add(street, p["y"], p["x"], words=False)
        # Keep a sample of points per word (enough to judge "near Tampines").
        self.loc = {k: v if len(v) <= 40 else v[::max(1, len(v) // 40)][:40] for k, v in loc.items()}
        self.loc_compact = {compact(k): k for k in self.loc}
        self.loc_keys = sorted(self.loc_compact)
        self._loc_cache = {}

    def location(self, phrase):
        """('tampines', [(lat, lon), ...]) if the words name a place, allowing small typos."""
        n = norm(phrase)
        if not n or n in self._loc_cache:
            return self._loc_cache.get(n)
        hit = None
        if n in self.loc and n not in LOC_STOP:
            hit = n
        elif compact(n) in self.loc_compact:
            hit = self.loc_compact[compact(n)]
        elif len(compact(n)) >= 5:
            c = compact(n)
            close = [k for k in self.loc_keys if abs(len(k) - len(c)) <= 2 and k[0] == c[0]]
            best = max(close, key=lambda k: ratio(c, k), default=None)
            if best and ratio(c, best) >= 0.85:  # one wrong letter: "tampinez"
                hit = self.loc_compact[best]
        out = (hit, self.loc[hit]) if hit and hit not in LOC_STOP and not any(w in CATEGORIES for w in [hit]) else None
        if len(self._loc_cache) > 5000:
            self._loc_cache.clear()
        self._loc_cache[n] = out
        return out

    def loc_score(self, loc, text, lat, lon):
        """1 if the place's mall/street/area mentions the location, less the further away it is."""
        key, points = loc
        if " " + key + " " in text:
            return 1.0
        if lat is None or not points:
            return 0.0
        d = min(meters(lat, lon, y, x) for y, x in points)
        return 0.85 if d <= 800 else 0.6 if d <= 2000 else 0.3 if d <= 4000 else 0.0

    def name_candidates(self, w):
        """Alias numbers worth scoring for typed words w (fast pre-filter)."""
        found = set()
        lo = bisect.bisect_left(self.sorted_names, (w.c,))
        for c, ai in self.sorted_names[lo:lo + 300]:
            if not c.startswith(w.c):
                break
            found.add(ai)
        if w.t:
            last = w.t[-1]
            lo = bisect.bisect_left(self.sorted_words, (last,))
            for tok, ai in self.sorted_words[lo:lo + 600]:
                if not tok.startswith(last):
                    break
                found.add(ai)
        if len(w.c) >= 3:
            grams = trigrams(w.c)
            hits = Counter()
            for g in grams:
                ids = self.tri.get(g)
                if ids is not None:
                    hits.update(ids)
            need = max(2, math.ceil(len(grams) * 0.45))
            for ai, n in hits.most_common(1500):
                if n < need:
                    break
                found.add(ai)
        return found

    def brand_key(self, p):
        return compact(norm(p.get("b") or p["n"]))

    def branch_count(self, p):
        return max(1, self.brand_count.get(self.brand_key(p), 1))

    def main_brand(self, ranked):
        """The chain most of the strong matches belong to: ('Ya Kun Kaya Toast', 78), or None."""
        strong = [r for r in ranked[:30] if r[0] >= CONFIDENT and r[2] != "category"]
        if not strong:
            return None
        votes = Counter(self.brand_key(self.places[r[1]]) for r in strong)
        key = max(votes, key=lambda k: (votes[k], self.brand_count.get(k, 0)))
        if key != self.brand_key(self.places[ranked[0][1]]) and votes[key] < 3:
            return None  # "Jewel Changi" isn't a search for the 2 "Changi Recommends" kiosks
        p = next(self.places[r[1]] for r in strong if self.brand_key(self.places[r[1]]) == key)
        count = self.brand_count.get(key, 0)
        return (p.get("b") or p["n"], count) if count > 1 else None

    def category_places(self, rule):
        k = id(rule)
        if k not in self.category_cache:
            self.category_cache[k] = [(pi, f) for pi, p in enumerate(self.places) for f in [fits_category(p, rule)] if f]
        return self.category_cache[k]

    def search(self, text, kind="other"):
        """Ranked [(score, place index, how, alias)] for what was typed."""
        q = Query(text, self)
        best = {}  # place index -> (score, how, alias display, reading location)
        for words, loc in q.readings:
            scores = {}  # place -> (name score, how, alias)
            for ai in self.name_candidates(words):
                s, how = name_score(words, self.aliases[ai])
                if s < 0.55:
                    continue
                for pi in self.alias_places[ai]:
                    # Matching a place's own name beats matching its brand or another name.
                    own = s if self.places[pi]["_n"] == self.aliases[ai].n else s - 0.01
                    if own > scores.get(pi, (0,))[0]:
                        scores[pi] = (own, how, self.alias_display[ai])
            # category words: "bubble tea", "pottery", "japanese food"
            # A place must fit every category word: "pottery workshop" = pottery AND workshop.
            whole = category_rule(words.n)
            rules = [whole] if whole else category_rules(words.t)
            if rules:
                fit = dict(self.category_places(rules[0]))
                for rule in rules[1:]:
                    more = dict(self.category_places(rule))
                    fit = {pi: min(f, more[pi]) for pi, f in fit.items() if pi in more}
                cat = 0.84 if len(rules) > 1 else 0.82
                for pi, strength in fit.items():
                    if cat * strength > scores.get(pi, (0,))[0]:
                        scores[pi] = (cat * strength, "category", None)
            for pi, (s, how, alias) in scores.items():
                p = self.places[pi]
                if s >= 0.9 and how != "category":
                    # Well-known names win close calls: 148 "McDonald's" beat one outlet mapped as "macdonald's".
                    s = min(1.0, s + 0.06 * min(1.0, math.log10(self.branch_count(p)) / 2))
                if loc:
                    s = 0.72 * s + 0.25 * self.loc_score(loc, p["_loc"], p["y"], p["x"])
                if kind != "other" and kind_of(p.get("k"), p.get("v")) == kind:
                    s += 0.03
                if s > best.get(pi, (0,))[0]:
                    best[pi] = (s, how, alias, loc)
        ranked = sorted(((v[0], pi, v[1], v[2], v[3]) for pi, v in best.items() if v[0] >= KEEP),
                        key=lambda r: (-round(r[0], 4), -self.branch_count(self.places[r[1]]) if r[2] != "category" else 0,
                                       self.places[r[1]]["_n"], self.places[r[1]].get("_loc", "")))
        return q, ranked[:MAX_RESULTS]

    def score_external(self, q, name, where, lat, lon, key, value, kind):
        """Score a result from another source (Photon) on the same scale, for merging."""
        n = Words(norm(name))
        text = " " + norm(where) + " "
        best = 0.0
        for words, loc in q.readings:
            s = name_score(words, n)[0]
            if loc:
                s = 0.72 * s + 0.25 * self.loc_score(loc, text, lat, lon)
            best = max(best, s)
        if kind != "other" and kind_of(key, value) == kind:
            best += 0.03
        return best


def where_text(p):
    """'Tampines Mall, #02-01, Tampines' — only what the map says (mall from its outline)."""
    parts = []

    def add(x):
        for seg in (x or "").split(","):  # addresses can repeat the mall: "Tampines Mall, Tampines Central Rd"
            seg = seg.strip()
            if seg and not any(norm(seg) in norm(y) for y in parts):
                parts.append(seg)
    add(p.get("m") or p.get("hn"))
    add(p.get("u"))
    if p.get("s"):
        add(" ".join(x for x in (p.get("h"), p["s"]) if x))
    add(p.get("r"))
    add(p.get("d"))
    add(p.get("a"))
    return ", ".join(parts[:5])


def category_text(p):
    """'Taiwanese restaurant', 'Bubble tea shop', 'Coffee shop', 'Cosmetics'."""
    cuisine = (p.get("c") or [""])[0].replace("_", " ")
    label = nice_label(p.get("v"))
    if not cuisine or cuisine in ("yes", "no"):
        return label or None
    if cuisine.endswith(("shop", "house", "bar")) or cuisine.split()[-1] in label.lower():
        return cuisine.capitalize()
    if p.get("v") in ("cafe", "beverages") and cuisine in ("bubble tea", "tea", "juice"):
        return cuisine.capitalize() + " shop"
    return (cuisine.capitalize() + " " + label.lower()).strip()


# ---------- Loading (once per process) ----------
_INDEX = None
_INDEX_LOCK = threading.Lock()
_INDEX_MTIME = None


def load(path=INDEX_PATH):
    """The index, loaded on first use (None if it hasn't been built)."""
    global _INDEX, _INDEX_MTIME
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    if _INDEX is not None and _INDEX_MTIME == mtime:
        return _INDEX
    with _INDEX_LOCK:
        if _INDEX is None or _INDEX_MTIME != mtime:  # also picks up a rebuilt file
            try:
                with gzip.open(path, "rt", encoding="utf-8") as f:
                    _INDEX = PlaceIndex(json.load(f))
                _INDEX_MTIME = mtime
            except (OSError, ValueError, KeyError) as e:
                print(f"Place index couldn't load ({e}); using Photon only.")
                return None
    return _INDEX


def from_places(places, areas=(), malls=(), built="test"):
    """An index from in-memory records (used by tests)."""
    return PlaceIndex({"places": [dict(p) for p in places], "areas": list(areas), "malls": list(malls), "built": built})


def main(argv):
    if len(argv) >= 2 and argv[1] == "build":
        build(argv[2] if len(argv) > 2 else INDEX_PATH)
    elif len(argv) >= 3 and argv[1] == "search":
        idx = load()
        if not idx:
            sys.exit("No index yet. Run: python3 placesearch.py build")
        t = time.time()
        _q, ranked = idx.search(" ".join(argv[2:]))
        print(f"{len(ranked)} results in {(time.time() - t) * 1000:.0f} ms")
        for s, pi, how, _alias, _loc in ranked[:15]:
            p = idx.places[pi]
            print(f"  {s:.2f} {how:8} {p['n']}  —  {where_text(p)}")
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv)
