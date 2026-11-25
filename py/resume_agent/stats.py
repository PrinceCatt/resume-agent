"""Numbers for the stats page: how far applications get, how fast replies come, and whether
the fit score and the job site make a difference."""

from __future__ import annotations

import re
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable
from urllib.parse import urlsplit

from .db import all_rows, get
from .jobs import job_jd, list_jobs, progress_reached
from .jsutil import js_round
from .schedule import list_events

KNOWN: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"greenhouse\.io$"), "Greenhouse"),
    (re.compile(r"lever\.co$"), "Lever"),
    (re.compile(r"linkedin\.com$"), "LinkedIn"),
    (re.compile(r"(myworkdayjobs|workday)\.com$"), "Workday"),
    (re.compile(r"mycareersfuture\.gov\.sg$"), "MyCareersFuture"),
    (re.compile(r"ashbyhq\.com$"), "Ashby"),
    (re.compile(r"smartrecruiters\.com$"), "SmartRecruiters"),
    (re.compile(r"(^|\.)indeed\."), "Indeed"),
    (re.compile(r"(^|\.)glassdoor\."), "Glassdoor"),
    (re.compile(r"(^|\.)jobstreet\."), "JobStreet"),
    (re.compile(r"zhipin\.com$"), "BOSS直聘"),
    (re.compile(r"nowcoder\.com$"), "牛客"),
    (re.compile(r"^(localhost|127\.0\.0\.1)$"), "本地测试页"),
]


def site_of(url: str) -> str:
    """Where a posting lives: a known job board by name, otherwise the site's own name."""
    if not url:
        return "粘贴的 JD"
    try:
        parts_ = urlsplit(url)
        if not parts_.scheme or not parts_.netloc:
            raise ValueError("not a URL")
        h = re.sub(r"^www\.", "", (parts_.hostname or "").lower())
    except ValueError:
        return "其他"
    for rx, name in KNOWN:
        if rx.search(h):
            return name
    parts = h.split(".")
    two_part = len(parts) >= 3 and re.match(r"^(com|gov|edu|org|net|co|ac)$", parts[-2]) is not None
    idx = len(parts) - (3 if two_part else 2)
    return parts[idx] if 0 <= idx < len(parts) else h


REPLY = ["screening", "interview", "offer", "rejected"]
POSITIVE = ["screening", "interview", "offer"]


def _utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace(" ", "T")).replace(tzinfo=timezone.utc)


def _week_start(d: datetime) -> date:
    """Monday of the week containing d, in local time."""
    local = d.astimezone() if d.tzinfo else d
    day = local.date()
    return day - timedelta(days=day.weekday())


def _bucket(key: str, label: str) -> dict[str, Any]:
    return {"key": key, "label": label, "applied": 0, "replied": 0, "positive": 0}


def _num(x: float) -> int | float:
    return int(x) if x == int(x) else x


def stats() -> dict[str, Any]:
    jobs = list_jobs()
    funnel = {"added": 0, "parsed": 0, "tailored": 0, "applied": 0, "replied": 0, "interview": 0, "offer": 0}
    mature = 0
    mature_replied = 0
    ended = 0
    reply_days: list[float] = []
    fit = [_bucket("high", "70 分以上"), _bucket("mid", "50–69 分"), _bucket("low", "50 分以下"), _bucket("none", "没有评分")]
    sites: dict[str, dict[str, Any]] = {}

    weeks_n = 10
    this_week = _week_start(datetime.now())
    weeks = []
    for i in range(weeks_n):
        d = this_week - timedelta(days=7 * (weeks_n - 1 - i))
        weeks.append({"start": d.isoformat(), "d": d, "added": 0, "applied": 0})

    def week_of(s: str | None) -> dict[str, Any] | None:
        if not s:
            return None
        try:
            t = _week_start(_utc(s))
        except ValueError:
            return None
        return next((w for w in weeks if w["d"] == t), None)

    now_ms = time.time() * 1000
    for j in jobs:
        if j["stage"] == "skipped":
            continue
        funnel["added"] += 1
        wa = week_of(j["created_at"])
        if wa:
            wa["added"] += 1
        if j["jd"]:
            funnel["parsed"] += 1
        if j["tailored"]:
            funnel["tailored"] += 1
        if j["stage"] != "applied":
            continue
        funnel["applied"] += 1
        applied_at = j["applied_at"] if j["applied_at"] is not None else j["updated_at"]
        wp = week_of(applied_at)
        if wp:
            wp["applied"] += 1

        cur = j["progress"] if j["progress"] is not None else "applied"
        reached = progress_reached(j["id"], cur)
        replied = any(p in reached for p in REPLY)
        positive = any(p in reached for p in POSITIVE)
        if replied:
            funnel["replied"] += 1
        if "interview" in reached or "offer" in reached:
            funnel["interview"] += 1
        if "offer" in reached:
            funnel["offer"] += 1
        if cur in ("rejected", "withdrawn"):
            ended += 1

        applied_ms = _utc(applied_at).timestamp() * 1000
        age = (now_ms - applied_ms) / 86_400_000
        if age >= 7:
            mature += 1
            if replied:
                mature_replied += 1
        if replied:
            row = get("SELECT MIN(ts) AS ts FROM progress_log WHERE job_id = ? AND progress != 'applied'", j["id"])
            first = row["ts"] if row and row["ts"] is not None else (j["progress_at"] if cur != "applied" else None)
            if first:
                d = (_utc(first).timestamp() * 1000 - applied_ms) / 86_400_000
                if d >= 0:
                    reply_days.append(d)

        jd = job_jd(j)
        f = jd.get("fit") if jd else None
        if not isinstance(f, dict) or "score" not in f:
            b = fit[3]
        else:
            score = f["score"]
            b = fit[0] if score is not None and score >= 70 else fit[1] if score is not None and score >= 50 else fit[2]
        name = site_of(j["url"])
        if name not in sites:
            sites[name] = _bucket(name, name)
        for x in (b, sites[name]):
            x["applied"] += 1
            if replied:
                x["replied"] += 1
            if positive:
                x["positive"] += 1

    reply_days.sort()
    median = reply_days[(len(reply_days) - 1) // 2] if reply_days else None
    tok = get("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS n FROM usage")
    return {
        "funnel": funnel,
        "responseRate": {"applied": mature, "replied": mature_replied, "recent": funnel["applied"] - mature},
        "medianReplyDays": None if median is None else _num(js_round(median * 10) / 10),
        "ended": ended,
        "weekly": [{"start": w["start"], "added": w["added"], "applied": w["applied"]} for w in weeks],
        "byFit": [b for b in fit if b["applied"] > 0],
        "bySite": sorted(sites.values(), key=lambda b: -b["applied"])[:8],
        "upcoming": len(list_events(upcoming=True)),
        "tokens": tok["n"] if tok else 0,
    }


def asked_questions(similar: Callable[[str, str], float], answers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Questions the agent asked you that are not in the profile's answers yet, with what you said."""
    rows = all_rows(
        """SELECT s.id, s.run_id, s.kind, s.text, s.ts, r.job_id, j.title, j.company
     FROM run_steps s JOIN runs r ON r.id = s.run_id JOIN jobs j ON j.id = r.job_id
     WHERE (s.kind = 'ask' AND s.text LIKE '问你：%') OR (s.kind = 'note' AND s.text LIKE '你的回答：%')
     ORDER BY s.run_id, s.id"""
    )
    out: dict[str, dict[str, Any]] = {}
    for i, r in enumerate(rows):
        if r["kind"] != "ask":
            continue
        q = r["text"][len("问你：") :].strip()
        nxt = rows[i + 1] if i + 1 < len(rows) else None
        a = (
            re.sub(r"（已记入资料库）$", "", nxt["text"][len("你的回答：") :]).strip()
            if nxt and nxt["run_id"] == r["run_id"] and nxt["kind"] == "note"
            else ""
        )
        if not q or any(x["a"].strip() and similar(x["q"], q) >= 0.8 for x in answers):
            continue
        key = re.sub(r"\s+", " ", q.lower())
        prev = out.get(key)
        out[key] = {
            "q": q,
            "a": a or (prev["a"] if prev else ""),
            "times": (prev["times"] if prev else 0) + 1,
            "job": " · ".join(x for x in (r["title"], r["company"]) if x),
            "ts": r["ts"],
        }
    vals = list(out.values())
    # b.times - a.times || b.ts.localeCompare(a.ts)
    vals.sort(key=lambda v: v["ts"], reverse=True)
    vals.sort(key=lambda v: -v["times"])
    return vals[:30]
