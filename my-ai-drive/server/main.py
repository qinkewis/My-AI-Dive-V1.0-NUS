"""My AI Drive — local web server. Run with ./run.sh, then open http://127.0.0.1:8765"""
import asyncio
import json
import os
import signal
import time
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import db, jobs, organize, team, vocab
from .agent import AgentRun, agent_available, build_prompt, scope_label, write_manifest
from .config import NOTES_DIR, PAPERS_DIR, STATIC, TEXT_DIR, load_settings, save_settings
from .discovery import lookup_doi, search
from .importer import import_pdf
from .nus import nus
from .pdftools import clean_doi, extract_text, is_pdf, write_metadata_only_text


@asynccontextmanager
async def lifespan(app):
    yield
    await nus.close()


app = FastAPI(title="My AI Drive", lifespan=lifespan)
RUNS: dict[str, AgentRun] = {}


def need(p):
    if not p:
        raise HTTPException(404, "Not found")
    return p


# ---------- app state ----------

@app.get("/api/state")
async def state():
    ok, detail = agent_available()
    counts = db.q1("SELECT count(*) total, sum(starred) starred, sum(read_status='unread') unread, sum(has_pdf=0) nopdf FROM papers")
    return {"folders": db.list_folders(), "counts": counts, "agent": {"ok": ok, "detail": detail},
            "nus": {**nus.last_check, "browser_open": nus.ctx is not None},
            "team": await asyncio.to_thread(_team_status),
            "vocab": db.q1("SELECT count(*) total, coalesce(sum(due<=?),0) due FROM vocab", (time.time(),)),
            "running_jobs": sum(1 for j in jobs.JOBS.values() if j["status"] == "running")}


def _team_status() -> dict:
    try:
        return team.status()
    except OSError as e:
        return {"enabled": False, "name": team.my_name(), "detail": str(e)}


MASK = "••••••"


def _public(s: dict) -> dict:
    """Settings for the browser: the API key is never sent back, only its last 4 characters."""
    k = s.get("api_key", "")
    return {**s, "api_key": (MASK + k[-4:]) if k else ""}


@app.get("/api/settings")
async def get_settings():
    return _public(load_settings())


@app.put("/api/settings")
async def put_settings(patch: dict = Body(...)):
    if str(patch.get("api_key", "")).startswith(MASK):
        patch.pop("api_key")  # unchanged
    return _public(save_settings(patch))


@app.post("/api/agent/test")
async def test_agent():
    """Sends a one-line request through the configured provider."""
    ok, detail = agent_available()
    if not ok:
        raise HTTPException(400, detail)
    t0, text, err = time.time(), "", ""
    async for ev in AgentRun().stream("Reply with exactly: OK", persist=False):
        if ev["t"] == "delta":
            text += ev["text"]
        elif ev["t"] == "done" and ev.get("result"):
            text = ev["result"]
        elif ev["t"] == "error":
            err = ev["text"]
    if err or not text.strip():
        raise HTTPException(400, err or "The provider returned nothing")
    return {"ok": True, "detail": detail, "reply": text.strip()[:200], "seconds": round(time.time() - t0, 1)}


# ---------- papers ----------

@app.get("/api/papers")
async def papers(view: str = "all", folder: str | None = None, q: str = "", sort: str = "added"):
    rows = db.list_papers(view, folder, q, "relevance" if q and sort == "added" else sort)
    snips = {s["id"]: s["snip"] for s in db.search_snippets(q, 200)} if q.strip() else {}
    for r in rows:
        if r["id"] in snips:
            r["snippet"] = snips[r["id"]]
    return rows


@app.get("/api/papers/{pid}")
async def paper(pid: str):
    return need(db.get_paper(pid))


@app.patch("/api/papers/{pid}")
async def patch_paper(pid: str, patch: dict = Body(...)):
    need(db.get_paper(pid))
    if "doi" in patch:
        patch["doi"] = clean_doi(patch["doi"])
    p = db.update_paper(pid, **patch)
    if patch.keys() & {"title", "authors", "year", "venue", "doi"} and p["has_pdf"]:
        await asyncio.to_thread(extract_text, pid, p)  # refresh the metadata header the agent sees
    if "notes" in patch and p["team_key"]:
        try:
            await asyncio.to_thread(team.sync_notes, pid)
        except OSError:
            pass  # team folder offline; the next save syncs
    return p


@app.delete("/api/papers/{pid}")
async def delete_paper(pid: str):
    _delete(pid)
    return {"ok": True}


def _delete(pid: str):
    db.delete_paper(pid)
    for f in (PAPERS_DIR / f"{pid}.pdf", TEXT_DIR / f"{pid}.md"):
        f.unlink(missing_ok=True)


@app.post("/api/papers/bulk")
async def bulk(body: dict = Body(...)):
    ids, action, value = body.get("ids", []), body.get("action"), body.get("value")
    for pid in ids:
        p = db.get_paper(pid)
        if not p:
            continue
        if action == "move":
            db.update_paper(pid, folder=value or "")
        elif action == "delete":
            _delete(pid)
        elif action == "star":
            db.update_paper(pid, starred=1 if value else 0)
        elif action == "status":
            db.update_paper(pid, read_status=value)
        elif action == "tag":
            db.update_paper(pid, tags=sorted(set(p["tags"]) | {value}))
        elif action == "untag":
            db.update_paper(pid, tags=[t for t in p["tags"] if t != value])
    return {"ok": True}


@app.get("/api/papers/{pid}/pdf")
async def paper_pdf(pid: str):
    f = PAPERS_DIR / f"{pid}.pdf"
    if not f.exists():
        raise HTTPException(404, "No PDF")
    return FileResponse(f, media_type="application/pdf")


@app.post("/api/upload")
async def upload(files: list[UploadFile] = File(...), folder: str = Form("")):
    out = []
    for f in files:
        data = await f.read()
        if not is_pdf(data):
            out.append({"error": f"{f.filename}: not a PDF"})
            continue
        try:
            out.append(await import_pdf(data, f.filename or "paper.pdf", folder))
        except Exception as e:
            out.append({"error": f"{f.filename}: {e}"})
    return out


@app.post("/api/papers/{pid}/attach")
async def attach_pdf(pid: str, file: UploadFile = File(...)):
    p = need(db.get_paper(pid))
    data = await file.read()
    if not is_pdf(data):
        raise HTTPException(400, "Not a PDF")
    (PAPERS_DIR / f"{pid}.pdf").write_bytes(data)
    pages = await asyncio.to_thread(extract_text, pid, p)
    return db.update_paper(pid, has_pdf=1, pages=pages, dl_status="ok", dl_error="")


@app.post("/api/papers/add_doi")
async def add_doi(body: dict = Body(...)):
    """Adds papers by DOI list (one per line) and downloads them."""
    dois = [clean_doi(d) for d in str(body.get("dois", "")).replace(",", "\n").splitlines() if d.strip()]
    items = []
    for d in dois:
        w = await lookup_doi(d) or {"title": d, "doi": d, "authors": []}
        items.append({"work": w, "folder": body.get("folder", ""), "source": "doi"})
    if not items:
        raise HTTPException(400, "No DOIs")
    return jobs.start_download(items, bool(body.get("use_proxy", True)), f"Add {len(items)} DOI(s)")


@app.post("/api/import_folder")
async def import_folder(body: dict = Body(...)):
    """Imports every PDF under a folder on this Mac (recursively) as a background job."""
    try:
        return organize.start_folder_import(body.get("path", ""), body.get("folder", ""),
                                            bool(body.get("organize", True)), body.get("base", ""))
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---------- organising ----------

@app.post("/api/organize")
async def organize_route(body: dict = Body(...)):
    try:
        return organize.start_organize(body.get("ids", []), body.get("base", ""))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/plans/{plan_id}")
async def get_plan(plan_id: str):
    return need(organize.get_plan(plan_id))


@app.post("/api/plans/{plan_id}/{action}")
async def plan_action(plan_id: str, action: str, body: dict = Body(default={})):
    try:
        if action == "apply":
            return organize.apply_plan(plan_id, body.get("renames"))
        if action == "undo":
            return organize.undo_plan(plan_id)
        if action == "discard":
            organize.discard_plan(plan_id)
            return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))
    raise HTTPException(404, "Unknown action")


# ---------- folders ----------

@app.post("/api/folders")
async def new_folder(body: dict = Body(...)):
    path = "/".join(s.strip() for s in str(body.get("path", "")).split("/") if s.strip())
    if not path:
        raise HTTPException(400, "Empty name")
    db.ex("INSERT OR IGNORE INTO folders(path) VALUES (?)", (path,))
    return {"path": path}


@app.patch("/api/folders")
async def rename_folder(body: dict = Body(...)):
    db.rename_folder(body["old"], "/".join(s.strip() for s in body["new"].split("/") if s.strip()))
    return {"ok": True}


@app.delete("/api/folders")
async def delete_folder(path: str):
    db.delete_folder(path)
    return {"ok": True}


# ---------- discovery & downloads ----------

@app.post("/api/discover")
async def discover(body: dict = Body(...)):
    topics = [t.strip() for t in body.get("topics", []) if t.strip()]
    opts = _search_opts(body)
    per = int(body.get("per_topic", 20))

    async def one(t):
        try:
            works = await search(t, per, **opts)
        except Exception as e:
            return {"topic": t, "error": str(e), "works": []}
        for w in works:
            hit = db.find_by_doi(w["doi"])
            w["in_library"] = bool(hit and hit["has_pdf"])
        return {"topic": t, "works": works}

    return await asyncio.gather(*(one(t) for t in topics))


def _search_opts(body: dict) -> dict:
    return {"year_from": int(body["year_from"]) if body.get("year_from") else None,
            "year_to": int(body["year_to"]) if body.get("year_to") else None,
            "sort": body.get("sort", "relevance"), "oa_only": bool(body.get("oa_only")),
            "types": body.get("types", "article|review")}


@app.post("/api/download")
async def download(body: dict = Body(...)):
    items = body.get("items", [])
    if not items:
        raise HTTPException(400, "Nothing selected")
    return jobs.start_download(items, bool(body.get("use_proxy", True)), f"Download {len(items)} paper(s)")


@app.post("/api/batch")
async def batch(body: dict = Body(...)):
    topics = [t.strip() for t in body.get("topics", []) if t.strip()]
    if not topics:
        raise HTTPException(400, "No topics")
    base = body.get("folder_base", "Searches") if body.get("folder_per_topic", True) else None
    return jobs.start_topic_batch(topics, int(body.get("per_topic", 10)), _search_opts(body), base,
                                  bool(body.get("use_proxy", True)))


@app.post("/api/retry")
async def retry(body: dict = Body(...)):
    ids = [i for i in body.get("ids", []) if (p := db.get_paper(i)) and not p["has_pdf"]]
    if not ids:
        raise HTTPException(400, "No selected papers are missing a PDF")
    return jobs.start_download([{"paper_id": i} for i in ids], bool(body.get("use_proxy", True)),
                               f"Retry {len(ids)} download(s)")


@app.post("/api/summarize")
async def summarize_route(body: dict = Body(...)):
    ids = body.get("ids", [])
    if body.get("only_missing", True):
        ids = [i for i in ids if (p := db.get_paper(i)) and not p["summary"]]
    if not ids:
        raise HTTPException(400, "All selected papers already have summaries")
    return jobs.start_summarize(ids)


@app.get("/api/jobs")
async def get_jobs():
    return jobs.list_jobs()


@app.post("/api/jobs/{jid}/cancel")
async def cancel_job(jid: str):
    jobs.cancel(jid)
    return {"ok": True}


# ---------- NUS ----------

@app.post("/api/nus/connect")
async def nus_connect():
    try:
        await nus.open_login()
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"ok": True}


@app.get("/api/nus/status")
async def nus_status():
    return {**(await nus.check_login()), "browser_open": nus.ctx is not None}


@app.post("/api/nus/close")
async def nus_close():
    await nus.close()
    return {"ok": True}


# ---------- chats with the agent ----------

@app.get("/api/chats")
async def chats():
    return db.q("SELECT id,title,scope,updated_at FROM chats ORDER BY updated_at DESC LIMIT 200")


@app.post("/api/chats")
async def new_chat(body: dict = Body(...)):
    scope = body.get("scope") or {"type": "all"}
    cid = db.new_id(4)
    now = time.time()
    db.ex("INSERT INTO chats(id,title,scope,session_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
          (cid, body.get("title") or scope_label(scope), json.dumps(scope), None, now, now))
    return {"id": cid, "title": scope_label(scope), "scope": scope, "messages": []}


@app.get("/api/chats/{cid}")
async def get_chat(cid: str):
    c = need(db.q1("SELECT * FROM chats WHERE id=?", (cid,)))
    c["scope"] = json.loads(c["scope"])
    c["messages"] = db.q("SELECT role,content,meta FROM messages WHERE chat_id=? ORDER BY id", (cid,))
    return c


@app.delete("/api/chats/{cid}")
async def delete_chat(cid: str):
    db.ex("DELETE FROM chats WHERE id=?", (cid,))
    db.ex("DELETE FROM messages WHERE chat_id=?", (cid,))
    return {"ok": True}


@app.post("/api/chats/{cid}/stop")
async def stop_chat(cid: str):
    if cid in RUNS:
        RUNS[cid].cancel()
    return {"ok": True}


@app.post("/api/chats/{cid}/send")
async def send(cid: str, body: dict = Body(...)):
    c = need(db.q1("SELECT * FROM chats WHERE id=?", (cid,)))
    scope = json.loads(c["scope"])
    message = body.get("message", "").strip()
    if not message:
        raise HTTPException(400, "Empty message")
    if cid in RUNS:
        raise HTTPException(409, "The agent is still answering in this chat")
    manifest, papers = write_manifest(cid, scope)
    for p in papers:  # make sure every paper has a text file, even abstract-only ones
        if not (TEXT_DIR / f"{p['id']}.md").exists():
            write_metadata_only_text(p["id"], p)
    api = load_settings()["agent_provider"] != "claude"
    # API providers keep no session on their side, so they get the earlier turns and the scope hint every time.
    history = [{"role": m["role"], "content": m["content"]} for m in
               db.q("SELECT role, content FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 20", (cid,))][::-1] if api else None
    prompt = build_prompt(manifest, papers, message, first_turn=api or not c["session_id"])
    db.ex("INSERT INTO messages(chat_id,role,content,meta,created_at) VALUES (?,?,?,?,?)",
          (cid, "user", message, None, time.time()))
    run = AgentRun()
    RUNS[cid] = run

    async def gen():
        text, tools, session, cost = "", [], c["session_id"], None
        try:
            async for ev in run.stream(prompt, load_settings()["chat_model"], resume=None if api else c["session_id"], history=history):
                if ev["t"] == "delta":
                    text += ev["text"]
                elif ev["t"] == "reset":
                    text = ""
                elif ev["t"] == "tool":
                    tools.append(ev)
                elif ev["t"] == "session":
                    session = ev["id"] or session
                elif ev["t"] == "done":
                    session, cost = ev.get("session") or session, ev.get("cost")
                    if not text.strip() and ev.get("result"):
                        text = ev["result"]
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        finally:
            RUNS.pop(cid, None)
            if text.strip():
                db.ex("INSERT INTO messages(chat_id,role,content,meta,created_at) VALUES (?,?,?,?,?)",
                      (cid, "assistant", text, json.dumps({"tools": tools[-60:], "cost": cost}), time.time()))
            db.ex("UPDATE chats SET session_id=?, updated_at=? WHERE id=?", (session, time.time(), cid))

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


# ---------- notes ----------

@app.get("/api/notes")
async def notes():
    return db.q("SELECT id,title,scope,created_at,updated_at,substr(content,1,240) AS preview FROM notes ORDER BY updated_at DESC")


@app.get("/api/notes/{nid}")
async def note(nid: str):
    return need(db.q1("SELECT * FROM notes WHERE id=?", (nid,)))


@app.post("/api/notes")
async def new_note(body: dict = Body(...)):
    nid, now = db.new_id(4), time.time()
    db.ex("INSERT INTO notes(id,title,content,scope,created_at,updated_at) VALUES (?,?,?,?,?,?)",
          (nid, body.get("title") or "Untitled note", body.get("content", ""), body.get("scope", ""), now, now))
    _write_note_file(nid)
    return {"id": nid}


@app.patch("/api/notes/{nid}")
async def patch_note(nid: str, body: dict = Body(...)):
    need(db.q1("SELECT id FROM notes WHERE id=?", (nid,)))
    for k in ("title", "content"):
        if k in body:
            db.ex(f"UPDATE notes SET {k}=?, updated_at=? WHERE id=?", (body[k], time.time(), nid))
    _write_note_file(nid)
    return {"ok": True}


@app.delete("/api/notes/{nid}")
async def delete_note(nid: str):
    db.ex("DELETE FROM notes WHERE id=?", (nid,))
    (NOTES_DIR / f"{nid}.md").unlink(missing_ok=True)
    return {"ok": True}


def _write_note_file(nid: str):
    n = db.q1("SELECT * FROM notes WHERE id=?", (nid,))
    if n:
        (NOTES_DIR / f"{nid}.md").write_text(f"# {n['title']}\nnote_id: {nid}\n\n{n['content']}")


# ---------- team sharing ----------

def _team_call(fn, *args):
    try:
        return fn(*args)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@app.get("/api/team")
async def team_items():
    return await asyncio.to_thread(_team_call, team.list_items)


@app.post("/api/team/share")
async def team_share(body: dict = Body(...)):
    for pid in body.get("ids", []):
        need(db.get_paper(pid))
        await asyncio.to_thread(_team_call, team.share, pid)
    return {"ok": True}


@app.post("/api/team/unshare")
async def team_unshare(body: dict = Body(...)):
    need(db.get_paper(body.get("id", "")))
    await asyncio.to_thread(_team_call, team.unshare, body["id"])
    return {"ok": True}


@app.post("/api/team/add")
async def team_add(body: dict = Body(...)):
    return {"id": await asyncio.to_thread(_team_call, team.add_to_library, body.get("key", ""))}


@app.get("/api/papers/{pid}/team_notes")
async def team_notes(pid: str):
    try:
        return await asyncio.to_thread(team.others_notes, pid)
    except OSError:
        return []


@app.post("/api/pick_folder")
async def pick_folder():
    return {"path": await asyncio.to_thread(team.pick_folder)}


# ---------- vocabulary ----------

@app.get("/api/vocab")
async def vocab_list():
    return db.q("SELECT * FROM vocab ORDER BY created_at DESC")


@app.post("/api/vocab")
async def vocab_add(body: dict = Body(...)):
    try:
        v = await asyncio.to_thread(vocab.add, body.get("term", ""), body.get("paper_id", ""), body.get("page"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not v.get("exists"):
        vocab.define_later(v["id"])
    return v


@app.patch("/api/vocab/{vid}")
async def vocab_patch(vid: str, body: dict = Body(...)):
    need(vocab.get(vid))
    for k in ("term", "definition", "translation"):
        if k in body:
            db.ex(f"UPDATE vocab SET {k}=? WHERE id=?", (str(body[k]).strip(), vid))
    return vocab.get(vid)


@app.post("/api/vocab/{vid}/define")
async def vocab_define(vid: str):
    need(vocab.get(vid))
    vocab.define_later(vid)
    return vocab.get(vid)


@app.post("/api/vocab/{vid}/review")
async def vocab_review(vid: str, body: dict = Body(...)):
    need(vocab.get(vid))
    return vocab.review(vid, bool(body.get("ok")))


@app.delete("/api/vocab/{vid}")
async def vocab_delete(vid: str):
    db.ex("DELETE FROM vocab WHERE id=?", (vid,))
    return {"ok": True}


@app.get("/api/vocab.csv")
async def vocab_csv():
    return PlainTextResponse(vocab.to_csv(), media_type="text/csv",
                             headers={"Content-Disposition": 'attachment; filename="vocabulary.csv"'})


# ---------- app ----------

@app.post("/api/quit")
async def quit_app():
    asyncio.get_running_loop().call_later(0.3, os.kill, os.getpid(), signal.SIGTERM)
    return {"ok": True}


# ---------- frontend ----------

app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
async def index():
    html = (STATIC / "index.html").read_text()
    for f in ("app.js", "styles.css"):  # cache-bust so edits show up on reload
        html = html.replace(f"/static/{f}", f"/static/{f}?v={int((STATIC / f).stat().st_mtime)}")
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})
