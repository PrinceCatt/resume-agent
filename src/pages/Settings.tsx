import { useEffect, useState } from "react";
import { api, pref, rmb, tokens, useApi, type AppState, type Balance, type PublicSettings, type Usage, type UsageSum } from "../api.ts";
import { Button, Card, Field, Icon, inputCls, toast, useAction } from "../components/ui.tsx";

const KIND: Record<string, string> = { parse: "Reading jobs", tailor: "Tailoring", apply: "Filling forms", prep: "Interview prep", email: "Emails", import: "Resume import", test: "Connection tests" };

function NotifyCard() {
  const supported = typeof Notification !== "undefined";
  const [on, setOn] = useState(() => pref.get("notify") === "1");
  const [perm, setPerm] = useState(() => (supported ? Notification.permission : "denied"));
  const toggle = async (want: boolean) => {
    if (want && supported && Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      setPerm(p);
      if (p !== "granted") {
        toast("The browser did not allow notifications; you can turn them on in the site settings left of the address bar", "err");
        return;
      }
    }
    pref.set("notify", want ? "1" : "0");
    setOn(want);
    if (want) new Notification("Resume Agent", { body: "Notifications are on: this is how you hear about an application waiting for you to confirm or answer." });
  };
  return (
    <Card className="space-y-3 p-5">
      <h2 className="flex items-center gap-2 font-medium">
        <Icon name="bell" className="size-4 text-stone-400" />
        Notifications
      </h2>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 accent-brand-600" disabled={!supported} checked={on && perm === "granted"} onChange={(e) => void toggle(e.target.checked)} />
        <span>
          Show a system notification when an application is filled in and waiting for you to confirm, or has a question for you; also an hour before an interview or test, and a day before an application deadline
          <span className="block text-xs text-muted">
            {!supported ? "This browser does not support notifications." : perm === "denied" ? "The browser blocks notifications from this page; allow them in the site settings first." : "Applications waiting for you only notify when this page is not in front; the tab title shows how many as well. Reminders need this page to stay open."}
          </span>
        </span>
      </label>
    </Card>
  );
}

/** DeepSeek's balance, read from its free balance endpoint (nothing shows for other providers or demo mode). */
function BalanceLine() {
  const { data } = useApi<{ balance: Balance | null }>("/balance", ["settings"]);
  const b = data?.balance;
  if (!b) return null;
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${b.available ? "text-muted" : "text-red-700"}`}>
      <span>
        Account balance: <span className="font-medium tabular-nums">{b.currency === "USD" ? "$" : "¥"}{b.total.toFixed(2)}</span>
        {!b.available && ". Not enough: reading, tailoring and form filling are paused"}
      </span>
      <a className="text-brand-700 hover:underline" href="https://platform.deepseek.com/" target="_blank" rel="noreferrer">
        Top up on DeepSeek
      </a>
    </div>
  );
}

function UsageCard() {
  const { data } = useApi<Usage>("/usage", ["job", "run"]);
  if (!data) return null;
  const cell = (label: string, u: UsageSum) => (
    <div className="rounded-md bg-paper px-3 py-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">
        ~{rmb(u.rmb)} <span className="text-sm font-normal text-muted">· {tokens(u.input + u.output)} tokens</span>
      </div>
      <div className="text-xs text-muted tabular-nums">
        {u.calls} {u.calls === 1 ? "call" : "calls"} · input {tokens(u.input)}
        {u.cached > 0 && ` (${tokens(u.cached)} cached)`} · output {tokens(u.output)}
      </div>
    </div>
  );
  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium">Model usage</h2>
        <a className="text-xs text-brand-700 hover:underline" href="https://platform.deepseek.com/usage" target="_blank" rel="noreferrer">
          Spending on DeepSeek
        </a>
      </div>
      {data.total.calls === 0 ? (
        <p className="text-sm text-muted">No model calls yet (demo mode does not count).</p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-3">
            {cell("Today", data.today)}
            {cell("This month", data.month)}
            {cell("All time", data.total)}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {data.byKind.map((k) => (
              <span key={k.kind}>
                {KIND[k.kind] ?? k.kind}: ~{rmb(k.rmb)} · {tokens(k.tokens)} ({k.calls} {k.calls === 1 ? "call" : "calls"})
              </span>
            ))}
          </div>
          <p className="text-xs text-stone-400">Costs are estimated from DeepSeek's November 2026 prices and the time of each call (peak / off-peak); DeepSeek's own bill is what counts.</p>
        </>
      )}
    </Card>
  );
}

type SaveFn = (patch: Partial<PublicSettings> & { apiKey?: string; extensionToken?: string }, ok?: string) => Promise<unknown>;

function BrowserCard({ data, s, save, busy, run, token, setToken }: {
  data: AppState;
  s: PublicSettings;
  save: SaveFn;
  busy: string | null;
  run: (name: string, fn: () => Promise<unknown>, ok?: string) => Promise<unknown>;
  token: string;
  setToken: (v: string) => void;
}) {
  const b = data.browser;
  const which = s.browserChannel === "chrome" ? "Chrome" : "Edge";
  const status =
    b.status === "on"
      ? { dot: "bg-brand-500", text: `Connected to your ${which}` }
      : b.status === "waiting"
        ? { dot: "bg-amber-400", text: b.tokenSet ? `Connecting to your ${which}…` : `Waiting for you to click Allow in ${which}: it opened a Playwright connection page` }
        : { dot: "bg-stone-300", text: `Not connected to ${which}` };
  return (
    <Card className="space-y-4 p-5">
      <h2 className="font-medium">Browser</h2>
      <p className="text-sm text-muted">
        The agent fills in forms in new tabs of the {which} you normally use (kept in one tab group), with the accounts you are already signed in to; it opens no separate window. It connects through the Playwright Extension (made by Microsoft) installed in {which}. At steps like verification codes, bot checks, Singpass or creating an account, it stops and calls you.
      </p>
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2.5">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <span className={`size-2 shrink-0 rounded-full ${status.dot}`} />
          {status.text}
        </span>
        <Button
          size="sm"
          variant={b.status === "on" ? undefined : "primary"}
          busy={busy === "connect"}
          onClick={() => void run("connect", () => api("/browser/open", { body: {} }))}
        >
          {b.status === "on" ? "Reconnect" : b.status === "waiting" ? "Reopen connection page" : "Connect"}
        </Button>
      </div>
      {b.error && b.status !== "on" && <p className="text-sm text-red-700">{b.error}</p>}
      {b.status !== "on" && (
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>
            In {which}, open{" "}
            <a className="text-brand-700 underline" href={b.extensionUrl} target="_blank" rel="noreferrer">
              Playwright Extension
            </a>{" "}
            and install it: it is in the Chrome Web Store (the store page sometimes calls it Playwright MCP Bridge); Edge's own add-on store does not list it. At the top of the page Edge asks whether to allow extensions from other stores: choose Allow, then click "Get". You only install it once.
          </li>
          <li>Click "Connect" above: {which} opens the extension's connection page; click Allow there.</li>
          <li>Optional: click the Playwright Extension icon in the toolbar (under the puzzle-piece icon). Its status page shows a token; copy it into the field below and you no longer need to click Allow each time.</li>
        </ol>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Browser" hint="The one you normally use, signed in to the job sites">
          <select className={inputCls} value={s.browserChannel} onChange={(e) => save({ browserChannel: e.target.value as PublicSettings["browserChannel"] })}>
            <option value="msedge">Microsoft Edge</option>
            <option value="chrome">Google Chrome</option>
          </select>
        </Field>
        <Field label="Extension token (optional)" hint={s.hasExtensionToken ? "Saved; no need to click Allow when connecting" : "Click the Playwright Extension icon in the toolbar to open its status page; click copy and paste the whole line here"}>
          <div className="flex gap-2">
            <input
              className={inputCls}
              type="password"
              autoComplete="off"
              placeholder={s.hasExtensionToken ? "Saved (a new one replaces it)" : "Paste the token"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            {token.trim() ? (
              <Button busy={busy === "save"} onClick={() => save({ extensionToken: token.trim() }, "Token saved").then(() => setToken(""))}>
                Save
              </Button>
            ) : (
              s.hasExtensionToken && (
                <Button busy={busy === "save"} onClick={() => save({ extensionToken: "" }, "Token cleared")}>
                  Clear
                </Button>
              )
            )}
          </div>
        </Field>
      </div>
      {data.sites.length > 0 && (
        <div className="border-t border-line pt-4">
          <div className="text-sm font-medium">Job sites common in Singapore</div>
          <p className="mt-0.5 text-xs text-muted">
            Being signed in to them in your {which} is enough: the agent uses the same sessions. Verification codes, bot checks and Singpass are always left to you; the agent never tries to get around them.
          </p>
          <ul className="mt-3 divide-y divide-line rounded-md border border-line">
            {data.sites.map((site) => (
              <li key={site.key} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{site.name}</div>
                  <div className="text-xs text-muted">{site.note}</div>
                </div>
                <a className="text-sm text-brand-700 hover:underline" href={site.login} target="_blank" rel="noreferrer">
                  Open sign-in page
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-stone-400">
            The terms of sites like LinkedIn and JobStreet usually forbid automation tools, and heavy use can get an account restricted; these are your own accounts. Nothing is submitted until you confirm it. Keep the volume low; "Applications at a time" set to 1 is the safest.
          </p>
        </div>
      )}
    </Card>
  );
}

export default function SettingsPage() {
  const { data, reload } = useApi<AppState>("/state", ["settings", "browser"]);
  const [s, setS] = useState<PublicSettings | null>(null);
  const [key, setKey] = useState("");
  const [token, setToken] = useState("");
  const { busy, run } = useAction();
  useEffect(() => {
    if (data) setS(data.settings);
  }, [data]);
  if (!s || !data) return null;

  const save = (patch: Partial<PublicSettings> & { apiKey?: string; extensionToken?: string }, ok = "Saved") =>
    run("save", async () => {
      await api("/settings", { method: "PUT", body: patch });
      await reload();
    }, ok);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted">All data (profile, jobs, screenshots, API key) is stored only in the resume-agent/data folder on this computer. Your sign-ins to websites stay in your own browser; the agent does not keep them.</p>
      </header>

      <Card className="space-y-4 p-5">
        <h2 className="font-medium">Model</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ["deepseek", "DeepSeek", "Really reads postings, tailors resumes and understands all kinds of forms"],
              ["demo", "Demo mode", "No model calls; fills only simple forms, for getting to know the flow"],
            ] as const
          ).map(([v, label, desc]) => (
            <button
              key={v}
              onClick={() => save({ llmMode: v }, v === "demo" ? "Switched to demo mode" : "Switched to DeepSeek")}
              className={`rounded-md border px-3 py-2.5 text-left ${s.llmMode === v ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500" : "border-line hover:bg-paper"}`}
            >
              <div className="text-sm font-medium">{label}</div>
              <div className="text-xs text-muted">{desc}</div>
            </button>
          ))}
        </div>
        <Field label="DeepSeek API key" hint={<>Create one under "API keys" on platform.deepseek.com.{s.hasKey && <> Current: <code>{s.keyHint}</code></>}</>}>
          <div className="flex gap-2">
            <input
              className={inputCls}
              type="password"
              autoComplete="off"
              placeholder={s.hasKey ? "Saved (a new one replaces it)" : "sk-…"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <Button
              variant="primary"
              disabled={!key.trim()}
              busy={busy === "save"}
              onClick={() => save({ apiKey: key.trim(), llmMode: "deepseek" }, "API key saved").then(() => setKey(""))}
            >
              Save
            </Button>
          </div>
        </Field>
        <BalanceLine />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Base URL">
            <input className={inputCls} value={s.baseUrl} onChange={(e) => setS({ ...s, baseUrl: e.target.value })} onBlur={() => save({ baseUrl: s.baseUrl })} />
          </Field>
          <Field label="Model" hint="deepseek-chat is fast and good enough">
            <input className={inputCls} value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} onBlur={() => save({ model: s.model })} />
          </Field>
        </div>
        <Button
          size="sm"
          disabled={!s.hasKey}
          busy={busy === "test"}
          onClick={() => run("test", async () => { const r = await api<{ ok: boolean; model: string }>("/settings/test", { body: {} }); toast(r.ok ? `Connection works (${r.model})` : "The API answered, but not correctly", r.ok ? "ok" : "err"); })}
        >
          Test connection
        </Button>
      </Card>

      <BrowserCard data={data} s={s} save={save} busy={busy} run={run} token={token} setToken={setToken} />

      <Card className="space-y-4 p-5">
        <h2 className="font-medium">Applying</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Applications at a time" hint="One tab each; every one stops before submitting">
            <select className={inputCls} value={s.concurrency} onChange={(e) => save({ concurrency: Number(e.target.value) })}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Most steps per application" hint="Beyond that it stops and leaves the page for you">
            <input className={inputCls} type="number" min={10} max={120} value={s.maxSteps} onChange={(e) => setS({ ...s, maxSteps: Number(e.target.value) })} onBlur={() => save({ maxSteps: s.maxSteps })} />
          </Field>
          <Field label="Resume language">
            <select className={inputCls} value={s.resumeLanguage} onChange={(e) => save({ resumeLanguage: e.target.value as PublicSettings["resumeLanguage"] })}>
              <option value="auto">Same as the posting (English for English postings, Chinese for Chinese ones)</option>
              <option value="en">Always English</option>
              <option value="zh">Always Chinese</option>
            </select>
          </Field>
          <Field label="Cover letter" hint="When off, only for postings that ask for one; a form that asks for one also gets one written on the spot">
            <label className="flex h-[34px] items-center gap-2 text-sm">
              <input type="checkbox" className="accent-brand-600" checked={s.coverLetter} onChange={(e) => save({ coverLetter: e.target.checked })} />
              Write one for every job
            </label>
          </Field>
          <Field label="Minimum fit for the automatic flow" hint="When you paste many links at once, low-fit jobs stop after being read, with no automatic tailoring or applying; you can still continue by hand">
            <select className={inputCls} value={s.minFit} onChange={(e) => save({ minFit: Number(e.target.value) })}>
              <option value={0}>No minimum: run every job to the end</option>
              {[...new Set([40, 50, 60, 70, s.minFit])].filter((n) => n > 0).sort((a, b) => a - b).map((n) => (
                <option key={n} value={n}>
                  Stop below {n}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Save money: wait for off-peak hours"
            hint="DeepSeek charges peak prices on weekdays 9:00–12:00 and 14:00–18:00 (Beijing time, the same as Singapore) and half price the rest of the time. When on, tailoring and form filling from Process and the automatic flow wait during peak hours and start by themselves afterwards; reading jobs still happens right away, and so does anything you start from a single job's buttons."
          >
            <label className="flex h-[34px] items-center gap-2 text-sm">
              <input type="checkbox" className="accent-brand-600" checked={s.offPeakOnly} onChange={(e) => save({ offPeakOnly: e.target.checked })} />
              Run batch work off-peak only
            </label>
          </Field>
        </div>
      </Card>

      <NotifyCard />
      <UsageCard />
    </div>
  );
}
