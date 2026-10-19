"""Runs your Claude Code agent headless, read-only, inside the library's data folder.

The agent gets Read/Grep/Glob only. Each paper is a text file at text/<id>.md with
"--- Page N ---" markers, so it can read whole papers or grep across hundreds of them.
"""
import asyncio
import json
import os
import shutil
from typing import AsyncIterator

from . import db
from .config import DATA, SCOPES_DIR, TEXT_DIR, load_settings
from .llm import ApiAgentRun, configured
from .team import others_notes

SYSTEM = """You are the research assistant built into "My AI Drive", the user's personal literature library.

Library layout (your working directory):
- text/<paper_id>.md — full text of each paper: a metadata header, then "--- Page N ---" markers.
- notes/<note_id>.md — the user's saved notes and earlier AI syntheses.
- scopes/<chat_id>.md — the manifest of papers the user put in scope for this conversation. Read it first.

How to work:
- Ground every claim in the papers. Read the relevant text before answering; for many papers, use the
  manifest and summaries to triage, then Grep text/ for key terms and Read the passages that matter.
- Cite as [@paper_id p.N] right after the claim (N = page from the nearest "--- Page N ---" marker above
  the passage). Use the exact paper_id. Several sources: [@id1 p.3][@id2 p.7]. The app turns these into
  links that open the PDF at that page, so be precise.
- If the papers don't answer the question, say so plainly instead of filling in from general knowledge;
  if you add background knowledge, label it as such.
- Write in Markdown. Use tables for comparisons. Be concise and specific: numbers, methods, sample sizes.
- Answer language: {lang}.
"""


def agent_available() -> tuple[bool, str]:
    if load_settings()["agent_provider"] != "claude":
        return configured()
    cmd = load_settings()["agent_cmd"]
    path = shutil.which(cmd) or (cmd if os.path.isfile(cmd) else None)
    if not path:
        return False, f"'{cmd}' not found on PATH. Install Claude Code or set the agent command in Settings."
    return True, path


def resolve_scope(scope: dict) -> list[dict]:
    kind = scope.get("type", "all")
    if kind == "papers":
        return [p for p in (db.get_paper(i) for i in scope.get("ids", [])) if p]
    if kind == "folder":
        return [db.get_paper(p["id"]) for p in db.list_papers(folder=scope.get("path", ""))]
    return [db.get_paper(p["id"]) for p in db.list_papers()]


def scope_label(scope: dict) -> str:
    kind = scope.get("type", "all")
    if kind == "papers":
        ids = scope.get("ids", [])
        if len(ids) == 1:
            p = db.get_paper(ids[0])
            return p["title"] if p else "1 paper"
        return f"{len(ids)} selected papers"
    if kind == "folder":
        return f"Folder: {scope.get('path')}"
    return "Whole library"


def write_manifest(chat_id: str, scope: dict) -> tuple[str, list[dict]]:
    papers = resolve_scope(scope)
    lines = [f"# Papers in scope — {scope_label(scope)} ({len(papers)} papers)", ""]
    for p in papers:
        first_author = (p["authors"][0].split()[-1] + (" et al." if len(p["authors"]) > 1 else "")) if p["authors"] else "?"
        lines.append(f"## [{p['id']}] {p['title']}")
        lines.append(f"{first_author} · {p['year'] or 'n.d.'} · {p['venue'] or ''} · "
                     f"{'full text' if p['has_pdf'] else 'abstract only'} · file: text/{p['id']}.md"
                     + (f" · {p['pages']} pages" if p.get("pages") else ""))
        if p.get("tags"):
            lines.append("tags: " + ", ".join(p["tags"]))
        if p.get("summary"):
            lines.append("summary: " + " ".join(p["summary"].split())[:900])
        elif p.get("abstract"):
            lines.append("abstract: " + " ".join(p["abstract"].split())[:600])
        if p.get("notes"):
            lines.append("user's notes: " + " ".join(p["notes"].split())[:400])
        if p.get("team_key"):
            try:
                for n in others_notes(p["id"]):
                    lines.append(f"teammate {n['by']}'s notes: " + " ".join(n["text"].split())[:300])
            except OSError:
                pass
        lines.append("")
    path = SCOPES_DIR / f"{chat_id}.md"
    path.write_text("\n".join(lines))
    return f"scopes/{chat_id}.md", papers


def build_prompt(manifest_rel: str, papers: list[dict], message: str, first_turn: bool) -> str:
    if not first_turn:
        return message + f"\n\n(The scope manifest {manifest_rel} is up to date.)"
    total_chars = sum((TEXT_DIR / f"{p['id']}.md").stat().st_size for p in papers if (TEXT_DIR / f"{p['id']}.md").exists())
    if len(papers) <= 4 and total_chars < 400_000:
        hint = "The scope is small: read the full text of each paper (" + ", ".join(f"text/{p['id']}.md" for p in papers) + ") before answering."
    else:
        hint = (f"The scope has {len(papers)} papers (~{total_chars // 4000}k tokens of text): read {manifest_rel} first, "
                "then Grep text/ and Read only what you need. Be thorough — check every potentially relevant paper.")
    return f"Scope manifest: {manifest_rel}\n{hint}\n\nUser request:\n{message}"


def system_prompt() -> str:
    s = load_settings()
    extra = s["custom_instructions"].strip()
    return SYSTEM.format(lang=s["answer_language"]) + (f"\nThe user's standing instructions:\n{extra}\n" if extra else "")


class AgentRun:
    """One agent turn with whichever provider Settings selects; yields UI events; can be cancelled."""

    def __init__(self):
        self.impl: ClaudeRun | ApiAgentRun | None = None

    def cancel(self):
        if self.impl:
            self.impl.cancel()

    async def stream(self, prompt: str, model: str = "", resume: str | None = None, persist: bool = True,
                     history: list[dict] | None = None) -> AsyncIterator[dict]:
        """model/resume/persist apply to Claude Code; history (earlier turns) to API providers."""
        if load_settings()["agent_provider"] == "claude":
            self.impl = ClaudeRun()
            async for ev in self.impl.stream(prompt, model, resume, persist):
                yield ev
            return
        self.impl = ApiAgentRun()
        async for ev in self.impl.stream(prompt, system_prompt(), history):
            if ev["t"] == "tool_call":  # show API tool calls like Claude Code's Read/Grep/Glob
                name, a = {"read_file": ("Read", {"file_path": ev["args"].get("path", "")}),
                           "grep": ("Grep", {"pattern": ev["args"].get("pattern", "")}),
                           "list_files": ("Glob", {"pattern": ev["args"].get("glob", "")})}.get(ev["name"], (ev["name"], {}))
                yield {"t": "tool", **describe_tool(name, json.dumps(a))}
            else:
                yield ev


class ClaudeRun:
    """One Claude Code CLI invocation; yields UI events; can be cancelled."""

    def __init__(self):
        self.proc: asyncio.subprocess.Process | None = None

    def cancel(self):
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.terminate()
            except ProcessLookupError:
                pass

    async def stream(self, prompt: str, model: str = "", resume: str | None = None,
                     persist: bool = True) -> AsyncIterator[dict]:
        ok, cmd = agent_available()
        if not ok:
            yield {"t": "error", "text": cmd}
            return
        args = [cmd, "-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                "--tools", "Read", "Grep", "Glob", "--allowedTools", "Read", "Grep", "Glob",
                # keep the API key and the library login session out of the agent's reach
                "--disallowedTools", "Read(./settings.json)", "Read(./browser_profile/**)",
                "--permission-mode", "dontAsk", "--strict-mcp-config",
                "--append-system-prompt", system_prompt()]
        if model:
            args += ["--model", model]
        if resume:
            args += ["--resume", resume]
        if not persist:
            args += ["--no-session-persistence"]
        env = {**os.environ}
        env.pop("CLAUDECODE", None)  # allow launching even if this server was started from a Claude Code shell
        self.proc = await asyncio.create_subprocess_exec(
            *args, cwd=str(DATA), stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env, limit=64 * 1024 * 1024)
        tool_inputs: dict[int, dict] = {}
        got_text = False
        async for raw in self.proc.stdout:
            try:
                e = json.loads(raw)
            except json.JSONDecodeError:
                continue
            t = e.get("type")
            if t == "system" and e.get("subtype") == "init":
                yield {"t": "session", "id": e.get("session_id")}
            elif t == "stream_event":
                ev = e.get("event", {})
                et = ev.get("type")
                if et == "content_block_start":
                    cb = ev.get("content_block", {})
                    if cb.get("type") == "tool_use":
                        tool_inputs[ev.get("index", 0)] = {"name": cb.get("name"), "json": ""}
                        if got_text:  # text before a tool call was interim narration, not the answer
                            got_text = False
                            yield {"t": "reset"}
                    elif cb.get("type") == "thinking":
                        yield {"t": "status", "text": "Thinking…"}
                elif et == "content_block_delta":
                    d = ev.get("delta", {})
                    if d.get("type") == "text_delta":
                        got_text = True
                        yield {"t": "delta", "text": d.get("text", "")}
                    elif d.get("type") == "input_json_delta" and ev.get("index", 0) in tool_inputs:
                        tool_inputs[ev["index"]]["json"] += d.get("partial_json", "")
                elif et == "content_block_stop" and ev.get("index", 0) in tool_inputs:
                    ti = tool_inputs.pop(ev["index"])
                    yield {"t": "tool", **describe_tool(ti["name"], ti["json"])}
                elif et == "message_start" and got_text:
                    yield {"t": "delta", "text": "\n\n"}
            elif t == "result":
                if e.get("is_error") or e.get("subtype") != "success":
                    yield {"t": "error", "text": str(e.get("result") or e.get("subtype"))}
                yield {"t": "done", "cost": e.get("total_cost_usd"), "session": e.get("session_id"),
                       "result": e.get("result") or ""}
        await self.proc.wait()
        if self.proc.returncode not in (0, None) and self.proc.returncode > 0:
            err = (await self.proc.stderr.read()).decode(errors="ignore").strip()
            if err:
                yield {"t": "error", "text": err[-800:]}


def describe_tool(name: str, raw: str) -> dict:
    try:
        inp = json.loads(raw or "{}")
    except json.JSONDecodeError:
        inp = {}
    detail, pid = "", None
    if name == "Read":
        fp = inp.get("file_path", "")
        base = os.path.basename(fp)
        if "/text/" in fp or fp.startswith("text/"):
            pid = base.removesuffix(".md")
            p = db.get_paper(pid)
            detail = f"Reading “{p['title'][:80]}”" if p else f"Reading {base}"
        elif "/scopes/" in fp or fp.startswith("scopes/"):
            detail = "Reading the scope manifest"
        else:
            detail = f"Reading {base}"
    elif name == "Grep":
        detail = f"Searching papers for “{inp.get('pattern', '')}”"
    elif name == "Glob":
        detail = f"Listing {inp.get('pattern', '')}"
    else:
        detail = name
    return {"name": name, "detail": detail, "paper": pid}


SUMMARY_PROMPT = """Read text/{pid}.md completely, then write a structured summary of this paper in Markdown.
Output ONLY the summary (no preamble), using exactly these sections:

**TL;DR** — one or two sentences.
**Research question** —
**Methods** — design, data/samples (with n), key techniques.
**Key findings** — 3–6 bullets with concrete numbers, each ending with [@{pid} p.N].
**Limitations** —
**Why it matters / how to use it** —
**Keywords** — 5–8 comma-separated terms.

Answer language: {lang}."""


async def summarize(pid: str) -> str:
    s = load_settings()
    run = AgentRun()
    text, result, err = "", "", ""
    async for ev in run.stream(SUMMARY_PROMPT.format(pid=pid, lang=s["answer_language"]),
                               model=s["summary_model"], persist=False):
        if ev["t"] == "delta":
            text += ev["text"]
        elif ev["t"] == "done":
            result = ev.get("result") or ""
        elif ev["t"] == "error":
            err = ev["text"]
    out = (result or text).strip()
    if not out:
        raise RuntimeError(err or "Agent returned nothing")
    return out
