import { useState } from "react";
import { api, go, RUN_LABEL, type RunView } from "../api.ts";
import { Badge, Button, Card, inputCls, useAction } from "./ui.tsx";
import { jobName } from "../status.ts";

export function RunCard({
  run: r,
  selectable,
  selected,
  onSelect,
  showJob = true,
  showLastScreen = false,
}: {
  run: RunView;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (v: boolean) => void;
  showJob?: boolean;
  /** For a finished run, show the screen it ended on (useful when it failed). */
  showLastScreen?: boolean;
}) {
  const { busy, run } = useAction();
  const [answer, setAnswer] = useState("");
  const [remember, setRemember] = useState(true);
  const [feedback, setFeedback] = useState("");
  const [revising, setRevising] = useState(false);
  const p = r.pending;
  const send = (key: string, body: object, ok?: string) => run(key, () => api(`/runs/${r.id}/reply`, { body }), ok);
  const focus = () => run("focus", () => api(`/runs/${r.id}/focus`, { body: {} }));

  const tone = r.status === "awaiting_confirm" || r.status === "need_user" ? "amber" : r.status === "submitted" ? "green" : r.status === "failed" ? "red" : r.status === "running" ? "blue" : "gray";

  return (
    <Card className={`overflow-hidden ${r.status === "awaiting_confirm" ? "ring-1 ring-amber-200" : ""}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        {selectable && <input type="checkbox" className="accent-brand-600" checked={!!selected} onChange={(e) => onSelect?.(e.target.checked)} />}
        {showJob && (
          <button className="min-w-0 truncate font-medium hover:underline" onClick={() => go(`/jobs/${r.job_id}`)}>
            {jobName({ title: r.job_title, company: r.job_company, url: r.job_url })}
            {r.job_company && <span className="font-normal text-muted"> · {r.job_company}</span>}
          </button>
        )}
        <Badge tone={tone} pulse={r.status === "running"}>
          {RUN_LABEL[r.status]}
        </Badge>
        <span className="text-xs text-muted">Step {r.steps}</span>
        <div className="ml-auto flex gap-1">
          {r.live && (
            <Button size="sm" variant="ghost" busy={busy === "focus"} onClick={focus}>
              Show in browser
            </Button>
          )}
          {r.live && (
            <Button size="sm" variant="ghost" busy={busy === "cancel"} onClick={() => send("cancel", { type: "cancel" }, "Application abandoned")}>
              Abandon
            </Button>
          )}
        </div>
      </div>

      {p?.kind === "ask" && (
        <div className="space-y-2 px-4 py-3">
          <div className="text-sm">{p.question}</div>
          {p.field && <div className="text-xs text-muted">Form field: {p.field}</div>}
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className={inputCls}
              autoFocus
              value={answer}
              placeholder="Your answer"
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && answer.trim() && send("answer", { type: "answer", answer, remember })}
            />
            <Button variant="primary" disabled={!answer.trim()} busy={busy === "answer"} onClick={() => send("answer", { type: "answer", answer, remember })}>
              Answer
            </Button>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" className="accent-brand-600" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Save to my profile and use it next time this comes up
          </label>
        </div>
      )}

      {p?.kind === "manual" && (
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
          <div className="flex-1 text-sm">{p.reason}</div>
          <div className="flex gap-2">
            <Button onClick={focus}>Go to browser</Button>
            <Button variant="primary" busy={busy === "resume"} onClick={() => send("resume", { type: "resume" })}>
              Done, continue
            </Button>
          </div>
        </div>
      )}

      {p?.kind === "review" && (
        <div className="grid gap-4 px-4 py-3 md:grid-cols-[1fr_220px]">
          <div className="min-w-0 space-y-3">
            {p.summary && <div className="rounded-md bg-paper px-3 py-2 text-sm">{p.summary}</div>}
            <table className="w-full text-[13px]">
              <tbody>
                {p.fields.map((f, i) => (
                  <tr key={i} className="border-b border-line/70 last:border-0">
                    <td className="w-2/5 py-1 pr-3 align-top text-muted">{f.label}</td>
                    <td className="py-1 break-words">{f.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {revising ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <input className={inputCls} autoFocus value={feedback} placeholder="What should change? E.g. add +65 before the phone number" onChange={(e) => setFeedback(e.target.value)} />
                <Button
                  disabled={!feedback.trim()}
                  busy={busy === "revise"}
                  onClick={() => send("revise", { type: "revise", feedback }).then(() => setRevising(false))}
                >
                  Ask for changes
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" busy={busy === "confirm"} onClick={() => send("confirm", { type: "confirm" }, "Confirmed, submitting")}>
                Confirm and submit
              </Button>
              {!revising && <Button onClick={() => setRevising(true)}>Needs changes</Button>}
              <span className="text-xs text-muted">Will click "{p.targetText}". You can also make changes in the browser yourself, then come back and confirm.</span>
              <a className="text-xs text-brand-700 hover:underline" href={`/api/jobs/${r.job_id}/resume.pdf`} target="_blank" rel="noreferrer">
                View uploaded resume
              </a>
            </div>
          </div>
          <a href={`/api/shots/${p.screenshot}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-line" title="Open the full screenshot">
            <img src={`/api/shots/${p.screenshot}`} alt="Screenshot of the filled-in form" className="max-h-80 w-full object-cover object-top" />
          </a>
        </div>
      )}

      {!p && r.outcome && <div className={`px-4 py-2.5 text-sm ${r.status === "failed" ? "text-red-700" : "text-muted"}`}>{r.outcome}</div>}
      {!p && r.status === "running" && <div className="px-4 py-2.5 text-sm text-muted">Filling in. The form is in the tab the agent opened in your browser; switch to it any time to watch.</div>}
      {!p && r.status === "queued" && <div className="px-4 py-2.5 text-sm text-muted">Queued. It starts when the applications ahead of it are done.</div>}
      {r.shot && p?.kind !== "review" && (r.live || showLastScreen) && (
        <div className="border-t border-line px-4 py-3">
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
            <span className="flex items-center gap-1.5">
              {r.live && r.status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-sky-500" />}
              {r.live ? "Live view (refreshes every step)" : "Where it stopped"}
            </span>
            <a href={`/api/shots/${r.shot}`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
              View full size
            </a>
          </div>
          <img src={`/api/shots/${r.shot}`} alt="The page in the agent's browser tab" className="max-h-72 w-full rounded-md border border-line object-cover object-top" />
        </div>
      )}
    </Card>
  );
}
