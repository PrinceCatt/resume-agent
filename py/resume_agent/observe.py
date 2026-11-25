"""Page snapshot for the agent: every form control, button and action link in every frame
(open shadow roots included), tagged with a data-ra-id the agent refers to."""

from __future__ import annotations

import json
import weakref
from pathlib import Path
from typing import Any

from .jsutil import js_json

# The in-page collector, the same function as in server/observe.ts (types stripped).
COLLECT_JS = (Path(__file__).parent / "collect.js").read_text("utf-8")

_frame_ids: "weakref.WeakKeyDictionary[Any, str]" = weakref.WeakKeyDictionary()
_frame_seq = 0


def _frame_prefix(f: Any) -> str:
    global _frame_seq
    p = _frame_ids.get(f)
    if not p:
        p = f"f{_frame_seq}_"
        _frame_seq += 1
        _frame_ids[f] = p
    return p


async def observe(page: Any, more: bool = False) -> dict[str, Any]:
    """more: list every ordinary button and link too (up to the cap), for when the agent is looking for one."""
    elements: list[dict[str, Any]] = []
    errors: list[str] = []
    excerpt = ""
    title = ""
    omitted = 0
    for f in page.frames:
        if f.is_detached():
            continue
        main = f == page.main_frame
        if not main:
            try:
                h = await f.frame_element()
                box = await h.bounding_box()
            except Exception:  # noqa: BLE001
                box = None
            if not box or box["width"] < 60 or box["height"] < 60:
                continue
        try:
            r = await f.evaluate(COLLECT_JS, {"prefix": _frame_prefix(f), "ordinary": 260 if more else 40})
            elements += r["elements"]
            errors += r["errors"]
            omitted += r["omitted"]
            if main:
                excerpt = r["excerpt"]
                title = r["title"]
            elif r["elements"]:
                excerpt += f"\n[frame] {r['excerpt'][:900]}"
        except Exception:  # noqa: BLE001 - frame navigated mid-read
            pass
    uniq: list[str] = []
    for e in errors:
        if e not in uniq:
            uniq.append(e)
    return {"url": page.url, "title": title, "errors": uniq[:12], "elements": elements, "excerpt": excerpt, "omitted": omitted}


def locate(page: Any, id_: str) -> Any | None:
    import re

    prefix = re.sub(r"\d+$", "", id_)
    frame = next((f for f in page.frames if _frame_ids.get(f) == prefix), None)
    if not frame or frame.is_detached():
        return None
    return frame.locator(f'[data-ra-id="{id_.replace(chr(34), "")}"]').first


def _q(s: str) -> str:
    return js_json(s[:140] + "…" if len(s) > 140 else s)


def format_obs(o: dict[str, Any], step: int) -> str:
    """Compact text form of a snapshot for the model."""
    lines = [f"STEP {step} — page snapshot", f"URL: {o['url']}", f"Title: {o['title']}"]
    if o["errors"]:
        lines.append(f"Errors/alerts on page: {' ; '.join(_q(e) for e in o['errors'])}")
    lines.append("Elements:")
    dialog_open = any(e["inDialog"] for e in o["elements"])
    if dialog_open:
        lines.append("  -- inside the dialog open on top of the page (work here first) --")
    last_group = ""
    behind = False
    for e in o["elements"]:
        if dialog_open and not e["inDialog"] and not behind:
            behind = True
            last_group = ""
            lines.append("  -- behind the dialog (usually not usable until it closes) --")
        if e["kind"] in ("radio", "checkbox") and e["group"] and e["group"] != last_group:
            lines.append(f"  group {_q(e['group'])}:")
        last_group = e["group"] if e["kind"] in ("radio", "checkbox") else ""
        lines.append(("    " if last_group else "") + _el_line(e))
    if not o["elements"]:
        lines.append("  (no interactive elements found)")
    if o.get("omitted"):
        lines.append(
            f"  ({o['omitted']} more ordinary buttons/links not listed, e.g. long lists of other jobs, menus; every form field, every button inside a form and every apply/next/submit-like button IS listed. If you need one that is not listed, scroll once: the next snapshot lists them all)"
        )
    lines += ["Visible text (start):", o["excerpt"][:1800]]
    return "\n".join(lines)


def _el_line(e: dict[str, Any], options: bool = True) -> str:
    flags = " ".join(
        x for x in ("*required" if e["required"] else "", "disabled" if e["disabled"] else "", "INVALID" if e["invalid"] else "", "hidden" if e["hidden"] else "") if x
    )
    line = f"[{e['id']}] {e['kind']}"
    if e["kind"] in ("button", "link", "option"):
        line += f" {_q(e['text'])}"
    else:
        line += f" {_q(e['label'])}"
    if flags:
        line += f" {flags}"
    if e["kind"] in ("radio", "checkbox"):
        line += " [x]" if e["checked"] else " [ ]"
    elif e["kind"] == "file":
        line += f" file={_q(e['value'])}" if e["value"] else " (no file)"
    elif e["kind"] not in ("button", "link", "option"):
        line += f" = {_q(e['value'])}"
    if options and e.get("options"):
        more = f" … (+{e['optionCount'] - len(e['options'])} more)" if e["optionCount"] > len(e["options"]) else ""
        line += f" options: {' | '.join(e['options'])}{more}"
    return line


def _layout(o: dict[str, Any]) -> str:
    """The page's layout: its URL and the same elements in the same order, labels and options. Values are left out."""
    return json.dumps(
        [o["url"], [[e["id"], e["kind"], e["label"], e["group"], e["text"], e.get("options"), e["optionCount"], e["inDialog"]] for e in o["elements"]]]
    )


def _state(e: dict[str, Any]) -> str:
    return json.dumps([e["value"], e["checked"], e["required"], e["disabled"], e["invalid"], e["hidden"]])


DELTA_MARK = " — same page and elements as the STEP "


def format_delta(base: dict[str, Any], cur: dict[str, Any], base_step: int, step: int) -> str | None:
    """After a turn that only filled fields, the page usually has the same layout and only new values. Sending
    the whole snapshot again cost 3,500-4,000 uncached tokens a step; this sends the elements that changed
    since the last full snapshot (which stays in the conversation, so DeepSeek serves it from its cache).
    None when the layout changed or the changes are not much smaller than the page: send a full snapshot."""
    if _layout(base) != _layout(cur):
        return None
    changed = [e for i, e in enumerate(cur["elements"]) if _state(e) != _state(base["elements"][i])]
    lines = [f"STEP {step}{DELTA_MARK}{base_step} snapshot above (ids unchanged). Elements that changed since then:"]
    for e in changed:
        grp = f" (group {_q(e['group'])})" if e["kind"] in ("radio", "checkbox") and e["group"] else ""
        lines.append(f"  {_el_line(e, False)}{grp}")
    if not changed:
        lines.append("  (none)")
    if cur["errors"]:
        lines.append(f"Errors/alerts on page now: {' ; '.join(_q(x) for x in cur['errors'])}")
    elif base["errors"]:
        lines.append("Errors/alerts on page now: none")
    if cur["excerpt"] == base["excerpt"]:
        lines.append("Visible text: unchanged.")
    else:
        lines += ["Visible text (start), now:", cur["excerpt"][:1800]]
    text = "\n".join(lines)
    return text if len(text) < len(format_obs(cur, step)) * 0.6 else None
