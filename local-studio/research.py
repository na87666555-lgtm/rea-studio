"""Read public sources for a question; never treat a search snippet as a source."""

import ipaddress
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
import re
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from urllib.parse import quote, urlencode, urlsplit

from public_fetch import fetch
from search_sources import SearchError, search_sources


_URL = re.compile(r"""https?://[^\s<>"'`।॥]+""", re.I)
_PUBLIC_LOOKUP = re.compile(
    r"\b(?:search|look up|fact.check|browse|research|sources?|citations?|verify|"
    r"published|according to|evidence|online|internet)\b|"
    r"स्रोत|खोज[ोें]?|ढूँ[ढढ़]|ढूं[ढढ़]|इंटरनेट|ऑनलाइन|तथ्य.जाँच|सत्यापित|शोध|संदर्भ", re.I
)
_INFORMATION = re.compile(
    r"\b(?:who|what|when|where|why|how|which|explain|compare|list|facts?|latest|"
    r"history|science|scientific|math(?:ematics)?|theorem|books?|art(?:ist)?|authors?|news|"
    r"current|forecast|dates?|definition|population|capital|weather|price|tell me about)\b|"
    r"क्या|कौन|कहाँ|कहां|कब|कैस[ेीा]|किस|कितन|क्यों|बताइए|बताएं|बताओ|जानकारी|"
    r"समझा|तुलना|विज्ञान|गणित|इतिहास|किताब|पुस्तक|लेखक|चित्रकार|कला|मौसम|समाचार|"
    r"ताज़ा|ताजा|कीमत|राजधानी|आबादी|तथ्य|सिद्धांत|सूत्र", re.I
)
_LOCAL_TASK = re.compile(
    r"\b(?:rewrite|rephrase|summari[sz]e|translate|edit|fix (?:my|this)|draft|"
    r"write (?:me |a |an |the )?|create|compose|draw|my|mine|myself|password|"
    r"secret|api.?key|access.?token)\b|"
    r"मेरे|मेरा|मेरी|मुझ[ेको]|पासवर्ड|गोपनीय|एपीआई की|अनुवाद|सारांश|संपादित|"
    r"सुधारो|ठीक करो|लिखो|लिखिए|बनाओ|बनाइए|बनाएँ|बना दो", re.I
)
_SENSITIVE = re.compile(
    r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|"
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}"
)


def _links(prompt):
    links = []
    for match in _URL.finditer(prompt):
        url = match.group().rstrip(".,!?;:]}，、。")
        while url.endswith(")") and url.count("(") < url.count(")"):
            url = url[:-1]
        if len(url) <= 2048 and url not in links:
            links.append(url)
        if len(links) == 5:
            break
    return links


def _public_candidate(url):
    # DNS and the final peer address are checked by public_fetch on every hop.
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower().rstrip(".")
        if parts.scheme not in ("http", "https") or parts.username is not None:
            return False
        if parts.port not in (None, 443 if parts.scheme == "https" else 80):
            return False
        if not host or host.endswith((".local", ".localhost", ".internal", ".home.arpa", ".test", ".invalid")):
            return False
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            return "." in host and not re.fullmatch(r"[\d.xa-f]+", host, re.I)
        return ip.is_global and not ip.is_multicast
    except (ValueError, UnicodeError):
        return False


def should_research(prompt):
    if not isinstance(prompt, str) or not prompt.strip():
        return False
    if re.fullmatch(
        r"(?:hello|hi|hey|good (?:morning|afternoon|evening)|how are you|thanks|thank you|"
        r"नमस्ते|नमस्कार|हैलो|हेलो|कैसे हो|कैसे हैं|धन्यवाद)[\s!?.।]*", prompt.strip(), re.I
    ):
        return False
    if _URL.search(prompt):
        return any(_public_candidate(url) for url in _links(prompt))
    if len(prompt) > 1000 or "```" in prompt or _SENSITIVE.search(prompt):
        return False
    if _PUBLIC_LOOKUP.search(prompt):
        return True
    if _LOCAL_TASK.search(prompt):
        return False
    return bool(_INFORMATION.search(prompt))


class _Page(HTMLParser):
    ignore = {"script", "style", "noscript", "nav", "footer", "header", "form", "svg", "template", "aside"}
    blocks = {"p", "div", "li", "h1", "h2", "h3", "h4", "section", "article", "br", "tr", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = []
        self.in_title = False
        self.in_head = False
        self.ignored = []
        self.rows = []
        self.row = []

    def flush(self):
        line = " ".join("".join(self.row).split())
        if line:
            self.rows.append(line)
        self.row.clear()

    def handle_starttag(self, tag, attrs):
        if tag in self.ignore:
            self.ignored.append(tag)
        if self.ignored:
            return
        if tag == "title":
            self.in_title = True
        elif tag == "head":
            self.in_head = True
        elif tag in self.blocks:
            self.flush()

    def handle_endtag(self, tag):
        if self.ignored:
            if tag == self.ignored[-1]:
                self.ignored.pop()
            return
        if tag == "title":
            self.in_title = False
        elif tag == "head":
            self.in_head = False
        elif tag in self.blocks:
            self.flush()

    def handle_data(self, data):
        if self.ignored:
            return
        if self.in_title:
            self.title.append(data)
        elif not self.in_head:
            self.row.append(data)


def _excerpt(rows, prompt):
    # Rank paragraphs by query overlap, then restore their original reading order.
    words = set(re.findall(r"[\w\u0900-\u097f]{3,}", _URL.sub(" ", prompt.lower())))
    eligible = [(i, row) for i, row in enumerate(rows) if len(row) >= 25]
    if not eligible:
        eligible = list(enumerate(rows))
    def rank(item):
        index, row = item
        tokens = set(re.findall(r"[\w\u0900-\u097f]{3,}", row[:3500].lower()))
        return -len(words & tokens), index
    selected, used = [], 0
    for index, row in sorted(eligible, key=rank):
        part = row[:min(1000, 2200 - used)]
        selected.append((index, part))
        used += len(part) + 1
        if used >= 2100 or len(selected) == 5:
            break
    return "\n".join(row for _, row in sorted(selected))


def _pdf_rows(payload):
    binary = shutil.which("pdftotext")
    if not binary or not payload.startswith(b"%PDF-"):
        return []
    # Limit CPU, memory and file growth in the parser process, not the web server.
    limits = (
        "import os,resource,sys;"
        "resource.setrlimit(resource.RLIMIT_AS,(268435456,268435456));"
        "resource.setrlimit(resource.RLIMIT_CPU,(3,3));"
        "resource.setrlimit(resource.RLIMIT_FSIZE,(1048576,1048576));"
        "os.execv(sys.argv[1],sys.argv[1:])"
    )
    with tempfile.TemporaryDirectory() as temp:
        output = Path(temp) / "pages.txt"
        try:
            subprocess.run(
                [sys.executable, "-I", "-c", limits, binary, "-f", "1", "-l", "6",
                 "-enc", "UTF-8", "-", str(output)],
                input=payload, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=True, timeout=5, cwd=temp,
            )
            return [line.strip() for line in output.read_text(encoding="utf-8").splitlines() if line.strip()]
        except (OSError, subprocess.SubprocessError, UnicodeError):
            return []


def _read(url, prompt):
    try:
        final, payload, content_type = fetch(url)
        mime = content_type.partition(";")[0].lower().strip()
        if mime == "application/pdf":
            rows = _pdf_rows(payload)
            text = _excerpt(rows, prompt)
            if len(text) >= 25:
                return {"url": final, "title": (rows[0] if rows else "PDF")[:180], "text": text}
            return None
        charset = re.search(r"charset\s*=\s*[\"']?([a-z0-9_.-]+)", content_type, re.I)
        encoding = charset.group(1) if charset else "utf-8-sig"
        try:
            body = payload.decode(encoding, errors="replace")
        except (ValueError, LookupError):
            body = payload.decode("utf-8-sig", errors="replace")
        if mime in {"text/html", "application/xhtml+xml"}:
            page = _Page()
            page.feed(body)
            page.close()
            page.flush()
            title = " ".join("".join(page.title).split())
            rows = page.rows
        elif mime in {"text/plain", "text/markdown"}:
            title = ""
            rows = [r.strip() for r in body.splitlines() if r.strip()]
        else:
            return None
        text = _excerpt(rows, prompt)
        if len(text) < 25:
            return None
        return {"title": (title or (urlsplit(final).hostname or final))[:180],
                "url": final, "text": text}
    except (ValueError, OSError, UnicodeError, AssertionError):
        # HTMLParser can raise AssertionError for malformed declarations.
        return None


def _official_json(base, params):
    _, payload, _ = fetch(base + "?" + urlencode(params), html=False)
    return json.loads(payload)


def _topic(prompt):
    cleaned = re.sub(
        r"\b(?:please|what|is|are|who|tell|me|about|explain|the|how|does|work)\b|"
        r"(?:के बारे में|क्या है|कौन है|कौन थे|बताओ|बताइए|समझाइए|समझाएं|जानकारी दें)",
        " ", prompt, flags=re.I
    )
    return (" ".join(cleaned.strip(" ?।.").split()) or prompt.strip())[:250]


def _encyclopedia(topic):
    lang = "hi" if re.search(r"[\u0900-\u097f]", topic) else "en"
    base = f"https://{lang}.wikipedia.org"
    data = _official_json(base + "/w/api.php", {
        "action": "query", "format": "json", "generator": "search", "gsrsearch": topic,
        "gsrlimit": "2", "prop": "extracts", "exintro": "1", "explaintext": "1",
        "exlimit": "2", "exchars": "1900",
    })
    records = []
    pages = data.get("query", {}).get("pages", {}).values()
    for page in sorted(pages, key=lambda item: item.get("index", 0)):
        title = page.get("title", "")
        text = page.get("extract", "").strip()
        if title and len(text) >= 25:
            path = quote(title.replace(" ", "_"), safe="")
            records.append({"title": title[:180], "text": text[:2000], "url": base + "/wiki/" + path})
    return records


def _papers(topic):
    data = _official_json("https://api.crossref.org/works", {
        "query.bibliographic": topic, "rows": "2", "filter": "has-abstract:true",
        "select": "title,abstract,DOI",
    })
    records = []
    for item in data.get("message", {}).get("items", []):
        doi = item.get("DOI", "")
        if not item.get("title") or not doi.startswith("10."):
            continue
        page = _Page()
        page.feed(item.get("abstract", ""))
        page.close()
        page.flush()
        text = " ".join(page.rows)
        if len(text) >= 25:
            records.append({"title": item["title"][0][:180], "text": text[:2000],
                            "url": "https://doi.org/" + quote(doi, safe="/")})
    return records


def _books(topic):
    data = _official_json("https://openlibrary.org/search.json", {
        "q": topic, "limit": "2", "fields": "key,title,author_name,first_publish_year",
    })
    records = []
    for book in data.get("docs", []):
        key, title = book.get("key", ""), book.get("title", "")
        if title and re.fullmatch(r"/works/OL[0-9]+W", key):
            fields = [title]
            if book.get("author_name"):
                fields.append("लेखक • " + ", ".join(book["author_name"][:3]))
            if book.get("first_publish_year"):
                fields.append("पहला प्रकाशन • " + str(book["first_publish_year"]))
            if len(fields) > 1:
                records.append({"title": title[:180], "text": "\n".join(fields)[:2000],
                                "url": "https://openlibrary.org" + key})
    return records


def _official_records(prompt):
    topic = _topic(prompt)
    lookups = [_encyclopedia]
    if re.search(r"पुस्तक|किताब|उपन्यास|लेखक|\b(book|novel|author)s?\b", prompt, re.I):
        lookups.insert(0, _books)
    if re.search(r"विज्ञान|अध्ययन|शोध|चिकित्सा|\b(scientific|research|papers?|studies|clinical|science)\b", prompt, re.I):
        lookups.insert(0, _papers)
    records = []
    with ThreadPoolExecutor(max_workers=len(lookups)) as pool:
        jobs = [pool.submit(lookup, topic) for lookup in lookups]
        for job in jobs:
            try:
                records.extend(job.result())
            except (ValueError, TypeError, AttributeError, KeyError, OSError, AssertionError):
                continue
    return records[:3]


def research(prompt, progress=None):
    """Return up to three fetched source excerpts, with actual final-page URLs."""
    if not should_research(prompt):
        return []
    urls = [url for url in _links(prompt) if _public_candidate(url)]
    if not urls:
        if progress:
            progress("सार्वजनिक वेब पर स्रोत खोजे जा रहे हैं।")
        try:
            urls = [u for u in search_sources(prompt, limit=5) if _public_candidate(u)]
        except (SearchError, ValueError, OSError):
            urls = []
    if progress and urls:
        progress("स्रोतों के मूल पन्ने पढ़े जा रहे हैं।")
    results = []
    seen = set()
    if urls:
        with ThreadPoolExecutor(max_workers=5) as pool:
            for source in pool.map(lambda url: _read(url, prompt), urls[:5]):
                if source and source["url"] not in seen and len(results) < 3:
                    results.append(source)
                    seen.add(source["url"])
    if not results and not _URL.search(prompt):
        if progress:
            progress("विषय के प्रकाशित संदर्भ और अभिलेख पढ़े जा रहे हैं।")
        results = _official_records(prompt)
    if progress:
        progress(f"{len(results)} सार्वजनिक स्रोत पढ़े गए।" if results else "पढ़ने योग्य सार्वजनिक स्रोत नहीं मिला।")
    return results
