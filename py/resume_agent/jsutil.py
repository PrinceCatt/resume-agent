"""Small helpers that reproduce JavaScript semantics the TypeScript server relies on."""

from __future__ import annotations

import json
import math
from decimal import ROUND_HALF_UP, Decimal
from typing import Any


def js_json(v: Any) -> str:
    """JSON.stringify: compact, non-ASCII kept as is."""
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def js_round(x: float) -> int:
    """Math.round: halves go towards +infinity."""
    return math.floor(x + 0.5)


def to_fixed(x: float, digits: int) -> str:
    """Number.prototype.toFixed: ties on the exact binary value go up (away from zero for positives)."""
    q = Decimal(1).scaleb(-digits)
    d = Decimal(x).quantize(q, rounding=ROUND_HALF_UP)
    s = f"{d:f}"
    if s.startswith("-") and float(d) == 0:
        s = s[1:]
    return s


def is_num(v: Any) -> bool:
    """typeof v === "number" (bool is not a number in JS)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def is_finite(v: Any) -> bool:
    """Number.isFinite: only real numbers, no coercion."""
    return is_num(v) and math.isfinite(v)


def js_number(v: Any) -> float:
    """Number(v) with JS coercion rules (NaN as float('nan'))."""
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if is_num(v):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        if s == "":
            return 0.0
        try:
            if s.lower().startswith(("0x", "-0x", "+0x")):
                return float(int(s, 16))
            if s in ("Infinity", "+Infinity"):
                return math.inf
            if s == "-Infinity":
                return -math.inf
            if s.lower() in ("inf", "+inf", "-inf", "nan", "infinity", "-infinity", "+infinity"):
                return math.nan
            return float(s)
        except ValueError:
            return math.nan
    if isinstance(v, list):
        if not v:
            return 0.0
        if len(v) == 1:
            return js_number(v[0])
        return math.nan
    return math.nan


def num_str(n: float) -> str:
    """String(number) for the values this app prints (integers without .0)."""
    if isinstance(n, bool):
        return "true" if n else "false"
    if isinstance(n, int):
        return str(n)
    if math.isnan(n):
        return "NaN"
    if math.isinf(n):
        return "Infinity" if n > 0 else "-Infinity"
    if n == int(n) and abs(n) < 1e21:
        return str(int(n))
    return repr(n)


def js_string(v: Any) -> str:
    """String(v)."""
    if v is None:
        return "null"
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return "true" if v else "false"
    if is_num(v):
        return num_str(v)
    if isinstance(v, list):
        return ",".join("" if x is None else js_string(x) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    return str(v)


def floor_num(x: float) -> int | float:
    """Math.floor that keeps NaN / infinities as they are."""
    if math.isnan(x) or math.isinf(x):
        return x
    return math.floor(x)


def base36(n: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    if n == 0:
        return "0"
    out = ""
    neg = n < 0
    n = abs(n)
    while n:
        n, r = divmod(n, 36)
        out = chars[r] + out
    return ("-" if neg else "") + out


def truthy(v: Any) -> bool:
    """JS truthiness."""
    if v is None or v is False:
        return False
    if is_num(v):
        return v != 0 and not (isinstance(v, float) and math.isnan(v))
    if isinstance(v, str):
        return v != ""
    return True
