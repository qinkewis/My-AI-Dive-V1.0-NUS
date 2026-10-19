"""Background jobs: batch download (OpenAlex → open access / NUS proxy) and batch summarise."""
import asyncio
import json
import time

from . import db
from .agent import summarize
from .config import PAPERS_DIR, load_settings
from .discovery import search
from .nus import DownloadError, nus
from .pdftools import extract_text, write_metadata_only_text

JOBS: dict[str, dict] = {}
_tasks: set[asyncio.Task] = set()
_cancelled: set[str] = set()
_last_proxy = 0.0


def _save(job: dict):
    job["updated_at"] = time.time()
    db.ex("INSERT OR REPLACE INTO jobs(id,kind,title,status,total,done,failed,log,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
          (job["id"], job["kind"], job["title"], job["status"], job["total"], job["done"], job["failed"],
           json.dumps(job["log"][-400:], ensure_ascii=False), job["created_at"], job["updated_at"]))


def _log(job: dict, msg: str, level: str = "info", paper: str | None = None):
    job["log"].append({"t": time.time(), "msg": msg, "level": level, "paper": paper})
    _save(job)


def new_job(kind: str, title: str, total: int) -> dict:
    job = {"id": db.new_id(4), "kind": kind, "title": title, "status": "running", "total": total,
           "done": 0, "failed": 0, "log": [], "created_at": time.time()}
    JOBS[job["id"]] = job
    _save(job)
    return job


def list_jobs() -> list[dict]:
    rows = db.q("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50")
    out = []
    for r in rows:
        live = JOBS.get(r["id"])
        out.append(live if live else {**r, "log": json.loads(r["log"] or "[]")})
    return out


def cancel(job_id: str):
    _cancelled.add(job_id)


def _spawn(coro):
    t = asyncio.create_task(coro)
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


# ---------- adding papers ----------

def add_from_work(w: dict, folder: str, source: str) -> tuple[dict, bool]:
    """Inserts a discovered work (or returns the existing one with the same DOI). Returns (paper, is_new)."""
    existing = db.find_by_doi(w.get("doi", ""))
    if existing:
        return existing, False
    p = db.insert_paper(title=w["title"], authors=w.get("authors", []), year=w.get("year"), venue=w.get("venue", ""),
                        doi=w.get("doi", ""), abstract=w.get("abstract", ""), url=w.get("url", ""),
                        oa_url=w.get("oa_url", ""), cited_by=w.get("cited_by"), folder=folder, source=source,
                        dl_status="pending")
    write_metadata_only_text(p["id"], p)
    db.reindex(p["id"])
    return p, True


def store_pdf(pid: str, data: bytes):
    (PAPERS_DIR / f"{pid}.pdf").write_bytes(data)
    p = db.get_paper(pid)
    pages = extract_text(pid, p)
    db.update_paper(pid, has_pdf=1, pages=pages, dl_status="ok", dl_error="")


async def download_one(p: dict, use_proxy: bool) -> str:
    """Open access over plain HTTP → open access in the browser → NUS proxy. Returns how it got the PDF."""
    urls = (p.get("oa_url") or "").split()
    if urls:
        data = await nus.fetch_open_access(urls)
        if data:
            store_pdf(p["id"], data)
            return "Open access"
        data = await nus.fetch_in_browser(urls)
        if data:
            store_pdf(p["id"], data)
            return "Open access (browser)"
    if not use_proxy:
        raise DownloadError("Open-access copies were blocked" if urls else "Not open access, and NUS proxy download is off")
    if not p.get("doi") and not p.get("url"):
        raise DownloadError("No DOI to look up")
    global _last_proxy
    if time.time() - _last_proxy < float(load_settings()["delay_max"]):
        await nus.polite_pause()  # space out publisher requests so the proxy doesn't flag the account
    try:
        data = await nus.fetch_via_proxy(p.get("doi", ""), p.get("url", ""))
    finally:
        _last_proxy = time.time()
    store_pdf(p["id"], data)
    return "NUS"


# ---------- job: download ----------

def start_download(items: list[dict], use_proxy: bool, title: str) -> dict:
    """items: [{work: {...} | paper_id: str, folder: str}]"""
    job = new_job("download", title, len(items))
    _spawn(_run_download(job, items, use_proxy))
    return job


async def _run_download(job: dict, items: list[dict], use_proxy: bool):
    try:
        if use_proxy:
            st = await nus.check_login() if nus.ctx else {"logged_in": None}
            if not st.get("logged_in"):
                _log(job, "NUS proxy is not signed in — open-access PDFs will still download; others will fail. "
                          "Use “Connect NUS Library” and re-run failed items.", "warn")
        for it in items:
            if job["id"] in _cancelled:
                job["status"] = "cancelled"
                _log(job, "Cancelled by user", "warn")
                return
            if "work" in it:
                p, is_new = add_from_work(it["work"], it.get("folder", ""), it.get("source", "search"))
                if not is_new and p["has_pdf"]:
                    job["done"] += 1
                    _log(job, f"Already in library: {p['title'][:90]}", "info", p["id"])
                    continue
            else:
                p = db.get_paper(it["paper_id"])
                if not p:
                    continue
            db.update_paper(p["id"], dl_status="downloading")
            try:
                how = await download_one(p, use_proxy)
                job["done"] += 1
                _log(job, f"✓ {how}: {p['title'][:90]}", "ok", p["id"])
            except Exception as e:
                job["failed"] += 1
                msg = str(e) or e.__class__.__name__
                db.update_paper(p["id"], dl_status="failed", dl_error=msg[:300])
                _log(job, f"✗ {p['title'][:90]} — {msg[:200]}", "error", p["id"])
        job["status"] = "done"
        _save(job)
    except Exception as e:
        job["status"] = "error"
        _log(job, f"Job crashed: {e}", "error")


# ---------- job: search topics then download ----------

def start_topic_batch(topics: list[str], per_topic: int, opts: dict, folder_base: str, use_proxy: bool) -> dict:
    job = new_job("search", f"Search & download: {', '.join(topics)[:80]}", 0)
    _spawn(_run_topic_batch(job, topics, per_topic, opts, folder_base, use_proxy))
    return job


async def _run_topic_batch(job, topics, per_topic, opts, folder_base, use_proxy):
    items = []
    for t in topics:
        try:
            works = await search(t, per_topic, **opts)
            folder = f"{folder_base}/{t}".strip("/") if folder_base is not None else ""
            items += [{"work": w, "folder": folder, "source": f"search: {t}"} for w in works]
            _log(job, f"“{t}”: found {len(works)} papers → folder {folder or '(root)'}")
        except Exception as e:
            _log(job, f"Search failed for “{t}”: {e}", "error")
    cap = int(load_settings()["max_per_batch"])
    if len(items) > cap:
        _log(job, f"Capped at {cap} papers per batch (Settings → max per batch)", "warn")
        items = items[:cap]
    job["total"] = len(items)
    _save(job)
    await _run_download(job, items, use_proxy)


# ---------- job: summarise ----------

def start_summarize(ids: list[str]) -> dict:
    job = new_job("summarize", f"Summarise {len(ids)} paper(s)", len(ids))
    _spawn(_run_summarize(job, ids))
    return job


async def _run_summarize(job, ids):
    sem = asyncio.Semaphore(max(1, int(load_settings()["summary_concurrency"])))

    async def one(pid):
        async with sem:
            if job["id"] in _cancelled:
                return
            p = db.get_paper(pid)
            if not p:
                return
            try:
                out = await summarize(pid)
                db.update_paper(pid, summary=out)
                job["done"] += 1
                _log(job, f"✓ {p['title'][:90]}", "ok", pid)
            except Exception as e:
                job["failed"] += 1
                _log(job, f"✗ {p['title'][:90]} — {str(e)[:200]}", "error", pid)

    await asyncio.gather(*(one(i) for i in ids))
    job["status"] = "cancelled" if job["id"] in _cancelled else "done"
    _save(job)
