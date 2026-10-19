"""Paper discovery and metadata via OpenAlex (free, no key; covers ~250M works)."""
import httpx

from .config import load_settings
from .pdftools import clean_doi

API = "https://api.openalex.org"
UA = "MyAIDrive/1.0 (personal literature manager)"


def _params(extra: dict) -> dict:
    mailto = load_settings().get("openalex_mailto")
    return {**extra, **({"mailto": mailto} if mailto else {})}


def _abstract(inv: dict | None) -> str:
    if not inv:
        return ""
    pos = [(i, w) for w, idx in inv.items() for i in idx]
    return " ".join(w for _, w in sorted(pos))


def _work(w: dict) -> dict:
    loc = w.get("primary_location") or {}
    src = loc.get("source") or {}
    oa = w.get("best_oa_location") or {}
    pdfs = [oa.get("pdf_url")] + [l.get("pdf_url") for l in w.get("locations", [])]
    pdfs = list(dict.fromkeys(u for u in pdfs if u))  # every known open-access copy, best first
    return {
        "openalex_id": w.get("id", "").rsplit("/", 1)[-1],
        "title": (w.get("title") or w.get("display_name") or "Untitled").strip(),
        "authors": [a["author"]["display_name"] for a in w.get("authorships", []) if a.get("author")][:30],
        "year": w.get("publication_year"),
        "venue": src.get("display_name") or "",
        "doi": clean_doi(w.get("doi") or ""),
        "abstract": _abstract(w.get("abstract_inverted_index")),
        "cited_by": w.get("cited_by_count"),
        "type": w.get("type"),
        "is_oa": (w.get("open_access") or {}).get("is_oa", False),
        "oa_url": "\n".join(pdfs[:5]),
        "url": loc.get("landing_page_url") or (w.get("doi") or ""),
    }


async def search(topic: str, limit: int = 20, year_from: int | None = None, year_to: int | None = None,
                 sort: str = "relevance", types: str = "article|review", oa_only: bool = False) -> list[dict]:
    filters = []
    if year_from:
        filters.append(f"from_publication_year:{year_from}")
    if year_to:
        filters.append(f"to_publication_year:{year_to}")
    if types:
        filters.append(f"type:{types}")
    if oa_only:
        filters.append("is_oa:true")
    sort_param = {"relevance": "relevance_score:desc", "cited": "cited_by_count:desc", "recent": "publication_date:desc"}[sort]
    params = _params({"search": topic, "per-page": min(max(limit, 1), 200), "sort": sort_param})
    if filters:
        params["filter"] = ",".join(filters)
    async with httpx.AsyncClient(timeout=30, headers={"User-Agent": UA}) as c:
        r = await c.get(f"{API}/works", params=params)
        r.raise_for_status()
        return [_work(w) for w in r.json().get("results", [])][:limit]


async def lookup_doi(doi: str) -> dict | None:
    doi = clean_doi(doi)
    if not doi:
        return None
    try:
        async with httpx.AsyncClient(timeout=20, headers={"User-Agent": UA}) as c:
            r = await c.get(f"{API}/works/doi:{doi}", params=_params({}))
            if r.status_code == 200:
                return _work(r.json())
    except httpx.HTTPError:
        pass
    return None


async def lookup_title(title: str) -> dict | None:
    """Best-effort match by title; only accepted when titles are near-identical."""
    if len(title) < 15:
        return None
    try:
        async with httpx.AsyncClient(timeout=20, headers={"User-Agent": UA}) as c:
            r = await c.get(f"{API}/works", params=_params({"search": title, "per-page": 3}))
            r.raise_for_status()
            norm = lambda s: "".join(ch for ch in s.lower() if ch.isalnum())
            for w in r.json().get("results", []):
                if norm(w.get("title") or "") == norm(title):
                    return _work(w)
    except httpx.HTTPError:
        pass
    return None
