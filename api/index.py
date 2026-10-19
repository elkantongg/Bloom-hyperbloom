"""Vercel entry point. Every request (the page, its scripts and the API) goes through
Bloom's own request handler in server.py, so the same file whitelist, security headers
and rate limits apply as when running `python3 server.py`.

Vercel runs this as a serverless function: it may start fresh for a request, and several
copies may run at once. So the database connection is opened lazily (and
retried if it failed) on the first group request, with a small pool per copy. Set DATABASE_URL in Vercel's project
settings; use Supabase's transaction pooler (port 6543).
"""
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402
from bloomdb import DatabaseConfigError  # noqa: E402

_LOCK = threading.Lock()


def _database_ready():
    if server.DB is not None:
        return True
    with _LOCK:
        if server.DB is None:
            try:
                # One copy of the function serves one request at a time, so a tiny pool is enough
                # and keeps Supabase's connection limit free for other copies.
                server.init_database(min_size=1, max_size=int(os.environ.get("BLOOM_DB_POOL_MAX", "2")))
            except DatabaseConfigError as e:
                print(f"Bloom database unavailable: {e}")  # already password-free
                return False
    return True


class handler(server.Handler):
    # Pages and place search don't need the database, so only group requests wait for it.
    def api(self, *args, **kwargs):
        if not _database_ready():
            return self.send_json(503, {"error": "Bloom can't reach its database right now. Try again in a minute."})
        return super().api(*args, **kwargs)
