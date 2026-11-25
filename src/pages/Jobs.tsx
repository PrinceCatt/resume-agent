import { useMemo, useState, type ReactNode } from "react";
import {
  ago,
  api,
  daysSince,
  EVENT_KINDS,
  eventLabel,
  go,
  hoursUntil,
  pref,
  PROGRESS,
  useApi,
  whenLabel,
  type AppState,
  type CalEvent,
  type FoundJob,
  type JobView,
  type Progress,
  type SearchKind,
  type SearchSource,
} from "../api.ts";
import { Avatar, Badge, Button, Card, Empty, FitPill, Icon, inputCls, toast, useAction } from "../components/ui.tsx";
import { Board } from "../components/Board.tsx";
import { hasProgress, isHeld, isInFlight, jobName, jobStatus, needsYou } from "../status.ts";
import { isPeak, peakEndLabel } from "../offpeak.ts";
import { factChips, isFiltering, KIND_LABEL as REQ_KIND_LABEL, KINDS as REQ_KINDS, NO_FILTER, passes, readFilter, reqStats, type ReqFilter } from "../reqs.ts";

type FilterKey = "all" | "active" | "you" | "applied" | "progress" | "skipped";
const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "In progress" },
  { key: "you", label: "Needs you" },
  { key: "applied", label: "Applied" },
  { key: "progress", label: "Moving forward" },
  { key: "skipped", label: "Skipped" },
];
type SortKey = "new" | "fit" | "updated";
type ViewKey = "list" | "board";

function matches(j: JobView, f: FilterKey) {
  if (f === "active") return isInFlight(j) || isHeld(j);
  if (f === "you") return needsYou(j);
  if (f === "applied") return j.stage === "applied";
  if (f === "progress") return hasProgress(j);
  if (f === "skipped") return j.stage === "skipped";
  return j.stage !== "skipped";
}

/** Links in whatever was pasted: an email or a list page full of them works too. */
function extractUrls(text: string) {
  const found = text.match(/https?:\/\/[^\s<>"'，。；、）)\]]+/g);
  if (found) return [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, "")))];
  return [...new Set(text.split(/\s+/).filter((t) => /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)))];
}

export default function JobsPage({ state }: { state: AppState | null }) {
  const { data, reload } = useApi<{ jobs: JobView[] }>("/jobs", ["job", "run"]);
  const [filter, setFilterState] = useState<FilterKey>(() =>
    FILTERS.some((f) => f.key === pref.get("jobs-filter")) ? (pref.get("jobs-filter") as FilterKey) : "all",
  );
  const [sort, setSortState] = useState<SortKey>(() =>
    ["new", "fit", "updated"].includes(pref.get("jobs-sort") ?? "") ? (pref.get("jobs-sort") as SortKey) : "new",
  );
  const [q, setQ] = useState("");
  const [view, setViewState] = useState<ViewKey>(() => (pref.get("jobs-view") === "board" ? "board" : "list"));
  const setView = (v: ViewKey) => {
    setViewState(v);
    setSel(new Set());
    pref.set("jobs-view", v);
  };
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [setupHidden, setSetupHidden] = useState(() => pref.get("setup-hidden") === "1");
  const { busy, run } = useAction();
  const setFilter = (f: FilterKey) => {
    setFilterState(f);
    setSel(new Set());
    pref.set("jobs-filter", f);
  };
  const setSort = (s: SortKey) => {
    setSortState(s);
    pref.set("jobs-sort", s);
  };
  const [req, setReqState] = useState<ReqFilter>(() => readFilter(pref.get("jobs-req")));
  const setReq = (r: ReqFilter) => {
    setReqState(r);
    setSel(new Set());
    pref.set("jobs-req", JSON.stringify(r));
  };
  const [showStats, setShowStatsState] = useState(() => pref.get("jobs-stats") === "1");
  const setShowStats = (v: boolean) => {
    setShowStatsState(v);
    pref.set("jobs-stats", v ? "1" : "0");
  };

  const jobs = data?.jobs ?? [];
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, jobs.filter((j) => matches(j, f.key)).length])) as Record<FilterKey, number>;
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const hit = (j: JobView) => !needle || [j.title, j.company, j.location, j.url, j.notes].some((v) => v?.toLowerCase().includes(needle));
    const list = jobs.filter((j) => matches(j, view === "board" ? "all" : filter) && hit(j) && passes(j, req));
    if (sort === "fit") list.sort((a, b) => (b.jd?.fit?.score ?? -1) - (a.jd?.fit?.score ?? -1));
    if (sort === "updated") list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return list;
  }, [jobs, filter, sort, needle, view, req]);
  const filtering = isFiltering(req);
  const selected = shown.filter((j) => sel.has(j.id));
  const allChecked = shown.length > 0 && selected.length === shown.length;
  const llmMissing = state && !state.llm.ok && state.llm.code === "no_key";
  const noBalance = state && !state.llm.ok && state.llm.code === "no_balance" ? state.llm.reason : null;

  const held = jobs.filter(isHeld).length;
  const appliedWeek = jobs.filter((j) => j.stage === "applied" && daysSince(j.appliedAt) < 7).length;
  const offers = jobs.filter((j) => j.stage === "applied" && j.progress === "offer").length;

  return (
    <div className={`mx-auto ${view === "board" ? "max-w-7xl" : "max-w-5xl"}`}>
      <header className="mb-5 flex items-end justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">Jobs</h1>
          <p className="mt-1 text-sm text-muted">Paste job links: the agent reads each posting, tailors your resume to it and fills in the application form on the site. Every application stops before the submit button and waits for you.</p>
        </div>
        {jobs.length > 0 && (
          <a
            href="/api/jobs.csv"
            className="inline-flex shrink-0 items-center gap-1.5 text-sm whitespace-nowrap text-muted hover:text-ink"
            title="Export the list as a spreadsheet (opens in Excel)"
          >
            <Icon name="download" />
            Export
          </a>
        )}
      </header>

      {llmMissing && setupHidden && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>No DeepSeek API key yet. Resumes are only really tailored and forms filled once you add one; or turn on demo mode first and try the whole flow on the local test job.</span>
          <Button size="sm" variant="primary" onClick={() => go("/settings")}>
            Open Settings
          </Button>
        </div>
      )}

      {noBalance && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <span>{noBalance.replace(/: top up.*$/, "")}. Reading, tailoring and form filling are paused instead of failing one by one. Top up on the DeepSeek platform, then continue on the right.</span>
          <div className="flex shrink-0 gap-2">
            <a className="inline-flex items-center rounded-md px-2.5 text-sm text-red-800 hover:underline" href="https://platform.deepseek.com/" target="_blank" rel="noreferrer">
              Top up
            </a>
            <Button
              size="sm"
              variant="primary"
              busy={busy === "resume"}
              onClick={() =>
                run("resume", async () => {
                  const r = await api<{ retried: number }>("/llm/resume", { body: {} });
                  toast(r.retried ? `Balance is fine; continuing ${r.retried} ${r.retried === 1 ? "job" : "jobs"}` : "Balance is fine; carry on", "ok");
                })
              }
            >
              Topped up, continue
            </Button>
          </div>
        </div>
      )}

      {!setupHidden && (
        <Setup
          state={state}
          onHide={() => {
            pref.set("setup-hidden", "1");
            setSetupHidden(true);
          }}
        />
      )}

      {jobs.length > 0 && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Needs you"
            value={counts.you}
            tone={counts.you ? "amber" : undefined}
            hint={counts.you ? "Confirm or answer" : "Nothing"}
            onClick={() => (counts.you ? go("/review") : setFilter("you"))}
          />
          <Stat label="In progress" value={counts.active} hint={counts.active ? "Reading, tailoring or filling in" : "Idle"} onClick={() => setFilter("active")} />
          <Stat label="Applied" value={counts.applied} hint={appliedWeek ? `+${appliedWeek} in the last 7 days` : "None in the last 7 days"} onClick={() => setFilter("applied")} />
          <Stat label="Moving forward" value={counts.progress} hint={offers ? `${offers} ${offers === 1 ? "offer" : "offers"}` : "Tests, interviews, offers"} onClick={() => setFilter("progress")} />
        </div>
      )}

      {held > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-white px-4 py-3 text-sm">
          <span>
            {isPeak()
              ? `${held} ${held === 1 ? "job is" : "jobs are"} waiting for DeepSeek's off-peak hours: tailoring and form filling start by themselves after ${peakEndLabel()} (half price then).`
              : `${held} ${held === 1 ? "job is" : "jobs are"} queued: tailoring and form filling start as soon as a slot is free.`}
          </span>
          <Button size="sm" busy={busy === "now"} onClick={() => run("now", () => api("/jobs/run-now", { body: {} }), "Started")}>
            Run now
          </Button>
        </div>
      )}

      <Upcoming />

      <AddBox state={state} onAdded={reload} />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        {view === "board" ? (
          <div className="text-sm text-muted">
            The board shows every job except skipped ones.{" "}
            <span className="pointer-coarse:hidden">Drag a card to another column to update its progress.</span>
            <span className="hidden pointer-coarse:inline">Applied cards have a progress picker underneath.</span>
          </div>
        ) : (
          <div className="scroll-clean -mx-1 flex max-w-full gap-1 overflow-x-auto px-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-md px-2.5 py-1 text-sm whitespace-nowrap ${filter === f.key ? "bg-white font-medium shadow-sm ring-1 ring-line" : "text-muted hover:text-ink"}`}
              >
                {f.label}
                {f.key !== "all" && counts[f.key] > 0 && <span className="ml-1 text-xs text-muted tabular-nums">{counts[f.key]}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
          <div className="flex shrink-0 rounded-md bg-stone-100 p-0.5" role="radiogroup" aria-label="View">
            {(
              [
                ["list", "List", "list"],
                ["board", "Board", "board"],
              ] as const
            ).map(([k, label, icon]) => (
              <button
                key={k}
                role="radio"
                aria-checked={view === k}
                title={label}
                onClick={() => setView(k)}
                className={`flex items-center gap-1 rounded px-2 py-1 text-[13px] ${view === k ? "bg-white font-medium shadow-sm" : "text-muted hover:text-ink"}`}
              >
                <Icon name={icon} className="size-3.5" />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
          <label className="relative min-w-0 flex-1 sm:w-52 sm:flex-none">
            <Icon name="search" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-stone-400" />
            <input className={`${inputCls} pl-8`} placeholder="Search jobs, companies, notes" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {view === "list" && (
            <select className={`${inputCls} w-auto! pr-7`} value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
              <option value="new">Recently added</option>
              <option value="fit">Fit</option>
              <option value="updated">Recently changed</option>
            </select>
          )}
        </div>
      </div>

      {jobs.length > 0 && <ReqBar value={req} onChange={setReq} showStats={showStats} onToggleStats={() => setShowStats(!showStats)} />}
      {jobs.length > 0 && showStats && <ReqStatsPanel jobs={shown} filtering={filtering} picked={req.keyword} onPick={(k) => setReq({ ...req, keyword: req.keyword === k ? "" : k })} />}

      {view === "board" && data && jobs.length > 0 ? (
        <Board jobs={shown} />
      ) : data && !shown.length ? (
        <Empty title={q ? "No matches" : filtering ? "No jobs match these filters" : jobs.length ? "No jobs in this group" : "No jobs yet"}>
          {q ? `No job contains "${q}"` : filtering ? (
            <button className="text-brand-700 hover:underline" onClick={() => setReq(NO_FILTER)}>
              Clear filters
            </button>
          ) : jobs.length ? "" : "Paste a few job links above to start."}
        </Empty>
      ) : (
        <Card className="overflow-hidden">
          {shown.length > 0 && (
            <div className="flex min-h-11 flex-wrap items-center gap-3 border-b border-line bg-paper/60 px-4 py-1.5 text-sm">
              <input
                type="checkbox"
                className="accent-brand-600"
                aria-label="Select all"
                checked={allChecked}
                onChange={() => setSel(allChecked ? new Set() : new Set(shown.map((j) => j.id)))}
              />
              {selected.length ? (
                <>
                  <span className="text-muted">{selected.length} selected</span>
                  <Button
                    size="sm"
                    variant="primary"
                    busy={busy === "pipe"}
                    onClick={() =>
                      run(
                        "pipe",
                        async () => {
                          await api("/jobs/pipeline", {
                            body: { ids: selected.map((j) => j.id) },
                          });
                          setSel(new Set());
                        },
                        "Processing the selected jobs",
                      )
                    }
                  >
                    Process
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      run("skip", async () => {
                        for (const j of selected)
                          await api(`/jobs/${j.id}`, {
                            method: "PATCH",
                            body: {
                              stage: filter === "skipped" ? "restore" : "skipped",
                            },
                          });
                        setSel(new Set());
                      })
                    }
                  >
                    {filter === "skipped" ? "Restore" : "Skip"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (!confirm(`Delete ${selected.length === 1 ? "this job" : `these ${selected.length} jobs`} with ${selected.length === 1 ? "its" : "their"} resumes and application records?`)) return;
                      void run(
                        "del",
                        async () => {
                          for (const j of selected) await api(`/jobs/${j.id}`, { method: "DELETE" });
                          setSel(new Set());
                        },
                        "Deleted",
                      );
                    }}
                  >
                    Delete
                  </Button>
                  <span className="hidden text-xs text-muted md:inline">
                    Process = take each job through its remaining steps (read → tailor resume → fill form); each one stops before submitting.
                    {state?.settings.offPeakOnly && " Tailoring and form filling wait for DeepSeek's off-peak hours."}
                  </span>
                </>
              ) : (
                <span className="text-xs text-muted">{shown.length} {shown.length === 1 ? "job" : "jobs"}</span>
              )}
            </div>
          )}
          <div className="divide-y divide-line">
            {shown.map((j) => (
              <JobRow
                key={j.id}
                job={j}
                checked={sel.has(j.id)}
                onCheck={(v) =>
                  setSel((s) => {
                    const n = new Set(s);
                    if (v) n.add(j.id);
                    else n.delete(j.id);
                    return n;
                  })
                }
              />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

/** Interviews, tests and deadlines coming up, across all jobs. */
function Upcoming() {
  const { data } = useApi<{ events: CalEvent[] }>("/schedule?upcoming=1", ["schedule", "job"]);
  const [showAll, setShowAll] = useState(false);
  const events = data?.events ?? [];
  if (!events.length) return null;
  const soon = events.filter((e) => hoursUntil(e.at) < 24 * 14);
  const list = showAll ? events : (soon.length ? soon : events).slice(0, 4);
  return (
    <Card className="mb-5 overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Icon name="calendar" className="size-4 text-stone-400" />
          Coming up
        </span>
        {events.length > list.length || showAll ? (
          <button className="text-xs text-brand-700 hover:underline" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show less" : `All ${events.length}`}
          </button>
        ) : null}
      </div>
      <ul className="divide-y divide-line">
        {list.map((e) => {
          const h = hoursUntil(e.at);
          const now = h <= 0;
          const link = e.note.match(/https?:\/\/\S+/)?.[0];
          return (
            <li key={e.id} className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-paper/60">
              <span className={`size-2 shrink-0 rounded-full ${EVENT_KINDS.find((k) => k.key === e.kind)?.dot ?? "bg-stone-400"}`} />
              <span className={`w-32 shrink-0 tabular-nums ${now ? "font-medium text-violet-800" : h < 24 ? "font-medium" : "text-muted"}`}>
                {now ? "Now" : whenLabel(e.at)}
              </span>
              <button className="min-w-0 flex-1 truncate text-left" onClick={() => go(`/jobs/${e.job_id}`)}>
                <span className="font-medium">{eventLabel(e.kind)}</span>
                <span className="text-muted">
                  {" · "}
                  {e.job_title || e.job_url}
                  {e.job_company && ` · ${e.job_company}`}
                </span>
              </button>
              {link && (
                <a href={link} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-brand-700 hover:underline" title={link}>
                  Link
                </a>
              )}
              {!now && h < 72 && (
                <span className="hidden shrink-0 text-xs text-muted sm:inline">
                  {h < 1 ? `in ${Math.max(1, Math.round(h * 60))} min` : `in ${Math.round(h)} h`}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Stat({ label, value, hint, tone, onClick }: { label: string; value: number; hint: string; tone?: "amber"; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-4 py-3 text-left transition-colors ${tone === "amber" ? "border-amber-200 bg-amber-50 hover:bg-amber-100/70" : "border-line bg-white hover:bg-paper"}`}
    >
      <div className={`text-xs ${tone === "amber" ? "text-amber-800" : "text-muted"}`}>{label}</div>
      <div className={`mt-0.5 text-2xl font-semibold tabular-nums ${tone === "amber" ? "text-amber-900" : ""}`}>{value}</div>
      <div className={`truncate text-xs ${tone === "amber" ? "text-amber-800" : "text-muted"}`}>{hint}</div>
    </button>
  );
}

const chipCls = (on: boolean) =>
  `rounded-md px-2 py-0.5 text-[13px] whitespace-nowrap ring-1 ${on ? "bg-brand-50 font-medium text-brand-700 ring-brand-200" : "bg-white text-muted ring-line hover:text-ink"}`;
const miniSelect = "h-7 rounded-md border border-line bg-white px-1.5 text-[13px] outline-none focus:border-brand-500";

/** Filters on what the postings ask for: type, experience, who may apply, materials, fit, skill. */
function ReqBar({ value: f, onChange, showStats, onToggleStats }: { value: ReqFilter; onChange: (f: ReqFilter) => void; showStats: boolean; onToggleStats: () => void }) {
  const set = (patch: Partial<ReqFilter>) => onChange({ ...f, ...patch });
  const toggleType = (t: ReqFilter["types"][number]) => set({ types: f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t] });
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
      <span className="flex flex-wrap items-center gap-1">
        {REQ_KINDS.map((t) => (
          <button key={t} className={chipCls(f.types.includes(t))} aria-pressed={f.types.includes(t)} onClick={() => toggleType(t)}>
            {REQ_KIND_LABEL[t]}
          </button>
        ))}
      </span>
      <select className={miniSelect} aria-label="Experience required" value={f.maxYears ?? ""} onChange={(e) => set({ maxYears: e.target.value === "" ? null : Number(e.target.value) })}>
        <option value="">Any experience</option>
        <option value="0">No experience</option>
        <option value="1">Up to 1 year</option>
        <option value="2">Up to 2 years</option>
      </select>
      <select className={miniSelect} aria-label="Cover letter" value={f.coverLetter} onChange={(e) => set({ coverLetter: e.target.value as ReqFilter["coverLetter"] })}>
        <option value="any">Cover letter: any</option>
        <option value="yes">Asks for a cover letter</option>
        <option value="no">No cover letter</option>
      </select>
      <select className={miniSelect} aria-label="Fit" value={f.minFit} onChange={(e) => set({ minFit: Number(e.target.value) })}>
        <option value="0">Any fit</option>
        <option value="50">Fit 50+</option>
        <option value="70">Fit 70+</option>
        <option value="85">Fit 85+</option>
      </select>
      <button className={chipCls(f.hideCitizenOnly)} aria-pressed={f.hideCitizenOnly} onClick={() => set({ hideCitizenOnly: !f.hideCitizenOnly })}>
        Hide citizens-only
      </button>
      <button className={chipCls(f.hideGraduatedOnly)} aria-pressed={f.hideGraduatedOnly} onClick={() => set({ hideGraduatedOnly: !f.hideGraduatedOnly })}>
        Hide graduates-only
      </button>
      <button className={chipCls(f.hideClosed)} aria-pressed={f.hideClosed} onClick={() => set({ hideClosed: !f.hideClosed })}>
        Hide closed
      </button>
      {f.keyword && (
        <button className={`${chipCls(true)} inline-flex items-center gap-1`} onClick={() => set({ keyword: "" })} title="Remove this skill filter">
          Skill: {f.keyword}
          <Icon name="x" className="size-3" />
        </button>
      )}
      <span className="ml-auto flex items-center gap-2">
        {isFiltering(f) && (
          <button className="text-muted hover:text-ink" onClick={() => onChange(NO_FILTER)}>
            Clear filters
          </button>
        )}
        <button className={`${chipCls(showStats)} inline-flex items-center gap-1`} aria-pressed={showStats} onClick={onToggleStats}>
          <Icon name="chart" className="size-3.5" />
          Requirements
        </button>
      </span>
    </div>
  );
}

/** Counts over the jobs on screen: what they ask for, and which skills come up most. */
function ReqStatsPanel({ jobs, filtering, picked, onPick }: { jobs: JobView[]; filtering: boolean; picked: string; onPick: (k: string) => void }) {
  const s = useMemo(() => reqStats(jobs), [jobs]);
  const known = s.total - s.noFacts;
  const group = (title: string, rows: Array<{ label: string; n: number }>, of: number) => (
    <div className="min-w-0">
      <div className="mb-1.5 text-xs font-medium text-muted">{title}</div>
      {rows.length ? (
        <div className="space-y-1">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center gap-2 text-[13px]">
              <span className="w-36 min-w-0 truncate" title={r.label}>{r.label}</span>
              <span className="h-1.5 min-w-8 flex-1 rounded-full bg-stone-100">
                <span className="block h-full rounded-full bg-brand-500" style={{ width: `${of ? Math.round((r.n / of) * 100) : 0}%` }} />
              </span>
              <span className="w-6 shrink-0 text-right text-xs text-muted tabular-nums">{r.n}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[13px] text-stone-400">None</div>
      )}
    </div>
  );
  return (
    <Card className="mb-3 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">What the postings ask for</span>
        <span className="text-xs text-muted">
          {s.total} {s.total === 1 ? "job" : "jobs"}
          {filtering ? " matching the filters" : ""}
          {s.noFacts > 0 && `; ${s.noFacts} of them were read before conditions were recorded (re-read to get them)`}
        </span>
      </div>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        {group("Type", s.types, known)}
        {group("Experience", s.years, known)}
        {group("Restrictions", s.limits, s.total)}
        {group("Documents to send", s.materials, known)}
      </div>
      {s.keywords.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium text-muted">
            Most-asked skills <span className="font-normal">· ✓ in your profile · click one to see only the jobs that ask for it</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {s.keywords.map((k) => (
              <button
                key={k.k}
                onClick={() => onPick(k.k)}
                aria-pressed={picked.toLowerCase() === k.k.toLowerCase()}
                className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] ring-1 ${
                  picked.toLowerCase() === k.k.toLowerCase()
                    ? "bg-brand-600 text-white ring-brand-600"
                    : k.have
                      ? "bg-emerald-50 text-emerald-900 ring-emerald-200 hover:ring-emerald-400"
                      : "bg-white text-ink ring-line hover:ring-stone-400"
                }`}
              >
                {k.have && <Icon name="check" className="size-3" />}
                {k.k}
                <span className="tabular-nums opacity-60">{k.n}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

const DEFAULT_QUERIES = "software engineer, backend developer, full stack developer";
const KINDS: Array<{ key: SearchKind; label: string }> = [
  { key: "fulltime", label: "Full-time (entry level)" },
  { key: "parttime", label: "Part-time" },
  { key: "internship", label: "Internship" },
];

function SearchBox({ auto, onAdded }: { auto: boolean; onAdded: () => unknown }) {
  const [queries, setQueriesState] = useState(() => pref.get("search-queries") || DEFAULT_QUERIES);
  const [kind, setKind] = useState<SearchKind>(() => (pref.get("search-kind") as SearchKind) || "fulltime");
  const [days, setDays] = useState(() => Number(pref.get("search-days")) || 7);
  const [linkedin, setLinkedin] = useState(() => pref.get("search-linkedin") !== "0");
  const [mcf, setMcf] = useState(() => pref.get("search-mcf") !== "0");
  const [easyOnly, setEasyOnly] = useState(() => pref.get("search-easy") !== "0");
  const [hideSenior, setHideSenior] = useState(() => pref.get("search-hide-senior") !== "0");
  const [hidden, setHidden] = useState(0);
  const [found, setFound] = useState<FoundJob[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { busy, run } = useAction();
  const setQueries = (v: string) => {
    setQueriesState(v);
    pref.set("search-queries", v);
  };
  const list = queries
    .split(/[,，\n]/)
    .map((q) => q.trim())
    .filter(Boolean);
  const sources: SearchSource[] = [...(linkedin ? (["linkedin"] as const) : []), ...(mcf ? (["mcf"] as const) : [])];

  const search = () =>
    run("search", async () => {
      pref.set("search-kind", kind);
      pref.set("search-days", String(days));
      pref.set("search-linkedin", linkedin ? "1" : "0");
      pref.set("search-mcf", mcf ? "1" : "0");
      pref.set("search-easy", easyOnly ? "1" : "0");
      pref.set("search-hide-senior", hideSenior ? "1" : "0");
      const r = await api<{ found: FoundJob[]; errors: string[]; hidden: number }>("/discover", {
        body: { queries: list, kind, days, sources, easyApplyOnly: easyOnly, hideSenior },
      });
      setFound(r.found);
      setErrors(r.errors);
      setHidden(r.hidden ?? 0);
      setPicked(new Set(r.found.filter((f) => !f.existingId).map((f) => f.url)));
    });
  const addPicked = () =>
    run("add", async () => {
      const urls = (found ?? []).filter((f) => picked.has(f.url) && !f.existingId).map((f) => f.url);
      const r = await api<{
        ids: number[];
        duplicates: Array<{ url: string; id: number }>;
      }>("/jobs", { body: { urls, autoApply: auto } });
      await onAdded();
      const added = new Set(urls);
      setFound((prev) => (prev ?? []).map((f) => (added.has(f.url) ? { ...f, existingId: f.existingId ?? -1 } : f)));
      setPicked(new Set());
      toast(`Added ${r.ids.length}${auto ? "; reading them and scoring the fit" : ""}${r.duplicates.length ? `; ${r.duplicates.length} already in the list` : ""}`);
    });
  const fresh = (found ?? []).filter((f) => !f.existingId);
  const toggle = (url: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(url);
      else next.delete(url);
      return next;
    });

  return (
    <div className="space-y-3">
      <input
        className={inputCls}
        placeholder="Keywords, separated by commas; each is searched separately"
        value={queries}
        onChange={(e) => setQueries(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && list.length && sources.length && search()}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <div className="flex overflow-hidden rounded-md border border-line">
          {KINDS.map((k) => (
            <button
              key={k.key}
              className={`px-2.5 py-1 ${kind === k.key ? "bg-brand-600 text-white" : "text-muted hover:bg-stone-50"}`}
              onClick={() => setKind(k.key)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-muted">
          Posted
          <select className="rounded-md border border-line bg-white px-1.5 py-1 text-sm" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d === 1 ? "in the last 24 hours" : `in the last ${d} days`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" className="accent-brand-600" checked={linkedin} onChange={(e) => setLinkedin(e.target.checked)} />
          LinkedIn
        </label>
        {linkedin && (
          <label className="flex items-center gap-1.5 text-muted" title="Easy Apply is filled in on LinkedIn itself, with no account to create on a company site">
            <input type="checkbox" className="accent-brand-600" checked={easyOnly} onChange={(e) => setEasyOnly(e.target.checked)} />
            Easy Apply only
          </label>
        )}
        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" className="accent-brand-600" checked={mcf} onChange={(e) => setMcf(e.target.checked)} />
          MyCareersFuture
        </label>
        <label className="flex items-center gap-1.5 text-muted" title="Leaves out titles with Senior, Lead, Manager, 5+ years and the like">
          <input type="checkbox" className="accent-brand-600" checked={hideSenior} onChange={(e) => setHideSenior(e.target.checked)} />
          Hide senior roles
        </label>
        <Button variant="primary" size="sm" busy={busy === "search"} disabled={!list.length || !sources.length} onClick={search}>
          Search
        </Button>
      </div>
      {errors.map((e) => (
        <div key={e} className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {e}
        </div>
      ))}
      {found && (
        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>
              Found {found.length}{found.length - fresh.length ? `, ${found.length - fresh.length} already in the list` : ""}
              {hidden ? ` (${hidden} senior ${hidden === 1 ? "role" : "roles"} not shown)` : ""}. This is only a list: jobs are read and scored once you tick and add them.
            </span>
            {fresh.length > 0 && (
              <span className="flex gap-3">
                <button className="text-brand-700 hover:underline" onClick={() => setPicked(new Set(fresh.map((f) => f.url)))}>
                  Select all
                </button>
                <button className="text-brand-700 hover:underline" onClick={() => setPicked(new Set())}>
                  Select none
                </button>
              </span>
            )}
          </div>
          {found.length === 0 ? (
            <div className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-muted">No results. Try other keywords or a longer time range.</div>
          ) : (
            <div className="max-h-[28rem] divide-y divide-line overflow-y-auto rounded-md border border-line">
              {found.map((f) => (
                <label
                  key={f.url}
                  className={`flex cursor-pointer items-start gap-2.5 px-3 py-2 text-sm hover:bg-stone-50 ${f.existingId ? "opacity-60" : ""}`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-brand-600"
                    disabled={!!f.existingId}
                    checked={!f.existingId && picked.has(f.url)}
                    onChange={(e) => toggle(f.url, e.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2">
                      <a href={f.url} target="_blank" rel="noreferrer" className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                        {f.title}
                      </a>
                      {f.existingId ? <Badge>In list</Badge> : null}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {[f.company, f.location, f.salary, f.posted ? ago(f.posted) : "", f.source === "linkedin" ? "LinkedIn" : "MyCareersFuture"]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {fresh.length > 0 && (
            <div className="mt-2 flex justify-end">
              <Button variant="primary" busy={busy === "add"} disabled={!picked.size} onClick={addPicked}>
                Add {picked.size} selected
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddBox({ state, onAdded }: { state: AppState | null; onAdded: () => unknown }) {
  const [urls, setUrls] = useState("");
  const [jdText, setJdText] = useState("");
  const [pasteJd, setPasteJd] = useState(false);
  const [mode, setModeState] = useState<"paste" | "search">(() => (pref.get("add-mode") === "search" ? "search" : "paste"));
  const setMode = (m: "paste" | "search") => {
    setModeState(m);
    pref.set("add-mode", m);
  };
  const [auto, setAutoState] = useState(() => pref.get("auto-pipeline") !== "0");
  const { busy, run } = useAction();
  const setAuto = (v: boolean) => {
    setAutoState(v);
    pref.set("auto-pipeline", v ? "1" : "0");
  };
  const found = pasteJd ? [] : extractUrls(urls);

  const add = (list: string[], text?: string) =>
    run("add", async () => {
      const r = await api<{
        ids: number[];
        duplicates: Array<{ url: string; id: number }>;
      }>("/jobs", { body: { urls: list, jdText: text, autoApply: auto } });
      setUrls("");
      setJdText("");
      await onAdded();
      if (!r.ids.length && r.duplicates.length === 1) {
        toast("This job is already in the list; opened it for you");
        go(`/jobs/${r.duplicates[0].id}`);
        return;
      }
      const parts = [];
      if (r.ids.length) parts.push(`Added ${r.ids.length}${auto ? "; reading now" : ""}`);
      if (r.duplicates.length) parts.push(`${r.duplicates.length} already in the list, not added again`);
      toast(parts.join("; "));
    });

  return (
    <Card className="mb-6 p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex gap-4 text-sm">
          {(["paste", "search"] as const).map((m) => (
            <button
              key={m}
              className={`border-b-2 pb-0.5 ${mode === m ? "border-brand-600 font-medium" : "border-transparent text-muted hover:text-ink"}`}
              onClick={() => setMode(m)}
            >
              {m === "search" ? "Search jobs" : pasteJd ? "Paste JD text" : "Paste job links"}
            </button>
          ))}
        </div>
        {mode === "paste" && (
          <button className="text-xs text-brand-700 hover:underline" onClick={() => setPasteJd(!pasteJd)}>
            {pasteJd ? "Paste links instead" : "Page won't open? Paste the JD"}
          </button>
        )}
      </div>
      {mode === "search" ? (
        <>
          <SearchBox auto={auto} onAdded={onAdded} />
          <label className="mt-3 flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="accent-brand-600" />
            After adding, run every step: read job → tailor resume → fill form (waits for you before submitting)
          </label>
        </>
      ) : (
        <>
          {pasteJd ? (
            <div className="space-y-2">
              <input className={inputCls} placeholder="Application page link (optional; without one it cannot apply for you)" value={urls} onChange={(e) => setUrls(e.target.value)} />
              <textarea className={`${inputCls} min-h-32`} placeholder="Paste the whole job description here" value={jdText} onChange={(e) => setJdText(e.target.value)} />
            </div>
          ) : (
            <textarea
              className={`${inputCls} min-h-20 font-mono text-[13px]`}
              placeholder={"One per line, as many as you like. A whole job-alert email works too: the links are picked out of it\nhttps://boards.greenhouse.io/…\nhttps://jobs.lever.co/…"}
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && found.length) add(found);
              }}
            />
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="accent-brand-600" />
              After adding, run every step: read job → tailor resume → fill form (waits for you before submitting)
            </label>
            <div className="flex items-center gap-2">
              {!pasteJd && found.length > 0 && <span className="text-xs text-muted">{found.length} {found.length === 1 ? "link" : "links"} found</span>}
              {state?.demo && (
                <Button size="sm" variant="ghost" onClick={() => add([`${window.location.origin}/fixtures/test-job.html?n=${Date.now() % 100000}`])}>
                  Add a local test job
                </Button>
              )}
              <Button
                variant="primary"
                busy={busy === "add"}
                disabled={pasteJd ? !jdText.trim() : !found.length}
                title="Ctrl+Enter"
                onClick={() => add(pasteJd ? (urls.trim() ? [urls.trim()] : []) : found, pasteJd ? jdText : undefined)}
              >
                Add{!pasteJd && found.length > 1 ? ` ${found.length}` : ""}
              </Button>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function JobRow({ job: j, checked, onCheck }: { job: JobView; checked: boolean; onCheck: (v: boolean) => void }) {
  const st = jobStatus(j);
  const { busy, run } = useAction();
  const cov = j.coverage && j.coverage.keywords.length ? j.coverage : null;
  const fit = j.jd?.fit;
  const applied = j.stage === "applied";
  const silent = applied && (j.progress ?? "applied") === "applied" && daysSince(j.appliedAt) > 14;
  const chips = applied ? [] : [...(fit?.conflict ? [{ text: fit.conflict, warn: true }] : []), ...factChips(j.jd?.facts ?? null)];

  let action: {
    label: string;
    key: string;
    fn: () => Promise<unknown>;
    primary?: boolean;
  } | null = null;
  if (!j.busy && !isInFlight(j)) {
    if (isHeld(j))
      action = {
        label: "Run now",
        key: "now",
        fn: () => api("/jobs/run-now", { body: { ids: [j.id] } }),
      };
    else if (needsYou(j))
      action = {
        label: "Open",
        key: "you",
        fn: async () => go("/review"),
        primary: true,
      };
    else if (j.stage === "new")
      action = {
        label: j.error ? "Read again" : "Read job",
        key: "parse",
        fn: () => api(`/jobs/${j.id}/parse`, { body: {} }),
      };
    else if (j.stage === "parsed")
      action = {
        label: "Tailor resume",
        key: "tailor",
        fn: () => api(`/jobs/${j.id}/tailor`, { body: {} }),
        primary: !j.notice,
      };
    else if (j.stage === "tailored")
      action = {
        label: j.run ? "Apply again" : "Start applying",
        key: "apply",
        fn: () => api(`/jobs/${j.id}/apply`, { body: {} }),
        primary: !j.run,
      };
  }

  let line: ReactNode = null;
  if (j.error) line = <div className="mt-1 text-[13px] text-red-700">{j.error}</div>;
  else if (j.run?.status === "failed" && j.run.outcome && !applied) line = <div className="mt-1 text-[13px] text-red-700">{j.run.outcome}</div>;
  else if (j.notice) line = <div className="mt-1 text-[13px] text-amber-800">{j.notice}</div>;
  else if (silent) line = <div className="mt-1 text-[13px] text-muted">No reply two weeks after applying: follow up, or mark it as rejected.</div>;
  else if (j.notes) line = <div className="mt-1 truncate text-[13px] text-muted">Notes: {j.notes}</div>;

  const control = applied ? (
    <select
      aria-label="Progress after applying"
      className="h-8 w-28 rounded-md border border-line bg-white px-1.5 text-[13px] outline-none focus:border-brand-500"
      value={j.progress ?? "applied"}
      onChange={(e) =>
        run("progress", () =>
          api(`/jobs/${j.id}`, {
            method: "PATCH",
            body: { progress: e.target.value as Progress },
          }),
        )
      }
    >
      {PROGRESS.map((p) => (
        <option key={p.key} value={p.key}>
          {p.label}
        </option>
      ))}
    </select>
  ) : action ? (
    <Button size="sm" variant={action.primary ? "primary" : "secondary"} busy={busy === action.key} onClick={() => run(action!.key, action!.fn)}>
      {action.label}
    </Button>
  ) : null;

  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-paper/60">
      <input type="checkbox" className="mt-1.5 accent-brand-600 sm:mt-3" checked={checked} onChange={(e) => onCheck(e.target.checked)} aria-label="Select" />
      <Avatar name={j.company || jobName(j)} className="mt-0.5 hidden size-9 sm:grid" />
      <div className="min-w-0 flex-1">
        <button className="block w-full min-w-0 text-left" onClick={() => go(`/jobs/${j.id}`)}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate font-medium">{jobName(j)}</span>
            <Badge tone={st.tone} pulse={st.pulse}>
              {st.label}
            </Badge>
            {j.warnings > 0 && !applied && <Badge tone="amber">{j.warnings} to check in resume</Badge>}
            {j.nextEvent && hoursUntil(j.nextEvent.at) < 24 * 7 && (
              <span
                className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs ${hoursUntil(j.nextEvent.at) < 24 ? "bg-violet-100 font-medium text-violet-800" : "bg-violet-50 text-violet-700"}`}
              >
                <Icon name="calendar" className="size-3" />
                {whenLabel(j.nextEvent.at)} {eventLabel(j.nextEvent.kind)}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[13px] text-muted">
            {[j.company, j.location].filter(Boolean).join(" · ") || j.url}
            <span className="text-stone-400"> · {applied && j.appliedAt ? `applied ${ago(j.appliedAt)}` : `added ${ago(j.createdAt)}`}</span>
          </div>
          {chips.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {chips.map((c) => (
                <span key={c.text} className={`rounded px-1.5 py-px text-[11px] ${c.warn ? "bg-amber-50 text-amber-800" : "bg-stone-100 text-stone-600"}`}>
                  {c.text}
                </span>
              ))}
            </div>
          )}
          {line}
        </button>
        {(fit || control) && (
          <div className="mt-2 flex items-center justify-between gap-2 sm:hidden">
            {fit ? <FitPill score={fit.score} /> : <span />}
            {control}
          </div>
        )}
      </div>
      <div className="hidden shrink-0 flex-col items-end gap-1 pt-0.5 sm:flex">
        {fit && <FitPill score={fit.score} />}
        {cov && (
          <div className="text-[11px] text-muted tabular-nums" title="Posting keywords in the resume: original → tailored / total">
            Keywords {cov.before.length}→{cov.after.length}/{cov.keywords.length}
          </div>
        )}
      </div>
      <div className="hidden w-28 shrink-0 justify-end pt-0.5 sm:flex">{control}</div>
    </div>
  );
}

function Setup({ state, onHide }: { state: AppState | null; onHide: () => void }) {
  if (!state) return null;
  // Connecting happens on demand, so remember that it worked once.
  if (state.browser.status === "on") pref.set("browser-connected", "1");
  const browserDone = pref.get("browser-connected") === "1";
  const p = state.profile;
  const items: Array<{
    done: boolean;
    title: string;
    desc: string;
    cta: string;
    go: () => void;
  }> = [
    {
      done: state.demo || state.settings.hasKey,
      title: "Connect a model",
      desc: state.demo ? "Demo mode is on: get to know the flow first" : "Enter a DeepSeek API key",
      cta: "Open Settings",
      go: () => go("/settings"),
    },
    {
      done: p.basics && p.bullets > 0,
      title: "Check your profile",
      desc: "Name, phone, email and every entry",
      cta: "Open Profile",
      go: () => go("/profile"),
    },
    {
      done: p.facts > 0,
      title: "Add extra facts",
      desc: "Internships, projects and numbers your resume leaves out",
      cta: "Add them",
      go: () => go("/profile"),
    },
    {
      done: p.answers > 0 && p.answered >= Math.min(4, p.answers),
      title: "Common questions",
      desc: `${p.answered}/${p.answers} answered: work pass, start date…`,
      cta: "Answer them",
      go: () => go("/profile"),
    },
    {
      done: browserDone,
      title: "Connect your browser",
      desc: "Install an extension and the agent fills forms in tabs of your signed-in Edge",
      cta: "Open Settings",
      go: () => go("/settings"),
    },
  ];
  const done = items.filter((i) => i.done);
  const todo = items.filter((i) => !i.done);
  if (!todo.length) return null;
  return (
    <Card className="mb-5 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-sm font-medium">
          Before you start
          <span className="flex items-center gap-1" aria-label={`${done.length}/${items.length} done`}>
            {items.map((it) => (
              <span key={it.title} className={`h-1.5 w-5 rounded-full ${it.done ? "bg-brand-500" : "bg-stone-200"}`} />
            ))}
          </span>
        </div>
        <button className="text-xs text-muted hover:text-ink" onClick={onHide}>
          Don't show again
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {todo.map((it) => (
          <button
            key={it.title}
            onClick={it.go}
            className="group flex gap-2.5 rounded-md border border-line px-3 py-2.5 text-left hover:border-brand-200 hover:bg-brand-50/40"
          >
            <span className="mt-0.5 size-4 shrink-0 rounded-full border border-stone-300" />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">{it.title}</span>
              <span className="block text-xs text-muted">{it.desc}</span>
              <span className="mt-1 block text-xs font-medium text-brand-700 group-hover:underline">{it.cta} →</span>
            </span>
          </button>
        ))}
      </div>
      {done.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {done.map((it) => (
            <span key={it.title} className="flex items-center gap-1">
              <Icon name="check" className="size-3 text-brand-600" />
              {it.title}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}
