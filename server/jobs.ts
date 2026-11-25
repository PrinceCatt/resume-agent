// Job intake: read the posting (headless first, the signed-in window if the page needs it),
// then pull out title, company, requirements and keywords.
import { createHash } from "node:crypto";
import { all, get, parseJson, run, sqlNow } from "./db.ts";
import { emit } from "./events.ts";
import { getSettings } from "./settings.ts";
import { getHeadless, newVisiblePage } from "./browser.ts";
import { chatJson, isDemo, llmReady } from "./llm.ts";
import { mockExtractJob, mockFit } from "./mock.ts";
import { getProfile, profileForPrompt, type Profile } from "./profile.ts";
import { profileText, unsupportedTerms } from "./terms.ts";
import { isCheckPage, siteFor } from "./sites.ts";
import { makeQueue } from "./tasks.ts";
import { mcfPostingText } from "./discover.ts";
import type { Page } from "playwright-core";

export type JobJd = {
  title: string;
  company: string;
  location: string;
  /** Two or three sentences in Chinese, for the list view. */
  summary: string;
  requirements: string[];
  niceToHave: string[];
  keywords: string[];
  language: "en" | "zh";
  closed: boolean;
  /** How well the profile meets the posting, judged when the job is read. */
  fit: Fit | null;
  /** The posting's conditions as fields, for filtering and statistics. null on jobs read before 2026-11-13. */
  facts: JobFacts | null;
  /** Fingerprint of everything the model read (prompt, profile, posting, model), so re-reading an unchanged job costs nothing. */
  src?: string;
};

export const MATERIALS = ["cover_letter", "transcript", "portfolio", "references", "other"] as const;
export type Material = (typeof MATERIALS)[number];
/** Only what the posting states; "" / null / [] when it does not say. */
export type JobFacts = {
  type: "fulltime" | "parttime" | "internship" | "contract" | "unknown";
  /** Internships and contracts: full-time or part-time hours. */
  hours: "full" | "part" | "";
  /** Internship or contract length in months. */
  months: number | null;
  /** Start date as written ("Jan 2027", "immediately"). */
  start: string;
  /** Minimum years of work experience; 0 when no experience is needed. */
  minYears: number | null;
  degree: "none" | "diploma" | "bachelor" | "master" | "phd" | "";
  /** "enrolled": must be a current student (most internships); "graduated": must already hold the degree. */
  student: "enrolled" | "graduated" | "";
  /** Only Singapore citizens, or only citizens and PRs. */
  workAuth: "citizen" | "citizen_pr" | "";
  salary: string;
  /** Documents asked for besides the resume. */
  materials: Material[];
  /** What the posting wants a cover letter to address. */
  coverLetterAsk: string;
  workplace: "onsite" | "hybrid" | "remote" | "";
};

/** The posting asks for a cover letter. */
export const asksCoverLetter = (jd: JobJd | null) => !!jd?.facts?.materials.includes("cover_letter");

/** unsupported: tools a strength names that the profile never mentions (the score may be inflated). */
/** conflict: a clear clash with what the candidate is looking for (a full-time internship for someone who wants part-time ones); it caps the score. */
export type Fit = { score: number; verdict: string; strengths: string[]; gaps: string[]; unsupported?: string[]; conflict?: string };
export const FIT_CONFLICT_CAP = 45;

export const PROGRESS = ["applied", "screening", "interview", "offer", "rejected", "withdrawn"] as const;
export type Progress = (typeof PROGRESS)[number];

export type JobRow = {
  id: number;
  url: string;
  title: string | null;
  company: string | null;
  location: string | null;
  stage: "new" | "parsed" | "tailored" | "applied" | "skipped";
  busy: string | null;
  error: string | null;
  jd_text: string | null;
  jd: string | null;
  tailored: string | null;
  cover_letter: string | null;
  resume_file: string | null;
  cover_file: string | null;
  auto_apply: number;
  progress: Progress | null;
  progress_at: string | null;
  applied_at: string | null;
  notes: string | null;
  notice: string | null;
  prep: string | null;
  drafts: string | null;
  held: "tailor" | "apply" | null;
  created_at: string;
  updated_at: string;
};

export const bgQueue = makeQueue(() => 2);

// The queue lives in memory, so a restart drops whatever was reading or tailoring. Without this the job
// showed "读取岗位中" for good, with no button to try again.
run(
  "UPDATE jobs SET error = CASE busy WHEN 'parsing' THEN '程序重启，读取中断了，再点一次' ELSE '程序重启，改简历中断了，再点一次' END, busy = NULL WHERE busy IS NOT NULL",
);

export function getJob(id: number) {
  return get<JobRow>("SELECT * FROM jobs WHERE id = ?", id);
}

export function setJob(id: number, patch: Partial<Record<keyof JobRow, string | number | null>>) {
  const cur = patch.stage === "applied" || patch.progress !== undefined ? getJob(id) : undefined;
  if (cur && patch.stage === "applied") {
    // The first time a job counts as applied starts its follow-up tracking.
    if (!cur.applied_at && patch.applied_at === undefined) patch = { ...patch, applied_at: sqlNow() };
    if (!cur.progress && patch.progress === undefined) patch = { ...patch, progress: "applied", progress_at: sqlNow() };
  }
  const keys = Object.keys(patch);
  if (!keys.length) return;
  run(
    `UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
    ...keys.map((k) => (patch as any)[k] as string | number | null),
    id,
  );
  if (cur && typeof patch.progress === "string" && patch.progress !== cur.progress) {
    const log = (p: string, ts: string) => run("INSERT INTO progress_log (job_id, progress, ts) VALUES (?, ?, ?)", id, p, ts);
    if (!get("SELECT 1 FROM progress_log WHERE job_id = ?", id)) {
      // Every history starts with "applied": a job applied before the log existed gets it (and where it
      // stood) dated from the job; one marked straight as "test" or "interview" gets it now.
      if (cur.progress) {
        log("applied", cur.applied_at ?? cur.updated_at);
        if (cur.progress !== "applied") log(cur.progress, cur.progress_at ?? cur.updated_at);
      } else if (patch.progress !== "applied") {
        log("applied", (patch.applied_at as string | undefined) ?? cur.applied_at ?? sqlNow());
      }
    }
    log(patch.progress, (patch.progress_at as string | undefined) ?? sqlNow());
  }
  emit("job", id);
}

/** How far a job got after applying, from its log plus its current progress. */
export function progressReached(jobId: number, current: Progress | null) {
  const seen = new Set(all<{ progress: string }>("SELECT progress FROM progress_log WHERE job_id = ?", jobId).map((r) => r.progress));
  if (current) seen.add(current);
  return seen;
}

export function progressLog(jobId: number) {
  return all<{ progress: Progress; ts: string }>("SELECT progress, ts FROM progress_log WHERE job_id = ? ORDER BY ts, id", jobId);
}

/** Days since a stored UTC time. */
export function daysSinceSql(t: string) {
  const d = new Date(`${t.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : (Date.now() - d.getTime()) / 86_400_000;
}

export function listJobs() {
  return all<JobRow>("SELECT * FROM jobs ORDER BY id DESC");
}

/** Hooks so jobs.ts doesn't import tailor/agent (they import jobs.ts). */
export const pipelineHooks: { afterParse?: (id: number) => void } = {};

/** A link reduced to what identifies the posting: no tracking parameters, fragment, www or trailing slash. */
export function normalizeUrl(raw: string) {
  try {
    const u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|refid$|trk|trackingid$|src$|source$|gh_src$|lever-(source|origin)|fbclid$|gclid$|mc_|_hs|origin$)/i.test(k)) u.searchParams.delete(k);
    }
    u.searchParams.sort();
    const q = u.searchParams.toString();
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${q ? `?${q}` : ""}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function addJobs(input: { urls: string[]; jdText?: string; autoApply: boolean }) {
  const ids: number[] = [];
  const duplicates: Array<{ url: string; id: number }> = [];
  const known = new Map<string, number>();
  for (const j of all<{ id: number; url: string }>("SELECT id, url FROM jobs WHERE url != ''")) known.set(normalizeUrl(j.url), j.id);
  const urls = input.urls.map((u) => u.trim()).filter(Boolean);
  for (const raw of urls) {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const key = normalizeUrl(url);
    const dup = known.get(key);
    if (dup !== undefined) {
      if (!duplicates.some((d) => d.id === dup)) duplicates.push({ url, id: dup });
      continue;
    }
    const { id } = run(
      "INSERT INTO jobs (url, jd_text, auto_apply) VALUES (?, ?, ?)",
      url,
      urls.length === 1 && input.jdText ? input.jdText : null,
      input.autoApply ? 1 : 0,
    );
    ids.push(id);
    known.set(key, id);
    queueParse(id);
  }
  if (!urls.length && input.jdText) {
    const { id } = run("INSERT INTO jobs (url, jd_text, auto_apply) VALUES ('', ?, 0)", input.jdText);
    ids.push(id);
    queueParse(id);
  }
  emit("job");
  return { ids, duplicates };
}

export function queueParse(id: number) {
  setJob(id, { busy: "parsing", error: null, notice: null });
  bgQueue.push(async () => {
    try {
      await parseJob(id);
      // Only the first read hands off to tailoring and applying. Re-reading a posting refreshes it and
      // the fit; before this check it re-tailored and started a second application on a submitted job.
      const j = getJob(id);
      if (j?.auto_apply && j.stage !== "applied" && !get("SELECT 1 AS x FROM runs WHERE job_id = ?", id)) pipelineHooks.afterParse?.(id);
    } catch (e) {
      setJob(id, { busy: null, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

const LOGIN_WALL = /sign in to (view|see|continue)|log in to (view|continue)|join now to see|登录后查看|请先登录|扫码登录/i;

async function readPage(page: Page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
  // Wait until the text stops growing: single-page sites (MyCareersFuture) fill the posting in after
  // load, and a fixed 2.5 s caught only its header.
  let last = -1;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(i ? 1000 : 1500);
    const n = await page.evaluate(() => document.body?.innerText.length ?? 0).catch(() => 0);
    if (n === last && n > 600) break;
    last = n;
  }
  const parts: string[] = [];
  for (const frame of page.frames()) {
    try {
      const t = await frame.evaluate(() => (document.body?.innerText ?? "").trim());
      if (t.length > 40) parts.push(t);
    } catch {
      /* detached or cross-process frame */
    }
  }
  const title = await page.title().catch(() => "");
  return { title, text: parts.join("\n\n").replace(/\n{3,}/g, "\n\n").slice(0, 24_000) };
}

export async function fetchPostingText(url: string) {
  const mcf = await mcfPostingText(url);
  if (mcf) return mcf;
  const site = siteFor(url);
  // JobStreet, Glassdoor and Indeed show a headless browser a bot check, so they go straight to the
  // assistant's own window, where you are signed in.
  if (!site?.visibleOnly) {
    const browser = await getHeadless();
    const page = await browser.newPage({ locale: "en-US" });
    let got = { title: "", text: "" };
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      got = await readPage(page);
    } catch {
      /* fall through to the visible browser */
    } finally {
      await page.close();
    }
    if (got.text.length >= 600 && !LOGIN_WALL.test(got.text.slice(0, 3000)) && !isCheckPage(got.title, got.text)) return got;
  }
  // Sites that need a signed-in session: read it in a tab of your own browser (where you're signed in).
  const vis = await newVisiblePage(url);
  let keep = false;
  try {
    const got = await readPage(vis);
    const name = site?.name ?? "这个网站";
    // Never save a check page or a sign-in wall as the posting. The tab stays open for you to deal with.
    if (isCheckPage(got.title, got.text)) {
      keep = true;
      throw new Error(`${name}打开时出现了人机验证：浏览器里已经开着这个岗位的标签页，你自己过一下验证，再点「重新读取岗位」。`);
    }
    if (LOGIN_WALL.test(got.text.slice(0, 3000))) {
      keep = true;
      throw new Error(`${name}要先登录才能看：在浏览器里开着的那个标签页上登录后，再点「重新读取岗位」。`);
    }
    return got;
  } finally {
    if (keep) await vis.bringToFront().catch(() => {});
    else await vis.close().catch(() => {});
  }
}

const EXTRACT_SYSTEM = `You read job postings. Return JSON with exactly these keys:
{"title": string, "company": string, "location": string,
 "summary": string (2-3 sentences in Simplified Chinese: what the role does and who it wants),
 "requirements": string[] (must-haves, short, in the posting's language),
 "niceToHave": string[],
 "keywords": string[] (8-20 concrete skills/tools/domains a recruiter or ATS would scan for, as written in the posting),
 "language": "en" | "zh" (language of the posting),
 "closed": boolean (true only if the page says the job is closed / no longer accepting applications),
 "facts": {"type": "fulltime"|"parttime"|"internship"|"contract"|"unknown",
   "hours": "full"|"part"|"" (internships and contracts: full-time or part-time hours, e.g. "at least 4 days a week" is full; "" if not stated),
   "months": number|null (internship or contract length in months),
   "start": string (start date as written, "" if not stated),
   "minYears": number|null (minimum years of work experience required; 0 if it says no experience needed or fresh graduates welcome; null if not stated),
   "degree": "none"|"diploma"|"bachelor"|"master"|"phd"|"" (minimum education required),
   "student": "enrolled"|"graduated"|"" ("enrolled" if applicants must be current students; "graduated" if they must already hold the qualification, e.g. "graduated within the last 2 years", "2024-2026 graduates"),
   "workAuth": "citizen"|"citizen_pr"|"" (open only to Singapore citizens / only to citizens and PRs; "" if not restricted),
   "salary": string (as written, "" if none),
   "materials": array of "cover_letter"|"transcript"|"portfolio"|"references"|"other" (documents applicants are asked to send besides the resume/CV; [] if none mentioned),
   "coverLetterAsk": string (what the posting wants the cover letter to address, in the posting's language; "" if nothing specific),
   "workplace": "onsite"|"hybrid"|"remote"|""},
 "fit": {"score": integer 0-100, "verdict": string, "strengths": string[], "gaps": string[], "conflict": "fulltime_internship"|"start_date"|"graduates_only"|"work_auth"|""} | null}
"facts" come only from the posting text: never guess; use ""/null/[] when it does not say.
"fit" compares the posting with CANDIDATE. Be strict and honest, like a recruiter screening: score how well the candidate meets the MUST-haves (level, years of experience, degree, required skills, work authorization if stated); nice-to-haves only move it a little. A student applying to a role that requires several years of experience scores low. verdict: one sentence in Simplified Chinese on whether it is worth applying. strengths/gaps: up to 4 short points each in Simplified Chinese, citing concrete items from the posting and the candidate. A strength may only name skills, tools and experience written in CANDIDATE; something the posting wants that CANDIDATE does not mention is a gap, never a strength, and it must not raise the score. Use null if there is no candidate profile.
When CANDIDATE includes WHAT THE CANDIDATE IS LOOKING FOR, also check the posting against it, and judge internships and full-time jobs separately:
- Internship: if the candidate wants part-time internships, an internship with full-time hours (full-time, 5 days a week, 40 hours) is a clear conflict however well the dates fit: it goes first in gaps, the verdict must not call it a match with what they want, and the score is 45 or lower. An internship for enrolled students that starts after their graduation date is a conflict too. If the hours are not stated, say in gaps that the hours need checking, without lowering the score much.
- Full-time job: one they would start after graduating. Graduating later is not a conflict unless the posting states a start date before the graduation date or requires the degree to be completed already. A wish for part-time internships is about internships only and never lowers a full-time job's score.
Other clear conflicts (a STATED start date before they can start, a role only for people who have already graduated) also go first in gaps and lower the score a lot. Something the posting does not state is not a conflict.
"conflict": the kind of clear conflict, or "" if none. Only these count: "fulltime_internship" (an internship whose posting states full-time hours, when the candidate wants part-time internships), "start_date" (a start date the posting STATES that the candidate cannot meet: before they can start, or after their graduation for an internship that needs enrolled students), "graduates_only" (only for people who already hold the qualification), "work_auth" (limited to citizens or PR and CANDIDATE is neither). Still studying and graduating later is never a conflict for a full-time job. A conflict caps the score at ${FIT_CONFLICT_CAP}.
If the text is not a job posting, return title "", fit null, and explain in summary.`;

// Saved answers that say what the candidate is after, given to the fit check. Before this, a
// 6-month full-time internship scored 82 for someone looking for full-time jobs and part-time
// internships, because the score only saw skills.
const PREF_IDS = ["qa_jobtype", "qa_grad", "qa_start", "qa_dur", "qa_auth", "qa_visa"];
export function searchPrefs(p: Profile): string {
  const lines = PREF_IDS.map((id) => p.answers.find((a) => a.id === id)).filter((a) => a && a.a.trim()).map((a) => `- ${a!.q}: ${a!.a.trim()}`);
  return lines.length ? `WHAT THE CANDIDATE IS LOOKING FOR\n${lines.join("\n")}` : "";
}

// Job sites print far more than the posting. LinkedIn's signed-out page wraps a 2,000–5,000 character posting in
// sign-in chrome, "Similar jobs" and "People also viewed": stored, it was 24,000 characters, and reading postings was
// three quarters of the DeepSeek bill (2026-11-13). MyCareersFuture's old page dumps carry a cookie banner and footer.
const LINKEDIN_TAIL = /^(?:Referrals increase your chances\b.*|Get notified about new .*|Sign in to create job alert|Similar jobs|Show more jobs like this|People also viewed|Similar Searches|Explore top content on LinkedIn.*|Looking for a job\?)\s*$/m;
const LINKEDIN_NOISE =
  /^(?:Skip to main content|LinkedIn|Jobs|Clear text|Sign in|Join now|Apply|Save|Show more|Show less|See who you know|Report this job|Use AI to assess how you fit|Get AI-powered advice on this job and more exclusive features\.|Am I a good fit for this job\?|Tailor my resume|See who .+ has hired for this role|Direct message the job poster from .+)$/;
const MCF_HEAD = "The machine translation for this job description is powered by Microsoft Translator.";
const MCF_TAIL = /^(?:More jobs from this company|Log in to Apply|A collaboration between)\s*$/m;
const MCF_NOISE =
  /^(?:See how you compare with other applicants|Log in to view|Tell employers what skills you have|The more skills you have, the better your job match\.|\d+% skills matched|Add these skills if you have them|Report issue|BETA|NEW!)$/;

/** The posting without the site around it, so the model is paid to read the posting only. Other sites' text comes back as it was. */
export function trimPosting(text: string, url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* pasted text without a link */
  }
  const cut = (t: string, tail: RegExp, noise: RegExp) => {
    const end = t.search(tail);
    return (end > 0 ? t.slice(0, end) : t)
      .split("\n")
      .filter((l) => !noise.test(l.trim()))
      .join("\n");
  };
  let t = text;
  if (/(^|\.)linkedin\.com$/.test(host)) t = cut(t, LINKEDIN_TAIL, LINKEDIN_NOISE);
  else if (/(^|\.)mycareersfuture\.gov\.sg$/.test(host) && t.includes(MCF_HEAD)) t = cut(t.slice(t.indexOf(MCF_HEAD) + MCF_HEAD.length), MCF_TAIL, MCF_NOISE);
  else return text;
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function parseJob(id: number) {
  if (!getJob(id)) return;
  const ready = llmReady();
  if (!ready.ok) throw new Error(ready.reason);
  const p = await readPrompt(id);
  const { job, text, pageTitle, profile } = p;
  const src = createHash("sha256").update(`${getSettings().model}\n${p.system}\n${p.input}`).digest("hex").slice(0, 20);
  const prev = jobJd(job);
  let jd: JobJd;
  if (isDemo()) {
    jd = mockExtractJob(text, job.url, pageTitle);
    jd.fit = profile.sections.length ? mockFit(jd, profile) : null;
  } else if (prev?.src === src) {
    // Re-reading a job whose posting, profile and prompt are all unchanged would pay for the same answer
    // again (three bulk re-reads were most of the 2026-11-13 bill). Its checks already ran on the same profile.
    jd = prev;
  } else {
    jd = normalizeJd(await chatJson<JobJd>(p.system, p.input, 4096, { jobId: id, kind: "parse" }));
    jd.src = src;
  }
  saveReading(id, p, jd, prev);
}

/**
 * Skill mode: an AI assistant (Claude Code, Codex…) answered the reading prompt from `readPrompt` itself.
 * Its answer goes through the same normalising and fit checks as the app's own DeepSeek call.
 */
export async function saveSkillReading(id: number, raw: unknown) {
  if (!getJob(id)) throw new Error("岗位不存在");
  if (!raw || typeof raw !== "object") throw new Error("要一个 JSON 对象（按读取提示词里的格式）");
  const p = await readPrompt(id);
  const jd = normalizeJd(raw);
  if (!jd.title && !jd.requirements.length) throw new Error("JSON 里没有岗位内容：至少要有 title 和 requirements");
  saveReading(id, p, jd, null);
  return jd;
}

type ReadPrompt = Awaited<ReturnType<typeof readPrompt>>;

/** What reading a job sends to the model; in skill mode it is handed to the AI assistant instead. */
export async function readPrompt(id: number) {
  const job = getJob(id);
  if (!job) throw new Error("岗位不存在");
  let text = job.jd_text ?? "";
  let pageTitle = "";
  if (!text && job.url) {
    const got = await fetchPostingText(job.url);
    text = got.text;
    pageTitle = got.title;
  }
  // Stored as trimmed too, so tailoring and interview prep read the same short text.
  text = trimPosting(text, job.url);
  if (text.trim().length < 80) throw new Error("没读到岗位内容：页面可能要登录，在你的浏览器里登录该网站后再点「重新读取岗位」，或直接粘贴 JD 文本。");

  const profile = getProfile();
  const prefs = searchPrefs(profile);
  const candidate = profile.sections.length ? `${profileForPrompt(profile, { withIds: false })}\n\nEXTRA FACTS\n${profile.extraFacts || "(none)"}${prefs ? `\n\n${prefs}` : ""}` : "(no profile yet)";
  // CANDIDATE goes first: it is the same for every job, so after the first read DeepSeek serves the system
  // prompt and the profile from its cache (billed at about a tenth) and only the posting is new.
  const input = `CANDIDATE\n${candidate}\n\nURL: ${job.url}\nPage title: ${pageTitle}\n\nPOSTING\n${text.slice(0, 12_000)}`;
  return { job, text, pageTitle, profile, prefs, system: EXTRACT_SYSTEM, input };
}

/** Saves a reading of the job, whoever produced it (DeepSeek, demo mode, or an AI assistant in skill mode). */
function saveReading(id: number, p: ReadPrompt, jd: JobJd, prev: JobJd | null) {
  const { job, text, pageTitle, profile, prefs } = p;
  if (jd !== prev) {
    if (jd.fit && profile.sections.length) jd.fit = checkFit(jd.fit, profileText(profile), jd.keywords);
    jd.fit = capForPrefs(jd.fit, jd.facts, prefs);
  }

  setJob(id, {
    jd_text: text,
    jd: JSON.stringify(jd),
    title: jd.title || pageTitle || null,
    company: jd.company || null,
    location: jd.location || null,
    stage: job.stage === "new" ? "parsed" : job.stage,
    busy: null,
    error: jd.closed ? "页面显示这个岗位已关闭" : null,
  });
}

function normalizeJd(raw: any): JobJd {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const a = (v: unknown) => (Array.isArray(v) ? v.map(s).filter(Boolean) : []);
  return {
    title: s(raw?.title),
    company: s(raw?.company),
    location: s(raw?.location),
    summary: s(raw?.summary),
    requirements: a(raw?.requirements),
    niceToHave: a(raw?.niceToHave),
    keywords: [...new Set(a(raw?.keywords))].slice(0, 25),
    language: raw?.language === "zh" ? "zh" : "en",
    closed: raw?.closed === true,
    fit: normalizeFit(raw?.fit, normalizeFacts(raw?.facts)),
    facts: normalizeFacts(raw?.facts),
  };
}

export function normalizeFacts(raw: any): JobFacts | null {
  if (!raw || typeof raw !== "object") return null;
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const one = <T extends string>(v: unknown, ok: readonly T[], dflt: T | "" = ""): T | "" => (ok.includes(v as T) ? (v as T) : dflt);
  const num = (v: unknown, max: number) => {
    const n = typeof v === "string" && v.trim() ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 10) / 10 : null;
  };
  return {
    type: (one(raw.type, ["fulltime", "parttime", "internship", "contract", "unknown"] as const) || "unknown") as JobFacts["type"],
    hours: one(raw.hours, ["full", "part"] as const),
    months: num(raw.months, 60),
    start: s(raw.start).slice(0, 60),
    minYears: num(raw.minYears, 30),
    degree: one(raw.degree, ["none", "diploma", "bachelor", "master", "phd"] as const),
    student: one(raw.student, ["enrolled", "graduated"] as const),
    workAuth: one(raw.workAuth, ["citizen", "citizen_pr"] as const),
    salary: s(raw.salary).slice(0, 80),
    materials: [...new Set<Material>((Array.isArray(raw.materials) ? raw.materials : []).filter((m: unknown): m is Material => MATERIALS.includes(m as Material)))],
    coverLetterAsk: s(raw.coverLetterAsk).slice(0, 400),
    workplace: one(raw.workplace, ["onsite", "hybrid", "remote"] as const),
  };
}

/** The conflicts that cap a fit, each with the posting condition that must back it up. */
const CONFLICTS: Record<string, { label: string; backed: (f: JobFacts) => boolean }> = {
  fulltime_internship: { label: "全职实习，和你想找的兼职实习不符", backed: (f) => f.type === "internship" && f.hours === "full" },
  start_date: { label: "开始时间对不上你的时间", backed: (f) => !!f.start },
  graduates_only: { label: "只招已经毕业的", backed: (f) => f.student === "graduated" },
  work_auth: { label: "只招公民 / PR", backed: (f) => !!f.workAuth },
};

/** Their wishes name part-time internships and do not also accept full-time ones. */
export const wantsPartTimeInternsOnly = (prefs: string) => /part[- ]?time intern|兼职实习/i.test(prefs) && !/full[- ]?time intern|全职实习/i.test(prefs);

/** A full-time internship for someone who wants part-time ones is a clash the posting's stated hours settle on their own;
 *  the model left it out on about a third of them (2026-11-13), so it is added here. */
export function capForPrefs(fit: Fit | null, facts: JobFacts | null, prefs: string): Fit | null {
  if (!fit || fit.conflict || !facts || !wantsPartTimeInternsOnly(prefs) || !CONFLICTS.fulltime_internship.backed(facts)) return fit;
  return { ...fit, conflict: CONFLICTS.fulltime_internship.label, score: Math.min(fit.score, FIT_CONFLICT_CAP) };
}

export function normalizeFit(raw: any, facts: JobFacts | null): Fit | null {
  const score = Number(raw?.score);
  if (!raw || !Number.isFinite(score)) return null;
  const a = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()).slice(0, 5) : []);
  // The model names a clash but does not always lower the score for it (a full-time internship scored 78 for
  // someone who wants part-time ones, 2026-11-13), so the cap is applied here. Asked for a free-text clash, it also
  // made some up ("not graduated yet" on full-time jobs), so it picks a kind and the posting's own conditions
  // (extracted in the same answer) must back it up.
  const kind = CONFLICTS[typeof raw.conflict === "string" ? raw.conflict.trim() : ""];
  const conflict = kind && facts && kind.backed(facts) ? kind.label : "";
  return {
    score: Math.max(0, Math.min(conflict ? FIT_CONFLICT_CAP : 100, Math.round(score))),
    verdict: typeof raw.verdict === "string" ? raw.verdict.trim() : "",
    strengths: a(raw.strengths),
    gaps: a(raw.gaps),
    ...(conflict && { conflict }),
  };
}

/** Marks strengths that credit the candidate with a tool the profile never mentions. */
export function checkFit(fit: Fit, profile: string, keywords: string[]): Fit {
  const unsupported = new Set<string>();
  const strengths = fit.strengths.map((st) => {
    const missing = unsupportedTerms(st, profile, keywords);
    missing.forEach((t) => unsupported.add(t));
    return missing.length ? `${st}（资料库里没找到：${missing.join("、")}）` : st;
  });
  return { ...fit, strengths, unsupported: [...unsupported] };
}

export function jobJd(job: JobRow): JobJd | null {
  const jd = parseJson<JobJd | null>(job.jd, null);
  if (jd && jd.fit === undefined) jd.fit = null;
  if (jd && jd.facts === undefined) jd.facts = null;
  return jd;
}
