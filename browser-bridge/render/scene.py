"""Rea scene Python: validate the entire bounded scene before using Blender."""
import ast
import math
import re

SHAPES = {"cube", "sphere", "torus", "cone", "cylinder", "crystal"}

def vector(value, limit):
    if not isinstance(value, (tuple, list)) or len(value) != 3 or any(type(n) not in (int, float) or not math.isfinite(n) or abs(n) > limit for n in value):
        raise ValueError("तीन सीमित संख्याएँ चाहिए।")
    return tuple(value)

def colour(value):
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ValueError("रंग #RRGGBB में लिखें।")
    return value

def parse_scene(source):
    seconds, background, objects = 3, "#192638", []
    def movie(seconds=3, background="#192638"):
        if type(seconds) is not int or not 1 <= seconds <= 6:
            raise ValueError("अवधि 1 से 6 पूरे सेकंड होनी चाहिए।")
        return seconds, colour(background)
    def shape(kind, at=(0, 0, 0), size=(1, 1, 1), color="#28c5aa", spin=(0, 0, 0), move=(0, 0, 0), tilt=(0, 0, 0)):
        if kind not in SHAPES or len(objects) >= 12:
            raise ValueError("अधिकतम 12 आकृतियाँ: cube, sphere, torus, cone, cylinder, crystal।")
        scale = vector(size, 4)
        if min(scale) < .05:
            raise ValueError("आकृति का आकार .05 से 4 तक रखें।")
        objects.append((kind, vector(at, 8), scale, colour(color), vector(spin, 1440), vector(move, 8), vector(tilt, 360)))
    try:
        tree = ast.parse(source)
        for stmt in tree.body:
            call = getattr(stmt, "value", None)
            if not isinstance(stmt, ast.Expr) or not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.func.id not in ("movie", "shape"):
                raise ValueError("यहाँ movie() और shape() वाली Blender दृश्य स्क्रिप्ट चलती है।")
            args = [ast.literal_eval(a) for a in call.args]
            keys = [a.arg for a in call.keywords]
            if None in keys or len(keys) != len(set(keys)):
                raise ValueError("तर्क का नाम सही नहीं है।")
            kwargs = {a.arg: ast.literal_eval(a.value) for a in call.keywords}
            if call.func.id == "movie":
                seconds, background = movie(*args, **kwargs)
            else:
                shape(*args, **kwargs)
    except (SyntaxError, TypeError, OverflowError, RecursionError, ValueError) as exc:
        reason = str(exc)
        raise ValueError(reason if any('\u0900' <= ch <= '\u097f' for ch in reason) else "स्क्रिप्ट में मान या तर्क सही नहीं है। संख्याएँ, रंग और सीधे movie()/shape() कॉल लिखें।") from None
    if not objects:
        raise ValueError("कम से कम एक shape() लिखें।")
    return seconds, background, objects
