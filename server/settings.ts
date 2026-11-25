import { all, run } from "./db.ts";

export type Settings = {
  /** "deepseek" calls the API; "demo" runs a rule-based stand-in so the flow can be tried without a key. */
  llmMode: "deepseek" | "demo";
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Which of your own browsers forms are filled in (through the Playwright Extension installed there). */
  browserChannel: "msedge" | "chrome";
  /** The Playwright Extension's token: lets it connect without you clicking allow each time. Kept on the server like the API key. */
  extensionToken: string;
  /** How many application forms are filled at the same time. */
  concurrency: number;
  maxSteps: number;
  coverLetter: boolean;
  /** "auto" follows the job posting's language. */
  resumeLanguage: "auto" | "en" | "zh";
  /** The automatic pipeline stops after reading a job whose fit score is below this (0 = never). */
  minFit: number;
  /** Batch tailoring and form filling wait for DeepSeek's off-peak hours (half price). Reading postings never waits. */
  offPeakOnly: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  llmMode: "deepseek",
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  browserChannel: "msedge",
  extensionToken: "",
  concurrency: 2,
  maxSteps: 40,
  coverLetter: true,
  resumeLanguage: "auto",
  minFit: 0,
  offPeakOnly: false,
};

export function getSettings(): Settings {
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of all<{ key: string; value: string }>("SELECT key, value FROM settings")) {
    if (!(r.key in DEFAULT_SETTINGS)) continue;
    try {
      s[r.key] = JSON.parse(r.value);
    } catch {
      /* ignore a bad row */
    }
  }
  return s as Settings;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const cur = getSettings();
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS) || v === undefined) continue;
    const def = (DEFAULT_SETTINGS as Record<string, unknown>)[k];
    if (typeof v !== typeof def) continue;
    run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, JSON.stringify(v));
  }
  return { ...cur, ...getSettings() };
}

/** What the browser UI gets: the API key and the extension token never leave the server. */
export function publicSettings() {
  const { apiKey, extensionToken, ...rest } = getSettings();
  return { ...rest, hasKey: apiKey.length > 0, keyHint: apiKey ? `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}` : "", hasExtensionToken: extensionToken.length > 0 };
}
