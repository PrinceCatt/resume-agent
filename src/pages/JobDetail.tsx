import { useEffect, useState } from "react";
import { api, go, localTime, PROGRESS, rmb, tokens, useApi, type CalEvent, type Draft, type DraftKind, type Fit, type JobFacts, type JobView, type Prep, type Progress, type ResumeDoc, type RunView, type Step, type Tailored } from "../api.ts";
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

  if (error) return <Empty title="打不开这个岗位">{error}</Empty>;
  if (!data) return null;
  const j = data.job;
  const st = jobStatus(j);
  const flight = isInFlight(j);
  const waiting = j.run?.status === "need_user" || j.run?.status === "awaiting_confirm";
  const patch = (body: object, ok?: string) => run("patch", () => api(`/jobs/${id}`, { method: "PATCH", body }), ok);

  return (
    <div className="mx-auto max-w-6xl">
      <button className="mb-3 text-sm text-muted hover:text-ink" onClick={() => go("/")}>
        ← 岗位
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
                原页面
                <Icon name="external" className="size-3" />
              </a>
            )}
            {j.tokens > 0 && (
              <span className="text-xs text-stone-400" title="这个岗位读取、改简历、填表一共用掉的模型 token；钱数按 DeepSeek 价目和每次调用的时段（高峰 / 闲时）估算">
                用了 {tokens(j.tokens)} tokens · 约 {rmb(j.cost)}
              </span>
            )}
          </div>
          {j.error && <div className="mt-2 text-sm text-red-700">{j.error}</div>}
          {!j.error && j.notice && <div className="mt-2 text-sm text-amber-800">{j.notice}</div>}
          {isHeld(j) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 text-sm text-muted">
              {isPeak()
                ? `在等 DeepSeek 闲时，${peakEndLabel()} 以后自动${j.held === "apply" ? "开始填表" : "改简历"}（那时半价）。`
                : `在排队，有空位就${j.held === "apply" ? "开始填表" : "改简历"}。`}
              <button
                className="text-brand-700 hover:underline disabled:opacity-50"
                disabled={busy === "now"}
                onClick={() => void run("now", () => api("/jobs/run-now", { body: { ids: [id] } }), "开始处理")}
              >
                现在就跑
              </button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button busy={busy === "tailor"} disabled={flight || !j.jd} onClick={() => run("tailor", () => api(`/jobs/${id}/tailor`, { body: {} }), "开始改简历")}>
            {data.tailored ? "重新改简历" : "改简历"}
          </Button>
          <Button
            variant="primary"
            busy={busy === "apply"}
            disabled={flight || !j.url || waiting}
            onClick={() => {
              if (j.stage === "applied" && !confirm("这个岗位已经投过了，确定再投一次？")) return;
              void run("apply", async () => {
                await api(`/jobs/${id}/apply`, { body: {} });
                setTab("runs");
              }, "开始填写申请表");
            }}
          >
            {j.run ? "再投一次" : "开始投递"}
          </Button>
          <Menu
            label="更多"
            items={[
              { label: "重新读取岗位", onClick: () => void run("parse", () => api(`/jobs/${id}/parse`, { body: {} }), "重新读取中"), hidden: flight },
              { label: "标为已投递（我自己投的）", onClick: () => void patch({ stage: "applied" }, "已标为已投递"), hidden: j.stage === "applied" },
              { label: j.stage === "skipped" ? "恢复" : "跳过这个岗位", onClick: () => void patch({ stage: j.stage === "skipped" ? "restore" : "skipped" }) },
              {
                label: "删除",
                danger: true,
                onClick: () => {
                  if (confirm("删除这个岗位、它的简历和投递记录？")) void run("del", async () => { await api(`/jobs/${id}`, { method: "DELETE" }); go("/"); });
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
            ["resume", "简历"],
            ["jd", j.jd?.fit ? `岗位要求 · 匹配 ${j.jd.fit.score}` : "岗位要求"],
            ["runs", `投递记录${data.runs.length ? ` (${data.runs.length})` : ""}`],
            ["prep", data.prepping ? "面试准备 · 生成中" : "面试准备"],
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
    { label: "读取岗位", state: j.busy === "parsing" ? "current" : j.jd ? "done" : j.error ? "error" : "todo" },
    { label: "改简历", state: j.busy === "tailoring" ? "current" : detail.tailored ? "done" : j.error && j.jd ? "error" : "todo" },
    {
      label: "填写申请",
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
    { label: "确认提交", state: applied ? "done" : r?.status === "awaiting_confirm" ? "wait" : "todo" },
    { label: applied && prog.key !== "applied" ? prog.label : "已投递", state: applied ? "done" : "todo" },
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
            {s.state === "wait" && "（等你）"}
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
    }, "备注已保存");
  };
  return (
    <Card className="mb-4 space-y-3 p-4">
      {applied && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-sm font-medium">进展</span>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="投递后的进展">
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
            {j.appliedAt && `投递于 ${localTime(j.appliedAt)}`}
            {j.progressAt && j.progress && j.progress !== "applied" && log.length < 2 && ` · 更新于 ${localTime(j.progressAt)}`}
          </span>
        </div>
      )}
      {applied && log.length > 1 && (
        <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted" aria-label="进展记录">
          {log.map((l, i) => (
            <li key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-stone-300">→</span>}
              <span className={i === log.length - 1 ? "font-medium text-ink" : ""}>
                {PROGRESS.find((p) => p.key === l.progress)?.label === "等回音" ? "投递" : PROGRESS.find((p) => p.key === l.progress)?.label}
              </span>
              <span className="text-stone-400">{localTime(l.ts).split(" ")[0]}</span>
            </li>
          ))}
        </ol>
      )}
      <Schedule jobId={j.id} events={events} applied={applied} />
      <textarea
        className={`${inputCls} min-h-9 text-[13px]`}
        rows={1}
        placeholder={applied ? "备注：联系人、面试时间、笔试题型、跟进记录…" : "备注：内推人、截止日期、为什么想投…"}
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
          <div className="text-sm font-medium">匹配度</div>
          {fit.verdict && <div className="mt-0.5 text-[13px] leading-snug text-muted">{fit.verdict}</div>}
        </div>
      </div>
      {fit.conflict && <div className="mt-3 rounded bg-amber-50 px-2 py-1.5 text-[13px] text-amber-900">和你想找的冲突：{fit.conflict}（分数最多 45）</div>}
      {fit.strengths.length > 0 && (
        <ul className="mt-3 space-y-1 text-[13px]">
          {fit.strengths.map((s, i) => {
            const bad = s.includes("（资料库里没找到");
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
          评估把资料库里没有的 {fit.unsupported.join("、")} 算成了你的优势，分数可能偏高。真会的话补进资料库，再在「更多」里重新读取岗位。
        </div>
      )}
      <div className="mt-3 text-xs text-stone-400">资料库改了之后，在「更多 → 重新读取岗位」里重新评估。</div>
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
                <div className="mb-1 text-[13px] font-medium text-muted">必须</div>
                <ul className="list-disc space-y-0.5 pl-5 text-sm">{jd.requirements.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}
            {jd.niceToHave.length > 0 && (
              <div>
                <div className="mb-1 text-[13px] font-medium text-muted">加分</div>
                <ul className="list-disc space-y-0.5 pl-5 text-sm">{jd.niceToHave.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}
          </Card>
        ) : (
          <Empty title="还没读取到岗位内容">{j.busy === "parsing" ? "正在读取…" : "点「更多 → 重新读取岗位」，或在下面直接贴 JD。"}</Empty>
        )}
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium">原文</div>
            <button className="text-xs text-brand-700 hover:underline" onClick={() => setEditing(!editing)}>
              {editing ? "收起" : "修改 / 贴 JD"}
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
                  }, "已保存，重新分析中")
                }
              >
                保存并重新分析
              </Button>
            </div>
          ) : (
            <pre className="max-h-96 overflow-auto font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-muted">{j.jdText || "（空）"}</pre>
          )}
        </Card>
      </div>
      <div className="order-first grid content-start gap-4 sm:grid-cols-2 xl:order-none xl:grid-cols-1">
        {jd?.fit && <FitCard fit={jd.fit} />}
        {jd && <FactsCard facts={jd.facts} closed={jd.closed} />}
        {jd && jd.keywords.length > 0 && (
          <Card className="h-fit p-4">
            <div className="mb-2 text-sm font-medium">关键词</div>
            <div className="flex flex-wrap gap-1.5">
              {jd.keywords.map((k) => (
                <span key={k} className={`rounded px-1.5 py-0.5 text-xs ${after.has(k.toLowerCase()) ? "bg-brand-50 text-brand-700" : "bg-stone-100 text-stone-500"}`}>
                  {k}
                </span>
              ))}
            </div>
            {detail.tailored && <div className="mt-3 text-xs text-muted">绿色 = 改好的简历里出现了。灰色的是你的资料里没有的，不会硬塞进去。</div>}
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
        <div className="mb-1 text-sm font-medium">岗位条件</div>
        <div className="text-xs text-muted">这是旧的读取结果，没有条件信息。点「更多 → 重新读取岗位」就有。</div>
      </Card>
    );
  const rows: Array<[string, string, boolean?]> = [
    ["类型", typeLabel(f) || "没写"],
    ["经验", f.minYears === null ? "没写" : yearsLabel(f.minYears), (f.minYears ?? 0) >= 2],
    ["学历", f.degree ? DEGREE_LABEL[f.degree] : "没写"],
    ["在读 / 毕业", f.student === "graduated" ? "须已毕业" : f.student === "enrolled" ? "须在读" : "没写", f.student === "graduated"],
    ["谁能申请", f.workAuth ? AUTH_LABEL[f.workAuth] : "没写", !!f.workAuth],
    ["开始时间", f.start || "没写"],
    ["办公", f.workplace ? { onsite: "到岗", hybrid: "混合", remote: "远程" }[f.workplace] : "没写"],
    ["薪资", f.salary || "没写"],
    ["要交的材料", f.materials.length ? f.materials.map((m) => MATERIAL_LABEL[m]).join("、") : "没写"],
  ];
  return (
    <Card className="h-fit p-4">
      <div className="mb-2 flex items-center justify-between text-sm font-medium">
        岗位条件
        {closed && <Badge tone="red">已关闭</Badge>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        {rows.map(([k, v, warn]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className={v === "没写" ? "text-stone-400" : warn ? "text-amber-800" : ""}>{v}</dd>
          </div>
        ))}
      </dl>
      {f.coverLetterAsk && <div className="mt-2 rounded bg-paper px-2 py-1.5 text-xs text-muted">求职信要写：{f.coverLetterAsk}</div>}
      <div className="mt-2 text-[11px] text-stone-400">只取岗位原文写明的，没写的不猜。</div>
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
    return <Empty title={j.busy === "tailoring" ? "正在按岗位改简历…" : "还没改简历"}>{j.jd ? "点右上角「改简历」。" : "先读取岗位。"}</Empty>;
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
            <div className="mb-1 font-medium">要你核对的地方</div>
            <ul className="list-disc space-y-0.5 pl-5">{t.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </div>
        )}
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">改了什么</div>
            <div className="flex flex-wrap gap-x-3 text-xs text-muted">
              {rewritten > 0 && <span>改写了 {rewritten} 条要点</span>}
              {cov.keywords.length > 0 && (
                <span>
                  关键词覆盖：原版 {cov.before.length} → 现在 <b className="text-ink">{cov.after.length}</b> / {cov.keywords.length}
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
                        const plainOrig = orig?.replace(/^（素材库）/, "");
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
                                  <span className="min-w-0 flex-1">原文：{orig}</span>
                                  {plainOrig && plainOrig !== b.text && (
                                    <button
                                      className="inline-flex shrink-0 items-center gap-0.5 text-stone-400 hover:text-brand-700"
                                      title="把这条换回原文"
                                      onClick={() => edit((d) => (d.sections[si].entries[ei].bullets[bi].text = plainOrig))}
                                    >
                                      <Icon name="undo" className="size-3" />
                                      用原文
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                            <button
                              title="去掉这条"
                              aria-label="去掉这条"
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
            <div className="text-sm font-medium">求职信</div>
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
                    }, "求职信写好了")
                  }
                >
                  {busy === "cover" ? "正在写…" : "写一封"}
                </button>
              )}
              {cover.trim() && (
                <button
                  className="text-xs text-brand-700 hover:underline"
                  onClick={() => navigator.clipboard.writeText(cover).then(() => toast("已复制"), () => toast("复制失败", "err"))}
                >
                  复制
                </button>
              )}
              {j.hasCover && (
                <a className="text-xs text-brand-700 hover:underline" href={`/api/jobs/${j.id}/cover.pdf`} target="_blank" rel="noreferrer">
                  看 PDF
                </a>
              )}
            </div>
          </div>
          <textarea
            className={`${inputCls} min-h-24 text-[13px] leading-relaxed`}
            placeholder={j.jd?.facts?.materials.includes("cover_letter") ? "这个岗位要求求职信，点右上角「写一封」" : "没有求职信。岗位要求、或申请表要的时候会自动写一封"}
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
              }, "已保存，PDF 已更新")
            }
          >
            保存并更新 PDF
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
              撤销修改
            </Button>
          )}
          {dirty && <span className="text-xs text-amber-700">有没保存的修改，预览还是旧的</span>}
          <a className="ml-auto inline-flex items-center gap-1 text-sm text-brand-700 hover:underline" href={`/api/jobs/${j.id}/resume.pdf?download=1`}>
            <Icon name="download" />
            下载 PDF
          </a>
        </div>
      </div>

      <div className="xl:sticky xl:top-6 xl:h-[calc(100vh-3rem)]">
        <div className="mb-2 flex items-center justify-between text-xs text-muted">
          <span>预览（上传的就是这份）{t.scale && t.scale < 1 ? ` · 为放进一页字号缩到 ${Math.round(t.scale * 100)}%` : ""}</span>
          <a className="text-brand-700 hover:underline" href={`/api/jobs/${j.id}/resume.pdf`} target="_blank" rel="noreferrer">
            打开 PDF
          </a>
        </div>
        <div className="overflow-hidden rounded-lg border border-line bg-white shadow-sm">
          <iframe key={previewKey} title="简历预览" src={`/api/jobs/${j.id}/resume.html`} className="aspect-[210/297] w-full" />
        </div>
      </div>
    </div>
  );
}

const RUN_TEXT: Record<string, string> = {
  submitted: "已提交",
  finished: "已结束",
  failed: "失败",
  cancelled: "已放弃",
  interrupted: "中断",
};

function RunsTab({ detail }: { detail: Detail }) {
  const [latest, ...older] = detail.runs;
  if (!latest) return <Empty title="还没投递过">简历改好后点「开始投递」，助手会在浏览器里打开申请页去填。</Empty>;
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <RunCard run={latest} showJob={false} showLastScreen />
        {older.length > 0 && (
          <Card className="divide-y divide-line">
            <div className="px-4 py-2 text-xs font-medium text-muted">之前的投递</div>
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
          这次的每一步
          <span className="text-xs font-normal text-muted">{localTime(latest.created_at)} 开始</span>
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
          <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-stone-300" />操作</span>
          <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-amber-500" />等你</span>
          <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-violet-500" />拦下的提交</span>
          <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-sky-400" />模型说明</span>
          <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-red-500" />出错</span>
        </div>
      </Card>
    </div>
  );
}
