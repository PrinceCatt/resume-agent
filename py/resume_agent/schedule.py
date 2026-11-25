"""Interviews, tests, calls and deadlines on a job: listed on the jobs page, reminded in the
browser, and downloadable as calendar files."""

from __future__ import annotations

import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from .db import all_rows, get, run, sql_now
from .events import emit
from .jobs import get_job, set_job
from .jsutil import js_number, js_round

EVENT_KINDS = ["interview", "test", "call", "deadline", "other"]
LABEL = {"interview": "面试", "test": "笔试/测评", "call": "电话沟通", "deadline": "投递截止", "other": "日程"}
EVENT_LABEL = LABEL

_HAS_ZONE = re.compile(r"[zZ]|[+-]\d\d:?\d\d$")


def to_sql_time(v: Any) -> str | None:
    """Any time the browser sends (ISO with Z or an offset) → UTC "YYYY-MM-DD HH:MM:SS"; None if unreadable."""
    if not isinstance(v, str) or not v.strip():
        return None
    s = v.strip()
    zoned = bool(_HAS_ZONE.search(s))
    t = s.replace(" ", "T", 1)
    if t.endswith(("z", "Z")):
        t = t[:-1] + "+00:00"
    # "+0800" → "+08:00" (fromisoformat wants the colon on older inputs).
    t = re.sub(r"([+-]\d\d)(\d\d)$", r"\1:\2", t)
    try:
        d = datetime.fromisoformat(t)
    except ValueError:
        return None
    if d.tzinfo is None:
        if zoned:
            return None
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


_SELECT = "SELECT e.*, j.title AS job_title, j.company AS job_company, j.url AS job_url FROM events e JOIN jobs j ON j.id = e.job_id"


def list_events(job_id: int | None = None, upcoming: bool = False) -> list[dict[str, Any]]:
    """Upcoming = not done and not more than three hours past (an interview that is running still shows)."""
    where: list[str] = []
    params: list[Any] = []
    if job_id is not None:
        where.append("e.job_id = ?")
        params.append(job_id)
    if upcoming:
        where.append("e.done = 0 AND e.at >= datetime('now', '-3 hours')")
    return all_rows(f"{_SELECT}{' WHERE ' + ' AND '.join(where) if where else ''} ORDER BY e.at, e.id", *params)


def next_event(job_id: int) -> dict[str, Any] | None:
    return get(
        "SELECT id, kind, at FROM events WHERE job_id = ? AND done = 0 AND at >= datetime('now', '-3 hours') ORDER BY at LIMIT 1",
        job_id,
    )


RANK = {"applied": 0, "screening": 1, "interview": 2}


def add_event(job_id: int, input_: dict[str, Any]) -> int:
    job = get_job(job_id)
    if not job:
        raise RuntimeError("岗位不存在")
    kind = input_.get("kind") if input_.get("kind") in EVENT_KINDS else "other"
    at = to_sql_time(input_.get("at"))
    if not at:
        raise RuntimeError("时间不对")
    minutes = 0 if kind == "deadline" else _clamp_minutes(input_.get("minutes"))
    note = input_["note"].strip()[:500] if isinstance(input_.get("note"), str) else ""
    id_ = run("INSERT INTO events (job_id, kind, at, minutes, note) VALUES (?, ?, ?, ?, ?)", job_id, kind, at, minutes, note)["id"]
    # An interview or a test on an applied job moves its progress forward (never back, never past an outcome).
    want = "interview" if kind == "interview" else "screening" if kind == "test" else None
    cur = job["progress"] if job["progress"] is not None else ("applied" if job["stage"] == "applied" else None)
    if want and job["stage"] == "applied" and cur and cur in RANK and RANK[cur] < RANK[want]:
        set_job(job_id, {"progress": want, "progress_at": sql_now()})
    emit("schedule", job_id)
    emit("job", job_id)
    return id_


def _clamp_minutes(v: Any) -> int:
    x = js_number(v) if v is not None else math.nan  # Number(undefined) is NaN
    if not math.isfinite(x):
        return 60
    n = js_round(x)
    return min(n, 24 * 60) if n > 0 else 60


def update_event(id_: int, input_: dict[str, Any]) -> None:
    ev = get("SELECT * FROM events WHERE id = ?", id_)
    if not ev:
        raise RuntimeError("没有这条日程")
    patch: dict[str, Any] = {}
    if input_.get("kind") in EVENT_KINDS:
        patch["kind"] = input_["kind"]
    if "at" in input_:
        at = to_sql_time(input_["at"])
        if not at:
            raise RuntimeError("时间不对")
        patch["at"] = at
    if "minutes" in input_:
        patch["minutes"] = _clamp_minutes(input_["minutes"]) if input_["minutes"] is not None else 60
    if patch.get("kind", ev["kind"]) == "deadline":
        patch["minutes"] = 0
    if isinstance(input_.get("note"), str):
        patch["note"] = input_["note"].strip()[:500]
    if isinstance(input_.get("done"), bool):
        patch["done"] = 1 if input_["done"] else 0
    keys = list(patch.keys())
    if keys:
        run(f"UPDATE events SET {', '.join(f'{k} = ?' for k in keys)} WHERE id = ?", *[patch[k] for k in keys], id_)
    emit("schedule", ev["job_id"])
    emit("job", ev["job_id"])


def delete_event(id_: int) -> None:
    ev = get("SELECT * FROM events WHERE id = ?", id_)
    if not ev:
        return
    run("DELETE FROM events WHERE id = ?", id_)
    emit("schedule", ev["job_id"])
    emit("job", ev["job_id"])


def get_event(id_: int) -> dict[str, Any] | None:
    return get(f"{_SELECT} WHERE e.id = ?", id_)


def _stamp(d: datetime) -> str:
    return d.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _esc(s: str) -> str:
    return re.sub(r"\r?\n", r"\\n", s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,"))


def ics_for(ev: dict[str, Any]) -> str:
    """An .ics file with one event and a reminder (an hour before; a day before for a deadline)."""
    start = datetime.fromisoformat(ev["at"].replace(" ", "T")).replace(tzinfo=timezone.utc)
    end = start + timedelta(minutes=max(ev["minutes"], 0 if ev["kind"] == "deadline" else 15))
    job = " @ ".join(x for x in (ev["job_title"], ev["job_company"]) if x) or ev["job_url"]
    m = re.search(r"https?://\S+", ev["note"])
    link = m.group(0) if m else None
    if link:
        where = [f"URL:{link}", f"LOCATION:{_esc(link)}"]
    elif ev["note"] and len(ev["note"]) < 120:
        where = [f"LOCATION:{_esc(ev['note'])}"]
    else:
        where = []
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//resume-agent//CN",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        f"UID:resume-agent-event-{ev['id']}@localhost",
        f"DTSTAMP:{_stamp(datetime.now(timezone.utc))}",
        f"DTSTART:{_stamp(start)}",
        f"DTEND:{_stamp(end)}",
        f"SUMMARY:{_esc(LABEL[ev['kind']] + ' · ' + job)}",
        f"DESCRIPTION:{_esc(chr(10).join(x for x in (ev['note'], ev['job_url']) if x))}",
        *where,
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        f"DESCRIPTION:{_esc(LABEL[ev['kind']])}",
        f"TRIGGER:{'-P1D' if ev['kind'] == 'deadline' else '-PT1H'}",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    # Lines longer than 75 octets are folded, as the format requires.
    return "\r\n".join(_fold(x) for x in lines) + "\r\n"


def _fold(line: str) -> str:
    if len(line.encode("utf-8")) <= 75:
        return line
    out: list[str] = []
    cur = ""
    n_bytes = 0
    for ch in line:
        n = len(ch.encode("utf-8"))
        if n_bytes + n > (74 if out else 75):
            out.append(cur)
            cur = ""
            n_bytes = 0
        cur += ch
        n_bytes += n
    out.append(cur)
    return "\r\n ".join(out)
