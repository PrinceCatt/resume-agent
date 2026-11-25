"""Two browsers:
- Your own, everyday Edge (or Chrome) with all your sign-ins. Application forms are filled in
  tabs the assistant opens there, so you can watch and take over. A browser started from its
  normal profile refuses remote debugging (Chromium 136+), so the connection goes through
  Microsoft's Playwright extension installed in that browser; relay.py starts a local CDP relay
  (the same protocol as Playwright's Node "extension mode"), opens the extension's connect page in
  your running browser, and Playwright connects to the relay over CDP.
- A headless one, never visible, for rendering PDFs and reading public job pages.

Development switch: RESUME_AGENT_HEADLESS_BROWSER=1 never touches your own browser. The tabs the agent
would open there open in a fresh headless browser instead (for local tests against fixtures/)."""

from __future__ import annotations

import asyncio
import os
import re
import weakref
from typing import Any, Callable

from playwright.async_api import Browser, BrowserContext, Page, Playwright, async_playwright

from .events import emit
from .settings import get_settings

EXTENSION_URL = "https://chromewebstore.google.com/detail/mmlmfjhmonkocbjadbfplnigmagldckm"


def headless_only() -> bool:
    """Dev-only: run the agent's own tabs in a headless browser instead of connecting to yours."""
    return os.environ.get("RESUME_AGENT_HEADLESS_BROWSER", "") not in ("", "0", "false")


_pw: Playwright | None = None
_pw_lock = asyncio.Lock()
_conn: dict[str, Any] | None = None  # {"browser": Browser, "ctx": BrowserContext, "relay": relay or None}
_connecting: asyncio.Future | None = None
# Bumped when an attempt is abandoned, so a connection that only arrives later is dropped
# instead of silently becoming the live one.
_attempt = 0
_last_error = ""
_headless: asyncio.Future | None = None
_close_listeners: set[Callable[[], None]] = set()
_mine: weakref.WeakSet[Page] = weakref.WeakSet()


async def playwright() -> Playwright:
    global _pw
    async with _pw_lock:
        if _pw is None:
            _pw = await async_playwright().start()
        return _pw


def on_browser_closed(fn: Callable[[], None]) -> Callable[[], None]:
    _close_listeners.add(fn)
    return lambda: _close_listeners.discard(fn)


def browser_state() -> dict[str, Any]:
    """off: not connected. waiting: the connect page is open in your browser, waiting for the extension."""
    return {
        "status": "on" if _conn else "waiting" if _connecting else "off",
        "error": _last_error,
        "tokenSet": len(get_settings()["extensionToken"]) > 0,
    }


def browser_open() -> bool:
    return _conn is not None


def _which() -> str:
    return "Chrome" if get_settings()["browserChannel"] == "chrome" else "Edge"


def _friendly(e: BaseException) -> str:
    msg = str(e)
    which = _which()
    if re.search(r"Playwright Extension not found", msg, re.I):
        return f"你的 {which} 里还没装 Playwright Extension（在 Chrome 应用商店里，商店页面上有时叫 Playwright MCP Bridge；Edge 自己的扩展商店里没有）：在 {which} 里打开设置页给的链接安装（Edge 会问是否允许来自其他商店的扩展，选允许），装好后再点「连接」。"
    if re.search(r"did not connect within", msg, re.I):
        return f"{which} 里的 Playwright 扩展 30 秒内没连上：设置里填的令牌要和扩展状态页（点工具栏里它的图标）上显示的一样；不确定就清空令牌，改成每次在 {which} 里点允许。"
    if re.search(r"executable not found|Unsupported channel", msg, re.I):
        return f"这台电脑上找不到 {which}。"
    return f"连不上你的 {which}：{msg.split(chr(10))[0]}"


def _fire_closed() -> None:
    for fn in list(_close_listeners):
        try:
            fn()
        except Exception:  # noqa: BLE001
            pass


async def _connect(my: int) -> dict[str, Any]:
    s = get_settings()
    pw = await playwright()
    relay = None
    if headless_only():
        b = await pw.chromium.launch(channel=s["browserChannel"], headless=True)
        ctx = await b.new_context()
    else:
        from .relay import create_extension_browser

        b, relay = await create_extension_browser(pw, s["browserChannel"], s["extensionToken"] or None, client_name="投递助手")
        ctx = b.contexts[0] if b.contexts else None
    if my != _attempt:
        # Disconnects only: a browser reached over CDP is not closed by close().
        try:
            await b.close()
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError("superseded")
    if ctx is None:
        raise RuntimeError("扩展连上了，但没有可用的标签页")

    def on_disconnected(_: Any = None) -> None:
        global _conn
        if not _conn or _conn["browser"] is not b:
            return
        _conn = None
        if relay:
            relay.stop()
        _fire_closed()
        emit("browser")

    b.on("disconnected", on_disconnected)
    return {"browser": b, "ctx": ctx, "relay": relay}


def _start_connect() -> asyncio.Future:
    global _attempt, _last_error, _connecting
    _attempt += 1
    my = _attempt
    _last_error = ""

    async def go() -> dict[str, Any]:
        global _conn, _connecting, _last_error
        try:
            c = await _connect(my)
        except Exception as e:  # noqa: BLE001
            if my == _attempt:
                _connecting = None
                _last_error = _friendly(e)
                emit("browser")
            raise RuntimeError(_last_error if my == _attempt else "已经换成新的连接") from None
        _conn = c
        _connecting = None
        emit("browser")
        return c

    fut = asyncio.ensure_future(go())
    fut.add_done_callback(lambda f: f.cancelled() or f.exception())
    _connecting = fut
    emit("browser")
    return fut


async def get_context(wait_ms: int = 180_000) -> BrowserContext:
    """Connects to your browser, or waits for the attempt already under way; gives up waiting after wait_ms but leaves the attempt running."""
    if _conn:
        return _conn["ctx"]
    fut = _connecting or _start_connect()
    try:
        c = await asyncio.wait_for(asyncio.shield(fut), wait_ms / 1000)
    except asyncio.TimeoutError:
        which = _which()
        raise RuntimeError(f"还没连上你的 {which}：在 {which} 里打开的 Playwright 连接页上点允许（或在设置里填扩展的令牌），然后再试。") from None
    return c["ctx"]


async def reconnect(wait_ms: int | None = None) -> BrowserContext:
    """Starts a fresh connection attempt, abandoning one that is stuck (e.g. its connect page was closed)."""
    global _attempt, _connecting
    if not _conn:
        _attempt += 1
        _connecting = None
    return await get_context(wait_ms if wait_ms is not None else 180_000)


async def new_visible_page(url: str | None = None) -> Page:
    """Opens a new tab in your browser (in the assistant's tab group)."""
    ctx = await get_context()
    page = await ctx.new_page()
    _mine.add(page)
    if url:
        await page.goto(url, wait_until="domcontentloaded", timeout=45_000)
    return page


def is_own_tab(page: Page) -> bool:
    """True for tabs the assistant opened itself, as opposed to your own tabs."""
    return page in _mine


async def get_headless() -> Browser:
    global _headless
    if _headless is None:

        async def launch() -> Browser:
            pw = await playwright()
            b = await pw.chromium.launch(channel=get_settings()["browserChannel"], headless=True)

            def gone(_: Any = None) -> None:
                global _headless
                _headless = None

            b.on("disconnected", gone)
            return b

        fut = asyncio.ensure_future(launch())

        def failed(f: asyncio.Future) -> None:
            global _headless
            if f.cancelled() or f.exception():
                if _headless is f:
                    _headless = None

        fut.add_done_callback(failed)
        _headless = fut
    return await asyncio.shield(_headless)


async def close_all() -> None:
    """Disconnects from your browser (its window and tabs stay as they are) and closes the headless one."""
    global _conn, _connecting, _headless, _attempt
    c = _conn
    hl = _headless
    _attempt += 1
    _conn = None
    _connecting = None
    _headless = None
    if c:
        _fire_closed()
        emit("browser")
    tasks = []
    if c:
        tasks.append(c["browser"].close())
    if hl is not None:

        async def close_hl() -> None:
            b = await hl
            await b.close()

        tasks.append(close_hl())
    await asyncio.gather(*tasks, return_exceptions=True)
    if c and c.get("relay"):
        c["relay"].stop()


async def shutdown() -> None:
    """close_all, then stop the Playwright driver."""
    global _pw
    await close_all()
    if _pw is not None:
        try:
            await _pw.stop()
        except Exception:  # noqa: BLE001
            pass
        _pw = None
