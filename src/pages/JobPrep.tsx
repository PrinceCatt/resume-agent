import { useEffect, useState } from "react";
import { api, daysSince, localTime, type Draft, type DraftKind, type Prep, type PrepPoint, type PrepQuestion } from "../api.ts";
import { Badge, Button, Card, Empty, Icon, inputCls, toast, useAction, type Tone } from "../components/ui.tsx";

const QKIND: Record<PrepQuestion["kind"], { label: string; tone: Tone }> = {
  behavioral: { label: "Behavioural", tone: "blue" },
  technical: { label: "Technical", tone: "violet" },
  role: { label: "Role", tone: "green" },
  resume: { label: "Resume", tone: "amber" },
};

const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast("Copied"), () => toast("Could not copy", "err"));

type Props = {
  jobId: number;
  hasJd: boolean;
  applied: boolean;
  appliedAt: string | null;
  prep: Prep | null;
  prepping: boolean;
  prepError: string | null;
  drafts: Partial<Record<DraftKind, Draft>>;
};

/** Interview prep and email drafts for one job, both written from the profile only. */
export function PrepTab(props: Props) {
  const { jobId, hasJd, prep, prepping, prepError } = props;
  const { busy, run } = useAction();
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (!hasJd) return <Empty title="Read the job first">Interview prep is written from the posting's requirements.</Empty>;
  const start = () => run("prep", () => api(`/jobs/${jobId}/prep`, { body: {} }), prep ? "Writing it again" : "Writing it; takes about half a minute");
  const allOpen = !!prep && open.size === prep.questions.length;
  const unsure = prep ? prep.questions.reduce((n, q) => n + q.points.filter((p) => p.kind === "unsure").length, 0) : 0;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Icon name="spark" className="size-4 text-brand-600" />
              Interview prep
            </div>
            <div className="mt-0.5 text-[13px] text-muted">
              Written from this job and your profile: likely questions with experiences you can talk about, a self-introduction and questions to ask. Only facts from your profile.
              {prep && <span className="text-stone-400"> · written {localTime(prep.generatedAt)}</span>}
            </div>
          </div>
          <Button variant={prep ? "secondary" : "primary"} busy={prepping || busy === "prep"} disabled={prepping} onClick={start}>
            {prepping ? "Writing…" : prep ? "Write again" : "Write interview prep"}
          </Button>
        </Card>
        {prepError && !prepping && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">Could not write it: {prepError}</div>}
        {!prep && !prepping && !prepError && (
          <Empty title="No interview prep yet">{props.applied ? "Write one before the interview and practise with it." : "Usually written once you have an interview, but you can write one now."}</Empty>
        )}
        {prepping && !prep && (
          <Card className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2">
                <div className="h-3.5 w-2/3 animate-pulse rounded bg-stone-100" />
                <div className="h-3 w-5/6 animate-pulse rounded bg-stone-100" />
              </div>
            ))}
          </Card>
        )}
        {prep && (
          <>
            {prep.pitch && (
              <Card className="p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-medium">Self-introduction (30–45 seconds)</div>
                  <button className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline" onClick={() => copy(prep.pitch)}>
                    <Icon name="copy" className="size-3" />
                    Copy
                  </button>
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{prep.pitch}</p>
                {prep.pitchWarnings.length > 0 && <Warnings title="Check before you say it; these don't match your profile:" items={prep.pitchWarnings} />}
              </Card>
            )}
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
                <div className="text-sm font-medium">
                  Likely questions <span className="font-normal text-muted">({prep.questions.length})</span>
                </div>
                <button className="text-xs text-brand-700 hover:underline" onClick={() => setOpen(allOpen ? new Set() : new Set(prep.questions.map((_, i) => i)))}>
                  {allOpen ? "Collapse all" : "Expand all"}
                </button>
              </div>
              <div className="px-4 pt-2 text-xs text-muted">
                Think about your answer first, then open a question to see experiences you can use. Green dots are things in your profile; "Approach" marks advice on answering, not your experience.
              </div>
              {unsure > 0 && (
                <div className="mx-4 mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {unsure} {unsure === 1 ? "point has" : "points have"} nothing in your profile to back {unsure === 1 ? "it" : "them"} up (in yellow). Don't repeat {unsure === 1 ? "it" : "them"} as written: if you really did it, add it to your profile and it turns green here; if not, leave it out.
                </div>
              )}
              <ol className="divide-y divide-line">
                {prep.questions.map((q, i) => {
                  const on = open.has(i);
                  return (
                    <li key={i}>
                      <button
                        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-paper/60"
                        aria-expanded={on}
                        onClick={() =>
                          setOpen((s) => {
                            const n = new Set(s);
                            if (on) n.delete(i);
                            else n.add(i);
                            return n;
                          })
                        }
                      >
                        <span className="mt-0.5 w-5 shrink-0 text-right text-xs text-stone-400 tabular-nums">{i + 1}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{q.q}</span>
                            <Badge tone={QKIND[q.kind].tone}>{QKIND[q.kind].label}</Badge>
                          </span>
                          {q.why && <span className="mt-0.5 block text-xs text-muted">{q.why}</span>}
                          {!on && q.points.some((p) => p.kind === "unsure") && (
                            <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-amber-700">
                              <span className="size-1.5 rounded-full bg-amber-500" />
                              {q.points.filter((p) => p.kind === "unsure").length} to check
                            </span>
                          )}
                        </span>
                        <span className={`mt-1 text-stone-400 transition-transform ${on ? "rotate-90" : ""}`} aria-hidden="true">
                          ›
                        </span>
                      </button>
                      {on && q.points.length > 0 && (
                        <ul className="space-y-1.5 pr-4 pb-3 pl-12 text-[13px]">
                          {q.points.map((p, k) => (
                            <Point key={k} p={p} />
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ol>
            </Card>
            <div className="grid gap-4 md:grid-cols-2">
              {prep.toAsk.length > 0 && (
                <Card className="p-4">
                  <div className="mb-2 text-sm font-medium">Questions to ask the interviewer</div>
                  <ul className="list-disc space-y-1 pl-5 text-[13px]">{prep.toAsk.map((t, i) => <li key={i}>{t}</li>)}</ul>
                </Card>
              )}
              {prep.gaps.length > 0 && (
                <Card className="p-4">
                  <div className="mb-2 text-sm font-medium">How to talk about gaps</div>
                  <ul className="space-y-2 text-[13px]">
                    {prep.gaps.map((g, i) => (
                      <li key={i}>
                        <div className="font-medium">{g.gap}</div>
                        <div className="text-muted">{g.how}</div>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          </>
        )}
      </div>
      <Drafts {...props} />
    </div>
  );
}

/** One talking point, styled by whether the profile backs it. */
function Point({ p }: { p: PrepPoint }) {
  if (p.kind === "tip")
    return (
      <li className="flex gap-2 text-muted">
        <span className="mt-px h-fit shrink-0 rounded bg-stone-100 px-1 text-[11px] text-stone-500">Approach</span>
        <span>{p.text}</span>
      </li>
    );
  if (p.kind === "unsure")
    return (
      <li className="-mx-2 flex gap-2 rounded-md bg-amber-50 px-2 py-1">
        <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-amber-500" />
        <span>
          {p.text}
          <span className="mt-0.5 block text-[11px] text-amber-800">{p.from}</span>
        </span>
      </li>
    );
  return (
    <li className="flex gap-2">
      <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-brand-500" />
      <span>
        {p.text}
        {p.from && <span className="ml-1.5 text-[11px] whitespace-nowrap text-stone-400">From: {p.from}</span>}
      </span>
    </li>
  );
}

function Warnings({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <div className="font-medium">{title}</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {items.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

const DRAFTS: Array<{ key: DraftKind; label: string; hint: string; extra: string }> = [
  { key: "followup", label: "Follow-up", hint: "When you have heard nothing for a while after applying: politely ask how it stands.", extra: "Anything to add (optional), e.g. the contact's name" },
  { key: "thanks", label: "Thank-you note", hint: "Send it on the day of the interview or the day after.", extra: "Interviewer's name, what you talked about (optional; makes it more specific)" },
];

function Drafts({ jobId, applied, appliedAt, drafts }: Props) {
  const silent = applied && daysSince(appliedAt) > 10;
  const [kind, setKind] = useState<DraftKind>(silent ? "followup" : "thanks");
  const saved = drafts[kind];
  const [extra, setExtra] = useState(saved?.extra ?? "");
  const [subject, setSubject] = useState(saved?.subject ?? "");
  const [body, setBody] = useState(saved?.body ?? "");
  const [warnings, setWarnings] = useState<string[]>(saved?.warnings ?? []);
  const { busy, run } = useAction();
  useEffect(() => {
    setExtra(saved?.extra ?? "");
    setSubject(saved?.subject ?? "");
    setBody(saved?.body ?? "");
    setWarnings(saved?.warnings ?? []);
  }, [kind, saved?.generatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = DRAFTS.find((x) => x.key === kind)!;
  const write = () =>
    run("draft", async () => {
      const r = await api<{ draft: Draft }>(`/jobs/${jobId}/draft`, { body: { kind, extra } });
      setSubject(r.draft.subject);
      setBody(r.draft.body);
      setWarnings(r.draft.warnings ?? []);
    });
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  return (
    <Card className="h-fit overflow-hidden xl:sticky xl:top-6">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm font-medium">
        <Icon name="mail" className="size-4 text-stone-400" />
        Email drafts
      </div>
      <div className="flex gap-1 border-b border-line px-3 pt-2">
        {DRAFTS.map((x) => (
          <button
            key={x.key}
            onClick={() => setKind(x.key)}
            className={`-mb-px border-b-2 px-2 pb-2 text-[13px] ${kind === x.key ? "border-brand-600 font-medium" : "border-transparent text-muted hover:text-ink"}`}
          >
            {x.label}
            {drafts[x.key] && <span className="ml-1 inline-block size-1.5 rounded-full bg-brand-500 align-middle" />}
          </button>
        ))}
      </div>
      <div className="space-y-3 p-4">
        <div className="text-xs text-muted">{d.hint}</div>
        <textarea className={`${inputCls} min-h-14 text-[13px]`} placeholder={d.extra} value={extra} onChange={(e) => setExtra(e.target.value)} />
        <Button size="sm" variant={body ? "secondary" : "primary"} busy={busy === "draft"} onClick={write}>
          {body ? "Write again" : "Write draft"}
        </Button>
        {body && (
          <div className="space-y-2 border-t border-line pt-3">
            <input className={`${inputCls} text-[13px] font-medium`} value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Email subject" />
            <textarea className={`${inputCls} min-h-56 text-[13px] leading-relaxed`} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Email body" />
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <button className="inline-flex items-center gap-1 text-brand-700 hover:underline" onClick={() => copy(`${subject}\n\n${body}`)}>
                <Icon name="copy" className="size-3" />
                Copy subject and body
              </button>
              <a className="inline-flex items-center gap-1 text-brand-700 hover:underline" href={mailto}>
                <Icon name="external" className="size-3" />
                Open in mail app
              </a>
            </div>
            {warnings.length > 0 && <Warnings title="Please check:" items={warnings} />}
            <div className="text-[11px] text-stone-400">Edits here are not saved. Read it once more before sending, and fill in the recipient.</div>
          </div>
        )}
      </div>
    </Card>
  );
}
