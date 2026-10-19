#!/usr/bin/env python3
"""Copy Bloom's groups, members and places from SQLite (data/bloom.db) into PostgreSQL.

Safe by design:
  * Dry run by default. Nothing is written unless you pass --apply.
  * The SQLite file is opened read-only and is never changed or deleted (keep it as a backup).
  * Repeatable: rows already in PostgreSQL with identical data are skipped, so running it
    again inserts nothing new. Nothing is ever updated, overwritten or deleted.
  * If a row with the same id exists in PostgreSQL with DIFFERENT data, that's a conflict:
    the run stops before writing anything and lists the ids to look at.
  * --apply writes everything in one transaction, then re-reads and verifies every row and
    relationship before committing. Any mismatch rolls the whole run back.
  * The connection string is never printed.

Usage:
  python3 migrate_sqlite_to_postgres.py                 # dry run: report what would happen
  python3 migrate_sqlite_to_postgres.py --apply         # copy (asks you to type "migrate")
  python3 migrate_sqlite_to_postgres.py --sqlite other.db --apply --yes
"""
import argparse
import json
import os
import sqlite3
import sys
from urllib.parse import quote

import psycopg

import bloomdb
from bloomdb import Database, DatabaseConfigError, Jsonb

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SQLITE = os.path.join(ROOT, "data", "bloom.db")
TABLES = ("groups", "members", "places")
COLUMNS = {
    "groups": ("id", "title", "host_name", "start_date", "pw_salt", "pw_hash", "created_at"),
    "members": ("id", "group_id", "name", "color", "token_hash", "avail", "votes", "is_host", "joined_at", "updated_at"),
    "places": ("id", "group_id", "name", "kind", "added_by", "created_at", "details"),
}
JSON_COLUMNS = {"avail", "votes", "details"}


class MigrationError(Exception):
    pass


# ---------- reading SQLite ----------

def read_sqlite(path):
    """Every row, in original insertion order, normalised to PostgreSQL types."""
    if not os.path.isfile(path):
        raise MigrationError(f"SQLite file not found: {path}")
    # mode=ro: SQLite refuses any write, so the backup can't be touched.
    conn = sqlite3.connect("file:" + quote(os.path.abspath(path)) + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        have = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        missing = [t for t in TABLES if t not in have]
        if missing:
            raise MigrationError("SQLite file has no " + ", ".join(missing) + " table(s); is it a Bloom database?")
        data = {}
        for t in TABLES:
            cols = {r[1] for r in conn.execute(f"PRAGMA table_info({t})")}
            select = ", ".join(c if c in cols else f"NULL AS {c}" for c in COLUMNS[t])  # old files lack places.details
            data[t] = [normalise(t, dict(r)) for r in conn.execute(f"SELECT {select} FROM {t} ORDER BY rowid")]
        return data
    finally:
        conn.close()


def normalise(table, row):
    out = dict(row)
    for c in JSON_COLUMNS & out.keys():
        v = out[c]
        if v is None or v == "":
            out[c] = None if c == "details" else ([] if c == "avail" else {})
            continue
        try:
            out[c] = json.loads(v)
        except (TypeError, ValueError):
            raise MigrationError(f"{table} {out['id']!r}: column {c} isn't valid JSON") from None
    if table == "groups":
        out["pw_salt"], out["pw_hash"] = bytes(out["pw_salt"]), bytes(out["pw_hash"])
    if table == "members":
        out["is_host"] = bool(out["is_host"])
    return out


def check_relationships(data):
    """Problems inside the SQLite data itself (orphans, cross-group links)."""
    problems = []
    groups = {g["id"] for g in data["groups"]}
    member_group = {m["id"]: m["group_id"] for m in data["members"]}
    for m in data["members"]:
        if m["group_id"] not in groups:
            problems.append(f"member {m['id']!r} belongs to missing group {m['group_id']!r}")
    for p in data["places"]:
        if p["group_id"] not in groups:
            problems.append(f"place {p['id']!r} belongs to missing group {p['group_id']!r}")
        if p["added_by"] not in member_group:
            problems.append(f"place {p['id']!r} was added by missing member {p['added_by']!r}")
        elif member_group[p["added_by"]] != p["group_id"]:
            problems.append(f"place {p['id']!r} was added by a member of another group")
    return problems


def vote_warnings(data):
    """Votes for places that aren't in the member's group. Copied as they are (the app
    ignores them), but worth knowing about."""
    place_group = {p["id"]: p["group_id"] for p in data["places"]}
    out = []
    for m in data["members"]:
        stray = [pid for pid in m["votes"] if place_group.get(pid) != m["group_id"]]
        if stray:
            out.append(f"member {m['id']!r} has {len(stray)} vote(s) for places outside their group")
    return out


# ---------- comparing with PostgreSQL ----------

def tables_exist(conn):
    rows = conn.execute("SELECT to_regclass('groups') AS g, to_regclass('members') AS m, to_regclass('places') AS p").fetchone()
    return all(rows.values())


def fetch_existing(conn, table, ids):
    if not ids:
        return {}
    cols = ", ".join(COLUMNS[table])
    rows = conn.execute(f"SELECT {cols} FROM {table} WHERE id = ANY(%s)", (list(ids),)).fetchall()
    for r in rows:
        if table == "groups":
            r["pw_salt"], r["pw_hash"] = bytes(r["pw_salt"]), bytes(r["pw_hash"])
    return {r["id"]: r for r in rows}


def plan(conn, data, have_tables):
    """For each table: rows to insert, identical rows to skip, conflicting ids."""
    result = {}
    for t in TABLES:
        rows = data[t]
        existing = fetch_existing(conn, t, [r["id"] for r in rows]) if have_tables else {}
        insert, same, conflict = [], [], []
        for r in rows:
            if r["id"] not in existing:
                insert.append(r)
            elif existing[r["id"]] == r:
                same.append(r)
            else:
                diff = sorted(c for c in COLUMNS[t] if existing[r["id"]].get(c) != r.get(c))
                conflict.append((r["id"], diff))
        result[t] = {"insert": insert, "same": same, "conflict": conflict}
    return result


def insert_rows(conn, table, rows):
    cols = COLUMNS[table]
    sql = (f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))}) "
           "ON CONFLICT (id) DO NOTHING")
    inserted = 0
    for r in rows:  # in SQLite rowid order, so seq keeps the original order
        vals = [Jsonb(r[c]) if c in JSON_COLUMNS and r[c] is not None else r[c] for c in cols]
        inserted += conn.execute(sql, vals).rowcount
    return inserted


def verify(conn, data):
    """Every SQLite row is in PostgreSQL with identical values, and its links hold there."""
    problems = []
    for t in TABLES:
        existing = fetch_existing(conn, t, [r["id"] for r in data[t]])
        for r in data[t]:
            got = existing.get(r["id"])
            if got is None:
                problems.append(f"{t} {r['id']!r} is missing after the copy")
            elif got != r:
                problems.append(f"{t} {r['id']!r} differs after the copy")
    ids = [g["id"] for g in data["groups"]]
    if ids:
        orphans = conn.execute(
            "SELECT count(*) AS n FROM places p JOIN members m ON m.id = p.added_by "
            "WHERE p.group_id = ANY(%s) AND m.group_id <> p.group_id", (ids,)).fetchone()["n"]
        if orphans:
            problems.append(f"{orphans} place(s) linked to a member of another group")
        counts = conn.execute(
            "SELECT (SELECT count(*) FROM members WHERE group_id = ANY(%s)) AS members, "
            "(SELECT count(*) FROM places WHERE group_id = ANY(%s)) AS places", (ids, ids)).fetchone()
        for t in ("members", "places"):
            if counts[t] < len(data[t]):
                problems.append(f"{t}: PostgreSQL has {counts[t]} for these groups, SQLite has {len(data[t])}")
    return problems


# ---------- the run ----------

def migrate(sqlite_path, db, apply=False, out=print):
    """Returns a report dict. Raises MigrationError (nothing written) on any problem."""
    data = read_sqlite(sqlite_path)
    out(f"SQLite source: {sqlite_path} (opened read-only)")
    out("  " + ", ".join(f"{t}: {len(data[t])}" for t in TABLES))
    problems = check_relationships(data)
    if problems:
        raise MigrationError("The SQLite data has broken links, so nothing was copied:\n  - " + "\n  - ".join(problems))
    for w in vote_warnings(data):
        out("  note: " + w)

    with db.transaction() as conn:
        have_tables = tables_exist(conn)
        if not have_tables:
            out("PostgreSQL: Bloom tables don't exist yet" + (" — creating them (db/schema.sql)" if apply else " (--apply would create them)"))
            if apply:
                with open(bloomdb.SCHEMA_FILE) as f:
                    conn.execute(f.read())
                have_tables = True
        p = plan(conn, data, have_tables)
        out(f"PostgreSQL target: {db.describe()}")
        for t in TABLES:
            out(f"  {t}: {len(p[t]['insert'])} to copy, {len(p[t]['same'])} already there (identical), "
                f"{len(p[t]['conflict'])} conflict(s)")
        conflicts = [(t, i, d) for t in TABLES for i, d in p[t]["conflict"]]
        if conflicts:
            lines = [f"{t} {i!r} (differs in: {', '.join(d)})" for t, i, d in conflicts[:20]]
            raise MigrationError("Some ids already exist in PostgreSQL with different data. Nothing was written; "
                                 "existing rows are never overwritten. Check these:\n  - " + "\n  - ".join(lines))
        report = {"apply": apply, "counts": {t: len(data[t]) for t in TABLES},
                  "inserted": {t: 0 for t in TABLES}, "skipped": {t: len(p[t]["same"]) for t in TABLES}}
        if not apply:
            out("Dry run: nothing was written. Run again with --apply to copy.")
            conn.rollback()
            return report
        for t in TABLES:  # parents first so every foreign key already exists
            report["inserted"][t] = insert_rows(conn, t, p[t]["insert"])
        problems = verify(conn, data)
        if problems:
            raise MigrationError("Verification failed, so the copy was rolled back:\n  - " + "\n  - ".join(problems[:20]))
        out("Copied: " + ", ".join(f"{t}: {report['inserted'][t]}" for t in TABLES))
        out("Verified: every row and relationship matches the SQLite file. Committing.")
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description="Copy Bloom data from SQLite into PostgreSQL (dry run unless --apply).")
    ap.add_argument("--sqlite", default=DEFAULT_SQLITE, help="SQLite file to read (default: data/bloom.db)")
    ap.add_argument("--apply", action="store_true", help="actually write to PostgreSQL")
    ap.add_argument("--yes", action="store_true", help="don't ask for confirmation with --apply")
    args = ap.parse_args(argv)

    import server  # noqa: F401  (loads .env the same way the app does)
    try:
        db = Database(bloomdb.database_url(), max_size=1).open()
    except DatabaseConfigError as e:
        sys.exit(f"Can't connect: {e}")
    try:
        if args.apply and not args.yes:
            migrate(args.sqlite, db, apply=False)
            if input('\nType "migrate" to copy these rows into PostgreSQL: ').strip() != "migrate":
                sys.exit("Cancelled. Nothing was written.")
        migrate(args.sqlite, db, apply=args.apply)
    except MigrationError as e:
        sys.exit(f"Stopped: {e}")
    except psycopg.Error as e:
        sys.exit(f"Database error, nothing was committed: {bloomdb.redact(e, db.url)}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
