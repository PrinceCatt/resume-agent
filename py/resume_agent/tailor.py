"""Tailoring: the model picks, orders and rewords; this file rebuilds the resume from the master
profile and rejects anything it cannot trace back to it."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

from .db import FILES_DIR, iso_now, parse_json
from .jobs import asks_cover_letter, bg_queue, get_job, job_jd, set_job, trim_posting
from .jsutil import is_finite, js_json
from .llm import chat_json, is_demo, llm_ready
from .mock import mock_tailor
from .profile import get_profile, profile_for_prompt
from .render import cover_letter_html, file_base_name, resume_html, write_pdf
from .settings import get_settings
from .terms import mentions


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.lower()).strip()


def _numbers_in(s: str) -> list[str]:
    return [n.replace(",", "") for n in re.findall(r"\d+(?:[.,]\d+)?%?", s)]


def doc_text(doc: dict[str, Any]) -> str:
    parts: list[str] = [doc["summary"]]
    for s in doc["sections"]:
        parts.append(s["heading"])
        for e in s["entries"]:
            parts += [e["title"], e["subtitle"], *[b["text"] for b in e["bullets"]]]
    for g in doc["skills"]:
        parts += [g["label"], *g["items"]]
    return "\n".join(parts)


def coverage(doc: dict[str, Any], keywords: list[str]) -> list[str]:
    raw = doc_text(doc)
    t = _norm(raw)
    # "ROS" is covered by "Robot Operating System", "Vue" by "Vue3".
    return [k for k in keywords if _norm(k) in t or mentions(raw, k)]


def master_doc(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "basics": p["basics"],
        "summary": p["summary"],
        "sections": p["sections"],
        "skills": p["skills"],
        "skillsHeading": p["skillsHeading"],
        "skillsPosition": p["skillsPosition"],
    }


def profile_has(p: dict[str, Any]) -> Callable[[str], bool]:
    """Whether the profile (resume and extra facts) mentions a skill, aliases included."""
    raw = doc_text(master_doc(p)) + "\n" + p["extraFacts"]
    t = _norm(raw)
    return lambda k: _norm(k) in t or mentions(raw, k)


def assemble(master: dict[str, Any], out: dict[str, Any], jd: dict[str, Any]) -> dict[str, Any]:
    """Rebuilds a resume from the model's choices; everything structural comes from the master profile.
    Returns {doc, origin, notes, warnings, coverLetter}."""
    warnings: list[str] = []
    origin: dict[str, str] = {}
    facts = _norm(master["extraFacts"])
    profile_text = _norm(profile_for_prompt(master, with_ids=False) + "\n" + master["extraFacts"])
    profile_numbers = set(_numbers_in(profile_text))
    bullet_by_id: dict[str, dict[str, Any]] = {}
    for s in master["sections"]:
        for e in s["entries"]:
            for b in e["bullets"]:
                bullet_by_id[b["id"]] = {"bullet": b, "entry": e}

    def check_text(text: str, source: str, where: str) -> str | None:
        """A rewritten bullet may only use numbers from its own entry (bullets of one entry can be merged)."""
        src_nums = set(_numbers_in(_norm(source)))
        bad = [n for n in _numbers_in(text) if n not in src_nums]
        if bad:
            return f"{where}：数字 {', '.join(bad)} 在原始资料里找不到，已改回原文"
        src_lower = _norm(source) + "\n" + profile_text
        unknown = [k for k in jd["keywords"] if _norm(k) in _norm(text) and _norm(k) not in src_lower]
        if unknown:
            warnings.append(f"{where}：出现了资料里没有的「{'」「'.join(unknown)}」，请核对是否属实")
        return None

    def lst(v: Any) -> list:
        return v if isinstance(v, list) else []

    def sv(d: dict, k: str) -> str:
        v = d.get(k)
        return v if isinstance(v, str) else ""

    sections: list[dict[str, Any]] = []
    used_entries: set[str] = set()
    all_entries = [e for s in master["sections"] for e in s["entries"]]
    for os_ in lst(out.get("sections")):
        if not isinstance(os_, dict):
            continue
        ms = next((s for s in master["sections"] if s["id"] == os_.get("id")), None)
        is_new = ms is None
        if is_new and not os_.get("heading"):
            continue
        entries: list[dict[str, Any]] = []
        for oe in lst(os_.get("entries")):
            if not isinstance(oe, dict):
                continue
            me = (next((e for e in ms["entries"] if e["id"] == oe.get("id")), None) if ms else None) or next(
                (e for e in all_entries if e["id"] == oe.get("id")), None
            )
            if me and me["id"] in used_entries:
                continue
            bullets: list[dict[str, str]] = []
            for ob in lst(oe.get("bullets")):
                if not isinstance(ob, dict):
                    continue
                text = (sv(ob, "text") or "").strip()
                if not text:
                    continue
                src = bullet_by_id.get(ob.get("src")) if isinstance(ob.get("src"), str) else None
                id_ = f"t_{len(bullets)}_{me['id'] if me else 'new'}_{len(sections)}"
                if src:
                    se = src["entry"]
                    entry_text = "\n".join([se["title"], se["subtitle"], se["dates"], *[b["text"] for b in se["bullets"]]])
                    problem = check_text(text, entry_text, f"「{(me['title'] if me else '') or se['title']}」的一条要点")
                    if problem:
                        warnings.append(problem)
                        bullets.append({"id": id_, "text": src["bullet"]["text"]})
                    else:
                        bullets.append({"id": id_, "text": text})
                        if _norm(text) != _norm(src["bullet"]["text"]):
                            origin[id_] = src["bullet"]["text"]
                elif ob.get("src") == "fact" and sv(ob, "fact") and _norm(ob["fact"])[:60] in facts:
                    problem = check_text(text, master["extraFacts"], "素材库里的一条")
                    if problem:
                        warnings.append(problem)
                        bullets.append({"id": id_, "text": ob["fact"].strip()})
                    else:
                        bullets.append({"id": id_, "text": text})
                    origin[id_] = f"（素材库）{ob['fact'].strip()}"
                else:
                    warnings.append(f"去掉了一条找不到出处的要点：「{text[:60]}」")
            if me:
                used_entries.add(me["id"])
                entries.append({**me, "bullets": bullets if bullets or not me["bullets"] else me["bullets"][:2]})
            elif bullets and sv(oe, "title"):
                # A new entry built from the extra facts: its header must be traceable too.
                header = oe["title"] + " " + (sv(oe, "subtitle"))
                missing = [w for w in re.split(r"[^A-Za-z0-9一-鿿]+", header) if len(w) >= 3 and w.lower() not in facts]
                if missing:
                    warnings.append(f"新条目「{oe['title']}」里的 {', '.join(missing)} 在素材库里找不到，请核对")
                warnings.append(f"新增了素材库里的条目「{oe['title']}」，请核对标题和日期")
                entries.append(
                    {
                        "id": f"new_{len(entries)}_{len(sections)}",
                        "title": oe["title"],
                        "subtitle": sv(oe, "subtitle"),
                        "dates": sv(oe, "dates"),
                        "location": sv(oe, "location"),
                        "bullets": bullets,
                    }
                )
        if entries:
            sections.append({"id": ms["id"] if ms else f"newsec_{len(sections)}", "heading": ms["heading"] if ms else os_["heading"], "entries": entries})

    # Education is never dropped.
    for ms in master["sections"]:
        if re.search(r"education|学历|教育", ms["heading"], re.I) and not any(s["id"] == ms["id"] for s in sections):
            sections.insert(0, ms)
            warnings.append("模型漏掉了教育经历，已按原样补回")

    all_skills: dict[str, str] = {}
    for g in master["skills"]:
        for it in g["items"]:
            all_skills[_norm(it)] = it
    skills: list[dict[str, Any]] = []
    for og in lst(out.get("skills")):
        if not isinstance(og, dict):
            continue
        mg = next((g for g in master["skills"] if g["id"] == og.get("id")), None)
        if not mg:
            continue
        items: list[str] = []
        for it in lst(og.get("items")):
            if not isinstance(it, str):
                continue
            hit = all_skills.get(_norm(it))
            if hit:
                items.append(hit)
            elif _norm(it) in facts:
                items.append(it.strip())
                warnings.append(f"技能「{it}」来自素材库，请核对")
            else:
                warnings.append(f"去掉了资料里没有的技能「{it}」")
        uniq: list[str] = []
        for x in items:
            if x not in uniq:
                uniq.append(x)
        if uniq:
            skills.append({**mg, "items": uniq})

    summary = (sv(out, "summary") or "").strip()
    if summary:
        bad = [n for n in _numbers_in(summary) if n not in profile_numbers]
        if bad:
            warnings.append(f"简介里的数字 {', '.join(bad)} 找不到出处，简介已去掉")
            summary = ""
    cover_letter = (sv(out, "coverLetter") or "").strip()
    warnings += cover_letter_warnings(master, cover_letter, jd)

    sp = out.get("skillsPosition")
    doc = {
        "basics": master["basics"],
        "summary": summary,
        "sections": sections if sections else master["sections"],
        "skills": skills if skills else master["skills"],
        "skillsHeading": master["skillsHeading"],
        "skillsPosition": max(0, int(sp // 1)) if is_finite(sp) else master["skillsPosition"],
    }
    notes = [n for n in lst(out.get("notes")) if isinstance(n, str)]
    return {"doc": doc, "origin": origin, "notes": notes, "warnings": warnings, "coverLetter": cover_letter}


def cover_letter_warnings(master: dict[str, Any], text: str, jd: dict[str, Any]) -> list[str]:
    """Numbers in a cover letter that neither the profile nor the posting's title and company contain."""
    profile_numbers = set(_numbers_in(_norm(profile_for_prompt(master, with_ids=False) + "\n" + master["extraFacts"])))
    bad = [n for n in _numbers_in(text) if n not in profile_numbers and n not in _norm(jd["title"] + jd["company"])]
    return [f"求职信里的数字 {', '.join(bad)} 找不到出处，请核对"] if bad else []


def wants_cover_letter(always: bool, jd: dict[str, Any]) -> bool:
    """Write a cover letter when the settings say always, or when this posting asks for one."""
    return always or asks_cover_letter(jd)


def _cover_ask(jd: dict[str, Any]) -> str:
    ask = (jd.get("facts") or {}).get("coverLetterAsk") if jd.get("facts") else ""
    return f"\nThe posting asks the cover letter to address: {ask}" if ask else ""


def _tailor_system(lang: str, with_cover: bool) -> str:
    cover = (
        'string (in the posting\'s language, 3 short paragraphs, ≤220 words, addressed "Dear Hiring Manager," and signed with the candidate\'s name; only facts; if the posting says what the letter should address, answer that with true facts)'
        if with_cover
        else '""'
    )
    return f"""You tailor a candidate's resume to one job posting. Return JSON only.

HARD RULES
1. Use only facts in PROFILE or EXTRA FACTS. Never invent employers, titles, dates, numbers, metrics, tools, technologies, or achievements. If the job asks for something the candidate lacks, leave it out.
2. You may: choose which sections, entries and bullets to include; reorder them so the most relevant come first; reword a bullet to use the posting's vocabulary when it stays true; tighten wording; merge two bullets of the same entry.
3. Every bullet must cite "src": the [id] of the profile bullet it is based on, or "fact" plus "fact": the exact sentence copied from EXTRA FACTS.
4. Refer to existing sections and entries by their [id]. A genuinely new entry (only from EXTRA FACTS, e.g. an internship or project missing from the resume) uses "id":"new" with title, subtitle, dates, location — copied from the facts. A new section uses "id":"new" and "heading".
5. Skills: refer to skill groups by [id]; list only items that appear in the profile skills (or EXTRA FACTS); put the most relevant first; drop irrelevant ones.
6. Fit one A4 page: about 14-18 bullets in total, each under ~25 words. Always keep Education. Prefer dropping old school activities over relevant work.
7. Write the resume in {"Simplified Chinese" if lang == "zh" else "English"}.

JSON SHAPE
{{"summary": string (optional, ≤2 sentences, only facts; "" if not useful),
 "sections": [{{"id": string, "heading"?: string, "entries": [{{"id": string, "title"?: string, "subtitle"?: string, "dates"?: string, "location"?: string, "bullets": [{{"src": string, "text": string, "fact"?: string}}]}}]}}],
 "skills": [{{"id": string, "items": string[]}}],
 "skillsPosition": number (index among your sections before which the skills block goes),
 "notes": string[] (3-6 short notes in Simplified Chinese: what you emphasised or dropped and why),
 "coverLetter": {cover}}}"""


COVER_SYSTEM = """You write a cover letter for one job posting from a candidate's profile. Return JSON {"coverLetter": string}.
- Use only facts in PROFILE or EXTRA FACTS. Never invent employers, titles, dates, numbers, tools or achievements; if the job wants something the candidate lacks, do not claim it.
- In the posting's language, 3 short paragraphs, at most 220 words, addressed "Dear Hiring Manager," and signed with the candidate's name.
- If the posting says what the letter should address, answer that with true facts."""


async def write_cover_letter(id_: int) -> dict[str, Any]:
    """A cover letter for a job that has none, when a form asks for one mid-application. Also writes its PDF."""
    job = get_job(id_)
    if not job:
        raise RuntimeError("岗位不存在")
    if (job["cover_letter"] or "").strip() and job["cover_file"] and Path(job["cover_file"]).exists():
        return {"file": job["cover_file"], "text": job["cover_letter"], "warnings": []}
    jd = job_jd(job)
    if not jd:
        raise RuntimeError("先解析岗位")
    ready = llm_ready()
    if not ready["ok"]:
        raise RuntimeError(ready["reason"])
    master = get_profile()
    if is_demo():
        out: Any = {
            "coverLetter": f"Dear Hiring Manager,\n\nI am applying for the {jd['title']} role at {jd['company']}.\n\n（演示模式：没有调用模型）\n\n{master['basics']['name']}"
        }
    else:
        reqs = "\n- ".join(jd["requirements"])
        out = await chat_json(
            COVER_SYSTEM,
            f"PROFILE\n{profile_for_prompt(master, with_ids=False)}\n\nEXTRA FACTS\n{master['extraFacts'] or '(none)'}\n\nJOB POSTING\nTitle: {jd['title']}\nCompany: {jd['company']}\nRequirements:\n- {reqs}{_cover_ask(jd)}\n\nFull text:\n{trim_posting(job['jd_text'] or '', job['url'])[:6000]}",
            1500,
            {"jobId": id_, "kind": "tailor"},
        )
    text = (out.get("coverLetter") if isinstance(out, dict) and isinstance(out.get("coverLetter"), str) else "").strip()
    if not text:
        raise RuntimeError("没写出求职信")
    warnings = cover_letter_warnings(master, text, jd)
    if not parse_json(job["tailored"], None):
        await render_master_files(id_)
    t = parse_json(get_job(id_)["tailored"], None)
    if warnings:
        t["warnings"] = [*t["warnings"], *warnings]
    set_job(id_, {"cover_letter": text, "tailored": js_json(t)})
    await render_job_files(id_)
    return {"file": get_job(id_)["cover_file"], "text": text, "warnings": warnings}


async def tailor_job(id_: int) -> None:
    job = get_job(id_)
    if not job:
        return
    jd = job_jd(job)
    if not jd:
        raise RuntimeError("先解析岗位")
    ready = llm_ready()
    if not ready["ok"]:
        raise RuntimeError(ready["reason"])
    master = get_profile()
    if not master["sections"]:
        raise RuntimeError("资料库是空的：先到「资料库」填写或导入简历")
    settings = get_settings()
    lang = jd["language"] if settings["resumeLanguage"] == "auto" else settings["resumeLanguage"]

    if is_demo():
        out = mock_tailor(master, jd)
    else:
        reqs = "\n- ".join(jd["requirements"])
        nice = "\n- ".join(jd["niceToHave"])
        out = await chat_json(
            _tailor_system(lang, wants_cover_letter(settings["coverLetter"], jd)),
            # PROFILE first, the same in every tailoring call, so DeepSeek can serve it from its cache.
            f"PROFILE\n{profile_for_prompt(master, with_ids=True)}\n\nEXTRA FACTS\n{master['extraFacts'] or '(none)'}\n\nJOB POSTING\nTitle: {jd['title']}\nCompany: {jd['company']}\nLocation: {jd['location']}\nRequirements:\n- {reqs}\nNice to have:\n- {nice}\nKeywords: {', '.join(jd['keywords'])}{_cover_ask(jd)}\n\nFull text:\n{trim_posting(job['jd_text'] or '', job['url'])[:8000]}",
            6000,
            {"jobId": id_, "kind": "tailor"},
        )
        if not isinstance(out, dict):
            out = {}

    built = assemble(master, out, jd)
    tailored = {
        "doc": built["doc"],
        "origin": built["origin"],
        "notes": built["notes"],
        "warnings": built["warnings"],
        "coverage": {"keywords": jd["keywords"], "before": coverage(master_doc(master), jd["keywords"]), "after": coverage(built["doc"], jd["keywords"])},
        "generatedAt": iso_now(),
    }
    set_job(id_, {"tailored": js_json(tailored), "cover_letter": built["coverLetter"] or None})
    await render_job_files(id_)
    set_job(id_, {"stage": "applied" if job["stage"] == "applied" else "tailored", "busy": None, "error": None, "notice": None})


async def render_job_files(id_: int) -> None:
    """(Re)writes the job's resume and cover letter PDFs from what is saved."""
    job = get_job(id_)
    t = parse_json(job["tailored"], None) if job else None
    if not t:
        raise RuntimeError("还没有定制简历")
    base = file_base_name(t["doc"])
    d = FILES_DIR / f"job-{id_}"
    resume_path = d / f"{base}_Resume.pdf"
    res = await write_pdf(resume_path, lambda s: resume_html(t["doc"], s), True)
    cover_path: Path | None = None
    if (job["cover_letter"] or "").strip():
        cover_path = d / f"{base}_Cover_Letter.pdf"
        letter = job["cover_letter"]
        await write_pdf(cover_path, lambda _s: cover_letter_html(t["doc"], letter), False)
    t["scale"] = res["scale"]
    set_job(id_, {"resume_file": str(resume_path), "cover_file": str(cover_path) if cover_path else None, "tailored": js_json(t)})


async def render_master_files(id_: int) -> None:
    """The untailored resume, used when you apply without tailoring."""
    master = get_profile()
    doc = master_doc(master)
    tailored = {
        "doc": doc,
        "origin": {},
        "notes": ["未定制：使用资料库原版简历"],
        "warnings": [],
        "coverage": {"keywords": [], "before": [], "after": []},
        "generatedAt": iso_now(),
    }
    set_job(id_, {"tailored": js_json(tailored)})
    await render_job_files(id_)


def queue_tailor(id_: int, then: Callable[[], None] | None = None) -> None:
    set_job(id_, {"busy": "tailoring", "error": None})

    async def task() -> None:
        try:
            await tailor_job(id_)
            if then:
                then()
        except Exception as e:  # noqa: BLE001
            set_job(id_, {"busy": None, "error": str(e)})

    bg_queue.push(task)
