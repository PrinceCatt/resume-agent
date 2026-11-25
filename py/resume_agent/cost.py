"""What the logged model calls cost in RMB, priced by the time of each call: DeepSeek charges half outside
its peak hours. Prices are DeepSeek's list for deepseek-chat / V4 Flash, per million tokens, as of
2026-11-14 (api-docs.deepseek.com/zh-cn/quick_start/pricing). An estimate: the DeepSeek console has the bill."""

from __future__ import annotations

from typing import Any

from .db import all_rows, parse_sql_time
from .offpeak import is_peak

PRICE = {
    "peak": {"hit": 0.04, "miss": 2, "out": 8},
    "off": {"hit": 0.02, "miss": 1, "out": 4},
}


def call_rmb(r: dict[str, Any]) -> float:
    """One call's cost in RMB. ts is UTC in SQLite's datetime('now') format."""
    when = parse_sql_time(r["ts"])
    p = PRICE["peak"] if when is not None and is_peak(when) else PRICE["off"]
    hit = min(r["cache_hit_tokens"], r["prompt_tokens"])
    return ((r["prompt_tokens"] - hit) * p["miss"] + hit * p["hit"] + r["completion_tokens"] * p["out"]) / 1e6


def sum_rmb(rows: list[dict[str, Any]]) -> float:
    return sum((call_rmb(r) for r in rows), 0.0)


def usage_rows(where: str = "", *params: Any) -> list[dict[str, Any]]:
    """Tokens and RMB of the usage rows matching a WHERE clause (or all of them)."""
    return all_rows(f"SELECT kind, prompt_tokens, cache_hit_tokens, completion_tokens, ts FROM usage {where}", *params)
