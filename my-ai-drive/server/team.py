"""Team sharing through a folder everyone syncs (Dropbox, OneDrive, Google Drive, a NAS…).

<team_dir>/
  <Author Year – Short title> [key]/
    paper.pdf            written once, by whoever shares the paper first
    info.json            metadata, plus who shared it and when
    notes - <Name>.md    one member's reading notes; only that member ever writes this file

No server and no merge conflicts, because every file has exactly one writer. Teammates who don't
use the app can still open the folder: the PDFs and notes are plain files.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

from . import db
from .config import PAPERS_DIR, TEXT_DIR, load_settings
from .pdftools import extract_text, write_metadata_only_text

INFO = "info.json"
NOTE_RE = re.compile(r"^notes - (.+)\.md$")
_BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')
_os_name: str | None = None


def team_dir() -> Path | None:
    d = load_settings()["team_dir"].strip()
    p = Path(os.path.expanduser(d)) if d else None
    return p if p and p.is_dir() else None


def _require() -> Path:
    root = team_dir()
    if not root:
        raise ValueError("Set a team folder in Settings → Team sharing first")
    return root


def my_name() -> str:
    global _os_name
    n = load_settings()["my_name"].strip()
    if not n:
        if _os_name is None:
            try:
                _os_name = subprocess.run(["id", "-F"], capture_output=True, text=True, timeout=3).stdout.strip()
            except Exception:
                _os_name = ""
            _os_name = _os_name or os.environ.get("USER", "")
        n = _os_name
    return _BAD.sub(" ", n).strip() or "Me"


def key_for(p: dict) -> str:
    """Same paper → same key on every member's machine (DOI, else normalised title)."""
    basis = "doi:" + p["doi"].lower() if p.get("doi") else "title:" + re.sub(r"\W+", "", (p.get("title") or "").lower())
    return hashlib.sha1(basis.encode()).hexdigest()[:10]


def _folder_name(p: dict, key: str) -> str:
    author = (p["authors"][0].split() or [""])[-1] if p.get("authors") else ""
    head = " ".join(x for x in (author, str(p.get("year") or "")) if x)
    title = " ".join(_BAD.sub(" ", p.get("title") or "Untitled").split())
    name = (f"{head} – {title}" if head else title)[:80].rstrip(" .–")
    return f"{name} [{key}]"


def _find(root: Path, key: str) -> Path | None:
    for e in os.scandir(root):
        if e.is_dir() and e.name.endswith(f"[{key}]"):
            return Path(e.path)
    return None


def _write(path: Path, data: bytes | str):
    """Write via a temp file so the sync client never uploads a half-written file."""
    tmp = path.with_name("." + path.name + ".tmp")
    tmp.write_bytes(data.encode() if isinstance(data, str) else data)
    tmp.replace(path)


def _info(d: Path) -> dict | None:
    try:
        return json.loads((d / INFO).read_text())
    except Exception:
        return None


def _notes(d: Path) -> list[dict]:
    out = []
    for f in d.iterdir():
        m = NOTE_RE.match(f.name)
        if m:
            out.append({"by": m.group(1), "updated": f.stat().st_mtime, "text": f.read_text(errors="ignore")})
    return sorted(out, key=lambda n: n["updated"], reverse=True)


# Note citations point at a paper id that only exists in one library, so the shared copy uses
# plain "[p.N]" page refs and each library turns them back into links to its own copy.
def _to_shared(text: str, pid: str) -> str:
    return re.sub(rf"\[@{pid}\s+(p\.\s*\d+)\]", r"[\1]", text)


def to_local(text: str, pid: str) -> str:
    return re.sub(r"\[(p\.\s*\d+)\]", rf"[@{pid} \1]", text)


# ---------- actions ----------

def share(pid: str) -> str:
    root = _require()
    p = db.get_paper(pid)
    key = p["team_key"] or key_for(p)
    d = _find(root, key)
    if not d:
        d = root / _folder_name(p, key)
        d.mkdir()
        info = {k: p[k] for k in ("title", "authors", "year", "venue", "doi", "abstract", "url")}
        _write(d / INFO, json.dumps({**info, "key": key, "shared_by": my_name(), "shared_at": time.time()},
                                    indent=2, ensure_ascii=False))
    if p["has_pdf"] and not (d / "paper.pdf").exists():
        _write(d / "paper.pdf", (PAPERS_DIR / f"{pid}.pdf").read_bytes())
    db.update_paper(pid, team_key=key)
    sync_notes(pid)
    return key


def sync_notes(pid: str):
    """Mirrors my notes on a shared paper into the team folder (called on every notes save)."""
    p = db.get_paper(pid)
    root = team_dir()
    d = root and p and p["team_key"] and _find(root, p["team_key"])
    if not d:
        return
    f = d / f"notes - {my_name()}.md"
    if p["notes"].strip():
        _write(f, _to_shared(p["notes"], pid))
    else:
        f.unlink(missing_ok=True)


def unshare(pid: str):
    """Removes my notes; removes the whole entry only if I shared it and nobody else has notes on it."""
    p = db.get_paper(pid)
    root = team_dir()
    d = root and p["team_key"] and _find(root, p["team_key"])
    if d:
        me = my_name()
        (d / f"notes - {me}.md").unlink(missing_ok=True)
        if (_info(d) or {}).get("shared_by") == me and not _notes(d):
            shutil.rmtree(d)
    db.update_paper(pid, team_key="")


def add_to_library(key: str) -> str:
    """Brings a teammate's shared paper into my library (or links my existing copy). Returns its id."""
    d = _find(_require(), key)
    info = d and _info(d)
    if not info:
        raise ValueError("That paper is no longer in the team folder")
    pdf = d / "paper.pdf"
    p = db.find_by_doi(info.get("doi", "")) or db.q1("SELECT id FROM papers WHERE team_key=?", (key,))
    if p:
        pid = p["id"]
        db.update_paper(pid, team_key=key)
        p = db.get_paper(pid)
        if not p["has_pdf"] and pdf.exists():
            shutil.copyfile(pdf, PAPERS_DIR / f"{pid}.pdf")
            db.update_paper(pid, has_pdf=1, pages=extract_text(pid, p), dl_status="ok", dl_error="")
        return pid
    p = db.insert_paper(title=info.get("title") or "Untitled", authors=info.get("authors", []), year=info.get("year"),
                        venue=info.get("venue", ""), doi=info.get("doi", ""), abstract=info.get("abstract", ""),
                        url=info.get("url", ""), source=f"team: shared by {info.get('shared_by', '?')}",
                        team_key=key, dl_status="ok" if pdf.exists() else "")
    pid = p["id"]
    if pdf.exists():
        shutil.copyfile(pdf, PAPERS_DIR / f"{pid}.pdf")
        db.update_paper(pid, has_pdf=1, pages=extract_text(pid, p))
    else:
        write_metadata_only_text(pid, p)
    db.reindex(pid)
    return pid


# ---------- reading ----------

def list_items() -> list[dict]:
    root = team_dir()
    if not root:
        return []
    local = {r["team_key"]: r["id"] for r in db.q("SELECT id, team_key FROM papers WHERE team_key<>''")}
    me = my_name()
    out = []
    for e in os.scandir(root):
        if not e.is_dir() or e.name.startswith("."):
            continue
        d = Path(e.path)
        info = _info(d)
        if not info or not info.get("key"):
            continue
        pid = local.get(info["key"]) or (db.find_by_doi(info.get("doi", "")) or {}).get("id")
        notes = _notes(d)
        for n in notes:
            n["mine"] = n["by"] == me
            if pid:
                n["text"] = to_local(n["text"], pid)
        out.append({**{k: info.get(k) for k in ("key", "title", "authors", "year", "venue", "doi", "shared_by", "shared_at")},
                    "has_pdf": (d / "paper.pdf").exists(), "notes": notes, "local_id": pid,
                    "linked": info["key"] in local,
                    "updated": max([info.get("shared_at") or 0] + [n["updated"] for n in notes])})
    return sorted(out, key=lambda x: x["updated"], reverse=True)


def others_notes(pid: str) -> list[dict]:
    """Teammates' notes on one of my papers."""
    p = db.get_paper(pid)
    root = team_dir()
    d = root and p and p["team_key"] and _find(root, p["team_key"])
    if not d:
        return []
    me = my_name()
    return [{**n, "text": to_local(n["text"], pid)} for n in _notes(d) if n["by"] != me]


def status() -> dict:
    root = team_dir()
    s = load_settings()["team_dir"].strip()
    if not root:
        return {"enabled": False, "name": my_name(), "detail": f"Folder not found: {s}" if s else ""}
    # Latest activity by someone else, so the sidebar can flag what's new.
    me, latest = my_name(), 0.0
    for e in os.scandir(root):
        if e.is_dir() and not e.name.startswith("."):
            for f in os.scandir(e.path):
                m = NOTE_RE.match(f.name)
                if (m and m.group(1) != me) or (f.name == INFO and (_info(Path(e.path)) or {}).get("shared_by") != me):
                    latest = max(latest, f.stat().st_mtime)
    return {"enabled": True, "name": me, "dir": str(root), "latest": latest}


def pick_folder() -> str:
    """Native macOS folder picker (the browser can't reveal real paths)."""
    r = subprocess.run(["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose the folder your team shares")'],
                       capture_output=True, text=True, timeout=300)
    return r.stdout.strip().rstrip("/") if r.returncode == 0 else ""
