"""Finding jobs to add: searches LinkedIn's public job search (the list a signed-out visitor sees)
and MyCareersFuture's search API, merges and de-duplicates the results, and marks the ones
already in your list. Nothing is added here; you pick what goes in, and from there the usual
read -> fit score -> tailor pipeline runs."""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

from . import net
from .db import all_rows
from .jsutil import js_string
from .urls import normalize_url

SENIOR = re.compile(r"\b(senior|snr|sr|lead|staff|principal|manager|head|director|architect|vp|avp|chief)\b|\b(\d+|five|ten)\s*\+?\s*(years|yrs)\b", re.I)


def senior_title(title: str) -> bool:
    """True for a title that is plainly not entry level."""
    return bool(SENIOR.search(title))


UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

ENTITIES = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": " "}


def _decode(s: str) -> str:
    s = re.sub(r"&#x([0-9a-f]+);", lambda m: chr(int(m.group(1), 16)), s, flags=re.I)
    s = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), s)
    return re.sub(r"&([a-z]+);", lambda m: ENTITIES.get(m.group(1).lower(), m.group(0)), s, flags=re.I)


def _clean(html: str) -> str:
    return re.sub(r"\s+", " ", _decode(re.sub(r"<[^>]+>", " ", html))).strip()


def _m(pattern: str, s: str) -> str | None:
    m = re.search(pattern, s)
    return m.group(1) if m else None


def parse_linkedin_cards(html: str) -> list[dict[str, Any]]:
    """Job cards from LinkedIn's public search fragment (jobs-guest/.../seeMoreJobPostings)."""
    out: list[dict[str, Any]] = []
    for chunk in re.split(r"<li[\s>]", html)[1:]:
        href = _m(r'class="base-card__full-link[^"]*"[^>]*?href="([^"]+)"', chunk) or _m(
            r'href="(https://[a-z]+\.linkedin\.com/jobs/view/[^"]+)"', chunk
        )
        if not href:
            continue
        url = _decode(href).split("?")[0]
        title = _clean(_m(r"<h3[^>]*base-search-card__title[^>]*>([\s\S]*?)</h3>", chunk) or _m(r'<span class="sr-only">([\s\S]*?)</span>', chunk) or "")
        company = _clean(_m(r"<h4[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)</h4>", chunk) or "")
        location = _clean(_m(r"job-search-card__location[^>]*>([\s\S]*?)</span>", chunk) or "")
        posted = _m(r'<time[^>]*datetime="([^"]+)"', chunk) or ""
        salary = _clean(_m(r"job-search-card__salary-info[^>]*>([\s\S]*?)</span>", chunk) or "")
        if title:
            out.append({"source": "linkedin", "title": title, "company": company, "location": location, "posted": posted, "url": url, "salary": salary})
    return out


async def _search_linkedin(q: str, spec: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    start = 0
    while start < spec["perQuery"]:
        p: dict[str, str] = {"keywords": q, "location": "Singapore", "f_TPR": f"r{spec['days'] * 86400}", "start": str(start)}
        if spec["kind"] == "fulltime":
            p["f_JT"] = "F"
            p["f_E"] = "2"  # entry level
        elif spec["kind"] == "parttime":
            p["f_JT"] = "P"
        else:
            p["f_JT"] = "I"
        if spec["easyApplyOnly"]:
            p["f_AL"] = "true"
        r = await net.request(
            "GET",
            f"https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?{urlencode(p)}",
            headers={"user-agent": UA, "accept-language": "en-US,en;q=0.9"},
            timeout=20,
        )
        if r.status == 429:
            raise RuntimeError("LinkedIn 暂时不让搜了（请求太频繁），过几分钟再试")
        if not r.ok:
            raise RuntimeError(f"LinkedIn 搜索出错（{r.status}）")
        cards = parse_linkedin_cards(r.text)
        out += cards
        if len(cards) < 10:
            break
        start += 10
    return out[: spec["perQuery"]]


def _g(o: Any, *path: str) -> Any:
    for k in path:
        if not isinstance(o, dict):
            return None
        o = o.get(k)
    return o


def map_mcf(results: list[Any]) -> list[dict[str, Any]]:
    """Results from MyCareersFuture's search API mapped to FoundJob."""
    out = []
    for r in results:
        if not (_g(r, "metadata", "jobDetailsUrl") and _g(r, "title")):
            continue
        s = r.get("salary")
        salary = (
            f"S${js_string(s.get('minimum')) if s.get('minimum') is not None else '?'}–{js_string(s.get('maximum')) if s.get('maximum') is not None else '?'}{'/月' if _g(s, 'type', 'salaryType') == 'Monthly' else ''}"
            if isinstance(s, dict) and (s.get("minimum") or s.get("maximum")) and not _g(r, "metadata", "isHideSalary")
            else ""
        )
        company = (
            (_g(r, "metadata", "isPostedOnBehalf") and not _g(r, "metadata", "isHideHiringEmployerName") and _g(r, "hiringCompany", "name"))
            or _g(r, "postedCompany", "name")
            or ""
        )
        addr = r.get("address")
        districts = _g(addr, "districts")
        location = (
            (districts[0].get("location") if isinstance(districts, list) and districts and isinstance(districts[0], dict) else None)
            or (addr[0].get("location") if isinstance(addr, list) and addr and isinstance(addr[0], dict) else "")
            or "Singapore"
        )
        out.append(
            {
                "source": "mcf",
                "title": js_string(r["title"]).strip(),
                "company": js_string(company).strip(),
                "location": location,
                "posted": js_string(_g(r, "metadata", "newPostingDate") if _g(r, "metadata", "newPostingDate") is not None else ""),
                "url": r["metadata"]["jobDetailsUrl"],
                "salary": salary,
            }
        )
    return out


async def _search_mcf(q: str, spec: dict[str, Any]) -> list[dict[str, Any]]:
    body: dict[str, Any] = {"search": q, "sortBy": ["new_posting_date"]}
    if spec["kind"] == "fulltime":
        body["positionLevels"] = ["Fresh/entry level"]
        body["employmentTypes"] = ["Full Time"]
    elif spec["kind"] == "parttime":
        body["employmentTypes"] = ["Part Time"]
    else:
        body["employmentTypes"] = ["Internship/Attachment"]
    r = await net.request(
        "POST",
        f"https://api.mycareersfuture.gov.sg/v2/search?limit={min(50, spec['perQuery'])}&page=0",
        headers={"user-agent": UA, "content-type": "application/json"},
        body=json.dumps(body),
        timeout=20,
    )
    if not r.ok:
        raise RuntimeError(f"MyCareersFuture 搜索出错（{r.status}）")
    j = json.loads(r.text)
    since = (datetime.now(timezone.utc) - timedelta(days=spec["days"])).strftime("%Y-%m-%d")
    results = j.get("results") if isinstance(j, dict) and isinstance(j.get("results"), list) else []
    return [f for f in map_mcf(results) if (not f["posted"] or f["posted"] >= since) and relevant_title(f["title"], q)]


FILLER = {"part", "full", "time", "intern", "internship", "interns", "junior", "senior", "graduate", "fresh", "entry", "level", "the", "and", "for", "with", "job", "jobs", "role"}


def relevant_title(title: str, query: str) -> bool:
    """MyCareersFuture's search is fuzzy: "developer" also brings back "Business Development" sales roles.
    Keep a title only when it carries one of the query's own words."""
    words = [w for w in re.split(r"[^a-z0-9+#]+", query.lower()) if len(w) >= 2 and w not in FILLER]
    if not words:
        return True
    t = f" {re.sub(r'[^a-z0-9+#]+', ' ', title.lower())} "
    return any(f" {w} " in t or f" {w}s " in t for w in words)


def mcf_job_text(j: Any) -> dict[str, str]:
    """Plain text of a MyCareersFuture job from its API record."""
    html = js_string(_g(j, "description") if _g(j, "description") is not None else "")
    s = html
    s = re.sub(r"</(p|li|h\d|div|ul|ol)>|<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<li[^>]*>", "• ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    description = _decode(s)
    description = re.sub(r"[ \t]+", " ", description)
    description = re.sub(r"\n\s*\n\s*(\n\s*)+", "\n\n", description).strip()
    company = (
        (_g(j, "metadata", "isPostedOnBehalf") and not _g(j, "metadata", "isHideHiringEmployerName") and _g(j, "hiringCompany", "name"))
        or _g(j, "postedCompany", "name")
        or ""
    )

    def names(xs: Any, k: str) -> str:
        return ", ".join(js_string(x.get(k)) for x in (xs if isinstance(xs, list) else []) if isinstance(x, dict) and x.get(k))

    sal = _g(j, "salary")
    title = js_string(_g(j, "title") if _g(j, "title") is not None else "").strip()
    status = _g(j, "status", "jobStatus")
    min_years = _g(j, "minimumYearsExperience")
    salary_line = ""
    if isinstance(sal, dict) and (sal.get("minimum") or sal.get("maximum")) and not _g(j, "metadata", "isHideSalary"):
        mn = js_string(sal["minimum"]) if sal.get("minimum") is not None else "?"
        mx = js_string(sal["maximum"]) if sal.get("maximum") is not None else "?"
        st = _g(sal, "type", "salaryType") or ""
        salary_line = f"Salary: S${mn} to S${mx} {st}".strip()
    lines = [
        title,
        js_string(company),
        f"Status: {status} (no longer accepting applications)" if status and status != "Open" else "",
        f"Employment type: {names(_g(j, 'employmentTypes'), 'employmentType')}" if names(_g(j, "employmentTypes"), "employmentType") else "",
        f"Position level: {names(_g(j, 'positionLevels'), 'position')}" if names(_g(j, "positionLevels"), "position") else "",
        f"Minimum years of experience: {js_string(min_years)}" if min_years is not None else "",
        salary_line,
        "",
        description,
        f"\nSkills: {names(_g(j, 'skills'), 'skill')}" if names(_g(j, "skills"), "skill") else "",
    ]
    return {
        "title": f"{title} | {company}" if company else title,
        "text": re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()[:24_000],
    }


async def mcf_posting_text(url: str) -> dict[str, str] | None:
    """MyCareersFuture pages are a single-page app whose text can look like a sign-in wall; its own API has the whole posting."""
    m = re.search(r"mycareersfuture\.gov\.sg/job/[^?#]*?([0-9a-f]{32})", url, re.I)
    if not m:
        return None
    try:
        r = await net.request(
            "GET", f"https://api.mycareersfuture.gov.sg/v2/jobs/{m.group(1).lower()}", headers={"user-agent": UA, "accept": "application/json"}, timeout=20
        )
    except Exception:  # noqa: BLE001
        return None
    if not r.ok:
        return None
    got = mcf_job_text(json.loads(r.text))
    return got if len(got["text"]) > 200 else None


def job_key(url: str) -> str:
    """One key per posting: LinkedIn serves the same job under sg./www. and with or without the title slug."""
    li = re.search(r"linkedin\.com/jobs/view/(?:[^/?#]*-)?(\d{6,})", url, re.I)
    if li:
        return f"linkedin:{li.group(1)}"
    mcf = re.search(r"mycareersfuture\.gov\.sg/job/[^?#]*?([0-9a-f]{32})", url, re.I)
    if mcf:
        return f"mcf:{mcf.group(1).lower()}"
    return normalize_url(url)


def merge_found(lists: list[list[dict[str, Any]]], known: dict[str, int]) -> list[dict[str, Any]]:
    """Drops repeats (same posting, or the same title at the same company from the other site) and marks jobs already in the list."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []

    def norm(s: str) -> str:
        s = re.sub(r"\b(pte|ltd|private|limited|inc|llc)\b\.?", "", s.lower())
        return re.sub(r"[^a-z0-9一-鿿]+", " ", s).strip()

    for lst in lists:
        for f in lst:
            k1 = job_key(f["url"])
            k2 = f"{norm(f['title'])}|{norm(f['company'])}"
            if k1 in seen or k2 in seen:
                continue
            seen.add(k1)
            seen.add(k2)
            out.append({**f, "existingId": known.get(k1)})
    # Array.prototype.sort is stable; newest first, undated last.
    out.sort(key=lambda f: f["posted"] or "", reverse=True)
    return out


async def search_jobs(spec: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []

    async def one(q: str, src: str) -> list[dict[str, Any]]:
        try:
            return await (_search_linkedin(q, spec) if src == "linkedin" else _search_mcf(q, spec))
        except Exception as e:  # noqa: BLE001
            msg = str(e) or e.__class__.__name__
            if msg not in errors:
                errors.append(msg)
            return []

    lists = await asyncio.gather(*[one(q, src) for q in spec["queries"] for src in spec["sources"]])
    known: dict[str, int] = {}
    for j in all_rows("SELECT id, url FROM jobs WHERE url != ''"):
        known[job_key(j["url"])] = j["id"]
    merged = merge_found(list(lists), known)
    found = [f for f in merged if not senior_title(f["title"])] if spec["hideSenior"] else merged
    return {"found": found, "errors": errors, "hidden": len(merged) - len(found)}
