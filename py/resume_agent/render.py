"""Resume and cover letter as HTML (the UI previews it) and as PDF (what gets uploaded)."""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from . import browser
from .jsutil import to_fixed

_ESC = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}


def esc(s: str) -> str:
    return re.sub(r"[&<>\"']", lambda m: _ESC[m.group(0)], s)


def _contact_line(doc: dict[str, Any]) -> str:
    b = doc["basics"]
    phone = f"{b['phoneCountryCode'] + ' ' if b['phoneCountryCode'] and not b['phone'].startswith('+') else ''}{b['phone']}" if b["phone"] else ""
    return " &bull; ".join(esc(x) for x in (phone, b["email"], b["linkedin"], b["github"], b["website"]) if x)


def resume_html(doc: dict[str, Any], scale: float = 1) -> str:
    blocks: list[str] = []
    for s in doc["sections"]:
        entries = []
        for e in s["entries"]:
            head = f'<div class="row"><span class="b">{esc(e["title"])}</span><span class="b">{esc(e["dates"])}</span></div>' if e["title"] or e["dates"] else ""
            sub = f'<div class="row"><span class="b">{esc(e["subtitle"])}</span><span>{esc(e["location"])}</span></div>' if e["subtitle"] or e["location"] else ""
            bullets = "<ul>" + "".join("<li>" + esc(x["text"]) + "</li>" for x in e["bullets"]) + "</ul>" if e["bullets"] else ""
            entries.append(f'<div class="entry">{head}{sub}{bullets}</div>')
        blocks.append(f"<section><h2>{esc(s['heading'])}</h2>{''.join(entries)}</section>")
    skills = [g for g in doc["skills"] if g["items"]]
    if skills:
        items = "".join(
            "<li>" + ('<span class="b">' + esc(g["label"]) + ":</span> " if g["label"] else "") + " | ".join(esc(i) for i in g["items"]) + "</li>"
            for g in skills
        )
        html = f"<section><h2>{esc(doc['skillsHeading'] or 'Skills')}</h2><ul>{items}</ul></section>"
        blocks.insert(min(doc["skillsPosition"], len(blocks)), html)
    summary = f'<p class="summary">{esc(doc["summary"])}</p>' if doc["summary"] else ""
    nl = "\n"
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{esc(doc['basics']['name'])} Resume</title>
<style>
@page {{ size: A4; margin: 12mm 15mm; }}
* {{ box-sizing: border-box; }}
html {{ background: #fff; }}
body {{ margin: 0; font-family: Arial, "Helvetica Neue", Helvetica, "Microsoft YaHei", sans-serif; color: #111; font-size: {to_fixed(10.6 * scale, 2)}pt; line-height: 1.22; }}
.page {{ width: 180mm; margin: 0 auto; }}
header {{ text-align: right; margin-bottom: {to_fixed(6 * scale, 1)}pt; }}
header h1 {{ margin: 0; font-size: {to_fixed(21 * scale, 1)}pt; letter-spacing: .3pt; text-transform: uppercase; }}
header .contact {{ margin-top: 1pt; }}
.summary {{ margin: 0 0 {to_fixed(4 * scale, 1)}pt; }}
section {{ margin-top: {to_fixed(8 * scale, 1)}pt; }}
h2 {{ margin: 0 0 {to_fixed(3 * scale, 1)}pt; font-size: {to_fixed(11.6 * scale, 1)}pt; text-transform: uppercase; border-bottom: 2.2pt double #111; padding-bottom: 1pt; }}
.entry {{ margin-bottom: {to_fixed(4 * scale, 1)}pt; break-inside: avoid; }}
.row {{ display: flex; justify-content: space-between; gap: 12pt; }}
.b {{ font-weight: 700; }}
ul {{ margin: 1pt 0 0; padding-left: 16pt; }}
li {{ margin: 0.6pt 0; }}
</style></head><body><div class="page">
<header><h1>{esc(doc['basics']['name'])}</h1><div class="contact">{_contact_line(doc)}</div></header>
{summary}{nl.join(blocks)}
</div></body></html>"""


_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def cover_letter_html(doc: dict[str, Any], letter: str) -> str:
    paras = "".join(
        f"<p>{esc(p).replace(chr(10), '<br>')}</p>" for p in (x.strip() for x in re.split(r"\n\s*\n", letter)) if p
    )
    d = datetime.now()
    date = f"{d.day} {_MONTHS[d.month - 1]} {d.year}"
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{esc(doc['basics']['name'])} Cover Letter</title>
<style>
@page {{ size: A4; margin: 22mm 22mm; }}
body {{ margin: 0; font-family: Arial, "Helvetica Neue", Helvetica, "Microsoft YaHei", sans-serif; font-size: 11pt; line-height: 1.45; color: #111; }}
header {{ margin-bottom: 18pt; }}
header h1 {{ margin: 0; font-size: 18pt; text-transform: uppercase; }}
p {{ margin: 0 0 10pt; }}
</style></head><body>
<header><h1>{esc(doc['basics']['name'])}</h1><div>{_contact_line(doc)}</div></header>
<p>{esc(date)}</p>{paras}
</body></html>"""


PRINTABLE_HEIGHT_PX = ((297 - 24) * 96) / 25.4


async def write_pdf(out_path: Path, html: Callable[[float], str], fit_one_page: bool) -> dict[str, float]:
    """Writes a PDF; for resumes, shrinks the type a little (down to 86%) to stay on one page."""
    b = await browser.get_headless()
    page = await b.new_page()
    try:
        chosen: float = 1
        if fit_one_page:
            for scale in (1, 0.96, 0.93, 0.9, 0.86):
                chosen = scale
                await page.set_content(html(scale), wait_until="load")
                await page.emulate_media(media="print")
                h = await page.evaluate("() => document.querySelector('.page')?.getBoundingClientRect().height ?? 0")
                if h <= PRINTABLE_HEIGHT_PX - 4:
                    break
        await page.set_content(html(chosen), wait_until="load")
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        await page.pdf(path=str(out_path), prefer_css_page_size=True, print_background=True)
        return {"scale": chosen}
    finally:
        await page.close()


def file_base_name(doc: dict[str, Any]) -> str:
    words = re.split(r"\s+", doc["basics"]["name"].strip())
    name = "_".join(w[0].upper() + w[1:].lower() if re.match(r"^[A-Za-z]", w) else w for w in words)
    return re.sub(r'[\\/:*?"<>|]', "", name) or "Resume"
