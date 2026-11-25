// Batch work (一键处理, and the automatic pipeline after a job is read) can wait for DeepSeek's off-peak
// hours, when every call costs half. Reading a posting never waits: it is cheap, and its fit score is
// what you screen with. Tailoring and form filling are the cost, so while the setting is on their next
// step waits in jobs.held and starts from here — off-peak only, and only when a slot is free, so nothing
// sits in a queue and starts after the next peak has begun. Work already running is never stopped.
import { isPeak } from "../src/offpeak.ts";
import { all } from "./db.ts";
import { runSlotFree, startRun } from "./agent.ts";
import { bgQueue, getJob, setJob, type JobRow } from "./jobs.ts";
import { llmReady } from "./llm.ts";
import { getSettings } from "./settings.ts";
import { queueTailor } from "./tailor.ts";

type Step = "tailor" | "apply";

/** Jobs you told to go now: the rest of their steps skip the wait. Kept in memory, like the queues. */
const goNow = new Set<number>();

/** Whether batch steps wait at all: the setting is on and DeepSeek (which has the peak price) is the model. */
export function holding() {
  const s = getSettings();
  return s.offPeakOnly && s.llmMode === "deepseek";
}

function nextStep(j: JobRow): Step | null {
  if (j.stage === "applied" || j.stage === "skipped" || !j.jd) return null;
  return j.tailored ? "apply" : "tailor";
}

function start(j: JobRow) {
  const step = nextStep(j);
  setJob(j.id, { held: null });
  if (step === "tailor") queueTailor(j.id, () => advance(j.id));
  else if (step === "apply") {
    goNow.delete(j.id);
    try {
      startRun(j.id);
    } catch (e) {
      setJob(j.id, { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** The next step of a job in a batch (tailor, then fill): now, or held until off-peak and a free slot. */
export function advance(id: number) {
  const j = getJob(id);
  if (!j || !nextStep(j)) return;
  if (!holding() || goNow.has(id)) return start(j);
  setJob(id, { held: nextStep(j) });
  pump();
}

/** Starts held steps while it is off-peak and a slot is free; all of them at once if the setting was turned off. */
export function pump(now = new Date()) {
  const held = all<{ id: number; held: Step }>(
    "SELECT id, held FROM jobs WHERE held IS NOT NULL ORDER BY CASE held WHEN 'apply' THEN 0 ELSE 1 END, updated_at, id",
  );
  const gate = holding();
  // No key or no balance: starting them would only fail each one. They keep waiting.
  const ready = llmReady().ok;
  for (const h of held) {
    const j = getJob(h.id);
    if (!j) continue;
    if (!nextStep(j)) {
      setJob(j.id, { held: null });
      continue;
    }
    if (!ready || (gate && isPeak(now))) continue;
    const free = h.held === "apply" ? runSlotFree() : bgQueue.size < 2;
    if (!gate || free) start(j);
  }
}

/** "现在就跑": held jobs (these, or all of them) start now and skip the wait for their remaining steps. */
export function runNow(ids?: number[]) {
  const held = all<{ id: number }>("SELECT id FROM jobs WHERE held IS NOT NULL").map((r) => r.id);
  for (const id of ids ? held.filter((h) => ids.includes(h)) : held) {
    goNow.add(id);
    const j = getJob(id);
    if (j) start(j);
  }
}
