// Interviews, tests, calls and deadlines on a job: listed on the jobs page, reminded in the
// browser, and downloadable as calendar files.
import { all, get, run, sqlNow } from "./db.ts";
import { emit } from "./events.ts";
import { getJob, setJob, type Progress } from "./jobs.ts";

export const EVENT_KINDS = ["interview", "test", "call", "deadline", "other"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
const LABEL: Record<EventKind, string> = { interview: "面试", test: "笔试/测评", call: "电话沟通", deadline: "投递截止", other: "日程" };

export type EventRow = {
  id: number;
  job_id: number;
  kind: EventKind;
  at: string;
  minutes: number;
  note: string;
  done: number;
  created_at: string;
};
export type EventView = EventRow & { job_title: string | null; job_company: string | null; job_url: string };

/** Any time the browser sends (ISO with Z or an offset) → UTC "YYYY-MM-DD HH:MM:SS"; null if unreadable. */
export function toSqlTime(v: unknown) {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

const SELECT = `SELECT e.*, j.title AS job_title, j.company AS job_company, j.url AS job_url FROM events e JOIN jobs j ON j.id = e.job_id`;

/** Upcoming = not done and not more than three hours past (an interview that is running still shows). */
export function listEvents(opts: { jobId?: number; upcoming?: boolean } = {}) {
  const where: string[] = [];
  const params: number[] = [];
  if (opts.jobId !== undefined) {
    where.push("e.job_id = ?");
    params.push(opts.jobId);
  }
  if (opts.upcoming) where.push("e.done = 0 AND e.at >= datetime('now', '-3 hours')");
  return all<EventView>(`${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY e.at, e.id`, ...params);
}

export function nextEvent(jobId: number) {
  return get<Pick<EventRow, "id" | "kind" | "at">>(
    "SELECT id, kind, at FROM events WHERE job_id = ? AND done = 0 AND at >= datetime('now', '-3 hours') ORDER BY at LIMIT 1",
    jobId,
  );
}

const RANK: Partial<Record<Progress, number>> = { applied: 0, screening: 1, interview: 2 };

export function addEvent(jobId: number, input: { kind?: unknown; at?: unknown; minutes?: unknown; note?: unknown }) {
  const job = getJob(jobId);
  if (!job) throw new Error("岗位不存在");
  const kind = EVENT_KINDS.includes(input.kind as EventKind) ? (input.kind as EventKind) : "other";
  const at = toSqlTime(input.at);
  if (!at) throw new Error("时间不对");
  const minutes = kind === "deadline" ? 0 : clampMinutes(input.minutes);
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";
  const { id } = run("INSERT INTO events (job_id, kind, at, minutes, note) VALUES (?, ?, ?, ?, ?)", jobId, kind, at, minutes, note);
  // An interview or a test on an applied job moves its progress forward (never back, never past an outcome).
  const want: Progress | null = kind === "interview" ? "interview" : kind === "test" ? "screening" : null;
  const cur = job.progress ?? (job.stage === "applied" ? "applied" : null);
  if (want && job.stage === "applied" && cur && RANK[cur] !== undefined && RANK[cur]! < RANK[want]!) {
    setJob(jobId, { progress: want, progress_at: sqlNow() });
  }
  emit("schedule", jobId);
  emit("job", jobId);
  return id;
}

function clampMinutes(v: unknown) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 60) : 60;
}

export function updateEvent(id: number, input: { kind?: unknown; at?: unknown; minutes?: unknown; note?: unknown; done?: unknown }) {
  const ev = get<EventRow>("SELECT * FROM events WHERE id = ?", id);
  if (!ev) throw new Error("没有这条日程");
  const patch: Record<string, string | number> = {};
  if (EVENT_KINDS.includes(input.kind as EventKind)) patch.kind = input.kind as EventKind;
  if (input.at !== undefined) {
    const at = toSqlTime(input.at);
    if (!at) throw new Error("时间不对");
    patch.at = at;
  }
  if (input.minutes !== undefined) patch.minutes = clampMinutes(input.minutes);
  if ((patch.kind ?? ev.kind) === "deadline") patch.minutes = 0;
  if (typeof input.note === "string") patch.note = input.note.trim().slice(0, 500);
  if (typeof input.done === "boolean") patch.done = input.done ? 1 : 0;
  const keys = Object.keys(patch);
  if (keys.length) run(`UPDATE events SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => patch[k]), id);
  emit("schedule", ev.job_id);
  emit("job", ev.job_id);
}

export function deleteEvent(id: number) {
  const ev = get<EventRow>("SELECT * FROM events WHERE id = ?", id);
  if (!ev) return;
  run("DELETE FROM events WHERE id = ?", id);
  emit("schedule", ev.job_id);
  emit("job", ev.job_id);
}

export function getEvent(id: number) {
  return get<EventView>(`${SELECT} WHERE e.id = ?`, id);
}

/** An .ics file with one event and a reminder (an hour before; a day before for a deadline). */
export function icsFor(ev: EventView) {
  const start = new Date(`${ev.at.replace(" ", "T")}Z`);
  const end = new Date(start.getTime() + Math.max(ev.minutes, ev.kind === "deadline" ? 0 : 15) * 60_000);
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const job = [ev.job_title, ev.job_company].filter(Boolean).join(" @ ") || ev.job_url;
  const link = ev.note.match(/https?:\/\/\S+/)?.[0];
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//resume-agent//CN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:resume-agent-event-${ev.id}@localhost`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(`${LABEL[ev.kind]} · ${job}`)}`,
    `DESCRIPTION:${esc([ev.note, ev.job_url].filter(Boolean).join("\n"))}`,
    ...(link ? [`URL:${link}`, `LOCATION:${esc(link)}`] : ev.note && ev.note.length < 120 ? [`LOCATION:${esc(ev.note)}`] : []),
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${esc(LABEL[ev.kind])}`,
    `TRIGGER:${ev.kind === "deadline" ? "-P1D" : "-PT1H"}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  // Lines longer than 75 octets are folded, as the format requires.
  return lines.map(fold).join("\r\n") + "\r\n";
}

function fold(line: string) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    if (len + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      len = 0;
    }
    cur += ch;
    len += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export { LABEL as EVENT_LABEL };
