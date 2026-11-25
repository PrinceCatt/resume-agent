import { useEffect, useRef, useState } from "react";
import { api, go, localDay, localTime, PROGRESS, rmb, tokens, useApi, type CalEvent, type Draft, type DraftKind, type Fit, type JobFacts, type JobView, type Prep, type Progress, type ResumeDoc, type RunView, type Step, type Tailored } from "../api.ts";
import { RunCard } from "../components/RunCard.tsx";
import { Schedule } from "../components/Schedule.tsx";
import { PrepTab } from "./JobPrep.tsx";
import { Badge, Button, Card, Empty, Icon, inputCls, Menu, toast, useAction } from "../components/ui.tsx";
import { fitTone, isHeld, isInFlight, jobName, jobStatus } from "../status.ts";
import { isPeak, peakEndLabel } from "../offpeak.ts";
import { AUTH_LABEL, DEGREE_LABEL, MATERIAL_LABEL, typeLabel, yearsLabel } from "../reqs.ts";

type Detail = {
  job: JobView & { jdText: string | null; coverLetter: string };
  tailored: Tailored | null;
  runs: RunView[];
  steps: Step[];
  events: CalEvent[];
  log: Array<{ progress: Progress; ts: string }>;
  prep: Prep | null;
  drafts: Partial<Record<DraftKind, Draft>>;
  prepping: boolean;
  prepError: string | null;
};
type TabKey = "jd" | "resume" | "runs" | "prep";

export default function JobDetailPage({ id }: { id: number }) {
  const { data, error, reload } = useApi<Detail>(`/jobs/${id}`, ["job", "run", "schedule"]);
  const [tab, setTab] = useState<TabKey>("resume");
  const { busy, run } = useAction();
  useEffect(() => {
    if (!data) return;
    const r = data.runs[0];
    if (r && ["running", "queued", "need_user", "awaiting_confirm"].includes(r.status)) setTab("runs");
    else if (data.job.stage === "applied" && (data.prep || ["screening", "interview"].includes(data.job.progress ?? ""))) setTab("prep");
    else if (!data.tailored) setTab("jd");
    // only on first load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!data]);

  if (error) return <Empty title="Could not open this job">{error}</Empty>;
  if (!data) return null;
  const j = data.job;
  const st = jobStatus(j);
  const flight = isInFlight(j);
  const waiting = j.run?.status === "need_user" || j.run?.status === "awaiting_confirm";
  const patch = (body: object, ok?: string) => run("patch", () => api(`/jobs/${id}`, { method: "PATCH", body }), ok);

  return (
    <div className="mx-auto max-w-6xl">
      <button className="mb-3 text-sm text-muted hover:text-ink" onClick={() => go("/")}>
        ← Jobs
      </button>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{jobName(j)}</h1>
            <Badge tone={st.tone} pulse={st.pulse}>
              {st.label}
            </Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            {[j.company, j.location].filter(Boolean).join(" · ")}
            {j.url && (
              <a href={j.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-700 hover:underline">
                Original page
                <Icon name="external" className="size-3" />
              </a>
            )}
            {j.tokens > 0 && (
              <span className="text-xs text-stone-400" title="Model tokens used on this job for reading, tailoring and form filling; the cost is estimated from DeepSeek's prices and the time of each call (peak / off-peak)">
                {tokens(j.tokens)} tokens · about {rmb(j.cost)}
              </span>
            )}
          </div>
          {j.error && <div className="mt-2 text-sm text-red-700">{j.error}</div>}
          {!j.error && j.notice && <div className="mt-2 text-sm text-amber-800">{j.notice}</div>}
          {isHeld(j) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 text-sm text-muted">
              {isPeak()
                ? `Waiting for DeepSeek's off-peak hours: ${j.held === "apply" ? "form filling" : "tailoring"} starts by itself after ${peakEndLabel()} (half price then).`
                : `Queued: ${j.held === "apply" ? "form filling" : "tailoring"} starts as soon as a slot is free.`}
              <button
                className="text-brand-700 hover:underline disabled:opacity-50"
                disabled={busy === "now"}
                onClick={() => void run("now", () => api("/jobs/run-now", { body: { ids: [id] } }), "Started")}
              >
                Run now
              </button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button busy={busy === "tailor"} disabled={flight || !j.jd} onClick={() => run("tailor", () => api(`/jobs/${id}/tailor`, { body: {} }), "Tailoring the resume")}>
            {data.tailored ? "Tailor again" : "Tailor resume"}
          </Button>
          <Button
            variant="primary"
            busy={busy === "apply"}
            disabled={flight || !j.url || waiting}
            onClick={() => {
              if (j.stage === "applied" && !confirm("You already applied to this job. Apply again?")) return;
              void run("apply", async () => {
                await api(`/jobs/${id}/apply`, { body: {} });
                setTab("runs");
              }, "Filling in the application");
            }}
          >
            {j.run ? "Apply again" : "Start applying"}
          </Button>
          <Menu
            label="More"
            items={[
              { label: "Re-read job", onClick: () => void run("parse", () => api(`/jobs/${id}/parse`, { body: {} }), "Reading it again"), hidden: flight },
              { label: "Mark as applied (I sent it myself)", onClick: () => void patch({ stage: "applied" }, "Marked as applied"), hidden: j.stage === "applied" },
              { label: j.stage === "skipped" ? "Restore" : "Skip this job", onClick: () => void patch({ stage: j.stage === "skipped" ? "restore" : "skipped" }) },
              {
                label: "Delete",
                danger: true,
                onClick: () => {
                  if (confirm("Delete this job with its resume and application records?")) void run("del", async () => { await api(`/jobs/${id}`, { method: "DELETE" }); go("/"); });
                },
              },
            ]}
          />
        </div>
      </header>

      <Stepper detail={data} />
      <FollowUp job={j} events={data.events} log={data.log} onChange={reload} />

      <div className="scroll-clean mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {(
          [
            ["resume", "Resume"],
            ["jd", j.jd?.fit ? `Posting · fit ${j.jd.fit.score}` : "Posting"],
            ["runs", `Applications${data.runs.length ? ` (${data.runs.length})` : ""}`],
            ["prep", data.prepping ? "Interview prep · writing" : "Interview prep"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${tab === k ? "border-brand-600 font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "jd" && <JdTab detail={data} onSaved={reload} />}
      {tab === "resume" && <ResumeTab detail={data} />}
      {tab === "runs" && <RunsTab detail={data} />}
      {tab === "prep" && (
        <PrepTab
          jobId={j.id}
          hasJd={!!j.jd}
          applied={j.stage === "applied"}
          appliedAt={j.appliedAt}
          prep={data.prep}
          prepping={data.prepping}
          prepError={data.prepError}
          drafts={data.drafts}
        />
      )}
    </div>
  );
}

type StepState = "done" | "current" | "wait" | "error" | "todo";
function Stepper({ detail }: { detail: Detail }) {
  const j = detail.job;
  const r = j.run;
  const applied = j.stage === "applied";
  const prog = PROGRESS.find((p) => p.key === (j.progress ?? "applied"))!;
  const steps: Array<{ label: string; state: StepState }> = [
    { label: "Read job", state: j.busy === "parsing" ? "current" : j.jd ? "done" : j.error ? "error" : "todo" },
    { label: "Tailor resume", state: j.busy === "tailoring" ? "current" : detail.tailored ? "done" : j.error && j.jd ? "error" : "todo" },
    {
      label: "Fill in form",
      state: applied
        ? "done"
        : r?.status === "running" || r?.status === "queued"
          ? "current"
          : r?.status === "need_user"
            ? "wait"
            : r?.status === "awaiting_confirm"
              ? "done"
              : r?.status === "failed" || r?.status === "interrupted"
                ? "error"
                : "todo",
    },
    { label: "Confirm submit", state: applied ? "done" : r?.status === "awaiting_confirm" ? "wait" : "todo" },
    { label: applied && prog.key !== "applied" ? prog.label : "Applied", state: applied ? "done" : "todo" },
  ];
  const dot: Record<StepState, string> = {
    done: "bg-brand-600 text-white",
    current: "bg-sky-500 text-white animate-pulse",
    wait: "bg-amber-500 text-white",
    error: "bg-red-600 text-white",
    todo: "border border-stone-300 bg-white text-stone-400",
  };
  return (
    <ol className="scroll-clean mb-4 flex items-center gap-1 overflow-x-auto rounded-lg border border-line bg-white px-4 py-2.5 text-[13px]">
      {steps.map((s, i) => (
        <li key={s.label} className="flex shrink-0 items-center gap-1">
          {i > 0 && <span className={`mx-1 h-px w-6 sm:w-10 ${s.state === "todo" ? "bg-line" : "bg-brand-200"}`} />}
          <span className={`grid size-5 place-items-center rounded-full text-[11px] font-semibold ${dot[s.state]}`}>
            {s.state === "done" ? <Icon name="check" className="size-3" /> : s.state === "error" ? "!" : i + 1}
          </span>
          <span className={s.state === "todo" ? "text-muted" : s.state === "wait" ? "font-medium text-amber-800" : s.state === "error" ? "text-red-700" : "text-ink"}>
            {s.label}
            {s.state === "wait" && " (your turn)"}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** After applying: where it stands, plus free notes (referrer, contact, interview time) for any job. */
function FollowUp({ job: j, events, log, onChange }: { job: Detail["job"]; events: CalEvent[]; log: Detail["log"]; onChange: () => unknown }) {
  const [notes, setNotes] = useState(j.notes);
  const [focused, setFocused] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => {
    if (!focused) setNotes(j.notes);
  }, [j.notes, focused]);
  const applied = j.stage === "applied";
  const saveNotes = () => {
    setFocused(false);
    if (notes === j.notes) return;
    void run("notes", async () => {
      await api(`/jobs/${j.id}`, { method: "PATCH", body: { notes } });
      await onChange();
    }, "Notes saved");
  };
  return (
    <Card className="mb-4 space-y-3 p-4">
      {applied && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-sm font-medium">Progress</span>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Progress after applying">
            {PROGRESS.map((p) => {
              const on = (j.progress ?? "applied") === p.key;
              return (
                <button
                  key={p.key}
                  role="radio"
                  aria-checked={on}
                  disabled={busy === "progress"}
                  onClick={() => !on && run("progress", () => api(`/jobs/${j.id}`, { method: "PATCH", body: { progress: p.key as Progress } }))}
                  className={`rounded-full border px-2.5 py-0.5 text-[13px] ${on ? "border-brand-600 bg-brand-600 text-white" : "border-line bg-white text-muted hover:border-stone-300 hover:text-ink"}`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-muted">
            {j.appliedAt && `Applied ${localTime(j.appliedAt)}`}
            {j.progressAt && j.progress && j.progress !== "applied" && log.length < 2 && ` · updated ${localTime(j.progressAt)}`}
          </span>
        </div>
      )}
      {applied && log.length > 1 && (
        <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted" aria-label="Progress history">
          {log.map((l, i) => (
            <li key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-stone-300">→</span>}
              <span className={i === log.length - 1 ? "font-medium text-ink" : ""}>
                {l.progress === "applied" ? "Applied" : PROGRESS.find((p) => p.key === l.progress)?.label}
              </span>
              <span className="text-stone-400">{localDay(l.ts)}</span>
            </li>
          ))}
        </ol>
      )}
      <Schedule jobId={j.id} events={events} applied={applied} />
      <textarea
        className={`${inputCls} min-h-9 text-[13px]`}
        rows={1}
        placeholder={applied ? "Notes: contacts, interview times, test format, follow-ups…" : "Notes: referrer, deadline, why you want it…"}
        value={notes}
        onFocus={() => setFocused(true)}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={saveNotes}
      />
    </Card>
  );
}

function ScoreRing({ score }: { score: number }) {
  const t = fitTone(score);
  const c = 2 * Math.PI * 22;
  return (
    <div className="relative size-16 shrink-0">
      <svg viewBox="0 0 52 52" className="size-16 -rotate-90">
        <circle cx="26" cy="26" r="22" fill="none" strokeWidth="5" className="stroke-stone-100" />
        <circle cx="26" cy="26" r="22" fill="none" strokeWidth="5" strokeLinecap="round" className={t.ring} strokeDasharray={`${(c * score) / 100} ${c}`} />
      </svg>
      <span className={`absolute inset-0 grid place-items-center text-lg font-semibold tabular-nums ${t.text}`}>{score}</span>
    </div>
  );
}

function FitCard({ fit }: { fit: Fit }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <ScoreRing score={fit.score} />
        <div className="min-w-0">
          <div className="text-sm font-medium">Fit</div>
          {fit.verdict && <div className="mt-0.5 text-[13px] leading-snug text-muted">{fit.verdict}</div>}
        </div>
      </div>
      {fit.conflict && <div className="mt-3 rounded bg-amber-50 px-2 py-1.5 text-[13px] text-amber-900">Clashes with what you want: {fit.conflict} (score capped at 45)</div>}
      {fit.strengths.length > 0 && (
        <ul className="mt-3 space-y-1 text-[13px]">
          {fit.strengths.map((s, i) => {
            // The second form is how the Chinese edition marked it, for jobs read before switching.
            const bad = s.includes("(not in your profile:") || s.includes("（资料库里没找到");
            return (
              <li key={i} className={`flex gap-1.5 ${bad ? "text-amber-900" : ""}`}>
                {bad ? <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" /> : <Icon name="check" className="mt-0.5 size-3.5 text-brand-600" />}
                <span>{s}</span>
              </li>
            );
          })}
        </ul>
      )}
      {fit.gaps.length > 0 && (
        <ul className="mt-2 space-y-1 text-[13px]">
          {fit.gaps.map((s, i) => (
            <li key={i} className="flex gap-1.5 text-muted">
              <span className="mt-[7px] h-0.5 w-2.5 shrink-0 rounded bg-amber-500" />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      )}
      {!!fit.unsupported?.length && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          The assessment counted {fit.unsupported.join(", ")} as your strengths, but your profile doesn't mention {fit.unsupported.length === 1 ? "it" : "them"}, so the score may be too high. If you really have {fit.unsupported.length === 1 ? "it" : "them"}, add {fit.unsupported.length === 1 ? "it" : "them"} to your profile and re-read the job from "More".
        </div>
      )}
      <div className="mt-3 text-xs text-stone-400">After changing your profile, re-score it with "More → Re-read job".</div>
    </Card>
  );
}

function JdTab({ detail, onSaved }: { detail: Detail; onSaved: () => void }) {
  const j = detail.job;
  const jd = j.jd;
  const after = new Set((detail.tailored?.coverage.after ?? []).map((k) => k.toLowerCase()));
  const [text, setText] = useState(j.jdText ?? "");
  const [editing, setEditing] = useState(false);
  const { busy, run } = useAction();
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        {jd ? (
          <Card className="space-y-4 p-5">
            {jd.summary && <p className="text-sm leading-relaxed">{jd.summary}</p>}
            {jd.requirements.length > 0 && (
              <div>
                <div className="mb-1 text-[13px] font-medium text-muted">Must have</div>
                <ul className="list-disc space-y-0.5 pl-5 text-sm">{jd.requirements.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}
            {jd.niceToHave.length > 0 && (
              <div>
                <div className="mb-1 text-[13px] font-medium text-muted">Nice to have</div>
                <ul className="list-disc space-y-0.5 pl-5 text-sm">{jd.niceToHave.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}
          </Card>
        ) : (
          <Empty title="No posting content yet">{j.busy === "parsing" ? "Reading…" : "Use \"More → Re-read job\", or paste the JD below."}</Empty>
        )}
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium">Original text</div>
            <button className="text-xs text-brand-700 hover:underline" onClick={() => setEditing(!editing)}>
              {editing ? "Close" : "Edit / paste JD"}
            </button>
          </div>
          {editing ? (
            <div className="space-y-2">
              <textarea className={`${inputCls} max-h-[60vh] min-h-48 text-[13px]`} value={text} onChange={(e) => setText(e.target.value)} />
              <Button
                variant="primary"
                busy={busy === "save"}
                onClick={() =>
                  run("save", async () => {
                    await api(`/jobs/${j.id}`, { method: "PATCH", body: { jdText: text } });
                    await api(`/jobs/${j.id}/parse`, { body: {} });
                    setEditing(false);
                    onSaved();
                  }, "Saved; analysing it again")
                }
              >
                Save and analyse again
              </Button>
            </div>
          ) : (
            <pre className="max-h-96 overflow-auto font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-muted">{j.jdText || "(empty)"}</pre>
          )}
        </Card>
      </div>
      <div className="order-first grid content-start gap-4 sm:grid-cols-2 xl:order-none xl:grid-cols-1">
        {jd?.fit && <FitCard fit={jd.fit} />}
        {jd && <FactsCard facts={jd.facts} closed={jd.closed} />}
        {jd && jd.keywords.length > 0 && (
          <Card className="h-fit p-4">
            <div className="mb-2 text-sm font-medium">Keywords</div>
            <div className="flex flex-wrap gap-1.5">
              {jd.keywords.map((k) => (
                <span key={k} className={`rounded px-1.5 py-0.5 text-xs ${after.has(k.toLowerCase()) ? "bg-brand-50 text-brand-700" : "bg-stone-100 text-stone-500"}`}>
                  {k}
                </span>
              ))}
            </div>
            {detail.tailored && <div className="mt-3 text-xs text-muted">Green = in the tailored resume. Grey ones are not in your profile, so they are not forced in.</div>}
          </Card>
        )}
      </div>
    </div>
  );
}

/** What the posting itself says about type, experience, who may apply and what to send. */
function FactsCard({ facts: f, closed }: { facts: JobFacts | null; closed?: boolean }) {
  if (!f)
    return (
      <Card className="h-fit p-4">
        <div className="mb-1 text-sm font-medium">Conditions</div>
        <div className="text-xs text-muted">This job was read before conditions were recorded. Use "More → Re-read job" to get them.</div>
      </Card>
    );
  const rows: Array<[string, string, boolean?]> = [
    ["Type", typeLabel(f) || "Not stated"],
    ["Experience", f.minYears === null ? "Not stated" : yearsLabel(f.minYears), (f.minYears ?? 0) >= 2],
    ["Education", f.degree ? DEGREE_LABEL[f.degree] : "Not stated"],
    ["Student / graduate", f.student === "graduated" ? "Graduates only" : f.student === "enrolled" ? "Current students only" : "Not stated", f.student === "graduated"],
    ["Who can apply", f.workAuth ? AUTH_LABEL[f.workAuth] : "Not stated", !!f.workAuth],
    ["Start date", f.start || "Not stated"],
    ["Workplace", f.workplace ? { onsite: "On-site", hybrid: "Hybrid", remote: "Remote" }[f.workplace] : "Not stated"],
    ["Salary", f.salary || "Not stated"],
    ["Documents to send", f.materials.length ? f.materials.map((m) => MATERIAL_LABEL[m]).join(", ") : "Not stated"],
  ];
  return (
    <Card className="h-fit p-4">
      <div className="mb-2 flex items-center justify-between text-sm font-medium">
        Conditions
        {closed && <Badge tone="red">Closed</Badge>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        {rows.map(([k, v, warn]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className={v === "Not stated" ? "text-stone-400" : warn ? "text-amber-800" : ""}>{v}</dd>
          </div>
        ))}
      </dl>
      {f.coverLetterAsk && <div className="mt-2 rounded bg-paper px-2 py-1.5 text-xs text-muted">Cover letter should cover: {f.coverLetterAsk}</div>}
      <div className="mt-2 text-[11px] text-stone-400">Only what the posting itself states; nothing is guessed.</div>
    </Card>
  );
}

function ResumeTab({ detail }: { detail: Detail }) {
  const t = detail.tailored;
  const j = detail.job;
  const [doc, setDoc] = useState<ResumeDoc | null>(t?.doc ?? null);
  const [cover, setCover] = useState(j.coverLetter);
  const [dirty, setDirty] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const { busy, run } = useAction();
  useEffect(() => {
    if (!dirty) {
      setDoc(t?.doc ?? null);
      setCover(j.coverLetter);
      setPreviewKey((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.generatedAt, t?.scale, j.coverLetter]);

  if (!t || !doc) {
    return <Empty title={j.busy === "tailoring" ? "Tailoring the resume to this job…" : "Resume not tailored yet"}>{j.jd ? "Click \"Tailor resume\" at the top right." : "Read the job first."}</Empty>;
  }
  const edit = (fn: (d: ResumeDoc) => void) => {
    const d = structuredClone(doc);
    fn(d);
    setDoc(d);
    setDirty(true);
  };
  const cov = t.coverage;
  const rewritten = Object.keys(t.origin).length;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
      <div className="space-y-4">
        {t.warnings.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="mb-1 font-medium">Please check</div>
            <ul className="list-disc space-y-0.5 pl-5">{t.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </div>
        )}
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">What changed</div>
            <div className="flex flex-wrap gap-x-3 text-xs text-muted">
              {rewritten > 0 && <span>{rewritten} {rewritten === 1 ? "bullet" : "bullets"} reworded</span>}
              {cov.keywords.length > 0 && (
                <span>
                  Keywords covered: original {cov.before.length} → now <b className="text-ink">{cov.after.length}</b> / {cov.keywords.length}
                </span>
              )}
            </div>
          </div>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-muted">{t.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </Card>

        <Card className="divide-y divide-line">
          {doc.summary !== undefined && (doc.summary || t.doc.summary) ? (
            <div className="p-4">
              <div className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Summary</div>
              <textarea className={`${inputCls} text-[13px]`} value={doc.summary} onChange={(e) => edit((d) => (d.summary = e.target.value))} />
            </div>
          ) : null}
          {doc.sections.map((s, si) => (
            <div key={s.id} className="p-4">
              <div className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{s.heading}</div>
              <div className="space-y-3">
                {s.entries.map((e, ei) => (
                  <div key={e.id}>
                    {(e.title || e.subtitle) && (
                      <div className="mb-1 flex justify-between gap-3 text-sm">
                        <span className="font-medium">
                          {e.title}
                          {e.subtitle && <span className="font-normal text-muted"> · {e.subtitle}</span>}
                        </span>
                        <span className="shrink-0 text-xs text-muted">{e.dates}</span>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      {e.bullets.map((b, bi) => {
                        const orig = t.origin[b.id];
                        // "（素材库）" is how the Chinese edition marked an extra fact, for resumes tailored before switching.
                        const plainOrig = orig?.replace(/^(\(Extra facts\) |（素材库）)/, "");
                        return (
                          <div key={b.id} className="group flex gap-2">
                            <span className={`mt-2 size-1 shrink-0 rounded-full ${orig ? "bg-brand-500" : "bg-stone-400"}`} />
                            <div className="min-w-0 flex-1">
                              <textarea
                                className="w-full resize-none rounded border border-transparent px-1.5 py-1 text-[13px] leading-snug outline-none hover:border-line focus:border-brand-500"
                                value={b.text}
                                onChange={(ev) => edit((d) => (d.sections[si].entries[ei].bullets[bi].text = ev.target.value))}
                              />
                              {orig && (
                                <div className="flex items-start gap-2 px-1.5 text-xs leading-snug text-stone-400">
                                  <span className="min-w-0 flex-1">Original: {orig}</span>
                                  {plainOrig && plainOrig !== b.text && (
                                    <button
                                      className="inline-flex shrink-0 items-center gap-0.5 text-stone-400 hover:text-brand-700"
                                      title="Switch this back to the original"
                                      onClick={() => edit((d) => (d.sections[si].entries[ei].bullets[bi].text = plainOrig))}
                                    >
                                      <Icon name="undo" className="size-3" />
                                      Use original
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                            <button
                              title="Remove this bullet"
                              aria-label="Remove this bullet"
                              className="mt-1 h-6 shrink-0 px-1 text-stone-300 opacity-0 group-hover:opacity-100 hover:text-red-600 focus:opacity-100"
                              onClick={() => edit((d) => d.sections[si].entries[ei].bullets.splice(bi, 1))}
                            >
                              <Icon name="x" className="size-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="p-4">
            <div className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{doc.skillsHeading}</div>
            <div className="space-y-1.5">
              {doc.skills.map((g, gi) => (
                <div key={g.id} className="flex items-center gap-2 text-[13px]">
                  <span className="w-36 shrink-0 font-medium">{g.label}</span>
                  <input
                    className={`${inputCls} min-w-0 flex-1 text-[13px]`}
                    value={g.items.join(", ")}
                    onChange={(e) => edit((d) => (d.skills[gi].items = e.target.value.split(",").map((x) => x.trim()).filter(Boolean)))}
                  />
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium">Cover letter</div>
            <div className="flex gap-3">
              {!cover.trim() && !dirty && (
                <button
                  className="text-xs text-brand-700 hover:underline disabled:opacity-50"
                  disabled={busy === "cover"}
                  onClick={() =>
                    run("cover", async () => {
                      const r = await api<{ text: string }>(`/jobs/${j.id}/cover-letter`, { body: {} });
                      setCover(r.text);
                      setPreviewKey((k) => k + 1);
                    }, "Cover letter written")
                  }
                >
                  {busy === "cover" ? "Writing…" : "Write one"}
                </button>
              )}
              {cover.trim() && (
                <button
                  className="text-xs text-brand-700 hover:underline"
                  onClick={() => navigator.clipboard.writeText(cover).then(() => toast("Copied"), () => toast("Could not copy", "err"))}
                >
                  Copy
                </button>
              )}
              {j.hasCover && (
                <a className="text-xs text-brand-700 hover:underline" href={`/api/jobs/${j.id}/cover.pdf`} target="_blank" rel="noreferrer">
                  View PDF
                </a>
              )}
            </div>
          </div>
          <textarea
            className={`${inputCls} min-h-24 text-[13px] leading-relaxed`}
            placeholder={j.jd?.facts?.materials.includes("cover_letter") ? "This job asks for a cover letter: click \"Write one\" at the top right" : "No cover letter. One is written automatically when the posting or the application form asks for it"}
            value={cover}
            onChange={(e) => {
              setCover(e.target.value);
              setDirty(true);
            }}
          />
        </Card>

        <div className="sticky bottom-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-white/95 p-3 shadow-sm backdrop-blur">
          <Button
            variant="primary"
            disabled={!dirty}
            busy={busy === "save"}
            onClick={() =>
              run("save", async () => {
                await api(`/jobs/${j.id}/tailored`, { method: "PUT", body: { doc, coverLetter: cover } });
                setDirty(false);
                setPreviewKey((k) => k + 1);
              }, "Saved; PDF updated")
            }
          >
            Save and update PDF
          </Button>
          {dirty && (
            <Button
              variant="ghost"
              onClick={() => {
                setDoc(t.doc);
                setCover(j.coverLetter);
                setDirty(false);
              }}
            >
              Undo changes
            </Button>
          )}
          {dirty && <span className="text-xs text-amber-700">Unsaved changes: the preview is still the old one</span>}
          <a className="ml-auto inline-flex items-center gap-1 text-sm text-brand-700 hover:underline" href={`/api/jobs/${j.id}/resume.pdf?download=1`}>
            <Icon name="download" />
            Download PDF
          </a>
        </div>
      </div>

      <div className="xl:sticky xl:top-6 xl:h-[calc(100vh-3rem)]">
        <div className="mb-2 flex items-center justify-between text-xs text-muted">
          <span>Preview (this is what gets uploaded){t.scale && t.scale < 1 ? ` · text scaled to ${Math.round(t.scale * 100)}% to fit one page` : ""}</span>
          <a className="text-brand-700 hover:underline" href={`/api/jobs/${j.id}/resume.pdf`} target="_blank" rel="noreferrer">
            Open PDF
          </a>
        </div>
        <ResumePreview key={previewKey} src={`/api/jobs/${j.id}/resume.html`} />
      </div>
    </div>
  );
}

// A4 at 96 dpi. The resume page is 180 mm wide, wider than the preview column on a laptop screen,
// so the page is laid out at full size and scaled to the column instead of being cut off on the right.
const PAGE_W = 794;
const PAGE_H = 1123;

function ResumePreview({ src }: { src: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / PAGE_W);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="relative aspect-[210/297] w-full overflow-hidden rounded-lg border border-line bg-white shadow-sm">
      {scale > 0 && (
        <iframe
          title="Resume preview"
          src={src}
          className="absolute left-0 top-0 origin-top-left border-0"
          style={{ width: PAGE_W, height: PAGE_H, transform: `scale(${scale})` }}
        />
      )}
    </div>
  );
}

const RUN_TEXT: Record<string, string> = {
  submitted: "Submitted",
  finished: "Finished",
  failed: "Failed",
  cancelled: "Abandoned",
  interrupted: "Interrupted",
};

function RunsTab({ detail }: { detail: Detail }) {
  const [latest, ...older] = detail.runs;
  if (!latest) return <Empty title="No applications yet">Once the resume is tailored, click "Start applying" and the agent opens the application page in your browser and fills it in.</Empty>;
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <RunCard run={latest} showJob={false} showLastScreen />
        {older.length > 0 && (
          <Card className="divide-y divide-line">
            <div className="px-4 py-2 text-xs font-medium text-muted">Earlier applications</div>
            {older.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="w-28 shrink-0 text-muted">{localTime(r.created_at)}</span>
                <Badge tone={r.status === "submitted" ? "green" : r.status === "failed" ? "red" : "gray"}>{RUN_TEXT[r.status] ?? r.status}</Badge>
                <span className="min-w-0 truncate text-muted">{r.outcome}</span>
              </div>
            ))}
          </Card>
        )}
      </div>
      <Card className="h-fit p-4">
        <div className="mb-2 flex items-center justify-between text-sm font-medium">
          Every step of this run
          <span className="text-xs font-normal text-muted">started {localTime(latest.created_at)}</span>
        </div>
        <ol className="max-h-[70vh] space-y-1.5 overflow-auto text-[13px]">
          {detail.steps.map((s) => (
            <li key={s.id} className="flex gap-2">
              <span
                className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                  s.kind === "error" ? "bg-red-500" : s.kind === "ask" ? "bg-amber-500" : s.kind === "guard" ? "bg-violet-500" : s.kind === "model" ? "bg-sky-400" : "bg-stone-300"
                }`}
              />
              <span className={s.kind === "error" ? "text-red-700" : s.kind === "model" ? "text-muted italic" : s.kind === "guard" ? "text-violet-800" : ""}>{s.text}</span>
            </li>
          ))}
        </ol>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2 text-[11px] text-muted">
          <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-stone-300" />Action</span>
          <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-amber-500" />Needs you</span>
          <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-violet-500" />Blocked submit</span>
          <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-sky-400" />Model note</span>
          <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-red-500" />Error</span>
        </div>
      </Card>
    </div>
  );
}
