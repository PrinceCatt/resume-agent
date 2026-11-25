"""The application agent: looks at the page, asks the model what to do, does it, repeats.
It never clicks a final submit on its own: it stops at request_submit and waits for you."""

from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable

from . import browser
from .db import SHOTS_DIR, all_rows, get, iso_now, parse_json, run
from .events import emit
from .jobs import get_job, job_jd, set_job
from .jsutil import js_json, js_number
from .llm import chat, is_demo, llm_ready
from .mock import MockMemory, mock_decide, new_mock_memory
from .observe import DELTA_MARK, format_delta, format_obs, locate, observe
from .profile import get_profile, new_id, profile_for_prompt, save_profile
from .settings import get_settings
from .sites import is_check_page, site_for
from .tailor import render_job_files, render_master_files, write_cover_letter
from .tasks import make_queue


class Live:
    def __init__(self) -> None:
        self.page: Any = None
        # Set once the run has had to bring its tab to the front (noted in the log the first time).
        self.brought_front = False
        # Every tab this run opened in your browser (its own tab and the apply popups), closed together when it is done.
        self.tabs: list[Any] = []
        self.waiter: asyncio.Future | None = None
        self.cancelled = False
        self.filled = 0
        self.submit_clicked = False
        self.mock: MockMemory = new_mock_memory()


class Cancelled(Exception):
    pass


class BrowserGone(Exception):
    pass


live: dict[int, Live] = {}
run_queue = make_queue(lambda: get_settings()["concurrency"])

# A restart loses the browser tabs, so anything that was mid-flight is over.
run(
    "UPDATE runs SET status = 'interrupted', pending = NULL, outcome = COALESCE(outcome, '程序重启，这次填写中断了'), finished_at = datetime('now') WHERE status IN ('queued','running','need_user','awaiting_confirm')",
)


def _resolve(l: Live, r: dict[str, Any]) -> None:
    if l.waiter is not None and not l.waiter.done():
        l.waiter.set_result(r)


def _on_browser_closed() -> None:
    for id_, l in list(live.items()):
        l.cancelled = True
        _resolve(l, {"type": "cancel"})
        add_step(id_, "error", "和浏览器的连接断开了（浏览器关掉了、扩展被停用，或在设置里换了浏览器）")


browser.on_browser_closed(_on_browser_closed)


def get_run(id_: int) -> dict[str, Any] | None:
    return get("SELECT * FROM runs WHERE id = ?", id_)


def set_run(id_: int, patch: dict[str, Any]) -> None:
    keys = list(patch.keys())
    run(f"UPDATE runs SET {', '.join(f'{k} = ?' for k in keys)}, updated_at = datetime('now') WHERE id = ?", *[patch[k] for k in keys], id_)
    emit("run", id_)


def add_step(run_id: int, kind: str, text: str) -> None:
    """kind: action | ask | note | error | guard | model"""
    run("INSERT INTO run_steps (run_id, kind, text) VALUES (?, ?, ?)", run_id, kind, text[:1000])
    emit("run", run_id)


def run_steps(run_id: int) -> list[dict[str, Any]]:
    return all_rows("SELECT id, ts, kind, text FROM run_steps WHERE run_id = ? ORDER BY id", run_id)


ACTIVE = ["queued", "running", "need_user", "awaiting_confirm"]


def run_slot_free() -> bool:
    """Whether a new run would start filling right away instead of waiting in the queue."""
    return run_queue.size() < max(1, get_settings()["concurrency"])


def start_run(job_id: int) -> int:
    ready = llm_ready()
    if not ready["ok"]:
        raise RuntimeError(ready["reason"])
    job = get_job(job_id)
    if not job:
        raise RuntimeError("岗位不存在")
    if not job["url"]:
        raise RuntimeError("这个岗位没有链接，没法自动投递")
    existing = get(f"SELECT * FROM runs WHERE job_id = ? AND status IN ({','.join('?' for _ in ACTIVE)})", job_id, *ACTIVE)
    if existing:
        return existing["id"]
    id_ = run("INSERT INTO runs (job_id) VALUES (?)", job_id)["id"]
    live[id_] = Live()
    emit("run", id_)
    run_queue.push(lambda: _exec_run(id_))
    return id_


def reply(run_id: int, r: dict[str, Any]) -> bool:
    l = live.get(run_id)
    if not l:
        return False
    if r.get("type") == "cancel":
        l.cancelled = True
        if not l.waiter:
            # Not waiting on you: it stops at the next step.
            set_run(run_id, {"status": "cancelled", "pending": None, "finished_at": iso_now()})
    if not l.waiter:
        return r.get("type") == "cancel"
    w = l.waiter
    l.waiter = None
    if not w.done():
        w.set_result(r)
    return True


async def focus_run(run_id: int) -> bool:
    l = live.get(run_id)
    p = l.page if l else None
    if not p or p.is_closed():
        return False
    await p.bring_to_front()
    return True


async def _wait_for_user(run_id: int, l: Live, status: str, pending: dict[str, Any]) -> dict[str, Any]:
    set_run(run_id, {"status": status, "pending": js_json(pending)})
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    l.waiter = fut
    r = await fut
    if r.get("type") == "cancel":
        raise Cancelled()
    set_run(run_id, {"status": "running", "pending": None})
    return r


def _tool(name: str, description: str, properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "function", "function": {"name": name, "description": description, "parameters": {"type": "object", "properties": properties, "required": list(properties.keys())}}}


TOOLS = [
    _tool("fill", "Type a value into a text input, textarea or editable field (replaces what is there).", {"id": {"type": "string"}, "value": {"type": "string"}}),
    _tool("select", "Choose an option of a native <select> by its visible text.", {"id": {"type": "string"}, "option": {"type": "string"}}),
    _tool(
        "choose",
        "For searchable dropdowns/autocomplete (kind=combobox, location/school pickers): types the text and clicks the best matching suggestion.",
        {"id": {"type": "string"}, "text": {"type": "string"}},
    ),
    _tool("check", "Tick or untick a checkbox, or pick a radio button (checked=true).", {"id": {"type": "string"}, "checked": {"type": "boolean"}}),
    _tool("click", "Click a button, link or option. Ends the turn (the page may change). Final submit buttons are blocked: use request_submit.", {"id": {"type": "string"}}),
    _tool("upload", "Attach a file to a file input or to an upload button.", {"id": {"type": "string"}, "file": {"type": "string", "enum": ["resume", "cover_letter"]}}),
    _tool(
        "write_cover_letter",
        "The form asks for a cover letter (upload or text box) and FILES says none is available: writes one from the profile. Returns its text; afterwards upload(file=cover_letter) works.",
        {},
    ),
    _tool("scroll", "Scroll the page to load more content.", {"direction": {"type": "string", "enum": ["down", "up"]}}),
    _tool("wait", "Wait for the page (max 10 s).", {"seconds": {"type": "number"}}),
    _tool("goto", "Open a URL in this tab (e.g. the application link found on the page).", {"url": {"type": "string"}}),
    _tool(
        "ask_user",
        "Ask the candidate for information a REQUIRED field needs that is not in the profile/answers. Question in Simplified Chinese.",
        {"question": {"type": "string"}, "field_label": {"type": "string", "description": "The form field's label, verbatim"}},
    ),
    _tool(
        "need_manual",
        "Hand over to the human for sign-in, account creation, passwords, verification codes, CAPTCHAs, or when stuck. Reason in Simplified Chinese.",
        {"reason": {"type": "string"}},
    ),
    _tool(
        "request_submit",
        "Everything required is filled: ask the candidate to approve clicking the final submit button.",
        {
            "id": {"type": "string", "description": "id of the final submit/apply/send button"},
            "summary": {"type": "string", "description": "Simplified Chinese: what was filled, anything uncertain, consent boxes ticked"},
        },
    ),
    _tool(
        "finish",
        "End this application.",
        {
            "outcome": {"type": "string", "enum": ["submitted", "already_applied", "closed", "failed"]},
            "note": {"type": "string", "description": "Simplified Chinese"},
        },
    ),
]


def _nz(*vals: Any) -> Any:
    """a ?? b ?? c"""
    for v in vals:
        if v is not None:
            return v
    return None


def _agent_system(profile: dict[str, Any], job: dict[str, Any], tailored: dict[str, Any] | None) -> str:
    jd = job_jd(job)
    answers = "\n".join(f"- Q: {a['q']}\n  A: {a['a'].strip() or '(unknown — ask if a required field needs it)'}" for a in profile["answers"])
    title = _nz(jd.get("title") if jd else None, job["title"], "")
    company = _nz(jd.get("company") if jd else None, job["company"], "")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    resume = Path(job["resume_file"]).name if job["resume_file"] else "not available"
    cover = Path(job["cover_file"]).name if job["cover_file"] else "not available"
    summary = (tailored or {}).get("doc", {}).get("summary") if tailored else ""
    summary_block = f"\nRESUME SUMMARY LINE\n{summary}" if summary else ""
    # Same for every application up to JOB (the date sits there too), so DeepSeek serves the rules and the
    # profile from its cache on the next application as well, not only on the next step.
    return f"""You fill in a job application form in a real browser on behalf of the candidate below. The candidate approves the final submission; you never submit on your own.

HOW YOU WORK
- Each turn you get a snapshot of the current page: interactive elements with ids like [f0_12], their labels, current values and options. When the page kept its layout, you get only the elements that changed since the last full snapshot; the rest is as that snapshot shows. Act only through the tools, with ids from the LATEST snapshot. Several tools per turn are fine (e.g. fill all simple fields at once); a click ends the turn.
- On a job description page, click the button or link that starts the application (Apply / Easy Apply / Apply now / 申请 / 投递).
- Sign-in, account creation, passwords, verification codes, CAPTCHAs, Singpass, or anything else only the human can do: call need_manual with a short Chinese explanation. Never type passwords. Never try to get around a CAPTCHA.
- If there is a resume/CV upload, upload the resume first: many forms auto-fill from it. Then check and correct the auto-filled values against the profile.
- Fill fields only with facts from CANDIDATE PROFILE and ANSWERS. Never guess or invent (dates, salary, GPA, addresses, ID numbers, referees…).
- "How many years of (work) experience with X": use a saved answer if there is one; otherwise count only the dated jobs, internships and projects in CANDIDATE PROFILE that used X, in whole years rounded DOWN (a few months is 0). Study and coursework are not work experience. Never round up to look better; if you are unsure, ask_user.
- "Have you completed / do you have a <degree or level of education>": Yes only if CANDIDATE PROFILE shows that qualification finished before today. A degree still in progress (graduation date after today) is No, even if it is the level asked about; say "in progress, graduating <date>" where there is a text box for it. A value the site pre-filled or remembered is not evidence either way: check it against the profile like any other value.
- If a REQUIRED field needs something that is not there, call ask_user (Chinese question, field_label = the field's label verbatim). Leave optional fields you have no facts for empty.
- Voluntary demographic questions (gender, race, veteran, disability): use ANSWERS if present, otherwise the "decline / prefer not to say" option.
- Required consent checkboxes (privacy notice, data processing, declaration that the information is accurate) may be ticked; list them in your request_submit summary. Leave optional marketing/newsletter boxes unticked.
- type=date inputs take YYYY-MM-DD. Look for a separate country-code field before typing a phone number.
- Native select → select. Searchable dropdowns and autocompletes (kind=combobox, or a text box that pops suggestions like Location/School) → choose.
- Cover letter: upload the cover_letter file to a cover-letter upload; paste COVER LETTER text into a cover-letter text box. If the form asks for a cover letter (required, or an optional field the posting itself asks for) and none is available, call write_cover_letter, then upload or paste it. Do not write one for an optional field nobody asked for.
- Multi-step forms: complete the step, then click Next / Continue / Review.
- When everything required is filled and only the final submit/send/apply button remains, call request_submit with that button's id and a Chinese summary. The click tool blocks final submits.
- After approval the system clicks it. If the next snapshot shows a confirmation/thank-you message, call finish(outcome="submitted"). If it shows validation errors, fix them and call request_submit again.
- Job closed → finish("closed"). Already applied → finish("already_applied"). Stuck after a few attempts → need_manual explaining the problem in Chinese.

CANDIDATE PROFILE
{profile_for_prompt(profile, with_ids=False)}

EXTRA FACTS (true, may be used to answer questions)
{profile['extraFacts'] or '(none)'}

ANSWERS
{answers or '(none)'}

JOB
{title} at {company} — {job['url']}
Today is {today}.

FILES FOR upload
- resume: {resume}
- cover_letter: {cover}

COVER LETTER TEXT
{(job['cover_letter'] or '').strip() or '(none)'}
{summary_block}"""


STRONG_SUBMIT = re.compile(
    r"\bsubmit\b|send application|complete (my )?application|finish application|confirm (and )?(send|apply)|提交|投递|确认申请|发送简历|立即沟通|^send$|^发送$",
    re.I,
)
STEP_WORDS = re.compile(r"\bnext\b|continue|review|save|search|upload|attach|add|下一步|继续|保存|搜索|上传|添加", re.I)


def is_final_submit(el: dict[str, Any], filled: int) -> bool:
    """True when clicking this would plausibly send the application. Errs towards asking you."""
    label = f"{el['text']} {el['label']}".strip()
    if STRONG_SUBMIT.search(label):
        return True
    if filled > 0 and re.search(r"\bapply\b|申请", label, re.I):
        return True
    if filled > 0 and el.get("submitType") and not STEP_WORDS.search(label):
        return True
    return False


async def _settle(page: Any) -> None:
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=15_000)
    except Exception:  # noqa: BLE001
        pass
    await page.wait_for_timeout(700)


def _swallow(t: asyncio.Future) -> None:
    if not t.cancelled():
        t.exception()


async def within(aw: Awaitable[Any], ms: int, what: str) -> Any:
    """Raises if `aw` takes longer than `ms` (the call itself keeps running; its result is ignored)."""
    task = asyncio.ensure_future(aw)
    try:
        return await asyncio.wait_for(asyncio.shield(task), ms / 1000)
    except asyncio.TimeoutError:
        task.add_done_callback(_swallow)
        raise RuntimeError(f"{what} timed out after {ms / 1000:g}s") from None


async def _ensure_visible(run_id: int, l: Live, page: Any) -> None:
    """Brings the run's tab to the front if it is hidden. The tab lives in your own browser, and a
    background tab gets no animation frames: Playwright's clicks then wait forever for the element
    to be "stable" and a mouse-wheel scroll never returns. Costs nothing while you are watching the tab."""
    try:
        state = await within(page.evaluate("() => document.visibilityState"), 5000, "visibility check")
    except Exception:  # noqa: BLE001
        state = "unknown"
    if state == "visible":
        return
    try:
        await page.bring_to_front()
    except Exception:  # noqa: BLE001
        pass
    await page.wait_for_timeout(400)
    if not l.brought_front:
        l.brought_front = True
        add_step(run_id, "note", "助手的标签页在后台，已切到前台（后台标签页浏览器会暂停渲染，点击和滚动会卡住）")


def similarity(a: str, b: str) -> float:
    na = re.sub(r"\s+", " ", a.lower()).strip()
    nb = re.sub(r"\s+", " ", b.lower()).strip()
    if not na or not nb:
        return 0
    if na == nb:
        return 1
    if nb.startswith(na) or na.startswith(nb):
        return 0.9
    if na in nb or nb in na:
        return 0.8
    ta = {t for t in re.split(r"[^a-z0-9一-鿿]+", na) if t}
    tb = {t for t in re.split(r"[^a-z0-9一-鿿]+", nb) if t}
    inter = len([t for t in ta if t in tb])
    return (0.7 * inter) / max(len(ta), len(tb)) if inter else 0


def best_match(want: str, options: list[str]) -> int:
    best = -1
    score = 0.0
    for i, o in enumerate(options):
        s = similarity(want, o)
        if s > score:
            score = s
            best = i
    return best if score >= 0.3 else -1


def _review_fields(obs: dict[str, Any]) -> list[dict[str, str]]:
    out = []
    for e in obs["elements"]:
        if e["kind"] in ("button", "link", "option"):
            continue
        if e["kind"] == "radio":
            if e["checked"]:
                out.append({"label": e["group"] or "选项", "value": e["label"]})
        elif e["kind"] == "checkbox":
            if e["checked"]:
                out.append({"label": e["group"] or "勾选", "value": e["label"]})
        elif e["value"]:
            out.append({"label": e["label"] or e["kind"], "value": e["value"]})
    return out


async def _exec_run(run_id: int) -> None:
    l = live[run_id]
    try:
        if l.cancelled:
            raise Cancelled()
        set_run(run_id, {"status": "running"})
        job = get_job(get_run(run_id)["job_id"])
        if not job["resume_file"] or not Path(job["resume_file"]).exists():
            add_step(run_id, "note", "重新生成简历 PDF" if job["tailored"] else "还没定制简历，先用资料库原版生成 PDF")
            if job["tailored"]:
                await render_job_files(job["id"])
            else:
                await render_master_files(job["id"])
            job = get_job(job["id"])
        settings = get_settings()
        demo = is_demo()
        tailored = parse_json(job["tailored"], None)
        profile = get_profile()

        page = await browser.new_visible_page()
        l.page = page
        l.tabs.append(page)

        def follow(p: Any) -> None:
            def on_popup(np: Any) -> None:
                l.page = np
                l.tabs.append(np)
                follow(np)
                add_step(run_id, "note", "申请页在新标签页打开，已切换过去")

                # Some apply forms (Indeed's) close their tab when done: carry on in the tab that opened it.
                def on_close(_: Any = None) -> None:
                    if l.page is np and not p.is_closed():
                        l.page = p
                        add_step(run_id, "note", "那个标签页关掉了，回到原来的页面")

                np.on("close", on_close)

            p.on("popup", on_popup)

        follow(page)
        add_step(run_id, "action", f"打开 {job['url']}")
        await page.goto(job["url"], wait_until="domcontentloaded", timeout=45_000)

        messages: list[dict[str, Any]] = [{"role": "system", "content": _agent_system(profile, job, tailored)}]
        noted: set[str] = set()
        base: dict[str, Any] | None = None
        # After a turn that scrolled or failed the model may be looking for a button the snapshot left out:
        # the next snapshot lists every ordinary button and link.
        more = False
        idle = 0
        # Turns in a row that only scrolled or waited (or whose actions all failed).
        stuck = 0
        for step in range(1, settings["maxSteps"] + 1):
            if l.cancelled:
                raise Cancelled()
            pg = l.page
            if pg.is_closed():
                raise BrowserGone()
            await _ensure_visible(run_id, l, pg)
            await _settle(pg)
            await _snapshot(run_id, pg)
            try:
                obs = await within(observe(pg, more), 30_000, "reading the page")
            except (Cancelled, BrowserGone):
                raise
            except Exception:  # noqa: BLE001
                await _ensure_visible(run_id, l, pg)
                obs = await within(observe(pg, more), 30_000, "reading the page")
            # A bot check ("Just a moment...") is yours to pass; asking the model about it only wastes a step.
            if is_check_page(obs["title"], obs["excerpt"]):
                s = site_for(obs["url"])
                name = s["name"] if s else "网站"
                add_step(run_id, "ask", f"需要你手动处理：{name}在做人机验证")
                try:
                    await pg.bring_to_front()
                except Exception:  # noqa: BLE001
                    pass
                await _wait_for_user(
                    run_id, l, "need_user", {"kind": "manual", "reason": f"{name}在做人机验证：请在浏览器里助手开的那个标签页上自己完成，然后点「处理好了，继续」。"}
                )
                add_step(run_id, "note", "你处理完了，继续")
                continue
            # What this site's flow usually looks like, the first time one of its pages is open.
            site = site_for(obs["url"])
            if site and site["key"] not in noted:
                noted.add(site["key"])
                messages.append(
                    {
                        "role": "user",
                        "content": f"SITE NOTES — you are now on {site['name']}. Hints from earlier use of this site; the page in front of you wins if it differs.\n{site['playbook']}",
                    }
                )
                if step > 1:
                    add_step(run_id, "note", f"进入 {site['name']}")
            # Same layout as the last full snapshot: only what changed, and the full one stays (cached). Otherwise a
            # full snapshot, and the older ones are dropped (they would cost tokens and confuse ids).
            delta = format_delta(base["obs"], obs, base["step"], step) if base else None
            if delta:
                for m in messages:
                    if m["role"] == "user" and m["content"].startswith("STEP ") and DELTA_MARK in m["content"]:
                        m["content"] = "(older update omitted)"
                messages.append({"role": "user", "content": delta})
            else:
                for m in messages:
                    if m["role"] == "user" and m["content"].startswith("STEP "):
                        m["content"] = "(older snapshot omitted)"
                messages.append({"role": "user", "content": format_obs(obs, step)})
                base = {"obs": obs, "step": step}

            content = ""
            if demo:
                profile = get_profile()
                calls = mock_decide(obs, profile, job, l.mock)
            else:
                r = await chat(messages=messages, tools=TOOLS, max_tokens=2500, usage={"jobId": job["id"], "kind": "apply"})
                calls = r["toolCalls"]
                content = r["content"]
            if l.cancelled:
                raise Cancelled()
            if content.strip():
                add_step(run_id, "model", content.strip())
            if not calls:
                messages.append({"role": "assistant", "content": content or "(no action)"})
                idle += 1
                if idle >= 3:
                    raise RuntimeError("模型连续几步没有动作")
                messages.append({"role": "user", "content": "Use the tools to act. If you are done or stuck, call finish or need_manual."})
                continue
            idle = 0
            messages.append({"role": "assistant", "content": content or None, "tool_calls": calls})

            end_turn = False
            finished: dict[str, str] | None = None
            progressed = False
            # You may have switched tabs while the model was thinking.
            if l.page and not l.page.is_closed():
                await _ensure_visible(run_id, l, l.page)
            for c in calls:
                if end_turn or finished:
                    result = "Skipped: an earlier action ended this turn; look at the new snapshot."
                else:
                    # Tools that wait for you have no time limit; everything that acts on the page does, so
                    # a stuck browser call can't hold the run (and its slot in the queue) forever.
                    # Writing a cover letter is a model call plus a PDF, not a page action: it gets no page limit either.
                    name = c["function"]["name"]
                    waits_for_you = name in ("ask_user", "need_manual", "request_submit", "finish", "write_cover_letter")
                    if waits_for_you:
                        out = await _exec_tool(run_id, l, c, obs, job)
                    else:
                        try:
                            out = await within(_exec_tool(run_id, l, c, obs, job), 60_000, name)
                        except (Cancelled, BrowserGone):
                            raise
                        except Exception as e:  # noqa: BLE001
                            add_step(run_id, "error", f"{name} 卡住了 60 秒，跳过")
                            out = {"result": f"ERROR: {e}. Look at the new snapshot before trying again.", "endTurn": True}
                    result = out["result"]
                    end_turn = out["endTurn"]
                    finished = out.get("finished")
                    if name not in ("scroll", "wait") and not result.startswith("ERROR") and not result.startswith("BLOCKED"):
                        progressed = True
                messages.append({"role": "tool", "tool_call_id": c["id"], "content": result})
            more = any(c["function"]["name"] == "scroll" for c in calls) or any(
                m["role"] == "tool" and m["content"].startswith("ERROR") for m in messages[-len(calls) :]
            )
            # A test run once scrolled 40 times looking for a button the snapshot had dropped.
            stuck = 0 if progressed else stuck + 1
            if stuck >= 8:
                raise RuntimeError("连续 8 步只在滚动、等待或出错，没有进展，停下了；浏览器里的页面保留着，你可以接手")
            set_run(run_id, {"steps": step})
            if finished:
                ok = finished["outcome"] in ("submitted", "already_applied")
                set_run(
                    run_id,
                    {
                        "status": "submitted" if finished["outcome"] == "submitted" else "finished" if ok else "failed",
                        "outcome": finished["note"] or finished["outcome"],
                        "pending": None,
                        "finished_at": iso_now(),
                    },
                )
                if ok:
                    set_job(job["id"], {"stage": "applied"})
                add_step(run_id, "note" if ok else "error", f"结束：{finished['outcome']}{' — ' + finished['note'] if finished['note'] else ''}")
                if ok:
                    tabs = list(l.tabs)
                    asyncio.get_running_loop().call_later(4, lambda: _release_tabs(tabs))
                return
        raise RuntimeError(f"走了 {settings['maxSteps']} 步还没填完，停下了；浏览器里的页面保留着，你可以接手")
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001
        if isinstance(e, Cancelled) or l.cancelled:
            set_run(run_id, {"status": "cancelled", "pending": None, "finished_at": iso_now()})
            add_step(run_id, "note", "已放弃这次投递")
            _release_tabs(l.tabs)
        else:
            # Keep the screen it stopped on: it usually explains the failure.
            if l.page and not l.page.is_closed():
                await _snapshot(run_id, l.page)
            msg = "页面被关掉了" if isinstance(e, BrowserGone) else str(e) or e.__class__.__name__
            set_run(run_id, {"status": "failed", "outcome": msg, "pending": None, "finished_at": iso_now()})
            add_step(run_id, "error", msg)
    finally:
        l.waiter = None
        live.pop(run_id, None)


def live_shot_name(run_id: int) -> str:
    """The latest view of the run's tab, shown live in the UI and kept afterwards as the last screen."""
    return f"run-{run_id}-live.jpg"


async def _snapshot(run_id: int, page: Any) -> None:
    try:
        await page.screenshot(path=str(SHOTS_DIR / live_shot_name(run_id)), type="jpeg", quality=55, timeout=5000)
    except Exception:  # noqa: BLE001
        pass


def _release_tabs(tabs: list[Any]) -> None:
    """Closes a finished run's tabs. Only tabs the run opened in your browser, never one of yours."""
    for t in tabs:
        if not t.is_closed():
            fut = asyncio.ensure_future(t.close())
            fut.add_done_callback(_swallow)


async def _exec_tool(run_id: int, l: Live, c: dict[str, Any], obs: dict[str, Any], job: dict[str, Any]) -> dict[str, Any]:
    page = l.page
    try:
        args = json.loads(c["function"].get("arguments") or "{}")
        if not isinstance(args, dict):
            args = {}
    except ValueError:
        return {"result": "ERROR: arguments were not valid JSON", "endTurn": False}
    name = c["function"]["name"]
    aid = args.get("id")
    el = next((e for e in obs["elements"] if e["id"] == aid), None) if isinstance(aid, str) else None
    loc = locate(page, aid) if isinstance(aid, str) else None

    def need_el() -> dict[str, Any] | None:
        if not el or not loc:
            return {"result": f"ERROR: no element [{aid if aid is not None else 'undefined'}] in the latest snapshot", "endTurn": False}
        return None

    what = f"「{(el['label'] or el['text'] or el['group'] or el['id'])[:50]}」" if el else ""

    def sarg(k: str, dflt: str = "") -> str:
        v = args.get(k)
        if v is None:
            return dflt
        return v if isinstance(v, str) else json.dumps(v) if isinstance(v, (dict, list)) else str(v).lower() if isinstance(v, bool) else str(v)

    try:
        if name == "fill":
            bad = need_el()
            if bad:
                return bad
            value = sarg("value")
            if el["kind"] == "file":
                return {"result": "ERROR: this is a file input; use upload", "endTurn": False}
            if el["kind"] == "select":
                return await _exec_tool(
                    run_id, l, {**c, "function": {"name": "select", "arguments": js_json({"id": aid, "option": value})}}, obs, job
                )
            await loc.fill(value, timeout=8000)
            l.filled += 1
            add_step(run_id, "action", f"填写{what}：{value[:80]}")
            return {"result": f"OK filled {what or aid}", "endTurn": False}
        if name == "select":
            bad = need_el()
            if bad:
                return bad
            opts = await loc.evaluate("(s) => Array.from(s.options).map((o) => ({ v: o.value, t: o.text.trim() }))")
            i = best_match(sarg("option"), [o["t"] for o in opts])
            if i < 0:
                return {"result": f'ERROR: no option like "{sarg("option", "undefined")}". Options: {" | ".join(o["t"] for o in opts[:60])}', "endTurn": False}
            await loc.select_option(opts[i]["v"], timeout=8000)
            l.filled += 1
            add_step(run_id, "action", f"选择{what}：{opts[i]['t']}")
            return {"result": f'OK selected "{opts[i]["t"]}"', "endTurn": False}
        if name == "choose":
            bad = need_el()
            if bad:
                return bad
            text = sarg("text")
            await loc.click(timeout=8000)
            try:
                await loc.fill(text, timeout=3000)
            except Exception:  # noqa: BLE001
                await loc.press_sequentially(text, delay=40, timeout=8000)
            await page.wait_for_timeout(1200)
            cands: list[dict[str, Any]] = []
            frames = page.frames
            for fi, fr in enumerate(frames):
                try:
                    found = await fr.evaluate(
                        """() => {
              const sel = '[role=option], [class*="select__option"], [class*="Select-option"], .pac-item, li[id*="option"], [class*="autocomplete"] li, [class*="suggestion"]';
              return Array.from(document.querySelectorAll(sel))
                .filter((e) => {
                  const r = e.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                })
                .slice(0, 40)
                .map((e, i) => {
                  e.setAttribute("data-ra-opt", String(i));
                  return e.innerText.replace(/\\s+/g, " ").trim();
                });
            }"""
                    )
                except Exception:  # noqa: BLE001
                    found = []
                for idx, t in enumerate(found):
                    if t:
                        cands.append({"text": t, "idx": idx, "frameIdx": fi})
            if not cands:
                add_step(run_id, "action", f"输入{what}：{text}（没有出现候选项）")
                return {
                    "result": "Typed the text, but no suggestions appeared. If this is a plain text box the typed value may be enough; otherwise try different wording.",
                    "endTurn": False,
                }
            i = best_match(text, [x["text"] for x in cands])
            if i < 0:
                shown = " | ".join(x["text"] for x in cands[:25])
                return {"result": f'Typed "{text}". Suggestions shown: {shown}. Call choose again with the exact suggestion text.', "endTurn": False}
            cand = cands[i]
            await frames[cand["frameIdx"]].locator(f'[data-ra-opt="{cand["idx"]}"]').first.click(timeout=6000)
            l.filled += 1
            add_step(run_id, "action", f"选择{what}：{cand['text'][:80]}")
            return {"result": f'OK chose "{cand["text"]}"', "endTurn": False}
        if name == "check":
            bad = need_el()
            if bad:
                return bad
            want = args.get("checked") is not False
            try:
                await loc.set_checked(want, timeout=4000)
            except Exception:  # noqa: BLE001
                await loc.evaluate("(e) => (e.labels?.[0] ?? e).click()")
                await page.wait_for_timeout(200)
            try:
                now = await loc.is_checked()
            except Exception:  # noqa: BLE001
                now = None
            if now is not None and now != want:
                return {"result": f"ERROR: could not {'tick' if want else 'untick'} it; try clicking its label instead", "endTurn": False}
            l.filled += 1
            if el["kind"] == "radio":
                label = f"{'「' + el['group'][:40] + '」' if el['group'] else ''}选「{el['label'][:40]}」"
            else:
                label = f"{'勾选' if want else '取消勾选'}{what}"
            add_step(run_id, "action", label)
            return {"result": f"OK {'checked' if want else 'unchecked'}", "endTurn": False}
        if name == "click":
            bad = need_el()
            if bad:
                return bad
            if is_final_submit(el, l.filled):
                add_step(run_id, "guard", f"拦下了对{what}的点击：这像是最终提交，要等你确认")
                return {
                    "result": "BLOCKED: this looks like the final submit. Do not click it. If everything required is filled, call request_submit with this id; otherwise finish filling first.",
                    "endTurn": False,
                }
            await loc.click(timeout=8000)
            add_step(run_id, "action", f"点击{what}")
            await _settle(l.page)
            return {"result": "OK clicked", "endTurn": True}
        if name == "upload":
            bad = need_el()
            if bad:
                return bad
            now_job = get_job(job["id"]) or job  # a cover letter may have been written during this run
            which = sarg("file")
            file = now_job["cover_file"] if which == "cover_letter" else now_job["resume_file"]
            if not file or not Path(file).exists():
                return {
                    "result": f"ERROR: {which or 'undefined'} is not available{'; call write_cover_letter first' if which == 'cover_letter' else ''}",
                    "endTurn": False,
                }
            # Hand Playwright the bytes, not the path: it then builds the File inside the page. A path
            # goes through CDP's DOM.setFileInputFiles, which your browser refuses to an extension
            # ("Not allowed") unless it was given access to file URLs.
            payload = {"name": Path(file).name, "mimeType": "application/pdf", "buffer": Path(file).read_bytes()}
            if el["kind"] == "file":
                await loc.set_input_files(payload, timeout=8000)
            else:
                async with page.expect_file_chooser(timeout=8000) as fc:
                    await loc.click(timeout=8000)
                chooser = await fc.value
                await chooser.set_files(payload)
            l.filled += 1
            add_step(run_id, "action", f"上传{'求职信' if which == 'cover_letter' else '简历'}：{Path(file).name}")
            await page.wait_for_timeout(2000)
            return {"result": f"OK attached {Path(file).name}. The form may have auto-filled fields from it; check them.", "endTurn": True}
        if name == "write_cover_letter":
            add_step(run_id, "note", "这个申请要求求职信，按资料库写一封")
            cl = await write_cover_letter(job["id"])
            add_step(run_id, "action", f"写好了求职信：{Path(cl['file']).name}{'（' + '；'.join(cl['warnings']) + '）' if cl['warnings'] else ''}")
            return {"result": f'OK cover letter ready as file "cover_letter" ({Path(cl["file"]).name}). Text, for a text box:\n{cl["text"]}', "endTurn": False}
        if name == "scroll":
            dy = -900 if args.get("direction") == "up" else 900
            # The wheel scrolls whatever pane is under the mouse (LinkedIn's job details is its own
            # scroller); if it doesn't come back, scroll the window instead.
            try:
                await within(page.mouse.wheel(0, dy), 5000, "scroll")
            except Exception:  # noqa: BLE001
                await page.evaluate("(d) => window.scrollBy(0, d)", dy)
            await page.wait_for_timeout(600)
            return {"result": "OK scrolled", "endTurn": True}
        if name == "wait":
            n = js_number(args.get("seconds")) if "seconds" in args else float("nan")
            secs = n if n == n and n != 0 else 2
            await page.wait_for_timeout(min(10, max(0.5, secs)) * 1000)
            return {"result": "OK waited", "endTurn": True}
        if name == "goto":
            url = sarg("url")
            if not re.match(r"^https?://", url, re.I):
                return {"result": "ERROR: only http(s) URLs", "endTurn": False}
            await page.goto(url, wait_until="domcontentloaded", timeout=45_000)
            add_step(run_id, "action", f"打开 {url}")
            return {"result": "OK opened", "endTurn": True}
        if name == "ask_user":
            field = sarg("field_label").strip()
            question = sarg("question").strip() or f"「{field}」该填什么？"
            add_step(run_id, "ask", f"问你：{question}")
            r = await _wait_for_user(run_id, l, "need_user", {"kind": "ask", "question": question, "field": field})
            if r.get("type") != "answer":
                return {"result": "The user did not answer; leave the field empty if it is optional, otherwise call need_manual.", "endTurn": True}
            answer = str(r.get("answer") or "").strip()
            remember = bool(r.get("remember"))
            add_step(run_id, "note", f"你的回答：{answer}{'（已记入资料库）' if remember else ''}")
            l.mock.answers[field or question] = answer
            if remember and answer:
                p = get_profile()
                q = re.sub(r"\s*(\*|\(required\)|（必填）)\s*$", "", field or question, flags=re.I).strip()
                hit = next((a for a in p["answers"] if similarity(a["q"], q) >= 0.8), None)
                if hit:
                    hit["a"] = answer
                else:
                    p["answers"].append({"id": new_id("qa"), "q": q, "a": answer})
                save_profile(p)
                emit("profile")
            return {"result": f"User answered: {js_json(answer)}", "endTurn": True}
        if name == "need_manual":
            reason = sarg("reason", "需要你在浏览器里处理一下")
            add_step(run_id, "ask", f"需要你手动处理：{reason}")
            try:
                await page.bring_to_front()
            except Exception:  # noqa: BLE001
                pass
            await _wait_for_user(run_id, l, "need_user", {"kind": "manual", "reason": reason})
            add_step(run_id, "note", "你处理完了，继续")
            return {"result": "The user says they handled it in the browser. Look at the new snapshot.", "endTurn": True}
        if name == "request_submit":
            bad = need_el()
            if bad:
                return bad
            summary = sarg("summary")
            shot = f"run-{run_id}-{int(time.time() * 1000)}.jpg"
            try:
                await page.screenshot(path=str(SHOTS_DIR / shot), full_page=True, type="jpeg", quality=70, timeout=15_000)
            except Exception:  # noqa: BLE001
                await page.screenshot(path=str(SHOTS_DIR / shot), type="jpeg", quality=70)
            add_step(run_id, "ask", f"填好了，等你确认提交（按钮{what}）")
            r = await _wait_for_user(
                run_id,
                l,
                "awaiting_confirm",
                {"kind": "review", "summary": summary, "fields": _review_fields(obs), "screenshot": shot, "targetText": el["text"] or el["label"], "url": page.url},
            )
            if r.get("type") == "revise":
                feedback = str(r.get("feedback") if r.get("feedback") is not None else "")
                add_step(run_id, "note", f"你要求修改：{feedback}")
                return {"result": f"Not approved yet. The candidate's feedback: {js_json(feedback)}. Make the changes, then call request_submit again.", "endTurn": True}
            if r.get("type") != "confirm":
                return {"result": "Not approved.", "endTurn": True}
            target = locate(page, aid)
            if not target:
                return {"result": "ERROR: the submit button is gone; look at the new snapshot", "endTurn": True}
            await target.click(timeout=10_000)
            l.submit_clicked = True
            add_step(run_id, "action", f"你确认了，已点击{what}")
            await _settle(page)
            await page.wait_for_timeout(2500)
            return {
                "result": "The candidate approved and the system clicked the submit button. If the new snapshot shows a confirmation, call finish(submitted). If it shows errors, fix them and call request_submit again. If it is another step, continue.",
                "endTurn": True,
            }
        if name == "finish":
            outcome = args.get("outcome") if args.get("outcome") in ("submitted", "already_applied", "closed", "failed") else "failed"
            note = sarg("note")
            if outcome == "submitted" and not l.submit_clicked:
                note = f"{note}（提交按钮不是经确认步骤点的，可能是你在浏览器里自己点的）"
            return {"result": "OK", "endTurn": True, "finished": {"outcome": outcome, "note": note}}
        return {"result": f"ERROR: unknown tool {name}", "endTurn": False}
    except (Cancelled, asyncio.CancelledError):
        raise
    except Exception as e:  # noqa: BLE001
        if page.is_closed():
            raise BrowserGone() from None
        msg = (str(e) or e.__class__.__name__).split("\n")[0][:300]
        add_step(run_id, "error", f"{name}{what} 出错：{msg}")
        return {"result": f"ERROR: {msg}", "endTurn": False}


def list_runs(job_id: int | None = None, active: bool = False) -> list[dict[str, Any]]:
    where: list[str] = []
    params: list[Any] = []
    if job_id:
        where.append("r.job_id = ?")
        params.append(job_id)
    if active:
        where.append(f"r.status IN ({','.join(repr(s) for s in ACTIVE)})")
    return all_rows(
        f"SELECT r.*, j.title AS job_title, j.company AS job_company, j.url AS job_url FROM runs r JOIN jobs j ON j.id = r.job_id {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY r.id DESC LIMIT 200",
        *params,
    )


def is_live(run_id: int) -> bool:
    return run_id in live
