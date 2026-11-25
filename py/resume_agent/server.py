"""The HTTP API (same routes, JSON shapes and event stream as server/index.ts), on aiohttp."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import math
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

from aiohttp import web

from . import browser
from .agent import focus_run, get_run, is_live, list_runs, live_shot_name, reply, run_steps, similarity, start_run
from .batch import advance, pump, run_now
from .browser import EXTENSION_URL, browser_open, browser_state, close_all, new_visible_page, reconnect
from .cost import call_rmb, sum_rmb, usage_rows
from .db import FILES_DIR, ROOT, SHOTS_DIR, parse_json, run, sql_now
from .discover import search_jobs
from .events import add_client, emit, remove_client
from .jobs import PROGRESS, add_jobs, get_job, job_jd, list_jobs, pipeline_hooks, progress_log, queue_parse, set_job
from .jsutil import js_json, js_number, js_round, js_string, truthy
from .llm import chat_json, get_balance, is_demo, llm_ready, money, set_no_balance
from .prep import DRAFT_KINDS, drafts_view, make_draft, prep_state, prep_view, queue_prep
from .profile import COMMON_QUESTIONS, get_profile, new_id, normalize_profile, pdf_text, save_profile
from .render import resume_html
from .reqs import AUTH_LABEL, DEGREE_LABEL, MATERIAL_LABEL, type_label, years_label
from .schedule import EVENT_LABEL, add_event, delete_event, get_event, ics_for, list_events, next_event, update_event
from .settings import get_settings, public_settings, save_settings
from .sites import login_sites
from .stats import asked_questions, stats
from .tailor import coverage, profile_has, queue_tailor, render_job_files, write_cover_letter

log = logging.getLogger("resume_agent")

LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]"]
JSON_LIMIT = 4 * 1024 * 1024
RAW_LIMIT = 15 * 1024 * 1024

routes = web.RouteTableDef()
_background: set[asyncio.Task] = set()


def _spawn(aw: Awaitable[Any]) -> None:
    """void promise: run in the background, swallow its error."""
    t = asyncio.ensure_future(aw)
    _background.add(t)

    def done(f: asyncio.Future) -> None:
        _background.discard(f)
        if not f.cancelled():
            f.exception()

    t.add_done_callback(done)


def _json(data: Any, status: int = 200) -> web.Response:
    return web.Response(text=js_json(data), status=status, content_type="application/json", charset="utf-8")


def _text(text: str, status: int, content_type: str = "text/html") -> web.Response:
    return web.Response(text=text, status=status, content_type=content_type, charset="utf-8")


# Only answer requests addressed to this machine, and only accept writes from its own pages:
# the API can submit applications and returns personal data.
@web.middleware
async def guard(request: web.Request, handler: Callable[[web.Request], Awaitable[web.StreamResponse]]) -> web.StreamResponse:
    host = re.sub(r":\d+$", "", request.headers.get("Host", ""))
    if host not in LOCAL_HOSTS:
        return _text("forbidden host", 403)
    if request.method not in ("GET", "HEAD"):
        origin = request.headers.get("Origin")
        if origin:
            try:
                h = urlsplit(origin).hostname or ""
                if ":" in h:
                    h = f"[{h}]"
                ok = h in LOCAL_HOSTS
            except ValueError:
                ok = False
            if not ok:
                return _text("forbidden origin", 403)
    # express.json({ limit: "4mb" }) for every route.
    request["body"] = None
    ctype = request.content_type
    if request.can_read_body and (ctype == "application/json" or ctype.endswith("+json")):
        if (request.content_length or 0) > JSON_LIMIT:
            return _text("request entity too large", 413)
        raw = await request.read()
        if len(raw) > JSON_LIMIT:
            return _text("request entity too large", 413)
        if raw.strip():
            try:
                body = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return _text("Bad Request", 400)
            # strict: only objects and arrays
            if not isinstance(body, (dict, list)):
                return _text("Bad Request", 400)
            request["body"] = body
    return await handler(request)


def wrap(fn: Callable[[web.Request], Any]) -> Callable[[web.Request], Awaitable[web.StreamResponse]]:
    async def handler(request: web.Request) -> web.StreamResponse:
        try:
            out = fn(request)
            if inspect.isawaitable(out):
                out = await out
            if isinstance(out, web.StreamResponse):
                return out
            if out is None:
                return web.Response(status=200)
            return _json(out)
        except web.HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("request failed")
            return _json({"error": str(e) or e.__class__.__name__}, 400)

    handler.__name__ = getattr(fn, "__name__", "handler")
    return handler


def _body(request: web.Request) -> Any:
    return request.get("body")


def _obj(request: web.Request) -> dict[str, Any]:
    b = request.get("body")
    return b if isinstance(b, dict) else {}


def _id_of(request: web.Request) -> int | None:
    """Number(req.params.id); an id that is not a whole number matches nothing."""
    n = js_number(request.match_info.get("id", ""))
    return int(n) if math.isfinite(n) and n == int(n) else None


def _numbers(v: Any) -> list[int | None]:
    out = []
    for x in v:
        n = js_number(x)
        out.append(int(n) if math.isfinite(n) and n == int(n) else None)
    return out


def job_view(j: dict[str, Any], has: Callable[[str], bool] | None = None) -> dict[str, Any]:
    if has is None:
        has = profile_has(get_profile())
    runs = list_runs(job_id=j["id"])
    jd = job_jd(j)
    latest = runs[0] if runs else None
    tailored = parse_json(j["tailored"], None)
    applied = j["stage"] == "applied"
    used = usage_rows("WHERE job_id = ?", j["id"])
    return {
        "id": j["id"],
        "url": j["url"],
        "title": j["title"],
        "company": j["company"],
        "location": j["location"],
        "stage": j["stage"],
        "busy": j["busy"],
        "held": j["held"],
        "error": j["error"],
        "notice": j["notice"],
        "autoApply": bool(j["auto_apply"]),
        "createdAt": j["created_at"],
        "updatedAt": j["updated_at"],
        # Jobs applied before tracking existed count as "applied" from their last update.
        "progress": j["progress"] if j["progress"] is not None else ("applied" if applied else None),
        "progressAt": j["progress_at"] if j["progress_at"] is not None else (j["updated_at"] if applied else None),
        "appliedAt": j["applied_at"] if j["applied_at"] is not None else (j["updated_at"] if applied else None),
        "notes": j["notes"] if j["notes"] is not None else "",
        "jd": jd,
        # The posting's keywords your profile already mentions (the rest are what you lack).
        "kwHave": [k for k in jd["keywords"] if has(k)] if jd else [],
        "hasResume": bool(j["resume_file"]),
        "hasCover": bool(j["cover_file"]),
        "coverage": tailored.get("coverage") if tailored else None,
        "warnings": len(tailored.get("warnings") or []) if tailored else 0,
        "tokens": sum(r["prompt_tokens"] + r["completion_tokens"] for r in used),
        # RMB, priced at the time of each call (an estimate from DeepSeek's price list).
        "cost": sum_rmb(used),
        "nextEvent": next_event(j["id"]),
        "hasPrep": bool(j["prep"]),
        "run": {"id": latest["id"], "status": latest["status"], "outcome": latest["outcome"], "steps": latest["steps"], "live": is_live(latest["id"])}
        if latest
        else None,
    }


def _shot_of(run_id: int) -> str | None:
    """The run's latest screenshot, with its time so the browser refetches it when it changes."""
    try:
        st = (SHOTS_DIR / live_shot_name(run_id)).stat()
    except OSError:
        return None
    return f"{live_shot_name(run_id)}?t={st.st_mtime_ns // 1_000_000}"


def run_view(r: dict[str, Any]) -> dict[str, Any]:
    return {**r, "pending": parse_json(r["pending"], None), "live": is_live(r["id"]), "shot": _shot_of(r["id"])}


def _profile_stats() -> dict[str, Any]:
    p = get_profile()
    b = p["basics"]
    return {
        "basics": bool(b["name"] and b["email"] and b["phone"]),
        "sections": len(p["sections"]),
        "bullets": sum(len(e["bullets"]) for s in p["sections"] for e in s["entries"]),
        "facts": len(p["extraFacts"].strip()),
        "answers": len(p["answers"]),
        "answered": len([a for a in p["answers"] if a["a"].strip()]),
    }


# ---- state & settings
@routes.get("/api/state")
@wrap
def api_state(request: web.Request) -> Any:
    return {
        "settings": public_settings(),
        "browserOpen": browser_open(),
        "browser": {**browser_state(), "extensionUrl": EXTENSION_URL},
        "demo": is_demo(),
        "llm": llm_ready(),
        "profile": _profile_stats(),
        "sites": login_sites(),
    }


@routes.get("/api/usage")
@wrap
def api_usage(request: web.Request) -> Any:
    def total(where: str) -> dict[str, Any]:
        rows = usage_rows(where)
        return {
            "calls": len(rows),
            "input": sum(r["prompt_tokens"] for r in rows),
            "output": sum(r["completion_tokens"] for r in rows),
            "cached": sum(r["cache_hit_tokens"] for r in rows),
            "rmb": sum_rmb(rows),
        }

    kinds: dict[str, dict[str, Any]] = {}
    for r in usage_rows():
        k = kinds.setdefault(r["kind"], {"kind": r["kind"], "calls": 0, "tokens": 0, "rmb": 0})
        k["calls"] += 1
        k["tokens"] += r["prompt_tokens"] + r["completion_tokens"]
        k["rmb"] += call_rmb(r)
    return {
        "today": total("WHERE ts >= datetime('now', 'localtime', 'start of day', 'utc')"),
        "month": total("WHERE ts >= datetime('now', 'localtime', 'start of month', 'utc')"),
        "total": total(""),
        "byKind": sorted(kinds.values(), key=lambda k: -k["rmb"]),
    }


_sse_streams: set[asyncio.Queue] = set()


@routes.get("/api/events")
async def api_events(request: web.Request) -> web.StreamResponse:
    res = web.StreamResponse(status=200, headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive"})
    await res.prepare(request)
    q = add_client()
    _sse_streams.add(q)
    try:
        await res.write(b"retry: 2000\n\n")
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), 25)
            except asyncio.TimeoutError:
                msg = ": ping\n\n"
            if msg is None:  # server shutting down
                break
            await res.write(msg.encode("utf-8"))
    except (ConnectionResetError, ConnectionError, asyncio.CancelledError):
        pass
    finally:
        remove_client(q)
        _sse_streams.discard(q)
    return res


def _clamp(v: Any, lo: int, hi: int, or_zero: bool = False) -> int | None:
    n = js_number(v)
    if or_zero and (math.isnan(n) or n == 0):
        n = 0
    if math.isnan(n):
        return None  # JSON.stringify(NaN) stores null, which reads back as the default
    return int(min(hi, max(lo, math.floor(n))))


@routes.put("/api/settings")
@wrap
def api_settings(request: web.Request) -> Any:
    body = _obj(request)
    patch = dict(body)
    if isinstance(body.get("apiKey"), str):
        patch["apiKey"] = body["apiKey"].strip()
    # The extension's status page shows (and its copy button copies) "PLAYWRIGHT_MCP_EXTENSION_TOKEN=…".
    if isinstance(body.get("extensionToken"), str):
        t = re.sub(r"^PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*", "", body["extensionToken"].strip())
        patch["extensionToken"] = re.sub(r"^[\"']|[\"']$", "", t)
    if "concurrency" in patch:
        patch["concurrency"] = _clamp(patch["concurrency"], 1, 4)
    if "minFit" in patch:
        patch["minFit"] = _clamp(patch["minFit"], 0, 100, or_zero=True)
    if "maxSteps" in patch:
        patch["maxSteps"] = _clamp(patch["maxSteps"], 10, 120)
    before = get_settings()
    save_settings(patch)
    # A different browser or token needs a fresh connection (runs in progress are cancelled).
    after = get_settings()
    if after["browserChannel"] != before["browserChannel"] or after["extensionToken"] != before["extensionToken"]:
        _spawn(close_all())
    # Another key, endpoint or mode: the old "balance used up" no longer says anything.
    if after["apiKey"] != before["apiKey"] or after["baseUrl"] != before["baseUrl"] or after["llmMode"] != before["llmMode"]:
        set_no_balance(None)
        _spawn(get_balance(True))
    # Turning the off-peak wait off starts whatever was waiting.
    pump()
    emit("settings")
    return public_settings()


@routes.get("/api/balance")
@wrap
async def api_balance(request: web.Request) -> Any:
    return {"balance": await get_balance()}


@routes.post("/api/llm/resume")
@wrap
async def api_llm_resume(request: web.Request) -> Any:
    """"充好了，继续": checks the balance, then retries what stopped on it (reads; batch jobs go on through the off-peak wait)."""
    b = await get_balance(True)
    if b and not b["available"]:
        raise RuntimeError(f"DeepSeek 显示余额还是不够（{money(b)}），到账后再点")
    set_no_balance(None)
    retried = 0
    for j in list_jobs():
        if not j["error"] or not re.search(r"余额不足|模型接口 402", j["error"]) or j["busy"]:
            continue
        set_job(j["id"], {"error": None})
        if not j["jd"]:
            queue_parse(j["id"])
        elif j["auto_apply"] and j["stage"] not in ("applied", "skipped"):
            advance(j["id"])
        else:
            continue
        retried += 1
    pump()
    return {"retried": retried}


@routes.post("/api/settings/test")
@wrap
async def api_settings_test(request: web.Request) -> Any:
    r = await chat_json('Reply with JSON {"ok": true}.', "ping", 20, {"kind": "test"})
    return {"ok": isinstance(r, dict) and r.get("ok") is True, "model": get_settings()["model"]}


@routes.post("/api/browser/open")
@wrap
async def api_browser_open(request: web.Request) -> Any:
    u = _obj(request).get("url")
    url = u if isinstance(u, str) and re.match(r"^https?://", u) else None
    if url:
        await new_visible_page(url)
    else:
        # Connecting can wait minutes for you to click allow in your browser: answer at once, the
        # status arrives over the event stream.
        _spawn(reconnect())
    return {"ok": True}


# ---- finding jobs: search LinkedIn / MyCareersFuture and list what comes back; adding is a separate step
@routes.post("/api/discover")
@wrap
async def api_discover(request: web.Request) -> Any:
    b = _obj(request)
    qs = b.get("queries") if isinstance(b.get("queries"), list) else []
    queries = [q for q in (("" if x is None else js_string(x)).strip() for x in qs) if q][:8]
    if not queries:
        raise RuntimeError("至少填一个关键词")
    kind = b["kind"] if b.get("kind") in ("parttime", "internship") else "fulltime"
    sources = [x for x in (b.get("sources") if isinstance(b.get("sources"), list) else []) if x in ("linkedin", "mcf")]
    if not sources:
        raise RuntimeError("至少选一个网站")

    def num_or(v: Any, d: int) -> float:
        n = js_number(v) if v is not None else math.nan
        return d if math.isnan(n) or n == 0 else n

    days = min(30, max(1, js_round(num_or(b.get("days"), 7))))
    per_query = min(50, max(10, js_round(num_or(b.get("perQuery"), 25))))
    return await search_jobs(
        {
            "queries": queries,
            "kind": kind,
            "days": days,
            "sources": sources,
            "easyApplyOnly": b.get("easyApplyOnly") is not False,
            "perQuery": per_query,
            "hideSenior": b.get("hideSenior") is not False,
        }
    )


# ---- profile
@routes.get("/api/profile")
@wrap
def api_profile(request: web.Request) -> Any:
    return {"profile": get_profile(), "commonQuestions": COMMON_QUESTIONS}


@routes.put("/api/profile")
@wrap
def api_profile_put(request: web.Request) -> Any:
    p = save_profile(normalize_profile(_body(request)))
    emit("profile")
    return {"profile": p}


@routes.get("/api/profile/resume.html")
async def api_profile_resume(request: web.Request) -> web.StreamResponse:
    return _text(resume_html(get_profile()), 200)


IMPORT_SYSTEM = """Convert a resume into JSON. Copy text faithfully; do not add, embellish or translate anything.
Shape: {"basics":{"name","firstName","lastName","email","phone","phoneCountryCode","location","linkedin","github","website"},
"summary": string,
"sections":[{"heading": string, "entries":[{"title": string (school/company/organisation/project, bold left), "dates": string, "subtitle": string (degree/role), "location": string, "bullets": string[]}]}],
"skills":[{"label": string, "items": string[]}],
"skillsHeading": string, "skillsPosition": number (index of the section the skills block came before)}
Put the technical skills and languages into "skills", not into "sections". A section that is only a list (e.g. awards) is one entry with empty title and the items as bullets."""


@routes.post("/api/profile/import")
async def api_profile_import(request: web.Request) -> web.StreamResponse:
    # express.raw({ type: ["application/pdf", "application/octet-stream"], limit: "15mb" })
    buf = b""
    if request.content_type in ("application/pdf", "application/octet-stream") and request.can_read_body:
        if (request.content_length or 0) > RAW_LIMIT:
            return _text("request entity too large", 413)
        buf = await request.read()
        if len(buf) > RAW_LIMIT:
            return _text("request entity too large", 413)

    async def go(_: web.Request) -> Any:
        if is_demo():
            raise RuntimeError("从 PDF 导入需要模型：先在设置里填 DeepSeek key 并关闭演示模式")
        ready = llm_ready()
        if not ready["ok"]:
            raise RuntimeError(ready["reason"])
        if not buf:
            raise RuntimeError("没收到文件")
        text = await asyncio.to_thread(pdf_text, buf)
        if len(text) < 100:
            raise RuntimeError("PDF 里读不到文字（可能是扫描件）")
        out = await chat_json(IMPORT_SYSTEM, text[:20_000], 6000, {"kind": "import"})
        cur = get_profile()
        draft = normalize_profile({**(out if isinstance(out, dict) else {}), "extraFacts": cur["extraFacts"], "answers": cur["answers"]})
        return {"profile": draft, "text": text}

    return await wrap(go)(request)


# ---- jobs
@routes.get("/api/jobs")
@wrap
def api_jobs(request: web.Request) -> Any:
    has = profile_has(get_profile())
    return {"jobs": [job_view(j, has) for j in list_jobs()]}


@routes.post("/api/jobs")
@wrap
def api_jobs_add(request: web.Request) -> Any:
    b = _obj(request)
    raw = b.get("urls")
    if isinstance(raw, list):
        urls = [js_string(u) for u in raw]
    else:
        urls = re.split(r"\s+", "" if raw is None else js_string(raw))
    jd_text = b["jdText"].strip() if isinstance(b.get("jdText"), str) else ""
    if not [u for u in urls if u.strip()] and not jd_text:
        raise RuntimeError("请粘贴岗位链接或 JD")
    return add_jobs(urls, jd_text, truthy(b.get("autoApply")))


STAGE_LABEL = {"new": "新加入", "parsed": "已读取", "tailored": "简历已改好", "applied": "已投递", "skipped": "已跳过"}
PROG_LABEL = {"applied": "等回音", "screening": "笔试/测评", "interview": "面试中", "offer": "Offer", "rejected": "未通过", "withdrawn": "我放弃了"}
_ZONED = re.compile(r"[zZ]|[+-]\d\d:?\d\d$")


def _local(s: str | None) -> str:
    if not s:
        return ""
    t = s if _ZONED.search(s) else s.replace(" ", "T", 1) + "Z"
    t = t.replace(" ", "T", 1)
    if t.endswith(("z", "Z")):
        t = t[:-1] + "+00:00"
    try:
        d = datetime.fromisoformat(t)
    except ValueError:
        return s
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone().strftime("%Y-%m-%d %H:%M")


def _cell(v: Any) -> str:
    s = "" if v is None else js_string(v)
    return '"' + s.replace('"', '""') + '"' if re.search(r"[\",\n\r]", s) else s


@routes.get("/api/jobs.csv")
async def api_jobs_csv(request: web.Request) -> web.StreamResponse:
    """Everything in the list as a spreadsheet (UTF-8 with BOM so Excel shows Chinese)."""
    rows = [["岗位", "公司", "地点", "链接", "状态", "进展", "投递时间", "进展更新", "下一个日程", "匹配度", "类型", "经验要求", "学历", "申请限制", "要交的材料", "薪资", "备注", "加入时间"]]
    has = profile_has(get_profile())
    for j in list_jobs():
        v = job_view(j, has)
        jd = v["jd"]
        f = jd.get("facts") if jd else None
        ne = v["nextEvent"]
        rows.append(
            [
                v["title"] or "",
                v["company"] or "",
                v["location"] or "",
                v["url"],
                STAGE_LABEL.get(v["stage"], v["stage"]),
                PROG_LABEL.get(v["progress"]) if v["progress"] else "",
                _local(v["appliedAt"]),
                _local(v["progressAt"]),
                f"{EVENT_LABEL[ne['kind']]} {_local(ne['at'])}" if ne else "",
                js_string(jd["fit"]["score"]) if jd and jd.get("fit") else "",
                (type_label(f) or "没写") if f else "",
                ("没写" if f["minYears"] is None else years_label(f["minYears"])) if f else "",
                DEGREE_LABEL.get(f["degree"]) if f and f.get("degree") else "",
                "、".join(
                    x
                    for x in (
                        f.get("workAuth") and AUTH_LABEL.get(f["workAuth"]),
                        f.get("student") == "graduated" and "须已毕业",
                        f.get("student") == "enrolled" and "须在读",
                        jd.get("closed") and "已关闭",
                    )
                    if x
                )
                if f
                else "",
                "、".join(MATERIAL_LABEL.get(m, "") for m in f["materials"]) if f else "",
                (f.get("salary") if f and f.get("salary") is not None else ""),
                v["notes"],
                _local(v["createdAt"]),
            ]
        )
    d = datetime.now()
    body = "﻿" + "\r\n".join(",".join(_cell(c) for c in r) for r in rows)
    return web.Response(
        text=body,
        content_type="text/csv",
        charset="utf-8",
        headers={"Content-Disposition": f'attachment; filename="jobs-{d.strftime("%Y%m%d")}.csv"'},
    )


@routes.get("/api/jobs/{id}")
@wrap
def api_job(request: web.Request) -> Any:
    j = get_job(_id_of(request))
    if not j:
        raise RuntimeError("岗位不存在")
    runs = [run_view(r) for r in list_runs(job_id=j["id"])]
    profile = get_profile()
    jd = job_jd(j)
    return {
        "job": {**job_view(j), "jdText": j["jd_text"], "coverLetter": j["cover_letter"] if j["cover_letter"] is not None else ""},
        "tailored": parse_json(j["tailored"], None),
        "runs": runs,
        "steps": run_steps(runs[0]["id"]) if runs else [],
        "events": list_events(job_id=j["id"]),
        "log": progress_log(j["id"]),
        "prep": prep_view(parse_json(j["prep"], None), profile, jd),
        "drafts": drafts_view(parse_json(j["drafts"], {}), profile, jd),
        **prep_state(j["id"]),
    }


@routes.patch("/api/jobs/{id}")
@wrap
def api_job_patch(request: web.Request) -> Any:
    j = get_job(_id_of(request))
    if not j:
        raise RuntimeError("岗位不存在")
    b = _obj(request)
    patch: dict[str, Any] = {}
    if b.get("stage") in ("skipped", "applied"):
        patch["stage"] = b["stage"]
        patch["held"] = None
    if b.get("stage") == "restore":
        patch["stage"] = "tailored" if j["tailored"] else "parsed" if j["jd"] else "new"
    if isinstance(b.get("jdText"), str):
        patch["jd_text"] = b["jdText"]
    if isinstance(b.get("url"), str):
        patch["url"] = b["url"].strip()
    if isinstance(b.get("notes"), str):
        patch["notes"] = b["notes"][:5000]
    if b.get("progress") in PROGRESS:
        patch["progress"] = b["progress"]
        patch["progress_at"] = sql_now()
        # Recording progress on a job you applied to by hand marks it applied.
        if j["stage"] != "applied":
            patch["stage"] = "applied"
    set_job(j["id"], patch)
    return job_view(get_job(j["id"]))


@routes.delete("/api/jobs/{id}")
@wrap
def api_job_delete(request: web.Request) -> Any:
    id_ = _id_of(request)
    run_ids = [r["id"] for r in list_runs(job_id=id_)] if id_ else []
    for r in list_runs(job_id=id_, active=True) if id_ else []:
        reply(r["id"], {"type": "cancel"})
    run("DELETE FROM jobs WHERE id = ?", id_)
    # Its PDFs and screenshots go too.
    shutil.rmtree(FILES_DIR / f"job-{id_ if id_ is not None else 'NaN'}", ignore_errors=True)
    for f in os.listdir(SHOTS_DIR):
        if any(f.startswith(f"run-{r}-") for r in run_ids):
            try:
                (SHOTS_DIR / f).unlink()
            except OSError:
                pass
    emit("job", id_)
    return {"ok": True}


# A button on one job runs now, even while batch work waits for off-peak; it takes the job out of the wait.
@routes.post("/api/jobs/{id}/parse")
@wrap
def api_job_parse(request: web.Request) -> Any:
    set_job(_id_of(request), {"held": None})
    queue_parse(_id_of(request))
    return {"ok": True}


@routes.post("/api/jobs/{id}/tailor")
@wrap
def api_job_tailor(request: web.Request) -> Any:
    set_job(_id_of(request), {"held": None})
    queue_tailor(_id_of(request))
    return {"ok": True}


@routes.post("/api/jobs/{id}/cover-letter")
@wrap
async def api_job_cover(request: web.Request) -> Any:
    return {"text": (await write_cover_letter(_id_of(request)))["text"]}


@routes.post("/api/jobs/{id}/apply")
@wrap
def api_job_apply(request: web.Request) -> Any:
    run_id = start_run(_id_of(request))
    set_job(_id_of(request), {"notice": None, "held": None})
    return {"runId": run_id}


@routes.post("/api/jobs/pipeline")
@wrap
def api_pipeline(request: web.Request) -> Any:
    """Whatever is left for each job: read → tailor → fill (the last two wait for off-peak when that is on)."""
    b = _obj(request)
    ids = _numbers(b["ids"]) if isinstance(b.get("ids"), list) else []
    for id_ in ids:
        j = get_job(id_)
        if not j or j["busy"] or j["held"] or j["stage"] in ("applied", "skipped"):
            continue
        # You picked these by hand, so a low fit score does not stop them.
        set_job(id_, {"auto_apply": 1, "notice": None})
        if not j["jd"]:
            queue_parse(id_)
        else:
            advance(id_)
    return {"ok": True}


@routes.post("/api/jobs/run-now")
@wrap
def api_run_now(request: web.Request) -> Any:
    """"现在就跑" on jobs waiting for off-peak: these ids, or all of them."""
    b = _obj(request)
    run_now(_numbers(b["ids"]) if isinstance(b.get("ids"), list) else None)
    return {"ok": True}


def _after_parse(id_: int) -> None:
    j = get_job(id_)
    if not j:
        return
    jd = job_jd(j)
    if jd and jd.get("closed"):
        return
    min_fit = get_settings()["minFit"]
    if min_fit > 0 and jd and jd.get("fit") and jd["fit"]["score"] < min_fit:
        set_job(id_, {"auto_apply": 0, "notice": f"匹配度 {js_string(jd['fit']['score'])}，低于你设的 {js_string(min_fit)} 分，所以没有自动改简历和投递"})
        return
    advance(id_)


pipeline_hooks["afterParse"] = _after_parse


@routes.put("/api/jobs/{id}/tailored")
@wrap
async def api_job_tailored(request: web.Request) -> Any:
    j = get_job(_id_of(request))
    if not j:
        raise RuntimeError("岗位不存在")
    t = parse_json(j["tailored"], None)
    if not t:
        raise RuntimeError("还没有定制简历")
    b = _body(request)
    if not isinstance(b, dict):
        raise RuntimeError("Cannot read properties of undefined (reading 'doc')")
    src = b.get("doc") if isinstance(b.get("doc"), dict) else {}
    doc = normalize_profile({**src, "extraFacts": "", "answers": []})
    nxt = {
        **t,
        "doc": {
            "basics": t["doc"]["basics"],
            "summary": doc["summary"],
            "sections": doc["sections"],
            "skills": doc["skills"],
            "skillsHeading": doc["skillsHeading"],
            "skillsPosition": doc["skillsPosition"],
        },
    }
    nxt["coverage"] = {**t["coverage"], "after": coverage(nxt["doc"], t["coverage"]["keywords"])}
    set_job(j["id"], {"tailored": js_json(nxt), "cover_letter": b["coverLetter"] if isinstance(b.get("coverLetter"), str) else j["cover_letter"]})
    await render_job_files(j["id"])
    return {"ok": True}


@routes.get("/api/jobs/{id}/resume.html")
async def api_job_resume_html(request: web.Request) -> web.StreamResponse:
    j = get_job(_id_of(request))
    t = parse_json(j["tailored"], None) if j else None
    if not t:
        return _text("还没有定制简历", 404)
    scale = t.get("scale")
    return _text(resume_html(t["doc"], scale if scale is not None else 1), 200)


def _file_route(col: str) -> Callable[[web.Request], Awaitable[web.StreamResponse]]:
    async def handler(request: web.Request) -> web.StreamResponse:
        j = get_job(_id_of(request))
        file = j[col] if j else None
        if not file or not Path(file).exists():
            return _text("not found", 404)
        mode = "attachment" if request.query.get("download") else "inline"
        return web.FileResponse(file, headers={"Content-Disposition": f'{mode}; filename="{Path(file).name}"'})

    return handler


routes.get("/api/jobs/{id}/resume.pdf")(_file_route("resume_file"))
routes.get("/api/jobs/{id}/cover.pdf")(_file_route("cover_file"))


# ---- schedule (interviews, tests, deadlines)
@routes.get("/api/schedule")
@wrap
def api_schedule(request: web.Request) -> Any:
    return {"events": list_events(upcoming=request.query.get("upcoming") == "1")}


@routes.post("/api/jobs/{id}/schedule")
@wrap
def api_schedule_add(request: web.Request) -> Any:
    return {"id": add_event(_id_of(request), _obj(request))}


@routes.patch("/api/schedule/{id}")
@wrap
def api_schedule_patch(request: web.Request) -> Any:
    update_event(_id_of(request), _obj(request))
    return {"ok": True}


@routes.delete("/api/schedule/{id}")
@wrap
def api_schedule_delete(request: web.Request) -> Any:
    delete_event(_id_of(request))
    return {"ok": True}


@routes.get("/api/schedule/{id}/calendar.ics")
async def api_schedule_ics(request: web.Request) -> web.StreamResponse:
    ev = get_event(_id_of(request))
    if not ev:
        return _text("not found", 404)
    return web.Response(
        text=ics_for(ev),
        content_type="text/calendar",
        charset="utf-8",
        headers={"Content-Disposition": f'attachment; filename="event-{ev["id"]}.ics"'},
    )


# ---- after applying: interview prep, email drafts, stats
@routes.post("/api/jobs/{id}/prep")
@wrap
def api_prep(request: web.Request) -> Any:
    queue_prep(_id_of(request))
    return {"ok": True}


@routes.post("/api/jobs/{id}/draft")
@wrap
async def api_draft(request: web.Request) -> Any:
    b = _obj(request)
    kind = b.get("kind")
    if kind not in DRAFT_KINDS:
        raise RuntimeError("bad kind")
    extra = b["extra"].strip()[:1000] if isinstance(b.get("extra"), str) else ""
    return {"draft": await make_draft(_id_of(request), kind, extra)}


@routes.get("/api/stats")
@wrap
def api_stats(request: web.Request) -> Any:
    return stats()


@routes.get("/api/profile/asked")
@wrap
def api_asked(request: web.Request) -> Any:
    return {"asked": asked_questions(similarity, get_profile()["answers"])}


# ---- runs
@routes.get("/api/runs")
@wrap
def api_runs(request: web.Request) -> Any:
    return {"runs": [run_view(r) for r in list_runs(active=request.query.get("active") == "1")]}


@routes.get("/api/runs/{id}")
@wrap
def api_run(request: web.Request) -> Any:
    id_ = _id_of(request)
    r = next((x for x in list_runs() if x["id"] == id_), None)
    if not r:
        raise RuntimeError("没有这条记录")
    return {"run": run_view(r), "steps": run_steps(r["id"])}


@routes.post("/api/runs/{id}/reply")
@wrap
def api_run_reply(request: web.Request) -> Any:
    body = _body(request)
    if not isinstance(body, dict) or body.get("type") not in ("answer", "resume", "confirm", "revise", "cancel"):
        raise RuntimeError("bad reply")
    r = get_run(_id_of(request))
    if not r:
        raise RuntimeError("没有这条记录")
    if body["type"] == "confirm" and r["status"] != "awaiting_confirm":
        raise RuntimeError("这份申请现在不在等确认")
    if not reply(r["id"], body):
        raise RuntimeError("这次填写已经结束了")
    return {"ok": True}


@routes.post("/api/runs/{id}/focus")
@wrap
async def api_run_focus(request: web.Request) -> Any:
    return {"ok": await focus_run(_id_of(request))}


@routes.get("/api/shots/{name}")
async def api_shot(request: web.Request) -> web.StreamResponse:
    name = request.match_info["name"]
    if not re.match(r"^[\w.-]+$", name, re.ASCII):
        return web.Response(status=400)
    file = SHOTS_DIR / name
    if not file.is_file():
        return web.Response(status=404)
    return web.FileResponse(file)


# ---- profile helpers for the UI
@routes.post("/api/profile/answers")
@wrap
def api_profile_answers(request: web.Request) -> Any:
    b = _obj(request)
    p = get_profile()
    q = ("" if b.get("q") is None else js_string(b["q"])).strip()
    if not q:
        raise RuntimeError("问题不能为空")
    p["answers"].append({"id": new_id("qa"), "q": q, "a": "" if b.get("a") is None else js_string(b["a"])})
    save_profile(p)
    emit("profile")
    return {"profile": p}


DIST = ROOT / "dist"


def _spa(dist: Path) -> Callable[[web.Request], Awaitable[web.StreamResponse]]:
    root = dist.resolve()

    async def handler(request: web.Request) -> web.StreamResponse:
        path = request.match_info.get("tail", "")
        if request.path.startswith("/api/"):
            return _text(f"Cannot {request.method} {request.path}", 404)
        if path:
            target = (root / path).resolve()
            if target.is_relative_to(root):
                if target.is_file():
                    return web.FileResponse(target)
                if target.is_dir() and (target / "index.html").is_file():
                    return web.FileResponse(target / "index.html")
        return web.FileResponse(root / "index.html")

    return handler


async def _pump_loop() -> None:
    # Held steps start when off-peak begins (and as slots free up); also picks up jobs held before a restart.
    while True:
        await asyncio.sleep(10)
        try:
            pump()
        except Exception:  # noqa: BLE001
            log.exception("pump")


async def _on_startup(app: web.Application) -> None:
    pump()
    app["pump"] = asyncio.ensure_future(_pump_loop())
    # Know about an empty balance before the first job runs into it (the balance endpoint is free).
    _spawn(get_balance(True))


async def _on_shutdown(app: web.Application) -> None:
    for q in list(_sse_streams):
        q.put_nowait(None)
    t = app.get("pump")
    if t:
        t.cancel()


async def _on_cleanup(app: web.Application) -> None:
    await browser.shutdown()


def make_app() -> web.Application:
    app = web.Application(middlewares=[guard], client_max_size=RAW_LIMIT + 1024 * 1024)
    app.add_routes(routes)
    # ---- static: the test job pages and, in production, the built UI
    app.router.add_static("/fixtures", ROOT / "fixtures")
    if DIST.exists():
        app.router.add_get("/{tail:.*}", _spa(DIST))
    app.on_startup.append(_on_startup)
    app.on_shutdown.append(_on_shutdown)
    app.on_cleanup.append(_on_cleanup)
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    port = int(js_number(os.environ.get("PORT", "8791")))
    if sys.platform == "win32":
        # Playwright needs subprocess support: the Proactor loop (the default since 3.8) has it.
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    suffix = " (serving the built UI)" if DIST.exists() else ""
    web.run_app(
        make_app(),
        host="127.0.0.1",
        port=port,
        print=lambda *_: print(f"resume-agent API (Python) on http://127.0.0.1:{port}{suffix}", flush=True),
        shutdown_timeout=5,
    )
