"""Server-sent events: the UI refetches whatever a message names, so payloads stay tiny.
Each open /api/events stream owns a queue; emit() is plain synchronous code (callable from anywhere on the loop)."""

from __future__ import annotations

import asyncio

from .jsutil import js_json

clients: set[asyncio.Queue[str]] = set()


def add_client() -> asyncio.Queue[str]:
    q: asyncio.Queue[str] = asyncio.Queue()
    clients.add(q)
    return q


def remove_client(q: asyncio.Queue[str]) -> None:
    clients.discard(q)


def emit(type_: str, id_: int | None = None) -> None:
    """type: job | run | profile | settings | browser | schedule. id is left out when None, as JSON.stringify does."""
    payload: dict = {"type": type_}
    if id_ is not None:
        payload["id"] = id_
    msg = f"data: {js_json(payload)}\n\n"
    for q in list(clients):
        q.put_nowait(msg)
