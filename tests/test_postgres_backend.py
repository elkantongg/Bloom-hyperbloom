"""Bloom's PostgreSQL backend: the real HTTP API against a real (throwaway) PostgreSQL.

Needs TEST_DATABASE_URL pointing at a database whose name contains "test", e.g. a local
`postgresql://bloom@127.0.0.1:54329/bloom_test`. It must not be your real DATABASE_URL.
Each run works in its own new schema (bloom_test_<random>) and drops only that schema
afterwards, so nothing outside it is read or changed. Without TEST_DATABASE_URL the
database tests are skipped (the config tests still run).
"""
import hashlib
import json
import os
import secrets
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from contextlib import closing
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import psycopg  # noqa: E402

import bloomdb  # noqa: E402
import migrate_sqlite_to_postgres as mig  # noqa: E402
import server  # noqa: E402  (also loads .env, so DATABASE_URL below is the real one if set)

TEST_URL = os.environ.get("TEST_DATABASE_URL", "").strip()


def unsafe_reason():
    if not TEST_URL:
        return "TEST_DATABASE_URL is not set"
    if TEST_URL == os.environ.get("DATABASE_URL", "").strip():
        return "TEST_DATABASE_URL is the same as DATABASE_URL; use a separate test database"
    if "test" not in urllib.parse.urlsplit(TEST_URL).path.lower():
        return "the TEST_DATABASE_URL database name must contain 'test'"
    return None


SKIP = unsafe_reason()
SCHEMAS = []


def new_schema():
    name = "bloom_test_" + secrets.token_hex(4)
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        c.execute(psycopg.sql.SQL("CREATE SCHEMA {}").format(psycopg.sql.Identifier(name)))
    SCHEMAS.append(name)
    return name


def tearDownModule():
    if SKIP:
        return
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        for name in SCHEMAS:  # only the schemas this run created
            assert name.startswith("bloom_test_")
            c.execute(psycopg.sql.SQL("DROP SCHEMA {} CASCADE").format(psycopg.sql.Identifier(name)))


class Client:
    def __init__(self, port):
        self.base = f"http://127.0.0.1:{port}"

    def call(self, method, path, body=None, token=None):
        req = urllib.request.Request(self.base + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None)
        req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())


@unittest.skipIf(SKIP, SKIP or "")
class ApiTest(unittest.TestCase):
    """Every request goes through the real handler and the real database."""

    @classmethod
    def setUpClass(cls):
        cls.schema = new_schema()
        server.init_database(TEST_URL, search_path=cls.schema, max_size=8)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.httpd.RequestHandlerClass.log_message = lambda *a: None
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.api = Client(cls.httpd.server_address[1])

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        server.DB.close()

    def setUp(self):
        server.LOOKUP_HITS.clear()
        server.FAILS.clear()

    def sql(self, query, params=()):
        with server.DB.transaction() as conn:
            return conn.execute(query, params).fetchall()

    def create(self, title="Weekend hangout", name="Alex", password="sunflower"):
        status, data = self.api.call("POST", "/api/groups", {"title": title, "name": name, "password": password,
                                                             "startDate": "2026-10-19"})
        self.assertEqual(status, 201, data)
        return data

    def join(self, gid, name, password="sunflower"):
        return self.api.call("POST", f"/api/groups/{gid}/join", {"name": name, "password": password})

    # ----- group creation -----
    def test_create_group_returns_token_and_state(self):
        g = self.create()
        self.assertEqual(set(g), {"groupId", "memberId", "token", "state"})
        st = g["state"]
        self.assertEqual(st["group"], {"id": g["groupId"], "title": "Weekend hangout", "host": "Alex", "startDate": "2026-10-19"})
        self.assertEqual(st["me"], g["memberId"])
        self.assertEqual(st["places"], [])
        self.assertEqual(st["members"], [{"id": g["memberId"], "name": "Alex", "color": server.COLORS[0],
                                          "isHost": True, "avail": [], "votes": {}}])

    def test_passwords_and_tokens_are_stored_hashed(self):
        g = self.create(password="sunflower")
        row = self.sql("SELECT pw_salt, pw_hash FROM groups WHERE id=%s", (g["groupId"],))[0]
        self.assertEqual(len(row["pw_salt"]), 16)
        self.assertEqual(bytes(row["pw_hash"]), server.hash_password("sunflower", bytes(row["pw_salt"])))
        self.assertNotIn(b"sunflower", bytes(row["pw_hash"]))
        m = self.sql("SELECT token_hash FROM members WHERE id=%s", (g["memberId"],))[0]
        self.assertEqual(m["token_hash"], hashlib.sha256(g["token"].encode()).hexdigest())

    def test_create_group_validation(self):
        status, data = self.api.call("POST", "/api/groups", {"title": "x", "name": "A", "password": "123"})
        self.assertEqual(status, 400)
        self.assertIn("Password", data["error"])

    # ----- invites, joining and authentication -----
    def test_invite_preview(self):
        g = self.create(title="Board games")
        self.assertEqual(self.api.call("GET", f"/api/groups/{g['groupId']}/invite"),
                         (200, {"title": "Board games", "host": "Alex", "memberCount": 1}))
        self.assertEqual(self.api.call("GET", "/api/groups/nope123/invite")[0], 404)

    def test_join_checks_password_and_names(self):
        g = self.create()
        gid = g["groupId"]
        status, data = self.join(gid, "Maya", "wrong")
        self.assertEqual((status, data["error"]), (403, "That password doesn't match"))
        status, data = self.join(gid, "Maya")
        self.assertEqual(status, 201)
        self.assertEqual([m["name"] for m in data["state"]["members"]], ["Alex", "Maya"])
        maya = data["state"]["members"][1]
        self.assertEqual((maya["isHost"], maya["color"]), (False, server.COLORS[1]))
        self.assertEqual(self.join(gid, "maya")[0], 409)  # names are case-insensitive
        self.assertEqual(self.api.call("GET", f"/api/groups/{gid}/invite")[1]["memberCount"], 2)

    def test_wrong_password_lockout(self):
        gid = self.create()["groupId"]
        for _ in range(5):
            self.assertEqual(self.join(gid, "Sam", "nope")[0], 403)
        self.assertEqual(self.join(gid, "Sam")[0], 429)

    def test_state_requires_a_valid_token_for_that_group(self):
        a, b = self.create(), self.create(title="Other")
        self.assertEqual(self.api.call("GET", f"/api/groups/{a['groupId']}/state")[0], 401)
        self.assertEqual(self.api.call("GET", f"/api/groups/{a['groupId']}/state", token="made-up")[0], 401)
        self.assertEqual(self.api.call("GET", f"/api/groups/{a['groupId']}/state", token=b["token"])[0], 401)
        status, st = self.api.call("GET", f"/api/groups/{a['groupId']}/state", token=a["token"])
        self.assertEqual((status, st["me"]), (200, a["memberId"]))

    def test_group_size_limit_holds_under_concurrent_joins(self):
        gid = self.create()["groupId"]
        results = []
        real_new_member = server.new_member

        def slow_new_member(*args):  # widen the gap between "count members" and "insert"
            time.sleep(0.05)
            return real_new_member(*args)

        threads = [threading.Thread(target=lambda i=i: results.append(self.join(gid, f"Friend {i}")[0]))
                   for i in range(server.MAX_MEMBERS + 3)]
        with mock.patch.object(server, "new_member", slow_new_member):
            [t.start() for t in threads]
            [t.join() for t in threads]
        self.assertEqual(results.count(201), server.MAX_MEMBERS - 1)  # the host is the 12th
        self.assertEqual(results.count(403), 4)
        self.assertEqual(self.sql("SELECT count(*) AS n FROM members WHERE group_id=%s", (gid,))[0]["n"], server.MAX_MEMBERS)

    # ----- availability -----
    def test_availability_is_saved_sorted_and_shared(self):
        g = self.create()
        gid = g["groupId"]
        maya = self.join(gid, "Maya")[1]
        slots = ["2026-10-21@18", "2026-10-20@9", "2026-10-21@18"]
        status, st = self.api.call("PUT", f"/api/groups/{gid}/me", {"avail": slots}, token=maya["token"])
        self.assertEqual(status, 200)
        self.assertEqual(st["members"][1]["avail"], ["2026-10-20@9", "2026-10-21@18"])
        # The host sees it too, from the database.
        st = self.api.call("GET", f"/api/groups/{gid}/state", token=g["token"])[1]
        self.assertEqual(st["members"][1]["avail"], ["2026-10-20@9", "2026-10-21@18"])
        self.assertEqual(self.api.call("PUT", f"/api/groups/{gid}/me", {"avail": ["tomorrow"]}, token=maya["token"])[0], 400)
        self.assertEqual(self.api.call("PUT", f"/api/groups/{gid}/me", {"avail": []})[0], 401)

    # ----- places and voting -----
    def test_places_and_voting(self):
        g = self.create()
        gid, host = g["groupId"], g["token"]
        maya = self.join(gid, "Maya")[1]
        details = {"source": "manual", "name": "Hide and Seek", "area": "Botanic Gardens", "lat": 1.3138, "lon": 103.8159}
        status, st = self.api.call("POST", f"/api/groups/{gid}/places",
                                   {"name": "Hide and Seek (Botanic Gardens)", "kind": "activity", "details": details},
                                   token=maya["token"])
        self.assertEqual(status, 201)
        place = st["places"][0]
        self.assertEqual((place["name"], place["kind"], place["addedBy"]), ("Hide and Seek (Botanic Gardens)", "activity", maya["memberId"]))
        self.assertEqual((place["details"]["area"], place["details"]["lat"]), ("Botanic Gardens", 1.3138))
        dup = self.api.call("POST", f"/api/groups/{gid}/places", {"name": "hide and seek (botanic gardens)", "kind": "activity"}, token=host)
        self.assertEqual(dup[0], 409)

        pid = place["id"]
        status, st = self.api.call("PUT", f"/api/groups/{gid}/me", {"votes": {pid: 1}}, token=maya["token"])
        self.assertEqual((status, st["members"][1]["votes"]), (200, {pid: 1}))
        self.assertEqual(self.api.call("PUT", f"/api/groups/{gid}/me", {"votes": {pid: -1}}, token=host)[0], 200)
        self.assertEqual(self.api.call("PUT", f"/api/groups/{gid}/me", {"votes": {"p_other": 1}}, token=host)[0], 400)
        self.assertEqual(self.api.call("PUT", f"/api/groups/{gid}/me", {"votes": {pid: True}}, token=host)[0], 400)
        st = self.api.call("GET", f"/api/groups/{gid}/state", token=host)[1]
        self.assertEqual([m["votes"] for m in st["members"]], [{pid: -1}, {pid: 1}])

    def test_editing_places(self):
        g = self.create()
        gid, host = g["groupId"], g["token"]
        maya, sam = self.join(gid, "Maya")[1], self.join(gid, "Sam")[1]
        pid = self.api.call("POST", f"/api/groups/{gid}/places", {"name": "Ramen", "kind": "food"}, token=maya["token"])[1]["places"][0]["id"]
        edit = {"name": "Ramen (Bugis)", "kind": "food", "edits": {"area": "Bugis", "price": "$$", "website": "ramen.sg"}}
        self.assertEqual(self.api.call("PUT", f"/api/groups/{gid}/places/{pid}", edit, token=sam["token"])[0], 403)
        status, st = self.api.call("PUT", f"/api/groups/{gid}/places/{pid}", edit, token=maya["token"])
        self.assertEqual(status, 200)
        p = st["places"][0]
        self.assertEqual((p["name"], p["details"]["area"], p["details"]["price"], p["details"]["website"]),
                         ("Ramen (Bugis)", "Bugis", "$$", "https://ramen.sg"))
        self.assertEqual(self.api.call("PUT", f"/api/groups/{gid}/places/{pid}", dict(edit, name="Ramen!"), token=host)[0], 200)

    # ----- persistence, transactions and failures -----
    def test_data_survives_a_server_restart(self):
        g = self.create()
        gid = g["groupId"]
        maya = self.join(gid, "Maya")[1]
        self.api.call("PUT", f"/api/groups/{gid}/me", {"avail": ["2026-10-25@14"]}, token=maya["token"])
        before = self.api.call("GET", f"/api/groups/{gid}/state", token=g["token"])[1]
        server.DB.close()  # a brand-new pool, like restarting the server
        server.init_database(TEST_URL, search_path=self.schema, max_size=8)
        self.assertEqual(self.api.call("GET", f"/api/groups/{gid}/state", token=g["token"]), (200, before))
        self.assertEqual(self.join(gid, "Jun")[0], 201)

    def test_failure_mid_request_saves_nothing(self):
        title = "Rollback " + secrets.token_hex(3)
        with mock.patch.object(server, "new_member", side_effect=psycopg.OperationalError("server closed the connection")):
            status, data = self.api.call("POST", "/api/groups", {"title": title, "name": "Alex", "password": "sunflower"})
        self.assertEqual(status, 503)
        self.assertIn("nothing was saved", data["error"])
        self.assertEqual(self.sql("SELECT count(*) AS n FROM groups WHERE title=%s", (title,))[0]["n"], 0)

    def test_database_errors_never_leak_credentials(self):
        g = self.create()
        leak = psycopg.OperationalError(f"connection to {server.DB.url} failed")
        with mock.patch.object(server.DB, "transaction", side_effect=leak), \
                mock.patch.object(server.Handler, "log_error") as log:
            status, data = self.api.call("GET", f"/api/groups/{g['groupId']}/state", token=g["token"])
        self.assertEqual(status, 503)
        self.assertNotIn(server.DB.url, json.dumps(data))
        self.assertNotIn(server.DB.url, " ".join(map(str, log.call_args.args)))


class ConfigTest(unittest.TestCase):
    """DATABASE_URL handling. No database needed."""
    GOOD = "postgresql://postgres.abc:p%40ss%23word@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres"

    def check(self, value):
        return bloomdb.database_url({"DATABASE_URL": value} if value is not None else {})

    def test_missing_placeholder_and_invalid_urls_fail_clearly(self):
        for bad, words in [(None, "not set"), ("", "not set"), ("postgresql://YOUR_CONNECTION_STRING", "placeholder"),
                           ("postgresql://postgres:[YOUR-PASSWORD]@db.x.supabase.co:5432/postgres", "placeholder"),
                           ("sqlite:///data/bloom.db", "postgresql://"), ("postgresql://u:pw@host:abc/db", "valid URI"),
                           ("postgresql://u@db.x.supabase.co/postgres", "no password")]:
            with self.subTest(bad=bad):
                with self.assertRaises(bloomdb.DatabaseConfigError) as cm:
                    self.check(bad)
                self.assertIn(words, str(cm.exception))
                if bad and "pw" in bad:
                    self.assertNotIn("pw", str(cm.exception).replace("password", ""))

    def test_valid_url_is_accepted(self):
        self.assertEqual(self.check(self.GOOD), self.GOOD)

    def test_redact_hides_password_in_both_forms(self):
        msg = bloomdb.redact(f"failed for {self.GOOD} with p@ss#word and p%40ss%23word", self.GOOD)
        self.assertNotIn("p@ss#word", msg)
        self.assertNotIn("p%40ss%23word", msg)

    def test_remote_connections_require_tls(self):
        self.assertEqual(bloomdb.connect_kwargs(self.GOOD)["sslmode"], "require")
        self.assertEqual(bloomdb.connect_kwargs(self.GOOD + "?sslmode=verify-full").get("sslmode"), None)  # theirs wins
        self.assertNotIn("sslmode", bloomdb.connect_kwargs("postgresql://bloom@127.0.0.1:5432/bloom_test"))
        self.assertIsNone(bloomdb.connect_kwargs(self.GOOD)["prepare_threshold"])  # Supabase pooler

    def test_server_refuses_to_start_without_database_url(self):
        with mock.patch.dict(os.environ, {"DATABASE_URL": ""}), mock.patch.object(server, "DB", None):
            with self.assertRaises(SystemExit) as cm:
                server.main()
        self.assertIn("DATABASE_URL is not set", str(cm.exception.code))

    def test_unreachable_database_fails_without_showing_the_password(self):
        url = "postgresql://bloom:hunter2secret@127.0.0.1:1/bloom_test"
        with self.assertRaises(bloomdb.DatabaseConfigError) as cm:
            bloomdb.Database(url).open()
        self.assertIn("Couldn't connect", str(cm.exception))
        self.assertNotIn("hunter2secret", str(cm.exception))


SQLITE_SCHEMA = """
CREATE TABLE groups (id TEXT PRIMARY KEY, title TEXT NOT NULL, host_name TEXT NOT NULL, start_date TEXT NOT NULL,
    pw_salt BLOB NOT NULL, pw_hash BLOB NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE members (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL, color TEXT NOT NULL, token_hash TEXT NOT NULL, avail TEXT NOT NULL DEFAULT '[]',
    votes TEXT NOT NULL DEFAULT '{}', is_host INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE places (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL, kind TEXT NOT NULL, added_by TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL);
ALTER TABLE places ADD COLUMN details TEXT;
"""


@unittest.skipIf(SKIP, SKIP or "")
class MigrationTest(unittest.TestCase):
    """migrate_sqlite_to_postgres.py against a SQLite file shaped like data/bloom.db."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "bloom.db")
        self.host_token, self.maya_token = "host-token-123", "maya-token-456"
        salt = b"0123456789abcdef"
        with closing(sqlite3.connect(self.path)) as c, c:
            c.executescript(SQLITE_SCHEMA)
            c.execute("INSERT INTO groups VALUES ('g1','Weekend','Alex','2026-10-19',?,?,1760000000)",
                      (salt, server.hash_password("sunflower", salt)))
            # Same joined_at on purpose: insertion order (rowid) must survive as the tie-breaker.
            c.execute("INSERT INTO members VALUES ('m_host','g1','Alex','#2F6FEB',?,'[\"2026-10-20@18\"]','{\"p1\": 1}',1,1760000000,1760000000)",
                      (server.hash_token(self.host_token),))
            c.execute("INSERT INTO members VALUES ('m_maya','g1','Maya','#E03131',?,'[]','{\"p1\": -1, \"p2\": 0}',0,1760000000,1760000100)",
                      (server.hash_token(self.maya_token),))
            c.execute("INSERT INTO places VALUES ('p1','g1','Hide and Seek (Botanic Gardens)','activity','m_maya',1760000050,?)",
                      (json.dumps({"source": "manual", "area": "Botanic Gardens", "lat": 1.3138}),))
            c.execute("INSERT INTO places VALUES ('p2','g1','Ramen','food','m_host',1760000050,NULL)")
        self.schema = new_schema()
        self.db = bloomdb.Database(TEST_URL, search_path=self.schema, max_size=2).open()
        self.log = []

    def tearDown(self):
        self.db.close()

    def run_migration(self, apply):
        return mig.migrate(self.path, self.db, apply=apply, out=self.log.append)

    def pg(self, query):
        with self.db.transaction() as conn:
            return conn.execute(query).fetchall()

    def file_hash(self):
        with open(self.path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()

    def test_dry_run_writes_nothing(self):
        report = self.run_migration(apply=False)
        self.assertEqual(report["counts"], {"groups": 1, "members": 2, "places": 2})
        self.assertEqual(report["inserted"], {"groups": 0, "members": 0, "places": 0})
        self.assertIsNone(self.pg("SELECT to_regclass('groups') AS t")[0]["t"])  # not even the tables
        self.assertTrue(any("Dry run" in line for line in self.log))

    def test_apply_copies_everything_and_the_app_can_use_it(self):
        before = self.file_hash()
        report = self.run_migration(apply=True)
        self.assertEqual(report["inserted"], {"groups": 1, "members": 2, "places": 2})
        self.assertEqual(self.file_hash(), before)  # the SQLite backup is untouched
        old_db, server.DB = server.DB, self.db
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        httpd.RequestHandlerClass.log_message = lambda *a: None
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            api = Client(httpd.server_address[1])
            status, st = api.call("GET", "/api/groups/g1/state", token=self.maya_token)  # old sessions still work
            self.assertEqual(status, 200)
            self.assertEqual(st["me"], "m_maya")
            self.assertEqual([(m["id"], m["isHost"], m["avail"], m["votes"]) for m in st["members"]],
                             [("m_host", True, ["2026-10-20@18"], {"p1": 1}), ("m_maya", False, [], {"p1": -1, "p2": 0})])
            self.assertEqual([(p["id"], p["details"]) for p in st["places"]],
                             [("p1", {"source": "manual", "area": "Botanic Gardens", "lat": 1.3138}), ("p2", None)])
            status, joined = api.call("POST", "/api/groups/g1/join", {"name": "Jun", "password": "sunflower"})
            self.assertEqual(status, 201)  # the old password hash still verifies
            self.assertEqual(api.call("POST", "/api/groups/g1/join", {"name": "Kai", "password": "nope"})[0], 403)
        finally:
            httpd.shutdown()
            httpd.server_close()
            server.DB = old_db

    def test_running_again_adds_nothing(self):
        self.run_migration(apply=True)
        report = self.run_migration(apply=True)
        self.assertEqual(report["inserted"], {"groups": 0, "members": 0, "places": 0})
        self.assertEqual(report["skipped"], {"groups": 1, "members": 2, "places": 2})
        self.assertEqual(self.pg("SELECT count(*) AS n FROM members")[0]["n"], 2)

    def test_conflicting_rows_are_never_overwritten(self):
        self.run_migration(apply=True)
        with self.db.transaction() as conn:
            conn.execute("UPDATE groups SET title='Changed in Postgres' WHERE id='g1'")
        with closing(sqlite3.connect(self.path)) as c, c:  # a new row that must NOT go in while there's a conflict
            c.execute("INSERT INTO places VALUES ('p3','g1','Bowling','activity','m_host',1760000060,NULL)")
        with self.assertRaises(mig.MigrationError) as cm:
            self.run_migration(apply=True)
        self.assertIn("'g1'", str(cm.exception))
        self.assertIn("title", str(cm.exception))
        self.assertEqual(self.pg("SELECT title FROM groups")[0]["title"], "Changed in Postgres")
        self.assertEqual(self.pg("SELECT count(*) AS n FROM places")[0]["n"], 2)

    def test_broken_sqlite_links_stop_the_migration(self):
        with closing(sqlite3.connect(self.path)) as c, c:
            c.execute("PRAGMA foreign_keys=OFF")
            c.execute("INSERT INTO places VALUES ('p9','g1','Ghost','food','m_gone',1760000070,NULL)")
        with self.assertRaises(mig.MigrationError) as cm:
            self.run_migration(apply=True)
        self.assertIn("missing member", str(cm.exception))
        self.assertIsNone(self.pg("SELECT to_regclass('groups') AS t")[0]["t"])

    def test_failed_verification_rolls_back_everything(self):
        with mock.patch.object(mig, "verify", return_value=["simulated mismatch"]):
            with self.assertRaises(mig.MigrationError):
                self.run_migration(apply=True)
        self.assertIsNone(self.pg("SELECT to_regclass('groups') AS t")[0]["t"])


if __name__ == "__main__":
    unittest.main()
