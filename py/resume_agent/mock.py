"""Demo mode: rule-based stand-ins for the model calls, so the whole flow (read job -> tailor -> fill ->
stop for your confirmation) can be tried without an API key. It only knows simple forms; the real
agent is the DeepSeek one. Port of server/mock.ts."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

from .jsutil import js_json, js_round

TECH = [
    "Python", "Java", "C++", "C", "JavaScript", "TypeScript", "Go", "Rust", "SQL", "MySQL", "PostgreSQL", "Redis", "MongoDB",
    "Spring Boot", "Spring", "React", "Vue", "Node.js", "HTML", "CSS", "Docker", "Kubernetes", "AWS", "GCP", "Azure", "Linux",
    "Git", "Machine Learning", "Deep Learning", "PyTorch", "TensorFlow", "LLM", "NLP", "Data Structures", "Algorithms",
    "REST", "Microservices", "Embedded", "ARM", "ROS", "Testing", "CI/CD", "Kafka", "Spark", "Excel",
]  # fmt: skip


def _hostname(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "") if re.match(r"^[a-z][a-z0-9+.-]*://", url, re.I) else ""
    except ValueError:
        return ""


def mock_extract_job(text: str, url: str, page_title: str) -> dict[str, Any]:
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    title = (re.split(r"[|\-–—]", page_title)[0] or (lines[0] if lines else "") or "").strip()[:100]
    company = ""
    host = _hostname(url)
    if host:
        company = re.sub(r"^www\.", "", host).split(".")[0]
    m = re.search(r"(?:company|about)\s*[:：]\s*([^\n.。]{2,60})", text, re.I)
    if m:
        company = m.group(1).strip()
    lower = text.lower()
    keywords = [k for k in TECH if re.search(r"(^|[^a-z])" + re.escape(k.lower()) + r"([^a-z]|$)", lower)]
    req = [re.sub(r"^[-•*·]\s*", "", ln) for ln in lines if re.match(r"^[-•*·]", ln)][:8]
    return {
        "title": title,
        "company": company,
        "location": "Singapore" if re.search(r"singapore", text, re.I) else "",
        "summary": "（演示模式：没有调用模型，以下是按关键词粗略提取的结果）",
        "requirements": req,
        "niceToHave": [],
        "keywords": keywords,
        "language": "zh" if re.search(r"[一-鿿]{20,}", text) else "en",
        "closed": bool(re.search(r"no longer accepting|position (has been )?filled|job (is )?closed|已关闭|停止招聘", text, re.I)),
        "fit": None,
        "facts": _mock_facts(text),
    }


def _mock_facts(text: str) -> dict[str, Any]:
    """Demo-mode conditions: the obvious phrases only."""
    years = re.search(r"(\d{1,2})\s*\+?\s*(?:years?|yrs)\b", text, re.I)
    if re.search(r"\bintern(ship)?\b|实习", text, re.I):
        type_ = "internship"
    elif re.search(r"part[- ]time|兼职", text, re.I):
        type_ = "parttime"
    elif re.search(r"\bcontract\b", text, re.I):
        type_ = "contract"
    elif re.search(r"full[- ]time|全职", text, re.I):
        type_ = "fulltime"
    else:
        type_ = "unknown"
    months_m = re.search(r"(\d{1,2})[- ]months?\b", text, re.I)
    months = int(months_m.group(1)) if months_m and int(months_m.group(1)) else None
    if years:
        min_years: int | None = int(years.group(1))
    elif re.search(r"no (prior )?experience (is )?(required|needed)|fresh grad", text, re.I):
        min_years = 0
    else:
        min_years = None
    salary = re.search(r"S?\$\s?\d[\d,]*(\s*[-–]\s*S?\$?\s?\d[\d,]*)?", text)
    return {
        "type": type_,
        "hours": "",
        "months": months,
        "start": "",
        "minYears": min_years,
        "degree": "bachelor" if re.search(r"\b(bachelor|degree)\b|本科", text, re.I) else "diploma" if re.search(r"\bdiploma\b", text, re.I) else "",
        "student": "",
        "workAuth": "citizen"
        if re.search(r"singapore(an)? citizens? only|only singapore(an)? citizens?", text, re.I)
        else "citizen_pr"
        if re.search(r"citizens? (and|or|/) (pr|permanent residents?)", text, re.I)
        else "",
        "salary": salary.group(0) if salary else "",
        "materials": ["cover_letter"] if re.search(r"cover(ing)? letter|求职信", text, re.I) else [],
        "coverLetterAsk": "",
        "workplace": "remote" if re.search(r"\bremote\b", text, re.I) else "hybrid" if re.search(r"\bhybrid\b", text, re.I) else "",
    }


def mock_fit(jd: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    """Demo-mode fit: the share of the posting's keywords that appear anywhere in the profile."""
    parts = [profile["summary"], profile["extraFacts"]]
    for s in profile["sections"]:
        for e in s["entries"]:
            parts += [e["title"], e["subtitle"], *[b["text"] for b in e["bullets"]]]
    for g in profile["skills"]:
        parts += g["items"]
    text = "\n".join(parts).lower()
    has = [k for k in jd["keywords"] if k.lower() in text]
    miss = [k for k in jd["keywords"] if k not in has]
    score = js_round(30 + (60 * len(has)) / len(jd["keywords"])) if jd["keywords"] else 50
    return {
        "score": score,
        "verdict": "演示模式：只按关键词重合度粗估，没有真正理解岗位要求。",
        "strengths": [f"资料里有：{'、'.join(has[:6])}"] if has else [],
        "gaps": [f"资料里没找到：{'、'.join(miss[:6])}"] if miss else [],
    }


def mock_tailor(master: dict[str, Any], jd: dict[str, Any]) -> dict[str, Any]:
    kw = [k.lower() for k in jd["keywords"]]

    def rank(s: str) -> int:
        return 0 if any(k in s.lower() for k in kw) else 1

    return {
        "summary": master["summary"],
        "sections": [
            {
                "id": s["id"],
                "entries": [
                    {
                        "id": e["id"],
                        "bullets": [{"src": b["id"], "text": b["text"]} for b in sorted(e["bullets"], key=lambda b: rank(b["text"]))],
                    }
                    for e in s["entries"]
                ],
            }
            for s in master["sections"]
        ],
        "skills": [{"id": g["id"], "items": sorted(g["items"], key=rank)} for g in master["skills"]],
        "skillsPosition": master["skillsPosition"],
        "notes": ["演示模式：没有调用模型，只把和岗位关键词相关的要点、技能排到了前面，措辞没改。"],
        "coverLetter": "",
    }


class MockMemory:
    def __init__(self) -> None:
        self.answers: dict[str, str] = {}
        self.asked: set[str] = set()
        self.done: set[str] = set()
        self.submit_requested = 0
        self.n = 0


def new_mock_memory() -> MockMemory:
    return MockMemory()


def _words(s: str) -> set[str]:
    return {w for w in re.split(r"[^a-z0-9一-鿿]+", s.lower()) if len(w) > 1}


def _overlap(a: str, b: str) -> float:
    A = _words(a)
    B = _words(b)
    if not A or not B:
        return 0
    return len([w for w in A if w in B]) / min(len(A), len(B))


def _from_answers(label: str, profile: dict[str, Any], mem: MockMemory) -> str:
    for q, a in mem.answers.items():
        if a and _overlap(label, q) >= 0.5:
            return a
    best = ""
    score = 0.0
    for qa in profile["answers"]:
        s = _overlap(label, qa["q"])
        if qa["a"].strip() and s > score:
            score = s
            best = qa["a"].strip()
    return best if score >= 0.5 else ""


def _guess(label: str, profile: dict[str, Any], job: dict[str, Any], mem: MockMemory) -> str:
    b = profile["basics"]
    L = label.lower()
    edu_sec = next((s for s in profile["sections"] if re.search(r"education", s["heading"], re.I)), None)
    edu = edu_sec["entries"][0] if edu_sec and edu_sec["entries"] else None
    if re.search(r"first name|given name|名字", L):
        return b["firstName"]
    if re.search(r"last name|surname|family name|姓氏", L):
        return b["lastName"]
    if re.search(r"full name|^name\b|your name|姓名", L):
        return b["name"]
    if re.search(r"e-?mail|邮箱", L):
        return b["email"]
    if re.search(r"country code|区号", L):
        return b["phoneCountryCode"]
    if re.search(r"phone|mobile|电话|手机", L):
        return b["phone"]
    if re.search(r"linkedin", L):
        return b["linkedin"]
    if re.search(r"github", L):
        return b["github"]
    if re.search(r"website|portfolio|个人网站", L):
        return b["website"]
    if re.search(r"school|university|college|学校|院校", L):
        return edu["title"] if edu else ""
    if re.search(r"degree|学位|专业", L):
        return edu["subtitle"] if edu else ""
    if re.search(r"cover letter|求职信", L):
        return job.get("cover_letter") or ""
    from_bank = _from_answers(label, profile, mem)
    if from_bank:
        return from_bank
    if re.search(r"city|location|所在地|居住地", L):
        return b["location"]
    return ""


DECLINE = re.compile(r"decline|prefer not|don.?t wish|not to (say|disclose)|不愿|不透露", re.I)
EEO = re.compile(r"gender|race|ethnic|veteran|disabilit|性别|种族|民族", re.I)
FINAL = re.compile(r"\bsubmit\b|send application|提交|投递|发送", re.I)
NEXT = re.compile(r"\bnext\b|continue|review|下一步|继续", re.I)


def mock_decide(obs: dict[str, Any], profile: dict[str, Any], job: dict[str, Any], mem: MockMemory) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    def call(name: str, args: dict[str, Any]) -> None:
        mem.n += 1
        calls.append({"id": f"mock_{mem.n}", "type": "function", "function": {"name": name, "arguments": js_json(args)}})

    if re.search(r"thank you for (applying|your application)|application (has been )?(received|submitted)|申请已提交|投递成功", obs["excerpt"], re.I):
        call("finish", {"outcome": "submitted", "note": "页面显示已收到申请"})
        return calls
    fields = [e for e in obs["elements"] if e["kind"] not in ("button", "link", "option") and not e["disabled"]]
    buttons = [e for e in obs["elements"] if e["kind"] in ("button", "link") and not e["disabled"]]
    if not any(e["kind"] != "checkbox" for e in fields):
        apply = next((e for e in buttons if re.search(r"apply|申请", e["text"], re.I)), None)
        if apply and apply["id"] not in mem.done:
            mem.done.add(apply["id"])
            call("click", {"id": apply["id"]})
        else:
            call("need_manual", {"reason": "演示模式没找到申请表或申请按钮，请在浏览器里看一下"})
        return calls

    file = next(
        (e for e in fields if e["kind"] == "file" and not e["value"] and re.search(r"resume|cv|简历", f"{e['label']} {e['group']}", re.I)),
        None,
    )
    if file and file["id"] not in mem.done:
        mem.done.add(file["id"])
        call("upload", {"id": file["id"], "file": "resume"})
        return calls

    missing: dict[str, Any] | None = None
    radio_groups: dict[str, list[dict[str, Any]]] = {}
    for e in fields:
        if e["kind"] == "radio":
            radio_groups.setdefault(e["group"], []).append(e)
            continue
        if e["id"] in mem.done:
            continue
        if e["kind"] == "file":
            continue
        if e["kind"] == "checkbox":
            if (
                e["required"]
                and not e["checked"]
                and re.search(r"agree|consent|acknowledge|confirm|privacy|同意|确认", f"{e['label']} {e['group']}", re.I)
            ):
                mem.done.add(e["id"])
                call("check", {"id": e["id"], "checked": True})
            continue
        if e["value"]:
            continue
        if e["kind"] == "select" and e.get("options"):
            if EEO.search(e["label"]):
                want = next((o for o in e["options"] if DECLINE.search(o)), "")
            elif re.search(r"country|国家", e["label"], re.I):
                want = "Singapore"
            else:
                want = _guess(e["label"], profile, job, mem)
            if want:
                mem.done.add(e["id"])
                call("select", {"id": e["id"], "option": want})
            elif e["required"] and missing is None:
                missing = e
            continue
        v = _guess(e["label"], profile, job, mem)
        if v:
            mem.done.add(e["id"])
            if e["kind"] == "combobox":
                call("choose", {"id": e["id"], "text": v})
            else:
                call("fill", {"id": e["id"], "value": v})
        elif e["required"] and missing is None:
            missing = e
    for group, radios in radio_groups.items():
        if any(r["checked"] for r in radios) or any(r["id"] in mem.done for r in radios):
            continue
        if EEO.search(group):
            want = next((r["label"] for r in radios if DECLINE.search(r["label"])), "")
        else:
            want = _from_answers(group, profile, mem)
        pick = None
        if want:
            pick = next((r for r in radios if r["label"].lower().startswith(want.lower()[:3])), None) or next(
                (r for r in radios if _overlap(r["label"], want) > 0), None
            )
        if pick:
            mem.done.add(pick["id"])
            call("check", {"id": pick["id"], "checked": True})
        elif any(r["required"] for r in radios) and missing is None:
            missing = {**radios[0], "label": group}
    if calls:
        return calls

    if missing:
        key = missing["label"] or missing["id"]
        if key not in mem.asked:
            mem.asked.add(key)
            call("ask_user", {"question": f"「{missing['label']}」这一项资料库里没有，该填什么？", "field_label": missing["label"]})
            return calls
        call("need_manual", {"reason": f"演示模式不会填「{missing['label']}」，请在浏览器里填好后点继续"})
        mem.asked.discard(key)
        return calls

    submit = next((e for e in buttons if FINAL.search(e["text"])), None) or next(
        (e for e in buttons if e["submitType"] and not NEXT.search(e["text"])), None
    )
    nxt = next((e for e in buttons if NEXT.search(e["text"]) and e["id"] not in mem.done), None)
    if submit:
        mem.submit_requested += 1
        if mem.submit_requested > 3:
            call("need_manual", {"reason": "提交后页面没有出现确认信息，请在浏览器里看一下"})
        else:
            call("request_submit", {"id": submit["id"], "summary": "演示模式：已按资料库填写所有能识别的字段，请核对后确认。"})
    elif nxt:
        mem.done.add(nxt["id"])
        call("click", {"id": nxt["id"]})
    else:
        call("need_manual", {"reason": "演示模式没找到下一步或提交按钮"})
    return calls


def mock_prep(jd: dict[str, Any], profile: dict[str, Any], lang: str) -> dict[str, Any]:
    """Demo-mode interview prep: template questions built from the posting's keywords and the profile's bullets."""
    zh = lang == "zh"
    bullets = [
        {"id": b["id"], "text": b["text"], "where": e["title"] or s["heading"]}
        for s in profile["sections"]
        for e in s["entries"]
        for b in e["bullets"]
    ]
    skills = " ".join(i for g in profile["skills"] for i in g["items"]).lower()

    def about(k: str) -> list[dict[str, Any]]:
        return [b for b in bullets if k.lower() in b["text"].lower()][:2]

    have = [k for k in jd["keywords"] if about(k) or k.lower() in skills]
    miss = [k for k in jd["keywords"] if k not in have]
    edu_sec = next((s for s in profile["sections"] if re.search(r"educ|教育", s["heading"], re.I)), None)
    edu = edu_sec["entries"][0] if edu_sec and edu_sec["entries"] else None
    name = profile["basics"]["name"] or "I"

    def is_school(b: dict[str, Any]) -> bool:
        return any(
            re.search(r"educ|教育", s["heading"], re.I) and any((e["title"] or s["heading"]) == b["where"] for e in s["entries"])
            for s in profile["sections"]
        )

    # The pitch leads with work or a project, not a school bullet.
    lead = next((b for b in bullets if not is_school(b)), None) or (bullets[0] if bullets else None)

    def sentence(t: str) -> str:
        return t.strip() if re.search(r"[.!?。！？]$", t.strip()) else f"{t.strip()}."

    role = jd["title"] or ("这个岗位" if zh else "this role")
    edu_point = [{"text": f"{edu['title']}{' · ' + edu['subtitle'] if edu['subtitle'] else ''}", "src": edu["id"]}] if edu else []
    questions: list[dict[str, Any]] = [
        {
            "q": "先简单介绍一下你自己。" if zh else "Tell me about yourself.",
            "kind": "behavioral",
            "why": "几乎每场面试的开场题，用下面的自我介绍回答。",
            "points": [*edu_point, *[{"text": f"{b['where']}: {b['text']}", "src": b["id"]} for b in bullets[:2]]],
        },
        {
            "q": f"为什么想加入{jd['company'] or '我们'}、做{role}？"
            if zh
            else f"Why do you want this {role} role{' at ' + jd['company'] if jd['company'] else ''}?",
            "kind": "role",
            "why": "考察你对岗位和公司的了解、动机是否清楚。",
            "points": [
                {
                    "text": f"把岗位要的 {'、'.join(have[:3])} 和你用过它们的经历对上"
                    if zh
                    else f"Connect the {', '.join(have[:3])} the role asks for with where you used them",
                    "src": "tip",
                }
                if have
                else {"text": "结合岗位描述讲你想学什么" if zh else "Connect what the role offers with what you want to learn", "src": "tip"}
            ],
        },
    ]
    for k in have[:5]:
        questions.append(
            {
                "q": f"讲一个你用 {k} 做过的项目。" if zh else f"Walk me through something you built with {k}.",
                "kind": "technical",
                "why": f"岗位关键词里有 {k}，你的资料里也有，面试官大概率会深挖。",
                "points": [{"text": f"{b['where']}: {b['text']}", "src": b["id"]} for b in about(k)]
                if about(k)
                else [
                    {
                        "text": f"技能栏里写了 {k}：准备一个具体例子" if zh else f"{k} is in your skills list: prepare one concrete example",
                        "src": "tip",
                    }
                ],
            }
        )
    for k in miss[:2]:
        questions.append(
            {
                "q": f"你对 {k} 熟悉吗？" if zh else f"How familiar are you with {k}?",
                "kind": "technical",
                "why": f"岗位要 {k}，你的资料里没有。",
                "points": [
                    {
                        "text": f"诚实说没用过 {k}，讲你会怎么上手，以及相近的经验"
                        if zh
                        else f"Say honestly you have not used {k}; explain how you would pick it up and what is closest in your experience",
                        "src": "tip",
                    }
                ],
            }
        )
    if zh:
        pitch = (
            f"我是{name}{'，' + edu['title'] + (edu['subtitle'] or '') if edu else ''}。"
            f"{'我做过' + lead['where'] + '：' + lead['text'] + '。' if lead else ''}"
            f"{' 这和' + role + '需要的 ' + '、'.join(have[:3]) + ' 很对口。' if have else ''}"
        )
    else:
        edu_part = f", {edu['subtitle'] + ' at ' if edu['subtitle'] else ''}{edu['title']}" if edu else ""
        lead_part = f" At {lead['where']}, I {sentence(re.sub(r'^[A-Z]', lambda c: c.group(0).lower(), lead['text']))}" if lead else ""
        have_part = f" That is why {role} fits me: it asks for {', '.join(have[:3])}, which I have used." if have else ""
        pitch = f"I'm {name}{edu_part}.{lead_part}{have_part}"
    return {
        "pitch": pitch,
        "questions": questions,
        "toAsk": ["这个岗位前三个月最重要的事情是什么？", "团队现在的技术栈和开发流程是怎样的？", "你们怎么评价一个实习生 / 新人做得好？"]
        if zh
        else [
            "What would success look like in the first three months?",
            "What does the team's stack and development process look like?",
            "How do you give feedback to interns or new joiners?",
        ],
        "gaps": [{"gap": f"资料里没有：{'、'.join(miss[:4])}", "how": "不要硬说会；讲相近经验和学习计划。"}] if miss else [],
        "_demo": "演示模式：按模板生成，不是模型写的",
    }


def mock_draft(kind: str, jd: dict[str, Any], profile: dict[str, Any], lang: str, extra: str) -> dict[str, str]:
    """Demo-mode email drafts."""
    name = profile["basics"]["name"] or ""
    role = jd["title"] or ("该岗位" if lang == "zh" else "the position")
    if lang == "zh":
        if kind == "followup":
            return {
                "subject": f"关于{role}的申请进度",
                "body": f"您好，\n\n我前段时间申请了贵司的{role}，想冒昧问一下目前的进度。我对这个岗位依然很感兴趣，期待有机会进一步沟通。\n\n谢谢！\n{name}",
            }
        return {
            "subject": f"感谢面试机会 —— {role}",
            "body": f"您好，\n\n谢谢您今天抽时间和我聊{role}。{'关于' + extra + '的讨论让我对团队有了更多了解。' if extra else ''}我对这个机会很期待，如有需要补充的材料请随时告诉我。\n\n祝好，\n{name}",
        }
    if kind == "followup":
        return {
            "subject": f"Following up on my application: {role}",
            "body": f"Dear Hiring Team,\n\nI applied for the {role} position{' at ' + jd['company'] if jd['company'] else ''} a while ago and wanted to ask whether there is any update on my application. I remain very interested in the role and would welcome the chance to discuss it.\n\nThank you for your time.\n\nBest regards,\n{name}",
        }
    return {
        "subject": f"Thank you: {role} interview",
        "body": f"Dear Hiring Team,\n\nThank you for taking the time to speak with me about the {role} position.{' I especially enjoyed our discussion about ' + extra + '.' if extra else ''} The conversation made me even more excited about the role, and I would be glad to provide anything else you need.\n\nBest regards,\n{name}",
    }
