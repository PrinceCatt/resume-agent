"""The extension relay (resume_agent/relay.py) without anyone's real browser: a stand-in for the Playwright
extension answers the relay's chrome.tabs / chrome.debugger calls by driving a fresh headless Edge over CDP,
and Playwright connects to the relay exactly as it would with the real extension."""

from __future__ import annotations

import asyncio
import itertools
import json
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import aiohttp
import pytest

from resume_agent import relay
from resume_agent.relay import EXTENSION_ID, CDPRelayServer, find_extension_profile

ROOT = Path(__file__).resolve().parents[2]


def test_the_profile_with_the_extension_is_found(tmp_path):
    udd = tmp_path / "User Data"
    for p in ("Default", "Profile 1", "Profile 2", "Profile 10", "System Profile"):
        (udd / p).mkdir(parents=True)
    assert find_extension_profile(udd) is None
    (udd / "Profile 10" / "Extensions" / EXTENSION_ID).mkdir(parents=True)
    assert find_extension_profile(udd) == "Profile 10"
    (udd / "Profile 1" / "Secure Preferences").write_text(json.dumps({"extensions": {"settings": {EXTENSION_ID: {"state": 1}}}}), "utf-8")
    assert find_extension_profile(udd) == "Profile 1", "Default first, then Profile N in number order"
    (udd / "Local State").write_text(json.dumps({"profile": {"last_used": "Profile 10"}}), "utf-8")
    assert find_extension_profile(udd) == "Profile 10", "the last used profile is tried first"
    (udd / "Default" / "Preferences").write_text(json.dumps({"extensions": {"settings": {EXTENSION_ID: {}}}}), "utf-8")
    assert relay.is_extension_installed_in_profile(udd / "Default") is False, "an empty settings record does not count"


class FakeExtension:
    """What the Playwright extension does, on top of a raw CDP connection to a headless browser."""

    def __init__(self, relay_url: str, cdp_url: str):
        self.relay_url = relay_url
        self.cdp_url = cdp_url
        self.ids = itertools.count(1)
        self.tab_ids = itertools.count(100)
        self.pending: dict[int, asyncio.Future] = {}
        self.tabs: dict[int, str] = {}  # tabId -> targetId
        self.session_of: dict[int, str] = {}  # tabId -> CDP session of the tab
        self.tab_of: dict[str, int] = {}  # CDP session (tab or child) -> tabId
        self.calls: list[str] = []
        self.tasks: list[asyncio.Task] = []

    async def start(self) -> None:
        self.http = aiohttp.ClientSession()
        self.cdp = await self.http.ws_connect(self.cdp_url, max_msg_size=0)
        self.ext = await self.http.ws_connect(self.relay_url, max_msg_size=0, origin=f"chrome-extension://{EXTENSION_ID}")
        self.tasks += [asyncio.ensure_future(self._read_cdp()), asyncio.ensure_future(self._read_ext())]
        await self.ext.send_json({"method": "extension.initialized", "params": {}})

    async def stop(self) -> None:
        for t in self.tasks:
            t.cancel()
        await self.ext.close()
        await self.cdp.close()
        await self.http.close()

    async def call(self, method: str, params: Any = None, session: str | None = None) -> Any:
        id_ = next(self.ids)
        fut = asyncio.get_running_loop().create_future()
        self.pending[id_] = fut
        msg = {"id": id_, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        await self.cdp.send_json(msg)
        return await fut

    async def _read_cdp(self) -> None:
        async for m in self.cdp:
            msg = json.loads(m.data)
            if "id" in msg:
                fut = self.pending.pop(msg["id"], None)
                if fut and not fut.done():
                    if "error" in msg:
                        fut.set_exception(RuntimeError(msg["error"].get("message", "CDP error")))
                    else:
                        fut.set_result(msg.get("result"))
                continue
            sid = msg.get("sessionId")
            if sid is None or sid not in self.tab_of:
                continue
            tab = self.tab_of[sid]
            params = msg.get("params", {})
            if msg["method"] == "Target.attachedToTarget":
                self.tab_of[params["sessionId"]] = tab
            source = {"tabId": tab} if self.session_of.get(tab) == sid else {"tabId": tab, "sessionId": sid}
            await self.ext.send_json({"method": "chrome.debugger.onEvent", "params": [source, msg["method"], params]})

    async def _read_ext(self) -> None:
        async for m in self.ext:
            req = json.loads(m.data)
            self.calls.append(req["method"])
            asyncio.ensure_future(self._answer(req))

    async def _answer(self, req: dict[str, Any]) -> None:
        method, params = req["method"], req.get("params") or []
        try:
            if method == "chrome.tabs.create":
                url = (params[0] or {}).get("url") or "about:blank"
                r = await self.call("Target.createTarget", {"url": url})
                tab = next(self.tab_ids)
                self.tabs[tab] = r["targetId"]
                result: Any = {"id": tab, "url": url, "active": True}
            elif method == "chrome.debugger.attach":
                tab = params[0]["tabId"]
                r = await self.call("Target.attachToTarget", {"targetId": self.tabs[tab], "flatten": True})
                self.session_of[tab] = r["sessionId"]
                self.tab_of[r["sessionId"]] = tab
                result = None
            elif method == "chrome.debugger.sendCommand":
                source, cmd = params[0], params[1]
                cmd_params = params[2] if len(params) > 2 and params[2] is not None else {}
                result = await self.call(cmd, cmd_params, source.get("sessionId") or self.session_of[source["tabId"]])
            elif method == "chrome.tabs.remove":
                await self.call("Target.closeTarget", {"targetId": self.tabs.pop(params[0])})
                await self.ext.send_json({"method": "chrome.tabs.onRemoved", "params": [params[0]]})
                result = None
            else:
                raise RuntimeError(f"unknown method {method}")
            await self.ext.send_json({"id": req["id"], "result": result})
        except Exception as e:  # noqa: BLE001
            if not self.ext.closed:
                await self.ext.send_json({"id": req["id"], "error": str(e)})


@pytest.mark.skipif(relay.find_executable("msedge") is None, reason="Microsoft Edge is not installed")
def test_playwright_drives_a_tab_through_the_relay(tmp_path):
    from playwright.async_api import async_playwright

    from resume_agent.observe import observe

    async def go() -> None:
        async with async_playwright() as pw:
            # A fresh, throwaway headless profile: never anyone's own browser.
            backing = await pw.chromium.launch_persistent_context(str(tmp_path / "profile"), channel="msedge", headless=True, args=["--remote-debugging-port=0"])
            port_file = tmp_path / "profile" / "DevToolsActivePort"
            for _ in range(100):
                if port_file.exists() and len(port_file.read_text().split()) >= 2:
                    break
                await asyncio.sleep(0.1)
            port, path = port_file.read_text().split()[:2]
            fake: FakeExtension | None = None
            r = CDPRelayServer("msedge", token="test-token")
            await r.start()
            try:
                # Refused: a page from another site, and a path that is not the relay's.
                async with aiohttp.ClientSession() as http:
                    with pytest.raises(aiohttp.WSServerHandshakeError) as e:
                        await http.ws_connect(r.extension_endpoint(), origin="https://evil.example")
                    assert e.value.status == 403
                    with pytest.raises(aiohttp.WSServerHandshakeError) as e:
                        await http.ws_connect(r.extension_endpoint().rsplit("/", 1)[0] + "/other")
                    assert e.value.status == 400

                opened: list[str] = []

                async def open_page(href: str) -> None:
                    nonlocal fake
                    opened.append(href)
                    q = parse_qs(urlsplit(href).query)
                    fake = FakeExtension(q["mcpRelayUrl"][0], f"ws://127.0.0.1:{port}{path}")
                    await fake.start()

                await r.establish_extension_connection("投递助手", open_page=open_page)
                href = opened[0]
                assert href.startswith(f"chrome-extension://{EXTENSION_ID}/connect.html?")
                q = parse_qs(urlsplit(href).query)
                assert q["token"] == ["test-token"] and q["protocolVersion"] == ["2"] and json.loads(q["client"][0]) == {"name": "投递助手"}

                b = await pw.chromium.connect_over_cdp(r.cdp_endpoint(), is_local=True, timeout=0, no_defaults=True)
                assert b.contexts, "the extension's browser has a default context"
                page = await b.contexts[0].new_page()
                await page.goto((ROOT / "fixtures" / "test-job.html").as_uri())
                await page.get_by_role("button", name="Apply for this job").click()
                await page.fill("#fn", "Alex")
                assert await page.input_value("#fn") == "Alex"
                obs = await observe(page)
                assert any(e["label"].startswith("First Name") and e["value"] == "Alex" for e in obs["elements"]), "the agent's snapshot works over the relay"
                await page.close()
                assert fake and "chrome.tabs.create" in fake.calls and "chrome.debugger.attach" in fake.calls and "chrome.tabs.remove" in fake.calls
                await b.close()
            finally:
                r.stop()
                if fake:
                    await fake.stop()
                await backing.close()

    asyncio.run(asyncio.wait_for(go(), 120))
