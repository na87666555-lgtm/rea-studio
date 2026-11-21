"""Visible Playwright sessions for optional, user-selected website providers."""

import os
import threading
import time
from concurrent.futures import Future
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit


class WebSessionError(ValueError):
    """A website-session error safe to display to the browser client."""


SITES = {
    "chatgpt": {
        "name": "ChatGPT", "url": "https://chatgpt.com/",
        "editor": '#prompt-textarea, textarea[name="prompt-textarea"]',
        "send": 'button[data-testid="send-button"]',
        "reply": '[data-message-author-role="assistant"]',
        "body": ".markdown", "turn": 'article, [data-testid^="conversation-turn"]',
        "done": 'button[data-testid="copy-turn-action-button"]',
        "stop": 'button[data-testid="stop-button"], button[aria-label*="Stop streaming" i]',
    },
    "gemini": {
        "name": "Gemini", "url": "https://gemini.google.com/app",
        "editor": 'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"]',
        "send": 'button.send-button, button[aria-label="Send message" i]',
        "reply": "model-response", "body": "message-content, .model-response-text",
        "turn": ".conversation-container",
        "done": 'copy-button, button[data-test-id="copy-button"], button[aria-label="Copy response" i]',
        "stop": 'button.stop, button[aria-label*="Stop response" i], button[aria-label*="Stop generation" i]',
    },
    "claude": {
        "name": "Claude", "url": "https://claude.ai/new",
        "editor": '[data-testid="chat-input"][contenteditable="true"], .ProseMirror[contenteditable="true"]',
        "send": 'button[data-testid="send-button"], button[aria-label="Send message" i]',
        "reply": ".font-claude-response", "body": "",
        "turn": '[data-is-streaming], [data-testid="assistant-message"]',
        "done": 'button[data-testid="action-bar-copy"], button[aria-label="Copy response" i]',
        "stop": 'button[data-testid="stop-button"], button[aria-label*="Stop response" i]',
    },
}

_LOCKS = {key: threading.Lock() for key in SITES}
_LOGIN_TTL = 600
_ANSWER_TTL = 150


def _keys():
    values = os.getenv("REA_WEB_PROVIDERS", "").lower().split(",")
    return list(dict.fromkeys(v.strip() for v in values if v.strip() in SITES))


def configured_models():
    return [{"provider": SITES[k]["name"] + " Web", "model": SITES[k]["name"]} for k in _keys()]


def _provider_key(provider):
    if isinstance(provider, str):
        key = provider.lower().removesuffix(" web").strip()
        if key in _keys():
            return key
    raise WebSessionError("पहले REA_WEB_PROVIDERS में इस वेबसाइट को चालू करें।")


@contextmanager
def _session(key):
    if not _LOCKS[key].acquire(blocking=False):
        raise WebSessionError("यह वेबसाइट अभी व्यस्त है। लॉगिन की विंडो बंद करें या चल रहा जवाब पूरा होने दें।")
    try:
        try:
            from playwright.sync_api import Error, sync_playwright
        except ImportError:
            raise WebSessionError("वेब सत्र के लिए सर्वर पर Python Playwright इंस्टॉल करें।") from None
        try:
            root = Path(os.getenv("REA_PROFILE_DIR") or "~/.local/share/rea-studio/browser-profiles").expanduser()
            profile = root / key
            profile.mkdir(parents=True, exist_ok=True, mode=0o700)
            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(
                    str(profile), executable_path=os.getenv("REA_CHROMIUM_PATH") or None,
                    headless=False, timeout=20000, accept_downloads=False,
                )
                try:
                    page = context.pages[0] if context.pages else context.new_page()
                    page.set_default_timeout(5000)
                    page.goto(SITES[key]["url"], wait_until="commit", timeout=20000)
                    yield page
                finally:
                    context.close()
        except (OSError, Error):
            raise WebSessionError("ब्राउज़र या वेबसाइट उपलब्ध नहीं है। Chromium, डिस्प्ले और लॉगिन जाँचें।") from None
    finally:
        _LOCKS[key].release()


def start_login(provider):
    """Open the official site; the user logs in and closes its window to save."""
    key = _provider_key(provider)
    opened = Future()

    def login():
        try:
            with _session(key) as page:
                opened.set_result(True)
                until = time.monotonic() + _LOGIN_TTL
                while not page.is_closed() and time.monotonic() < until:
                    page.wait_for_timeout(500)
        except Exception as exc:
            if not opened.done():
                opened.set_exception(exc if isinstance(exc, WebSessionError) else
                                     WebSessionError("लॉगिन की विंडो नहीं खुली।"))

    threading.Thread(target=login, daemon=True).start()
    try:
        opened.result(timeout=50)
    except TimeoutError:
        raise WebSessionError("लॉगिन की विंडो खुलने का समय समाप्त हुआ।") from None
    return {"provider": SITES[key]["name"] + " Web",
            "message": "सर्वर की स्क्रीन पर लॉगिन पूरा करके ब्राउज़र विंडो बंद करें।"}


# Completion is evaluated on the new assistant turn. Old turns, code-copy buttons
# and stable partial text alone cannot complete a request.
_SNAPSHOT = """([s, count]) => {
  const visible = el => Boolean(el && el.getClientRects().length);
  const replies = [...document.querySelectorAll(s.reply)].filter(visible);
  const stoppedBy = [...document.querySelectorAll(s.stop)].some(visible);
  if (replies.length <= count) return {count: replies.length, stoppedBy};
  const reply = replies[replies.length - 1];
  const turn = reply.closest(s.turn) || reply;
  const newReplies = replies.slice(count).filter(el => (el.closest(s.turn) || el) === turn);
  const text = newReplies.flatMap(el => {
    const matches = s.body ? [...el.querySelectorAll(s.body)].filter(visible) : [];
    const roots = matches.filter(node => !matches.some(parent => parent !== node && parent.contains(node)));
    return (roots.length ? roots : [el]).map(node => node.innerText.trim());
  }).filter(Boolean).join('\\n\\n');
  const complete = turn.getAttribute('data-is-streaming') === 'false' ||
    [...turn.querySelectorAll(s.done)].some(visible);
  return {count: replies.length, stoppedBy, complete, text};
}"""


def ask(provider, instruction, prompt):
    """Submit once to the visible official site and read only its new reply."""
    key = _provider_key(provider)
    site = SITES[key]
    with _session(key) as page:
        editor = page.locator(site["editor"]).filter(visible=True).last
        try:
            editor.wait_for(state="visible", timeout=45000)
        except Exception:
            raise WebSessionError("वेबसाइट पर लिखने का बॉक्स नहीं मिला। लॉगिन या स्क्रीन पर सत्यापन पूरा करें।") from None
        if urlsplit(page.url).netloc != urlsplit(site["url"]).netloc:
            raise WebSessionError("वेबसाइट पर अपना लॉगिन पूरा करें।")
        editor.fill(instruction + "\n\n" + prompt)
        old_count = page.evaluate(_SNAPSHOT, [site, 0])["count"]
        if urlsplit(page.url).netloc != urlsplit(site["url"]).netloc:
            raise WebSessionError("लिखने से पहले वेबसाइट का पता बदल गया।")
        send = page.locator(site["send"]).filter(visible=True).last
        if send.count():
            send.click(timeout=5000)
        else:
            editor.press("Enter")

        deadline = time.monotonic() + _ANSWER_TTL
        saw_stop = False
        last_text, last_change = "", time.monotonic()
        while time.monotonic() < deadline:
            if urlsplit(page.url).netloc != urlsplit(site["url"]).netloc:
                raise WebSessionError("जवाब मिलने से पहले वेबसाइट का पता बदल गया।")
            state = page.evaluate(_SNAPSHOT, [site, old_count])
            now = time.monotonic()
            text = state.get("text", "")
            if text != last_text:
                last_text, last_change = text, now
            saw_stop = saw_stop or state["stoppedBy"]
            if (text and not state["stoppedBy"] and (state.get("complete") or saw_stop)
                    and now - last_change >= 2):
                return text[:12000]
            page.wait_for_timeout(400)
        raise WebSessionError("वेबसाइट से पूरा नया जवाब मिलने का समय समाप्त हुआ।")
