"""Ephemeral two-party WebRTC signaling for a single Rea Studio server process."""

import secrets
import threading
import time
from dataclasses import dataclass, field

_ROOM_LIMIT = 128
_WAIT_SECONDS = 600
_PEER_IDLE_SECONDS = 180
_ENDED_SECONDS = 60
_MAX_EVENTS = 160
_MAX_DESCRIPTION = 65536
_MAX_CANDIDATE = 2048


@dataclass
class Room:
    created: float
    tokens: list
    last_seen: list
    events: list = field(default_factory=list)
    descriptions: dict = field(default_factory=dict)
    ended: float | None = None


_rooms = {}
_lock = threading.Lock()


def _expire(now):
    for code, room in list(_rooms.items()):
        if room.ended is not None:
            if now - room.ended > _ENDED_SECONDS:
                del _rooms[code]
        elif len(room.tokens) == 1 and now - room.created > _WAIT_SECONDS:
            del _rooms[code]
        elif len(room.tokens) == 2 and now - min(room.last_seen) > _PEER_IDLE_SECONDS:
            room.ended = now
            room.events.clear()
            room.descriptions.clear()


def _sanitize_signal(signal, slot):
    if not isinstance(signal, dict):
        raise ValueError("कॉल का संदेश अधूरा है।")
    kind, value = signal.get("type"), signal.get("value")
    if not isinstance(value, dict):
        raise ValueError("कॉल का संदेश अधूरा है।")
    if kind in ("offer", "answer"):
        expected = ("offer", "answer")[slot]
        sdp = value.get("sdp")
        if kind != expected or value.get("type") != kind:
            raise ValueError("कॉल विवरण भेजने का क्रम सही नहीं है।")
        if not isinstance(sdp, str) or not 0 < len(sdp) <= _MAX_DESCRIPTION:
            raise ValueError("कॉल विवरण पढ़ा नहीं जा सका।")
        return {"type": kind, "value": {"type": kind, "sdp": sdp}}
    if kind != "candidate":
        raise ValueError("अज्ञात कॉल संदेश।")
    candidate = value.get("candidate")
    if not isinstance(candidate, str) or len(candidate) > _MAX_CANDIDATE:
        raise ValueError("नेटवर्क विवरण पढ़ा नहीं जा सका।")
    fields = {"candidate": candidate}
    for key in ("sdpMid", "usernameFragment"):
        item = value.get(key)
        if item is not None:
            if not isinstance(item, str) or len(item) > 256:
                raise ValueError("नेटवर्क विवरण पढ़ा नहीं जा सका।")
            fields[key] = item
    index = value.get("sdpMLineIndex")
    if index is not None:
        if type(index) is not int or not 0 <= index <= 65535:
            raise ValueError("नेटवर्क विवरण पढ़ा नहीं जा सका।")
        fields["sdpMLineIndex"] = index
    return {"type": kind, "value": fields}


def dispatch(path, data):
    if not isinstance(data, dict) or path not in {
        "/api/rooms/" + name for name in ("create", "join", "send", "poll", "leave")
    }:
        raise ValueError("कॉल का अनुरोध पढ़ा नहीं जा सका।")
    action = path.rsplit("/", 1)[-1]
    with _lock:
        now = time.monotonic()
        _expire(now)
        if action == "create":
            if len(_rooms) >= _ROOM_LIMIT:
                raise ValueError("सभी कॉल रूम व्यस्त हैं। थोड़ी देर बाद कोशिश करें।")
            code = secrets.token_hex(5).upper()
            while code in _rooms:
                code = secrets.token_hex(5).upper()
            token = secrets.token_urlsafe(24)
            _rooms[code] = Room(now, [token], [now])
            return {"code": code, "token": token}

        code = data.get("code")
        room = _rooms.get(code.strip().upper()) if isinstance(code, str) else None
        if room is None:
            raise ValueError("कॉल रूम नहीं मिला या उसकी अवधि समाप्त हो गई।")
        if action == "join":
            if room.ended is not None or len(room.tokens) == 2:
                raise ValueError("इस रूम में अब शामिल नहीं हो सकते।")
            token = secrets.token_urlsafe(24)
            room.tokens.append(token)
            room.last_seen.append(now)
            return {"token": token}

        token = data.get("token")
        if not isinstance(token, str) or not token.isascii():
            raise ValueError("कॉल की अनुमति नहीं मिली।")
        slot = next((index for index, key in enumerate(room.tokens)
                     if secrets.compare_digest(token, key)), None)
        if slot is None:
            raise ValueError("कॉल की अनुमति नहीं मिली।")
        room.last_seen[slot] = now
        if action == "leave":
            if room.ended is None:
                room.ended = now
                room.events.clear()
                room.descriptions.clear()
            return {}
        if action == "poll":
            after = data.get("after", 0)
            if type(after) is not int or after < 0:
                raise ValueError("कॉल संदेश का क्रमांक अमान्य है।")
            events = [
                {"id": i, "signal": signal}
                for i, (sender, signal) in enumerate(room.events, 1)
                if i > after and sender != slot
            ]
            return {"events": events, "joined": len(room.tokens) == 2,
                    "ended": room.ended is not None}
        if room.ended is not None:
            raise ValueError("कॉल समाप्त हो चुकी है।")
        signal = _sanitize_signal(data.get("signal"), slot)
        if (slot, signal) in room.events:
            return {}
        kind = signal["type"]
        if kind in room.descriptions or (kind == "answer" and "offer" not in room.descriptions):
            raise ValueError("कॉल विवरण भेजने का क्रम सही नहीं है।")
        if len(room.events) >= _MAX_EVENTS:
            raise ValueError("इस रूम की संदेश सीमा पूरी हो गई।")
        if kind in ("offer", "answer"):
            room.descriptions[kind] = True
        room.events.append((slot, signal))
        return {}
