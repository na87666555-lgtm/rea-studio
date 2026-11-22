"""A shared stdio MCP session for a single-user Rea workspace (Linux/Termux)."""

import atexit
import contextlib
import json
import os
import select
import signal
import subprocess
import sys
from pathlib import Path
import threading
import time


class MCPError(RuntimeError):
    pass


MAX_MESSAGE = 2 * 1024 * 1024
VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")


def is_configured():
    return bool(os.environ.get("REA_MCP_COMMAND", "").strip()) or Path(__file__).with_name("notes_mcp.py").is_file()


def _config():
    configured = os.environ.get("REA_MCP_COMMAND", "").strip()
    try:
        argv = json.loads(configured) if configured else [
            sys.executable, str(Path(__file__).resolve().with_name("notes_mcp.py"))
        ]
        extra_env = json.loads(os.environ.get("REA_MCP_ENV", "{}"))
    except ValueError as exc:
        raise MCPError("MCP कॉन्फ़िगरेशन में मान्य JSON दें।") from exc
    if not isinstance(argv, list) or not argv or not all(isinstance(v, str) for v in argv):
        raise MCPError("REA_MCP_COMMAND में कमांड और उसके आर्गुमेंट की JSON सूची दें।")
    if not isinstance(extra_env, dict) or not all(isinstance(v, str) for v in extra_env.values()):
        raise MCPError("REA_MCP_ENV में नाम और मान की JSON ऑब्जेक्ट दें।")
    keys = ("HOME", "PATH", "TMPDIR", "USER", "LANG", "LANGUAGE", "LC_ALL", "PREFIX",
            "SYSTEMROOT", "APPDATA", "LD_LIBRARY_PATH", "ANDROID_ROOT", "ANDROID_DATA")
    env = {k: os.environ[k] for k in keys if k in os.environ}
    if not configured and os.environ.get("REA_NOTES_FILE"):
        env["REA_NOTES_FILE"] = os.environ["REA_NOTES_FILE"]
    env.update(extra_env)
    return argv, env


def _wait(fd, deadline, *, writing=False):
    remaining = deadline - time.monotonic()
    if remaining > 0:
        readable, writable, _ = select.select([] if writing else [fd],
                                               [fd] if writing else [], [], remaining)
        if readable or writable:
            return
    raise MCPError("MCP सर्वर ने समय पर जवाब नहीं दिया।")


class _Session:
    def __init__(self, argv, env):
        self.process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, env=env, bufsize=0,
                                        start_new_session=True)
        self.reader = self.process.stdout.fileno()
        self.writer = self.process.stdin.fileno()
        os.set_blocking(self.reader, False)
        os.set_blocking(self.writer, False)
        self.buffer = bytearray()
        self.request_id = 0

    def close(self):
        with contextlib.suppress(ProcessLookupError):
            os.killpg(self.process.pid, signal.SIGKILL)
        self.process.stdin.close()
        self.process.stdout.close()
        self.process.wait(timeout=2)

    def send(self, body, deadline):
        body["jsonrpc"] = "2.0"
        data = memoryview((json.dumps(body, separators=(",", ":"), ensure_ascii=False,
                                      allow_nan=False) + "\n").encode("utf-8"))
        if len(data) > MAX_MESSAGE:
            raise MCPError("MCP अनुरोध बहुत बड़ा है।")
        while data:
            _wait(self.writer, deadline, writing=True)
            data = data[os.write(self.writer, data):]

    def receive(self, deadline):
        while True:
            if time.monotonic() >= deadline:
                raise MCPError("MCP सर्वर ने समय पर जवाब नहीं दिया।")
            end = self.buffer.find(b"\n")
            if end > MAX_MESSAGE or (end == -1 and len(self.buffer) >= MAX_MESSAGE):
                raise MCPError("MCP सर्वर का जवाब बहुत बड़ा है।")
            if end >= 0:
                msg = json.loads(self.buffer[:end])
                del self.buffer[:end + 1]
                if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
                    raise MCPError("MCP सर्वर से अमान्य JSON-RPC जवाब मिला।")
                return msg
            _wait(self.reader, deadline)
            chunk = os.read(self.reader, 65536)
            if not chunk:
                raise MCPError("MCP सर्वर से कनेक्शन बंद हो गया।")
            self.buffer.extend(chunk)

    def request(self, method, params, deadline):
        self.request_id += 1
        self.send({"id": self.request_id, "method": method, "params": params}, deadline)
        while True:
            msg = self.receive(deadline)
            if "method" in msg:
                if "id" in msg:
                    reply = {"id": msg["id"]}
                    if msg["method"] == "ping":
                        reply["result"] = {}
                    else:
                        reply["error"] = {"code": -32601, "message": "Unsupported method"}
                    self.send(reply, deadline)
                continue
            if msg.get("id") != self.request_id:
                raise MCPError("MCP सर्वर ने दूसरे अनुरोध का जवाब दिया।")
            if "error" in msg:
                error = msg["error"]
                detail = error.get("message") if isinstance(error, dict) else ""
                raise MCPError("MCP सर्वर की त्रुटि: " + str(detail or method)[:500])
            result = msg.get("result")
            if not isinstance(result, dict):
                raise MCPError("MCP सर्वर से अमान्य परिणाम मिला।")
            return result

    def initialize(self, deadline):
        info = self.request("initialize", {"protocolVersion": VERSIONS[0], "capabilities": {},
                            "clientInfo": {"name": "rea-studio", "version": "1.0"}}, deadline)
        if info.get("protocolVersion") not in VERSIONS:
            raise MCPError("इस MCP प्रोटोकॉल संस्करण का समर्थन उपलब्ध नहीं है।")
        capabilities = info.get("capabilities")
        if not isinstance(capabilities, dict) or "tools" not in capabilities:
            raise MCPError("यह MCP सर्वर टूल उपलब्ध नहीं कराता।")
        self.send({"method": "notifications/initialized"}, deadline)


_lock = threading.Lock()
_session = None


def _close():
    global _session
    if _session is not None:
        try:
            _session.close()
        finally:
            _session = None


atexit.register(_close)


@contextlib.contextmanager
def _connection():
    global _session
    if not _lock.acquire(timeout=2):
        raise MCPError("MCP सर्वर अभी दूसरे अनुरोध पर काम कर रहा है।")
    try:
        deadline = time.monotonic() + 45
        if _session is not None and _session.process.poll() is not None:
            _close()
        if _session is None:
            argv, env = _config()
            _session = _Session(argv, env)
            _session.initialize(deadline)
        yield _session, deadline
    except (ValueError, OSError, RecursionError) as exc:
        _close()
        raise MCPError("MCP सर्वर की कमांड, कनेक्शन या संदेश की जाँच करें।") from exc
    except MCPError:
        _close()
        raise
    finally:
        _lock.release()


def list_tools():
    """Connect if needed and return tool definitions across all supported pages."""
    with _connection() as (session, deadline):
        tools = []
        seen = set()
        params = {}
        total_bytes = 0
        while True:
            page = session.request("tools/list", params, deadline)
            entries = page.get("tools")
            if not isinstance(entries, list) or not all(
                    isinstance(entry, dict) and isinstance(entry.get("name"), str)
                    for entry in entries):
                raise MCPError("MCP सर्वर से अमान्य टूल सूची मिली।")
            tools.extend(entries)
            total_bytes += len(json.dumps(entries, ensure_ascii=False).encode())
            if len(tools) > 1000 or total_bytes > MAX_MESSAGE:
                raise MCPError("MCP सर्वर की टूल सूची बहुत बड़ी है।")
            cursor = page.get("nextCursor")
            if cursor is None:
                return tools
            if not isinstance(cursor, str) or cursor in seen or len(seen) >= 100:
                raise MCPError("MCP सर्वर ने अमान्य पेज पहचान भेजी।")
            seen.add(cursor)
            params = {"cursor": cursor}


def call_tool(name, arguments):
    """Issue one explicit tool call. Preserve MCP content and isError for the UI."""
    if not isinstance(name, str) or not name.strip() or len(name) > 256:
        raise ValueError("टूल का नाम दें।")
    if not isinstance(arguments, dict):
        raise ValueError("टूल के आर्गुमेंट JSON ऑब्जेक्ट में दें।")
    with _connection() as (session, deadline):
        return session.request("tools/call", {"name": name, "arguments": arguments}, deadline)
