"""NUS Libraries access through EZproxy, using a persistent browser profile.

You log in yourself once (NUSNET + MFA) in a real Chrome window that this app opens.
The session cookies stay in data/browser_profile, so your password is never seen or stored
by this app. Downloads then go through that same logged-in browser.
"""
import asyncio
import random
import re
from urllib.parse import quote, urljoin, urlparse

import httpx
from playwright.async_api import BrowserContext, Page, async_playwright

from .config import PROFILE_DIR, load_settings
from .pdftools import is_pdf

BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)

PDF_HREF = re.compile(r"(\.pdf($|[?#])|/pdf/|/pdfft|pdfdirect|/epdf/|getpdf|stamp\.jsp|download.*pdf|/content/pdf/)", re.I)
PDF_TEXT = re.compile(r"^\s*((download|view|get|full[- ]?text)\s*(the\s*)?(article\s*)?pdf|pdf)\b", re.I)


class DownloadError(Exception):
    pass


class NUSSession:
    def __init__(self):
        self._pw = None
        self.ctx: BrowserContext | None = None
        self._lock = asyncio.Lock()
        self.last_check: dict = {"logged_in": None, "detail": "Not checked yet"}

    # ---------- browser lifecycle ----------

    @property
    def proxy_prefix(self) -> str:
        return load_settings()["proxy_prefix"]

    @property
    def proxy_host(self) -> str:
        return urlparse(self.proxy_prefix).hostname or ""

    def proxied(self, url: str) -> str:
        return self.proxy_prefix + quote(url, safe=":/?&=#%")

    async def ensure_browser(self) -> BrowserContext:
        if self.ctx:
            try:
                _ = self.ctx.pages
                return self.ctx
            except Exception:
                self.ctx = None
        if not self._pw:
            self._pw = await async_playwright().start()
        channel = load_settings().get("browser_channel") or "chrome"
        kwargs = dict(user_data_dir=str(PROFILE_DIR), headless=False, accept_downloads=True,
                      no_viewport=True, args=["--disable-blink-features=AutomationControlled"])
        try:
            self.ctx = await self._pw.chromium.launch_persistent_context(
                channel=None if channel == "chromium" else channel, **kwargs)
        except Exception as e:
            if channel == "chromium":
                raise
            # Fall back to Playwright's bundled Chromium (needs `playwright install chromium`).
            try:
                self.ctx = await self._pw.chromium.launch_persistent_context(**kwargs)
            except Exception:
                raise RuntimeError(f"Could not start a browser: {e}")
        self.ctx.on("close", lambda *_: setattr(self, "ctx", None))
        return self.ctx

    async def close(self):
        if self.ctx:
            try:
                await self.ctx.close()
            except Exception:
                pass
            self.ctx = None

    # ---------- login ----------

    async def open_login(self):
        """Opens the NUS proxy login page in a visible window for the user to sign in."""
        ctx = await self.ensure_browser()
        page = await ctx.new_page()
        await page.goto(self.proxied("https://www.sciencedirect.com/"), wait_until="domcontentloaded")
        await page.bring_to_front()

    async def check_login(self) -> dict:
        """Asks the proxy for a licensed site; logged in if we land on a proxied host, not a login page."""
        if not self.ctx:
            has_cookie = any(PROFILE_DIR.glob("**/Cookies"))
            self.last_check = {"logged_in": None, "detail": "Browser not started" + (" (saved profile found)" if has_cookie else "")}
            return self.last_check
        try:
            r = await self.ctx.request.get(self.proxied("https://www.jstor.org/"), timeout=30000, max_redirects=20)
            final = r.url
            host = urlparse(final).hostname or ""
            on_proxied_site = host.endswith(self.proxy_host) and host != self.proxy_host
            ok = on_proxied_site and "login" not in urlparse(final).path.lower()
            self.last_check = {"logged_in": ok, "detail": "Signed in to NUS Libraries" if ok else "Not signed in — click Connect and log in with NUSNET", "url": final}
        except Exception as e:
            self.last_check = {"logged_in": False, "detail": f"Check failed: {e}"}
        return self.last_check

    # ---------- downloading ----------

    async def fetch_open_access(self, urls: list[str]) -> bytes | None:
        """Plain HTTP first (fast); many publishers block this, so fetch_in_browser is the fallback."""
        async with httpx.AsyncClient(timeout=45, follow_redirects=True, headers={"User-Agent": BROWSER_UA}) as c:
            for url in urls:
                try:
                    r = await c.get(url)
                    if r.status_code == 200 and is_pdf(r.content):
                        return r.content
                except httpx.HTTPError:
                    pass
        return None

    async def fetch_in_browser(self, urls: list[str]) -> bytes | None:
        """Open-access URLs fetched by the real browser (passes Cloudflare/bot checks)."""
        async with self._lock:
            ctx = await self.ensure_browser()
            for url in urls:
                data = await self._try_request(url) or await self._try_navigate(ctx, url)
                if data:
                    return data
        return None

    async def fetch_via_proxy(self, doi: str, landing_url: str = "") -> bytes:
        """Opens the article through the NUS proxy, finds its PDF link and returns the PDF bytes."""
        async with self._lock:
            ctx = await self.ensure_browser()
            page = await ctx.new_page()
            try:
                target = f"https://doi.org/{doi}" if doi else landing_url
                if not target:
                    raise DownloadError("No DOI or URL to open")
                await page.goto(self.proxied(target), wait_until="domcontentloaded", timeout=90000)
                await self._settle(page)
                host = urlparse(page.url).hostname or ""
                if not host.endswith(self.proxy_host) or ("login" in page.url.lower() and host == self.proxy_host):
                    raise DownloadError("Not signed in to the NUS proxy (or the proxy does not cover this publisher)")
                candidates = await self._pdf_candidates(page)
                if not candidates:
                    raise DownloadError(f"No PDF link found on {host} — NUS may not subscribe to this title")
                for url in candidates[:6]:
                    data = await self._try_request(url) or await self._try_navigate(ctx, url)
                    if data:
                        return data
                raise DownloadError(f"Found {len(candidates)} PDF link(s) on {host} but none returned a PDF (access denied or captcha)")
            finally:
                await page.close()

    async def _settle(self, page: Page):
        try:
            await page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            pass
        # Bot-check interstitials (Cloudflare etc.) — give the user time to solve them in the window.
        for _ in range(30):
            title = (await page.title()).lower()
            if not any(s in title for s in ("just a moment", "attention required", "verify you are human", "are you a robot")):
                break
            await page.bring_to_front()
            await asyncio.sleep(2)

    async def _pdf_candidates(self, page: Page) -> list[str]:
        base = page.url
        found: list[str] = []

        def add(u):
            if u:
                u = urljoin(base, u)
                if u not in found:
                    found.append(u)

        for sel in ('meta[name="citation_pdf_url"]', 'meta[name="eprints.document_url"]', 'meta[property="citation_pdf_url"]'):
            for el in await page.query_selector_all(sel):
                add(await el.get_attribute("content"))

        # Publisher URL patterns (work on proxied hostnames too).
        u = urlparse(base)
        path = u.path
        if re.search(r"/doi/(abs|full|epdf|book)/", path):  # Wiley, T&F, SAGE, ACS, Annual Reviews, etc.
            add(re.sub(r"/doi/(abs|full|epdf|book)/", "/doi/pdfdirect/", base) if "wiley" in u.netloc else None)
            add(re.sub(r"/doi/(abs|full|epdf|book)/", "/doi/pdf/", base))
        if "springer" in u.netloc and "/article/" in path:
            add(base.replace("/article/", "/content/pdf/").split("?")[0] + ".pdf")
        if "nature-com" in u.netloc and "/articles/" in path:
            add(base.split("?")[0] + ".pdf")
        m = re.search(r"/document/(\d+)", path)
        if m and "ieee" in u.netloc:
            add(f"{u.scheme}://{u.netloc}/stamp/stamp.jsp?tp=&arnumber={m.group(1)}")

        links = await page.eval_on_selector_all(
            "a[href]", "els => els.map(e => [e.getAttribute('href'), (e.innerText||e.title||e.getAttribute('aria-label')||'').trim().slice(0,60)])")
        scored = []
        for href, text in links:
            if not href or href.startswith(("javascript:", "mailto:", "#")):
                continue
            s = (2 if PDF_HREF.search(href) else 0) + (2 if PDF_TEXT.search(text or "") else 0)
            if re.search(r"supplement|suppl|appendix|esm|figure|citation|\.ris|bibtex", href + " " + text, re.I):
                s -= 3
            if s > 0:
                scored.append((s, href))
        for _, href in sorted(scored, key=lambda x: -x[0])[:6]:
            add(href)
        return found

    async def _try_request(self, url: str, depth: int = 0) -> bytes | None:
        """Direct GET with the browser's cookies; follows HTML wrappers (iframes, meta-refresh)."""
        try:
            r = await self.ctx.request.get(url, timeout=90000, max_redirects=20,
                                           headers={"Accept": "application/pdf,text/html;q=0.9,*/*;q=0.8"})
            body = await r.body()
        except Exception:
            return None
        if is_pdf(body):
            return body
        if depth < 2 and b"<" in body[:2000]:
            html = body.decode("utf-8", "ignore")
            for m in re.finditer(r'(?:<iframe|<embed|<object)[^>]+(?:src|data)="([^"]+)"|http-equiv="refresh"[^>]+url=([^"\'> ]+)|(?:window\.location(?:\.href)?|location\.replace\()\s*=?\s*["\']([^"\']+\.pdf[^"\']*|[^"\']*pdf[^"\']*)["\']', html, re.I):
                nxt = next(g for g in m.groups() if g)
                data = await self._try_request(urljoin(r.url, nxt.replace("&amp;", "&")), depth + 1)
                if data:
                    return data
        return None

    async def _try_navigate(self, ctx: BrowserContext, url: str) -> bytes | None:
        """Loads the URL in a real tab and captures a PDF response or download (handles JS redirects)."""
        page = await ctx.new_page()
        got: asyncio.Future = asyncio.get_running_loop().create_future()

        async def on_response(resp):
            try:
                if "pdf" in (resp.headers.get("content-type") or "").lower() and not got.done():
                    body = b"" if resp.status == 206 else await resp.body()
                    if not is_pdf(body):
                        # Chrome's viewer loads PDFs in byte ranges; refetch the whole file with the same cookies.
                        body = await (await ctx.request.get(resp.url, timeout=90000)).body()
                    if is_pdf(body) and not got.done():
                        got.set_result(body)
            except Exception:
                pass

        async def on_download(dl):
            try:
                path = await dl.path()
                data = open(path, "rb").read() if path else b""
                if is_pdf(data) and not got.done():
                    got.set_result(data)
            except Exception:
                pass

        page.on("response", lambda r: asyncio.ensure_future(on_response(r)))
        page.on("download", lambda d: asyncio.ensure_future(on_download(d)))
        try:
            try:
                await page.goto(url, wait_until="commit", timeout=60000)
            except Exception:
                pass  # navigation that turns into a download raises; that's fine
            try:
                return await asyncio.wait_for(got, timeout=40)
            except asyncio.TimeoutError:
                return None
        finally:
            await page.close()

    @staticmethod
    async def polite_pause():
        s = load_settings()
        await asyncio.sleep(random.uniform(float(s["delay_min"]), float(max(s["delay_max"], s["delay_min"]))))


nus = NUSSession()
