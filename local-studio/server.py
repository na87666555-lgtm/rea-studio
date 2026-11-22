"""Run Rea Studio locally with python server.py."""
import argparse
import json
import os
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import mcp_client
import media_rooms
import models
import studio

STATIC = Path(__file__).resolve().parent / "static"
history = {}
jobs_lock = threading.Lock()


def begin_answer(prompt, note="", previous=None):
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 12000:
        raise ValueError("सवाल 1 से 12,000 अक्षरों में लिखें।")
    if not isinstance(note, str) or len(note) > 3200:
        raise ValueError("साझा नोट 3,200 अक्षरों तक रखें।")
    if previous is not None and not isinstance(previous, str):
        raise ValueError("सत्र का पता मान्य नहीं है।")
    with jobs_lock:
        prior = history.get(previous, {})
        context = list(prior.get("context", []))
        prior_result = prior.get("result", {})
        prior_text = prior_result.get("synthesis") or "\n".join(
            answer["text"] for answer in prior_result.get("answers", []))
        if prior_text:
            context.append({"question": prior["prompt"][:1500], "answer": prior_text[:2500]})
        context = context[-3:]
        if any(item["state"] == "running" for item in history.values()):
            raise RuntimeError("पहले से एक सवाल चल रहा है।")
        if len(history) >= 12:
            history.pop(next(iter(history)))
        job_id = secrets.token_hex(12)
        history[job_id] = {"state": "running", "events": ["सवाल प्राप्त हुआ।"], "prompt": prompt, "context": context}

    def progress(message, *details):
        with jobs_lock:
            history[job_id]["events"].append(str(message) + " ".join(map(str, details)))

    def run():
        try:
            import research
            sources = []
            if research.should_research(prompt):
                try:
                    sources = research.research(prompt, progress)
                except Exception:
                    progress("इंटरनेट खोज पूरी नहीं हो सकी।")
            with jobs_lock:
                history[job_id]["sources"] = sources
            result = models.generate(prompt, progress=progress, sources=sources, note=note, context=context)
            result["sources"] = sources
            update = {"state": "done", "result": result}
        except Exception:
            update = {"state": "failed", "error": "जवाब तैयार करने में समस्या हुई। सर्वर कॉन्फ़िगरेशन जाँचें।"}
        with jobs_lock:
            history[job_id].update(update)

    threading.Thread(target=run, daemon=True).start()
    return {"id": job_id}


def page(guest):
    html = (STATIC / "index.html").read_text()
    media = (STATIC / "media.html").read_text()
    if guest:
        return ('<!DOCTYPE html><html lang="hi"><meta charset="utf-8"><meta name="viewport" '
                'content="width=device-width,initial-scale=1"><title>Rea · वीडियो कॉल</title>'
                '<link rel="stylesheet" href="/static/style.css"><link rel="stylesheet" href="/static/media.css">'
                '<body data-guest><main><h1>Rea · वीडियो कॉल</h1>' + media +
                '</main><script defer src="/static/media.js"></script></body></html>').encode()
    return html.replace("<!--MEDIA-->", media).replace("<!--STUDIO-->", (STATIC / "studio.html").read_text()).encode()


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, data, mime="application/json", attachment=None):
        if mime == "application/json":
            data = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        if attachment:
            self.send_header("Content-Disposition", f'attachment; filename="{attachment}"')
        self.end_headers()
        self.wfile.write(data)

    def allowed(self, post=False):
        host = self.headers.get("Host", "")
        if not self.server.guest:
            port = self.server.server_port
            valid = {f"{name}:{port}" for name in ("localhost", "127.0.0.1")}
            if port == 80:
                valid.update(("localhost", "127.0.0.1"))
            if host not in valid or self.client_address[0] != "127.0.0.1":
                return False
        return not post or self.headers.get("Origin") in ("http://" + host, "https://" + host)

    def do_GET(self):
        path = urlsplit(self.path).path
        try:
            if not self.allowed():
                return self.reply(403, {"error": "स्थानीय पता आवश्यक है।"})
            if path == "/":
                return self.reply(200, page(self.server.guest), "text/html; charset=utf-8")
            if path.startswith("/static/"):
                asset = (STATIC / path[len("/static/"):]).resolve()
                if not asset.is_relative_to(STATIC) or not asset.is_file():
                    raise KeyError
                mimes = {".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
                         ".webmanifest": "application/manifest+json", ".png": "image/png"}
                if asset.suffix not in mimes:
                    raise KeyError
                return self.reply(200, asset.read_bytes(), mimes[asset.suffix])
            if self.server.guest:
                raise KeyError
            if path == "/api/status":
                return self.reply(200, {"models": models.configured_models(),
                    "mcp": mcp_client.is_configured(), "built_in_notes": not os.getenv("REA_MCP_COMMAND"), "studio": studio.capabilities()})
            if path.startswith("/api/answer/"):
                with jobs_lock:
                    item = history[path.split("/")[-1]]
                    snapshot = {k: v for k, v in item.items() if k != "context"}
                    snapshot["events"] = list(item["events"])
                return self.reply(200, snapshot)
            if path == "/api/studio":
                return self.reply(200, studio.capabilities())
            parts = path.strip("/").split("/")
            if parts[:3] == ["api", "studio", "jobs"]:
                if len(parts) == 4:
                    return self.reply(200, studio.status(parts[3]))
                if len(parts) == 5:
                    data, mime = studio.artifact(parts[3], parts[4])
                    return self.reply(200, data, mime, parts[4] if "download" in urlsplit(self.path).query else None)
            raise KeyError
        except Exception as exc:
            self.failure(exc)

    def failure(self, exc):
        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return
        if isinstance(exc, KeyError):
            return self.reply(404, {"error": "यहाँ कुछ नहीं मिला।"})
        if isinstance(exc, (ValueError, RuntimeError, mcp_client.MCPError)):
            return self.reply(400, {"error": str(exc)[:1200]})
        self.log_error("request failed (%s)", type(exc).__name__)
        self.reply(500, {"error": "सर्वर अनुरोध पूरा नहीं कर सका।"})

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            if not self.allowed(post=True):
                return self.reply(403, {"error": "इसी ऐप से अनुरोध भेजें।"})
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 300000 or self.headers.get_content_type() != "application/json":
                raise ValueError("मान्य JSON आवश्यक है।")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("JSON object आवश्यक है।")
            if path == "/api/rooms/config":
                config = json.loads(os.getenv("REA_ICE_SERVERS", '[{"urls":"stun:stun.l.google.com:19302"}]'))
                result = {"iceServers": config}
            elif path.startswith("/api/rooms/"):
                if self.server.guest and path == "/api/rooms/create":
                    raise KeyError
                result = media_rooms.dispatch(path, data)
            elif self.server.guest:
                raise KeyError
            elif path == "/api/answer":
                result = begin_answer(data.get("prompt"), data.get("note", ""), data.get("previous"))
            elif path == "/api/login":
                import web_sessions
                result = web_sessions.start_login(data.get("provider"))
            elif path == "/api/mcp/list":
                result = {"tools": mcp_client.list_tools()}
            elif path == "/api/mcp/call":
                result = mcp_client.call_tool(data.get("name"), data.get("arguments", {}))
            elif path == "/api/studio/jobs":
                result = studio.start(data.get("engine"), data.get("script"))
            elif path == "/api/studio/install":
                result = studio.install_blender()
            else:
                raise KeyError
            self.reply(200, result)
        except Exception as exc:
            self.failure(exc)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--open", action="store_true", help="Open the workspace in the local browser")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--guest-port", type=int, help="Video-call guest listener on all interfaces (place behind HTTPS)")
    args = parser.parse_args()
    if not any(os.getenv(k) for k in ("OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODELS")):
        os.environ.setdefault("REA_WEB_PROVIDERS", "chatgpt,gemini,claude")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.guest = False
    if args.guest_port:
        guests = ThreadingHTTPServer(("0.0.0.0", args.guest_port), Handler)
        guests.guest = True
        threading.Thread(target=guests.serve_forever, daemon=True).start()
    print(f"Rea Studio • http://127.0.0.1:{server.server_port}", flush=True)
    if args.open:
        import webbrowser
        import shutil
        import subprocess
        url = f"http://127.0.0.1:{server.server_port}"
        if shutil.which("termux-open-url"):
            subprocess.Popen(["termux-open-url", url])
        else:
            threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
