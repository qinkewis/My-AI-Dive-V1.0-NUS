"""Vocabulary notebook: words and phrases saved from the reader, defined by the agent, reviewed as flashcards."""
import asyncio
import csv
import io
import json
import re
import time

from . import db
from .agent import AgentRun
from .config import TEXT_DIR, load_settings

INTERVALS = [0, 1, 3, 7, 16, 35]  # days until the next review, by Leitner box
_tasks: set[asyncio.Task] = set()

DEFINE_PROMPT = """A researcher reading an academic paper saved a term to their vocabulary notebook.
Term: "{term}"
Sentence it appeared in: "{context}"
Paper: "{title}"

Do not use any tools. Reply with ONLY this JSON object and nothing else:
{{"definition": "<what the term means as used here, in plain English, at most 30 words>", "translation": "<the term in {lang}, at most 8 words>"}}"""


def context_for(pid: str, page: int | None, term: str) -> str:
    """The sentence around the term, taken from the paper's extracted text."""
    f = TEXT_DIR / f"{pid}.md"
    if not pid or not f.exists():
        return ""
    text = f.read_text(errors="ignore")
    if page:
        m = re.search(rf"--- Page {page} ---\n(.*?)(?=\n--- Page \d+ ---|\Z)", text, re.S)
        text = m.group(1) if m else text
    flat = " ".join(text.split())

    def sentence(m):
        starts = [flat.rfind(s, 0, m.start()) for s in (". ", "? ", "! ")]
        a = max(starts) + 2 if max(starts) >= 0 else 0
        ends = [i for i in (flat.find(s, m.end()) for s in (". ", "? ", "! ")) if i >= 0]
        z = min(ends) + 1 if ends else len(flat)
        if a < m.start() - 220:  # very long sentence: trim to ~220 chars each side, on word boundaries
            a = flat.find(" ", m.start() - 220) + 1
        if z > m.end() + 220:
            z = flat.rfind(" ", 0, m.end() + 220)
        return a, z

    # The page may use the term several times (title, headings, body); prefer running prose,
    # i.e. the sentence with the most lowercase words.
    spans = [sentence(m) for m in re.finditer(r"\s*".join(map(re.escape, term.split())), flat, re.I)]
    if not spans:
        return ""
    a, z = max(spans, key=lambda s: sum(w[:1].islower() for w in flat[s[0]:s[1]].split()))
    return ("…" if a > 0 and flat[a - 2] not in ".?!" else "") + flat[a:z].strip() + ("…" if flat[z - 1:z] not in ".?!" and z < len(flat) else "")


def add(term: str, pid: str = "", page: int | None = None) -> dict:
    term = " ".join(term.split()).strip(" .,;:()[]\"'“”")[:120]
    if not term:
        raise ValueError("Empty term")
    dup = db.q1("SELECT * FROM vocab WHERE lower(term)=lower(?)", (term,))
    if dup:
        return {**dup, "exists": True}
    vid = db.new_id(4)
    db.ex("INSERT INTO vocab(id,term,context,paper_id,page,status,box,due,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
          (vid, term, context_for(pid, page, term), pid or "", page, "defining", 0, time.time(), time.time()))
    return get(vid)


def get(vid: str) -> dict | None:
    return db.q1("SELECT * FROM vocab WHERE id=?", (vid,))


def define_later(vid: str):
    db.ex("UPDATE vocab SET status='defining' WHERE id=?", (vid,))
    t = asyncio.create_task(_define(vid))
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


async def _define(vid: str):
    v = get(vid)
    if not v:
        return
    s = load_settings()
    p = db.get_paper(v["paper_id"]) if v["paper_id"] else None
    prompt = DEFINE_PROMPT.format(term=v["term"], context=v["context"] or "(none)",
                                  title=p["title"] if p else "(unknown)", lang=s["translate_to"])
    out = ""
    try:
        async for ev in AgentRun().stream(prompt, model=s["vocab_model"], persist=False):
            if ev["t"] == "delta":
                out += ev["text"]
            elif ev["t"] == "done" and ev.get("result"):
                out = ev["result"]
        m = re.search(r"\{.*\}", out, re.S)
        d = json.loads(m.group(0)) if m else {}
        db.ex("UPDATE vocab SET definition=?, translation=?, status='' WHERE id=?",
              (str(d.get("definition", "")).strip(), str(d.get("translation", "")).strip(), vid))
        if not d:
            db.ex("UPDATE vocab SET status='error' WHERE id=?", (vid,))
    except Exception:
        db.ex("UPDATE vocab SET status='error' WHERE id=?", (vid,))


def review(vid: str, ok: bool) -> dict:
    v = get(vid)
    box = min(v["box"] + 1, len(INTERVALS) - 1) if ok else 0
    due = time.time() + INTERVALS[box] * 86400 if ok else time.time()
    db.ex("UPDATE vocab SET box=?, due=? WHERE id=?", (box, due, vid))
    return get(vid)


def to_csv() -> str:
    """Anki-friendly: front, back, context, source."""
    buf = io.StringIO()
    w = csv.writer(buf)
    for v in db.q("SELECT * FROM vocab ORDER BY created_at"):
        p = db.get_paper(v["paper_id"]) if v["paper_id"] else None
        src = f"{p['title']}{', p.' + str(v['page']) if v['page'] else ''}" if p else ""
        back = " — ".join(x for x in (v["translation"], v["definition"]) if x)
        w.writerow([v["term"], back, v["context"], src])
    return buf.getvalue()
