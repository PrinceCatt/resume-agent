// The application agent: looks at the page, asks the model what to do, does it, repeats.
// It never clicks a final submit on its own: it stops at request_submit and waits for you.
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { all, get, parseJson, run, SHOTS_DIR } from "./db.ts";
import { emit } from "./events.ts";
import { getJob, jobJd, setJob, type JobRow } from "./jobs.ts";
import { getProfile, newId, profileForPrompt, saveProfile, type Profile } from "./profile.ts";
import { chat, isDemo, llmReady, type Message, type ToolCall, type ToolDef } from "./llm.ts";
import { getSettings } from "./settings.ts";
import { makeQueue } from "./tasks.ts";
import { newVisiblePage, onBrowserClosed } from "./browser.ts";
import { DELTA_MARK, formatDelta, formatObs, locate, observe, type El, type Obs } from "./observe.ts";
import { renderJobFiles, renderMasterFiles, writeCoverLetter, type Tailored } from "./tailor.ts";
import { mockDecide, newMockMemory, type MockMemory } from "./mock.ts";
import { isCheckPage, siteFor } from "./sites.ts";

export type ReviewField = { label: string; value: string };
export type Pending =
  | { kind: "ask"; question: string; field: string }
  | { kind: "manual"; reason: string }
  | { kind: "review"; summary: string; fields: ReviewField[]; screenshot: string; targetText: string; url: string };

export type UserReply =
  | { type: "answer"; answer: string; remember: boolean }
  | { type: "resume" }
  | { type: "confirm" }
  | { type: "revise"; feedback: string }
  | { type: "cancel" };

export type RunRow = {
  id: number;
  job_id: number;
  status: string;
  pending: string | null;
  outcome: string | null;
  steps: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type Live = {
  page: Page | null;
  /** Set once the run has had to bring its tab to the front (noted in the log the first time). */
  broughtFront?: boolean;
  /** Every tab this run opened in your browser (its own tab and the apply popups), closed together when it is done. */
  tabs: Page[];
  waiter: ((r: UserReply) => void) | null;
  cancelled: boolean;
  filled: number;
  submitClicked: boolean;
  mock: MockMemory;
};

class Cancelled extends Error {}
class BrowserGone extends Error {}

const live = new Map<number, Live>();
const runQueue = makeQueue(() => getSettings().concurrency);

// A restart loses the browser tabs, so anything that was mid-flight is over.
run(
  "UPDATE runs SET status = 'interrupted', pending = NULL, outcome = COALESCE(outcome, '程序重启，这次填写中断了'), finished_at = datetime('now') WHERE status IN ('queued','running','need_user','awaiting_confirm')",
);

onBrowserClosed(() => {
  for (const [id, l] of live) {
    l.cancelled = true;
    l.waiter?.({ type: "cancel" });
    addStep(id, "error", "和浏览器的连接断开了（浏览器关掉了、扩展被停用，或在设置里换了浏览器）");
  }
});

export function getRun(id: number) {
  return get<RunRow>("SELECT * FROM runs WHERE id = ?", id);
}

function setRun(id: number, patch: Partial<Record<keyof RunRow, string | number | null>>) {
  const keys = Object.keys(patch);
  run(
    `UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
    ...keys.map((k) => (patch as any)[k] as string | number | null),
    id,
  );
  emit("run", id);
}

function addStep(runId: number, kind: "action" | "ask" | "note" | "error" | "guard" | "model", text: string) {
  run("INSERT INTO run_steps (run_id, kind, text) VALUES (?, ?, ?)", runId, kind, text.slice(0, 1000));
  emit("run", runId);
}

export function runSteps(runId: number) {
  return all<{ id: number; ts: string; kind: string; text: string }>("SELECT id, ts, kind, text FROM run_steps WHERE run_id = ? ORDER BY id", runId);
}

const ACTIVE = ["queued", "running", "need_user", "awaiting_confirm"];

/** Whether a new run would start filling right away instead of waiting in the queue. */
export function runSlotFree() {
  return runQueue.size < Math.max(1, getSettings().concurrency);
}

export function startRun(jobId: number) {
  const ready = llmReady();
  if (!ready.ok) throw new Error(ready.reason);
  const job = getJob(jobId);
  if (!job) throw new Error("岗位不存在");
  if (!job.url) throw new Error("这个岗位没有链接，没法自动投递");
  const existing = get<RunRow>(`SELECT * FROM runs WHERE job_id = ? AND status IN (${ACTIVE.map(() => "?").join(",")})`, jobId, ...ACTIVE);
  if (existing) return existing.id;
  const { id } = run("INSERT INTO runs (job_id) VALUES (?)", jobId);
  live.set(id, { page: null, tabs: [], waiter: null, cancelled: false, filled: 0, submitClicked: false, mock: newMockMemory() });
  emit("run", id);
  runQueue.push(() => execRun(id));
  return id;
}

export function reply(runId: number, r: UserReply) {
  const l = live.get(runId);
  if (!l) return false;
  if (r.type === "cancel") {
    l.cancelled = true;
    if (!l.waiter) {
      // Not waiting on you: it stops at the next step.
      setRun(runId, { status: "cancelled", pending: null, finished_at: new Date().toISOString() });
    }
  }
  if (!l.waiter) return r.type === "cancel";
  const w = l.waiter;
  l.waiter = null;
  w(r);
  return true;
}

export async function focusRun(runId: number) {
  const p = live.get(runId)?.page;
  if (!p || p.isClosed()) return false;
  await p.bringToFront();
  return true;
}

function waitForUser(runId: number, l: Live, status: "need_user" | "awaiting_confirm", pending: Pending): Promise<UserReply> {
  setRun(runId, { status, pending: JSON.stringify(pending) });
  return new Promise<UserReply>((resolve) => {
    l.waiter = resolve;
  }).then((r) => {
    if (r.type === "cancel") throw new Cancelled();
    setRun(runId, { status: "running", pending: null });
    return r;
  });
}

const TOOLS: ToolDef[] = [
  tool("fill", "Type a value into a text input, textarea or editable field (replaces what is there).", {
    id: { type: "string" },
    value: { type: "string" },
  }),
  tool("select", "Choose an option of a native <select> by its visible text.", { id: { type: "string" }, option: { type: "string" } }),
  tool("choose", "For searchable dropdowns/autocomplete (kind=combobox, location/school pickers): types the text and clicks the best matching suggestion.", {
    id: { type: "string" },
    text: { type: "string" },
  }),
  tool("check", "Tick or untick a checkbox, or pick a radio button (checked=true).", { id: { type: "string" }, checked: { type: "boolean" } }),
  tool("click", "Click a button, link or option. Ends the turn (the page may change). Final submit buttons are blocked: use request_submit.", {
    id: { type: "string" },
  }),
  tool("upload", "Attach a file to a file input or to an upload button.", {
    id: { type: "string" },
    file: { type: "string", enum: ["resume", "cover_letter"] },
  }),
  tool("write_cover_letter", "The form asks for a cover letter (upload or text box) and FILES says none is available: writes one from the profile. Returns its text; afterwards upload(file=cover_letter) works.", {}),
  tool("scroll", "Scroll the page to load more content.", { direction: { type: "string", enum: ["down", "up"] } }),
  tool("wait", "Wait for the page (max 10 s).", { seconds: { type: "number" } }),
  tool("goto", "Open a URL in this tab (e.g. the application link found on the page).", { url: { type: "string" } }),
  tool("ask_user", "Ask the candidate for information a REQUIRED field needs that is not in the profile/answers. Question in Simplified Chinese.", {
    question: { type: "string" },
    field_label: { type: "string", description: "The form field's label, verbatim" },
  }),
  tool("need_manual", "Hand over to the human for sign-in, account creation, passwords, verification codes, CAPTCHAs, or when stuck. Reason in Simplified Chinese.", {
    reason: { type: "string" },
  }),
  tool("request_submit", "Everything required is filled: ask the candidate to approve clicking the final submit button.", {
    id: { type: "string", description: "id of the final submit/apply/send button" },
    summary: { type: "string", description: "Simplified Chinese: what was filled, anything uncertain, consent boxes ticked" },
  }),
  tool("finish", "End this application.", {
    outcome: { type: "string", enum: ["submitted", "already_applied", "closed", "failed"] },
    note: { type: "string", description: "Simplified Chinese" },
  }),
];

function tool(name: string, description: string, properties: Record<string, object>): ToolDef {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required: Object.keys(properties) } },
  };
}

function agentSystem(profile: Profile, job: JobRow, tailored: Tailored | null) {
  const jd = jobJd(job);
  const answers = profile.answers.map((a) => `- Q: ${a.q}\n  A: ${a.a.trim() || "(unknown — ask if a required field needs it)"}`).join("\n");
  // Same for every application up to JOB (the date sits there too), so DeepSeek serves the rules and the
  // profile from its cache on the next application as well, not only on the next step.
  return `You fill in a job application form in a real browser on behalf of the candidate below. The candidate approves the final submission; you never submit on your own.

HOW YOU WORK
- Each turn you get a snapshot of the current page: interactive elements with ids like [f0_12], their labels, current values and options. When the page kept its layout, you get only the elements that changed since the last full snapshot; the rest is as that snapshot shows. Act only through the tools, with ids from the LATEST snapshot. Several tools per turn are fine (e.g. fill all simple fields at once); a click ends the turn.
- On a job description page, click the button or link that starts the application (Apply / Easy Apply / Apply now / 申请 / 投递).
- Sign-in, account creation, passwords, verification codes, CAPTCHAs, Singpass, or anything else only the human can do: call need_manual with a short Chinese explanation. Never type passwords. Never try to get around a CAPTCHA.
- If there is a resume/CV upload, upload the resume first: many forms auto-fill from it. Then check and correct the auto-filled values against the profile.
- Fill fields only with facts from CANDIDATE PROFILE and ANSWERS. Never guess or invent (dates, salary, GPA, addresses, ID numbers, referees…).
- "How many years of (work) experience with X": use a saved answer if there is one; otherwise count only the dated jobs, internships and projects in CANDIDATE PROFILE that used X, in whole years rounded DOWN (a few months is 0). Study and coursework are not work experience. Never round up to look better; if you are unsure, ask_user.
- "Have you completed / do you have a <degree or level of education>": Yes only if CANDIDATE PROFILE shows that qualification finished before today. A degree still in progress (graduation date after today) is No, even if it is the level asked about; say "in progress, graduating <date>" where there is a text box for it. A value the site pre-filled or remembered is not evidence either way: check it against the profile like any other value.
- If a REQUIRED field needs something that is not there, call ask_user (Chinese question, field_label = the field's label verbatim). Leave optional fields you have no facts for empty.
- Voluntary demographic questions (gender, race, veteran, disability): use ANSWERS if present, otherwise the "decline / prefer not to say" option.
- Required consent checkboxes (privacy notice, data processing, declaration that the information is accurate) may be ticked; list them in your request_submit summary. Leave optional marketing/newsletter boxes unticked.
- type=date inputs take YYYY-MM-DD. Look for a separate country-code field before typing a phone number.
- Native select → select. Searchable dropdowns and autocompletes (kind=combobox, or a text box that pops suggestions like Location/School) → choose.
- Cover letter: upload the cover_letter file to a cover-letter upload; paste COVER LETTER text into a cover-letter text box. If the form asks for a cover letter (required, or an optional field the posting itself asks for) and none is available, call write_cover_letter, then upload or paste it. Do not write one for an optional field nobody asked for.
- Multi-step forms: complete the step, then click Next / Continue / Review.
- When everything required is filled and only the final submit/send/apply button remains, call request_submit with that button's id and a Chinese summary. The click tool blocks final submits.
- After approval the system clicks it. If the next snapshot shows a confirmation/thank-you message, call finish(outcome="submitted"). If it shows validation errors, fix them and call request_submit again.
- Job closed → finish("closed"). Already applied → finish("already_applied"). Stuck after a few attempts → need_manual explaining the problem in Chinese.

CANDIDATE PROFILE
${profileForPrompt(profile, { withIds: false })}

EXTRA FACTS (true, may be used to answer questions)
${profile.extraFacts || "(none)"}

ANSWERS
${answers || "(none)"}

JOB
${jd?.title ?? job.title ?? ""} at ${jd?.company ?? job.company ?? ""} — ${job.url}
Today is ${new Date().toISOString().slice(0, 10)}.

FILES FOR upload
- resume: ${job.resume_file ? path.basename(job.resume_file) : "not available"}
- cover_letter: ${job.cover_file ? path.basename(job.cover_file) : "not available"}

COVER LETTER TEXT
${job.cover_letter?.trim() || "(none)"}
${tailored?.doc.summary ? `\nRESUME SUMMARY LINE\n${tailored.doc.summary}` : ""}`;
}

const STRONG_SUBMIT = /\bsubmit\b|send application|complete (my )?application|finish application|confirm (and )?(send|apply)|提交|投递|确认申请|发送简历|立即沟通|^send$|^发送$/i;
const STEP_WORDS = /\bnext\b|continue|review|save|search|upload|attach|add|下一步|继续|保存|搜索|上传|添加/i;

/** True when clicking this would plausibly send the application. Errs towards asking you. */
export function isFinalSubmit(el: El, filled: number) {
  const label = `${el.text} ${el.label}`.trim();
  if (STRONG_SUBMIT.test(label)) return true;
  if (filled > 0 && /\bapply\b|申请/i.test(label)) return true;
  if (filled > 0 && el.submitType && !STEP_WORDS.test(label)) return true;
  return false;
}

async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(700);
}

/** Rejects if `p` takes longer than `ms` (the call itself keeps running; its result is ignored). */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    }),
  ]);
}

/**
 * Brings the run's tab to the front if it is hidden. The tab lives in your own browser, and a
 * background tab gets no animation frames: Playwright's clicks then wait forever for the element
 * to be "stable" and a mouse-wheel scroll never returns. A run hung like that for 14 minutes
 * after its tab went to the background. Costs nothing while you are watching the tab.
 */
async function ensureVisible(runId: number, l: Live, page: Page) {
  const state = await within(page.evaluate(() => document.visibilityState), 5000, "visibility check").catch(() => "unknown");
  if (state === "visible") return;
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(400);
  if (!l.broughtFront) {
    l.broughtFront = true;
    addStep(runId, "note", "助手的标签页在后台，已切到前台（后台标签页浏览器会暂停渲染，点击和滚动会卡住）");
  }
}

export function similarity(a: string, b: string) {
  const na = a.toLowerCase().replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/\s+/g, " ").trim();
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (nb.startsWith(na) || na.startsWith(nb)) return 0.9;
  if (nb.includes(na) || na.includes(nb)) return 0.8;
  const ta = new Set(na.split(/[^a-z0-9一-鿿]+/).filter(Boolean));
  const tb = new Set(nb.split(/[^a-z0-9一-鿿]+/).filter(Boolean));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter ? (0.7 * inter) / Math.max(ta.size, tb.size) : 0;
}

export function bestMatch(want: string, options: string[]) {
  let best = -1;
  let score = 0;
  options.forEach((o, i) => {
    const s = similarity(want, o);
    if (s > score) {
      score = s;
      best = i;
    }
  });
  return score >= 0.3 ? best : -1;
}

function reviewFields(obs: Obs): ReviewField[] {
  const out: ReviewField[] = [];
  for (const e of obs.elements) {
    if (e.kind === "button" || e.kind === "link" || e.kind === "option") continue;
    if (e.kind === "radio") {
      if (e.checked) out.push({ label: e.group || "选项", value: e.label });
    } else if (e.kind === "checkbox") {
      if (e.checked) out.push({ label: e.group || "勾选", value: e.label });
    } else if (e.value) out.push({ label: e.label || e.kind, value: e.value });
  }
  return out;
}

async function execRun(runId: number) {
  const l = live.get(runId)!;
  try {
    if (l.cancelled) throw new Cancelled();
    setRun(runId, { status: "running" });
    let job = getJob(getRun(runId)!.job_id)!;
    if (!job.resume_file || !fs.existsSync(job.resume_file)) {
      addStep(runId, "note", job.tailored ? "重新生成简历 PDF" : "还没定制简历，先用资料库原版生成 PDF");
      if (job.tailored) await renderJobFiles(job.id);
      else await renderMasterFiles(job.id);
      job = getJob(job.id)!;
    }
    const settings = getSettings();
    const demo = isDemo();
    const tailored = parseJson<Tailored | null>(job.tailored, null);
    let profile = getProfile();

    const page = await newVisiblePage();
    l.page = page;
    l.tabs.push(page);
    const follow = (p: Page) => {
      p.on("popup", (np) => {
        l.page = np;
        l.tabs.push(np);
        follow(np);
        addStep(runId, "note", "申请页在新标签页打开，已切换过去");
        // Some apply forms (Indeed's) close their tab when done: carry on in the tab that opened it.
        np.on("close", () => {
          if (l.page === np && !p.isClosed()) {
            l.page = p;
            addStep(runId, "note", "那个标签页关掉了，回到原来的页面");
          }
        });
      });
    };
    follow(page);
    addStep(runId, "action", `打开 ${job.url}`);
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 45_000 });

    const messages: Message[] = [{ role: "system", content: agentSystem(profile, job, tailored) }];
    const noted = new Set<string>();
    let base: { obs: Obs; step: number } | null = null;
    // After a turn that scrolled or failed the model may be looking for a button the snapshot left out:
    // the next snapshot lists every ordinary button and link.
    let more = false;
    let idle = 0;
    // Turns in a row that only scrolled or waited (or whose actions all failed).
    let stuck = 0;
    for (let step = 1; step <= settings.maxSteps; step++) {
      if (l.cancelled) throw new Cancelled();
      const pg = l.page!;
      if (pg.isClosed()) throw new BrowserGone();
      await ensureVisible(runId, l, pg);
      await settle(pg);
      await snapshot(runId, pg);
      const obs = await within(observe(pg, more), 30_000, "reading the page").catch(async () => {
        await ensureVisible(runId, l, pg);
        return within(observe(pg, more), 30_000, "reading the page");
      });
      // A bot check ("Just a moment…") is yours to pass; asking the model about it only wastes a step.
      if (isCheckPage(obs.title, obs.excerpt)) {
        const name = siteFor(obs.url)?.name ?? "网站";
        addStep(runId, "ask", `需要你手动处理：${name}在做人机验证`);
        await pg.bringToFront().catch(() => {});
        await waitForUser(runId, l, "need_user", { kind: "manual", reason: `${name}在做人机验证：请在浏览器里助手开的那个标签页上自己完成，然后点「处理好了，继续」。` });
        addStep(runId, "note", "你处理完了，继续");
        continue;
      }
      // What this site's flow usually looks like, the first time one of its pages is open.
      const site = siteFor(obs.url);
      if (site && !noted.has(site.key)) {
        noted.add(site.key);
        messages.push({ role: "user", content: `SITE NOTES — you are now on ${site.name}. Hints from earlier use of this site; the page in front of you wins if it differs.\n${site.playbook}` });
        if (step > 1) addStep(runId, "note", `进入 ${site.name}`);
      }
      // Same layout as the last full snapshot: only what changed, and the full one stays (cached). Otherwise a
      // full snapshot, and the older ones are dropped (they would cost tokens and confuse ids).
      const delta = base ? formatDelta(base.obs, obs, base.step, step) : null;
      if (delta) {
        for (const m of messages) if (m.role === "user" && m.content.startsWith("STEP ") && m.content.includes(DELTA_MARK)) m.content = "(older update omitted)";
        messages.push({ role: "user", content: delta });
      } else {
        for (const m of messages) if (m.role === "user" && m.content.startsWith("STEP ")) m.content = "(older snapshot omitted)";
        messages.push({ role: "user", content: formatObs(obs, step) });
        base = { obs, step };
      }

      let calls: ToolCall[];
      let content = "";
      if (demo) {
        profile = getProfile();
        calls = mockDecide(obs, profile, job, l.mock);
      } else {
        const r = await chat({ messages, tools: TOOLS, maxTokens: 2500, usage: { jobId: job.id, kind: "apply" } });
        calls = r.toolCalls;
        content = r.content;
      }
      if (l.cancelled) throw new Cancelled();
      if (content.trim()) addStep(runId, "model", content.trim());
      if (!calls.length) {
        messages.push({ role: "assistant", content: content || "(no action)" });
        if (++idle >= 3) throw new Error("模型连续几步没有动作");
        messages.push({ role: "user", content: "Use the tools to act. If you are done or stuck, call finish or need_manual." });
        continue;
      }
      idle = 0;
      messages.push({ role: "assistant", content: content || null, tool_calls: calls });

      let endTurn = false;
      let finished: { outcome: string; note: string } | null = null;
      let progressed = false;
      // You may have switched tabs while the model was thinking.
      if (l.page && !l.page.isClosed()) await ensureVisible(runId, l, l.page);
      for (const call of calls) {
        let result: string;
        if (endTurn || finished) result = "Skipped: an earlier action ended this turn; look at the new snapshot.";
        else {
          // Tools that wait for you have no time limit; everything that acts on the page does, so
          // a stuck browser call can't hold the run (and its slot in the queue) forever.
          // Writing a cover letter is a model call plus a PDF, not a page action: it gets no page limit either.
          const waitsForYou = ["ask_user", "need_manual", "request_submit", "finish", "write_cover_letter"].includes(call.function.name);
          const out = waitsForYou
            ? await execTool(runId, l, call, obs, job)
            : await within(execTool(runId, l, call, obs, job), 60_000, call.function.name).catch((e: unknown): ToolOut => {
                if (e instanceof Cancelled || e instanceof BrowserGone) throw e;
                addStep(runId, "error", `${call.function.name} 卡住了 60 秒，跳过`);
                return { result: `ERROR: ${e instanceof Error ? e.message : String(e)}. Look at the new snapshot before trying again.`, endTurn: true };
              });
          result = out.result;
          endTurn = out.endTurn;
          finished = out.finished ?? null;
          if (!["scroll", "wait"].includes(call.function.name) && !result.startsWith("ERROR") && !result.startsWith("BLOCKED")) progressed = true;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      more = calls.some((c) => c.function.name === "scroll") || messages.slice(-calls.length).some((m) => m.role === "tool" && m.content.startsWith("ERROR"));
      // A test run once scrolled 40 times looking for a button the snapshot had dropped.
      stuck = progressed ? 0 : stuck + 1;
      if (stuck >= 8) throw new Error("连续 8 步只在滚动、等待或出错，没有进展，停下了；浏览器里的页面保留着，你可以接手");
      setRun(runId, { steps: step });
      if (finished) {
        const ok = finished.outcome === "submitted" || finished.outcome === "already_applied";
        setRun(runId, {
          status: finished.outcome === "submitted" ? "submitted" : ok ? "finished" : "failed",
          outcome: finished.note || finished.outcome,
          pending: null,
          finished_at: new Date().toISOString(),
        });
        if (ok) setJob(job.id, { stage: "applied" });
        addStep(runId, ok ? "note" : "error", `结束：${finished.outcome}${finished.note ? ` — ${finished.note}` : ""}`);
        if (ok) setTimeout(() => releaseTabs(l.tabs), 4000);
        return;
      }
    }
    throw new Error(`走了 ${settings.maxSteps} 步还没填完，停下了；浏览器里的页面保留着，你可以接手`);
  } catch (e) {
    if (e instanceof Cancelled || l.cancelled) {
      setRun(runId, { status: "cancelled", pending: null, finished_at: new Date().toISOString() });
      addStep(runId, "note", "已放弃这次投递");
      releaseTabs(l.tabs);
    } else {
      // Keep the screen it stopped on: it usually explains the failure.
      if (l.page && !l.page.isClosed()) await snapshot(runId, l.page);
      const msg = e instanceof BrowserGone ? "页面被关掉了" : e instanceof Error ? e.message : String(e);
      setRun(runId, { status: "failed", outcome: msg, pending: null, finished_at: new Date().toISOString() });
      addStep(runId, "error", msg);
    }
  } finally {
    l.waiter = null;
    live.delete(runId);
  }
}

/** The latest view of the run's tab, shown live in the UI and kept afterwards as the last screen. */
export const liveShotName = (runId: number) => `run-${runId}-live.jpg`;
async function snapshot(runId: number, page: Page) {
  await page.screenshot({ path: path.join(SHOTS_DIR, liveShotName(runId)), type: "jpeg", quality: 55, timeout: 5000 }).catch(() => {});
}

/** Closes a finished run's tabs. Only tabs the run opened in your browser, never one of yours. */
function releaseTabs(tabs: Page[]) {
  for (const t of tabs) if (!t.isClosed()) void t.close().catch(() => {});
}

type ToolOut = { result: string; endTurn: boolean; finished?: { outcome: string; note: string } };

async function execTool(runId: number, l: Live, call: ToolCall, obs: Obs, job: JobRow): Promise<ToolOut> {
  const page = l.page!;
  let args: any = {};
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return { result: "ERROR: arguments were not valid JSON", endTurn: false };
  }
  const name = call.function.name;
  const el = typeof args.id === "string" ? obs.elements.find((e) => e.id === args.id) : undefined;
  const loc = typeof args.id === "string" ? locate(page, args.id) : null;
  const needEl = () => {
    if (!el || !loc) return { result: `ERROR: no element [${args.id}] in the latest snapshot`, endTurn: false };
    return null;
  };
  const what = el ? `「${(el.label || el.text || el.group || el.id).slice(0, 50)}」` : "";

  try {
    switch (name) {
      case "fill": {
        const bad = needEl();
        if (bad) return bad;
        const value = String(args.value ?? "");
        if (el!.kind === "file") return { result: "ERROR: this is a file input; use upload", endTurn: false };
        if (el!.kind === "select") return execTool(runId, l, { ...call, function: { name: "select", arguments: JSON.stringify({ id: args.id, option: value }) } }, obs, job);
        await loc!.fill(value, { timeout: 8000 });
        l.filled++;
        addStep(runId, "action", `填写${what}：${value.slice(0, 80)}`);
        return { result: `OK filled ${what || args.id}`, endTurn: false };
      }
      case "select": {
        const bad = needEl();
        if (bad) return bad;
        const opts = await loc!.evaluate((s: any) => Array.from(s.options as ArrayLike<HTMLOptionElement>).map((o) => ({ v: o.value, t: o.text.trim() })));
        const i = bestMatch(String(args.option ?? ""), opts.map((o: { t: string }) => o.t));
        if (i < 0) return { result: `ERROR: no option like "${args.option}". Options: ${opts.map((o: { t: string }) => o.t).slice(0, 60).join(" | ")}`, endTurn: false };
        await loc!.selectOption(opts[i].v, { timeout: 8000 });
        l.filled++;
        addStep(runId, "action", `选择${what}：${opts[i].t}`);
        return { result: `OK selected "${opts[i].t}"`, endTurn: false };
      }
      case "choose": {
        const bad = needEl();
        if (bad) return bad;
        const text = String(args.text ?? "");
        await loc!.click({ timeout: 8000 });
        try {
          await loc!.fill(text, { timeout: 3000 });
        } catch {
          await loc!.pressSequentially(text, { delay: 40, timeout: 8000 });
        }
        await page.waitForTimeout(1200);
        const cands: Array<{ text: string; idx: number; frameIdx: number }> = [];
        const frames = page.frames();
        for (let fi = 0; fi < frames.length; fi++) {
          const found = await frames[fi]
            .evaluate(() => {
              const sel = '[role=option], [class*="select__option"], [class*="Select-option"], .pac-item, li[id*="option"], [class*="autocomplete"] li, [class*="suggestion"]';
              return Array.from(document.querySelectorAll(sel))
                .filter((e) => {
                  const r = e.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                })
                .slice(0, 40)
                .map((e, i) => {
                  e.setAttribute("data-ra-opt", String(i));
                  return (e as HTMLElement).innerText.replace(/\s+/g, " ").trim();
                });
            })
            .catch(() => [] as string[]);
          found.forEach((t, idx) => t && cands.push({ text: t, idx, frameIdx: fi }));
        }
        if (!cands.length) {
          addStep(runId, "action", `输入${what}：${text}（没有出现候选项）`);
          return { result: "Typed the text, but no suggestions appeared. If this is a plain text box the typed value may be enough; otherwise try different wording.", endTurn: false };
        }
        const i = bestMatch(text, cands.map((c) => c.text));
        if (i < 0) {
          return { result: `Typed "${text}". Suggestions shown: ${cands.map((c) => c.text).slice(0, 25).join(" | ")}. Call choose again with the exact suggestion text.`, endTurn: false };
        }
        const c = cands[i];
        await frames[c.frameIdx].locator(`[data-ra-opt="${c.idx}"]`).first().click({ timeout: 6000 });
        l.filled++;
        addStep(runId, "action", `选择${what}：${c.text.slice(0, 80)}`);
        return { result: `OK chose "${c.text}"`, endTurn: false };
      }
      case "check": {
        const bad = needEl();
        if (bad) return bad;
        const want = args.checked !== false;
        try {
          await loc!.setChecked(want, { timeout: 4000 });
        } catch {
          await loc!.evaluate((e: any) => (e.labels?.[0] ?? e).click());
          await page.waitForTimeout(200);
        }
        const now = await loc!.isChecked().catch(() => null);
        if (now !== null && now !== want) return { result: `ERROR: could not ${want ? "tick" : "untick"} it; try clicking its label instead`, endTurn: false };
        l.filled++;
        const label = el!.kind === "radio" ? `${el!.group ? `「${el!.group.slice(0, 40)}」` : ""}选「${el!.label.slice(0, 40)}」` : `${want ? "勾选" : "取消勾选"}${what}`;
        addStep(runId, "action", label);
        return { result: `OK ${want ? "checked" : "unchecked"}`, endTurn: false };
      }
      case "click": {
        const bad = needEl();
        if (bad) return bad;
        if (isFinalSubmit(el!, l.filled)) {
          addStep(runId, "guard", `拦下了对${what}的点击：这像是最终提交，要等你确认`);
          return {
            result: "BLOCKED: this looks like the final submit. Do not click it. If everything required is filled, call request_submit with this id; otherwise finish filling first.",
            endTurn: false,
          };
        }
        await loc!.click({ timeout: 8000 });
        addStep(runId, "action", `点击${what}`);
        await settle(l.page!);
        return { result: "OK clicked", endTurn: true };
      }
      case "upload": {
        const bad = needEl();
        if (bad) return bad;
        const now = getJob(job.id) ?? job; // a cover letter may have been written during this run
        const file = args.file === "cover_letter" ? now.cover_file : now.resume_file;
        if (!file || !fs.existsSync(file))
          return { result: `ERROR: ${args.file} is not available${args.file === "cover_letter" ? "; call write_cover_letter first" : ""}`, endTurn: false };
        // Hand Playwright the bytes, not the path: it then builds the File inside the page. A path
        // goes through CDP's DOM.setFileInputFiles, which your browser refuses to an extension
        // ("Not allowed") unless it was given access to file URLs.
        const payload = { name: path.basename(file), mimeType: "application/pdf", buffer: fs.readFileSync(file) };
        if (el!.kind === "file") await loc!.setInputFiles(payload, { timeout: 8000 });
        else {
          const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8000 }), loc!.click({ timeout: 8000 })]);
          await chooser.setFiles(payload);
        }
        l.filled++;
        addStep(runId, "action", `上传${args.file === "cover_letter" ? "求职信" : "简历"}：${path.basename(file)}`);
        await page.waitForTimeout(2000);
        return { result: `OK attached ${path.basename(file)}. The form may have auto-filled fields from it; check them.`, endTurn: true };
      }
      case "write_cover_letter": {
        addStep(runId, "note", "这个申请要求求职信，按资料库写一封");
        const cl = await writeCoverLetter(job.id);
        addStep(runId, "action", `写好了求职信：${path.basename(cl.file)}${cl.warnings.length ? `（${cl.warnings.join("；")}）` : ""}`);
        return { result: `OK cover letter ready as file "cover_letter" (${path.basename(cl.file)}). Text, for a text box:\n${cl.text}`, endTurn: false };
      }
      case "scroll": {
        const dy = args.direction === "up" ? -900 : 900;
        // The wheel scrolls whatever pane is under the mouse (LinkedIn's job details is its own
        // scroller); if it doesn't come back, scroll the window instead.
        await within(page.mouse.wheel(0, dy), 5000, "scroll").catch(() => page.evaluate((d) => window.scrollBy(0, d), dy));
        await page.waitForTimeout(600);
        return { result: "OK scrolled", endTurn: true };
      }
      case "wait": {
        await page.waitForTimeout(Math.min(10, Math.max(0.5, Number(args.seconds) || 2)) * 1000);
        return { result: "OK waited", endTurn: true };
      }
      case "goto": {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) return { result: "ERROR: only http(s) URLs", endTurn: false };
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        addStep(runId, "action", `打开 ${url}`);
        return { result: "OK opened", endTurn: true };
      }
      case "ask_user": {
        const field = String(args.field_label ?? "").trim();
        const question = String(args.question ?? "").trim() || `「${field}」该填什么？`;
        addStep(runId, "ask", `问你：${question}`);
        const r = await waitForUser(runId, l, "need_user", { kind: "ask", question, field });
        if (r.type !== "answer") return { result: "The user did not answer; leave the field empty if it is optional, otherwise call need_manual.", endTurn: true };
        const answer = r.answer.trim();
        addStep(runId, "note", `你的回答：${answer}${r.remember ? "（已记入资料库）" : ""}`);
        l.mock.answers.set(field || question, answer);
        if (r.remember && answer) {
          const p = getProfile();
          const q = (field || question).replace(/\s*(\*|\(required\)|（必填）)\s*$/i, "").trim();
          const hit = p.answers.find((a) => similarity(a.q, q) >= 0.8);
          if (hit) hit.a = answer;
          else p.answers.push({ id: newId("qa"), q, a: answer });
          saveProfile(p);
          emit("profile");
        }
        return { result: `User answered: ${JSON.stringify(answer)}`, endTurn: true };
      }
      case "need_manual": {
        const reason = String(args.reason ?? "需要你在浏览器里处理一下");
        addStep(runId, "ask", `需要你手动处理：${reason}`);
        await page.bringToFront().catch(() => {});
        await waitForUser(runId, l, "need_user", { kind: "manual", reason });
        addStep(runId, "note", "你处理完了，继续");
        return { result: "The user says they handled it in the browser. Look at the new snapshot.", endTurn: true };
      }
      case "request_submit": {
        const bad = needEl();
        if (bad) return bad;
        const summary = String(args.summary ?? "");
        const shot = `run-${runId}-${Date.now()}.jpg`;
        await page.screenshot({ path: path.join(SHOTS_DIR, shot), fullPage: true, type: "jpeg", quality: 70, timeout: 15_000 }).catch(() =>
          page.screenshot({ path: path.join(SHOTS_DIR, shot), type: "jpeg", quality: 70 }),
        );
        addStep(runId, "ask", `填好了，等你确认提交（按钮${what}）`);
        const r = await waitForUser(runId, l, "awaiting_confirm", {
          kind: "review",
          summary,
          fields: reviewFields(obs),
          screenshot: shot,
          targetText: el!.text || el!.label,
          url: page.url(),
        });
        if (r.type === "revise") {
          addStep(runId, "note", `你要求修改：${r.feedback}`);
          return { result: `Not approved yet. The candidate's feedback: ${JSON.stringify(r.feedback)}. Make the changes, then call request_submit again.`, endTurn: true };
        }
        if (r.type !== "confirm") return { result: "Not approved.", endTurn: true };
        const target = locate(page, args.id);
        if (!target) return { result: "ERROR: the submit button is gone; look at the new snapshot", endTurn: true };
        await target.click({ timeout: 10_000 });
        l.submitClicked = true;
        addStep(runId, "action", `你确认了，已点击${what}`);
        await settle(page);
        await page.waitForTimeout(2500);
        return {
          result: "The candidate approved and the system clicked the submit button. If the new snapshot shows a confirmation, call finish(submitted). If it shows errors, fix them and call request_submit again. If it is another step, continue.",
          endTurn: true,
        };
      }
      case "finish": {
        const outcome = ["submitted", "already_applied", "closed", "failed"].includes(args.outcome) ? args.outcome : "failed";
        let note = String(args.note ?? "");
        if (outcome === "submitted" && !l.submitClicked) note = `${note}（提交按钮不是经确认步骤点的，可能是你在浏览器里自己点的）`;
        return { result: "OK", endTurn: true, finished: { outcome, note } };
      }
      default:
        return { result: `ERROR: unknown tool ${name}`, endTurn: false };
    }
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    if (page.isClosed()) throw new BrowserGone();
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);
    addStep(runId, "error", `${name}${what} 出错：${msg}`);
    return { result: `ERROR: ${msg}`, endTurn: false };
  }
}

export function listRuns(opts: { jobId?: number; active?: boolean } = {}) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.jobId) {
    where.push("r.job_id = ?");
    params.push(opts.jobId);
  }
  if (opts.active) where.push(`r.status IN (${ACTIVE.map((s) => `'${s}'`).join(",")})`);
  return all<RunRow & { job_title: string | null; job_company: string | null; job_url: string }>(
    `SELECT r.*, j.title AS job_title, j.company AS job_company, j.url AS job_url FROM runs r JOIN jobs j ON j.id = r.job_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.id DESC LIMIT 200`,
    ...params,
  );
}

export function isLive(runId: number) {
  return live.has(runId);
}
