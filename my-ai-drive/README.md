# My AI Drive

A local literature drive with a library on the left, a list or chat in the middle and a PDF reader on the right. An AI agent reads your papers and answers with page citations. It runs on Claude Code, DeepSeek, Qwen or any OpenAI-compatible API. Your university library access (NUS Libraries by default) downloads paywalled PDFs.

Everything runs on your own computer. Your papers, notes, settings, API keys and library login stay in `data/`, which is never committed.

## Requirements

- macOS (the app icon and folder picker use macOS; the web app itself also runs on Linux)
- Python 3.10+
- Google Chrome, for the library login and the app window
- One AI provider:
  - [Claude Code](https://claude.com/claude-code), signed in (`claude` on your PATH), or
  - an API key for DeepSeek, Qwen (Alibaba Cloud DashScope) or another OpenAI-compatible service with tool calling

## Start

```bash
git clone <this repo> my-ai-drive && cd my-ai-drive
./run.sh            # creates .venv, installs requirements, opens http://127.0.0.1:8765
./make_app.sh       # optional: a "My AI Drive" app icon on your Desktop, in this folder and in the Dock
```

Then open **Settings → AI provider**. Pick Claude Code, DeepSeek, Qwen or another API, enter your key and model, and click **Save & test connection**.

The app icon starts the server in the background when it isn't running, then opens the app in its own Chrome window. On first launch macOS asks whether it may access the folder this project lives in; click Allow. The server keeps running after you close the window, and *Settings → Stop server* stops it. If you move this folder, run `./make_app.sh` again.

## What it does

| Area | How |
|---|---|
| **Library** | Drag PDFs onto the window or use *Import PDFs*. The app reads metadata from the PDF's DOI through OpenAlex, extracts the full text and indexes it for search (press `/`). You can organise papers with nested folders (drag papers onto a folder), tags, stars and read status. |
| **Batch import & organise** | *Import ▾ → A whole folder of PDFs* imports every PDF under a folder (subfolders included) as a background job and skips papers you already have. The agent then organises the new papers. First it designs one folder tree from their topics, reusing your existing folders. Then it gives each paper a folder plus tags for study type, methods and model system. You review the plan, rename folders if you like, and *Apply*. *Undo* puts every paper back. *⌗ Organise* (library header, selection bar, right-click, or a folder's ⋯ menu) does the same for papers already in your library. |
| **Reader (right pane)** | The PDF viewer remembers your page. Select text to get *Ask AI*, *Explain*, *Translate*, *+ Note* or *Copy*. The *Details & summary* tab holds editable metadata, the AI summary and your notes. ⤢ opens focus mode. |
| **Agent** | *Ask AI* works on one paper, a selection, a folder or the whole library. The agent has read-only tools (read, grep, list) over the papers' extracted text and your notes, so it can search across hundreds of papers. It cannot read your settings, API key or library login. Answers cite `[@id p.N]`, and the app turns those into chips that open the PDF at that page. *Summarise* runs a batch job with structured summaries. You can save any answer as a note. Use ✦ Chat in the reader, or focus mode, to keep the chat beside the PDF. |
| **AI provider** | *Settings → AI provider* chooses the engine. **Claude Code** runs `claude -p` locally with your Claude login. **DeepSeek**, **Qwen** and **other OpenAI-compatible APIs** use your key and one model for every task; the model must support tool calling. *Custom instructions* are added to the agent's instructions for every task, for example your field or the style you want. *Temperature* applies to API providers. |
| **Team** | Each person sets *Settings → Team sharing* to the same synced folder (shared Dropbox, OneDrive or Google Drive). *Share with team* (right-click, selection bar or Details tab) copies the PDF there and keeps your notes on that paper in sync as you type. Teammates see shared papers and everyone's notes under **Team**, can add them to their own library with one click, and see teammates' notes in a paper's Details tab. The agent reads them too. Every file has a single writer (`notes - <Name>.md`), so syncing never conflicts. |
| **Vocabulary** | Select a word or phrase in a PDF and click *+ Word*. The agent writes a short definition and a translation (your *Translate selections to* language), and the app keeps the sentence the word came from and links back to that page. *Review* runs spaced-repetition flashcards (Space to reveal, then 1 = again, 2 = got it). *Export* writes a CSV that Anki can import. |
| **Find papers (NUS)** | Enter several topics, one per line. Each topic gets an OpenAlex search, and its results can go into their own folder. Downloads try open-access copies first, then your logged-in NUS proxy (`libproxy1.nus.edu.sg`). You can review results before downloading or download everything. *Add by DOI* is also available. |

## Library login (NUS)

Click **Connect NUS Library** under *Find papers*. A Chrome window opens at the NUS proxy, and you log in there yourself with your own NUSNET ID and 2FA. The app never sees or stores your password. Other institutions that use EZproxy can change *Settings → Proxy prefix* to their own login URL. The session lives in `data/browser_profile/`, so keep that folder private. If a site shows a "verify you are human" check, solve it in that window and the download continues.

Publisher licences forbid systematic bulk downloading, and the proxy can suspend accounts that do it. Downloads are spaced 8–15 s apart and capped at 40 per batch. You can change both in Settings.

## Privacy

`data/` holds everything personal: PDFs, notes, chats, settings, API keys and your library login session. `.gitignore` excludes it, along with `.venv/` and the local app shortcut, so the repository contains only the source code.

## Files

```
data/papers/<id>.pdf     original PDFs
data/text/<id>.md        extracted text with "--- Page N ---" markers (what the agent reads)
data/notes/              saved notes and AI answers
data/library.db          metadata, folders, chats, jobs (SQLite)
data/browser_profile/    Chrome profile holding your library session
data/settings.json       your settings, including any API key
server/                  FastAPI backend (agent.py, nus.py, jobs.py, ...)
static/                  frontend (app.js, styles.css, vendored pdf.js/marked/DOMPurify)
data/server.log          server output when started from the app icon

<team folder>/<Author Year – Title> [key]/
    paper.pdf, info.json     written once by whoever shared it first
    notes - <Name>.md        one file per person, written only by that person
```
