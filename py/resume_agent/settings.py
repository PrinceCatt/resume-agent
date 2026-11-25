"""Settings stored as JSON values in the settings table (same keys and encoding as server/settings.ts)."""

from __future__ import annotations

import json
from typing import Any

from .db import all_rows, run
from .jsutil import is_num, js_json

DEFAULT_SETTINGS: dict[str, Any] = {
    # "deepseek" calls the API; "demo" runs a rule-based stand-in so the flow can be tried without a key.
    "llmMode": "deepseek",
    "apiKey": "",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-chat",
    # Which of your own browsers forms are filled in (through the Playwright Extension installed there).
    "browserChannel": "msedge",
    # The Playwright Extension's token: lets it connect without you clicking allow each time. Kept on the server like the API key.
    "extensionToken": "",
    # How many application forms are filled at the same time.
    "concurrency": 2,
    "maxSteps": 40,
    "coverLetter": True,
    # "auto" follows the job posting's language.
    "resumeLanguage": "auto",
    # The automatic pipeline stops after reading a job whose fit score is below this (0 = never).
    "minFit": 0,
    # Batch tailoring and form filling wait for DeepSeek's off-peak hours (half price). Reading postings never waits.
    "offPeakOnly": False,
}


def _same_type(v: Any, d: Any) -> bool:
    """typeof v === typeof def."""
    if isinstance(d, bool):
        return isinstance(v, bool)
    if is_num(d):
        return is_num(v)
    if isinstance(d, str):
        return isinstance(v, str)
    return type(v) is type(d)


def get_settings() -> dict[str, Any]:
    s = dict(DEFAULT_SETTINGS)
    for r in all_rows("SELECT key, value FROM settings"):
        if r["key"] not in DEFAULT_SETTINGS:
            continue
        try:
            s[r["key"]] = json.loads(r["value"])
        except (ValueError, TypeError):
            pass  # ignore a bad row
    return s


def save_settings(patch: dict[str, Any]) -> dict[str, Any]:
    cur = get_settings()
    for k, v in patch.items():
        if k not in DEFAULT_SETTINGS or v is None:
            continue
        if not _same_type(v, DEFAULT_SETTINGS[k]):
            continue
        if is_num(v) and isinstance(v, float) and v.is_integer():
            v = int(v)
        run(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            k,
            js_json(v),
        )
    return {**cur, **get_settings()}


def public_settings() -> dict[str, Any]:
    """What the browser UI gets: the API key and the extension token never leave the server."""
    s = get_settings()
    api_key = s.pop("apiKey")
    token = s.pop("extensionToken")
    return {
        **s,
        "hasKey": len(api_key) > 0,
        "keyHint": f"{api_key[:3]}…{api_key[-4:]}" if api_key else "",
        "hasExtensionToken": len(token) > 0,
    }
