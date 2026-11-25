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
  { key: "all", label: "全部" },
  { key: "active", label: "进行中" },
  { key: "you", label: "等你处理" },
  { key: "applied", label: "已投递" },
  { key: "progress", label: "有进展" },
  { key: "skipped", label: "已跳过" },
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
          <h1 className="text-xl font-semibold tracking-tight">岗位</h1>
          <p className="mt-1 text-sm text-muted">贴链接进来，助手会读岗位、按岗位改简历、去网站上填申请表。每一份都停在提交按钮前，等你确认。</p>
        </div>
        {jobs.length > 0 && (
          <a
            href="/api/jobs.csv"
            className="inline-flex shrink-0 items-center gap-1.5 text-sm whitespace-nowrap text-muted hover:text-ink"
            title="把列表导出成表格（Excel 可以直接打开）"
          >
            <Icon name="download" />
            导出表格
          </a>
        )}
      </header>

      {llmMissing && setupHidden && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>还没填 DeepSeek API key。填上之后才会真正改简历、填表；也可以先开演示模式，用本地测试岗位走一遍流程。</span>
          <Button size="sm" variant="primary" onClick={() => go("/settings")}>
            去设置
          </Button>
        </div>
      )}

      {noBalance && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <span>{noBalance.replace(/：充值后.*$/, "")}。读取、改简历、填表都先停下，不会一个个报错。到 DeepSeek 后台充值后点右边继续。</span>
          <div className="flex shrink-0 gap-2">
            <a className="inline-flex items-center rounded-md px-2.5 text-sm text-red-800 hover:underline" href="https://platform.deepseek.com/" target="_blank" rel="noreferrer">
              去充值
            </a>
            <Button
              size="sm"
              variant="primary"
              busy={busy === "resume"}
              onClick={() =>
                run("resume", async () => {
                  const r = await api<{ retried: number }>("/llm/resume", { body: {} });
                  toast(r.retried ? `余额够了，继续处理 ${r.retried} 个岗位` : "余额够了，可以继续用", "ok");
                })
              }
            >
              充好了，继续
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
            label="等你处理"
            value={counts.you}
            tone={counts.you ? "amber" : undefined}
            hint={counts.you ? "去确认或回答" : "没有"}
            onClick={() => (counts.you ? go("/review") : setFilter("you"))}
          />
          <Stat label="进行中" value={counts.active} hint={counts.active ? "读取、改简历或填表" : "空闲"} onClick={() => setFilter("active")} />
          <Stat label="已投递" value={counts.applied} hint={appliedWeek ? `近 7 天 +${appliedWeek}` : "近 7 天没有"} onClick={() => setFilter("applied")} />
          <Stat label="有进展" value={counts.progress} hint={offers ? `${offers} 个 Offer` : "笔试、面试、Offer"} onClick={() => setFilter("progress")} />
        </div>
      )}

      {held > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-white px-4 py-3 text-sm">
          <span>
            {isPeak()
              ? `${held} 个岗位在等 DeepSeek 闲时，${peakEndLabel()} 以后自动开始改简历、填表（那时半价）。`
              : `${held} 个岗位在排队，有空位就开始改简历、填表。`}
          </span>
          <Button size="sm" busy={busy === "now"} onClick={() => run("now", () => api("/jobs/run-now", { body: {} }), "开始处理")}>
            现在就跑
          </Button>
        </div>
      )}

      <Upcoming />

      <AddBox state={state} onAdded={reload} />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        {view === "board" ? (
          <div className="text-sm text-muted">
            看板显示全部岗位（不含已跳过），
            <span className="pointer-coarse:hidden">把卡片拖到别的列就是改进展。</span>
            <span className="hidden pointer-coarse:inline">已投递的卡片下面可以直接改进展。</span>
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
          <div className="flex shrink-0 rounded-md bg-stone-100 p-0.5" role="radiogroup" aria-label="显示方式">
            {(
              [
                ["list", "列表", "list"],
                ["board", "看板", "board"],
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
            <input className={`${inputCls} pl-8`} placeholder="搜岗位、公司、备注" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {view === "list" && (
            <select className={`${inputCls} w-auto! pr-7`} value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="排序">
              <option value="new">最近加入</option>
              <option value="fit">匹配度</option>
              <option value="updated">最近变动</option>
            </select>
          )}
        </div>
      </div>

      {jobs.length > 0 && <ReqBar value={req} onChange={setReq} showStats={showStats} onToggleStats={() => setShowStats(!showStats)} />}
      {jobs.length > 0 && showStats && <ReqStatsPanel jobs={shown} filtering={filtering} picked={req.keyword} onPick={(k) => setReq({ ...req, keyword: req.keyword === k ? "" : k })} />}

      {view === "board" && data && jobs.length > 0 ? (
        <Board jobs={shown} />
      ) : data && !shown.length ? (
        <Empty title={q ? "没有搜到" : filtering ? "没有符合筛选条件的岗位" : jobs.length ? "这个分类下没有岗位" : "还没有岗位"}>
          {q ? `没有包含「${q}」的岗位` : filtering ? (
            <button className="text-brand-700 hover:underline" onClick={() => setReq(NO_FILTER)}>
              清除筛选
            </button>
          ) : jobs.length ? "" : "在上面贴几个岗位链接开始。"}
        </Empty>
      ) : (
        <Card className="overflow-hidden">
          {shown.length > 0 && (
            <div className="flex min-h-11 flex-wrap items-center gap-3 border-b border-line bg-paper/60 px-4 py-1.5 text-sm">
              <input
                type="checkbox"
                className="accent-brand-600"
                aria-label="全选"
                checked={allChecked}
                onChange={() => setSel(allChecked ? new Set() : new Set(shown.map((j) => j.id)))}
              />
              {selected.length ? (
                <>
                  <span className="text-muted">已选 {selected.length}</span>
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
                        "开始处理所选岗位",
                      )
                    }
                  >
                    一键处理
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
                    {filter === "skipped" ? "恢复" : "跳过"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (!confirm(`删除这 ${selected.length} 个岗位和它们的简历、投递记录？`)) return;
                      void run(
                        "del",
                        async () => {
                          for (const j of selected) await api(`/jobs/${j.id}`, { method: "DELETE" });
                          setSel(new Set());
                        },
                        "已删除",
                      );
                    }}
                  >
                    删除
                  </Button>
                  <span className="hidden text-xs text-muted md:inline">
                    一键处理 = 每个岗位把剩下的步骤走完（读取 → 改简历 → 填表），提交前都会停下。
                    {state?.settings.offPeakOnly && "改简历和填表会等到 DeepSeek 闲时。"}
                  </span>
                </>
              ) : (
                <span className="text-xs text-muted">{shown.length} 个岗位</span>
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
          接下来
        </span>
        {events.length > list.length || showAll ? (
          <button className="text-xs text-brand-700 hover:underline" onClick={() => setShowAll(!showAll)}>
            {showAll ? "收起" : `全部 ${events.length} 项`}
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
              <span className={`w-24 shrink-0 tabular-nums ${now ? "font-medium text-violet-800" : h < 24 ? "font-medium" : "text-muted"}`}>
                {now ? "进行中" : whenLabel(e.at)}
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
                  链接
                </a>
              )}
              {!now && h < 72 && (
                <span className="hidden shrink-0 text-xs text-muted sm:inline">
                  {h < 1 ? `${Math.max(1, Math.round(h * 60))} 分钟后` : `${Math.round(h)} 小时后`}
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
      <span className="flex items-center gap-1">
        {REQ_KINDS.map((t) => (
          <button key={t} className={chipCls(f.types.includes(t))} aria-pressed={f.types.includes(t)} onClick={() => toggleType(t)}>
            {REQ_KIND_LABEL[t]}
          </button>
        ))}
      </span>
      <select className={miniSelect} aria-label="经验要求" value={f.maxYears ?? ""} onChange={(e) => set({ maxYears: e.target.value === "" ? null : Number(e.target.value) })}>
        <option value="">经验不限</option>
        <option value="0">不要经验</option>
        <option value="1">最多 1 年</option>
        <option value="2">最多 2 年</option>
      </select>
      <select className={miniSelect} aria-label="求职信" value={f.coverLetter} onChange={(e) => set({ coverLetter: e.target.value as ReqFilter["coverLetter"] })}>
        <option value="any">求职信不限</option>
        <option value="yes">要求求职信</option>
        <option value="no">不要求求职信</option>
      </select>
      <select className={miniSelect} aria-label="匹配度" value={f.minFit} onChange={(e) => set({ minFit: Number(e.target.value) })}>
        <option value="0">匹配度不限</option>
        <option value="50">匹配度 50+</option>
        <option value="70">匹配度 70+</option>
        <option value="85">匹配度 85+</option>
      </select>
      <button className={chipCls(f.hideCitizenOnly)} aria-pressed={f.hideCitizenOnly} onClick={() => set({ hideCitizenOnly: !f.hideCitizenOnly })}>
        不看仅限公民
      </button>
      <button className={chipCls(f.hideGraduatedOnly)} aria-pressed={f.hideGraduatedOnly} onClick={() => set({ hideGraduatedOnly: !f.hideGraduatedOnly })}>
        不看须已毕业
      </button>
      <button className={chipCls(f.hideClosed)} aria-pressed={f.hideClosed} onClick={() => set({ hideClosed: !f.hideClosed })}>
        不看已关闭
      </button>
      {f.keyword && (
        <button className={`${chipCls(true)} inline-flex items-center gap-1`} onClick={() => set({ keyword: "" })} title="去掉这个技能筛选">
          技能：{f.keyword}
          <Icon name="x" className="size-3" />
        </button>
      )}
      <span className="ml-auto flex items-center gap-2">
        {isFiltering(f) && (
          <button className="text-muted hover:text-ink" onClick={() => onChange(NO_FILTER)}>
            清除筛选
          </button>
        )}
        <button className={`${chipCls(showStats)} inline-flex items-center gap-1`} aria-pressed={showStats} onClick={onToggleStats}>
          <Icon name="chart" className="size-3.5" />
          要求统计
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
              <span className="w-24 shrink-0 truncate">{r.label}</span>
              <span className="h-1.5 min-w-0 flex-1 rounded-full bg-stone-100">
                <span className="block h-full rounded-full bg-brand-500" style={{ width: `${of ? Math.round((r.n / of) * 100) : 0}%` }} />
              </span>
              <span className="w-6 shrink-0 text-right text-xs text-muted tabular-nums">{r.n}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[13px] text-stone-400">没有</div>
      )}
    </div>
  );
  return (
    <Card className="mb-3 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">要求统计</span>
        <span className="text-xs text-muted">
          {filtering ? "按当前筛选，" : ""}
          {s.total} 个岗位
          {s.noFacts > 0 && `，其中 ${s.noFacts} 个是旧的读取结果、没有条件信息（重新读取就有）`}
        </span>
      </div>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        {group("类型", s.types, known)}
        {group("经验要求", s.years, known)}
        {group("限制", s.limits, s.total)}
        {group("要交的材料", s.materials, known)}
      </div>
      {s.keywords.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium text-muted">
            最常要求的技能 <span className="font-normal">· ✓ 你的简历里有 · 点一下只看要这个技能的岗位</span>
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
  { key: "fulltime", label: "全职（入门级）" },
  { key: "parttime", label: "兼职" },
  { key: "internship", label: "实习" },
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
      toast(`加入了 ${r.ids.length} 个${auto ? "，正在读取和评估匹配度" : ""}${r.duplicates.length ? `；${r.duplicates.length} 个已在列表里` : ""}`);
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
        placeholder="关键词，逗号分隔，每个分别搜"
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
          发布于
          <select className="rounded-md border border-line bg-white px-1.5 py-1 text-sm" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d === 1 ? "24 小时内" : `${d} 天内`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" className="accent-brand-600" checked={linkedin} onChange={(e) => setLinkedin(e.target.checked)} />
          LinkedIn
        </label>
        {linkedin && (
          <label className="flex items-center gap-1.5 text-muted" title="Easy Apply 在 LinkedIn 里直接填，不用去公司网站注册账号">
            <input type="checkbox" className="accent-brand-600" checked={easyOnly} onChange={(e) => setEasyOnly(e.target.checked)} />
            只要 Easy Apply
          </label>
        )}
        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" className="accent-brand-600" checked={mcf} onChange={(e) => setMcf(e.target.checked)} />
          MyCareersFuture
        </label>
        <label className="flex items-center gap-1.5 text-muted" title="标题里有 Senior、Lead、Manager、5+ years 之类的不列出来">
          <input type="checkbox" className="accent-brand-600" checked={hideSenior} onChange={(e) => setHideSenior(e.target.checked)} />
          不看资深岗
        </label>
        <Button variant="primary" size="sm" busy={busy === "search"} disabled={!list.length || !sources.length} onClick={search}>
          搜索
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
              找到 {found.length} 个{found.length - fresh.length ? `，其中 ${found.length - fresh.length} 个已在列表里` : ""}
              {hidden ? `（另有 ${hidden} 个资深岗没列出）` : ""}；只是列出来，勾选后加入才会读取和评估
            </span>
            {fresh.length > 0 && (
              <span className="flex gap-3">
                <button className="text-brand-700 hover:underline" onClick={() => setPicked(new Set(fresh.map((f) => f.url)))}>
                  全选
                </button>
                <button className="text-brand-700 hover:underline" onClick={() => setPicked(new Set())}>
                  全不选
                </button>
              </span>
            )}
          </div>
          {found.length === 0 ? (
            <div className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-muted">没有结果。换个关键词，或者把时间放宽一点</div>
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
                      {f.existingId ? <Badge>已在列表</Badge> : null}
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
                加入选中的 {picked.size} 个
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
        toast("这个岗位已经在列表里了，已为你打开");
        go(`/jobs/${r.duplicates[0].id}`);
        return;
      }
      const parts = [];
      if (r.ids.length) parts.push(`加入了 ${r.ids.length} 个${auto ? "，正在读取" : ""}`);
      if (r.duplicates.length) parts.push(`${r.duplicates.length} 个已经在列表里，没有重复加`);
      toast(parts.join("；"));
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
              {m === "search" ? "搜索岗位" : pasteJd ? "粘贴 JD 文本" : "粘贴岗位链接"}
            </button>
          ))}
        </div>
        {mode === "paste" && (
          <button className="text-xs text-brand-700 hover:underline" onClick={() => setPasteJd(!pasteJd)}>
            {pasteJd ? "改为贴链接" : "页面打不开？直接贴 JD"}
          </button>
        )}
      </div>
      {mode === "search" ? (
        <>
          <SearchBox auto={auto} onAdded={onAdded} />
          <label className="mt-3 flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="accent-brand-600" />
            加入后自动走完：读岗位 → 改简历 → 填表（提交前等你确认）
          </label>
        </>
      ) : (
        <>
          {pasteJd ? (
            <div className="space-y-2">
              <input className={inputCls} placeholder="申请页链接（可选，没有就不能自动投）" value={urls} onChange={(e) => setUrls(e.target.value)} />
              <textarea className={`${inputCls} min-h-32`} placeholder="把岗位描述整段贴进来" value={jdText} onChange={(e) => setJdText(e.target.value)} />
            </div>
          ) : (
            <textarea
              className={`${inputCls} min-h-20 font-mono text-[13px]`}
              placeholder={"一行一个，可以一次贴很多；整封招聘邮件贴进来也行，会自动挑出链接\nhttps://boards.greenhouse.io/…\nhttps://jobs.lever.co/…"}
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
              加入后自动走完：读岗位 → 改简历 → 填表（提交前等你确认）
            </label>
            <div className="flex items-center gap-2">
              {!pasteJd && found.length > 0 && <span className="text-xs text-muted">识别到 {found.length} 个链接</span>}
              {state?.demo && (
                <Button size="sm" variant="ghost" onClick={() => add([`${window.location.origin}/fixtures/test-job.html?n=${Date.now() % 100000}`])}>
                  加一个本地测试岗位
                </Button>
              )}
              <Button
                variant="primary"
                busy={busy === "add"}
                disabled={pasteJd ? !jdText.trim() : !found.length}
                title="Ctrl+Enter"
                onClick={() => add(pasteJd ? (urls.trim() ? [urls.trim()] : []) : found, pasteJd ? jdText : undefined)}
              >
                添加{!pasteJd && found.length > 1 ? ` ${found.length} 个` : ""}
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
        label: "现在就跑",
        key: "now",
        fn: () => api("/jobs/run-now", { body: { ids: [j.id] } }),
      };
    else if (needsYou(j))
      action = {
        label: "去处理",
        key: "you",
        fn: async () => go("/review"),
        primary: true,
      };
    else if (j.stage === "new")
      action = {
        label: j.error ? "重新读取" : "读取岗位",
        key: "parse",
        fn: () => api(`/jobs/${j.id}/parse`, { body: {} }),
      };
    else if (j.stage === "parsed")
      action = {
        label: "改简历",
        key: "tailor",
        fn: () => api(`/jobs/${j.id}/tailor`, { body: {} }),
        primary: !j.notice,
      };
    else if (j.stage === "tailored")
      action = {
        label: j.run ? "重新投递" : "开始投递",
        key: "apply",
        fn: () => api(`/jobs/${j.id}/apply`, { body: {} }),
        primary: !j.run,
      };
  }

  let line: ReactNode = null;
  if (j.error) line = <div className="mt-1 text-[13px] text-red-700">{j.error}</div>;
  else if (j.run?.status === "failed" && j.run.outcome && !applied) line = <div className="mt-1 text-[13px] text-red-700">{j.run.outcome}</div>;
  else if (j.notice) line = <div className="mt-1 text-[13px] text-amber-800">{j.notice}</div>;
  else if (silent) line = <div className="mt-1 text-[13px] text-muted">投了两周还没回音，可以跟进一下，或者标成未通过。</div>;
  else if (j.notes) line = <div className="mt-1 truncate text-[13px] text-muted">备注：{j.notes}</div>;

  const control = applied ? (
    <select
      aria-label="投递后的进展"
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
      <input type="checkbox" className="mt-1.5 accent-brand-600 sm:mt-3" checked={checked} onChange={(e) => onCheck(e.target.checked)} aria-label="选择" />
      <Avatar name={j.company || jobName(j)} className="mt-0.5 hidden size-9 sm:grid" />
      <div className="min-w-0 flex-1">
        <button className="block w-full min-w-0 text-left" onClick={() => go(`/jobs/${j.id}`)}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate font-medium">{jobName(j)}</span>
            <Badge tone={st.tone} pulse={st.pulse}>
              {st.label}
            </Badge>
            {j.warnings > 0 && !applied && <Badge tone="amber">简历有 {j.warnings} 处要核对</Badge>}
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
            <span className="text-stone-400"> · {applied && j.appliedAt ? `投递于 ${ago(j.appliedAt)}` : `${ago(j.createdAt)}加入`}</span>
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
          <div className="text-[11px] text-muted tabular-nums" title="改好的简历里出现的岗位关键词：原版 → 现在 / 总数">
            关键词 {cov.before.length}→{cov.after.length}/{cov.keywords.length}
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
      title: "接上模型",
      desc: state.demo ? "现在是演示模式，可以先熟悉流程" : "填 DeepSeek API key",
      cta: "去设置",
      go: () => go("/settings"),
    },
    {
      done: p.basics && p.bullets > 0,
      title: "核对资料库",
      desc: "姓名、电话、邮箱和每段经历",
      cta: "去资料库",
      go: () => go("/profile"),
    },
    {
      done: p.facts > 0,
      title: "补充素材",
      desc: "简历上没写的实习、项目和数字",
      cta: "去填写",
      go: () => go("/profile"),
    },
    {
      done: p.answers > 0 && p.answered >= Math.min(4, p.answers),
      title: "常见问题",
      desc: `已回答 ${p.answered}/${p.answers}：工作许可、入职时间…`,
      cta: "去回答",
      go: () => go("/profile"),
    },
    {
      done: browserDone,
      title: "连接你的浏览器",
      desc: "装一个扩展，助手就在你已登录的 Edge 里开标签页填表",
      cta: "去设置",
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
          开始之前
          <span className="flex items-center gap-1" aria-label={`完成 ${done.length}/${items.length}`}>
            {items.map((it) => (
              <span key={it.title} className={`h-1.5 w-5 rounded-full ${it.done ? "bg-brand-500" : "bg-stone-200"}`} />
            ))}
          </span>
        </div>
        <button className="text-xs text-muted hover:text-ink" onClick={onHide}>
          不再显示
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
