import { useState } from "react";
import { go, tokens, useApi, type StatBucket, type Stats } from "../api.ts";
import { Card, Empty, Icon } from "../components/ui.tsx";

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export default function StatsPage() {
  const { data } = useApi<Stats>("/stats", ["job", "schedule"]);
  if (!data) return null;
  const f = data.funnel;
  const thisWeek = data.weekly[data.weekly.length - 1]?.applied ?? 0;
  const rr = data.responseRate;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Stats</h1>
        <p className="mt-1 text-sm text-muted">Counts only the jobs recorded here (skipped ones excluded). Progress after applying is whatever you mark on each job: the more you mark, the more accurate this gets.</p>
      </header>

      {f.added === 0 ? (
        <Empty title="No data yet">Once you add some jobs and apply, this shows your funnel, reply rate and applications per week.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Applied" value={String(f.applied)} sub={thisWeek ? `${thisWeek} this week` : "None this week yet"} />
            <Tile
              label="Reply rate"
              value={rr.applied ? `${pct(rr.replied, rr.applied)}%` : "—"}
              sub={rr.applied ? `${rr.replied} of ${rr.applied} sent over a week ago got a reply` : f.applied ? "Every application is under a week old" : "No applications yet"}
            />
            <Tile label="Interviews" value={String(f.interview)} sub={f.offer ? `${f.offer} ${f.offer === 1 ? "offer" : "offers"}` : "No offers yet"} />
            <Tile
              label="Time to reply"
              value={data.medianReplyDays === null ? "—" : data.medianReplyDays < 1 ? "< 1 day" : `${Math.round(data.medianReplyDays)} ${Math.round(data.medianReplyDays) === 1 ? "day" : "days"}`}
              sub="From applying to the first reply (median)"
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Funnel f={f} />
            <Weekly weeks={data.weekly} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Meters
              title="Fit and replies"
              desc="Grouped by the fit score when the job was read. Use it to set the minimum fit for the automatic flow: if low scores hardly ever get a reply, raise it."
              rows={data.byFit}
            />
            <Meters title="Which sites reply" desc="Grouped by the site the job link is on." rows={data.bySite} />
          </div>

          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
            {data.upcoming > 0 && (
              <button className="inline-flex items-center gap-1 text-brand-700 hover:underline" onClick={() => go("/")}>
                <Icon name="calendar" className="size-3" />
                {data.upcoming} upcoming {data.upcoming === 1 ? "event" : "events"}
              </button>
            )}
            {data.ended > 0 && <span>{data.ended} ended (rejected or withdrawn)</span>}
            {data.tokens > 0 && <span>{tokens(data.tokens)} model tokens used in total</span>}
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold">{value}</div>
      <div className="text-xs text-muted">{sub}</div>
    </Card>
  );
}

/** Each stage as a bar on one baseline, scaled to the jobs added; the step conversion beside it. */
function Funnel({ f }: { f: Stats["funnel"] }) {
  // Each step is a subset of the one above (tailoring is not: you can apply with the original resume).
  const rows: Array<[string, number]> = [
    ["Added", f.added],
    ["Applied", f.applied],
    ["Replied", f.replied],
    ["Interview", f.interview],
    ["Offer", f.offer],
  ];
  return (
    <Card className="p-5">
      <h2 className="font-medium">Funnel</h2>
      <p className="mt-0.5 mb-4 text-xs text-muted">How many jobs reached each step; on the right, the share of the step before. "Replied" includes rejections.</p>
      <ul className="space-y-2.5">
        {rows.map(([label, n], i) => {
          const prev = i ? rows[i - 1][1] : 0;
          return (
            <li key={label} className="grid grid-cols-[5.5rem_minmax(0,1fr)_4.5rem] items-center gap-3 text-[13px]" title={`${label}: ${n}`}>
              <span className="text-muted">{label}</span>
              <span className="h-5">
                {n > 0 && <span className="block h-full rounded-r-[4px] bg-chart" style={{ width: `${Math.max(1.5, pct(n, f.added))}%` }} />}
              </span>
              <span className="text-right tabular-nums">
                <span className="font-medium">{n}</span>
                {i > 0 && <span className="ml-1.5 text-xs text-muted">{prev ? `${pct(n, prev)}%` : "—"}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 text-xs text-muted">
        Of the {f.added} added, {f.parsed} were read and {f.tailored} got a tailored resume.
      </div>
    </Card>
  );
}

// Weekly chart geometry (px): 160 tall = 8 headroom + 132 plot + 20 for the week labels.
const PLOT_TOP = 8;
const PLOT_H = 132;

function Weekly({ weeks }: { weeks: Stats["weekly"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(...weeks.map((w) => w.applied));
  const top = max <= 4 ? 4 : Math.ceil(max / 5) * 5;
  const label = (s: string) => {
    const [, m, d] = s.split("-");
    return `${Number(d)}/${Number(m)}`;
  };
  const total = weeks.reduce((n, w) => n + w.applied, 0);

  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium">Applications per week</h2>
        <button className="text-xs text-brand-700 hover:underline" onClick={() => setTable(!table)}>
          {table ? "Chart" : "Numbers"}
        </button>
      </div>
      <p className="mt-0.5 mb-4 text-xs text-muted">Last 10 weeks, {total} in total; weeks start on Monday.</p>
      {table ? (
        <table className="w-full text-[13px] tabular-nums">
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              <th className="py-1 text-left font-normal">Week of</th>
              <th className="py-1 text-right font-normal">Added</th>
              <th className="py-1 text-right font-normal">Applied</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.start} className="border-b border-line/60 last:border-0">
                <td className="py-1">{label(w.start)}</td>
                <td className="py-1 text-right text-muted">{w.added}</td>
                <td className="py-1 text-right font-medium">{w.applied}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="flex gap-2">
          <div className="relative h-40 w-5 shrink-0 text-right text-[11px] text-stone-400 tabular-nums">
            {[top, top / 2, 0].map((v) => (
              <span key={v} className="absolute right-0 -translate-y-1/2" style={{ top: PLOT_TOP + PLOT_H * (1 - v / top) }}>
                {v}
              </span>
            ))}
          </div>
          <div className="relative min-w-0 flex-1">
            {[top, top / 2].map((v) => (
              <div key={v} className="pointer-events-none absolute inset-x-0 h-px bg-line" style={{ top: PLOT_TOP + PLOT_H * (1 - v / top) }} />
            ))}
            <div className="flex h-40 items-stretch">
              {weeks.map((w, i) => {
                const h = (w.applied / top) * 100;
                const on = hover === i;
                return (
                  <div
                    key={w.start}
                    tabIndex={0}
                    aria-label={`Week of ${label(w.start)}: ${w.applied} applied, ${w.added} added`}
                    className="group relative flex flex-1 flex-col items-center outline-none"
                    onPointerEnter={() => setHover(i)}
                    onPointerLeave={() => setHover((x) => (x === i ? null : x))}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover((x) => (x === i ? null : x))}
                  >
                    <div className="relative flex w-full flex-1 items-end justify-center border-b border-stone-300 pt-2">
                      {w.applied > 0 && (
                        <div className={`w-full max-w-6 rounded-t-[4px] bg-chart transition-opacity ${hover !== null && !on ? "opacity-50" : ""}`} style={{ height: `${h}%` }} />
                      )}
                      {on && (
                        // Just above the bar; the outer columns anchor inward so it is never cut off.
                        <div
                          className={`absolute z-10 rounded-md bg-ink px-2 py-1 text-xs whitespace-nowrap text-white shadow ${
                            i >= weeks.length - 2 ? "right-0" : i <= 1 ? "left-0" : "left-1/2 -translate-x-1/2"
                          }`}
                          style={{ bottom: `calc(${h}% + 6px)` }}
                        >
                          <span className="font-semibold">{w.applied} applied</span>
                          <span className="text-white/70"> · week of {label(w.start)} · {w.added} added</span>
                        </div>
                      )}
                    </div>
                    <span className={`h-5 pt-1 text-[11px] tabular-nums ${on ? "text-ink" : "text-stone-400"} ${i % 2 && weeks.length > 6 ? "max-sm:invisible" : ""}`}>{label(w.start)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

/** One row per group: how many applied, and the share that got any reply as a meter. */
function Meters({ title, desc, rows }: { title: string; desc: string; rows: StatBucket[] }) {
  return (
    <Card className="p-5">
      <h2 className="font-medium">{title}</h2>
      <p className="mt-0.5 mb-4 text-xs text-muted">{desc}</p>
      {!rows.length ? (
        <div className="text-sm text-muted">Shows up once you have applied.</div>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.key} className="text-[13px]" title={`${r.label}: ${r.applied} applied, ${r.replied} replied, ${r.positive} reached a test, interview or offer`}>
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{r.label}</span>
                <span className="shrink-0 text-xs text-muted tabular-nums">
                  {r.applied} applied · <span className="font-medium text-ink">{pct(r.replied, r.applied)}%</span> replied
                  {r.positive > 0 && ` · ${r.positive} moved forward`}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-chart-track">
                {r.replied > 0 && <div className="h-full rounded-full bg-chart" style={{ width: `${pct(r.replied, r.applied)}%` }} />}
              </div>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && rows.reduce((n, r) => n + r.applied, 0) < 15 && <div className="mt-3 text-xs text-stone-400">Still few applications: these rates swing a lot, so take them as a rough guide.</div>}
    </Card>
  );
}
