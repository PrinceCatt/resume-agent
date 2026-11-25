// Two browsers:
// - Your own, everyday Edge (or Chrome) with all your sign-ins. Application forms are filled in
//   tabs the assistant opens there, so you can watch and take over. A browser started from its
//   normal profile refuses remote debugging (Chromium 136+), so the connection goes through
//   Microsoft's Playwright extension installed in that browser (Chrome Web Store, listed as
//   "Playwright MCP Bridge" and in some languages "Playwright Extension"); Playwright's extension mode
//   starts a local relay, opens the extension's connect page in your running browser, and the
//   extension forwards the tabs it is allowed to control. No separate window, no separate profile.
// - A headless one, never visible, for rendering PDFs and reading public job pages.
import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { getSettings } from "./settings.ts";
import { emit } from "./events.ts";

const require = createRequire(import.meta.url);

export const EXTENSION_URL = "https://chromewebstore.google.com/detail/mmlmfjhmonkocbjadbfplnigmagldckm";

/** off: not connected. waiting: the connect page is open in your browser, waiting for the extension (and, without a token, for you to allow it). */
export type BrowserState = { status: "off" | "waiting" | "on"; error: string; tokenSet: boolean };

type Conn = { browser: Browser; ctx: BrowserContext };
let conn: Conn | null = null;
let connecting: Promise<Conn> | null = null;
// Bumped when an attempt is abandoned, so a connection that only arrives later is dropped
// instead of silently becoming the live one.
let attempt = 0;
let lastError = "";
let headlessPromise: Promise<Browser> | null = null;
const closeListeners = new Set<() => void>();
const mine = new WeakSet<Page>();

export function onBrowserClosed(fn: () => void) {
  closeListeners.add(fn);
  return () => closeListeners.delete(fn);
}

export function browserState(): BrowserState {
  return { status: conn ? "on" : connecting ? "waiting" : "off", error: lastError, tokenSet: getSettings().extensionToken.length > 0 };
}

export function browserOpen() {
  return conn !== null;
}

function friendly(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  const which = getSettings().browserChannel === "chrome" ? "Chrome" : "Edge";
  if (/Playwright Extension not found/i.test(msg))
    return `你的 ${which} 里还没装 Playwright Extension（在 Chrome 应用商店里，商店页面上有时叫 Playwright MCP Bridge；Edge 自己的扩展商店里没有）：在 ${which} 里打开设置页给的链接安装（Edge 会问是否允许来自其他商店的扩展，选允许），装好后再点「连接」。`;
  if (/did not connect within/i.test(msg))
    return `${which} 里的 Playwright 扩展 30 秒内没连上：设置里填的令牌要和扩展状态页（点工具栏里它的图标）上显示的一样；不确定就清空令牌，改成每次在 ${which} 里点允许。`;
  if (/executable not found|Unsupported channel/i.test(msg)) return `这台电脑上找不到 ${which}。`;
  return `连不上你的 ${which}：${msg.split("\n")[0]}`;
}

function startConnect(): Promise<Conn> {
  const s = getSettings();
  // Read by Playwright's relay when it is created. With the extension's token the extension
  // connects by itself (or fails within 30 s); without it, the connect page waits for you to allow it.
  if (s.extensionToken) process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = s.extensionToken;
  else delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  const my = ++attempt;
  lastError = "";
  const { tools } = require("playwright-core/lib/coreBundle");
  const p: Promise<Conn> = tools
    .createBrowserWithInfo(
      { browser: { browserName: "chromium", launchOptions: {}, contextOptions: {} }, extension: true, tabGroup: true, background: false },
      { clientName: "投递助手" },
      { browser: s.browserChannel },
      { title: "resume-agent" },
    )
    .then(async (info: { browser: Browser }) => {
      const browser = info.browser;
      // Extension mode also starts a sharing server for Playwright's own CLI; nothing here uses it.
      await (browser as any).unbind?.().catch(() => {});
      if (my !== attempt) {
        // Disconnects only: a browser reached over CDP is not closed by close().
        await browser.close().catch(() => {});
        throw new Error("superseded");
      }
      const ctx = browser.contexts()[0];
      if (!ctx) throw new Error("扩展连上了，但没有可用的标签页");
      browser.on("disconnected", () => {
        if (conn?.browser !== browser) return;
        conn = null;
        for (const fn of closeListeners) fn();
        emit("browser");
      });
      conn = { browser, ctx };
      connecting = null;
      emit("browser");
      return conn;
    })
    .catch((e: unknown) => {
      if (my === attempt) {
        connecting = null;
        lastError = friendly(e);
        emit("browser");
      }
      throw new Error(my === attempt ? lastError : "已经换成新的连接");
    });
  p.catch(() => {});
  connecting = p;
  emit("browser");
  return p;
}

/** Connects to your browser, or waits for the attempt already under way; gives up waiting after `waitMs` but leaves the attempt running. */
export async function getContext(waitMs = 180_000): Promise<BrowserContext> {
  if (conn) return conn.ctx;
  const p = connecting ?? startConnect();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const which = getSettings().browserChannel === "chrome" ? "Chrome" : "Edge";
      reject(new Error(`还没连上你的 ${which}：在 ${which} 里打开的 Playwright 连接页上点允许（或在设置里填扩展的令牌），然后再试。`));
    }, waitMs);
  });
  try {
    return (await Promise.race([p, timeout])).ctx;
  } finally {
    clearTimeout(timer);
  }
}

/** Starts a fresh connection attempt, abandoning one that is stuck (e.g. its connect page was closed). */
export async function reconnect(waitMs?: number) {
  if (!conn) {
    attempt++;
    connecting = null;
  }
  return getContext(waitMs);
}

/** Opens a new tab in your browser (in the assistant's tab group). */
export async function newVisiblePage(url?: string): Promise<Page> {
  const ctx = await getContext();
  const page = await ctx.newPage();
  mine.add(page);
  if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  return page;
}

/** True for tabs the assistant opened itself, as opposed to your own tabs. */
export function isOwnTab(page: Page) {
  return mine.has(page);
}

export async function getHeadless(): Promise<Browser> {
  if (!headlessPromise) {
    headlessPromise = chromium.launch({ channel: getSettings().browserChannel, headless: true }).then((b) => {
      b.on("disconnected", () => (headlessPromise = null));
      return b;
    });
    headlessPromise.catch(() => (headlessPromise = null));
  }
  return headlessPromise;
}

/** Disconnects from your browser (its window and tabs stay as they are) and closes the headless one. */
export async function closeAll() {
  const c = conn;
  const hl = headlessPromise;
  attempt++;
  conn = null;
  connecting = null;
  headlessPromise = null;
  if (c) {
    for (const fn of closeListeners) fn();
    emit("browser");
  }
  await Promise.allSettled([c?.browser.close(), hl?.then((b) => b.close())]);
}
