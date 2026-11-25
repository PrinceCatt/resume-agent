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
        <h1 className="text-xl font-semibold tracking-tight">统计</h1>
        <p className="mt-1 text-sm text-muted">只算这里记下的岗位（已跳过的不算）。投递后的进展要你在岗位上标，标得越全，这里越准。</p>
      </header>

      {f.added === 0 ? (
        <Empty title="还没有数据">加几个岗位、投出去之后，这里会显示投递漏斗、回复率和每周投了多少。</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="已投递" value={String(f.applied)} sub={thisWeek ? `本周 ${thisWeek} 份` : "本周还没投"} />
            <Tile
              label="回复率"
              value={rr.applied ? `${pct(rr.replied, rr.applied)}%` : "—"}
              sub={rr.applied ? `投满一周的 ${rr.applied} 份里 ${rr.replied} 份有回音` : f.applied ? "投递都还不到一周" : "还没投递"}
            />
            <Tile label="进入面试" value={String(f.interview)} sub={f.offer ? `${f.offer} 个 Offer` : "还没有 Offer"} />
            <Tile
              label="回音要等"
              value={data.medianReplyDays === null ? "—" : data.medianReplyDays < 1 ? "不到 1 天" : `${Math.round(data.medianReplyDays)} 天`}
              sub="从投递到第一次回音（中位数）"
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Funnel f={f} />
            <Weekly weeks={data.weekly} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Meters
              title="匹配度和回音"
              desc="按读取岗位时的匹配度分组。可以拿来定「自动流程的匹配度门槛」：低分组几乎没回音，就把门槛设高一点。"
              rows={data.byFit}
            />
            <Meters title="哪个网站回得多" desc="按岗位链接所在的网站分组。" rows={data.bySite} />
          </div>

          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
            {data.upcoming > 0 && (
              <button className="inline-flex items-center gap-1 text-brand-700 hover:underline" onClick={() => go("/")}>
                <Icon name="calendar" className="size-3" />
                接下来有 {data.upcoming} 项日程
              </button>
            )}
            {data.ended > 0 && <span>已结束 {data.ended} 份（未通过或放弃）</span>}
            {data.tokens > 0 && <span>模型一共用了 {tokens(data.tokens)} tokens</span>}
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
    ["加入", f.added],
    ["已投递", f.applied],
    ["有回音", f.replied],
    ["进入面试", f.interview],
    ["拿到 Offer", f.offer],
  ];
  return (
    <Card className="p-5">
      <h2 className="font-medium">投递漏斗</h2>
      <p className="mt-0.5 mb-4 text-xs text-muted">每一步走到了多少个岗位；右边是占上一步的比例。「有回音」含被拒。</p>
      <ul className="space-y-2.5">
        {rows.map(([label, n], i) => {
          const prev = i ? rows[i - 1][1] : 0;
          return (
            <li key={label} className="grid grid-cols-[5.5rem_minmax(0,1fr)_4.5rem] items-center gap-3 text-[13px]" title={`${label}：${n}`}>
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
        加入的 {f.added} 个里，读取了 {f.parsed} 个，按岗位改过简历的 {f.tailored} 个。
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
    return `${Number(m)}/${Number(d)}`;
  };
  const total = weeks.reduce((n, w) => n + w.applied, 0);

  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium">每周投递</h2>
        <button className="text-xs text-brand-700 hover:underline" onClick={() => setTable(!table)}>
          {table ? "看图" : "看数字"}
        </button>
      </div>
      <p className="mt-0.5 mb-4 text-xs text-muted">最近 10 周，共 {total} 份；周一开始算一周。</p>
      {table ? (
        <table className="w-full text-[13px] tabular-nums">
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              <th className="py-1 text-left font-normal">那一周</th>
              <th className="py-1 text-right font-normal">加入</th>
              <th className="py-1 text-right font-normal">投递</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.start} className="border-b border-line/60 last:border-0">
                <td className="py-1">{label(w.start)} 起</td>
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
                    aria-label={`${label(w.start)} 那周投了 ${w.applied} 份，加入 ${w.added} 个`}
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
                          <span className="font-semibold">{w.applied} 份</span>
                          <span className="text-white/70"> · {label(w.start)} 那周 · 加入 {w.added}</span>
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
        <div className="text-sm text-muted">投递之后才有。</div>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.key} className="text-[13px]" title={`${r.label}：投了 ${r.applied}，${r.replied} 份有回音，${r.positive} 份进了笔试/面试/Offer`}>
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{r.label}</span>
                <span className="shrink-0 text-xs text-muted tabular-nums">
                  投了 {r.applied} · <span className="font-medium text-ink">{pct(r.replied, r.applied)}%</span> 有回音
                  {r.positive > 0 && ` · ${r.positive} 个往下走了`}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-chart-track">
                {r.replied > 0 && <div className="h-full rounded-full bg-chart" style={{ width: `${pct(r.replied, r.applied)}%` }} />}
              </div>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && rows.reduce((n, r) => n + r.applied, 0) < 15 && <div className="mt-3 text-xs text-stone-400">投得还少，比例波动会很大，先参考着看。</div>}
    </Card>
  );
}
