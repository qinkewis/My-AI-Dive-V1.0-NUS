"""SQLite storage: papers, folders, notes, chats, jobs (+ FTS5 full-text index)."""
import json
import secrets
import sqlite3
import threading
import time

from .config import DB_PATH, TEXT_DIR

_lock = threading.RLock()
_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode=WAL")

_conn.executescript(
    """
CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  authors TEXT NOT NULL DEFAULT '[]',
  year INTEGER,
  venue TEXT DEFAULT '',
  doi TEXT DEFAULT '',
  abstract TEXT DEFAULT '',
  url TEXT DEFAULT '',
  oa_url TEXT DEFAULT '',
  cited_by INTEGER,
  folder TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  has_pdf INTEGER NOT NULL DEFAULT 0,
  pages INTEGER,
  source TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  read_status TEXT NOT NULL DEFAULT 'unread',
  starred INTEGER NOT NULL DEFAULT 0,
  dl_status TEXT DEFAULT '',
  dl_error TEXT DEFAULT '',
  last_page INTEGER DEFAULT 1,
  added_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS papers_doi ON papers(doi);
CREATE INDEX IF NOT EXISTS papers_folder ON papers(folder);
CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, title TEXT, content TEXT, scope TEXT, created_at REAL, updated_at REAL
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, title TEXT, scope TEXT, session_id TEXT, created_at REAL, updated_at REAL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, role TEXT, content TEXT, meta TEXT, created_at REAL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT, title TEXT, status TEXT, total INTEGER, done INTEGER,
  failed INTEGER, log TEXT, created_at REAL, updated_at REAL
);
CREATE TABLE IF NOT EXISTS vocab (
  id TEXT PRIMARY KEY, term TEXT NOT NULL, definition TEXT DEFAULT '', translation TEXT DEFAULT '',
  context TEXT DEFAULT '', paper_id TEXT DEFAULT '', page INTEGER, status TEXT DEFAULT '',
  box INTEGER NOT NULL DEFAULT 0, due REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
  id UNINDEXED, title, authors, abstract, body, tokenize='unicode61 remove_diacritics 2'
);
"""
)
if "team_key" not in {r[1] for r in _conn.execute("PRAGMA table_info(papers)")}:
    _conn.execute("ALTER TABLE papers ADD COLUMN team_key TEXT NOT NULL DEFAULT ''")
# Jobs that were running when the app stopped can never finish.
_conn.execute("UPDATE jobs SET status='interrupted' WHERE status IN ('running','queued')")
_conn.commit()


def new_id(n: int = 5) -> str:
    return secrets.token_hex(n)


def q(sql: str, args=()) -> list[dict]:
    with _lock:
        return [dict(r) for r in _conn.execute(sql, args).fetchall()]


def q1(sql: str, args=()) -> dict | None:
    rows = q(sql, args)
    return rows[0] if rows else None


def ex(sql: str, args=()) -> int:
    with _lock:
        cur = _conn.execute(sql, args)
        _conn.commit()
        return cur.rowcount


# ---------- papers ----------

PAPER_FIELDS = {
    "title", "authors", "year", "venue", "doi", "abstract", "url", "oa_url", "cited_by", "folder",
    "tags", "has_pdf", "pages", "source", "summary", "notes", "read_status", "starred",
    "dl_status", "dl_error", "last_page", "team_key",
}


def _decode(p: dict | None) -> dict | None:
    if p:
        p["authors"] = json.loads(p.get("authors") or "[]")
        p["tags"] = json.loads(p.get("tags") or "[]")
    return p


def get_paper(pid: str) -> dict | None:
    return _decode(q1("SELECT * FROM papers WHERE id=?", (pid,)))


def find_by_doi(doi: str) -> dict | None:
    if not doi:
        return None
    return _decode(q1("SELECT * FROM papers WHERE lower(doi)=lower(?)", (doi,)))


def insert_paper(**f) -> dict:
    pid = f.pop("id", None) or new_id()
    f = {k: v for k, v in f.items() if k in PAPER_FIELDS}
    for k in ("authors", "tags"):
        if k in f and not isinstance(f[k], str):
            f[k] = json.dumps(f[k], ensure_ascii=False)
    f.setdefault("title", "Untitled")
    cols = ["id", "added_at", *f.keys()]
    with _lock:
        _conn.execute(
            f"INSERT INTO papers ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
            (pid, time.time(), *f.values()),
        )
        if f.get("folder"):
            _conn.execute("INSERT OR IGNORE INTO folders(path) VALUES (?)", (f["folder"],))
        _conn.commit()
    reindex(pid)
    return get_paper(pid)


def update_paper(pid: str, **f) -> dict | None:
    f = {k: v for k, v in f.items() if k in PAPER_FIELDS}
    if not f:
        return get_paper(pid)
    for k in ("authors", "tags"):
        if k in f and not isinstance(f[k], str):
            f[k] = json.dumps(f[k], ensure_ascii=False)
    with _lock:
        _conn.execute(
            f"UPDATE papers SET {','.join(k + '=?' for k in f)} WHERE id=?", (*f.values(), pid)
        )
        if f.get("folder"):
            _conn.execute("INSERT OR IGNORE INTO folders(path) VALUES (?)", (f["folder"],))
        _conn.commit()
    if f.keys() & {"title", "authors", "abstract", "has_pdf"}:
        reindex(pid)
    return get_paper(pid)


def reindex(pid: str):
    p = get_paper(pid)
    if not p:
        return
    tf = TEXT_DIR / f"{pid}.md"
    body = tf.read_text(errors="ignore") if tf.exists() else ""
    with _lock:
        _conn.execute("DELETE FROM papers_fts WHERE id=?", (pid,))
        _conn.execute(
            "INSERT INTO papers_fts(id,title,authors,abstract,body) VALUES (?,?,?,?,?)",
            (pid, p["title"], ", ".join(p["authors"]), p["abstract"] or "", body),
        )
        _conn.commit()


def delete_paper(pid: str):
    with _lock:
        _conn.execute("DELETE FROM papers WHERE id=?", (pid,))
        _conn.execute("DELETE FROM papers_fts WHERE id=?", (pid,))
        _conn.commit()


def list_papers(view: str = "all", folder: str | None = None, search: str = "", sort: str = "added") -> list[dict]:
    where, args = [], []
    if folder is not None:
        where.append("(p.folder=? OR p.folder LIKE ?)")
        args += [folder, folder + "/%"]
    if view == "starred":
        where.append("p.starred=1")
    elif view == "unread":
        where.append("p.read_status='unread'")
    elif view == "nopdf":
        where.append("p.has_pdf=0")
    join = ""
    if search.strip():
        join = "JOIN (SELECT id AS fid, rank FROM papers_fts WHERE papers_fts MATCH ?) f ON f.fid=p.id"
        args.insert(0, _fts_query(search))
    order = {
        "added": "p.added_at DESC",
        "year": "p.year DESC NULLS LAST, p.added_at DESC",
        "title": "p.title COLLATE NOCASE",
        "cited": "p.cited_by DESC NULLS LAST",
        "relevance": "f.rank" if join else "p.added_at DESC",
    }.get(sort, "p.added_at DESC")
    sql = (
        "SELECT p.id,p.title,p.authors,p.year,p.venue,p.doi,p.folder,p.tags,p.has_pdf,p.pages,"
        "p.read_status,p.starred,p.dl_status,p.dl_error,p.cited_by,p.added_at,p.team_key,"
        "(p.summary<>'') AS has_summary FROM papers p " + join
        + (" WHERE " + " AND ".join(where) if where else "") + f" ORDER BY {order} LIMIT 5000"
    )
    try:
        return [_decode(r) for r in q(sql, args)]
    except sqlite3.OperationalError:
        return []


def _fts_query(s: str) -> str:
    # Treat every word as a prefix term; quote to neutralise FTS syntax characters.
    words = [w.replace('"', "") for w in s.split() if w.strip()]
    return " ".join(f'"{w}"*' for w in words if w)


def search_snippets(search: str, limit: int = 30) -> list[dict]:
    try:
        return q(
            "SELECT id, snippet(papers_fts, 4, '<mark>', '</mark>', ' … ', 18) AS snip "
            "FROM papers_fts WHERE papers_fts MATCH ? ORDER BY rank LIMIT ?",
            (_fts_query(search), limit),
        )
    except sqlite3.OperationalError:
        return []


# ---------- folders ----------

def list_folders() -> list[dict]:
    paths = {r["path"] for r in q("SELECT path FROM folders")}
    paths |= {r["folder"] for r in q("SELECT DISTINCT folder FROM papers WHERE folder<>''")}
    # include implicit parents
    for p in list(paths):
        parts = p.split("/")
        for i in range(1, len(parts)):
            paths.add("/".join(parts[:i]))
    counts = {r["folder"]: r["n"] for r in q("SELECT folder, count(*) n FROM papers GROUP BY folder")}
    out = []
    for p in sorted(paths, key=str.lower):
        total = sum(n for f, n in counts.items() if f == p or f.startswith(p + "/"))
        out.append({"path": p, "count": total})
    return out


def rename_folder(old: str, new: str):
    with _lock:
        for r in _conn.execute("SELECT path FROM folders WHERE path=? OR path LIKE ?", (old, old + "/%")).fetchall():
            _conn.execute("UPDATE OR IGNORE folders SET path=? WHERE path=?", (new + r[0][len(old):], r[0]))
        _conn.execute(
            "UPDATE papers SET folder=? || substr(folder, ?) WHERE folder=? OR folder LIKE ?",
            (new, len(old) + 1, old, old + "/%"),
        )
        _conn.execute("DELETE FROM folders WHERE path=? OR path LIKE ?", (old, old + "/%"))
        _conn.execute("INSERT OR IGNORE INTO folders(path) VALUES (?)", (new,))
        _conn.commit()


def delete_folder(path: str):
    """Removes the folder; its papers move to the parent folder (never deleted)."""
    parent = path.rsplit("/", 1)[0] if "/" in path else ""
    with _lock:
        _conn.execute("UPDATE papers SET folder=? WHERE folder=? OR folder LIKE ?", (parent, path, path + "/%"))
        _conn.execute("DELETE FROM folders WHERE path=? OR path LIKE ?", (path, path + "/%"))
        _conn.commit()
