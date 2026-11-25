import { useEffect, useState } from "react";
import { api, daysSince, localTime, type Draft, type DraftKind, type Prep, type PrepPoint, type PrepQuestion } from "../api.ts";
import { Badge, Button, Card, Empty, Icon, inputCls, toast, useAction, type Tone } from "../components/ui.tsx";

const QKIND: Record<PrepQuestion["kind"], { label: string; tone: Tone }> = {
  behavioral: { label: "行为", tone: "blue" },
  technical: { label: "技术", tone: "violet" },
  role: { label: "岗位", tone: "green" },
  resume: { label: "简历", tone: "amber" },
};

const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast("已复制"), () => toast("复制失败", "err"));

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
  if (!hasJd) return <Empty title="先读取岗位">面试准备要根据岗位要求来写。</Empty>;
  const start = () => run("prep", () => api(`/jobs/${jobId}/prep`, { body: {} }), prep ? "重新生成中" : "开始生成，大约半分钟");
  const allOpen = !!prep && open.size === prep.questions.length;
  const unsure = prep ? prep.questions.reduce((n, q) => n + q.points.filter((p) => p.kind === "unsure").length, 0) : 0;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Icon name="spark" className="size-4 text-brand-600" />
              面试准备
            </div>
            <div className="mt-0.5 text-[13px] text-muted">
              按这个岗位和你的资料库写：可能被问的问题和可以讲的经历、自我介绍、反问的问题。只用资料库里的事实。
              {prep && <span className="text-stone-400"> · 生成于 {localTime(prep.generatedAt)}</span>}
            </div>
          </div>
          <Button variant={prep ? "secondary" : "primary"} busy={prepping || busy === "prep"} disabled={prepping} onClick={start}>
            {prepping ? "生成中…" : prep ? "重新生成" : "生成面试准备"}
          </Button>
        </Card>
        {prepError && !prepping && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">没生成出来：{prepError}</div>}
        {!prep && !prepping && !prepError && (
          <Empty title="还没有面试准备">{props.applied ? "约到面试之前生成一份，对着练。" : "一般约到面试再生成；现在生成也可以。"}</Empty>
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
                  <div className="text-sm font-medium">自我介绍（30–45 秒）</div>
                  <button className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline" onClick={() => copy(prep.pitch)}>
                    <Icon name="copy" className="size-3" />
                    复制
                  </button>
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{prep.pitch}</p>
                {prep.pitchWarnings.length > 0 && <Warnings title="说之前核对一下，这几处资料库里对不上：" items={prep.pitchWarnings} />}
              </Card>
            )}
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
                <div className="text-sm font-medium">
                  可能被问的问题 <span className="font-normal text-muted">（{prep.questions.length}）</span>
                </div>
                <button className="text-xs text-brand-700 hover:underline" onClick={() => setOpen(allOpen ? new Set() : new Set(prep.questions.map((_, i) => i)))}>
                  {allOpen ? "全部收起" : "全部展开"}
                </button>
              </div>
              <div className="px-4 pt-2 text-xs text-muted">
                先自己想怎么答，再点开看可以讲的经历。绿点是资料库里写过的事，「思路」是答题方法，不是你的经历。
              </div>
              {unsure > 0 && (
                <div className="mx-4 mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  有 {unsure} 条要点在资料库里找不到依据（标黄）。别照着说：真做过就补进资料库，这里会自动变绿；没做过就别提。
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
                              {q.points.filter((p) => p.kind === "unsure").length} 条要点待核对
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
                  <div className="mb-2 text-sm font-medium">可以反问面试官</div>
                  <ul className="list-disc space-y-1 pl-5 text-[13px]">{prep.toAsk.map((t, i) => <li key={i}>{t}</li>)}</ul>
                </Card>
              )}
              {prep.gaps.length > 0 && (
                <Card className="p-4">
                  <div className="mb-2 text-sm font-medium">短板怎么说</div>
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
        <span className="mt-px h-fit shrink-0 rounded bg-stone-100 px-1 text-[11px] text-stone-500">思路</span>
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
        {p.from && <span className="ml-1.5 text-[11px] whitespace-nowrap text-stone-400">出自：{p.from}</span>}
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
  { key: "followup", label: "跟进邮件", hint: "投了一段时间没回音时，礼貌问一下进度。", extra: "补充（可选），比如联系人名字" },
  { key: "thanks", label: "面试后感谢信", hint: "面试当天或第二天发。", extra: "面试官名字、聊了什么（可选，写了会更具体）" },
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
        邮件草稿
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
          {body ? "重新写" : "写草稿"}
        </Button>
        {body && (
          <div className="space-y-2 border-t border-line pt-3">
            <input className={`${inputCls} text-[13px] font-medium`} value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="邮件标题" />
            <textarea className={`${inputCls} min-h-56 text-[13px] leading-relaxed`} value={body} onChange={(e) => setBody(e.target.value)} aria-label="邮件正文" />
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <button className="inline-flex items-center gap-1 text-brand-700 hover:underline" onClick={() => copy(`${subject}\n\n${body}`)}>
                <Icon name="copy" className="size-3" />
                复制标题和正文
              </button>
              <a className="inline-flex items-center gap-1 text-brand-700 hover:underline" href={mailto}>
                <Icon name="external" className="size-3" />
                用邮件 App 打开
              </a>
            </div>
            {warnings.length > 0 && <Warnings title="核对一下：" items={warnings} />}
            <div className="text-[11px] text-stone-400">这里的修改不会保存；发之前再读一遍，把收件人填上。</div>
          </div>
        )}
      </div>
    </Card>
  );
}
