"""Connecting to your own, everyday browser through Microsoft's Playwright extension.

A port of Playwright's Node "extension mode" (tools/mcp/cdpRelay.ts, cdpRelayV2.ts, browserModel.ts,
extensionContextFactory.ts, utils/extension.ts in playwright-core 1.65), which the TypeScript server uses
and the Python package does not ship: a local WebSocket relay with two ends, /extension/<uuid> for the
extension and /cdp/<uuid> for Playwright. The extension's connect page is opened in your running browser
(the profile the extension is installed in); once it connects, Playwright connects to the relay over CDP and
the relay turns CDP into chrome.tabs / chrome.debugger calls the extension makes for it.

This file is a derivative work of Playwright, Copyright (c) Microsoft Corporation, licensed under the Apache
License 2.0 (py/licenses/playwright-LICENSE.txt, with its NOTICE in py/licenses/playwright-NOTICE.txt). It was
translated from TypeScript to Python and changed to fit this app; the rest of the project is MIT."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlencode, urlsplit

from aiohttp import WSMsgType, web

log = logging.getLogger("resume_agent.relay")

EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm"
INSTALL_URL = f"https://chromewebstore.google.com/detail/playwright-extension/{EXTENSION_ID}"
PROTOCOL_VERSION = 2
CONNECT_TIMEOUT = float(os.environ.get("PWTEST_EXTENSION_CONNECT_TIMEOUT", "30000")) / 1000
LOOPBACK = {"localhost", "127.0.0.1", "[::1]"}


# ---- where the browser and its profiles are (utils/chromiumChannels.ts, utils/extension.ts)


def default_user_data_dir(channel: str) -> Path | None:
    home = Path.home()
    local = Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local")
    linux_home = Path(os.environ.get("CHROME_CONFIG_HOME") or os.environ.get("XDG_CONFIG_HOME") or home / ".config")

    def linux(product: str) -> Path:
        return Path(os.environ["CHROME_USER_DATA_DIR"]) if os.environ.get("CHROME_USER_DATA_DIR") else linux_home / product

    table = {
        "chrome": {"win32": local / "Google" / "Chrome" / "User Data", "darwin": home / "Library/Application Support/Google/Chrome", "linux": linux("google-chrome")},
        "msedge": {"win32": local / "Microsoft" / "Edge" / "User Data", "darwin": home / "Library/Application Support/Microsoft Edge", "linux": linux("microsoft-edge")},
    }
    plat = "win32" if sys.platform == "win32" else "darwin" if sys.platform == "darwin" else "linux"
    return table.get(channel, {}).get(plat)


def find_executable(channel: str) -> str | None:
    """Where Playwright's registry looks for the stable Chrome / Edge."""
    if channel not in ("chrome", "msedge"):
        raise RuntimeError(f'Unsupported channel: "{channel}"')
    if sys.platform == "win32":
        tail = r"Microsoft\Edge\Application\msedge.exe" if channel == "msedge" else r"Google\Chrome\Application\chrome.exe"
        roots = [os.environ.get(k) for k in ("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)")]
        candidates = [str(Path(r) / tail) for r in roots if r]
    elif sys.platform == "darwin":
        candidates = ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" if channel == "msedge" else "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    else:
        candidates = ["/opt/microsoft/msedge/msedge" if channel == "msedge" else "/opt/google/chrome/chrome"]
    return next((c for c in candidates if Path(c).is_file()), None)


def list_profile_directories(user_data_dir: Path) -> list[str]:
    try:
        entries = os.listdir(user_data_dir)
    except OSError:
        return []
    profiles = [e for e in entries if e == "Default" or (e.startswith("Profile ") and e[8:].isdigit())]
    return sorted(profiles, key=lambda p: -1 if p == "Default" else int(p[8:]))


def read_last_used_profile(user_data_dir: Path) -> str | None:
    try:
        state = json.loads((user_data_dir / "Local State").read_text("utf-8"))
    except (OSError, ValueError):
        return None
    last = state.get("profile", {}).get("last_used") if isinstance(state, dict) and isinstance(state.get("profile"), dict) else None
    return last if isinstance(last, str) else None


def _has_settings_record(prefs_path: Path) -> bool:
    try:
        prefs = json.loads(prefs_path.read_text("utf-8"))
    except (OSError, ValueError):
        return False
    try:
        record = prefs["extensions"]["settings"][EXTENSION_ID]
    except (KeyError, TypeError):
        return False
    return isinstance(record, dict) and len(record) > 0


def is_extension_installed_in_profile(profile_dir: Path) -> bool:
    if (profile_dir / "Extensions" / EXTENSION_ID).exists():
        return True
    return any(_has_settings_record(profile_dir / f) for f in ("Preferences", "Secure Preferences"))


def find_extension_profile(user_data_dir: Path) -> str | None:
    """The last used profile first, then the others; the first one with the extension installed."""
    profiles = list_profile_directories(user_data_dir)
    last = read_last_used_profile(user_data_dir)
    ordered = [last, *[p for p in profiles if p != last]] if last and last in profiles else profiles
    return next((p for p in ordered if is_extension_installed_in_profile(user_data_dir / p)), None)


# ---- the model of the extension's tabs (browserModel.ts)


class BrowserModel:
    def __init__(self, send_to_extension: Callable[[str, Any], Awaitable[Any]]):
        self._send_to_cdp_client: Callable[[dict[str, Any]], None] | None = None
        self._known_tabs: dict[int, dict[str, Any]] = {}
        self._tab_sessions: dict[int, dict[str, Any]] = {}
        self._auto_attach = False
        self._next_session_id = 1
        self._send_to_extension = send_to_extension
        self._tasks: set[asyncio.Task] = set()

    def connect_over_cdp(self, send: Callable[[dict[str, Any]], None]) -> None:
        self._send_to_cdp_client = send

    def _emit(self, message: dict[str, Any]) -> None:
        if self._send_to_cdp_client:
            self._send_to_cdp_client(message)

    def _background(self, aw: Awaitable[Any]) -> None:
        t = asyncio.ensure_future(aw)
        self._tasks.add(t)

        def done(f: asyncio.Future) -> None:
            self._tasks.discard(f)
            if not f.cancelled() and f.exception():
                log.debug("relay: %s", f.exception())

        t.add_done_callback(done)

    # extension → model
    def on_tab_created(self, tab: dict[str, Any]) -> None:
        if not isinstance(tab, dict) or tab.get("id") is None:
            return
        self._known_tabs[tab["id"]] = tab
        if self._auto_attach:
            self._background(self._attach_tab(tab["id"]))

    def on_tab_removed(self, tab_id: int) -> None:
        self._known_tabs.pop(tab_id, None)
        self._detach_tab(tab_id)

    def on_debugger_event(self, source: dict[str, Any], method: str, params: Any) -> None:
        if not isinstance(source, dict) or source.get("tabId") is None:
            return
        tab_session = self._tab_sessions.get(source["tabId"])
        if not tab_session:
            return
        child = params.get("sessionId") if isinstance(params, dict) else None
        if method == "Target.attachedToTarget" and child:
            tab_session["childSessions"].add(child)
        elif method == "Target.detachedFromTarget" and child:
            tab_session["childSessions"].discard(child)
        session_id = source.get("sessionId") or tab_session["sessionId"]
        self._emit(_clean({"sessionId": session_id, "method": method, "params": params}))

    def on_debugger_detach(self, source: dict[str, Any]) -> None:
        if isinstance(source, dict) and source.get("tabId") is not None:
            self._detach_tab(source["tabId"])

    # Playwright → model
    async def enable_auto_attach(self) -> None:
        self._auto_attach = True
        await asyncio.gather(*(self._attach_tab(t) for t in list(self._known_tabs)), return_exceptions=True)

    async def create_target(self, url: str | None, active: bool) -> dict[str, Any]:
        tab = await self._send_to_extension("chrome.tabs.create", [_clean({"url": url, "active": active})])
        if not isinstance(tab, dict) or tab.get("id") is None:
            raise RuntimeError("Failed to create tab")
        self._known_tabs[tab["id"]] = tab
        s = await self._attach_tab(tab["id"])
        return _clean({"targetId": (s["targetInfo"] or {}).get("targetId")})

    async def close_target(self, target_id: str | None) -> dict[str, Any]:
        s = self._find(lambda s: (s["targetInfo"] or {}).get("targetId") == target_id) if target_id else None
        if not s:
            return {"success": False}
        await self._send_to_extension("chrome.tabs.remove", [s["tabId"]])
        return {"success": True}

    def get_target_info(self, session_id: str | None) -> Any:
        if not session_id:
            return None
        s = self._find(lambda s: s["sessionId"] == session_id)
        return s["targetInfo"] if s else None

    async def send_browser_command(self, method: str, params: Any) -> Any:
        """chrome.debugger.sendCommand needs a target, so a browser-level command goes through any attached tab."""
        s = next(iter(self._tab_sessions.values()), None)
        if not s:
            raise RuntimeError(f"No attached tab to forward browser-level command: {method}")
        return await self._send_to_extension("chrome.debugger.sendCommand", [{"tabId": s["tabId"]}, method, params])

    async def send_command(self, session_id: str, method: str, params: Any) -> Any:
        s = self._find(lambda s: s["sessionId"] == session_id)
        cdp_session = None
        if not s:
            s = self._find(lambda s: session_id in s["childSessions"])
            cdp_session = session_id
        if not s:
            raise RuntimeError(f"No tab found for sessionId: {session_id}")
        return await self._send_to_extension("chrome.debugger.sendCommand", [_clean({"tabId": s["tabId"], "sessionId": cdp_session}), method, params])

    async def _attach_tab(self, tab_id: int) -> dict[str, Any]:
        existing = self._tab_sessions.get(tab_id)
        if existing:
            return existing
        await self._send_to_extension("chrome.debugger.attach", [{"tabId": tab_id}, "1.3"])
        result = await self._send_to_extension("chrome.debugger.sendCommand", [{"tabId": tab_id}, "Target.getTargetInfo"])
        target_info = result.get("targetInfo") if isinstance(result, dict) else None
        session_id = f"pw-tab-{self._next_session_id}"
        self._next_session_id += 1
        s = {"tabId": tab_id, "sessionId": session_id, "targetInfo": target_info, "childSessions": set()}
        self._tab_sessions[tab_id] = s
        self._emit({"method": "Target.attachedToTarget", "params": {"sessionId": session_id, "targetInfo": {**(target_info or {}), "attached": True}, "waitingForDebugger": False}})
        return s

    def _detach_tab(self, tab_id: int) -> None:
        s = self._tab_sessions.pop(tab_id, None)
        if not s:
            return
        self._emit({"method": "Target.detachedFromTarget", "params": _clean({"sessionId": s["sessionId"], "targetId": (s["targetInfo"] or {}).get("targetId")})})

    def _find(self, pred: Callable[[dict[str, Any]], bool]) -> dict[str, Any] | None:
        return next((s for s in self._tab_sessions.values() if pred(s)), None)


def _clean(d: dict[str, Any]) -> dict[str, Any]:
    """JSON.stringify leaves out undefined properties."""
    return {k: v for k, v in d.items() if v is not None}


# ---- the extension protocol, version 2 (cdpRelayV2.ts)


class ExtensionProtocolV2:
    def __init__(self, send_command: Callable[[str, Any], Awaitable[Any]], background: bool = False):
        self._ready: asyncio.Future = asyncio.get_running_loop().create_future()
        self._ready.add_done_callback(lambda f: f.cancelled() or f.exception())
        self.model = BrowserModel(send_command)
        self._background = background

    def ready(self) -> asyncio.Future:
        return self._ready

    def connect_over_cdp(self, send: Callable[[dict[str, Any]], None]) -> None:
        self.model.connect_over_cdp(send)

    def on_extension_disconnect(self, reason: str) -> None:
        if not self._ready.done():
            self._ready.set_exception(RuntimeError(f"Extension disconnected before initialization: {reason}"))

    def handle_extension_event(self, method: str, params: Any) -> None:
        p = params if isinstance(params, list) else []
        if method == "chrome.debugger.onEvent":
            self.model.on_debugger_event(p[0] if p else None, p[1] if len(p) > 1 else "", p[2] if len(p) > 2 else None)
        elif method == "chrome.debugger.onDetach":
            self.model.on_debugger_detach(p[0] if p else None)
        elif method == "chrome.tabs.onCreated":
            self.model.on_tab_created(p[0] if p else None)
        elif method == "chrome.tabs.onRemoved":
            if p:
                self.model.on_tab_removed(p[0])
        elif method == "extension.initialized":
            if not self._ready.done():
                self._ready.set_result(None)

    async def handle_cdp_command(self, method: str, params: Any, session_id: str | None) -> tuple[bool, Any]:
        """(True, result) when handled here; (False, None) to forward to the extension."""
        p = params if isinstance(params, dict) else {}
        if method == "Target.setAutoAttach":
            if session_id:
                return False, None
            await self.model.enable_auto_attach()
            return True, {}
        if method == "Target.createTarget":
            return True, await self.model.create_target(p.get("url"), not self._background)
        if method in ("Page.bringToFront", "Target.activateTarget"):
            return (True, {}) if self._background else (False, None)
        if method == "Target.closeTarget":
            return True, await self.model.close_target(p.get("targetId"))
        if method == "Target.getTargetInfo":
            return True, self.model.get_target_info(session_id)
        return False, None

    async def forward_to_extension(self, method: str, params: Any, session_id: str | None) -> Any:
        if not session_id:
            return await self.model.send_browser_command(method, params)
        return await self.model.send_command(session_id, method, params)


# ---- the relay server (cdpRelay.ts)


class ExtensionConnection:
    def __init__(self, ws: web.WebSocketResponse):
        self._ws = ws
        self._callbacks: dict[int, asyncio.Future] = {}
        self._last_id = 0
        self.onmessage: Callable[[str, Any], None] | None = None
        self.onclose: Callable[[str], None] | None = None

    async def send(self, method: str, params: Any) -> Any:
        if self._ws.closed:
            raise RuntimeError("Unexpected WebSocket state: closed")
        self._last_id += 1
        id_ = self._last_id
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._callbacks[id_] = fut
        msg: dict[str, Any] = {"id": id_, "method": method}
        if params is not None:
            msg["params"] = params
        await self._ws.send_str(json.dumps(msg, ensure_ascii=False, separators=(",", ":")))
        return await fut

    async def close(self, message: str) -> None:
        if not self._ws.closed:
            await self._ws.close(code=1000, message=message.encode("utf-8")[:120])

    def handle_text(self, data: str) -> bool:
        """False: the connection should be closed (malformed message)."""
        try:
            obj = json.loads(data)
        except ValueError:
            log.debug("relay: closing the extension connection, malformed JSON")
            return False
        if not isinstance(obj, dict):
            return False
        id_ = obj.get("id")
        if id_ and id_ in self._callbacks:
            fut = self._callbacks.pop(id_)
            if fut.done():
                return True
            if obj.get("error"):
                fut.set_exception(RuntimeError(str(obj["error"])))
            else:
                fut.set_result(obj.get("result"))
        elif id_:
            log.debug("relay: unexpected response from the extension %s", obj)
        elif self.onmessage:
            try:
                self.onmessage(obj.get("method", ""), obj.get("params"))
            except Exception:  # noqa: BLE001
                return False
        return True

    def dispose(self) -> None:
        for fut in self._callbacks.values():
            if not fut.done():
                fut.set_exception(RuntimeError("WebSocket closed"))
        self._callbacks.clear()


class CDPRelayServer:
    def __init__(
        self,
        channel: str,
        executable_path: str | None = None,
        user_data_dir: str | None = None,
        profile_directory: str | None = None,
        background: bool = False,
        token: str | None = None,
    ):
        self._channel = channel
        self._executable_path = executable_path
        self._user_data_dir = user_data_dir
        self._profile_directory = profile_directory
        self._background = background
        self._token = token or None
        self._protocol_version = int(os.environ.get("PWTEST_EXTENSION_PROTOCOL", str(PROTOCOL_VERSION)))
        self._cdp: web.WebSocketResponse | None = None
        self._extension: ExtensionConnection | None = None
        self._extension_ready: asyncio.Future = asyncio.get_running_loop().create_future()
        self._extension_ready.add_done_callback(lambda f: f.cancelled() or f.exception())

        async def send_command(method: str, params: Any) -> Any:
            if not self._extension:
                raise RuntimeError("Extension not connected")
            return await self._extension.send(method, params)

        self._handler = ExtensionProtocolV2(send_command, background)
        u = uuid.uuid4()
        self._cdp_path = f"/cdp/{u}"
        self._extension_path = f"/extension/{u}"
        self._runner: web.AppRunner | None = None
        self._host = ""
        self._stopped = False
        self._tasks: set[asyncio.Task] = set()

    async def start(self) -> None:
        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", self._on_request)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        self._host = f"ws://127.0.0.1:{port}"

    def cdp_endpoint(self) -> str:
        return f"{self._host}{self._cdp_path}"

    def extension_endpoint(self) -> str:
        return f"{self._host}{self._extension_path}"

    def connect_page_url(self, client_name: str, tab_group: bool = True) -> str:
        q: list[tuple[str, str]] = [
            ("mcpRelayUrl", self.extension_endpoint()),
            ("client", json.dumps({"name": client_name}, ensure_ascii=False, separators=(",", ":"))),
            ("protocolVersion", str(self._protocol_version)),
        ]
        if not tab_group:
            q.append(("tabGroup", "false"))
        if self._background:
            q.append(("background", "true"))
        if self._token:
            q.append(("token", self._token))
        return f"chrome-extension://{EXTENSION_ID}/connect.html?{urlencode(q)}"

    async def establish_extension_connection(self, client_name: str, tab_group: bool = True, open_page: Callable[[str], Any] | None = None) -> None:
        """Opens the connect page (open_page replaces opening it in the browser, for tests) and waits for the
        extension: 30 s with a token, otherwise until you click allow."""
        href = self.connect_page_url(client_name, tab_group)
        if open_page:
            r = open_page(href)
            if asyncio.iscoroutine(r):
                await r
        else:
            self._open_connect_page_in_browser(href)

        async def both() -> None:
            await self._extension_ready
            await self._handler.ready()

        if not self._token:
            await both()
            return
        try:
            await asyncio.wait_for(both(), CONNECT_TIMEOUT)
        except asyncio.TimeoutError:
            profile = f' "{self._profile_directory}"' if self._profile_directory else ""
            raise RuntimeError(
                f"Playwright extension did not connect within {CONNECT_TIMEOUT:g}s after opening the connect page. Make sure the extension is installed in the Chrome profile{profile} and PLAYWRIGHT_MCP_EXTENSION_TOKEN matches its token."
            ) from None

    def _open_connect_page_in_browser(self, href: str) -> None:
        exe = self._executable_path
        if not exe:
            exe = find_executable(self._channel)
            if not exe:
                raise RuntimeError(f'"{self._channel}" executable not found. Make sure it is installed at a standard location.')
        args = [exe]
        if self._user_data_dir:
            args.append(f"--user-data-dir={self._user_data_dir}")
        if self._profile_directory:
            args.append(f"--profile-directory={self._profile_directory}")
        if self._background and self._token:
            args.append("--open-in-background")
        args.append(href)
        # Detached, like Node's spawn({ detached: true }): stopping this server never takes the browser with it.
        kw: dict[str, Any] = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "close_fds": True}
        if sys.platform == "win32":
            kw["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        else:
            kw["start_new_session"] = True
        subprocess.Popen(args, **kw)  # noqa: S603

    def stop(self) -> None:
        """Closes both connections and the server (idempotent; the closing runs in the background)."""
        if self._stopped:
            return
        self._stopped = True
        if not self._extension_ready.done():
            self._extension_ready.set_exception(RuntimeError("Server stopped"))

        async def go() -> None:
            await self._close_cdp("Server stopped")
            await self._close_extension("Server stopped")
            if self._runner:
                await self._runner.cleanup()

        self._spawn(go())

    def _spawn(self, aw: Awaitable[Any]) -> None:
        t = asyncio.ensure_future(aw)
        self._tasks.add(t)

        def done(f: asyncio.Future) -> None:
            self._tasks.discard(f)
            if not f.cancelled() and f.exception():
                log.debug("relay: %s", f.exception())

        t.add_done_callback(done)

    async def _close_cdp(self, reason: str) -> None:
        if self._cdp is not None and not self._cdp.closed:
            await self._cdp.close(code=1000, message=reason.encode("utf-8")[:120])

    async def _close_extension(self, reason: str) -> None:
        if self._extension:
            await self._extension.close(reason)
        if not self._extension_ready.done():
            self._extension_ready.set_exception(RuntimeError(reason))

    def _allowed(self, request: web.Request) -> bool:
        host = request.headers.get("Host", "").lower()
        hostname = host[: host.index("]") + 1] if host.startswith("[") else host.split(":")[0]
        if hostname not in LOOPBACK:
            return False
        origin = request.headers.get("Origin")
        if not origin:
            return True
        try:
            u = urlsplit(origin)
        except ValueError:
            return False
        if u.scheme not in ("http", "https"):
            return True  # chrome-extension://…
        h = (u.hostname or "").lower()
        return h in LOOPBACK or f"[{h}]" in LOOPBACK

    async def _on_request(self, request: web.Request) -> web.StreamResponse:
        if request.headers.get("Upgrade", "").lower() != "websocket":
            return web.Response(status=404)
        if request.path not in (self._cdp_path, self._extension_path):
            return web.Response(status=400, text="Bad Request")
        if not self._allowed(request):
            return web.Response(status=403, text="Forbidden")
        ws = web.WebSocketResponse(max_msg_size=0, autoping=True)
        await ws.prepare(request)
        if request.path == self._cdp_path:
            await self._handle_playwright(ws)
        else:
            await self._handle_extension(ws)
        return ws

    async def _handle_playwright(self, ws: web.WebSocketResponse) -> None:
        if not self._extension:
            await ws.close(code=1000, message=b"Extension not connected")
            return
        if self._cdp is not None:
            await ws.close(code=1000, message=b"Another CDP client already connected")
            return
        self._cdp = ws
        self._handler.connect_over_cdp(self._send_to_cdp_client)
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    try:
                        m = json.loads(msg.data)
                    except ValueError:
                        continue
                    self._spawn(self._handle_playwright_message(m))
                elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                    break
        finally:
            await self._close_extension("Playwright client disconnected")

    async def _handle_extension(self, ws: web.WebSocketResponse) -> None:
        if self._extension:
            await ws.close(code=1000, message=b"Another extension connection already established")
            return
        conn = ExtensionConnection(ws)
        self._extension = conn
        conn.onmessage = self._handler.handle_extension_event
        if not self._extension_ready.done():
            self._extension_ready.set_result(None)
        reason = ""
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    if not conn.handle_text(msg.data):
                        await ws.close()
                        break
                elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                    break
            reason = f"code {ws.close_code}" if ws.close_code else ""
        finally:
            conn.dispose()
            self._handler.on_extension_disconnect(reason)
            await self._close_cdp(f"Extension disconnected: {reason}")

    async def _handle_playwright_message(self, message: dict[str, Any]) -> None:
        id_ = message.get("id")
        session_id = message.get("sessionId")
        method = message.get("method", "")
        params = message.get("params")
        try:
            result = await self._handle_cdp_command(method, params, session_id)
            self._send_to_cdp_client(_clean({"id": id_, "sessionId": session_id, "result": result}))
        except Exception as e:  # noqa: BLE001
            self._send_to_cdp_client(_clean({"id": id_, "sessionId": session_id, "error": {"message": str(e)}}))

    async def _handle_cdp_command(self, method: str, params: Any, session_id: str | None) -> Any:
        if method == "Browser.getVersion":
            return {"protocolVersion": "1.3", "product": "Chrome/Extension-Bridge", "userAgent": "CDP-Bridge-Server/1.0.0"}
        if method == "Browser.setDownloadBehavior":
            return {}
        handled, result = await self._handler.handle_cdp_command(method, params, session_id)
        if handled:
            return result
        return await self._handler.forward_to_extension(method, params, session_id)

    def _send_to_cdp_client(self, message: dict[str, Any]) -> None:
        ws = self._cdp
        if ws is not None and not ws.closed:
            self._spawn(ws.send_str(json.dumps(message, ensure_ascii=False, separators=(",", ":"))))


# ---- extensionContextFactory.ts


async def create_extension_browser(
    pw: Any,
    channel: str,
    token: str | None,
    client_name: str,
    tab_group: bool = True,
    background: bool = False,
) -> tuple[Any, CDPRelayServer]:
    """Finds the profile with the extension, opens its connect page in your browser, waits for the
    extension and connects Playwright to the relay. Returns (browser, relay)."""
    executable_path = os.environ.get("PLAYWRIGHT_MCP_EXECUTABLE_PATH") or None
    custom_udd = os.environ.get("PWTEST_EXTENSION_USER_DATA_DIR") or None
    profile_dir_name = os.environ.get("PLAYWRIGHT_MCP_PROFILE_DIR_NAME") or None
    udd = Path(custom_udd) if custom_udd else (None if executable_path else default_user_data_dir(channel))
    profile = profile_dir_name or (find_extension_profile(udd) if udd else None)
    if udd and not executable_path and (not profile or not is_extension_installed_in_profile(udd / profile)):
        where = udd / profile if profile else udd
        raise RuntimeError(
            f'Playwright Extension not found in "{where}". Install it from {INSTALL_URL}, or set the PLAYWRIGHT_MCP_EXECUTABLE_PATH environment variable to use a browser at a custom location.'
        )
    relay = CDPRelayServer(channel, executable_path, custom_udd, profile, background, token)
    await relay.start()
    try:
        await relay.establish_extension_connection(client_name, tab_group)
        browser = await pw.chromium.connect_over_cdp(relay.cdp_endpoint(), is_local=True, timeout=0, no_defaults=True)
        browser.on("disconnected", lambda _=None: relay.stop())
        return browser, relay
    except BaseException:
        relay.stop()
        raise

