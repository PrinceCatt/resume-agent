import { useState } from "react";
import { api, EVENT_KINDS, eventLabel, hoursUntil, parseTime, toLocalInput, whenLabel, type CalEvent, type EventKind } from "../api.ts";
import { Button, Icon, inputCls, useAction } from "./ui.tsx";

const DURATIONS = [30, 45, 60, 90, 120];

function defaultTime() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return toLocalInput(d);
}

/** A job's interviews, tests, calls and deadlines: add, edit, tick off, export to a calendar. */
export function Schedule({ jobId, events, applied }: { jobId: number; events: CalEvent[]; applied: boolean }) {
  const [editing, setEditing] = useState<CalEvent | "new" | null>(null);
  const [showPast, setShowPast] = useState(false);
  const { busy, run } = useAction();
  const past = (e: CalEvent) => !!e.done || hoursUntil(e.at) < -3;
  const upcoming = events.filter((e) => !past(e));
  const done = events.filter(past);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Icon name="calendar" className="size-4 text-stone-400" />
          Schedule
        </span>
        {editing === null && (
          <button className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline" onClick={() => setEditing("new")}>
            <Icon name="plus" className="size-3" />
            {applied ? "Add interview / test" : "Add deadline / event"}
          </button>
        )}
      </div>
      {editing !== null && (
        <EventForm
          jobId={jobId}
          initial={editing === "new" ? null : editing}
          defaultKind={applied ? "interview" : "deadline"}
          onDone={() => setEditing(null)}
        />
      )}
      {!upcoming.length && editing === null && (
        <div className="text-xs text-muted">{applied ? "Got an interview or a test? Note it here: you get a reminder before it starts, and you can add it to your calendar." : "Note the application deadline here if there is one."}</div>
      )}
      <ul className="space-y-1">
        {[...upcoming, ...(showPast ? done : [])].map((e) => {
          const isPast = past(e);
          const link = e.note.match(/https?:\/\/\S+/)?.[0];
          const h = hoursUntil(e.at);
          return (
            <li key={e.id} className={`group flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md px-2 py-1.5 text-[13px] hover:bg-paper ${isPast ? "text-muted" : ""}`}>
              <span className={`size-2 shrink-0 rounded-full ${isPast ? "bg-stone-300" : (EVENT_KINDS.find((k) => k.key === e.kind)?.dot ?? "bg-stone-400")}`} />
              <span className={`tabular-nums ${!isPast && h < 24 ? "font-medium text-violet-800" : ""} ${e.done ? "line-through" : ""}`}>{whenLabel(e.at)}</span>
              <span className={`font-medium ${e.done ? "line-through" : ""}`}>{eventLabel(e.kind)}</span>
              {e.kind !== "deadline" && <span className="text-xs text-muted">{e.minutes} min</span>}
              {e.note && (
                <span className="min-w-0 flex-1 truncate text-xs text-muted" title={e.note}>
                  {link ? (
                    <a href={link} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                      {e.note}
                    </a>
                  ) : (
                    e.note
                  )}
                </span>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-2 text-xs opacity-70 group-hover:opacity-100">
                {!isPast && (
                  <a className="text-brand-700 hover:underline" href={`/api/schedule/${e.id}/calendar.ics`} title="Download an .ics file; open it to add the event to Outlook or your calendar">
                    Add to calendar
                  </a>
                )}
                <button className="text-muted hover:text-ink" onClick={() => setEditing(e)}>
                  Edit
                </button>
                <button
                  className="text-muted hover:text-ink"
                  disabled={busy === `done-${e.id}`}
                  onClick={() => run(`done-${e.id}`, () => api(`/schedule/${e.id}`, { method: "PATCH", body: { done: !e.done } }))}
                >
                  {e.done ? "Not done" : "Done"}
                </button>
                <button
                  className="text-muted hover:text-red-700"
                  onClick={() => confirm(`Delete this event (${eventLabel(e.kind)} ${whenLabel(e.at)})?`) && run(`del-${e.id}`, () => api(`/schedule/${e.id}`, { method: "DELETE" }))}
                >
                  Delete
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {done.length > 0 && (
        <button className="mt-1 px-2 text-xs text-muted hover:text-ink" onClick={() => setShowPast(!showPast)}>
          {showPast ? "Hide past events" : `${done.length} past`}
        </button>
      )}
    </div>
  );
}

function EventForm({ jobId, initial, defaultKind, onDone }: { jobId: number; initial: CalEvent | null; defaultKind: EventKind; onDone: () => void }) {
  const [kind, setKind] = useState<EventKind>(initial?.kind ?? defaultKind);
  const [at, setAt] = useState(() => {
    const d = parseTime(initial?.at);
    return d ? toLocalInput(d) : defaultTime();
  });
  const [minutes, setMinutes] = useState(initial?.minutes || 60);
  const [note, setNote] = useState(initial?.note ?? "");
  const { busy, run } = useAction();
  const save = () =>
    run(
      "save",
      async () => {
        const when = new Date(at);
        if (Number.isNaN(when.getTime())) throw new Error("That time is not valid");
        const body = { kind, at: when.toISOString(), minutes, note };
        if (initial) await api(`/schedule/${initial.id}`, { method: "PATCH", body });
        else await api(`/jobs/${jobId}/schedule`, { body });
        onDone();
      },
      initial ? "Event updated" : "Saved",
    );
  return (
    <div className="mb-2 space-y-2 rounded-md border border-line bg-paper/60 p-3">
      <div className="flex flex-wrap gap-1">
        {EVENT_KINDS.map((k) => (
          <button
            key={k.key}
            onClick={() => setKind(k.key)}
            className={`rounded-full border px-2.5 py-0.5 text-[13px] ${kind === k.key ? "border-brand-600 bg-brand-600 text-white" : "border-line bg-white text-muted hover:text-ink"}`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-[auto_auto_1fr]">
        <input type="datetime-local" className={`${inputCls} sm:w-52`} value={at} onChange={(e) => setAt(e.target.value)} aria-label="Time" />
        {kind !== "deadline" ? (
          <select className={`${inputCls} sm:w-28`} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="Duration">
            {[...new Set([...DURATIONS, minutes])].sort((a, b) => a - b).map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        ) : (
          <span className="hidden sm:block" />
        )}
        <input
          className={inputCls}
          placeholder={kind === "deadline" ? "Note (optional)" : "Meeting link, place or interviewer (optional)"}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" busy={busy === "save"} onClick={save}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <span className="text-xs text-muted">{kind === "deadline" ? "Reminder a day before" : "Reminder an hour before (with notifications on in Settings)"}</span>
      </div>
    </div>
  );
}
