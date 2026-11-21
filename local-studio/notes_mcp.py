"""Rea's bundled single-note MCP server. Its transport is JSON-RPC over stdio."""

import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile


VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
MAX_CHARS = 16000
MAX_LINE = 2 * 1024 * 1024
DEFAULT_PATH = Path.home() / ".local" / "share" / "rea-studio" / "note.txt"
NOTE = Path(os.environ.get("REA_NOTES_FILE") or DEFAULT_PATH).expanduser()
TEXT_SCHEMA = {"type": "string", "maxLength": MAX_CHARS}
TOOLS = [
    {"name": "note.read", "description": "Rea का साझा नोट और उसका मौजूदा संस्करण पढ़ें।",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "note.write", "description": "Rea का साझा नोट सहेजें। revision देने पर बीच में हुए बदलाव सुरक्षित रहते हैं।",
     "inputSchema": {"type": "object", "required": ["text"], "additionalProperties": False,
                     "properties": {"text": TEXT_SCHEMA, "revision": {"type": "string"}}}},
]


def snapshot():
    try:
        with NOTE.open("rb") as stream:
            raw = stream.read(MAX_CHARS * 4 + 1)
    except FileNotFoundError:
        raw = b""
    if len(raw) > MAX_CHARS * 4:
        raise ValueError("सहेजा हुआ नोट आकार सीमा से बड़ा है।")
    text = raw.decode("utf-8")
    if len(text) > MAX_CHARS:
        raise ValueError("सहेजा हुआ नोट आकार सीमा से बड़ा है।")
    return {"text": text, "revision": hashlib.sha256(raw).hexdigest()}


def save_note(text, revision):
    if not isinstance(text, str) or len(text) > MAX_CHARS:
        raise ValueError("एक नोट में अधिकतम 16000 अक्षर लिखें।")
    if revision is not None and not isinstance(revision, str):
        raise ValueError("revision का मान टेक्स्ट होना चाहिए।")
    raw = text.encode("utf-8")
    NOTE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = NOTE.with_name(NOTE.name + ".lock")
    with lock_path.open("ab") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if revision is not None and revision != snapshot()["revision"]:
            raise ValueError("नोट बदल गया है। नया संस्करण पढ़कर फिर सहेजें।")
        temp_name = None
        try:
            with tempfile.NamedTemporaryFile(dir=NOTE.parent, delete=False) as out:
                temp_name = out.name
                out.write(raw)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp_name, NOTE)
        finally:
            if temp_name:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(temp_name)
        return {"text": text, "revision": hashlib.sha256(raw).hexdigest()}


def use_tool(params):
    name = params.get("name")
    args = params.get("arguments", {})
    if not isinstance(args, dict):
        raise ValueError("आर्गुमेंट में JSON ऑब्जेक्ट दें।")
    if name == "note.read" and not args:
        info = snapshot()
    elif name == "note.write" and "text" in args and not args.keys() - {"text", "revision"}:
        info = save_note(args["text"], args.get("revision"))
    else:
        raise ValueError("टूल के नाम और आर्गुमेंट की जाँच करें।")
    return {"content": [{"type": "text", "text": info["text"]}], "structuredContent": info}


def respond(ident, *, result=None, code=None, message=None):
    reply = {"jsonrpc": "2.0", "id": ident}
    if code is None:
        reply["result"] = result
    else:
        reply["error"] = {"code": code, "message": message}
    print(json.dumps(reply, separators=(",", ":"), ensure_ascii=True), flush=True)


def main():
    initialized = ready = False
    while raw := sys.stdin.buffer.readline(MAX_LINE + 1):
        if len(raw) > MAX_LINE:
            break
        try:
            req = json.loads(raw)
        except (ValueError, RecursionError):
            respond(None, code=-32700, message="Parse error")
            continue
        if not isinstance(req, dict) or req.get("jsonrpc") != "2.0":
            respond(None, code=-32600, message="Invalid request")
            continue
        method = req.get("method")
        ident = req.get("id")
        params = req.get("params", {})
        if ident is None:
            if method == "notifications/initialized" and initialized:
                ready = True
            continue
        if not isinstance(params, dict):
            respond(ident, code=-32602, message="Invalid params")
        elif method == "initialize":
            requested = params.get("protocolVersion")
            version = requested if requested in VERSIONS else VERSIONS[0]
            respond(ident, result={"protocolVersion": version, "capabilities": {"tools": {}},
                                   "serverInfo": {"name": "rea-notes", "version": "1.0"}})
            initialized = True
        elif method == "ping":
            respond(ident, result={})
        elif not ready:
            respond(ident, code=-32000, message="Initialize first")
        elif method == "tools/list":
            respond(ident, result={"tools": TOOLS})
        elif method == "tools/call":
            try:
                result = use_tool(params)
            except (ValueError, OSError) as exc:
                detail = str(exc) if isinstance(exc, ValueError) else "नोट की फ़ाइल पढ़ी या सहेजी नहीं जा सकी।"
                result = {"isError": True, "content": [{"type": "text", "text": detail}]}
            respond(ident, result=result)
        else:
            respond(ident, code=-32601, message="Method not found")


if __name__ == "__main__":
    main()
