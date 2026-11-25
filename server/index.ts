import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { FILES_DIR, parseJson, run, SHOTS_DIR, sqlNow } from "./db.ts";
import { addClient, emit } from "./events.ts";
import { getSettings, publicSettings, saveSettings, type Settings } from "./settings.ts";
import { COMMON_QUESTIONS, getProfile, newId, normalizeProfile, pdfText, saveProfile } from "./profile.ts";
import { addJobs, getJob, jobJd, listJobs, pipelineHooks, PROGRESS, progressLog, queueParse, setJob, type JobRow, type Progress } from "./jobs.ts";
import { addEvent, deleteEvent, EVENT_LABEL, getEvent, icsFor, listEvents, nextEvent, updateEvent } from "./schedule.ts";
import { DRAFT_KINDS, draftsView, makeDraft, prepState, prepView, queuePrep, type DraftKind } from "./prep.ts";
import { askedQuestions, stats } from "./stats.ts";
import { coverage, profileHas, queueTailor, renderJobFiles, writeCoverLetter, type Tailored } from "./tailor.ts";
import { focusRun, getRun, isLive, listRuns, liveShotName, reply, runSteps, similarity, startRun, type UserReply } from "./agent.ts";
import { browserOpen, browserState, closeAll, EXTENSION_URL, newVisiblePage, reconnect } from "./browser.ts";
import { resumeHtml, type ResumeDoc } from "./render.ts";
import { chatJson, getBalance, isDemo, llmReady, money, setNoBalance } from "./llm.ts";
import { loginSites } from "./sites.ts";
import { searchJobs, type Kind, type Source } from "./discover.ts";
import { AUTH_LABEL, DEGREE_LABEL, MATERIAL_LABEL, typeLabel, yearsLabel } from "../src/reqs.ts";
import { advance, pump, runNow } from "./batch.ts";
import { callRmb, sumRmb, usageRows } from "./cost.ts";

const PORT = Number(process.env.PORT ?? 8791);
const ROOT = path.resolve(import.meta.dirname, "..");
const app = express();

// Only answer requests addressed to this machine, and only accept writes from its own pages:
// the API can submit applications and returns personal data.
app.use((req: Request, res: Response, next: NextFunction) => {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return res.status(403).send("forbidden host");
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        ok = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);
      } catch {
        ok = false;
      }
      if (!ok) return res.status(403).send("forbidden origin");
    }
  }
  next();
});
app.use(express.json({ limit: "4mb" }));

const wrap = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
};
const idOf = (req: Request) => Number(req.params.id);

function jobView(j: JobRow, has: (k: string) => boolean = profileHas(getProfile())) {
  const runs = listRuns({ jobId: j.id });
  const jd = jobJd(j);
  const latest = runs[0];
  const tailored = parseJson<Tailored | null>(j.tailored, null);
  const applied = j.stage === "applied";
  const used = usageRows("WHERE job_id = ?", j.id);
  return {
    id: j.id,
    url: j.url,
    title: j.title,
    company: j.company,
    location: j.location,
    stage: j.stage,
    busy: j.busy,
    held: j.held,
    error: j.error,
    notice: j.notice,
    autoApply: !!j.auto_apply,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    // Jobs applied before tracking existed count as "applied" from their last update.
    progress: (j.progress ?? (applied ? "applied" : null)) as Progress | null,
    progressAt: j.progress_at ?? (applied ? j.updated_at : null),
    appliedAt: j.applied_at ?? (applied ? j.updated_at : null),
    notes: j.notes ?? "",
    jd,
    /** The posting's keywords your profile already mentions (the rest are what you lack). */
    kwHave: jd ? jd.keywords.filter(has) : [],
    hasResume: !!j.resume_file,
    hasCover: !!j.cover_file,
    coverage: tailored?.coverage ?? null,
    warnings: tailored?.warnings.length ?? 0,
    tokens: used.reduce((n, r) => n + r.prompt_tokens + r.completion_tokens, 0),
    /** RMB, priced at the time of each call (an estimate from DeepSeek's price list). */
    cost: sumRmb(used),
    nextEvent: nextEvent(j.id) ?? null,
    hasPrep: !!j.prep,
    run: latest
      ? {
          id: latest.id,
          status: latest.status,
          outcome: latest.outcome,
          steps: latest.steps,
          live: isLive(latest.id),
        }
      : null,
  };
}

/** The run's latest screenshot, with its time so the browser refetches it when it changes. */
function shotOf(runId: number) {
  try {
    const st = fs.statSync(path.join(SHOTS_DIR, liveShotName(runId)));
    return `${liveShotName(runId)}?t=${Math.floor(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

function runView(r: ReturnType<typeof listRuns>[number]) {
  return {
    ...r,
    pending: parseJson(r.pending, null),
    live: isLive(r.id),
    shot: shotOf(r.id),
  };
}

function profileStats() {
  const p = getProfile();
  return {
    basics: !!(p.basics.name && p.basics.email && p.basics.phone),
    sections: p.sections.length,
    bullets: p.sections.reduce((n, s) => n + s.entries.reduce((m, e) => m + e.bullets.length, 0), 0),
    facts: p.extraFacts.trim().length,
    answers: p.answers.length,
    answered: p.answers.filter((a) => a.a.trim()).length,
  };
}

// ---- state & settings
app.get(
  "/api/state",
  wrap(() => ({
    settings: publicSettings(),
    browserOpen: browserOpen(),
    browser: { ...browserState(), extensionUrl: EXTENSION_URL },
    demo: isDemo(),
    llm: llmReady(),
    profile: profileStats(),
    sites: loginSites(),
  })),
);
app.get(
  "/api/usage",
  wrap(() => {
    const sum = (where: string) => {
      const rows = usageRows(where);
      return {
        calls: rows.length,
        input: rows.reduce((n, r) => n + r.prompt_tokens, 0),
        output: rows.reduce((n, r) => n + r.completion_tokens, 0),
        cached: rows.reduce((n, r) => n + r.cache_hit_tokens, 0),
        rmb: sumRmb(rows),
      };
    };
    const kinds = new Map<string, { kind: string; calls: number; tokens: number; rmb: number }>();
    for (const r of usageRows()) {
      const k = kinds.get(r.kind) ?? { kind: r.kind, calls: 0, tokens: 0, rmb: 0 };
      k.calls++;
      k.tokens += r.prompt_tokens + r.completion_tokens;
      k.rmb += callRmb(r);
      kinds.set(r.kind, k);
    }
    return {
      today: sum("WHERE ts >= datetime('now', 'localtime', 'start of day', 'utc')"),
      month: sum("WHERE ts >= datetime('now', 'localtime', 'start of month', 'utc')"),
      total: sum(""),
      byKind: [...kinds.values()].sort((a, b) => b.rmb - a.rmb),
    };
  }),
);
app.get("/api/events", (req, res) => addClient(res));
app.put(
  "/api/settings",
  wrap((req) => {
    const body = req.body as Partial<Settings> & { apiKey?: string };
    const patch: Partial<Settings> = { ...body };
    if (typeof body.apiKey === "string") patch.apiKey = body.apiKey.trim();
    // The extension's status page shows (and its copy button copies) "PLAYWRIGHT_MCP_EXTENSION_TOKEN=…".
    if (typeof body.extensionToken === "string")
      patch.extensionToken = body.extensionToken
        .trim()
        .replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*/, "")
        .replace(/^["']|["']$/g, "");
    if (patch.concurrency !== undefined) patch.concurrency = Math.min(4, Math.max(1, Math.floor(Number(patch.concurrency))));
    if (patch.minFit !== undefined) patch.minFit = Math.min(100, Math.max(0, Math.floor(Number(patch.minFit) || 0)));
    if (patch.maxSteps !== undefined) patch.maxSteps = Math.min(120, Math.max(10, Math.floor(Number(patch.maxSteps))));
    const before = getSettings();
    saveSettings(patch);
    // A different browser or token needs a fresh connection (runs in progress are cancelled).
    const after = getSettings();
    if (after.browserChannel !== before.browserChannel || after.extensionToken !== before.extensionToken) void closeAll();
    // Another key, endpoint or mode: the old "balance used up" no longer says anything.
    if (after.apiKey !== before.apiKey || after.baseUrl !== before.baseUrl || after.llmMode !== before.llmMode) {
      setNoBalance(null);
      void getBalance(true);
    }
    // Turning the off-peak wait off starts whatever was waiting.
    pump();
    emit("settings");
    return publicSettings();
  }),
);
app.get(
  "/api/balance",
  wrap(async () => ({ balance: await getBalance() })),
);
/** "充好了，继续": checks the balance, then retries what stopped on it (reads; batch jobs go on through the off-peak wait). */
app.post(
  "/api/llm/resume",
  wrap(async () => {
    const b = await getBalance(true);
    if (b && !b.available) throw new Error(`DeepSeek 显示余额还是不够（${money(b)}），到账后再点`);
    setNoBalance(null);
    let retried = 0;
    for (const j of listJobs()) {
      if (!j.error || !/余额不足|模型接口 402/.test(j.error) || j.busy) continue;
      setJob(j.id, { error: null });
      if (!j.jd) queueParse(j.id);
      else if (j.auto_apply && j.stage !== "applied" && j.stage !== "skipped") advance(j.id);
      else continue;
      retried++;
    }
    pump();
    return { retried };
  }),
);
app.post(
  "/api/settings/test",
  wrap(async () => {
    const r = await chatJson<{ ok: boolean }>('Reply with JSON {"ok": true}.', "ping", 20, { kind: "test" });
    return { ok: r.ok === true, model: getSettings().model };
  }),
);
app.post(
  "/api/browser/open",
  wrap(async (req) => {
    const url = typeof req.body?.url === "string" && /^https?:\/\//.test(req.body.url) ? req.body.url : undefined;
    if (url) await newVisiblePage(url);
    // Connecting can wait minutes for you to click allow in your browser: answer at once, the
    // status arrives over the event stream.
    else void reconnect().catch(() => {});
    return { ok: true };
  }),
);

// ---- finding jobs: search LinkedIn / MyCareersFuture and list what comes back; adding is a separate step
app.post(
  "/api/discover",
  wrap(async (req) => {
    const b = req.body ?? {};
    const queries = (Array.isArray(b.queries) ? b.queries : [])
      .map((q: unknown) => String(q ?? "").trim())
      .filter(Boolean)
      .slice(0, 8);
    if (!queries.length) throw new Error("至少填一个关键词");
    const kind: Kind = b.kind === "parttime" || b.kind === "internship" ? b.kind : "fulltime";
    const sources = (Array.isArray(b.sources) ? b.sources : []).filter((x: unknown): x is Source => x === "linkedin" || x === "mcf");
    if (!sources.length) throw new Error("至少选一个网站");
    const days = Math.min(30, Math.max(1, Math.round(Number(b.days) || 7)));
    const perQuery = Math.min(50, Math.max(10, Math.round(Number(b.perQuery) || 25)));
    return searchJobs({
      queries,
      kind,
      days,
      sources,
      easyApplyOnly: b.easyApplyOnly !== false,
      perQuery,
      hideSenior: b.hideSenior !== false,
    });
  }),
);

// ---- profile
app.get(
  "/api/profile",
  wrap(() => ({ profile: getProfile(), commonQuestions: COMMON_QUESTIONS })),
);
app.put(
  "/api/profile",
  wrap((req) => {
    const p = saveProfile(normalizeProfile(req.body));
    emit("profile");
    return { profile: p };
  }),
);
app.get("/api/profile/resume.html", (req, res) => {
  const p = getProfile();
  res.type("html").send(resumeHtml(p));
});
app.post(
  "/api/profile/import",
  express.raw({
    type: ["application/pdf", "application/octet-stream"],
    limit: "15mb",
  }),
  wrap(async (req) => {
    if (isDemo()) throw new Error("从 PDF 导入需要模型：先在设置里填 DeepSeek key 并关闭演示模式");
    const ready = llmReady();
    if (!ready.ok) throw new Error(ready.reason);
    const buf = req.body as Buffer;
    if (!buf?.length) throw new Error("没收到文件");
    const text = await pdfText(new Uint8Array(buf));
    if (text.length < 100) throw new Error("PDF 里读不到文字（可能是扫描件）");
    const out = await chatJson<any>(
      `Convert a resume into JSON. Copy text faithfully; do not add, embellish or translate anything.
Shape: {"basics":{"name","firstName","lastName","email","phone","phoneCountryCode","location","linkedin","github","website"},
"summary": string,
"sections":[{"heading": string, "entries":[{"title": string (school/company/organisation/project, bold left), "dates": string, "subtitle": string (degree/role), "location": string, "bullets": string[]}]}],
"skills":[{"label": string, "items": string[]}],
"skillsHeading": string, "skillsPosition": number (index of the section the skills block came before)}
Put the technical skills and languages into "skills", not into "sections". A section that is only a list (e.g. awards) is one entry with empty title and the items as bullets.`,
      text.slice(0, 20_000),
      6000,
      { kind: "import" },
    );
    const cur = getProfile();
    const draft = normalizeProfile({
      ...out,
      extraFacts: cur.extraFacts,
      answers: cur.answers,
    });
    return { profile: draft, text };
  }),
);

// ---- jobs
app.get(
  "/api/jobs",
  wrap(() => {
    const has = profileHas(getProfile());
    return { jobs: listJobs().map((j) => jobView(j, has)) };
  }),
);
app.post(
  "/api/jobs",
  wrap((req) => {
    const urls = (Array.isArray(req.body?.urls) ? req.body.urls : String(req.body?.urls ?? "").split(/\s+/)).map(String);
    const jdText = typeof req.body?.jdText === "string" ? req.body.jdText.trim() : "";
    if (!urls.filter((u: string) => u.trim()).length && !jdText) throw new Error("请粘贴岗位链接或 JD");
    return addJobs({ urls, jdText, autoApply: !!req.body?.autoApply });
  }),
);
/** Everything in the list as a spreadsheet (UTF-8 with BOM so Excel shows Chinese). */
app.get("/api/jobs.csv", (req, res) => {
  const local = (s: string | null) => {
    if (!s) return "";
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
    if (Number.isNaN(d.getTime())) return s;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const STAGE: Record<string, string> = {
    new: "新加入",
    parsed: "已读取",
    tailored: "简历已改好",
    applied: "已投递",
    skipped: "已跳过",
  };
  const PROG: Record<string, string> = {
    applied: "等回音",
    screening: "笔试/测评",
    interview: "面试中",
    offer: "Offer",
    rejected: "未通过",
    withdrawn: "我放弃了",
  };
  const cell = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["岗位", "公司", "地点", "链接", "状态", "进展", "投递时间", "进展更新", "下一个日程", "匹配度", "类型", "经验要求", "学历", "申请限制", "要交的材料", "薪资", "备注", "加入时间"]];
  const has = profileHas(getProfile());
  for (const j of listJobs()) {
    const v = jobView(j, has);
    const f = v.jd?.facts ?? null;
    rows.push([
      v.title ?? "",
      v.company ?? "",
      v.location ?? "",
      v.url,
      STAGE[v.stage] ?? v.stage,
      v.progress ? PROG[v.progress] : "",
      local(v.appliedAt),
      local(v.progressAt),
      v.nextEvent ? `${EVENT_LABEL[v.nextEvent.kind]} ${local(v.nextEvent.at)}` : "",
      v.jd?.fit ? String(v.jd.fit.score) : "",
      f ? typeLabel(f) || "没写" : "",
      f ? (f.minYears === null ? "没写" : yearsLabel(f.minYears)) : "",
      f?.degree ? DEGREE_LABEL[f.degree] : "",
      f ? [f.workAuth && AUTH_LABEL[f.workAuth], f.student === "graduated" && "须已毕业", f.student === "enrolled" && "须在读", v.jd?.closed && "已关闭"].filter(Boolean).join("、") : "",
      f ? f.materials.map((m) => MATERIAL_LABEL[m]).join("、") : "",
      f?.salary ?? "",
      v.notes,
      local(v.createdAt),
    ]);
  }
  const d = new Date();
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="jobs-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.csv"`,
  );
  res.send(String.fromCharCode(0xfeff) + rows.map((r) => r.map(cell).join(",")).join("\r\n"));
});
app.get(
  "/api/jobs/:id",
  wrap((req) => {
    const j = getJob(idOf(req));
    if (!j) throw new Error("岗位不存在");
    const runs = listRuns({ jobId: j.id }).map(runView);
    const profile = getProfile();
    const jd = jobJd(j);
    return {
      job: {
        ...jobView(j),
        jdText: j.jd_text,
        coverLetter: j.cover_letter ?? "",
      },
      tailored: parseJson<Tailored | null>(j.tailored, null),
      runs,
      steps: runs[0] ? runSteps(runs[0].id) : [],
      events: listEvents({ jobId: j.id }),
      log: progressLog(j.id),
      prep: prepView(parseJson(j.prep, null), profile, jd),
      drafts: draftsView(parseJson(j.drafts, {}), profile, jd),
      ...prepState(j.id),
    };
  }),
);
app.patch(
  "/api/jobs/:id",
  wrap((req) => {
    const j = getJob(idOf(req));
    if (!j) throw new Error("岗位不存在");
    const b = req.body ?? {};
    const patch: Record<string, string | number | null> = {};
    if (b.stage === "skipped" || b.stage === "applied") {
      patch.stage = b.stage;
      patch.held = null;
    }
    if (b.stage === "restore") patch.stage = j.tailored ? "tailored" : j.jd ? "parsed" : "new";
    if (typeof b.jdText === "string") patch.jd_text = b.jdText;
    if (typeof b.url === "string") patch.url = b.url.trim();
    if (typeof b.notes === "string") patch.notes = b.notes.slice(0, 5000);
    if (PROGRESS.includes(b.progress)) {
      patch.progress = b.progress;
      patch.progress_at = sqlNow();
      // Recording progress on a job you applied to by hand marks it applied.
      if (j.stage !== "applied") patch.stage = "applied";
    }
    setJob(j.id, patch);
    return jobView(getJob(j.id)!);
  }),
);
app.delete(
  "/api/jobs/:id",
  wrap((req) => {
    const id = idOf(req);
    const runIds = listRuns({ jobId: id }).map((r) => r.id);
    for (const r of listRuns({ jobId: id, active: true })) reply(r.id, { type: "cancel" });
    run("DELETE FROM jobs WHERE id = ?", id);
    // Its PDFs and screenshots go too.
    fs.rmSync(path.join(FILES_DIR, `job-${id}`), {
      recursive: true,
      force: true,
    });
    for (const f of fs.readdirSync(SHOTS_DIR)) if (runIds.some((r) => f.startsWith(`run-${r}-`))) fs.rmSync(path.join(SHOTS_DIR, f), { force: true });
    emit("job", id);
    return { ok: true };
  }),
);
// A button on one job runs now, even while batch work waits for off-peak; it takes the job out of the wait.
app.post(
  "/api/jobs/:id/parse",
  wrap((req) => (setJob(idOf(req), { held: null }), queueParse(idOf(req)), { ok: true })),
);
app.post(
  "/api/jobs/:id/tailor",
  wrap((req) => (setJob(idOf(req), { held: null }), queueTailor(idOf(req)), { ok: true })),
);
app.post(
  "/api/jobs/:id/cover-letter",
  wrap(async (req) => ({ text: (await writeCoverLetter(idOf(req))).text })),
);
app.post(
  "/api/jobs/:id/apply",
  wrap((req) => {
    const runId = startRun(idOf(req));
    setJob(idOf(req), { notice: null, held: null });
    return { runId };
  }),
);
/** Whatever is left for each job: read → tailor → fill (the last two wait for off-peak when that is on). */
app.post(
  "/api/jobs/pipeline",
  wrap((req) => {
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    for (const id of ids) {
      const j = getJob(id);
      if (!j || j.busy || j.held || j.stage === "applied" || j.stage === "skipped") continue;
      // You picked these by hand, so a low fit score does not stop them.
      setJob(id, { auto_apply: 1, notice: null });
      if (!j.jd) queueParse(id);
      else advance(id);
    }
    return { ok: true };
  }),
);
/** "现在就跑" on jobs waiting for off-peak: these ids, or all of them. */
app.post(
  "/api/jobs/run-now",
  wrap((req) => {
    runNow(Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : undefined);
    return { ok: true };
  }),
);
pipelineHooks.afterParse = (id) => {
  const j = getJob(id);
  if (!j) return;
  const jd = jobJd(j);
  if (jd?.closed) return;
  const min = getSettings().minFit;
  if (min > 0 && jd?.fit && jd.fit.score < min) {
    setJob(id, {
      auto_apply: 0,
      notice: `匹配度 ${jd.fit.score}，低于你设的 ${min} 分，所以没有自动改简历和投递`,
    });
    return;
  }
  advance(id);
};
// Held steps start when off-peak begins (and as slots free up); also picks up jobs held before a restart.
setInterval(() => pump(), 10_000);
pump();
app.put(
  "/api/jobs/:id/tailored",
  wrap(async (req) => {
    const j = getJob(idOf(req));
    if (!j) throw new Error("岗位不存在");
    const t = parseJson<Tailored | null>(j.tailored, null);
    if (!t) throw new Error("还没有定制简历");
    const doc = normalizeProfile({
      ...req.body.doc,
      extraFacts: "",
      answers: [],
    });
    const next: Tailored = {
      ...t,
      doc: {
        basics: t.doc.basics,
        summary: doc.summary,
        sections: doc.sections,
        skills: doc.skills,
        skillsHeading: doc.skillsHeading,
        skillsPosition: doc.skillsPosition,
      },
    };
    next.coverage = {
      ...t.coverage,
      after: coverage(next.doc, t.coverage.keywords),
    };
    setJob(j.id, {
      tailored: JSON.stringify(next),
      cover_letter: typeof req.body.coverLetter === "string" ? req.body.coverLetter : j.cover_letter,
    });
    await renderJobFiles(j.id);
    return { ok: true };
  }),
);
app.get("/api/jobs/:id/resume.html", (req, res) => {
  const j = getJob(idOf(req));
  const t = j && parseJson<Tailored | null>(j.tailored, null);
  if (!t) return res.status(404).send("还没有定制简历");
  res.type("html").send(resumeHtml(t.doc as ResumeDoc, t.scale ?? 1));
});
for (const [route, col] of [
  ["resume.pdf", "resume_file"],
  ["cover.pdf", "cover_file"],
] as const) {
  app.get(`/api/jobs/:id/${route}`, (req, res) => {
    const j = getJob(idOf(req));
    const file = j?.[col];
    if (!file || !fs.existsSync(file)) return res.status(404).send("not found");
    res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${path.basename(file)}"`);
    res.sendFile(file);
  });
}

// ---- schedule (interviews, tests, deadlines)
app.get(
  "/api/schedule",
  wrap((req) => ({
    events: listEvents({ upcoming: req.query.upcoming === "1" }),
  })),
);
app.post(
  "/api/jobs/:id/schedule",
  wrap((req) => ({ id: addEvent(idOf(req), req.body ?? {}) })),
);
app.patch(
  "/api/schedule/:id",
  wrap((req) => (updateEvent(idOf(req), req.body ?? {}), { ok: true })),
);
app.delete(
  "/api/schedule/:id",
  wrap((req) => (deleteEvent(idOf(req)), { ok: true })),
);
app.get("/api/schedule/:id/calendar.ics", (req, res) => {
  const ev = getEvent(idOf(req));
  if (!ev) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="event-${ev.id}.ics"`);
  res.send(icsFor(ev));
});

// ---- after applying: interview prep, email drafts, stats
app.post(
  "/api/jobs/:id/prep",
  wrap((req) => (queuePrep(idOf(req)), { ok: true })),
);
app.post(
  "/api/jobs/:id/draft",
  wrap(async (req) => {
    const kind = req.body?.kind as DraftKind;
    if (!DRAFT_KINDS.includes(kind)) throw new Error("bad kind");
    const extra = typeof req.body?.extra === "string" ? req.body.extra.trim().slice(0, 1000) : "";
    return { draft: await makeDraft(idOf(req), kind, extra) };
  }),
);
app.get(
  "/api/stats",
  wrap(() => stats()),
);
app.get(
  "/api/profile/asked",
  wrap(() => ({ asked: askedQuestions(similarity, getProfile().answers) })),
);

// ---- runs
app.get(
  "/api/runs",
  wrap((req) => ({
    runs: listRuns({ active: req.query.active === "1" }).map(runView),
  })),
);
app.get(
  "/api/runs/:id",
  wrap((req) => {
    const r = listRuns().find((x) => x.id === idOf(req));
    if (!r) throw new Error("没有这条记录");
    return { run: runView(r), steps: runSteps(r.id) };
  }),
);
app.post(
  "/api/runs/:id/reply",
  wrap((req) => {
    const body = req.body as UserReply;
    if (!["answer", "resume", "confirm", "revise", "cancel"].includes(body?.type)) throw new Error("bad reply");
    const r = getRun(idOf(req));
    if (!r) throw new Error("没有这条记录");
    if (body.type === "confirm" && r.status !== "awaiting_confirm") throw new Error("这份申请现在不在等确认");
    if (!reply(r.id, body)) throw new Error("这次填写已经结束了");
    return { ok: true };
  }),
);
app.post(
  "/api/runs/:id/focus",
  wrap(async (req) => ({ ok: await focusRun(idOf(req)) })),
);
app.get("/api/shots/:name", (req, res) => {
  const name = String(req.params.name);
  if (!/^[\w.-]+$/.test(name)) return res.status(400).end();
  const file = path.join(SHOTS_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

// ---- profile helpers for the UI
app.post(
  "/api/profile/answers",
  wrap((req) => {
    const p = getProfile();
    const q = String(req.body?.q ?? "").trim();
    if (!q) throw new Error("问题不能为空");
    p.answers.push({ id: newId("qa"), q, a: String(req.body?.a ?? "") });
    saveProfile(p);
    emit("profile");
    return { profile: p };
  }),
);

// ---- static: the test job pages and, in production, the built UI
app.use("/fixtures", express.static(path.join(ROOT, "fixtures")));
const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(PORT, "127.0.0.1", () => {
  console.log(`resume-agent API on http://127.0.0.1:${PORT}${fs.existsSync(dist) ? " (serving the built UI)" : ""}`);
  // Know about an empty balance before the first job runs into it (the balance endpoint is free).
  void getBalance(true);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void closeAll().finally(() => process.exit(0));
  });
}
