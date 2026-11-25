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
    return `The Playwright Extension is not installed in your ${which} yet (it is in the Chrome Web Store, where the page sometimes calls it Playwright MCP Bridge; Edge's own add-on store does not have it). Open the link on the Settings page in ${which} to install it (Edge asks whether to allow extensions from other stores: choose Allow), then click "Connect" again.`;
  if (/did not connect within/i.test(msg))
    return `The Playwright extension in ${which} did not connect within 30 seconds. The token in Settings must match the one on the extension's status page (click its icon in the toolbar); if unsure, clear the token and click Allow in ${which} each time instead.`;
  if (/executable not found|Unsupported channel/i.test(msg)) return `${which} was not found on this computer.`;
  return `Could not connect to your ${which}: ${msg.split("\n")[0]}`;
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
      { clientName: "Resume Agent" },
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
      if (!ctx) throw new Error("The extension connected, but there is no tab to use");
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
      throw new Error(my === attempt ? lastError : "Replaced by a newer connection");
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
      reject(new Error(`Not connected to your ${which} yet: click Allow on the Playwright connection page that opened in ${which} (or enter the extension token in Settings), then try again.`));
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
