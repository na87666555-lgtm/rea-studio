"""Read bounded public web resources with DNS pinning or a restricted publisher proxy."""
import base64
import http.client
import ipaddress
import json
import re
import socket
import ssl
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener, getproxies
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit

USER_AGENT = "ReaStudioBot"
DEADLINE = 9
MAX_BODY = 1024 * 1024
REDIRECTS = {301, 302, 303, 307, 308}
GLOBAL_V6 = ipaddress.ip_network("2000::/3")
PUBLISHERS = {
    "docs.python.org", "en.wikipedia.org", "hi.wikipedia.org", "api.crossref.org",
    "openlibrary.org", "developer.mozilla.org", "threejs.org", "docs.blender.org",
}
HEADERS = {"User-Agent": USER_AGENT + "/1.0", "Accept-Encoding": "identity", "Connection": "close"}


def _parts(url):
    if not isinstance(url, str) or len(url) > 8192 or re.search(r"[\x00-\x20\x7f\\]", url):
        raise ValueError("Invalid URL")
    parts = urlsplit(url)
    port = {"http": 80, "https": 443}.get(parts.scheme)
    if not port or not parts.hostname or parts.username is not None or parts.password is not None:
        raise ValueError("Public HTTP or HTTPS URL required")
    if parts.port not in (None, port) or "%" in parts.netloc:
        raise ValueError("Unsupported public address")
    host = parts.hostname.encode("idna").decode("ascii").lower().rstrip(".")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if ("." not in host or host.endswith((".local", ".localhost", ".internal", ".home.arpa", ".onion"))
                or len(host) > 253 or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                                               for label in host.split("."))):
            raise ValueError("Public hostname required")
    authority = "[" + host + "]" if ":" in host else host
    path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
    query = quote(parts.query, safe="/?%:@!$&'()*+,;=-._~")
    canonical = urlunsplit((parts.scheme, authority, path, query, ""))
    return canonical, host, port


def _public(address):
    ip = ipaddress.ip_address(address)
    if not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_loopback or ip.is_link_local:
        return False
    if ip.version == 6:
        return ip in GLOBAL_V6 and ip.sixtofour is None and ip.teredo is None and ip.ipv4_mapped is None
    return True


def _addresses(host, port):
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
    if not addresses or any(
        family not in (socket.AF_INET, socket.AF_INET6) or not _public(address[0])
        or (family == socket.AF_INET6 and address[3] != 0)
        for family, _, _, _, address in addresses
    ):
        raise ValueError("Source does not resolve exclusively to public addresses")
    return addresses


def _response(response, limit):
    status = response.status
    location = response.headers.get("Location")
    mime = response.headers.get("Content-Type", "")
    if status != 200:
        return status, location, mime, b""
    if response.headers.get("Content-Encoding", "identity").lower() != "identity":
        raise ValueError("Unsupported content encoding")
    length = response.headers.get("Content-Length")
    if length and (not length.isdecimal() or int(length) > limit):
        raise ValueError("Public resource exceeds size limit")
    body = response.read(limit + 1)
    if len(body) > limit:
        raise ValueError("Public resource exceeds size limit")
    return status, location, mime, body


def _publisher(url):
    parts = urlsplit(_parts(url)[0])
    return parts.scheme == "https" and parts.netloc in PUBLISHERS


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def _publisher_request(url, limit):
    if not _publisher(url):
        raise ValueError("Publisher origin is not allowed")
    proxy = getproxies().get("https")
    if not proxy:
        raise OSError("Publisher proxy unavailable")
    opener = build_opener(ProxyHandler({"https": proxy}), _NoRedirect())
    try:
        response = opener.open(Request(url, headers=HEADERS), timeout=4)
    except HTTPError as error:
        response = error  # The outer traversal checks redirects and robots itself.
    with response:
        return _response(response, limit)


def _request(url, limit):
    canonical, host, port = _parts(url)
    parts = urlsplit(canonical)
    addresses = _addresses(host, port)
    # Connect to the validated sockaddr, while keeping the original host for SNI
    # and certificate validation. No second hostname resolution occurs.
    last_error = None
    for family, kind, protocol, _, address in addresses[:3]:
        sock = socket.socket(family, kind, protocol)
        try:
            sock.settimeout(3)
            sock.connect(address)
            if parts.scheme == "https":
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
            with http.client.HTTPConnection(host, port, timeout=3) as connection:
                connection.sock = sock
                target = parts.path + ("?" + parts.query if parts.query else "")
                connection.request("GET", target, headers={**HEADERS, "Host": parts.netloc})
                with connection.getresponse() as response:
                    return _response(response, limit)
        except (OSError, http.client.HTTPException) as exc:
            last_error = exc
        finally:
            sock.close()
    raise OSError("Source did not respond") from last_error


def _rule_value(value):
    # RFC 9309 matches unreserved escapes and literal UTF-8 characters equally.
    return re.sub(r"%[0-9A-Fa-f]{2}", lambda m: (
        unquote(m[0]) if re.fullmatch(r"[A-Za-z0-9._~-]", unquote(m[0])) else m[0].upper()
    ), quote(value, safe="/%?:@!$&'()*+,;=-._~"))


def _allowed(text, path):
    groups = []
    agents, rules = [], []
    for line in text.splitlines():
        key, sep, raw = line.partition("#")[0].partition(":")
        if not sep:
            continue
        key, raw = key.strip().lower(), raw.strip()
        if key == "user-agent":
            if rules:
                groups.append((agents, rules))
                agents, rules = [], []
            agents.append(raw.lower())
        elif key in ("allow", "disallow") and agents:
            rules.append((key, raw))
    groups.append((agents, rules))
    specific = [rules for agents, rules in groups if USER_AGENT.lower() in agents]
    active = specific or [rules for agents, rules in groups if "*" in agents]
    path = _rule_value(path)
    best = (-1, True)
    for rules in active:
        for key, raw in rules:
            if not raw or not raw.startswith("/"):
                continue
            pattern = _rule_value(raw)
            anchored = pattern.endswith("$")
            core = pattern[:-1] if anchored else pattern
            # Ordered substring matching avoids regex backtracking on remote rules.
            chunks = core.split("*")
            if not path.startswith(chunks[0]):
                continue
            offset = len(chunks[0])
            if anchored and len(chunks) == 1 and offset != len(path):
                continue
            for index, chunk in enumerate(chunks[1:], 1):
                if anchored and index == len(chunks) - 1:
                    if not path.endswith(chunk) or len(path) - len(chunk) < offset:
                        break
                else:
                    found = path.find(chunk, offset)
                    if found < 0:
                        break
                    offset = found + len(chunk)
            else:
                best = max(best, (len(core.replace("*", "")), key == "allow"))
    return best[1]


def _redirect(url, location):
    target = _parts(urljoin(url, location))[0]
    if _publisher(url) and not _publisher(target):
        raise ValueError("Publisher redirect leaves the approved origins")
    return target


def _check_robots(url, request):
    parts = urlsplit(url)
    current = urlunsplit((parts.scheme, parts.netloc, "/robots.txt", "", ""))
    for _ in range(5):
        status, location, _, body = request(current, 512000)
        if status in REDIRECTS and location:
            current = _redirect(current, location)
            continue
        if status in (404, 410):
            return
        path = parts.path + ("?" + parts.query if parts.query else "")
        if status == 200 and _allowed(body.decode("utf-8-sig", "replace"), path):
            return
        break
    raise ValueError("Website crawling policy does not permit this request")


def _fetch(url, html, request):
    current = _parts(url)[0]
    for _ in range(5):
        if html:
            _check_robots(current, request)
        status, location, mime, data = request(current, MAX_BODY)
        if status in REDIRECTS and location:
            current = _redirect(current, location)
            continue
        if status != 200:
            raise ValueError("Public source returned HTTP " + str(status))
        return current, data, mime
    raise ValueError("Too many redirects")


def _run(url, html, proxy, timeout):
    result = subprocess.run(
        [sys.executable, "-I", str(Path(__file__).resolve())],
        input=json.dumps([url, html, proxy]), text=True, encoding="utf-8",
        capture_output=True, timeout=timeout, check=True,
    )
    reply = json.loads(result.stdout)
    if "error" in reply:
        if reply.get("network"):
            raise OSError("Public source did not respond")
        raise ValueError(reply["error"])
    return reply["url"], base64.b64decode(reply["data"]), reply["mime"]


def fetch(url, *, html=True):
    """Return final URL, body and Content-Type. html=True also checks robots.txt."""
    canonical = _parts(url)[0]
    proxy_available = _publisher(canonical) and bool(getproxies().get("https"))
    deadline = time.monotonic() + DEADLINE
    # The worker deadline also covers DNS and slowly trickling HTTP headers.
    try:
        return _run(canonical, html, False, 1.5 if proxy_available else DEADLINE)
    except (OSError, subprocess.SubprocessError) as exc:
        if not proxy_available:
            raise OSError("Public source unavailable or timed out") from exc
    try:
        return _run(canonical, html, True, max(0.01, deadline - time.monotonic()))
    except (OSError, subprocess.SubprocessError) as exc:
        raise OSError("Public publisher unavailable or timed out") from exc


if __name__ == "__main__":
    try:
        url, html, proxy = json.load(sys.stdin)
        final_url, data, mime = _fetch(url, html, _publisher_request if proxy else _request)
        print(json.dumps({"url": final_url, "data": base64.b64encode(data).decode("ascii"), "mime": mime}))
    except ValueError as error:
        print(json.dumps({"error": str(error)}))
    except (OSError, http.client.HTTPException):
        print(json.dumps({"error": "Public source unavailable", "network": True}))
