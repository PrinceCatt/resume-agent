import { useEffect, useRef, useState } from "react";
import { api, eventLabel, go, hoursUntil, pref, useApi, useRoute, whenLabel, type AppState, type CalEvent, type RunView } from "./api.ts";
import { Icon, Toasts, toast, type IconName } from "./components/ui.tsx";
import { jobName } from "./status.ts";
import JobsPage from "./pages/Jobs.tsx";
import JobDetailPage from "./pages/JobDetail.tsx";
import ReviewPage from "./pages/Review.tsx";
import ProfilePage from "./pages/Profile.tsx";
import SettingsPage from "./pages/Settings.tsx";
import StatsPage from "./pages/Stats.tsx";

const isWaiting = (r: RunView) => r.status === "need_user" || r.status === "awaiting_confirm";

/** A system notification when a run starts waiting for you while this tab is in the background. */
function useWaitingNotifications(runs: RunView[] | undefined) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!runs) return;
    const waiting = runs.filter(isWaiting);
    const keys = new Set(waiting.map((r) => `${r.id}:${r.status}:${r.updated_at}`));
    const before = seen.current;
    seen.current = keys;
    if (!before) return; // the first load is not news
    const fresh = waiting.filter((r) => !before.has(`${r.id}:${r.status}:${r.updated_at}`));
    if (!fresh.length || pref.get("notify") !== "1" || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    const r = fresh[0];
    const name = jobName({ title: r.job_title, company: r.job_company, url: r.job_url });
    const what = r.status === "awaiting_confirm" ? "filled in, waiting for you to confirm" : r.pending?.kind === "manual" ? "needs you in the browser" : "has a question for you";
    const n = new Notification(fresh.length > 1 ? `${fresh.length} applications are waiting for you` : "Resume Agent", {
      body: `${name}${r.job_company ? ` · ${r.job_company}` : ""}: ${what}`,
      tag: "resume-agent-waiting",
    });
    n.onclick = () => {
      window.focus();
      go("/review");
      n.close();
    };
  }, [runs]);
}

/** One reminder per event: an hour before it starts, a day before a deadline. */
function useEventReminders() {
  const { data } = useApi<{ events: CalEvent[] }>("/schedule?upcoming=1", ["schedule", "job"]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    for (const e of data?.events ?? []) {
      const lead = e.kind === "deadline" ? 24 : 1;
      const h = hoursUntil(e.at);
      if (h > lead || h < -0.25) continue;
      const key = `reminded-${e.id}-${e.at}`;
      if (pref.get(key)) continue;
      pref.set(key, "1");
      const job = [jobName({ title: e.job_title, company: e.job_company, url: e.job_url }), e.job_company].filter(Boolean).join(" · ");
      const what = `${whenLabel(e.at)} ${eventLabel(e.kind)}`;
      if (pref.get("notify") === "1" && typeof Notification !== "undefined" && Notification.permission === "granted") {
        const n = new Notification(e.kind === "deadline" ? "Application deadline coming up" : `In ${Math.max(1, Math.round(h * 60))} min: ${eventLabel(e.kind)}`, {
          body: `${job}\n${what}${e.note ? `\n${e.note}` : ""}`,
          tag: `resume-agent-event-${e.id}`,
        });
        n.onclick = () => {
          window.focus();
          go(`/jobs/${e.job_id}`);
          n.close();
        };
      } else {
        toast(`Reminder: ${what} · ${job}`);
      }
    }
  }, [data, tick]);
}

export default function App() {
  const route = useRoute();
  const state = useApi<AppState>("/state", ["settings", "browser", "profile"]);
  const active = useApi<{ runs: RunView[] }>("/runs?active=1", ["run"]);
  const waiting = (active.data?.runs ?? []).filter(isWaiting).length;
  useWaitingNotifications(active.data?.runs);
  useEventReminders();
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Resume Agent` : "Resume Agent";
  }, [waiting]);

  let page;
  const m = route.match(/^\/jobs\/(\d+)/);
  if (m) page = <JobDetailPage key={m[1]} id={Number(m[1])} />;
  else if (route.startsWith("/review")) page = <ReviewPage />;
  else if (route.startsWith("/profile")) page = <ProfilePage />;
  else if (route.startsWith("/settings")) page = <SettingsPage />;
  else if (route.startsWith("/stats")) page = <StatsPage />;
  else page = <JobsPage state={state.data} />;

  const nav: Array<{ path: string; label: string; icon: IconName; count?: number; match: (r: string) => boolean }> = [
    { path: "/", label: "Jobs", icon: "jobs", match: (r) => r === "/" || r.startsWith("/jobs") },
    { path: "/review", label: "Waiting", icon: "inbox", count: waiting, match: (r) => r.startsWith("/review") },
    { path: "/stats", label: "Stats", icon: "chart", match: (r) => r.startsWith("/stats") },
    { path: "/profile", label: "Profile", icon: "profile", match: (r) => r.startsWith("/profile") },
    { path: "/settings", label: "Settings", icon: "settings", match: (r) => r.startsWith("/settings") },
  ];
  const s = state.data;
  const llm = !s
    ? null
    : s.demo
      ? { text: "Demo mode (no model calls)", short: "Demo mode", tone: "text-amber-700", dot: "bg-amber-500" }
      : s.llm.ok
        ? { text: `DeepSeek · ${s.settings.model}`, short: "DeepSeek", tone: "text-brand-700", dot: "bg-brand-500" }
        : s.llm.code === "no_balance"
          ? { text: "DeepSeek balance too low", short: "No balance", tone: "text-red-700", dot: "bg-red-500" }
          : { text: "No API key yet", short: "Not set up", tone: "text-red-700", dot: "bg-red-500" };

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="border-b border-line bg-white md:sticky md:top-0 md:flex md:h-screen md:w-56 md:shrink-0 md:flex-col md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-3 px-4 py-3 md:block md:px-5 md:py-5">
          <button onClick={() => go("/")} className="flex items-center gap-2 text-left">
            <span className="grid size-7 place-items-center rounded-md bg-brand-600 text-white">
              <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M4 2.5h6l2.5 2.5v8.5h-8.5z" />
                <path d="M6 8h5M6 10.5h5" />
              </svg>
            </span>
            <span className="font-semibold tracking-tight">Resume Agent</span>
          </button>
          {llm && (
            <button className={`flex items-center gap-1.5 text-xs md:hidden ${llm.tone}`} onClick={() => go("/settings")}>
              <span className={`size-1.5 rounded-full ${llm.dot}`} />
              {llm.short}
            </button>
          )}
        </div>
        <nav className="scroll-clean flex gap-1 overflow-x-auto px-3 pb-2 md:flex-col md:pb-0">
          {nav.map((n) => {
            const on = n.match(route);
            return (
              <button
                key={n.path}
                onClick={() => go(n.path)}
                aria-current={on ? "page" : undefined}
                className={`flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm whitespace-nowrap md:py-2 ${on ? "bg-brand-50 font-medium text-brand-700" : "text-muted hover:bg-paper hover:text-ink"}`}
              >
                <Icon name={n.icon} className={`size-4 ${on ? "text-brand-600" : "text-stone-400"}`} />
                <span className="flex-1 text-left">{n.label}</span>
                {!!n.count && <span className="rounded-full bg-amber-500 px-1.5 text-xs leading-5 font-semibold text-white tabular-nums">{n.count}</span>}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto hidden space-y-2.5 border-t border-line px-5 py-4 text-xs md:block">
          {llm && (
            <button className={`flex items-center gap-1.5 text-left hover:underline ${llm.tone}`} onClick={() => go("/settings")}>
              <span className={`size-1.5 shrink-0 rounded-full ${llm.dot}`} />
              {llm.text}
            </button>
          )}
          {s && (
            <div className="flex items-center justify-between gap-2 text-muted">
              <span className="flex items-center gap-1.5">
                <span className={`size-1.5 rounded-full ${s.browser.status === "on" ? "bg-brand-500" : s.browser.status === "waiting" ? "bg-amber-400" : "bg-stone-300"}`} />
                {(s.settings.browserChannel === "chrome" ? "Chrome" : "Edge") + (s.browser.status === "on" ? " connected" : s.browser.status === "waiting" ? " waiting for you to allow" : " not connected")}
              </span>
              {s.browser.status === "off" && (
                <button
                  className="text-brand-700 hover:underline"
                  onClick={() => {
                    if (s.browser.error) go("/settings");
                    api("/browser/open", { body: {} }).catch((e) => toast(e.message, "err"));
                  }}
                >
                  Connect
                </button>
              )}
            </div>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-5 md:px-8 md:py-7">{page}</main>
      <Toasts />
    </div>
  );
}
