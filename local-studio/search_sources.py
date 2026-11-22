"""Look up candidate public URLs; retrieval and DNS validation are separate."""

from html.parser import HTMLParser
import ipaddress
import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request
from urllib.robotparser import RobotFileParser


AGENT = "ReaStudio/1.0 (+https://github.com/nm9536237-ship-it/rea-studio)"
DDG = "https://html.duckduckgo.com"
BRAVE = "https://api.search.brave.com/res/v1/web/search"


class SearchError(RuntimeError):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _download(url, *, accept, headers=None, limit=512 * 1024, timeout=8):
    request = Request(url, headers={"User-Agent": AGENT, "Accept": accept, **(headers or {})})
    with build_opener(_NoRedirect()).open(request, timeout=timeout) as response:
        if response.status != 200:
            raise SearchError("खोज सेवा ने परिणाम उपलब्ध नहीं कराए।")
        body = response.read(limit + 1)
        if len(body) > limit:
            raise SearchError("खोज सेवा का जवाब पढ़ने की सीमा से बड़ा है।")
        return body.decode("utf-8", errors="replace")


def _allow_search(url):
    try:
        rules = _download(DDG + "/robots.txt", accept="text/plain", limit=512 * 1024)
    except HTTPError as exc:
        if exc.code in (404, 410):
            return True
        raise
    parser = RobotFileParser()
    parser.parse(rules.splitlines())
    return parser.can_fetch("ReaStudio", url)


class _DuckResults(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []
        self.empty = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = (attrs.get("class") or "").split()
        if "no-results" in classes or "result--no-result" in classes:
            self.empty = True
        if tag != "a" or "result__a" not in classes or not attrs.get("href"):
            return
        try:
            url = urljoin(DDG + "/", attrs["href"])
            parts = urlsplit(url)
            if parts.hostname in ("duckduckgo.com", "html.duckduckgo.com") and parts.path == "/l/":
                url = parse_qs(parts.query, max_num_fields=24).get("uddg", [""])[0]
            self.urls.append(url)
        except ValueError:
            return


def _candidates(urls, limit):
    distinct, other = [], []
    seen = set()
    hosts = set()
    for url in urls:
        if not isinstance(url, str) or len(url) > 4096 or "\\" in url or any(
                c.isspace() or ord(c) < 32 for c in url):
            continue
        try:
            p = urlsplit(url)
            host = (p.hostname or "").rstrip(".").lower()
            if (p.scheme not in ("https", "http") or p.username is not None or p.password is not None
                    or p.port not in (None, 80, 443) or "." not in host or host.endswith(
                        (".local", ".localhost", ".internal", ".test", ".invalid", ".onion"))):
                continue
            try:
                ip = ipaddress.ip_address(host)
                if not ip.is_global or ip.is_multicast:
                    continue
            except ValueError:
                if all(c in "0123456789." for c in host):
                    continue
            cleaned = urlunsplit((p.scheme, p.netloc, p.path or "/", p.query, ""))
        except ValueError:
            continue
        if cleaned in seen:
            continue
        seen.add(cleaned)
        (other if host in hosts else distinct).append(cleaned)
        hosts.add(host)
    return (distinct + other)[:limit]


def search_sources(query, *, limit=5):
    """Use the Brave API if configured, otherwise the robots-permitted DDG HTML search."""
    if not isinstance(query, str) or not query.strip():
        raise ValueError("खोज के लिए विषय लिखें।")
    if type(limit) is not int or not 1 <= limit <= 10:
        raise ValueError("खोज परिणामों की सीमा 1 से 10 के बीच रखें।")
    query = query.strip()[:400]
    key = os.environ.get("BRAVE_SEARCH_API_KEY", "").strip()
    try:
        if key:
            url = BRAVE + "?" + urlencode({"q": query, "count": min(20, limit * 2)})
            raw = _download(url, accept="application/json", headers={"X-Subscription-Token": key})
            entries = json.loads(raw).get("web", {}).get("results", [])
            return _candidates((r.get("url") for r in entries if isinstance(r, dict)), limit)
        url = DDG + "/html/?" + urlencode({"q": query})
        if not _allow_search(url):
            raise SearchError("इस खोज सेवा के robots नियम इस अनुरोध की अनुमति नहीं देते।")
        page = _DuckResults()
        page.feed(_download(url, accept="text/html"))
        page.close()
        if not page.urls and not page.empty:
            raise SearchError("खोज सेवा ने पढ़ने योग्य परिणाम नहीं दिए।")
        return _candidates(page.urls, limit)
    except HTTPError as exc:
        raise SearchError(f"खोज सेवा उपलब्ध नहीं है (HTTP {exc.code})।") from exc
    except (URLError, OSError, ValueError, AttributeError, TypeError) as exc:
        raise SearchError("वेब खोज पूरी नहीं हो सकी। खोज सेवा या नेटवर्क की जाँच करें।") from exc
