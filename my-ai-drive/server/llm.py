"""The agent over an OpenAI-compatible chat API (DeepSeek, Qwen/DashScope, OpenAI, a local server…).

It mirrors the Claude Code agent: a tool loop with read-only access to the paper texts, notes and scope
manifests, yielding the same UI events as agent.AgentRun.
"""
import fnmatch
import json
import re

import httpx

from .config import DATA, load_settings

LABELS = {"deepseek": "DeepSeek", "qwen": "Qwen", "openai": "OpenAI-compatible API"}  # defaults live in the Settings page
READABLE = ("text", "notes", "scopes")  # never settings.json (API key) or browser_profile (library session)
MAX_STEPS = 30
MAX_CHARS = 60_000

TOOLS = [
    {"type": "function", "function": {
        "name": "read_file",
        "description": "Read a text file from the library, e.g. text/<paper_id>.md (a paper's full text with "
                       "'--- Page N ---' markers), notes/<id>.md or scopes/<chat_id>.md. Long files come in "
                       "pages: pass offset (first line, 1-based) to continue.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "Path relative to the library, e.g. text/ab12cd34ef.md"},
            "offset": {"type": "integer", "description": "First line to read (1-based)", "default": 1},
            "limit": {"type": "integer", "description": "Max lines", "default": 1500}},
            "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "grep",
        "description": "Search the library's files with a regular expression. Returns matching lines as "
                       "path:line: text. Use it to find which papers mention a term and where.",
        "parameters": {"type": "object", "properties": {
            "pattern": {"type": "string", "description": "Regular expression (case-insensitive)"},
            "glob": {"type": "string", "description": "Which files, e.g. text/*.md (default) or text/ab12cd34ef.md"},
            "max_results": {"type": "integer", "default": 80}},
            "required": ["pattern"]}}},
    {"type": "function", "function": {
        "name": "list_files",
        "description": "List library files matching a glob, e.g. text/*.md or notes/*.md.",
        "parameters": {"type": "object", "properties": {"glob": {"type": "string"}}, "required": ["glob"]}}},
]

TOOL_RULES = """
Tools: read_file, grep and list_files give you read-only access to the library files described above.
Always read the relevant files before answering; never invent page numbers. Prefer grep to find
passages across many papers, then read_file around the matches."""


def configured() -> tuple[bool, str]:
    s = load_settings()
    label = LABELS.get(s["agent_provider"], LABELS["openai"])
    missing = [n for n, k in (("API base URL", "api_base"), ("API key", "api_key"), ("model", "api_model")) if not s[k].strip()]
    if missing:
        return False, f"{label}: set the {', '.join(missing)} in Settings → AI provider."
    return True, f"{label} · {s['api_model']}"


def _resolve(rel: str):
    p = (DATA / rel.lstrip("/")).resolve()
    if not any(p.is_relative_to(DATA / d) for d in READABLE):
        raise ValueError(f"Only {', '.join(d + '/' for d in READABLE)} can be read")
    return p


def _files(glob: str) -> list:
    glob = (glob or "text/*.md").lstrip("/")
    top = glob.split("/")[0]
    if top not in READABLE:
        raise ValueError(f"Only {', '.join(d + '/' for d in READABLE)} can be searched")
    return sorted(p for p in (DATA / top).rglob("*") if p.is_file() and fnmatch.fnmatch(str(p.relative_to(DATA)), glob))


def run_tool(name: str, args: dict) -> str:
    try:
        if name == "read_file":
            p = _resolve(str(args.get("path", "")))
            if not p.is_file():
                return f"No such file: {args.get('path')}"
            lines = p.read_text(errors="ignore").splitlines()
            start = max(1, int(args.get("offset") or 1))
            out, size = [], 0
            for i in range(start - 1, min(len(lines), start - 1 + int(args.get("limit") or 1500))):
                size += len(lines[i]) + 1
                if size > MAX_CHARS:
                    break
                out.append(lines[i])
            end = start - 1 + len(out)
            more = f"\n[lines {start}-{end} of {len(lines)}; continue with offset={end + 1}]" if end < len(lines) else ""
            return "\n".join(out) + more
        if name == "grep":
            rx = re.compile(str(args.get("pattern", "")), re.I)
            cap, hits = int(args.get("max_results") or 80), []
            for p in _files(str(args.get("glob") or "text/*.md")):
                for n, line in enumerate(p.read_text(errors="ignore").splitlines(), 1):
                    if rx.search(line):
                        hits.append(f"{p.relative_to(DATA)}:{n}: {line.strip()[:300]}")
                        if len(hits) >= cap:
                            return "\n".join(hits) + f"\n[stopped at {cap} matches]"
            return "\n".join(hits) or "No matches"
        if name == "list_files":
            fs = _files(str(args.get("glob", "")))
            return "\n".join(str(p.relative_to(DATA)) for p in fs[:500]) or "No files"
        return f"Unknown tool {name}"
    except (ValueError, re.error, OSError) as e:
        return f"Error: {e}"


class ApiAgentRun:
    """One agent turn over the API; yields UI events; can be cancelled."""

    def __init__(self):
        self.cancelled = False

    def cancel(self):
        self.cancelled = True

    async def stream(self, prompt: str, system: str, history: list[dict] | None = None, tools: bool = True):
        ok, detail = configured()
        if not ok:
            yield {"t": "error", "text": detail}
            return
        s = load_settings()
        messages = [{"role": "system", "content": system + (TOOL_RULES if tools else "")},
                    *(history or []), {"role": "user", "content": prompt}]
        url = s["api_base"].rstrip("/") + "/chat/completions"
        headers = {"Authorization": f"Bearer {s['api_key'].strip()}"}
        tokens = 0
        async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=20)) as client:
            for _ in range(MAX_STEPS):
                body = {"model": s["api_model"], "messages": messages, "stream": True,
                        "temperature": s["temperature"], "stream_options": {"include_usage": True}}
                if tools:
                    body["tools"] = TOOLS
                text, calls, thinking = "", {}, False
                try:
                    async with client.stream("POST", url, headers=headers, json=body) as r:
                        if r.status_code != 200:
                            err = (await r.aread()).decode(errors="ignore")
                            yield {"t": "error", "text": f"{r.status_code} from {s['api_base']}: {err[:600]}"}
                            return
                        async for line in r.aiter_lines():
                            if self.cancelled:
                                yield {"t": "done", "result": text}
                                return
                            if not line.startswith("data:") or line[5:].strip() == "[DONE]":
                                continue
                            try:
                                chunk = json.loads(line[5:])
                            except json.JSONDecodeError:
                                continue
                            tokens += (chunk.get("usage") or {}).get("total_tokens", 0)
                            for ch in chunk.get("choices") or []:
                                d = ch.get("delta") or {}
                                if d.get("reasoning_content") and not thinking:
                                    thinking = True
                                    yield {"t": "status", "text": "Thinking…"}
                                if d.get("content"):
                                    text += d["content"]
                                    yield {"t": "delta", "text": d["content"]}
                                for tc in d.get("tool_calls") or []:
                                    c = calls.setdefault(tc.get("index", 0), {"id": "", "name": "", "args": ""})
                                    c["id"] = tc.get("id") or c["id"]
                                    fn = tc.get("function") or {}
                                    c["name"] += fn.get("name") or ""
                                    c["args"] += fn.get("arguments") or ""
                except httpx.HTTPError as e:
                    yield {"t": "error", "text": f"Could not reach {s['api_base']}: {e}"}
                    return
                if not calls:
                    yield {"t": "done", "result": text, "tokens": tokens}
                    return
                if text:
                    yield {"t": "reset"}  # text before a tool call was interim narration, not the answer
                messages.append({"role": "assistant", "content": text or None, "tool_calls": [
                    {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["args"] or "{}"}}
                    for c in calls.values()]})
                for c in calls.values():
                    try:
                        args = json.loads(c["args"] or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    yield {"t": "tool_call", "name": c["name"], "args": args}
                    messages.append({"role": "tool", "tool_call_id": c["id"], "content": run_tool(c["name"], args)})
            yield {"t": "error", "text": f"Stopped after {MAX_STEPS} tool steps"}
            yield {"t": "done", "result": "", "tokens": tokens}
