// Numbers for the stats page: how far applications get, how fast replies come, and whether
// the fit score and the job site make a difference.
import { all, get } from "./db.ts";
import { jobJd, listJobs, progressReached, type Progress } from "./jobs.ts";
import { listEvents } from "./schedule.ts";

const KNOWN: Array<[RegExp, string]> = [
  [/greenhouse\.io$/, "Greenhouse"],
  [/lever\.co$/, "Lever"],
  [/linkedin\.com$/, "LinkedIn"],
  [/(myworkdayjobs|workday)\.com$/, "Workday"],
  [/mycareersfuture\.gov\.sg$/, "MyCareersFuture"],
  [/ashbyhq\.com$/, "Ashby"],
  [/smartrecruiters\.com$/, "SmartRecruiters"],
  [/(^|\.)indeed\./, "Indeed"],
  [/(^|\.)glassdoor\./, "Glassdoor"],
  [/(^|\.)jobstreet\./, "JobStreet"],
  [/zhipin\.com$/, "BOSS Zhipin"],
  [/nowcoder\.com$/, "Nowcoder"],
  [/^(localhost|127\.0\.0\.1)$/, "Local test page"],
];

/** Where a posting lives: a known job board by name, otherwise the site's own name. */
export function siteOf(url: string) {
  if (!url) return "Pasted JD";
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    for (const [re, name] of KNOWN) if (re.test(h)) return name;
    const parts = h.split(".");
    const twoPart = parts.length >= 3 && /^(com|gov|edu|org|net|co|ac)$/.test(parts[parts.length - 2]);
    return parts[parts.length - (twoPart ? 3 : 2)] ?? h;
  } catch {
    return "Other";
  }
}

const REPLY: Progress[] = ["screening", "interview", "offer", "rejected"];
const POSITIVE: Progress[] = ["screening", "interview", "offer"];
const utc = (s: string) => new Date(`${s.replace(" ", "T")}Z`);

/** Monday 00:00 local time of the week containing d. */
function weekStart(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

type Bucket = { key: string; label: string; applied: number; replied: number; positive: number };
const bucket = (key: string, label: string): Bucket => ({ key, label, applied: 0, replied: 0, positive: 0 });

export function stats() {
  const jobs = listJobs();
  const funnel = { added: 0, parsed: 0, tailored: 0, applied: 0, replied: 0, interview: 0, offer: 0 };
  let mature = 0;
  let matureReplied = 0;
  let ended = 0;
  const replyDays: number[] = [];
  const fit = [bucket("high", "70 and up"), bucket("mid", "50–69"), bucket("low", "Below 50"), bucket("none", "No score")];
  const sites = new Map<string, Bucket>();

  const WEEKS = 10;
  const thisWeek = weekStart(new Date());
  const weeks = Array.from({ length: WEEKS }, (_, i) => {
    const d = new Date(thisWeek);
    d.setDate(d.getDate() - 7 * (WEEKS - 1 - i));
    return { start: ymd(d), t: d.getTime(), added: 0, applied: 0 };
  });
  const weekOf = (s: string | null) => {
    if (!s) return null;
    const t = weekStart(utc(s)).getTime();
    return weeks.find((w) => w.t === t) ?? null;
  };

  for (const j of jobs) {
    if (j.stage === "skipped") continue;
    funnel.added++;
    const wa = weekOf(j.created_at);
    if (wa) wa.added++;
    if (j.jd) funnel.parsed++;
    if (j.tailored) funnel.tailored++;
    if (j.stage !== "applied") continue;
    funnel.applied++;
    const appliedAt = j.applied_at ?? j.updated_at;
    const wp = weekOf(appliedAt);
    if (wp) wp.applied++;

    const cur = (j.progress ?? "applied") as Progress;
    const reached = progressReached(j.id, cur);
    const replied = REPLY.some((p) => reached.has(p));
    const positive = POSITIVE.some((p) => reached.has(p));
    if (replied) funnel.replied++;
    if (reached.has("interview") || reached.has("offer")) funnel.interview++;
    if (reached.has("offer")) funnel.offer++;
    if (cur === "rejected" || cur === "withdrawn") ended++;

    const age = (Date.now() - utc(appliedAt).getTime()) / 86_400_000;
    if (age >= 7) {
      mature++;
      if (replied) matureReplied++;
    }
    if (replied) {
      const first =
        get<{ ts: string | null }>("SELECT MIN(ts) AS ts FROM progress_log WHERE job_id = ? AND progress != 'applied'", j.id)?.ts ??
        (cur !== "applied" ? j.progress_at : null);
      if (first) {
        const d = (utc(first).getTime() - utc(appliedAt).getTime()) / 86_400_000;
        if (d >= 0) replyDays.push(d);
      }
    }

    const score = jobJd(j)?.fit?.score;
    const b = score === undefined ? fit[3] : score >= 70 ? fit[0] : score >= 50 ? fit[1] : fit[2];
    const name = siteOf(j.url);
    if (!sites.has(name)) sites.set(name, bucket(name, name));
    for (const x of [b, sites.get(name)!]) {
      x.applied++;
      if (replied) x.replied++;
      if (positive) x.positive++;
    }
  }

  replyDays.sort((a, b) => a - b);
  const median = replyDays.length ? replyDays[Math.floor((replyDays.length - 1) / 2)] : null;
  return {
    funnel,
    responseRate: { applied: mature, replied: matureReplied, recent: funnel.applied - mature },
    medianReplyDays: median === null ? null : Math.round(median * 10) / 10,
    ended,
    weekly: weeks.map(({ start, added, applied }) => ({ start, added, applied })),
    byFit: fit.filter((b) => b.applied > 0),
    bySite: [...sites.values()].sort((a, b) => b.applied - a.applied).slice(0, 8),
    upcoming: listEvents({ upcoming: true }).length,
    tokens: get<{ n: number }>("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS n FROM usage")?.n ?? 0,
  };
}

/** How the agent records a question it asked you, and your answer, in a run's steps. */
export const ASKED = "Question for you: ";
export const ANSWERED = "Your answer: ";
export const SAVED = " (saved to your profile)";
// The same steps as the Chinese edition wrote them, so questions asked before switching still count.
const ASKED_ZH = "问你：";
const ANSWERED_ZH = "你的回答：";
const SAVED_ZH = "（已记入资料库）";
const unprefix = (t: string, ps: string[]) => t.slice(ps.find((p) => t.startsWith(p))?.length ?? 0);
const unsuffix = (t: string, ss: string[]) => t.slice(0, t.length - (ss.find((s) => t.endsWith(s))?.length ?? 0));

/** Questions the agent asked you that are not in the profile's answers yet, with what you said. */
export function askedQuestions(similar: (a: string, b: string) => number, answers: Array<{ q: string; a: string }>) {
  const rows = all<{ id: number; run_id: number; kind: string; text: string; ts: string; job_id: number; title: string | null; company: string | null }>(
    `SELECT s.id, s.run_id, s.kind, s.text, s.ts, r.job_id, j.title, j.company
     FROM run_steps s JOIN runs r ON r.id = s.run_id JOIN jobs j ON j.id = r.job_id
     WHERE (s.kind = 'ask' AND (s.text LIKE ? OR s.text LIKE ?)) OR (s.kind = 'note' AND (s.text LIKE ? OR s.text LIKE ?))
     ORDER BY s.run_id, s.id`,
    `${ASKED}%`,
    `${ASKED_ZH}%`,
    `${ANSWERED}%`,
    `${ANSWERED_ZH}%`,
  );
  const out = new Map<string, { q: string; a: string; times: number; job: string; ts: string }>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind !== "ask") continue;
    const q = unprefix(r.text, [ASKED, ASKED_ZH]).trim();
    const next = rows[i + 1];
    const a = next && next.run_id === r.run_id && next.kind === "note" ? unsuffix(unprefix(next.text, [ANSWERED, ANSWERED_ZH]), [SAVED, SAVED_ZH]).trim() : "";
    if (!q || answers.some((x) => x.a.trim() && similar(x.q, q) >= 0.8)) continue;
    const key = q.toLowerCase().replace(/\s+/g, " ");
    const prev = out.get(key);
    out.set(key, { q, a: a || prev?.a || "", times: (prev?.times ?? 0) + 1, job: [r.title, r.company].filter(Boolean).join(" · "), ts: r.ts });
  }
  return [...out.values()].sort((a, b) => b.times - a.times || b.ts.localeCompare(a.ts)).slice(0, 30);
}

