import { useState } from "react";
import { ago, api, eventLabel, go, hoursUntil, PROGRESS, whenLabel, type JobView, type Progress } from "../api.ts";
import { Avatar, Badge, FitPill, Icon, toast } from "./ui.tsx";
import { jobName, jobStatus } from "../status.ts";

type ColKey = "prep" | "applied" | "screening" | "interview" | "offer" | "ended";
const COLS: Array<{ key: ColKey; label: string; empty: string }> = [
  { key: "prep", label: "Preparing", empty: "No jobs waiting to be sent" },
  { key: "applied", label: "Awaiting reply", empty: "Applications you send show up here" },
  { key: "screening", label: "Assessment", empty: "" },
  { key: "interview", label: "Interviewing", empty: "" },
  { key: "offer", label: "Offer", empty: "" },
  { key: "ended", label: "Ended", empty: "Rejected / withdrawn" },
];

function colOf(j: JobView): ColKey {
  if (j.stage !== "applied") return "prep";
  const p = j.progress ?? "applied";
  return p === "rejected" || p === "withdrawn" ? "ended" : p;
}

/** Applications by where they stand; drag a card to another column to record progress. */
export function Board({ jobs }: { jobs: JobView[] }) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<ColKey | null>(null);

  const move = async (id: number, col: ColKey) => {
    const j = jobs.find((x) => x.id === id);
    if (!j || col === "prep" || colOf(j) === col) return;
    const progress: Progress = col === "ended" ? "rejected" : col;
    if (j.stage !== "applied" && !confirm(`Mark "${jobName(j)}" as applied (you sent it yourself)?`)) return;
    try {
      await api(`/jobs/${id}`, { method: "PATCH", body: { progress } });
      toast(`Moved to "${COLS.find((c) => c.key === col)!.label}"`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "err");
    }
  };

  return (
    // The scrollbar stays visible: on narrower screens the last columns are off to the right.
    <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-3 [scrollbar-width:thin] md:mx-0 md:px-0">
      {COLS.map((c) => {
        const list = jobs.filter((j) => colOf(j) === c.key);
        const target = drag !== null && c.key !== "prep";
        return (
          <section
            key={c.key}
            aria-label={c.label}
            onDragOver={(e) => {
              if (!target) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (over !== c.key) setOver(c.key);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === c.key ? null : o));
            }}
            onDrop={(e) => {
              e.preventDefault();
              const id = drag;
              setOver(null);
              setDrag(null);
              if (id !== null) void move(id, c.key);
            }}
            className={`flex w-60 min-w-48 shrink-0 flex-col rounded-lg border transition-colors md:w-auto md:flex-1 ${
              over === c.key ? "border-brand-400 bg-brand-50/70" : target ? "border-dashed border-stone-300 bg-paper" : "border-line bg-paper/70"
            }`}
          >
            <header className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-2">
              <span className="text-[13px] font-medium">{c.label}</span>
              <span className="rounded-full bg-white px-1.5 text-xs leading-5 text-muted tabular-nums ring-1 ring-line">{list.length}</span>
            </header>
            <div className="flex min-h-28 flex-col gap-2 px-2 pb-2">
              {list.map((j) => (
                <Card key={j.id} job={j} col={c.key} dragging={drag === j.id} onDragStart={() => setDrag(j.id)} onDragEnd={() => (setDrag(null), setOver(null))} />
              ))}
              {!list.length && (
                <div className="grid flex-1 place-items-center rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-stone-400">
                  {target ? "Drop here" : c.empty || "Empty"}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Card({ job: j, col, dragging, onDragStart, onDragEnd }: { job: JobView; col: ColKey; dragging: boolean; onDragStart: () => void; onDragEnd: () => void }) {
  const st = jobStatus(j);
  const fit = j.jd?.fit;
  const ev = j.nextEvent && hoursUntil(j.nextEvent.at) < 24 * 14 ? j.nextEvent : null;
  const ended = PROGRESS.find((p) => p.key === j.progress);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(j.id));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`group cursor-grab rounded-md border border-line bg-white p-2.5 shadow-xs transition hover:border-stone-300 hover:shadow-sm active:cursor-grabbing ${dragging ? "opacity-40" : ""}`}
    >
      <button className="block w-full text-left" onClick={() => go(`/jobs/${j.id}`)}>
        <div className="flex items-start gap-2">
          <Avatar name={j.company || jobName(j)} className="size-7 text-xs" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] leading-snug font-medium">{jobName(j)}</div>
            <div className="truncate text-xs text-muted">{j.company || j.location || "—"}</div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {col === "prep" && (
            <Badge tone={st.tone} pulse={st.pulse}>
              {st.label}
            </Badge>
          )}
          {col === "ended" && ended && <Badge tone="gray">{ended.label}</Badge>}
          {fit && <FitPill score={fit.score} />}
        </div>
        {ev && (
          <div className={`mt-1.5 flex items-center gap-1 text-xs ${hoursUntil(ev.at) < 24 ? "font-medium text-violet-800" : "text-violet-700"}`}>
            <Icon name="calendar" className="size-3" />
            {whenLabel(ev.at)} {eventLabel(ev.kind)}
          </div>
        )}
        <div className="mt-1.5 text-[11px] text-stone-400">{j.stage === "applied" && j.appliedAt ? `Applied ${ago(j.appliedAt)}` : `Added ${ago(j.createdAt)}`}</div>
      </button>
      {j.stage === "applied" && (
        // Touch screens cannot drag: a small picker instead.
        <select
          aria-label="Move to"
          className="mt-2 hidden h-7 w-full rounded border border-line bg-white px-1 text-xs pointer-coarse:block"
          value={j.progress ?? "applied"}
          onChange={(e) => api(`/jobs/${j.id}`, { method: "PATCH", body: { progress: e.target.value } }).catch((err) => toast(err.message, "err"))}
        >
          {PROGRESS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
