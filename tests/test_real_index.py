"""Acceptance checks on the real Singapore index (search/sg-places.json.gz).
Skipped when the index hasn't been built. OpenStreetMap changes, so these check
behaviour (right chain first, location respected), not exact counts."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import placesearch as ps  # noqa: E402

IDX = ps.load()


def top(q, n=5):
    _q, ranked = IDX.search(q)
    return [IDX.places[r[1]] for r in ranked[:n]]


@unittest.skipUnless(IDX, "place index not built (python3 placesearch.py build)")
class RealIndex(unittest.TestCase):
    def test_spelling_finds_the_chain(self):
        for q in ("Macdonalds", "Mcdonalds", "mac donalds", "MCDONALDS"):
            self.assertTrue(all(p.get("b") == "McDonald's" or "mcdonald" in ps.compact(p["_n"]) for p in top(q)), q)
        self.assertGreater(IDX.main_brand(IDX.search("Macdonalds")[1])[1], 20)

    def test_location_first(self):
        for q, area in (("McDonalds Tampines", "tampines"), ("Din Tai Fung Tampines", "tampines"), ("Sephora Orchard", "orchard")):
            first = top(q, 1)[0]
            self.assertIn(area, first["_loc"], (q, first["n"], first["_loc"]))

    def test_chains(self):
        for q, name in (("Din Tai Fung", "din tai fung"), ("Ya Kun", "ya kun"), ("Haidilao", "haidilao"), ("starbuck", "starbucks")):
            got = top(q, 5)
            self.assertTrue(all(p["_n"].startswith(name) for p in got), (q, [p["n"] for p in got]))

    def test_categories(self):
        got = top("Bubble tea Bugis", 5)
        self.assertTrue(all("bubble_tea" in (p.get("c") or []) or p.get("v") in ("beverages", "tea", "bubble_tea") for p in got),
                        [p["n"] for p in got])
        self.assertTrue(top("Pottery workshop", 1))

    def test_speed(self):
        import time
        t = time.time()
        for q in ("macdonalds tampines", "bubble tea bugis", "din tai", "pottery workshop", "sephora orchard"):
            IDX.search(q)
        self.assertLess((time.time() - t) / 5, 0.2)


if __name__ == "__main__":
    unittest.main()
