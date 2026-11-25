"""A tiny in-process queue for background work (reading job pages, tailoring, filling forms)."""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from typing import Awaitable, Callable

Task = Callable[[], Awaitable[None]]
log = logging.getLogger("resume_agent")


class Queue:
    def __init__(self, concurrency: Callable[[], int]):
        self._concurrency = concurrency
        self._waiting: deque[Task] = deque()
        self._active = 0
        self._running: set[asyncio.Task] = set()

    def _pump(self) -> None:
        while self._active < max(1, self._concurrency()) and self._waiting:
            t = self._waiting.popleft()
            self._active += 1
            fut = asyncio.ensure_future(self._run(t))
            self._running.add(fut)
            fut.add_done_callback(self._running.discard)

    async def _run(self, t: Task) -> None:
        try:
            await t()
        except Exception:  # noqa: BLE001 - mirrors .catch((e) => console.error("[task]", e))
            log.exception("[task]")
        finally:
            self._active -= 1
            self._pump()

    def push(self, t: Task) -> None:
        self._waiting.append(t)
        self._pump()

    def size(self) -> int:
        return len(self._waiting) + self._active


def make_queue(concurrency: Callable[[], int]) -> Queue:
    return Queue(concurrency)
