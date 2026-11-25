import { useCallback, useEffect, useRef, useState } from "react";

export type Bullet = { id: string; text: string };
export type Entry = {
  id: string;
  title: string;
  dates: string;
  subtitle: string;
  location: string;
  bullets: Bullet[];
};
export type Section = { id: string; heading: string; entries: Entry[] };
export type SkillGroup = { id: string; label: string; items: string[] };
export type Answer = { id: string; q: string; a: string };
export type Basics = {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneCountryCode: string;
  location: string;
  linkedin: string;
  github: string;
  website: string;
};
export type Profile = {
  basics: Basics;
  summary: string;
  sections: Section[];
  skills: SkillGroup[];
  skillsHeading: string;
  skillsPosition: number;
  extraFacts: string;
  answers: Answer[];
};
export type ResumeDoc = Pick<Profile, "basics" | "summary" | "sections" | "skills" | "skillsHeading" | "skillsPosition">;
export type JobJd = {
  title: string;
  company: string;
  location: string;
  summary: string;
  requirements: string[];
  niceToHave: string[];
  keywords: string[];
  language: "en" | "zh";
  closed: boolean;
  fit: Fit | null;
  /** null on jobs read before conditions were recorded (re-read them). */
  facts: JobFacts | null;
};
export type Material = "cover_letter" | "transcript" | "portfolio" | "references" | "other";
/** The posting's conditions; "" / null / [] where it does not say. Mirrors server/jobs.ts. */
export type JobFacts = {
  type: "fulltime" | "parttime" | "internship" | "contract" | "unknown";
  hours: "full" | "part" | "";
  months: number | null;
  start: string;
  minYears: number | null;
  degree: "none" | "diploma" | "bachelor" | "master" | "phd" | "";
  student: "enrolled" | "graduated" | "";
  workAuth: "citizen" | "citizen_pr" | "";
  salary: string;
  materials: Material[];
  coverLetterAsk: string;
  workplace: "onsite" | "hybrid" | "remote" | "";
};
/** unsupported: tools a strength names that the profile never mentions. */
export type Fit = {
  score: number;
  verdict: string;
  /** A clear clash with what the candidate is looking for; the score is capped when set. */
  conflict?: string;
  strengths: string[];
  gaps: string[];
  unsupported?: string[];
};
export type Coverage = {
  keywords: string[];
  before: string[];
  after: string[];
};
export type RunStatus = "queued" | "running" | "need_user" | "awaiting_confirm" | "submitted" | "finished" | "failed" | "cancelled" | "interrupted";
export type Progress = "applied" | "screening" | "interview" | "offer" | "rejected" | "withdrawn";
export const PROGRESS: Array<{
  key: Progress;
  label: string;
  tone: "green" | "blue" | "violet" | "gray";
}> = [
  { key: "applied", label: "Awaiting reply", tone: "green" },
  { key: "screening", label: "Assessment", tone: "blue" },
  { key: "interview", label: "Interviewing", tone: "violet" },
  { key: "offer", label: "Offer", tone: "green" },
  { key: "rejected", label: "Rejected", tone: "gray" },
  { key: "withdrawn", label: "Withdrawn", tone: "gray" },
];
export type JobView = {
  id: number;
  url: string;
  title: string | null;
  company: string | null;
  location: string | null;
  stage: "new" | "parsed" | "tailored" | "applied" | "skipped";
  busy: string | null;
  /** The batch step waiting for DeepSeek's off-peak hours or a free slot. */
  held: "tailor" | "apply" | null;
  error: string | null;
  notice: string | null;
  autoApply: boolean;
  createdAt: string;
  updatedAt: string;
  progress: Progress | null;
  progressAt: string | null;
  appliedAt: string | null;
  notes: string;
  jd: JobJd | null;
  /** The posting's keywords the profile already mentions. */
  kwHave: string[];
  hasResume: boolean;
  hasCover: boolean;
  coverage: Coverage | null;
  warnings: number;
  tokens: number;
  /** Estimated RMB this job's model calls cost. */
  cost: number;
  nextEvent: { id: number; kind: EventKind; at: string } | null;
  hasPrep: boolean;
  run: {
    id: number;
    status: RunStatus;
    outcome: string | null;
    steps: number;
    live: boolean;
  } | null;
};

export type EventKind = "interview" | "test" | "call" | "deadline" | "other";
export const EVENT_KINDS: Array<{
  key: EventKind;
  label: string;
  dot: string;
}> = [
  { key: "interview", label: "Interview", dot: "bg-violet-500" },
  { key: "test", label: "Assessment", dot: "bg-sky-500" },
  { key: "call", label: "Call", dot: "bg-brand-500" },
  { key: "deadline", label: "Deadline", dot: "bg-amber-500" },
  { key: "other", label: "Other", dot: "bg-stone-400" },
];
export const eventLabel = (k: EventKind) => EVENT_KINDS.find((x) => x.key === k)?.label ?? "Event";
export type CalEvent = {
  id: number;
  job_id: number;
  kind: EventKind;
  at: string;
  minutes: number;
  note: string;
  done: number;
  job_title: string | null;
  job_company: string | null;
  job_url: string;
};
/** fact: from the profile (from = where); tip: how to answer; unsure: not backed by the profile (from = why). */
export type PrepPoint = {
  text: string;
  kind: "fact" | "tip" | "unsure";
  from: string;
};
export type PrepQuestion = {
  q: string;
  kind: "behavioral" | "technical" | "role" | "resume";
  why: string;
  points: PrepPoint[];
};
export type Prep = {
  pitch: string;
  pitchWarnings: string[];
  questions: PrepQuestion[];
  toAsk: string[];
  gaps: Array<{ gap: string; how: string }>;
  generatedAt: string;
};
export type DraftKind = "followup" | "thanks";
export type Draft = {
  subject: string;
  body: string;
  extra: string;
  generatedAt: string;
  warnings?: string[];
};
export type StatBucket = {
  key: string;
  label: string;
  applied: number;
  replied: number;
  positive: number;
};
export type Stats = {
  funnel: {
    added: number;
    parsed: number;
    tailored: number;
    applied: number;
    replied: number;
    interview: number;
    offer: number;
  };
  responseRate: { applied: number; replied: number; recent: number };
  medianReplyDays: number | null;
  ended: number;
  weekly: Array<{ start: string; added: number; applied: number }>;
  byFit: StatBucket[];
  bySite: StatBucket[];
  upcoming: number;
  tokens: number;
};
export type AskedQuestion = {
  q: string;
  a: string;
  times: number;
  job: string;
  ts: string;
};
export type Tailored = {
  doc: ResumeDoc;
  origin: Record<string, string>;
  notes: string[];
  warnings: string[];
  coverage: Coverage;
  generatedAt: string;
  scale?: number;
};
export type Pending =
  | { kind: "ask"; question: string; field: string }
  | { kind: "manual"; reason: string }
  | {
      kind: "review";
      summary: string;
      fields: { label: string; value: string }[];
      screenshot: string;
      targetText: string;
      url: string;
    };
export type RunView = {
  id: number;
  job_id: number;
  status: RunStatus;
  pending: Pending | null;
  outcome: string | null;
  steps: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  job_title: string | null;
  job_company: string | null;
  job_url: string;
  live: boolean;
  /** Latest screenshot of the run's tab (live while it runs, the last screen afterwards). */
  shot: string | null;
};
export type Step = { id: number; ts: string; kind: string; text: string };
export type PublicSettings = {
  llmMode: "deepseek" | "demo";
  baseUrl: string;
  model: string;
  browserChannel: "msedge" | "chrome";
  concurrency: number;
  maxSteps: number;
  coverLetter: boolean;
  resumeLanguage: "auto" | "en" | "zh";
  minFit: number;
  offPeakOnly: boolean;
  hasKey: boolean;
  keyHint: string;
  hasExtensionToken: boolean;
};
/** Connection to your own browser through the Playwright Extension. waiting = the connect page is open there. */
export type SearchKind = "fulltime" | "parttime" | "internship";
export type SearchSource = "linkedin" | "mcf";
export type FoundJob = {
  source: SearchSource;
  title: string;
  company: string;
  location: string;
  posted: string;
  url: string;
  salary: string;
  existingId: number | null;
};
export type BrowserState = {
  status: "off" | "waiting" | "on";
  error: string;
  tokenSet: boolean;
  extensionUrl: string;
};
export type ProfileStats = {
  basics: boolean;
  sections: number;
  bullets: number;
  facts: number;
  answers: number;
  answered: number;
};
export type AppState = {
  settings: PublicSettings;
  browserOpen: boolean;
  browser: BrowserState;
  demo: boolean;
  llm: { ok: true } | { ok: false; reason: string; code: "no_key" | "no_balance" };
  profile: ProfileStats;
  /** Job sites with a sign-in page, shown in Settings. */
  sites: Array<{ key: string; name: string; login: string; note: string }>;
};
export type UsageSum = {
  calls: number;
  input: number;
  output: number;
  cached: number;
  /** Estimated RMB at DeepSeek's prices, by the time of each call. */
  rmb: number;
};
export type Usage = {
  today: UsageSum;
  month: UsageSum;
  total: UsageSum;
  byKind: Array<{ kind: string; calls: number; tokens: number; rmb: number }>;
};
export type Balance = { available: boolean; total: number; currency: string };

/** ¥0.012 for small amounts, ¥3.40 from a yuan up. */
export function rmb(n: number) {
  return `¥${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
}

// ---- time: the server stores UTC as "YYYY-MM-DD HH:MM:SS" (or ISO with Z)
export function parseTime(s: string | null | undefined) {
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function ago(s: string | null | undefined) {
  const d = parseTime(s);
  if (!d) return "";
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  if (sec < 86400 * 7) {
    const n = Math.floor(sec / 86400);
    return `${n} ${n === 1 ? "day" : "days"} ago`;
  }
  return dayMonth(d, d.getFullYear() !== new Date().getFullYear());
}
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "20 Nov", or "20 Nov 2025" with the year. */
const dayMonth = (d: Date, withYear = false) => `${d.getDate()} ${MONTH[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ""}`;
export function localTime(s: string | null | undefined) {
  const d = parseTime(s);
  if (!d) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dayMonth(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** "20 Nov": localTime without the time. */
export function localDay(s: string | null | undefined) {
  const d = parseTime(s);
  return d ? dayMonth(d) : "";
}
export const daysSince = (s: string | null | undefined) => {
  const d = parseTime(s);
  return d ? (Date.now() - d.getTime()) / 86_400_000 : Infinity;
};
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Today 14:00", "Tomorrow 09:30", "Thu 14:00" within a week, else "20 Nov 14:00". */
export function whenLabel(s: string | null | undefined, withTime = true) {
  const d = parseTime(s);
  if (!d) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  const time = withTime ? ` ${p(d.getHours())}:${p(d.getMinutes())}` : "";
  const day0 = new Date();
  day0.setHours(0, 0, 0, 0);
  const days = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - day0.getTime()) / 86_400_000);
  if (days === 0) return `Today${time}`;
  if (days === 1) return `Tomorrow${time}`;
  if (days === -1) return `Yesterday${time}`;
  if (days > 1 && days < 7) return `${WEEKDAY[d.getDay()]}${time}`;
  return `${dayMonth(d, d.getFullYear() !== day0.getFullYear())}${time}`;
}
/** Hours from now (negative = past). */
export const hoursUntil = (s: string | null | undefined) => {
  const d = parseTime(s);
  return d ? (d.getTime() - Date.now()) / 3_600_000 : Infinity;
};
/** A Date as the value of <input type="datetime-local">. */
export function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function tokens(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// ---- per-browser preferences (conveniences only; nothing important lives here)
export const pref = {
  get(key: string) {
    try {
      return localStorage.getItem(`ra-${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(`ra-${key}`);
      else localStorage.setItem(`ra-${key}`, v);
    } catch {
      /* private window */
    }
  },
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: Blob } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined || opts.raw ? "POST" : "GET"),
    headers: opts.raw ? { "Content-Type": "application/pdf" } : opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

// ---- live updates: one EventSource shared by every hook
type Ev = { type: string; id?: number };
const listeners = new Set<(e: Ev) => void>();
let source: EventSource | null = null;
function ensureSource() {
  if (source) return;
  source = new EventSource("/api/events");
  // Events sent while the connection was down (the server restarting, the laptop asleep) are
  // lost, so after a reconnect every hook refetches.
  let dropped = false;
  source.onerror = () => {
    dropped = true;
  };
  source.onopen = () => {
    if (!dropped) return;
    dropped = false;
    for (const l of listeners) l({ type: "*" });
  };
  source.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as Ev;
      for (const l of listeners) l(e);
    } catch {
      /* ignore */
    }
  };
}
export function useEvents(types: string[], fn: (e: Ev) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  const key = types.join(",");
  useEffect(() => {
    ensureSource();
    const l = (e: Ev) => {
      if (e.type === "*" || key.split(",").includes(e.type)) ref.current(e);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [key]);
}

/** Fetches a path and refetches (throttled) whenever one of the event types fires. */
export function useApi<T>(path: string | null, types: string[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const retry = useRef<number | null>(null);
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // The local server may be restarting: try again shortly.
      if (retry.current) clearTimeout(retry.current);
      retry.current = window.setTimeout(() => void load(), 2000);
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void load();
    return () => {
      if (retry.current) clearTimeout(retry.current);
    };
  }, [load]);
  useEvents(types, () => {
    if (timer.current) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void load();
    }, 250);
  });
  return { data, error, reload: load, setData };
}

// ---- hash router
export function useRoute() {
  const get = () => window.location.hash.replace(/^#/, "") || "/";
  const [route, setRoute] = useState(get);
  useEffect(() => {
    const on = () => setRoute(get());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
export const go = (path: string) => {
  window.location.hash = path;
};

export const RUN_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Filling in",
  need_user: "Needs you",
  awaiting_confirm: "Ready to submit",
  submitted: "Submitted",
  finished: "Finished",
  failed: "Failed",
  cancelled: "Abandoned",
  interrupted: "Interrupted",
};
