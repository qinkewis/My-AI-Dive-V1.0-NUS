"""Importing PDFs into the library."""
import asyncio
from pathlib import Path

from . import db
from .config import PAPERS_DIR
from .discovery import lookup_doi, lookup_title
from .pdftools import extract_text, inspect_pdf


async def import_pdf(data: bytes, filename: str, folder: str) -> dict:
    """Stores a PDF, finds its metadata (DOI → OpenAlex, else title search) and indexes its text.
    A PDF whose DOI is already in the library comes back with duplicate=True."""
    pid = db.new_id()
    tmp = PAPERS_DIR / f"{pid}.pdf"
    tmp.write_bytes(data)
    info = await asyncio.to_thread(inspect_pdf, tmp)
    meta = await lookup_doi(info["doi_guess"]) if info["doi_guess"] else None
    if not meta and info["title_guess"]:
        meta = await lookup_title(info["title_guess"])
    if meta and meta.get("doi"):
        dup = db.find_by_doi(meta["doi"])
        if dup:
            if dup["has_pdf"]:
                tmp.unlink()
                return {**dup, "duplicate": True}
            # Metadata-only record already exists (e.g. download failed) → attach this PDF to it.
            tmp.rename(PAPERS_DIR / f"{dup['id']}.pdf")
            pages = await asyncio.to_thread(extract_text, dup["id"], dup)
            return db.update_paper(dup["id"], has_pdf=1, pages=pages, dl_status="ok", dl_error="")
    fields = dict(title=(meta or {}).get("title") or info["title_guess"] or Path(filename).stem,
                  authors=(meta or {}).get("authors", []), year=(meta or {}).get("year"),
                  venue=(meta or {}).get("venue", ""), doi=(meta or {}).get("doi", info["doi_guess"]),
                  abstract=(meta or {}).get("abstract", ""), url=(meta or {}).get("url", ""),
                  cited_by=(meta or {}).get("cited_by"))
    p = db.insert_paper(id=pid, folder=folder, source=f"upload: {filename}", has_pdf=1,
                        pages=info["pages"], dl_status="ok", **fields)
    await asyncio.to_thread(extract_text, pid, p)
    db.reindex(pid)
    return db.get_paper(pid)
