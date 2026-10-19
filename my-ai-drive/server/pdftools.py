"""PDF text extraction (for the agent and full-text search) and metadata guessing."""
import re
from pathlib import Path

import pymupdf

from .config import PAPERS_DIR, TEXT_DIR

DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>,;]+)", re.I)


def is_pdf(data: bytes) -> bool:
    """A complete, openable PDF (rejects HTML error pages and truncated range-request chunks)."""
    if not data or not data[:1024].lstrip().startswith(b"%PDF"):
        return False
    try:
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            return doc.page_count > 0 and (not doc.is_repaired or b"%%EOF" in data[-4096:])
    except Exception:
        return False


def clean_doi(doi: str) -> str:
    doi = (doi or "").strip()
    doi = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:\s*)", "", doi, flags=re.I)
    return doi.rstrip(".)]}")


def inspect_pdf(path: Path) -> dict:
    """Returns {pages, title_guess, doi_guess}."""
    doc = pymupdf.open(path)
    info = {"pages": doc.page_count, "title_guess": "", "doi_guess": ""}
    meta_title = (doc.metadata or {}).get("title", "").strip()
    first = "".join(doc[i].get_text() for i in range(min(2, doc.page_count)))
    m = DOI_RE.search(first)
    if m:
        info["doi_guess"] = clean_doi(m.group(1))
    # Largest-font line on page 1 is usually the title.
    best, best_size = "", 0.0
    if doc.page_count:
        for block in doc[0].get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                text = " ".join(s["text"] for s in line["spans"]).strip()
                size = max((s["size"] for s in line["spans"]), default=0)
                if len(text) > 8 and size > best_size + 0.5:
                    best, best_size = text, size
                elif len(text) > 2 and abs(size - best_size) <= 0.5 and best and len(best) < 250:
                    best += " " + text
    looks_junk = not meta_title or len(meta_title) < 8 or re.search(r"\.(docx?|pdf|tex)$|^untitled|^microsoft", meta_title, re.I)
    info["title_guess"] = (best if looks_junk else meta_title)[:300]
    doc.close()
    return info


def extract_text(pid: str, header: dict) -> int:
    """Writes data/text/<pid>.md with a metadata header and page markers. Returns page count."""
    pdf = PAPERS_DIR / f"{pid}.pdf"
    doc = pymupdf.open(pdf)
    authors = ", ".join(header.get("authors") or [])
    lines = [
        f"# {header.get('title') or 'Untitled'}",
        f"paper_id: {pid}",
        f"authors: {authors}",
        f"year: {header.get('year') or ''}",
        f"venue: {header.get('venue') or ''}",
        f"doi: {header.get('doi') or ''}",
        "",
    ]
    for i, page in enumerate(doc, start=1):
        txt = page.get_text("text")  # natural order follows columns in most publisher PDFs
        txt = re.sub(r"[ \t]{2,}", " ", txt)
        txt = re.sub(r"(?m)^[ \t]+|[ \t]+$", "", txt)
        txt = re.sub(r"-\n(?=[a-z])", "", txt)  # re-join hyphenated line breaks
        txt = re.sub(r"\n{3,}", "\n\n", txt)
        lines.append(f"\n--- Page {i} ---\n")
        lines.append(txt.strip())
    n = doc.page_count
    doc.close()
    (TEXT_DIR / f"{pid}.md").write_text("\n".join(lines))
    return n


def write_metadata_only_text(pid: str, p: dict):
    """For papers without a PDF yet, the agent can still read the abstract."""
    authors = ", ".join(p.get("authors") or [])
    (TEXT_DIR / f"{pid}.md").write_text(
        f"# {p.get('title')}\npaper_id: {pid}\nauthors: {authors}\nyear: {p.get('year') or ''}\n"
        f"venue: {p.get('venue') or ''}\ndoi: {p.get('doi') or ''}\n\n(Full text not available — abstract only.)\n\n"
        f"## Abstract\n{p.get('abstract') or '(none)'}\n"
    )
