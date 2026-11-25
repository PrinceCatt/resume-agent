"""The master profile: everything a tailored resume or an application answer may draw on.
Tailoring may select, reorder and reword what is here, never add to it."""

from __future__ import annotations

import io
import json
import math
import re
import time
from typing import Any

from .db import DATA_DIR, get, run
from .jsutil import base36, is_finite, js_json, js_string

_seq = 0


def new_id(prefix: str) -> str:
    global _seq
    _seq = (_seq + 1) % 1000
    return f"{prefix}_{base36(int(time.time() * 1000))}{base36(_seq)}"


EMPTY_PROFILE: dict[str, Any] = {
    "basics": {
        "name": "",
        "firstName": "",
        "lastName": "",
        "email": "",
        "phone": "",
        "phoneCountryCode": "+65",
        "location": "",
        "linkedin": "",
        "github": "",
        "website": "",
    },
    "summary": "",
    "sections": [],
    "skills": [],
    "skillsHeading": "Technical Skills",
    "skillsPosition": 2,
    "extraFacts": "",
    "answers": [],
}

# Questions most application forms ask; answers start empty so the agent asks the first time.
COMMON_QUESTIONS = [
    "Are you legally authorized to work in Singapore?",
    "Will you now or in the future require visa sponsorship?",
    "Earliest start date / availability",
    "Internship duration you are available for",
    "Expected salary / stipend",
    "Notice period",
    "Graduation date",
    "Gender (voluntary self-identification)",
    "Race / ethnicity (voluntary self-identification)",
    "How did you hear about this job?",
]

SEED_FILE = DATA_DIR / "seed-profile.json"


def get_profile() -> dict[str, Any]:
    row = get("SELECT data FROM profile WHERE id = 1")
    if row:
        return normalize_profile(json.loads(row["data"]))
    seed = normalize_profile(json.loads(SEED_FILE.read_text("utf-8"))) if SEED_FILE.exists() else normalize_profile(EMPTY_PROFILE)
    save_profile(seed)
    return seed


def save_profile(p: dict[str, Any]) -> dict[str, Any]:
    clean = normalize_profile(p)
    run(
        "INSERT INTO profile (id, data, updated_at) VALUES (1, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        js_json(clean),
    )
    return clean


def _str(v: Any) -> str:
    if isinstance(v, str):
        return v
    if v is None:
        return ""
    return js_string(v)


def _arr(v: Any) -> list:
    return v if isinstance(v, list) else []


def _obj(v: Any) -> dict:
    return v if isinstance(v, dict) else {}


def normalize_profile(raw: Any) -> dict[str, Any]:
    """Fills in missing fields and ids so the rest of the code can trust the shape."""
    raw = _obj(raw)
    b = _obj(raw.get("basics"))

    def bullets_of(e: dict) -> list[dict]:
        out = []
        for x in _arr(e.get("bullets")):
            x = {"id": "", "text": x} if isinstance(x, str) else _obj(x)
            item = {"id": _str(x.get("id")) or new_id("b"), "text": _str(x.get("text"))}
            if item["text"].strip():
                out.append(item)
        return out

    sp = raw.get("skillsPosition")
    return {
        "basics": {
            "name": _str(b.get("name")),
            "firstName": _str(b.get("firstName")),
            "lastName": _str(b.get("lastName")),
            "email": _str(b.get("email")),
            "phone": _str(b.get("phone")),
            "phoneCountryCode": _str(b.get("phoneCountryCode")) or "+65",
            "location": _str(b.get("location")),
            "linkedin": _str(b.get("linkedin")),
            "github": _str(b.get("github")),
            "website": _str(b.get("website")),
        },
        "summary": _str(raw.get("summary")),
        "sections": [
            {
                "id": _str(_obj(s).get("id")) or new_id("sec"),
                "heading": _str(_obj(s).get("heading")),
                "entries": [
                    {
                        "id": _str(_obj(e).get("id")) or new_id("ent"),
                        "title": _str(_obj(e).get("title")),
                        "dates": _str(_obj(e).get("dates")),
                        "subtitle": _str(_obj(e).get("subtitle")),
                        "location": _str(_obj(e).get("location")),
                        "bullets": bullets_of(_obj(e)),
                    }
                    for e in _arr(_obj(s).get("entries"))
                ],
            }
            for s in _arr(raw.get("sections"))
        ],
        "skills": [
            {
                "id": _str(_obj(g).get("id")) or new_id("sk"),
                "label": _str(_obj(g).get("label")),
                "items": [x for x in (_str(i).strip() for i in _arr(_obj(g).get("items"))) if x],
            }
            for g in _arr(raw.get("skills"))
        ],
        "skillsHeading": _str(raw.get("skillsHeading")) or "Technical Skills",
        "skillsPosition": max(0, math.floor(sp)) if is_finite(sp) else 2,
        "extraFacts": _str(raw.get("extraFacts")),
        "answers": [
            {"id": _str(_obj(a).get("id")) or new_id("qa"), "q": _str(_obj(a).get("q")), "a": _str(_obj(a).get("a"))}
            for a in _arr(raw.get("answers"))
        ],
    }


def profile_for_prompt(p: dict[str, Any], with_ids: bool) -> str:
    """Plain-text dump with ids, for prompts."""
    lines: list[str] = []
    b = p["basics"]
    lines.append(f"Name: {b['name']} (first: {b['firstName']}, last: {b['lastName']})")
    lines.append(f"Email: {b['email']} | Phone: {b['phoneCountryCode']} {b['phone']} | Location: {b['location']}")
    if b["linkedin"]:
        lines.append(f"LinkedIn: {b['linkedin']}")
    if b["github"]:
        lines.append(f"GitHub: {b['github']}")
    if b["website"]:
        lines.append(f"Website: {b['website']}")
    if p["summary"]:
        lines.append(f"Summary: {p['summary']}")
    for s in p["sections"]:
        lines += ["", f"## {s['heading']}{' [' + s['id'] + ']' if with_ids else ''}"]
        for e in s["entries"]:
            head = " | ".join(x for x in (e["title"], e["subtitle"], e["location"], e["dates"]) if x)
            if head:
                lines.append(f"- {head}{' [' + e['id'] + ']' if with_ids else ''}")
            elif with_ids:
                lines.append(f"- (list) [{e['id']}]")
            for x in e["bullets"]:
                lines.append(f"    * {x['text']}{' [' + x['id'] + ']' if with_ids else ''}")
    lines += ["", "## Skills"]
    for g in p["skills"]:
        lines.append(f"- {g['label']}{' [' + g['id'] + ']' if with_ids else ''}: {', '.join(g['items'])}")
    return "\n".join(lines)


def pdf_text(buf: bytes) -> str:
    """Extracts the text layer of a PDF resume (no OCR). Uses pypdf instead of pdf.js, so line breaks can differ a little."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(buf))
    pages: list[str] = []
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:  # noqa: BLE001 - a broken page is skipped, not fatal
            text = ""
        lines = [re.sub(r"\s+", " ", ln).strip() for ln in text.split("\n")]
        pages.append("\n".join(ln for ln in lines if ln))
    return "\n\n".join(pages)
