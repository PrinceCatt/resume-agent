"""After applying: interview prep (likely questions with talking points from the profile) and
short email drafts (a follow-up, a thank-you). Same rule as tailoring: only facts from the
profile, never invented experience."""

from __future__ import annotations

import asyncio
import re
from typing import Any

from .db import iso_now, parse_json
from .events import emit
from .jobs import days_since_sql, get_job, job_jd, set_job, trim_posting
from .jsutil import js_json, js_round
from .llm import chat_json, is_demo, llm_ready
from .mock import mock_draft, mock_prep
from .profile import get_profile, profile_for_prompt
from .settings import get_settings
from .terms import profile_text, unsupported_terms

DRAFT_KINDS = ["followup", "thanks"]

_prepping: set[int] = set()
_prep_errors: dict[int, str] = {}
_tasks: set[asyncio.Task] = set()


def prep_state(id_: int) -> dict[str, Any]:
    return {"prepping": id_ in _prepping, "prepError": _prep_errors.get(id_)}


def _context(id_: int) -> dict[str, Any]:
    job = get_job(id_)
    if not job:
        raise RuntimeError("岗位不存在")
    jd = job_jd(job)
    if not jd:
        raise RuntimeError("先读取岗位")
    ready = llm_ready()
    if not ready["ok"]:
        raise RuntimeError(ready["reason"])
    profile = get_profile()
    if not profile["sections"]:
        raise RuntimeError("资料库是空的：先到「资料库」填写或导入简历")
    s = get_settings()
    lang = jd["language"] if s["resumeLanguage"] == "auto" else s["resumeLanguage"]
    posting = (
        f"Title: {jd['title']}\nCompany: {jd['company']}\nLocation: {jd['location']}\nRequirements:\n- "
        + "\n- ".join(jd["requirements"])
        + "\nNice to have:\n- "
        + "\n- ".join(jd["niceToHave"])
        + f"\nKeywords: {', '.join(jd['keywords'])}\n\nFull text:\n{trim_posting(job['jd_text'] or '', job['url'])[:8000]}"
    )
    extra = profile["extraFacts"] or "(none)"
    candidate = f"{profile_for_prompt(profile, with_ids=False)}\n\nEXTRA FACTS\n{extra}"
    candidate_with_ids = f"{profile_for_prompt(profile, with_ids=True)}\n\nEXTRA FACTS\n{extra}"
    return {
        "job": job,
        "jd": jd,
        "profile": profile,
        "lang": lang,
        "langName": "Simplified Chinese" if lang == "zh" else "English",
        "posting": posting,
        "candidate": candidate,
        "candidateWithIds": candidate_with_ids,
    }


def _prep_system(lang_name: str) -> str:
    return f"""You coach a candidate for the interviews of one specific job.
Use ONLY facts from CANDIDATE (the profile, whose lines carry [ids], and EXTRA FACTS). Never invent experience, employers, tools, tests, methods, durations, team sizes, numbers or results: if CANDIDATE does not say they did it, they did not. Where the candidate lacks something the job needs, say so plainly and suggest an honest way to handle it.
Every talking point is one of two kinds:
- experience: something CANDIDATE says the candidate did or has. "src" is the [id] of the profile line it comes from (a bullet, an entry or a skills group), or "fact" with "fact" set to the exact sentence copied from EXTRA FACTS. Stay within what that line says.
- tip: advice on how to answer (structure, what to explain, what to admit). "src" is "tip". It must be phrased as advice ("Explain…", "Walk through…", "Admit that…") and must not describe anything as done by the candidate.
Return JSON:
{{"pitch": string (a 30-45 second self-introduction for this role, first person, in {lang_name}, only facts from CANDIDATE),
 "questions": [{{"q": string (in {lang_name}), "kind": "behavioral" | "technical" | "role" | "resume", "why": string (one sentence in Simplified Chinese: why an interviewer for this role would ask it), "points": [{{"text": string (in {lang_name}), "src": string, "fact"?: string}}] (2-4 points; prefer experience points, use tips where CANDIDATE has nothing relevant)}}]
   (8-12 questions, the ones most likely for THIS posting: its must-haves and keywords, and what on the candidate's resume an interviewer would probe),
 "toAsk": string[] (3-5 questions for the candidate to ask the interviewer, in {lang_name}, specific to this role and company),
 "gaps": [{{"gap": string (Simplified Chinese), "how": string (Simplified Chinese: an honest way to handle it in the interview)}}] (0-4 items)}}"""


def queue_prep(id_: int) -> None:
    """Starts writing the prep in the background; the job emits when it is done."""
    if id_ in _prepping:
        return
    ctx = _context(id_)  # throws early (no profile, no key) so the button can say why
    _prepping.add(id_)
    _prep_errors.pop(id_, None)
    emit("job", id_)

    async def go() -> None:
        try:
            if is_demo():
                raw = mock_prep(ctx["jd"], ctx["profile"], ctx["lang"])
            else:
                raw = await chat_json(
                    _prep_system(ctx["langName"]),
                    f"JOB POSTING\n{ctx['posting']}\n\nCANDIDATE\n{ctx['candidateWithIds']}",
                    5000,
                    {"jobId": id_, "kind": "prep"},
                )
            prep = _normalize_prep(raw)
            if not prep["questions"]:
                raise RuntimeError("模型没有给出面试题，再试一次")
            if get_job(id_):
                set_job(id_, {"prep": js_json(prep)})
        except Exception as e:  # noqa: BLE001
            _prep_errors[id_] = str(e) or e.__class__.__name__
        finally:
            _prepping.discard(id_)
            emit("job", id_)

    t = asyncio.ensure_future(go())
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


def _numbers_in(t: str) -> list[str]:
    return [n.replace(",", "") for n in re.findall(r"\d+(?:[.,]\d+)?%?", t)]


def _squash(t: str) -> str:
    return re.sub(r"\s+", " ", t.lower()).strip()


# A "tip" that opens like a résumé line is a claim in disguise.
CLAIM = re.compile(
    r"^(i\s+|i've\s+|i have\s+)?(used|built|led|developed|implemented|created|designed|worked|completed|learned|collaborated|encountered|deployed|wrote|managed|optimi[sz]ed|debugged|resolved|identified|overcame|applied|conducted|participated)\b|^我(做|用|负责|参与|完成|写|学|搭|开发|设计|带)",
    re.I,
)


def check_point(raw: Any, profile: dict[str, Any], jd: dict[str, Any]) -> dict[str, str]:
    """Sorts each talking point into fact / tip / unsure by checking its source against the profile."""
    if isinstance(raw, str):
        text = raw.strip()
    elif isinstance(raw, dict) and isinstance(raw.get("text"), str):
        text = raw["text"].strip()
    else:
        text = ""
    src = re.sub(r"^\[|\]$", "", raw["src"].strip()) if isinstance(raw, dict) and isinstance(raw.get("src"), str) else ""
    if src.lower() == "tip":
        if CLAIM.search(text):
            return {"text": text, "kind": "unsure", "from": "写得像你做过的事，但没有标出处"}
        return {"text": text, "kind": "tip", "from": ""}
    where: dict[str, str] = {}
    for s in profile["sections"]:
        where[s["id"]] = s["heading"]
        for e in s["entries"]:
            where[e["id"]] = e["title"] or s["heading"]
            for b in e["bullets"]:
                where[b["id"]] = e["title"] or s["heading"]
    for g in profile["skills"]:
        where[g["id"]] = g["label"] or "技能"
    from_ = where.get(src, "")
    fact = raw.get("fact") if isinstance(raw, dict) else None
    if not from_ and src == "fact" and isinstance(fact, str) and fact.strip() and _squash(fact) in _squash(profile["extraFacts"]):
        from_ = "素材库"
    if not from_:
        return {"text": text, "kind": "unsure", "from": "资料库里找不到出处"}
    ptext = profile_text(profile)
    missing = unsupported_terms(text, ptext, jd.get("keywords"))
    if missing:
        return {"text": text, "kind": "unsure", "from": f"出自「{from_}」，但资料库里没有 {'、'.join(missing)}"}
    nums = set(_numbers_in(ptext))
    bad = [n for n in _numbers_in(text) if n not in nums]
    if bad:
        return {"text": text, "kind": "unsure", "from": f"出自「{from_}」，但资料库里没有 {'、'.join(bad)} 这个数字"}
    return {"text": text, "kind": "fact", "from": from_}


def _s(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ""


def _normalize_prep(raw: Any) -> dict[str, Any]:
    r = raw if isinstance(raw, dict) else {}
    kinds = ["behavioral", "technical", "role", "resume"]

    def point(p: Any) -> dict[str, str]:
        d = p if isinstance(p, dict) else {}
        out = {"text": _s(d["text"] if d.get("text") is not None else p), "src": _s(d.get("src"))}
        if _s(d.get("fact")):
            out["fact"] = _s(d["fact"])
        return out

    questions = []
    for q in r.get("questions") if isinstance(r.get("questions"), list) else []:
        qd = q if isinstance(q, dict) else {}
        pts = [pt for pt in (point(p) for p in (qd.get("points") if isinstance(qd.get("points"), list) else [])) if pt["text"]][:5]
        item = {"q": _s(qd.get("q")), "kind": qd.get("kind") if qd.get("kind") in kinds else "role", "why": _s(qd.get("why")), "points": pts}
        if item["q"]:
            questions.append(item)
    gaps = []
    for g in r.get("gaps") if isinstance(r.get("gaps"), list) else []:
        gd = g if isinstance(g, dict) else {}
        item = {"gap": _s(gd.get("gap")), "how": _s(gd.get("how"))}
        if item["gap"]:
            gaps.append(item)
    to_ask = [x for x in (_s(v) for v in r["toAsk"]) if x][:6] if isinstance(r.get("toAsk"), list) else []
    return {"pitch": _s(r.get("pitch")), "questions": questions[:15], "toAsk": to_ask, "gaps": gaps[:5], "generatedAt": iso_now()}


def prep_view(raw: Any, profile: dict[str, Any], jd: dict[str, Any] | None) -> dict[str, Any] | None:
    """The saved prep with every point and the pitch checked against the profile as it is now."""
    if not isinstance(raw, dict) or not isinstance(raw.get("questions"), list):
        return None
    ptext = profile_text(profile)
    nums = set(_numbers_in(ptext))
    keywords = (jd or {}).get("keywords") or []
    pitch = raw["pitch"] if isinstance(raw.get("pitch"), str) else ""

    def view_point(p: Any) -> Any:
        if isinstance(p, str):
            return {"text": p, "kind": "unsure", "from": "早先生成的，没有标出处：重新生成一次"}
        if isinstance(p, dict) and isinstance(p.get("kind"), str) and not isinstance(p.get("src"), str):
            return p
        return check_point(p, profile, {"keywords": keywords})

    return {
        **raw,
        "pitchWarnings": [f"提到了 {t}，资料库里没有" for t in unsupported_terms(pitch, ptext, keywords)]
        + [f"数字 {n} 资料库里没有" for n in _numbers_in(pitch) if n not in nums],
        "questions": [{**q, "points": [view_point(p) for p in (q.get("points") or [])]} for q in raw["questions"]],
    }


def draft_warnings(d: dict[str, Any], profile: dict[str, Any], jd: dict[str, Any] | None) -> list[str]:
    """Tools an email names that neither the profile nor the user's notes mention."""
    # Names the notes mention (the interviewer's stack) are fine; anything else is worth a look.
    return [
        f"提到了 {t}，资料库里没有：说的是对方的技术就没事，别写成你会"
        for t in unsupported_terms(f"{d['subject']}\n{d['body']}", f"{profile_text(profile)}\n{d['extra']}", (jd or {}).get("keywords") or [])
    ]


def drafts_view(raw: Any, profile: dict[str, Any], jd: dict[str, Any] | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(raw, dict):
        for k in DRAFT_KINDS:
            d = raw.get(k)
            if isinstance(d, dict) and d.get("body"):
                out[k] = {**d, "warnings": draft_warnings(d, profile, jd)}
    return out


def _draft_system(kind: str, lang_name: str, days: float | None) -> str:
    if kind == "followup":
        ago = f"{js_round(days)} days ago" if days is not None and days >= 2 else "recently"
        body = f"It follows up on an application submitted {ago} with no reply yet: ask politely about the status, restate interest in one sentence that cites one concrete, relevant fact from CANDIDATE. At most 120 words."
    else:
        body = "It thanks the interviewer(s) after an interview: thank them, recall what NOTES says was discussed (if NOTES is empty, stay general but specific to this role), restate interest with one concrete, relevant fact from CANDIDATE. At most 150 words."
    return f"""You write one short, polite email for a job candidate, in {lang_name}.
{body}
Use only facts from CANDIDATE; never invent experience, numbers or details of the interview. Address it to the person NOTES names, otherwise "Dear Hiring Team," (or "您好，" in Chinese). Sign with the candidate's name. No placeholders in brackets.
Return JSON {{"subject": string, "body": string}}."""


async def make_draft(id_: int, kind: str, extra: str) -> dict[str, Any]:
    ctx = _context(id_)
    days = days_since_sql(ctx["job"]["applied_at"]) if ctx["job"]["applied_at"] else None
    if is_demo():
        raw = mock_draft(kind, ctx["jd"], ctx["profile"], ctx["lang"], extra)
    else:
        raw = await chat_json(
            _draft_system(kind, ctx["langName"], days),
            f"JOB POSTING\n{ctx['posting'][:3000]}\n\nCANDIDATE\n{ctx['candidate']}\n\nNOTES\n{extra or '(none)'}",
            1200,
            {"jobId": id_, "kind": "email"},
        )
    r = raw if isinstance(raw, dict) else {}
    draft = {
        "subject": r["subject"].strip() if isinstance(r.get("subject"), str) else "",
        "body": r["body"].strip() if isinstance(r.get("body"), str) else "",
        "extra": extra,
        "generatedAt": iso_now(),
    }
    if not draft["body"]:
        raise RuntimeError("模型没有写出邮件，再试一次")
    j = get_job(id_)
    drafts = parse_json(j["drafts"] if j else None, {})
    if not isinstance(drafts, dict):
        drafts = {}
    drafts[kind] = draft
    set_job(id_, {"drafts": js_json(drafts)})
    return {**draft, "warnings": draft_warnings(draft, ctx["profile"], ctx["jd"])}
