#!/usr/bin/env node
// Command line for 投递助手 (resume-agent), used by the Agent Skill in ../SKILL.md.
// Talks to the app running on this computer (default http://127.0.0.1:8791, override with RESUME_AGENT_URL).
// Node 18+, no dependencies. Run `node ra.mjs help` for the commands.
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.RESUME_AGENT_URL ?? "http://127.0.0.1:8791").replace(/\/+$/, "");
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const optNames = new Set(["--out", "--dir", "--text", "--timeout"]);
const args = argv.filter((a, i) => !a.startsWith("--") && !optNames.has(argv[i - 1]));
const [cmd, ...rest] = args;
const asJson = flags.has("--json");

async function api(method, p, body) {
  let res;
  try {
    res = await fetch(BASE + p, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    fail(`连不上投递助手（${BASE}）。先启动它：在项目文件夹里 pnpm serve（或 Windows 上双击 start.cmd）。`);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) fail(data && data.error ? data.error : `${res.status} ${typeof data === "string" ? data.slice(0, 200) : ""}`);
  return data;
}
async function download(p, file) {
  const res = await fetch(BASE + p).catch(() => fail(`连不上投递助手（${BASE}）`));
  if (!res.ok) fail(`${p}: ${res.status}`);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return path.resolve(file);
}
function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}
const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
const idArg = (i = 0) => {
  const n = Number(rest[i]);
  if (!Number.isInteger(n) || n <= 0) fail(`需要一个数字 id（第 ${i + 1} 个参数）`);
  return n;
};
/** A JSON answer from a file, or from stdin with "-". Tolerates ```json fences around it. */
function readJsonArg(i) {
  const src = rest[i];
  if (!src) fail("需要 JSON 文件路径，或用 - 从标准输入读");
  const raw = src === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(src, "utf8");
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(s);
  } catch (e) {
    fail(`不是合法的 JSON：${e.message}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jobLine(j) {
  const fit = j.jd?.fit ? `fit ${String(j.jd.fit.score).padStart(3)}` : "fit   -";
  const state = j.busy ? `[${j.busy}]` : j.held ? `[waits: ${j.held}]` : j.run && ["need_user", "awaiting_confirm"].includes(j.run.status) ? `[run ${j.run.id}: ${j.run.status}]` : "";
  const err = j.error ? `  ! ${j.error}` : "";
  return `#${j.id}  ${j.stage.padEnd(8)} ${fit}  ${j.title ?? j.url}${j.company ? ` @ ${j.company}` : ""} ${state}${err}`;
}

function pendingText(r) {
  const p = r.pending ?? {};
  const head = `run ${r.id} · job #${r.job_id} ${r.job_title ?? ""}${r.job_company ? ` @ ${r.job_company}` : ""} · ${r.status}`;
  if (p.kind === "ask") return `${head}\n  QUESTION: ${p.question}${p.field ? `  (field: ${p.field})` : ""}${p.options?.length ? `\n  options: ${p.options.join(" | ")}` : ""}\n  → node ra.mjs answer ${r.id} "<answer>" [--remember]`;
  if (p.kind === "manual") return `${head}\n  NEEDS THE USER IN THE BROWSER: ${p.reason}\n  → after they are done: node ra.mjs resume ${r.id}`;
  if (p.kind === "review")
    return `${head}\n  READY TO SUBMIT (button: ${p.targetText ?? "?"}) at ${p.url ?? ""}\n  summary: ${p.summary ?? ""}\n${(p.fields ?? []).map((f) => `  - ${f.label}: ${f.value}`).join("\n")}\n  screenshot: node ra.mjs shot ${r.id}\n  → only after the user says yes: node ra.mjs confirm ${r.id} --user-confirmed\n  → to change something: node ra.mjs revise ${r.id} "<what to change>"`;
  return `${head}${r.status === "running" ? " (working…)" : ""}`;
}

const HELP = `投递助手 CLI (resume-agent). App: ${BASE}

Look:
  status                         app, model mode, browser, what waits for the user
  jobs [--all]                   job list (skipped jobs only with --all)
  job <id>                       one job: posting summary, fit, conditions, resume notes, runs
  posting <id>                   the posting text as stored
  profile                        the user's profile (facts the resume and forms may use)
  pending                        applications waiting for the user (questions, manual steps, reviews)
  shot <runId> [--out file]      save the run's latest screenshot (default ./run-<id>.jpg)
  files <id> [--dir d]           save the job's resume / cover letter PDFs
  usage                          model tokens and estimated cost

Add and process with the app's own model (DeepSeek, or its demo mode):
  add <url> [url…] [--auto]      add jobs; --auto also tailors and fills (stops before submit)
  add --text <file>              add a pasted job description
  read <id> | tailor <id>        queue reading / tailoring; then: wait <id>
  wait <id> [--timeout s]        wait until the job is no longer busy

Skill mode — you (the AI assistant) are the model, no DeepSeek key needed:
  read-prompt <id> [--out f]     the exact prompt for reading the job; answer it with ONE JSON object
  save-reading <id> <file|->     save that JSON; the app checks it and scores the fit
  tailor-prompt <id> [--out f]   the exact prompt for tailoring the resume
  save-tailoring <id> <file|->   save that JSON; the source check drops untraceable bullets, then the PDF is made

Apply:
  apply <id>                     the app's agent fills the form in the user's own Edge, stops before submit
  answer <runId> "<text>" [--remember]   answer the agent's question (--remember saves it to the profile)
  resume <runId>                 the user finished a manual step (sign-in, CAPTCHA) in the browser
  revise <runId> "<feedback>"    change something before submitting
  confirm <runId> --user-confirmed   submit — ONLY after the user explicitly said yes to this application
  cancel <runId>                 give up this application
  mark <id> applied|skipped|screening|interview|offer|rejected|withdrawn

Add --json to any look command for raw JSON.`;

switch (cmd) {
  case undefined:
  case "help":
    out(HELP);
    break;

  case "status": {
    const s = await api("GET", "/api/state");
    const { runs } = await api("GET", "/api/runs?active=1");
    if (asJson) {
      out({ state: s, activeRuns: runs });
      break;
    }
    const llm = s.settings.llmMode === "demo" ? "demo mode (rule-based, no model)" : s.settings.hasKey ? `DeepSeek (${s.settings.model})` : "DeepSeek, NO API KEY — use skill mode or ask the user to add a key in Settings";
    out(`app: ${BASE} — ok
model: ${llm}${s.llm && !s.llm.ok ? `\n  ! ${s.llm.reason}` : ""}
browser: ${s.browser?.status ?? "?"}${s.browser?.error ? ` (${s.browser.error})` : ""}
waiting for the user: ${runs.filter((r) => ["need_user", "awaiting_confirm"].includes(r.status)).length} · running: ${runs.filter((r) => ["queued", "running"].includes(r.status)).length}`);
    break;
  }

  case "jobs": {
    const { jobs } = await api("GET", "/api/jobs");
    const list = flags.has("--all") ? jobs : jobs.filter((j) => j.stage !== "skipped");
    if (asJson) out(list);
    else out(list.length ? list.map(jobLine).join("\n") : "(no jobs)");
    break;
  }

  case "job": {
    const d = await api("GET", `/api/jobs/${idArg()}`);
    if (asJson) {
      out(d);
      break;
    }
    const j = d.job;
    const jd = j.jd;
    const lines = [jobLine(j), `url: ${j.url}`];
    if (jd) {
      if (jd.summary) lines.push(`summary: ${jd.summary}`);
      if (jd.requirements?.length) lines.push(`requirements:\n${jd.requirements.map((r) => `  - ${r}`).join("\n")}`);
      if (jd.facts) lines.push(`conditions: ${JSON.stringify(jd.facts)}`);
      if (jd.fit) lines.push(`fit ${jd.fit.score}: ${jd.fit.verdict}${jd.fit.conflict ? `\n  conflict: ${jd.fit.conflict}` : ""}\n  + ${jd.fit.strengths.join("\n  + ")}\n  - ${jd.fit.gaps.join("\n  - ")}${jd.fit.unsupported?.length ? `\n  ? not in profile: ${jd.fit.unsupported.join(", ")}` : ""}`);
    } else lines.push("(not read yet)");
    if (d.tailored) lines.push(`resume: notes: ${(d.tailored.notes ?? []).join(" / ")}${d.tailored.warnings?.length ? `\n  check: ${d.tailored.warnings.join(" / ")}` : ""}`);
    if (d.runs?.length) lines.push(`runs: ${d.runs.map((r) => `${r.id}:${r.status}`).join(", ")}`);
    out(lines.join("\n"));
    break;
  }

  case "posting": {
    const d = await api("GET", `/api/jobs/${idArg()}`);
    out(d.job.jdText ?? "(no posting text stored yet — run read-prompt or read first)");
    break;
  }

  case "profile":
    out(await api("GET", "/api/profile"));
    break;

  case "pending": {
    const { runs } = await api("GET", "/api/runs?active=1");
    if (asJson) out(runs);
    else out(runs.length ? runs.map(pendingText).join("\n\n") : "(nothing waiting)");
    break;
  }

  case "shot": {
    const id = idArg();
    const r = await api("GET", `/api/runs/${id}`);
    const run = r.run ?? r;
    const name = run.pending?.screenshot ?? (run.shot ? run.shot.split("?")[0] : null);
    if (!name) fail("这个申请还没有截图");
    out(await download(`/api/shots/${name}`, opt("--out") ?? `run-${id}.jpg`));
    break;
  }

  case "files": {
    const id = idArg();
    const d = await api("GET", `/api/jobs/${id}`);
    const dir = opt("--dir") ?? ".";
    if (!d.job.hasResume) fail("这个岗位还没有简历 PDF：先改简历（tailor 或 tailor-prompt / save-tailoring）");
    const saved = [await download(`/api/jobs/${id}/resume.pdf`, path.join(dir, `job-${id}-resume.pdf`))];
    if (d.job.hasCover) saved.push(await download(`/api/jobs/${id}/cover.pdf`, path.join(dir, `job-${id}-cover-letter.pdf`)));
    out(saved.join("\n"));
    break;
  }

  case "usage": {
    const u = await api("GET", "/api/usage");
    out(asJson ? u : `today ¥${u.today?.rmb?.toFixed(3) ?? "?"} · month ¥${u.month?.rmb?.toFixed(3) ?? "?"} · total ¥${u.total?.rmb?.toFixed(3) ?? "?"} (estimates; skill-mode work done by you is not counted)`);
    break;
  }

  case "add": {
    const textFile = opt("--text");
    const body = textFile ? { urls: [], jdText: fs.readFileSync(textFile, "utf8"), autoApply: flags.has("--auto") } : { urls: rest, autoApply: flags.has("--auto") };
    if (!textFile && !rest.length) fail("给一个或多个岗位链接，或 --text <文件>");
    const r = await api("POST", "/api/jobs", body);
    out(`added: ${r.ids.map((i) => `#${i}`).join(" ") || "(none)"}${r.duplicates?.length ? `\nalready in the list: ${r.duplicates.map((i) => `#${i}`).join(" ")}` : ""}`);
    break;
  }

  case "read":
  case "tailor": {
    const id = idArg();
    await api("POST", `/api/jobs/${id}/${cmd === "read" ? "parse" : "tailor"}`, {});
    out(`queued ${cmd} for #${id}; follow with: node ra.mjs wait ${id}`);
    break;
  }

  case "wait": {
    const id = idArg();
    const until = Date.now() + Number(opt("--timeout") ?? 180) * 1000;
    let j;
    do {
      j = (await api("GET", `/api/jobs/${id}`)).job;
      if (!j.busy) break;
      await sleep(1500);
    } while (Date.now() < until);
    out(j.busy ? `still ${j.busy} after the timeout` : jobLine(j));
    break;
  }

  case "read-prompt":
  case "tailor-prompt": {
    const id = idArg();
    const p = await api("POST", `/api/skill/jobs/${id}/${cmd}`, {});
    const text = `=== SYSTEM ===\n${p.system}\n\n=== INPUT ===\n${p.input}\n\n=== ANSWER ===\nReply with one JSON object exactly as the system part describes, save it to a file, then run: node ra.mjs ${cmd === "read-prompt" ? "save-reading" : "save-tailoring"} ${id} <file>`;
    const file = opt("--out");
    if (file) {
      fs.writeFileSync(file, asJson ? JSON.stringify(p, null, 2) : text);
      out(path.resolve(file));
    } else out(asJson ? p : text);
    break;
  }

  case "save-reading": {
    const id = idArg();
    const j = await api("POST", `/api/skill/jobs/${id}/read`, readJsonArg(1));
    out(asJson ? j : `saved.\n${jobLine(j)}${j.jd?.fit?.conflict ? `\n  conflict: ${j.jd.fit.conflict}` : ""}${j.jd?.fit?.unsupported?.length ? `\n  the fit credits things not in the profile: ${j.jd.fit.unsupported.join(", ")}` : ""}`);
    break;
  }

  case "save-tailoring": {
    const id = idArg();
    const r = await api("POST", `/api/skill/jobs/${id}/tailor`, readJsonArg(1));
    out(
      asJson
        ? r
        : `saved; PDF made.\nkeywords covered: ${r.coverage?.before?.length ?? 0} → ${r.coverage?.after?.length ?? 0} / ${r.coverage?.keywords?.length ?? 0}\nnotes: ${(r.notes ?? []).join(" / ")}${r.warnings?.length ? `\nCHECK WITH THE USER (the source check flagged these):\n  - ${r.warnings.join("\n  - ")}` : "\nsource check: nothing flagged"}\nresume: ${r.resumeFile}${r.coverFile ? `\ncover letter: ${r.coverFile}` : ""}`,
    );
    break;
  }

  case "apply": {
    const id = idArg();
    const r = await api("POST", `/api/jobs/${id}/apply`, {});
    out(`run ${r.runId} started for #${id}. It stops before the final submit; check with: node ra.mjs pending`);
    break;
  }

  case "answer": {
    const id = idArg();
    const text = rest.slice(1).join(" ").trim();
    if (!text) fail("给出回答文字");
    await api("POST", `/api/runs/${id}/reply`, { type: "answer", answer: text, remember: flags.has("--remember") });
    out(`answered run ${id}`);
    break;
  }

  case "resume":
    await api("POST", `/api/runs/${idArg()}/reply`, { type: "resume" });
    out("continuing");
    break;

  case "revise": {
    const id = idArg();
    const feedback = rest.slice(1).join(" ").trim();
    if (!feedback) fail("说明要改什么");
    await api("POST", `/api/runs/${id}/reply`, { type: "revise", feedback });
    out(`sent to run ${id}`);
    break;
  }

  case "confirm": {
    const id = idArg();
    if (!flags.has("--user-confirmed")) fail("confirm submits a real application. Show the user the review (node ra.mjs pending) and add --user-confirmed only after they said yes.");
    await api("POST", `/api/runs/${id}/reply`, { type: "confirm" });
    out(`run ${id}: submitting; check the result with node ra.mjs pending / job`);
    break;
  }

  case "cancel":
    await api("POST", `/api/runs/${idArg()}/reply`, { type: "cancel" });
    out("cancelled");
    break;

  case "mark": {
    const id = idArg();
    const what = rest[1];
    const progress = ["screening", "interview", "offer", "rejected", "withdrawn"];
    const body = what === "applied" || what === "skipped" ? { stage: what } : progress.includes(what) ? { progress: what } : fail("mark <id> applied|skipped|screening|interview|offer|rejected|withdrawn");
    out(jobLine(await api("PATCH", `/api/jobs/${id}`, body)));
    break;
  }

  default:
    fail(`unknown command "${cmd}". Run: node ra.mjs help`);
}
