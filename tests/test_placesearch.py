"""Place search tests: spelling, branches, locations, categories, merging, dedupe.
Uses a small made-up fixture (no network). Run:  python3 -m unittest discover tests
"""
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ["BLOOM_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")  # never touch the real database
os.environ.pop("GOOGLE_PLACES_API_KEY", None)

import placesearch as ps  # noqa: E402
import server  # noqa: E402

AREAS = [["Tampines", 1.3540, 103.9440, "town"], ["Orchard", 1.3040, 103.8320, "suburb"],
         ["Bugis", 1.3000, 103.8550, "neighbourhood"], ["Jurong East", 1.3330, 103.7420, "town"],
         ["Changi", 1.3570, 103.9880, "suburb"], ["Tiong Bahru", 1.2860, 103.8270, "neighbourhood"]]
MALLS = [["Tampines Mall", 1.3526, 103.9447], ["ION Orchard", 1.3040, 103.8318], ["Paragon", 1.3036, 103.8357],
         ["Bugis Junction", 1.2995, 103.8555], ["Jewel Changi Airport", 1.3602, 103.9898]]


def P(i, n, k, v, y, x, **extra):
    return dict(i=i, n=n, k=k, v=v, y=y, x=x, **extra)


PLACES = [
    P("N1", "McDonald's", "amenity", "fast_food", 1.3527, 103.9446, b="McDonald's", m="Tampines Mall", a="Tampines", u="#01-12", c=["burger"]),
    P("N2", "McDonald's", "amenity", "fast_food", 1.3560, 103.9530, b="McDonald's", s="Tampines Street 32", h="475", a="Tampines", c=["burger"]),
    P("N3", "McDonald's", "amenity", "fast_food", 1.3010, 103.8390, b="McDonald's", s="Orchard Road", a="Orchard", c=["burger"]),
    P("N4", "McDonald's", "amenity", "fast_food", 1.3335, 103.7425, b="McDonald's", a="Jurong East", c=["burger"]),
    P("W5", "MacDonald House", "tourism", "attraction", 1.2990, 103.8480, a="Orchard"),
    P("N6", "Din Tai Fung", "amenity", "restaurant", 1.3528, 103.9448, b="Din Tai Fung", m="Tampines Mall", a="Tampines", c=["taiwanese"], o="Mo-Su 11:00-21:30"),
    P("N7", "Din Tai Fung", "amenity", "restaurant", 1.3036, 103.8358, b="Din Tai Fung", m="Paragon", a="Orchard", c=["taiwanese"]),
    P("N8", "Din Tai Fung", "amenity", "restaurant", 1.3603, 103.9897, b="Din Tai Fung", m="Jewel Changi Airport", a="Changi", c=["taiwanese"]),
    P("N9", "Sephora", "shop", "cosmetics", 1.3041, 103.8319, b="Sephora", m="ION Orchard", a="Orchard", u="#B2-09"),
    P("N10", "Sephora", "shop", "cosmetics", 1.3601, 103.9899, b="Sephora", m="Jewel Changi Airport", a="Changi"),
    P("N11", "Ya Kun Kaya Toast", "amenity", "cafe", 1.3525, 103.9449, b="Ya Kun Kaya Toast", m="Tampines Mall", a="Tampines", c=["coffee_shop"]),
    P("N12", "Ya Kun Kaya Toast", "amenity", "cafe", 1.2995, 103.8556, b="Ya Kun Kaya Toast", m="Bugis Junction", a="Orchard", d="Bugis", c=["coffee_shop"]),
    P("N13", "Haidilao Hot Pot", "amenity", "restaurant", 1.3002, 103.8552, b="Haidilao", al=["Haidilao", "海底捞"], a="Orchard", d="Bugis", c=["hotpot"]),
    P("N14", "Haidilao Hot Pot", "amenity", "restaurant", 1.3332, 103.7419, b="Haidilao", al=["Haidilao"], a="Jurong East", c=["hotpot"]),
    P("N15", "Mud Rock Ceramics", "craft", "pottery", 1.2861, 103.8271, d="Tiong Bahru", a="Orchard"),
    P("N16", "The Pottery Place", "amenity", "studio", 1.3200, 103.8800),
    P("N17", "LiHO TEA", "shop", "beverages", 1.2996, 103.8554, m="Bugis Junction", d="Bugis", a="Orchard", c=["bubble_tea"]),
    P("N18", "KOI Thé", "amenity", "cafe", 1.3529, 103.9450, m="Tampines Mall", a="Tampines", c=["bubble_tea"]),
    P("N19", "Tea Clothing", "shop", "clothes", 1.2998, 103.8553, d="Bugis", a="Orchard"),
    P("W20", "Tampines Mall", "shop", "mall", 1.3526, 103.9447, a="Tampines"),
    P("N21", "Tampines Hawker Centre", "amenity", "food_court", 1.3540, 103.9430, a="Tampines"),
]


def fixture():
    return ps.from_places(PLACES, AREAS, MALLS)


IDX = fixture()


def names(q, kind="other", n=None):
    _q, ranked = IDX.search(q, kind)
    out = [(IDX.places[r[1]]["n"], IDX.places[r[1]]["i"]) for r in ranked]
    return out[:n] if n else out


class Normalise(unittest.TestCase):
    def test_punctuation_case_spaces(self):
        self.assertEqual(ps.norm("McDonald's"), "mcdonalds")
        self.assertEqual(ps.norm("MCDONALD’S @ Tampines"), "mcdonalds at tampines")
        self.assertEqual(ps.compact(ps.norm("Mac Donalds")), "macdonalds")
        self.assertEqual(ps.norm("KOI Thé"), "koi the")


class Spelling(unittest.TestCase):
    def test_mcdonalds_variants(self):
        for q in ["Macdonalds", "Mcdonalds", "Mac Donalds", "MCDONALDS", "mcdonals", "mc donald's", "mcdonald"]:
            top = names(q, n=4)
            self.assertTrue(all(n == "McDonald's" for n, _ in top), (q, top))

    def test_prefix_of_another_name(self):
        # "macdonald" is literally the start of "MacDonald House", so that may lead,
        # but every McDonald's still follows straight after.
        top = names("macdonald", n=5)
        self.assertEqual(sum(n == "McDonald's" for n, _ in top), 4)

    def test_lookalike_ranks_below(self):
        ids = [i for _n, i in names("Macdonalds")]
        if "W5" in ids:  # "MacDonald House" may show, but after every McDonald's
            self.assertGreater(ids.index("W5"), max(ids.index(i) for i in ("N1", "N2", "N3", "N4")))

    def test_partial_names(self):
        self.assertEqual(names("Din Tai")[0][0], "Din Tai Fung")
        self.assertEqual(names("din tai fung")[0][0], "Din Tai Fung")
        self.assertEqual(names("Ya Kun")[0][0], "Ya Kun Kaya Toast")
        self.assertEqual(names("yakun")[0][0], "Ya Kun Kaya Toast")
        self.assertEqual(names("Haidilao")[0][0], "Haidilao Hot Pot")
        self.assertEqual(names("hai di lao")[0][0], "Haidilao Hot Pot")
        self.assertEqual(names("sephra")[0][0], "Sephora")

    def test_no_unrelated(self):
        self.assertNotIn("McDonald's", [n for n, _ in names("Sephora")])
        self.assertEqual(names("zzqxv"), [])
        self.assertEqual(names("qwertyuiop"), [])


class Branches(unittest.TestCase):
    def test_all_branches(self):
        self.assertEqual({i for n, i in names("Din Tai Fung") if n == "Din Tai Fung"}, {"N6", "N7", "N8"})
        self.assertEqual({i for n, i in names("McDonalds") if n == "McDonald's"}, {"N1", "N2", "N3", "N4"})
        self.assertEqual(IDX.brand_count["mcdonalds"], 4)

    def test_location_first(self):
        top = [i for _n, i in names("McDonalds Tampines")]
        self.assertEqual(set(top[:2]), {"N1", "N2"})
        self.assertTrue({"N3", "N4"} <= set(top), "other branches still listed")
        self.assertLess(top.index("N4"), top.index("W20") if "W20" in top else 999,
                        "a McDonald's elsewhere beats a non-McDonald's that merely says Tampines")
        self.assertEqual(set([i for _n, i in names("Tampines McDonalds")][:2]), {"N1", "N2"})
        self.assertEqual(names("Din Tai Fung Tampines")[0][1], "N6")
        self.assertEqual(names("Din Tai Fung at Paragon")[0][1], "N7")
        self.assertEqual(names("Sephora Orchard")[0][1], "N9")
        self.assertEqual(names("sephora ion orchard")[0][1], "N9")
        self.assertEqual(names("mcdonalds tampinez")[0][1] in ("N1", "N2"), True)  # typo in the area too

    def test_exact_full_name_wins(self):
        self.assertEqual(names("Tampines Mall")[0][1], "W20")


class Categories(unittest.TestCase):
    def test_bubble_tea_bugis(self):
        got = [i for _n, i in names("Bubble tea Bugis")]
        self.assertEqual(got[0], "N17")
        self.assertNotIn("N18", got)  # bubble tea 11 km away in Tampines isn't "in Bugis"
        self.assertEqual({i for _n, i in names("bubble tea")}, {"N17", "N18"})
        self.assertNotIn("N19", got)  # a clothes shop with "Tea" in its name isn't a drink shop

    def test_pottery_workshop(self):
        got = {i for _n, i in names("Pottery workshop")}
        self.assertTrue({"N15", "N16"} <= got)
        self.assertTrue({"N15", "N16"} <= {i for _n, i in names("pottery class")})

    def test_kind_prefers_but_does_not_filter(self):
        got = [i for _n, i in names("Tampines", kind="food")]
        self.assertIn("W20", got)


class Build(unittest.TestCase):
    def test_record(self):
        r = ps.record({"type": "node", "id": 5, "lat": 1.3, "lon": 103.8,
                       "tags": {"name": "麦当劳", "name:en": "McDonald's", "brand": "麦当劳", "brand:en": "McDonald's",
                                "amenity": "fast_food", "addr:housenumber": "#02-01", "addr:street": "Tampines Central"}})
        self.assertEqual((r["i"], r["n"], r["b"], r["u"]), ("N5", "McDonald's", "McDonald's", "#02-01"))
        self.assertNotIn("h", r)
        self.assertIsNone(ps.record({"type": "way", "id": 1, "tags": {"name": "No position", "shop": "x"}}))
        self.assertIsNone(ps.record({"type": "node", "id": 2, "lat": 1, "lon": 103, "tags": {"name": "Bench"}}))

    def test_dedupe(self):
        a = P("N1", "Din Tai Fung", "amenity", "restaurant", 1.30000, 103.80000)
        b = P("W2", "Din Tai Fung", "amenity", "restaurant", 1.30010, 103.80010, o="Mo-Su 11:00-21:00")  # same venue, ~15 m
        c = P("N3", "Din Tai Fung", "amenity", "restaurant", 1.30500, 103.80000)  # ~550 m away: another branch
        d = P("N4", "Ya Kun", "amenity", "cafe", 1.30000, 103.80000, u="#01-01")
        e = P("N5", "Ya Kun", "amenity", "cafe", 1.30001, 103.80001, u="#03-10")  # same mall, other unit
        kept = ps.dedupe([dict(x) for x in (a, b, c, d, e)])
        self.assertEqual(len(kept), 4)
        merged = [k for k in kept if k["n"] == "Din Tai Fung" and k["i"] in ("N1", "W2")][0]
        self.assertEqual(merged["o"], "Mo-Su 11:00-21:00")  # gaps filled from the duplicate

    def test_attach_locations(self):
        p = [P("N1", "Shop", "shop", "clothes", 1.3005, 103.8005)]
        mall = {"type": "way", "id": 9, "tags": {"name": "Test Mall"},
                "bounds": {"minlat": 1.3, "minlon": 103.8, "maxlat": 1.301, "maxlon": 103.801}}
        ps.attach_locations(p, [mall], [["Somewhere", 1.3006, 103.8006, "suburb"]])
        self.assertEqual((p[0]["m"], p[0]["a"]), ("Test Mall", "Somewhere"))
        q = [P("N2", "Cafe", "amenity", "cafe", 1.4, 103.9, s="Test Mall, Some Road, #01-02")]  # outside the outline
        ps.attach_locations(q, [mall], [])
        self.assertEqual(q[0]["m"], "Test Mall")


def photon_response(features):
    return io.BytesIO(json.dumps({"features": features}).encode())


def feature(osm_id, name, lon, lat, cc="SG", key="amenity", value="fast_food", **props):
    return {"properties": dict(osm_type="N", osm_id=osm_id, osm_key=key, osm_value=value, name=name, countrycode=cc, **props),
            "geometry": {"type": "Point", "coordinates": [lon, lat]}}


class Api(unittest.TestCase):
    """server.free_autocomplete / index_details with the fixture index and a fake Photon."""

    def setUp(self):
        server.LOOKUP_CACHE.clear()
        server.PHOTON_PAUSE[:] = [0.0, 30.0]
        self.load = mock.patch.object(ps, "load", return_value=IDX)
        self.load.start()

    def tearDown(self):
        self.load.stop()

    def fake_photon(self, features):
        return mock.patch("urllib.request.urlopen", return_value=photon_response(features))

    def test_contract_paging_and_suggestion(self):
        with self.fake_photon([]):
            r = server.free_autocomplete("Macdonalds", "food")
        for k in ("results", "approximate", "used", "total", "more", "offset", "didYouMean", "branches"):
            self.assertIn(k, r)
        first = r["results"][0]
        self.assertEqual(set(first), {"placeId", "main", "category", "secondary", "categoryMatch"})
        self.assertEqual(first["main"], "McDonald's")
        self.assertEqual(r["didYouMean"], "McDonald's")
        self.assertEqual(r["branches"], {"name": "McDonald's", "count": 4, "area": None})
        with self.fake_photon([]):
            self.assertEqual(server.free_autocomplete("mcdonalds tampines", "food")["branches"]["area"], "Tampines")
        self.assertFalse(r["approximate"])
        with self.fake_photon([]):
            r = server.free_autocomplete("cafe", "drinks")
        self.assertLessEqual(len(r["results"]), server.PAGE)
        if r["total"] > server.PAGE:
            self.assertTrue(r["more"])
            page2 = server.free_autocomplete("cafe", "drinks", offset=server.PAGE)
            self.assertFalse({x["placeId"] for x in page2["results"]} & {x["placeId"] for x in r["results"]})

    def test_category_search_is_not_a_near_miss(self):
        with self.fake_photon([]):
            r = server.free_autocomplete("bubble tea", "drinks")
        self.assertFalse(r["approximate"])
        self.assertIsNone(r["branches"])
        self.assertEqual(r["results"][0]["category"], "Bubble tea shop")

    def test_exact_name_has_no_suggestion(self):
        with self.fake_photon([]):
            self.assertIsNone(server.free_autocomplete("Din Tai Fung", "food")["didYouMean"])

    def test_photon_merge_dedupe_and_boundary(self):
        feats = [feature(101, "McDonald's", 103.94461, 1.35271),                            # same venue as N1 (~2 m)
                 feature(102, "McDonald's", 103.7600, 1.4400, district="Woodlands"),         # not in the index: added
                 feature(103, "McDonald's", 103.7700, 1.4700, cc="MY", city="Johor Bahru")]  # Malaysia: dropped
        with self.fake_photon(feats):
            r = server.free_autocomplete("mcdonalds", "food")
        ids = [x["placeId"] for _s, x in server.ranked_search("mcdonalds", "food")["ranked"]]
        self.assertIn("osm:N102", ids)
        self.assertNotIn("osm:N101", ids)
        self.assertNotIn("osm:N103", ids)
        self.assertEqual(ids.count("osm:N1"), 1)
        self.assertEqual(r["total"], len(ids))

    def test_photon_only_when_no_index(self):
        feats = [feature(7, "Some Cafe", 103.85, 1.30, value="cafe"), feature(8, "Kedai", 103.77, 1.47, cc="MY")]
        with mock.patch.object(ps, "load", return_value=None), self.fake_photon(feats):
            r = server.free_autocomplete("some cafe", "drinks")
        self.assertEqual([x["main"] for x in r["results"]], ["Some Cafe"])

    def test_photon_down_uses_index(self):
        with mock.patch("urllib.request.urlopen", side_effect=TimeoutError("busy")):
            r = server.free_autocomplete("pottery", "activity")
        self.assertTrue(r["results"])
        self.assertGreater(server.PHOTON_PAUSE[0], 0)  # backs off before asking again

    def test_empty(self):
        with self.fake_photon([]):
            r = server.free_autocomplete("zzqxv", "food")
        self.assertEqual((r["results"], r["total"], r["more"], r["didYouMean"]), ([], 0, False, None))

    def test_index_details(self):
        with mock.patch.object(server, "wikidata_photos", return_value={}):
            d = server.index_details("osm:N6")
        self.assertEqual((d["name"], d["area"], d["kind"]), ("Din Tai Fung", "Tampines Mall", "food"))
        self.assertEqual(d["hours"][0], "Monday: 11:00 – 21:30")
        self.assertIsNone(d["price"])  # nothing invented
        self.assertIsNone(d["photo"])
        self.assertIsNone(server.index_details("osm:N999"))


if __name__ == "__main__":
    unittest.main()
