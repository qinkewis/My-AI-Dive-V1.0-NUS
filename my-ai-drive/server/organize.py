"""Batch import from a folder on disk, and AI organisation of papers into folders and tags.

Organising takes two passes so it scales to hundreds of papers:
1. taxonomy: the agent sees every paper briefly and designs one folder tree, reusing existing folders;
2. assignment: papers go to the agent in chunks with their abstracts; each gets a folder and tags.
The result is a plan that the user reviews and applies. Applying records each paper's previous folder
and tags, so the whole plan can be undone.
"""
import asyncio
import json
import os
import re
import time
from collections import Counter
from pathlib import Path

from . import db, jobs
from .agent import AgentRun
from .config import TEXT_DIR, load_settings
from .importer import import_pdf
from .pdftools import is_pdf

CHUNK = 40  # papers per assignment call
STUDY_TYPES = ["review", "primary research", "methods/protocol", "clinical study", "meta-analysis",
               "commentary", "dataset/resource"]
FALLBACK = "Unsorted"

TAXONOMY_PROMPT = """You are organising a researcher's personal library of academic papers. Design the folder
structure an expert in these fields would use for their own reading library, so that the researcher can
later find "the papers on X" by browsing folders.

PAPERS ({n})
{papers}

EXISTING FOLDERS (reuse a folder, spelled exactly, whenever it fits; this keeps batches consistent)
{folders}

RULES
- Organise by research field and topic: what the paper is about. Do not organise by year, venue, method or study type (those become tags).
- At most two levels: "Field" or "Field/Subtopic". Create a subfolder only when it will hold at least 3 of these papers; otherwise keep papers in the field folder.
- Top level: between 2 and 12 folders, scaled to the number of papers. Aim for 4-25 papers per folder. Never one folder per paper.
- Folder names: 1-4 words, specific and recognisable to a specialist (for example "Erythropoiesis", "Enucleation", "Gene Editing/Base Editing"), Title Case, no numbering, no dates, no "/" inside a name. Avoid vague names such as "Miscellaneous", "General", "Other Papers"; if a few papers truly fit nowhere, use "Other <Field>".
- Every paper listed must fit somewhere in the structure.

Do not use any tools. Reply with ONLY this JSON object:
{{"folders": [{{"path": "Field/Subtopic", "about": "one line: what belongs here"}}]}}"""

ASSIGN_PROMPT = """Sort these papers into a researcher's library: give each exactly one folder and 3-6 tags.

FOLDERS (use the path exactly as written)
{folders}

TAGS
Tags capture what the folder does not, so a paper can be found again by method or system:
1. exactly one study type, from: {types}
2. 1-3 key methods or techniques (for example "CRISPR screen", "single-cell RNA-seq", "flow cytometry", "mass spectrometry")
3. 1-2 model systems or organisms when relevant (for example "human iPSC", "mouse", "HUDEP-2", "zebrafish")
Write tags in lowercase except proper nouns and acronyms. Keep them short (1-3 words) and general enough to be shared by several papers.
Never restate the study type or the folder name in another tag (no "literature review" next to "review"). For reviews and commentaries, tag the main techniques or systems they discuss.
EXISTING TAGS (reuse these exact spellings when they mean the same thing): {tags}

RULES
- Pick the most specific folder that fits the paper's main topic. Use "{fallback}" only if nothing fits.
- Judge from the title, abstract and keywords; do not guess beyond them.
- Every paper id below must appear exactly once in your answer.

PAPERS
{papers}

Do not use any tools. Reply with ONLY this JSON object:
{{"assignments": [{{"id": "<paper id>", "folder": "<folder path>", "tags": ["...", "..."]}}]}}"""


# ---------- batch import from a folder ----------

def start_folder_import(path: str, folder: str, organize: bool, base: str) -> dict:
    root = Path(os.path.expanduser(path.strip()))
    if not root.is_dir():
        raise ValueError(f"Not a folder: {path}")
    try:
        files = sorted(f for f in root.rglob("*") if f.suffix.lower() == ".pdf" and f.is_file()
                       and not any(part.startswith(".") for part in f.relative_to(root).parts))
    except PermissionError:
        raise ValueError(f"macOS blocked access to {root}. Allow it in System Settings → Privacy & Security → Files and Folders.")
    if not files:
        raise ValueError(f"No PDFs found in {root}")
    job = jobs.new_job("import", f"Import {len(files)} PDF(s) from “{root.name}”", len(files))
    jobs._spawn(_run_import(job, files, folder, organize, base))
    return job


async def _run_import(job: dict, files: list[Path], folder: str, organize: bool, base: str):
    sem = asyncio.Semaphore(4)
    new_ids: list[str] = []

    async def one(f: Path):
        async with sem:
            if job["id"] in jobs._cancelled:
                return
            try:
                data = await asyncio.to_thread(f.read_bytes)
                if not await asyncio.to_thread(is_pdf, data):
                    raise ValueError("not a readable PDF")
                p = await import_pdf(data, f.name, folder)
                job["done"] += 1
                if p.get("duplicate"):
                    jobs._log(job, f"Already in library: {p['title'][:90]}", "info", p["id"])
                else:
                    new_ids.append(p["id"])
                    jobs._log(job, f"✓ {p['title'][:90]}", "ok", p["id"])
            except Exception as e:
                job["failed"] += 1
                jobs._log(job, f"✗ {f.name} — {str(e)[:200]}", "error")

    try:
        await asyncio.gather(*(one(f) for f in files))
        job["status"] = "cancelled" if job["id"] in jobs._cancelled else "done"
        jobs._save(job)
        if organize and new_ids and job["status"] == "done":
            start_organize(new_ids, base, f"Organise {len(new_ids)} imported paper(s)")
            jobs._log(job, "Organising the new papers with AI: see the next job", "info")
    except Exception as e:
        job["status"] = "error"
        jobs._log(job, f"Job crashed: {e}", "error")


# ---------- organise ----------

def start_organize(ids: list[str], base: str = "", title: str | None = None) -> dict:
    ids = [i for i in dict.fromkeys(ids) if db.get_paper(i)]
    if not ids:
        raise ValueError("No papers to organise")
    base = _clean_path(base)
    job = jobs.new_job("organize", title or f"Organise {len(ids)} paper(s)", 1 + -(-len(ids) // CHUNK))
    jobs._spawn(_run_organize(job, ids, base))
    return job


async def _run_organize(job: dict, ids: list[str], base: str):
    try:
        papers = [db.get_paper(i) for i in ids]
        tags = _existing_tags()
        jobs._log(job, f"Designing a folder structure for {len(papers)} paper(s)…")
        folders = await _taxonomy(papers, base)
        job["done"] += 1
        jobs._log(job, f"Folder structure: {len(folders)} folder(s)", "ok")

        sem = asyncio.Semaphore(max(1, int(load_settings()["summary_concurrency"])))
        assigned: dict[str, dict] = {}

        async def chunk(c: list[dict]):
            async with sem:
                if job["id"] in jobs._cancelled:
                    return
                try:
                    got = await _assign(c, folders, tags)
                    missing = [p for p in c if p["id"] not in got]
                    if missing:  # the agent skipped some: one more try for just those
                        got.update(await _assign(missing, folders, tags))
                    assigned.update(got)
                    job["done"] += 1
                    jobs._log(job, f"Sorted {len(got)} of {len(c)} paper(s)", "ok")
                except Exception as e:
                    job["failed"] += 1
                    jobs._log(job, f"✗ A group of {len(c)} paper(s) could not be sorted — {str(e)[:200]}", "error")

        await asyncio.gather(*(chunk(papers[i:i + CHUNK]) for i in range(0, len(papers), CHUNK)))
        if job["id"] in jobs._cancelled:
            job["status"] = "cancelled"
            jobs._save(job)
            return
        prefix = (base + "/") if base else ""
        items = [{"id": p["id"], "title": p["title"], "folder": prefix + a["folder"], "tags": a["tags"]}
                 for p in papers if (a := assigned.get(p["id"]))]
        used = Counter(it["folder"] for it in items)
        plan = {"base": base, "items": items,
                "folders": [{"path": prefix + f, "about": about} for f, about in folders.items() if used[prefix + f]]
                + ([{"path": prefix + FALLBACK, "about": "Papers that fit no other folder"}] if used[prefix + FALLBACK] else [])}
        db.ex("INSERT OR REPLACE INTO plans(id,status,data,created_at) VALUES (?,?,?,?)",
              (job["id"], "ready", json.dumps(plan, ensure_ascii=False), time.time()))
        job["status"] = "done"
        jobs._log(job, f"Plan ready: {len(items)} paper(s) into {len(plan['folders'])} folder(s). Review it to apply.", "ok")
    except Exception as e:
        job["status"] = "error"
        jobs._log(job, f"Organising failed: {str(e)[:300]}", "error")


async def _taxonomy(papers: list[dict], base: str) -> dict[str, str]:
    brief = len(papers) > 400  # very large batches: titles only, to keep the prompt manageable
    lines = []
    for p in papers:
        line = f"- {p['title']} ({p['venue'] or '?'}, {p['year'] or 'n.d.'})"
        if not brief and (p["abstract"] or "").strip():
            line += " — " + " ".join(p["abstract"].split())[:220]
        lines.append(line)
    prefix = (base + "/") if base else ""
    existing = [f["path"][len(prefix):] for f in db.list_folders() if f["path"].startswith(prefix) and f["path"] != base]
    out = await _ask_json(TAXONOMY_PROMPT.format(n=len(papers), papers="\n".join(lines),
                                                 folders="\n".join(f"- {f}" for f in existing) or "(none)"))
    folders = {}
    for f in out.get("folders", []):
        path = "/".join(_clean_path(f.get("path", "")).split("/")[:2])
        if path:
            folders[path] = str(f.get("about", "")).strip()
    if not folders:
        raise RuntimeError("The agent proposed no folders")
    return folders


async def _assign(papers: list[dict], folders: dict[str, str], tags: list[str]) -> dict[str, dict]:
    listing = "\n".join(f"- {f} — {about}" if about else f"- {f}" for f, about in folders.items())
    out = await _ask_json(ASSIGN_PROMPT.format(
        folders=listing + f"\n- {FALLBACK} — fits no other folder", types=", ".join(f'"{t}"' for t in STUDY_TYPES),
        tags=", ".join(tags) or "(none yet)", fallback=FALLBACK, papers="\n\n".join(_digest(p) for p in papers)))
    by_lower = {f.lower(): f for f in folders}
    tag_spelling = {t.lower(): t for t in tags}
    ids = {p["id"] for p in papers}
    got = {}
    for a in out.get("assignments", []):
        pid = str(a.get("id", "")).strip()
        if pid not in ids:
            continue
        f = _clean_path(str(a.get("folder", "")))
        f = by_lower.get(f.lower()) or by_lower.get(f.split("/")[0].lower()) or FALLBACK
        clean = []
        for t in a.get("tags", []):
            t = " ".join(str(t).split()).strip(" #,.")[:40]
            t = tag_spelling.get(t.lower(), t)
            if t and t.lower() not in {x.lower() for x in clean}:
                clean.append(t)
        got[pid] = {"folder": f, "tags": clean[:6]}
    return got


def _digest(p: dict) -> str:
    text = (p["abstract"] or "").strip() or _body_start(p["id"])
    lines = [f"### {p['id']}", f"title: {p['title']}", f"venue: {p['venue'] or '?'} ({p['year'] or 'n.d.'})"]
    kw = re.search(r"\*\*Keywords\*\*\s*[—–-]+\s*(.+)", p.get("summary") or "")
    if kw:
        lines.append("keywords: " + kw.group(1).strip()[:200])
    lines.append("abstract: " + (" ".join(text.split())[:1000] or "(none)"))
    return "\n".join(lines)


def _body_start(pid: str) -> str:
    """No abstract: the opening of the full text usually contains one."""
    f = TEXT_DIR / f"{pid}.md"
    if not f.exists():
        return ""
    t = f.read_text(errors="ignore")
    i = t.find("--- Page 1 ---")
    return t[i + 14:i + 1600] if i >= 0 else ""


def _existing_tags() -> list[str]:
    c = Counter(t for r in db.q("SELECT tags FROM papers") for t in json.loads(r["tags"] or "[]"))
    return [t for t, _ in c.most_common(150)]


def _clean_path(p: str) -> str:
    return "/".join(" ".join(s.split()) for s in str(p).replace("\\", "/").split("/") if s.strip())


async def _ask_json(prompt: str) -> dict:
    model = load_settings()["summary_model"]
    err = ""
    for _ in range(2):  # one retry: a reply occasionally comes back truncated or wrapped in prose
        out = ""
        async for ev in AgentRun().stream(prompt, model=model, persist=False):
            if ev["t"] == "delta":
                out += ev["text"]
            elif ev["t"] == "done" and ev.get("result"):
                out = ev["result"]
            elif ev["t"] == "error":
                err = ev["text"]
        m = re.search(r"\{.*\}", out, re.S)
        try:
            return json.loads(m.group(0))
        except (AttributeError, json.JSONDecodeError):
            err = err or "The agent's reply was not valid JSON"
    raise RuntimeError(err)


# ---------- plans ----------

def get_plan(plan_id: str) -> dict | None:
    row = db.q1("SELECT * FROM plans WHERE id=?", (plan_id,))
    return row and {**json.loads(row["data"]), "id": row["id"], "status": row["status"], "created_at": row["created_at"]}


def _save_plan(plan: dict, status: str):
    data = {k: v for k, v in plan.items() if k not in ("id", "status", "created_at")}
    db.ex("UPDATE plans SET status=?, data=? WHERE id=?", (status, json.dumps(data, ensure_ascii=False), plan["id"]))


def apply_plan(plan_id: str, renames: dict[str, str] | None = None) -> dict:
    """renames: {old folder path: new path} edits the user made while reviewing."""
    plan = get_plan(plan_id)
    if not plan or plan["status"] != "ready":
        raise ValueError("This plan was already applied or discarded")
    renames = {k: _clean_path(v) for k, v in (renames or {}).items() if _clean_path(v)}
    before = {f["path"] for f in db.list_folders()}
    for it in plan["items"]:
        p = db.get_paper(it["id"])
        if not p:
            continue
        it["folder"] = renames.get(it["folder"], it["folder"])
        it["old_folder"], it["old_tags"] = p["folder"], p["tags"]
        have = {t.lower() for t in p["tags"]}
        db.update_paper(it["id"], folder=it["folder"], tags=p["tags"] + [t for t in it["tags"] if t.lower() not in have])
    for f in plan["folders"]:
        f["path"] = renames.get(f["path"], f["path"])
    plan["created"] = sorted({it["folder"] for it in plan["items"]} - before)
    _save_plan(plan, "applied")
    return plan


def undo_plan(plan_id: str) -> dict:
    plan = get_plan(plan_id)
    if not plan or plan["status"] != "applied":
        raise ValueError("Only an applied plan can be undone")
    for it in plan["items"]:
        if "old_folder" in it and db.get_paper(it["id"]):
            db.update_paper(it["id"], folder=it["old_folder"], tags=it["old_tags"])
    for f in plan.get("created", []):
        if not db.q1("SELECT 1 FROM papers WHERE folder=? OR folder LIKE ? LIMIT 1", (f, f + "/%")):
            db.ex("DELETE FROM folders WHERE path=?", (f,))
    _save_plan(plan, "undone")
    return plan


def discard_plan(plan_id: str):
    db.ex("UPDATE plans SET status='discarded' WHERE id=? AND status='ready'", (plan_id,))
