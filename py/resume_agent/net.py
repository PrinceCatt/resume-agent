"""Outgoing HTTP in one place (the model API, DeepSeek's balance, job searches), so tests can replace
`request` the way the TypeScript tests replace globalThis.fetch."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import aiohttp


@dataclass
class Response:
    status: int
    text: str

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


async def _request(method: str, url: str, headers: dict[str, str] | None = None, body: str | None = None, timeout: float = 30) -> Response:
    t = aiohttp.ClientTimeout(total=timeout)
    async with aiohttp.ClientSession(timeout=t) as s:
        async with s.request(method, url, headers=headers, data=body.encode("utf-8") if body is not None else None) as r:
            return Response(r.status, await r.text(errors="replace"))


async def request(method: str, url: str, headers: dict[str, str] | None = None, body: str | None = None, timeout: float = 30) -> Response:
    """Raises on network errors and timeouts (asyncio.TimeoutError / aiohttp.ClientError), like fetch rejects."""
    return await _request(method, url, headers, body, timeout)


async def sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)
