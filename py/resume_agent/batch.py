"""Batch work (一键处理, and the automatic pipeline after a job is read) can wait for DeepSeek's off-peak
hours, when every call costs half. Reading a posting never waits: it is cheap, and its fit score is
what you screen with. Tailoring and form filling are the cost, so while the setting is on their next
step waits in jobs.held and starts from here — off-peak only, and only when a slot is free, so nothing
sits in a queue and starts after the next peak has begun. Work already running is never stopped."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from . import agent, jobs
from .db import all_rows
from .jobs import get_job, set_job
from .llm import llm_ready
from .offpeak import is_peak
from .settings import get_settings
from .tailor import queue_tailor

# Jobs you told to go now: the rest of their steps skip the wait. Kept in memory, like the queues.
go_now: set[int] = set()


def holding() -> bool:
    """Whether batch steps wait at all: the setting is on and DeepSeek (which has the peak price) is the model."""
    s = get_settings()
    return bool(s["offPeakOnly"]) and s["llmMode"] == "deepseek"


def next_step(j: dict[str, Any]) -> str | None:
    if j["stage"] in ("applied", "skipped") or not j["jd"]:
        return None
    return "apply" if j["tailored"] else "tailor"


def _start(j: dict[str, Any]) -> None:
    step = next_step(j)
    set_job(j["id"], {"held": None})
    if step == "tailor":
        queue_tailor(j["id"], lambda: advance(j["id"]))
    elif step == "apply":
        go_now.discard(j["id"])
        try:
            agent.start_run(j["id"])
        except Exception as e:  # noqa: BLE001
            set_job(j["id"], {"error": str(e)})


def advance(id_: int) -> None:
    """The next step of a job in a batch (tailor, then fill): now, or held until off-peak and a free slot."""
    j = get_job(id_)
    if not j or not next_step(j):
        return
    if not holding() or id_ in go_now:
        return _start(j)
    set_job(id_, {"held": next_step(j)})
    pump()


def pump(now: datetime | None = None) -> None:
    """Starts held steps while it is off-peak and a slot is free; all of them at once if the setting was turned off."""
    held = all_rows("SELECT id, held FROM jobs WHERE held IS NOT NULL ORDER BY CASE held WHEN 'apply' THEN 0 ELSE 1 END, updated_at, id")
    gate = holding()
    # No key or no balance: starting them would only fail each one. They keep waiting.
    ready = llm_ready()["ok"]
    for h in held:
        j = get_job(h["id"])
        if not j:
            continue
        if not next_step(j):
            set_job(j["id"], {"held": None})
            continue
        if not ready or (gate and is_peak(now)):
            continue
        free = agent.run_slot_free() if h["held"] == "apply" else jobs.bg_queue.size() < 2
        if not gate or free:
            _start(j)


def run_now(ids: list[int] | None = None) -> None:
    """"现在就跑": held jobs (these, or all of them) start now and skip the wait for their remaining steps."""
    held = [r["id"] for r in all_rows("SELECT id FROM jobs WHERE held IS NOT NULL")]
    for id_ in [h for h in held if h in ids] if ids is not None else held:
        go_now.add(id_)
        j = get_job(id_)
        if j:
            _start(j)
