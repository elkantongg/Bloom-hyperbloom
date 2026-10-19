"""PostgreSQL (Supabase) connection handling for Bloom.

Reads DATABASE_URL, refuses to start on a missing or malformed value (there is
no silent fallback to SQLite), and hands out pooled connections that commit on
success and roll back on any error, so a failure can't leave half-written data.
Credentials are never printed: every error message goes through redact().
"""
import os
import urllib.parse
from contextlib import contextmanager

try:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
    from psycopg_pool import ConnectionPool
except ImportError:  # pragma: no cover
    raise SystemExit("Bloom needs the PostgreSQL driver. Install it with:\n"
                     "  python3 -m pip install -r requirements.txt") from None

ROOT = os.path.dirname(os.path.abspath(__file__))
SCHEMA_FILE = os.path.join(ROOT, "db", "schema.sql")
PLACEHOLDERS = ("YOUR_CONNECTION_STRING", "[YOUR-PASSWORD]", "YOUR-PASSWORD")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}

__all__ = ["Database", "DatabaseConfigError", "Jsonb", "database_url", "psycopg", "redact"]


class DatabaseConfigError(Exception):
    """DATABASE_URL is missing, still the placeholder, or not a PostgreSQL URI."""


def database_url(env=None):
    """The validated DATABASE_URL. Raises DatabaseConfigError with a safe message."""
    url = ((env if env is not None else os.environ).get("DATABASE_URL") or "").strip()
    if not url:
        raise DatabaseConfigError(
            "DATABASE_URL is not set. Add your Supabase connection string to .env "
            "(DATABASE_URL=postgresql://...). Bloom no longer falls back to SQLite.")
    if any(p in url for p in PLACEHOLDERS):
        raise DatabaseConfigError(
            "DATABASE_URL still contains the placeholder. Replace it in .env with the full "
            "URI from Supabase (Project Settings > Database > Connection string).")
    try:
        u = urllib.parse.urlsplit(url)
        u.port  # raises ValueError for a non-numeric port
    except ValueError:
        raise DatabaseConfigError("DATABASE_URL isn't a valid URI. Check it in .env; special "
                                  "characters in the password (@ # / ? %) must be percent-encoded.") from None
    if u.scheme not in ("postgresql", "postgres"):
        raise DatabaseConfigError("DATABASE_URL must start with postgresql:// (got a different scheme).")
    if not u.hostname or not u.username:
        raise DatabaseConfigError("DATABASE_URL must include a user and host, "
                                  "like postgresql://USER:PASSWORD@HOST:5432/postgres")
    if u.password is None and u.hostname not in LOCAL_HOSTS:
        raise DatabaseConfigError("DATABASE_URL has no password. Use the full URI from Supabase, "
                                  "with your database password filled in.")
    return url


def redact(message, url):
    """Remove the URL and its password (raw and percent-decoded) from a message."""
    message = str(message)
    if not url:
        return message
    secrets = [url]
    try:
        u = urllib.parse.urlsplit(url)
        raw = u.netloc.rpartition("@")[0].partition(":")[2]
        secrets += [raw, urllib.parse.unquote(raw)]
    except ValueError:
        pass
    for s in sorted({s for s in secrets if s}, key=len, reverse=True):
        message = message.replace(s, "***")
    return message


def connect_kwargs(url, search_path=None):
    """Options for every connection: encrypted for remote hosts, pooler-friendly."""
    u = urllib.parse.urlsplit(url)
    params = urllib.parse.parse_qs(u.query)
    kw = {
        "row_factory": dict_row,
        # Supabase's transaction pooler (port 6543) doesn't support prepared statements.
        "prepare_threshold": None,
        "connect_timeout": int(os.environ.get("BLOOM_DB_CONNECT_TIMEOUT", "10")),
        "application_name": "bloom",
    }
    if "sslmode" not in params and u.hostname not in LOCAL_HOSTS:
        kw["sslmode"] = "require"  # never send the password or data unencrypted
    if search_path:  # used by the tests to work in their own throwaway schema
        kw["options"] = "-c search_path=" + search_path
    return kw


class Database:
    """A small connection pool. Use `with db.transaction() as conn:` for all work."""

    def __init__(self, url, min_size=1, max_size=None, search_path=None):
        self.url = url
        self.kwargs = connect_kwargs(url, search_path)
        self.pool = ConnectionPool(
            url, kwargs=self.kwargs, min_size=min_size,
            max_size=max_size or int(os.environ.get("BLOOM_DB_POOL_MAX", "5")),
            timeout=float(os.environ.get("BLOOM_DB_POOL_TIMEOUT", "10")),
            open=False, name="bloom", check=ConnectionPool.check_connection)

    def open(self):
        """Connect once directly (for a clear, redacted error), then start the pool."""
        try:
            with psycopg.connect(self.url, **self.kwargs) as conn:
                conn.execute("SELECT 1")
        except psycopg.Error as e:
            raise DatabaseConfigError("Couldn't connect to PostgreSQL: " + redact(e, self.url).strip()) from None
        self.pool.open(wait=True, timeout=30)
        return self

    def close(self):
        self.pool.close()

    @contextmanager
    def transaction(self):
        """One transaction: committed when the block finishes, rolled back on any error."""
        with self.pool.connection() as conn:
            yield conn

    def apply_schema(self):
        """Create any missing tables and indexes (never drops or alters existing data)."""
        with open(SCHEMA_FILE) as f:
            sql = f.read()
        with self.transaction() as conn:
            conn.execute(sql)

    def describe(self):
        """'host:port/dbname' for logs, without the user or password."""
        u = urllib.parse.urlsplit(self.url)
        return f"{u.hostname}:{u.port or 5432}{u.path or '/'}"
