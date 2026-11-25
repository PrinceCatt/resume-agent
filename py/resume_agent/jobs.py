"""Job intake: read the posting (headless first, the signed-in window if the page needs it),
then pull out title, company, requirements and keywords."""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from typing import Any, Callable

from . import browser
from .db import all_rows, get, parse_json, parse_sql_time, run, sql_now
from .events import emit
from .jsutil import is_finite, js_json, js_number, js_round
from .llm import chat_json, is_demo, llm_ready
from .mock import mock_extract_job, mock_fit
from .profile import get_profile, profile_for_prompt
from .settings import get_settings
from .sites import is_check_page, site_for
from .tasks import make_queue
from .terms import profile_text, unsupported_terms
from .urls import normalize_url

__all__ = ["normalize_url"]

MATERIALS = ["cover_letter", "transcript", "portfolio", "references", "other"]
FIT_CONFLICT_CAP = 45
PROGRESS = ["applied", "screening", "interview", "offer", "rejected", "withdrawn"]


def asks_cover_letter(jd: dict | None) -> bool:
    """The posting asks for a cover letter."""
    return bool(jd and jd.get("facts") and "cover_letter" in (jd["facts"].get("materials") or []))


bg_queue = make_queue(lambda: 2)

# The queue lives in memory, so a restart drops whatever was reading or tailoring. Without this the job
# showed "读取岗位中" for good, with no button to try again.
run(
    "UPDATE jobs SET error = CASE busy WHEN 'parsing' THEN '程序重启，读取中断了，再点一次' ELSE '程序重启，改简历中断了，再点一次' END, busy = NULL WHERE busy IS NOT NULL",
)


def get_job(id_: int) -> dict[str, Any] | None:
    return get("SELECT * FROM jobs WHERE id = ?", id_)


def set_job(id_: int, patch: dict[str, Any]) -> None:
    patch = dict(patch)
    cur = get_job(id_) if patch.get("stage") == "applied" or "progress" in patch else None
    if cur and patch.get("stage") == "applied":
        # The first time a job counts as applied starts its follow-up tracking.
        if not cur["applied_at"] and "applied_at" not in patch:
            patch["applied_at"] = sql_now()
        if not cur["progress"] and "progress" not in patch:
            patch["progress"] = "applied"
            patch["progress_at"] = sql_now()
    keys = list(patch.keys())
    if not keys:
        return
    run(
        f"UPDATE jobs SET {', '.join(f'{k} = ?' for k in keys)}, updated_at = datetime('now') WHERE id = ?",
        *[patch[k] for k in keys],
        id_,
    )
    if cur and isinstance(patch.get("progress"), str) and patch["progress"] != cur["progress"]:

        def log(p: str, ts: str) -> None:
            run("INSERT INTO progress_log (job_id, progress, ts) VALUES (?, ?, ?)", id_, p, ts)

        if not get("SELECT 1 FROM progress_log WHERE job_id = ?", id_):
            # Every history starts with "applied": a job applied before the log existed gets it (and where it
            # stood) dated from the job; one marked straight as "test" or "interview" gets it now.
            if cur["progress"]:
                log("applied", cur["applied_at"] or cur["updated_at"])
                if cur["progress"] != "applied":
                    log(cur["progress"], cur["progress_at"] or cur["updated_at"])
            elif patch["progress"] != "applied":
                log("applied", patch.get("applied_at") or cur["applied_at"] or sql_now())
        log(patch["progress"], patch.get("progress_at") or sql_now())
    emit("job", id_)


def progress_reached(job_id: int, current: str | None) -> set[str]:
    """How far a job got after applying, from its log plus its current progress."""
    seen = {r["progress"] for r in all_rows("SELECT progress FROM progress_log WHERE job_id = ?", job_id)}
    if current:
        seen.add(current)
    return seen


def progress_log(job_id: int) -> list[dict[str, Any]]:
    return all_rows("SELECT progress, ts FROM progress_log WHERE job_id = ? ORDER BY ts, id", job_id)


def days_since_sql(t: str) -> float | None:
    """Days since a stored UTC time."""
    d = parse_sql_time(t)
    return None if d is None else (datetime.now(timezone.utc) - d).total_seconds() / 86400


def list_jobs() -> list[dict[str, Any]]:
    return all_rows("SELECT * FROM jobs ORDER BY id DESC")


# Hooks so jobs.py doesn't import tailor/agent (they import jobs.py).
pipeline_hooks: dict[str, Callable[[int], None] | None] = {"afterParse": None}


def add_jobs(urls_in: list[str], jd_text: str = "", auto_apply: bool = False) -> dict[str, Any]:
    ids: list[int] = []
    duplicates: list[dict[str, Any]] = []
    known: dict[str, int] = {}
    for j in all_rows("SELECT id, url FROM jobs WHERE url != ''"):
        known[normalize_url(j["url"])] = j["id"]
    urls = [u.strip() for u in urls_in if u.strip()]
    for raw in urls:
        url = raw if re.match(r"^https?://", raw, re.I) else f"https://{raw}"
        key = normalize_url(url)
        dup = known.get(key)
        if dup is not None:
            if not any(d["id"] == dup for d in duplicates):
                duplicates.append({"url": url, "id": dup})
            continue
        id_ = run(
            "INSERT INTO jobs (url, jd_text, auto_apply) VALUES (?, ?, ?)",
            url,
            jd_text if len(urls) == 1 and jd_text else None,
            1 if auto_apply else 0,
        )["id"]
        ids.append(id_)
        known[key] = id_
        queue_parse(id_)
    if not urls and jd_text:
        id_ = run("INSERT INTO jobs (url, jd_text, auto_apply) VALUES ('', ?, 0)", jd_text)["id"]
        ids.append(id_)
        queue_parse(id_)
    emit("job")
    return {"ids": ids, "duplicates": duplicates}


def queue_parse(id_: int) -> None:
    set_job(id_, {"busy": "parsing", "error": None, "notice": None})

    async def task() -> None:
        try:
            await parse_job(id_)
            # Only the first read hands off to tailoring and applying. Re-reading a posting refreshes it and
            # the fit; before this check it re-tailored and started a second application on a submitted job.
            j = get_job(id_)
            if j and j["auto_apply"] and j["stage"] != "applied" and not get("SELECT 1 AS x FROM runs WHERE job_id = ?", id_):
                hook = pipeline_hooks.get("afterParse")
                if hook:
                    hook(id_)
        except Exception as e:  # noqa: BLE001
            set_job(id_, {"busy": None, "error": str(e)})

    bg_queue.push(task)


LOGIN_WALL = re.compile(r"sign in to (view|see|continue)|log in to (view|continue)|join now to see|登录后查看|请先登录|扫码登录", re.I)


async def read_page(page: Any) -> dict[str, str]:
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=30_000)
    except Exception:  # noqa: BLE001
        pass
    # Wait until the text stops growing: single-page sites (MyCareersFuture) fill the posting in after
    # load, and a fixed 2.5 s caught only its header.
    last = -1
    for i in range(12):
        await page.wait_for_timeout(1000 if i else 1500)
        try:
            n = await page.evaluate("() => document.body?.innerText.length ?? 0")
        except Exception:  # noqa: BLE001
            n = 0
        if n == last and n > 600:
            break
        last = n
    parts: list[str] = []
    for frame in page.frames:
        try:
            t = await frame.evaluate("() => (document.body?.innerText ?? '').trim()")
            if len(t) > 40:
                parts.append(t)
        except Exception:  # noqa: BLE001 - detached or cross-process frame
            pass
    try:
        title = await page.title()
    except Exception:  # noqa: BLE001
        title = ""
    return {"title": title, "text": re.sub(r"\n{3,}", "\n\n", "\n\n".join(parts))[:24_000]}


async def fetch_posting_text(url: str) -> dict[str, str]:
    from .discover import mcf_posting_text

    mcf = await mcf_posting_text(url)
    if mcf:
        return mcf
    site = site_for(url)
    # JobStreet, Glassdoor and Indeed show a headless browser a bot check, so they go straight to the
    # assistant's own window, where you are signed in.
    if not (site and site["visibleOnly"]):
        b = await browser.get_headless()
        page = await b.new_page(locale="en-US")
        got = {"title": "", "text": ""}
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=45_000)
            got = await read_page(page)
        except Exception:  # noqa: BLE001 - fall through to the visible browser
            pass
        finally:
            await page.close()
        if len(got["text"]) >= 600 and not LOGIN_WALL.search(got["text"][:3000]) and not is_check_page(got["title"], got["text"]):
            return got
    # Sites that need a signed-in session: read it in a tab of your own browser (where you're signed in).
    vis = await browser.new_visible_page(url)
    keep = False
    try:
        got = await read_page(vis)
        name = site["name"] if site else "这个网站"
        # Never save a check page or a sign-in wall as the posting. The tab stays open for you to deal with.
        if is_check_page(got["title"], got["text"]):
            keep = True
            raise RuntimeError(f"{name}打开时出现了人机验证：浏览器里已经开着这个岗位的标签页，你自己过一下验证，再点「重新读取岗位」。")
        if LOGIN_WALL.search(got["text"][:3000]):
            keep = True
            raise RuntimeError(f"{name}要先登录才能看：在浏览器里开着的那个标签页上登录后，再点「重新读取岗位」。")
        return got
    finally:
        try:
            if keep:
                await vis.bring_to_front()
            else:
                await vis.close()
        except Exception:  # noqa: BLE001
            pass


EXTRACT_SYSTEM = f"""You read job postings. Return JSON with exactly these keys:
{{"title": string, "company": string, "location": string,
 "summary": string (2-3 sentences in Simplified Chinese: what the role does and who it wants),
 "requirements": string[] (must-haves, short, in the posting's language),
 "niceToHave": string[],
 "keywords": string[] (8-20 concrete skills/tools/domains a recruiter or ATS would scan for, as written in the posting),
 "language": "en" | "zh" (language of the posting),
 "closed": boolean (true only if the page says the job is closed / no longer accepting applications),
 "facts": {{"type": "fulltime"|"parttime"|"internship"|"contract"|"unknown",
   "hours": "full"|"part"|"" (internships and contracts: full-time or part-time hours, e.g. "at least 4 days a week" is full; "" if not stated),
   "months": number|null (internship or contract length in months),
   "start": string (start date as written, "" if not stated),
   "minYears": number|null (minimum years of work experience required; 0 if it says no experience needed or fresh graduates welcome; null if not stated),
   "degree": "none"|"diploma"|"bachelor"|"master"|"phd"|"" (minimum education required),
   "student": "enrolled"|"graduated"|"" ("enrolled" if applicants must be current students; "graduated" if they must already hold the qualification, e.g. "graduated within the last 2 years", "2024-2026 graduates"),
   "workAuth": "citizen"|"citizen_pr"|"" (open only to Singapore citizens / only to citizens and PRs; "" if not restricted),
   "salary": string (as written, "" if none),
   "materials": array of "cover_letter"|"transcript"|"portfolio"|"references"|"other" (documents applicants are asked to send besides the resume/CV; [] if none mentioned),
   "coverLetterAsk": string (what the posting wants the cover letter to address, in the posting's language; "" if nothing specific),
   "workplace": "onsite"|"hybrid"|"remote"|""}},
 "fit": {{"score": integer 0-100, "verdict": string, "strengths": string[], "gaps": string[], "conflict": "fulltime_internship"|"start_date"|"graduates_only"|"work_auth"|""}} | null}}
"facts" come only from the posting text: never guess; use ""/null/[] when it does not say.
"fit" compares the posting with CANDIDATE. Be strict and honest, like a recruiter screening: score how well the candidate meets the MUST-haves (level, years of experience, degree, required skills, work authorization if stated); nice-to-haves only move it a little. A student applying to a role that requires several years of experience scores low. verdict: one sentence in Simplified Chinese on whether it is worth applying. strengths/gaps: up to 4 short points each in Simplified Chinese, citing concrete items from the posting and the candidate. A strength may only name skills, tools and experience written in CANDIDATE; something the posting wants that CANDIDATE does not mention is a gap, never a strength, and it must not raise the score. Use null if there is no candidate profile.
When CANDIDATE includes WHAT THE CANDIDATE IS LOOKING FOR, also check the posting against it, and judge internships and full-time jobs separately:
- Internship: if the candidate wants part-time internships, an internship with full-time hours (full-time, 5 days a week, 40 hours) is a clear conflict however well the dates fit: it goes first in gaps, the verdict must not call it a match with what they want, and the score is 45 or lower. An internship for enrolled students that starts after their graduation date is a conflict too. If the hours are not stated, say in gaps that the hours need checking, without lowering the score much.
- Full-time job: one they would start after graduating. Graduating later is not a conflict unless the posting states a start date before the graduation date or requires the degree to be completed already. A wish for part-time internships is about internships only and never lowers a full-time job's score.
Other clear conflicts (a STATED start date before they can start, a role only for people who have already graduated) also go first in gaps and lower the score a lot. Something the posting does not state is not a conflict.
"conflict": the kind of clear conflict, or "" if none. Only these count: "fulltime_internship" (an internship whose posting states full-time hours, when the candidate wants part-time internships), "start_date" (a start date the posting STATES that the candidate cannot meet: before they can start, or after their graduation for an internship that needs enrolled students), "graduates_only" (only for people who already hold the qualification), "work_auth" (limited to citizens or PR and CANDIDATE is neither). Still studying and graduating later is never a conflict for a full-time job. A conflict caps the score at {FIT_CONFLICT_CAP}.
If the text is not a job posting, return title "", fit null, and explain in summary."""

# Saved answers that say what the candidate is after, given to the fit check. Before this, a
# 6-month full-time internship scored 82 for someone looking for full-time jobs and part-time
# internships, because the score only saw skills.
PREF_IDS = ["qa_jobtype", "qa_grad", "qa_start", "qa_dur", "qa_auth", "qa_visa"]


def search_prefs(p: dict[str, Any]) -> str:
    lines = []
    for id_ in PREF_IDS:
        a = next((x for x in p["answers"] if x["id"] == id_), None)
        if a and a["a"].strip():
            lines.append(f"- {a['q']}: {a['a'].strip()}")
    return "WHAT THE CANDIDATE IS LOOKING FOR\n" + "\n".join(lines) if lines else ""


# Job sites print far more than the posting. LinkedIn's signed-out page wraps a 2,000-5,000 character posting in
# sign-in chrome, "Similar jobs" and "People also viewed": stored, it was 24,000 characters, and reading postings was
# three quarters of the DeepSeek bill (2026-11-13). MyCareersFuture's old page dumps carry a cookie banner and footer.
LINKEDIN_TAIL = re.compile(
    r"^(?:Referrals increase your chances\b.*|Get notified about new .*|Sign in to create job alert|Similar jobs|Show more jobs like this|People also viewed|Similar Searches|Explore top content on LinkedIn.*|Looking for a job\?)\s*$",
    re.M,
)
LINKEDIN_NOISE = re.compile(
    r"^(?:Skip to main content|LinkedIn|Jobs|Clear text|Sign in|Join now|Apply|Save|Show more|Show less|See who you know|Report this job|Use AI to assess how you fit|Get AI-powered advice on this job and more exclusive features\.|Am I a good fit for this job\?|Tailor my resume|See who .+ has hired for this role|Direct message the job poster from .+)$"
)
MCF_HEAD = "The machine translation for this job description is powered by Microsoft Translator."
MCF_TAIL = re.compile(r"^(?:More jobs from this company|Log in to Apply|A collaboration between)\s*$", re.M)
MCF_NOISE = re.compile(
    r"^(?:See how you compare with other applicants|Log in to view|Tell employers what skills you have|The more skills you have, the better your job match\.|\d+% skills matched|Add these skills if you have them|Report issue|BETA|NEW!)$"
)


def trim_posting(text: str, url: str) -> str:
    """The posting without the site around it, so the model is paid to read the posting only. Other sites' text comes back as it was."""
    from urllib.parse import urlsplit

    host = ""
    try:
        if re.match(r"^[a-z][a-z0-9+.-]*:", url or "", re.I):
            host = urlsplit(url).hostname or ""
    except ValueError:
        pass  # pasted text without a link

    def cut(t: str, tail: re.Pattern[str], noise: re.Pattern[str]) -> str:
        m = tail.search(t)
        end = m.start() if m else -1
        body = t[:end] if end > 0 else t
        return "\n".join(ln for ln in body.split("\n") if not noise.search(ln.strip()))

    t = text
    if re.search(r"(^|\.)linkedin\.com$", host):
        t = cut(t, LINKEDIN_TAIL, LINKEDIN_NOISE)
    elif re.search(r"(^|\.)mycareersfuture\.gov\.sg$", host) and MCF_HEAD in t:
        t = cut(t[t.index(MCF_HEAD) + len(MCF_HEAD) :], MCF_TAIL, MCF_NOISE)
    else:
        return text
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+\n", "\n", t)).strip()


async def parse_job(id_: int) -> None:
    job = get_job(id_)
    if not job:
        return
    ready = llm_ready()
    if not ready["ok"]:
        raise RuntimeError(ready["reason"])

    text = job["jd_text"] or ""
    page_title = ""
    if not text and job["url"]:
        got = await fetch_posting_text(job["url"])
        text = got["text"]
        page_title = got["title"]
    # Stored as trimmed too, so tailoring and interview prep read the same short text.
    text = trim_posting(text, job["url"])
    if len(text.strip()) < 80:
        raise RuntimeError("没读到岗位内容：页面可能要登录，在你的浏览器里登录该网站后再点「重新读取岗位」，或直接粘贴 JD 文本。")

    profile = get_profile()
    prefs = search_prefs(profile)
    if profile["sections"]:
        candidate = f"{profile_for_prompt(profile, with_ids=False)}\n\nEXTRA FACTS\n{profile['extraFacts'] or '(none)'}{chr(10) + chr(10) + prefs if prefs else ''}"
    else:
        candidate = "(no profile yet)"
    # CANDIDATE goes first: it is the same for every job, so after the first read DeepSeek serves the system
    # prompt and the profile from its cache (billed at about a tenth) and only the posting is new.
    input_ = f"CANDIDATE\n{candidate}\n\nURL: {job['url']}\nPage title: {page_title}\n\nPOSTING\n{text[:12_000]}"
    src = hashlib.sha256(f"{get_settings()['model']}\n{EXTRACT_SYSTEM}\n{input_}".encode("utf-8")).hexdigest()[:20]
    prev = job_jd(job)
    if is_demo():
        jd = mock_extract_job(text, job["url"], page_title)
        jd["fit"] = mock_fit(jd, profile) if profile["sections"] else None
    elif prev is not None and prev.get("src") == src:
        # Re-reading a job whose posting, profile and prompt are all unchanged would pay for the same answer
        # again (three bulk re-reads were most of the 2026-11-13 bill). Its checks already ran on the same profile.
        jd = prev
    else:
        jd = normalize_jd(await chat_json(EXTRACT_SYSTEM, input_, 4096, {"jobId": id_, "kind": "parse"}))
        jd["src"] = src
    if jd is not prev:
        if jd["fit"] and profile["sections"]:
            jd["fit"] = check_fit(jd["fit"], profile_text(profile), jd["keywords"])
        jd["fit"] = cap_for_prefs(jd["fit"], jd["facts"], prefs)

    set_job(
        id_,
        {
            "jd_text": text,
            "jd": js_json(jd),
            "title": jd["title"] or page_title or None,
            "company": jd["company"] or None,
            "location": jd["location"] or None,
            "stage": "parsed" if job["stage"] == "new" else job["stage"],
            "busy": None,
            "error": "页面显示这个岗位已关闭" if jd["closed"] else None,
        },
    )


def _s(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ""


def _a(v: Any) -> list[str]:
    return [x for x in (_s(i) for i in v) if x] if isinstance(v, list) else []


def normalize_jd(raw: Any) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    keywords: list[str] = []
    for k in _a(raw.get("keywords")):
        if k not in keywords:
            keywords.append(k)
    facts = normalize_facts(raw.get("facts"))
    return {
        "title": _s(raw.get("title")),
        "company": _s(raw.get("company")),
        "location": _s(raw.get("location")),
        "summary": _s(raw.get("summary")),
        "requirements": _a(raw.get("requirements")),
        "niceToHave": _a(raw.get("niceToHave")),
        "keywords": keywords[:25],
        "language": "zh" if raw.get("language") == "zh" else "en",
        "closed": raw.get("closed") is True,
        "fit": normalize_fit(raw.get("fit"), normalize_facts(raw.get("facts"))),
        "facts": facts,
    }


def normalize_facts(raw: Any) -> dict[str, Any] | None:
    # !raw || typeof raw !== "object": an empty object or an array still counts (with every field unknown).
    if not isinstance(raw, (dict, list)):
        return None
    if isinstance(raw, list):
        raw = {}

    def one(v: Any, ok: list[str], dflt: str = "") -> str:
        return v if isinstance(v, str) and v in ok else dflt

    def num(v: Any, mx: float) -> int | float | None:
        n = js_number(v) if isinstance(v, str) and v.strip() else v
        if is_finite(n) and 0 <= n <= mx:
            r = js_round(n * 10) / 10
            return int(r) if float(r).is_integer() else r
        return None

    materials: list[str] = []
    for m in raw.get("materials") if isinstance(raw.get("materials"), list) else []:
        if isinstance(m, str) and m in MATERIALS and m not in materials:
            materials.append(m)
    return {
        "type": one(raw.get("type"), ["fulltime", "parttime", "internship", "contract", "unknown"]) or "unknown",
        "hours": one(raw.get("hours"), ["full", "part"]),
        "months": num(raw.get("months"), 60),
        "start": _s(raw.get("start"))[:60],
        "minYears": num(raw.get("minYears"), 30),
        "degree": one(raw.get("degree"), ["none", "diploma", "bachelor", "master", "phd"]),
        "student": one(raw.get("student"), ["enrolled", "graduated"]),
        "workAuth": one(raw.get("workAuth"), ["citizen", "citizen_pr"]),
        "salary": _s(raw.get("salary"))[:80],
        "materials": materials,
        "coverLetterAsk": _s(raw.get("coverLetterAsk"))[:400],
        "workplace": one(raw.get("workplace"), ["onsite", "hybrid", "remote"]),
    }


# The conflicts that cap a fit, each with the posting condition that must back it up.
CONFLICTS: dict[str, dict[str, Any]] = {
    "fulltime_internship": {
        "label": "全职实习，和你想找的兼职实习不符",
        "backed": lambda f: f["type"] == "internship" and f["hours"] == "full",
    },
    "start_date": {"label": "开始时间对不上你的时间", "backed": lambda f: bool(f["start"])},
    "graduates_only": {"label": "只招已经毕业的", "backed": lambda f: f["student"] == "graduated"},
    "work_auth": {"label": "只招公民 / PR", "backed": lambda f: bool(f["workAuth"])},
}


def wants_part_time_interns_only(prefs: str) -> bool:
    """Their wishes name part-time internships and do not also accept full-time ones."""
    return bool(re.search(r"part[- ]?time intern|兼职实习", prefs, re.I)) and not re.search(r"full[- ]?time intern|全职实习", prefs, re.I)


def cap_for_prefs(fit: dict | None, facts: dict | None, prefs: str) -> dict | None:
    """A full-time internship for someone who wants part-time ones is a clash the posting's stated hours settle on their own;
    the model left it out on about a third of them (2026-11-13), so it is added here."""
    if not fit or fit.get("conflict") or not facts or not wants_part_time_interns_only(prefs) or not CONFLICTS["fulltime_internship"]["backed"](facts):
        return fit
    return {**fit, "conflict": CONFLICTS["fulltime_internship"]["label"], "score": min(fit["score"], FIT_CONFLICT_CAP)}


def normalize_fit(raw: Any, facts: dict | None) -> dict | None:
    if not raw or not isinstance(raw, dict):
        return None
    score = js_number(raw.get("score")) if "score" in raw else float("nan")
    if not is_finite(score):
        return None

    def a(v: Any) -> list[str]:
        return [x.strip() for x in v if isinstance(x, str) and x.strip()][:5] if isinstance(v, list) else []

    # The model names a clash but does not always lower the score for it (a full-time internship scored 78 for
    # someone who wants part-time ones, 2026-11-13), so the cap is applied here. Asked for a free-text clash, it also
    # made some up ("not graduated yet" on full-time jobs), so it picks a kind and the posting's own conditions
    # (extracted in the same answer) must back it up.
    kind = CONFLICTS.get(raw["conflict"].strip() if isinstance(raw.get("conflict"), str) else "")
    conflict = kind["label"] if kind and facts and kind["backed"](facts) else ""
    out: dict[str, Any] = {
        "score": max(0, min(FIT_CONFLICT_CAP if conflict else 100, js_round(score))),
        "verdict": raw["verdict"].strip() if isinstance(raw.get("verdict"), str) else "",
        "strengths": a(raw.get("strengths")),
        "gaps": a(raw.get("gaps")),
    }
    if conflict:
        out["conflict"] = conflict
    return out


def check_fit(fit: dict, profile: str, keywords: list[str]) -> dict:
    """Marks strengths that credit the candidate with a tool the profile never mentions."""
    unsupported: list[str] = []
    strengths = []
    for st in fit["strengths"]:
        missing = unsupported_terms(st, profile, keywords)
        for t in missing:
            if t not in unsupported:
                unsupported.append(t)
        strengths.append(f"{st}（资料库里没找到：{'、'.join(missing)}）" if missing else st)
    return {**fit, "strengths": strengths, "unsupported": unsupported}


def job_jd(job: dict[str, Any]) -> dict[str, Any] | None:
    jd = parse_json(job["jd"], None)
    if not isinstance(jd, dict):
        return None
    if "fit" not in jd:
        jd["fit"] = None
    if "facts" not in jd:
        jd["facts"] = None
    return jd

