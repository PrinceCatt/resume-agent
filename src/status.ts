import { PROGRESS, type JobView } from "./api.ts";
import type { Tone } from "./components/ui.tsx";
import { isPeak, peakEndLabel } from "./offpeak.ts";

export function jobStatus(j: JobView): { label: string; tone: Tone; pulse?: boolean } {
  if (j.busy === "parsing") return { label: "读取岗位中", tone: "blue", pulse: true };
  if (j.busy === "tailoring") return { label: "改简历中", tone: "blue", pulse: true };
  if (j.held) return isPeak() ? { label: `等闲时 · ${peakEndLabel()}`, tone: "gray" } : { label: "排队处理", tone: "blue" };
  const r = j.run;
  if (r?.status === "queued") return { label: "排队投递", tone: "blue" };
  if (r?.status === "running") return { label: "填写中", tone: "blue", pulse: true };
  if (r?.status === "need_user") return { label: "等你处理", tone: "amber" };
  if (r?.status === "awaiting_confirm") return { label: "待确认提交", tone: "amber" };
  if (j.stage === "applied") {
    const p = PROGRESS.find((x) => x.key === (j.progress ?? "applied"))!;
    return { label: p.key === "applied" ? "已投递" : p.label, tone: p.tone };
  }
  if (j.stage === "skipped") return { label: "已跳过", tone: "gray" };
  if (j.error) return { label: "出错", tone: "red" };
  if (r?.status === "failed" || r?.status === "interrupted") return { label: "投递没完成", tone: "red" };
  if (j.stage === "tailored") return { label: "简历已改好", tone: "violet" };
  if (j.stage === "parsed") return { label: "已读取", tone: "gray" };
  return { label: "新加入", tone: "gray" };
}

export function isInFlight(j: JobView) {
  return !!j.busy || (!!j.run && ["queued", "running"].includes(j.run.status));
}
/** Waiting for off-peak (or a free slot) to tailor or fill. Not in flight: its buttons still run it now. */
export function isHeld(j: JobView) {
  return !!j.held && !j.busy;
}
export function needsYou(j: JobView) {
  return !!j.run && ["need_user", "awaiting_confirm"].includes(j.run.status);
}
/** Applied jobs that got past the first reply: a test, an interview or an offer. */
export function hasProgress(j: JobView) {
  return j.stage === "applied" && (j.progress === "screening" || j.progress === "interview" || j.progress === "offer");
}

export function jobName(j: { title: string | null; company: string | null; url: string }) {
  if (j.title) return j.title;
  try {
    return new URL(j.url).hostname.replace(/^www\./, "");
  } catch {
    return "粘贴的 JD";
  }
}

export function fitTone(score: number): { text: string; bg: string; ring: string } {
  if (score >= 70) return { text: "text-brand-700", bg: "bg-brand-50", ring: "stroke-brand-500" };
  if (score >= 50) return { text: "text-amber-800", bg: "bg-amber-50", ring: "stroke-amber-500" };
  return { text: "text-red-700", bg: "bg-red-50", ring: "stroke-red-500" };
}
