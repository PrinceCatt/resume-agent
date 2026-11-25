"""DeepSeek through its OpenAI-compatible chat completions API. Any other OpenAI-compatible
endpoint works by changing baseUrl/model in settings."""

from __future__ import annotations

import asyncio
import json
import math
import re
import time
from typing import Any
from urllib.parse import urlsplit

from . import net
from .db import run
from .events import emit
from .jsutil import is_num, js_json, to_fixed
from .settings import get_settings


class LlmError(Exception):
    pass


# Set when DeepSeek answered 402 or its balance endpoint says the account cannot be used. Until it clears
# (a call that works, a balance check that shows money, a new key), nothing calls the model: on 2026-11-13
# an empty balance failed every queued job one by one with the same error.
_no_balance: dict[str, str] | None = None


def llm_ready() -> dict[str, Any]:
    s = get_settings()
    if s["llmMode"] == "demo":
        return {"ok": True}
    if not s["apiKey"]:
        return {"ok": False, "code": "no_key", "reason": "还没填 DeepSeek API key：到「设置」里填上，或者先切到演示模式。"}
    if _no_balance is not None:
        bal = _no_balance["balance"]
        return {
            "ok": False,
            "code": "no_balance",
            "reason": f"DeepSeek 账户余额不足{f'（{bal}）' if bal else ''}：充值后点岗位页上的「充好了，继续」。",
        }
    return {"ok": True}


def set_no_balance(balance: str | None) -> None:
    global _no_balance
    was = _no_balance is not None
    _no_balance = None if balance is None else {"balance": balance}
    if was != (_no_balance is not None):
        emit("settings")


def no_balance_value() -> str | None:
    return None if _no_balance is None else _no_balance["balance"]


_balance_cache: dict[str, Any] | None = None


def money(b: dict[str, Any]) -> str:
    return f"{'$' if b['currency'] == 'USD' else '¥'}{to_fixed(b['total'], 2)}"


def _host_of(url: str) -> str:
    try:
        return urlsplit(url).hostname or ""
    except ValueError:
        return ""


async def get_balance(fresh: bool = False) -> dict[str, Any] | None:
    """DeepSeek's balance (a free call). None for other providers, demo mode, no key, or when it cannot be read."""
    global _balance_cache
    s = get_settings()
    if s["llmMode"] != "deepseek" or not s["apiKey"] or not re.search(r"(^|\.)deepseek\.com$", _host_of(s["baseUrl"])):
        return None
    now = time.monotonic()
    if not fresh and _balance_cache and _balance_cache["key"] == s["apiKey"] and now - _balance_cache["at"] < 60:
        return _balance_cache["value"]
    value: dict[str, Any] | None = None
    try:
        res = await net.request(
            "GET",
            f"{s['baseUrl'].rstrip('/')}/user/balance",
            headers={"Authorization": f"Bearer {s['apiKey']}", "Accept": "application/json"},
            timeout=15,
        )
        if res.ok:
            b = json.loads(res.text)
            infos = b.get("balance_infos") if isinstance(b, dict) and isinstance(b.get("balance_infos"), list) else []
            info = next((i for i in infos if isinstance(i, dict) and i.get("currency") == "CNY"), infos[0] if infos else None)
            info = info if isinstance(info, dict) else {}
            try:
                total = float(info.get("total_balance") or 0)
                if not math.isfinite(total):
                    total = 0.0
            except (TypeError, ValueError):
                total = 0.0
            value = {
                "available": isinstance(b, dict) and b.get("is_available") is True,
                "total": total,
                "currency": str(info.get("currency") if info.get("currency") is not None else "CNY"),
            }
    except Exception:  # noqa: BLE001 - offline or the endpoint moved: say nothing rather than block
        pass
    _balance_cache = {"at": now, "key": s["apiKey"], "value": value}
    if value:
        set_no_balance(None if value["available"] else money(value))
    return value


def is_demo() -> bool:
    return get_settings()["llmMode"] == "demo"


async def chat(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    json_mode: bool = False,
    temperature: float | None = None,
    max_tokens: int | None = None,
    usage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Returns {"content": str, "toolCalls": [...]}."""
    s = get_settings()
    if not s["apiKey"]:
        raise LlmError("没有 API key")
    body: dict[str, Any] = {
        "model": s["model"],
        "messages": messages,
        "temperature": 0.2 if temperature is None else temperature,
        "max_tokens": 4096 if max_tokens is None else max_tokens,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    if json_mode:
        body["response_format"] = {"type": "json_object"}

    last_err: BaseException | None = None
    for attempt in range(3):
        try:
            res = await net.request(
                "POST",
                f"{s['baseUrl'].rstrip('/')}/chat/completions",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {s['apiKey']}"},
                body=js_json(body),
                timeout=180,
            )
            if res.status == 429 or res.status >= 500:
                last_err = LlmError(f"模型接口 {res.status}")
                await net.sleep(1.5 * (attempt + 1))
                continue
            if not res.ok:
                hint = "（API key 不对）" if res.status == 401 else "（账户余额不足）" if res.status == 402 else ""
                if res.status == 402:
                    set_no_balance(no_balance_value() or "")
                raise LlmError(f"模型接口 {res.status}{hint}: {res.text[:300]}")
            data = json.loads(res.text)
            if _no_balance is not None:
                set_no_balance(None)
            _record_usage(usage, data.get("usage") if isinstance(data, dict) else None)
            choices = data.get("choices") if isinstance(data, dict) else None
            msg = (choices[0].get("message") if choices and isinstance(choices[0], dict) else None) or {}
            return {"content": msg.get("content") or "", "toolCalls": msg.get("tool_calls") or []}
        except LlmError:
            raise
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - network errors are retried like fetch rejections
            last_err = e
            await net.sleep(1.5 * (attempt + 1))
    if isinstance(last_err, Exception):
        raise last_err
    raise LlmError(str(last_err))


def _record_usage(tag: dict[str, Any] | None, u: Any) -> None:
    if not u or not isinstance(u, dict):
        return

    def n(v: Any) -> int:
        return math.floor(v + 0.5) if is_num(v) and math.isfinite(v) else 0

    kind = (tag or {}).get("kind") or "test"
    try:
        run(
            "INSERT INTO usage (job_id, kind, prompt_tokens, completion_tokens, cache_hit_tokens) VALUES (?, ?, ?, ?, ?)",
            (tag or {}).get("jobId"),
            kind,
            n(u.get("prompt_tokens")),
            n(u.get("completion_tokens")),
            n(u.get("prompt_cache_hit_tokens")),
        )
    except Exception:  # noqa: BLE001 - the job may have been deleted while the call was running
        try:
            run(
                "INSERT INTO usage (job_id, kind, prompt_tokens, completion_tokens, cache_hit_tokens) VALUES (NULL, ?, ?, ?, ?)",
                kind,
                n(u.get("prompt_tokens")),
                n(u.get("completion_tokens")),
                n(u.get("prompt_cache_hit_tokens")),
            )
        except Exception:  # noqa: BLE001 - never let bookkeeping break a call
            pass


async def chat_json(system: str, user: str, max_tokens: int = 4096, usage: dict[str, Any] | None = None) -> Any:
    """JSON-mode call; tolerates a fenced block."""
    r = await chat(
        messages=[
            # JSON mode needs the word "json" in the prompt. Output costs four times what uncached input does, and
            # pretty-printed JSON spends a token or so per line on line breaks and indentation.
            {"role": "system", "content": f"{system}\n\nRespond with a single json object, minified: no line breaks or indentation."},
            {"role": "user", "content": user},
        ],
        json_mode=True,
        max_tokens=max_tokens,
        usage=usage,
    )
    text = re.sub(r"```$", "", re.sub(r"^```(?:json)?\s*", "", r["content"].strip(), flags=re.I))
    try:
        return json.loads(text)
    except ValueError:
        raise LlmError(f"模型没有返回合法 JSON：{text[:200]}") from None
