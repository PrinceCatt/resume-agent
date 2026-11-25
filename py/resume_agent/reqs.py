"""What postings ask for, as labels, filters and counts (port of src/reqs.ts). The server uses the labels for
the CSV export; the filters and counts are ported too so the shared rules stay tested on this side."""

from __future__ import annotations

import json
from typing import Any

from .jsutil import is_num, js_string

TYPE_LABEL = {"fulltime": "全职", "parttime": "兼职", "internship": "实习", "contract": "合同工", "unknown": "没写"}
DEGREE_LABEL = {"none": "不限学历", "diploma": "大专", "bachelor": "本科", "master": "硕士", "phd": "博士"}
MATERIAL_LABEL = {"cover_letter": "求职信", "transcript": "成绩单", "portfolio": "作品集", "references": "推荐人", "other": "其他材料"}
AUTH_LABEL = {"citizen": "仅限公民", "citizen_pr": "仅限公民/PR"}


def _n(v: Any) -> str:
    return js_string(v)


def type_label(f: dict) -> str:
    """"兼职实习 3 个月", "全职", "" """
    months = " " + _n(f["months"]) + " 个月" if f.get("months") else ""
    if f["type"] == "internship":
        hours = "兼职" if f.get("hours") == "part" else "全职" if f.get("hours") == "full" else ""
        return hours + "实习" + months
    if f["type"] == "contract":
        return "合同工" + months
    return "" if f["type"] == "unknown" else TYPE_LABEL[f["type"]]


def years_label(n: float) -> str:
    return "不要经验" if n == 0 else f"{_n(n)} 年以上经验"


def fact_chips(f: dict | None) -> list[dict]:
    """Short labels for a job's conditions, in a fixed order; the warning ones are flagged."""
    if not f:
        return []
    out: list[dict] = []
    t = type_label(f)
    if t:
        out.append({"text": t})
    if f.get("minYears") is not None:
        out.append({"text": years_label(f["minYears"]), "warn": f["minYears"] >= 2})
    if f.get("student") == "graduated":
        out.append({"text": "须已毕业", "warn": True})
    if f.get("student") == "enrolled":
        out.append({"text": "须在读"})
    if f.get("workAuth"):
        out.append({"text": AUTH_LABEL[f["workAuth"]], "warn": True})
    for m in f.get("materials") or []:
        out.append({"text": f"要{MATERIAL_LABEL[m]}"})
    if f.get("start"):
        out.append({"text": f"开始 {f['start']}"})
    return out


KINDS = ["fulltime", "intern_part", "intern_full", "parttime"]
KIND_LABEL = {"fulltime": "全职", "intern_part": "兼职实习", "intern_full": "全职实习", "parttime": "兼职"}


def _kinds_of(f: dict) -> list[str]:
    """The kinds a job could be; an internship with no stated hours could be either."""
    if f["type"] in ("fulltime", "parttime"):
        return [f["type"]]
    if f["type"] != "internship":
        return []
    return ["intern_part"] if f.get("hours") == "part" else ["intern_full"] if f.get("hours") == "full" else ["intern_part", "intern_full"]


NO_FILTER: dict[str, Any] = {
    "types": [],
    "maxYears": None,
    "hideCitizenOnly": False,
    "hideGraduatedOnly": False,
    "coverLetter": "any",
    "minFit": 0,
    "hideClosed": False,
    "keyword": "",
}


def read_filter(raw: str | None) -> dict[str, Any]:
    """Reads a saved filter, dropping anything malformed."""
    try:
        o = json.loads(raw if raw is not None else "null")
    except (ValueError, TypeError):
        return dict(NO_FILTER)
    if not isinstance(o, dict):
        return dict(NO_FILTER)
    types: list[str] = []
    if isinstance(o.get("types"), list):
        for t in o["types"]:
            # "internship" was one kind before part-time and full-time internships were told apart.
            for k in (["intern_part", "intern_full"] if t == "internship" else [t] if t in KINDS else []):
                if k not in types:
                    types.append(k)
    return {
        "types": types,
        "maxYears": o["maxYears"] if is_num(o.get("maxYears")) else None,
        "hideCitizenOnly": o.get("hideCitizenOnly") is True,
        "hideGraduatedOnly": o.get("hideGraduatedOnly") is True,
        "coverLetter": o["coverLetter"] if o.get("coverLetter") in ("yes", "no") else "any",
        "minFit": o["minFit"] if is_num(o.get("minFit")) else 0,
        "hideClosed": o.get("hideClosed") is True,
        "keyword": o["keyword"] if isinstance(o.get("keyword"), str) else "",
    }


def _jd(j: dict) -> dict | None:
    return j.get("jd")


def _closed(j: dict) -> bool:
    return bool((_jd(j) or {}).get("closed"))


def passes(j: dict, f: dict) -> bool:
    """Does the job pass the filter? A job read before conditions were recorded passes the conditions it cannot be judged on."""
    jd = _jd(j) or {}
    facts = jd.get("facts")
    if f["hideClosed"] and _closed(j):
        return False
    if f["minFit"] and ((jd.get("fit") or {}).get("score", -1) if jd.get("fit") else -1) < f["minFit"]:
        return False
    if f["keyword"] and not any(k.lower() == f["keyword"].lower() for k in jd.get("keywords") or []):
        return False
    if not facts:
        return len(f["types"]) == 0 and f["coverLetter"] != "yes"
    if f["types"] and not any(k in f["types"] for k in _kinds_of(facts)):
        return False
    if f["maxYears"] is not None and facts.get("minYears") is not None and facts["minYears"] > f["maxYears"]:
        return False
    if f["hideCitizenOnly"] and facts.get("workAuth"):
        return False
    if f["hideGraduatedOnly"] and facts.get("student") == "graduated":
        return False
    cl = "cover_letter" in (facts.get("materials") or [])
    if f["coverLetter"] == "yes" and not cl:
        return False
    if f["coverLetter"] == "no" and cl:
        return False
    return True


def req_stats(jobs: list[dict], top_k: int = 24) -> dict[str, Any]:
    def count(m: dict[str, int], k: str) -> None:
        m[k] = m.get(k, 0) + 1

    types: dict[str, int] = {}
    years: dict[str, int] = {}
    limits: dict[str, int] = {}
    materials: dict[str, int] = {}
    kw: dict[str, dict[str, Any]] = {}
    no_facts = 0
    for j in jobs:
        have = {k.lower() for k in (j.get("kwHave") or [])}
        seen: list[str] = []
        for x in (_jd(j) or {}).get("keywords") or []:
            k = x.strip()
            if k and k not in seen:
                seen.append(k)
        for k in seen:
            key = k.lower()
            e = kw.get(key) or {"k": k, "n": 0, "have": False, "forms": {}}
            e["n"] += 1
            count(e["forms"], k)
            e["have"] = e["have"] or key in have
            kw[key] = e
        if _closed(j):
            count(limits, "已关闭")
        f = (_jd(j) or {}).get("facts")
        if not f:
            no_facts += 1
            continue
        if type_label(f):
            label = (
                f"{'兼职' if f.get('hours') == 'part' else '全职' if f.get('hours') == 'full' else ''}实习"
                if f["type"] == "internship"
                else TYPE_LABEL[f["type"]]
            )
        else:
            label = "没写"
        count(types, label)
        my = f.get("minYears")
        count(years, "没写" if my is None else "不要经验" if my == 0 else "1 年" if my <= 1 else "2 年" if my <= 2 else "3 年以上")
        if f.get("workAuth"):
            count(limits, AUTH_LABEL[f["workAuth"]])
        if f.get("student") == "graduated":
            count(limits, "须已毕业")
        if f.get("student") == "enrolled":
            count(limits, "须在读")
        for m in f.get("materials") or []:
            count(materials, f"要{MATERIAL_LABEL[m]}")

    def ordered(m: dict[str, int], order: list[str] | None = None) -> list[dict]:
        items = [{"label": k, "n": n} for k, n in m.items()]
        if order:
            return sorted(items, key=lambda x: order.index(x["label"]) if x["label"] in order else -1)
        return sorted(items, key=lambda x: -x["n"])

    keywords = []
    for e in kw.values():
        forms = sorted(e["forms"].items(), key=lambda kv: -kv[1])
        keywords.append({"k": forms[0][0], "n": e["n"], "have": e["have"]})
    keywords.sort(key=lambda x: (-x["n"], x["k"].lower(), x["k"]))
    return {
        "total": len(jobs),
        "noFacts": no_facts,
        "types": ordered(types),
        "years": ordered(years, ["不要经验", "1 年", "2 年", "3 年以上", "没写"]),
        "limits": ordered(limits),
        "materials": ordered(materials),
        # Shown the way most postings write it ("Go", not the one posting's "GO").
        "keywords": keywords[:top_k],
    }
