"""Paths and user settings for My AI Drive."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PAPERS_DIR = DATA / "papers"        # original PDFs: <id>.pdf
TEXT_DIR = DATA / "text"            # extracted full text the agent reads: <id>.md
NOTES_DIR = DATA / "notes"          # saved AI answers / reviews: <id>.md
SCOPES_DIR = DATA / "scopes"        # per-chat manifests listing the papers in scope
PROFILE_DIR = DATA / "browser_profile"  # persistent Chrome profile holding the NUS login
DB_PATH = DATA / "library.db"
SETTINGS_PATH = DATA / "settings.json"
STATIC = ROOT / "static"

for d in (DATA, PAPERS_DIR, TEXT_DIR, NOTES_DIR, SCOPES_DIR, PROFILE_DIR):
    d.mkdir(parents=True, exist_ok=True)

DEFAULTS = {
    # Agent provider: "claude" = the Claude Code CLI, run headless and read-only inside data/;
    # "deepseek" | "qwen" | "openai" = an OpenAI-compatible chat API
    "agent_provider": "claude",
    "agent_cmd": "claude",
    "api_base": "",
    "api_key": "",
    "api_model": "",
    "temperature": 0.3,
    "custom_instructions": "",   # appended to the agent's system prompt (any provider)
    "chat_model": "",            # "" = the CLI's default model
    "summary_model": "sonnet",
    "summary_concurrency": 3,
    "answer_language": "Same language as the question",
    "translate_to": "Chinese (Simplified)",
    "vocab_model": "haiku",      # defines words saved to the vocabulary notebook
    # NUS Libraries EZproxy
    "proxy_prefix": "https://libproxy1.nus.edu.sg/login?url=",
    "browser_channel": "chrome",  # "chrome" = your installed Google Chrome; "chromium" = Playwright's
    "delay_min": 8,               # seconds between publisher downloads (be gentle with the proxy)
    "delay_max": 15,
    "max_per_batch": 40,
    # Team: a folder everyone syncs (Dropbox, OneDrive, Google Drive…); "" = sharing off
    "team_dir": "",
    "my_name": "",               # "" = your macOS account name
    # Discovery
    "openalex_mailto": "",        # optional: puts you in OpenAlex's faster "polite pool"
}


def load_settings() -> dict:
    s = dict(DEFAULTS)
    if SETTINGS_PATH.exists():
        try:
            s.update(json.loads(SETTINGS_PATH.read_text()))
        except Exception:
            pass
    return s


def save_settings(patch: dict) -> dict:
    s = load_settings()
    for k, v in patch.items():
        if k in DEFAULTS:
            s[k] = type(DEFAULTS[k])(v) if DEFAULTS[k] is not None and v is not None else v
    SETTINGS_PATH.write_text(json.dumps(s, indent=2, ensure_ascii=False))
    return s
