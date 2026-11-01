"""Tie test for the (created_at, id) cursor used by /api/entries?cursor=.
Same WHERE/ORDER BY as lib/common-store.ts listEntries, on an in-memory SQLite
table where many rows share a millisecond. Exits non-zero on any skip/repeat.
Also shows the bare created_at < ? cursor skipping rows (the bug it fixes)."""
import sqlite3, sys

db = sqlite3.connect(":memory:")
db.execute("CREATE TABLE entries (id TEXT PRIMARY KEY, created_at INTEGER)")
rows = []
for t in range(1000, 1010):  # 10 timestamps
    for k in range(7):  # 7 rows share each timestamp (ties span page edges)
        rows.append((f"e{t}_{k}", t))
db.executemany("INSERT INTO entries VALUES (?,?)", rows)
want = {r[0] for r in rows}

def walk(limit, composite):
    got, cur = [], None
    while True:
        if cur is None:
            q, a = "SELECT id, created_at FROM entries ORDER BY created_at DESC, id DESC LIMIT ?", [limit + 1]
        elif composite:
            q = "SELECT id, created_at FROM entries WHERE (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?"
            a = [cur[1], cur[1], cur[0], limit + 1]
        else:
            q = "SELECT id, created_at FROM entries WHERE created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?"
            a = [cur[1], limit + 1]
        res = db.execute(q, a).fetchall()
        page = res[:limit]
        got += [r[0] for r in page]
        if len(res) <= limit:
            return got
        cur = page[-1]

bad = 0
for limit in (1, 3, 5, 7, 10, 13, 70):
    g = walk(limit, True)
    ok = len(g) == len(set(g)) == len(want) and set(g) == want
    skipped = len(want) - len(set(walk(limit, False)))
    print(f"limit={limit:3d} cursor: {len(g)} rows, repeats={len(g)-len(set(g))}, ok={ok}; bare created_at cursor skipped {skipped}")
    bad += not ok
sys.exit(1 if bad else 0)
