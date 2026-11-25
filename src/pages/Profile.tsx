import { useEffect, useRef, useState } from "react";
import { api, ago, useApi, type AskedQuestion, type Basics, type Profile } from "../api.ts";
import { Button, Card, Field, inputCls, toast, useAction } from "../components/ui.tsx";

const rid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const BASICS: Array<[keyof Basics, string, string?]> = [
  ["name", "姓名（简历上显示）", "Alex Tan"],
  ["firstName", "名（First name）"],
  ["lastName", "姓（Last name）"],
  ["email", "邮箱"],
  ["phoneCountryCode", "国家区号", "+65"],
  ["phone", "电话"],
  ["location", "所在地"],
  ["linkedin", "LinkedIn"],
  ["github", "GitHub"],
  ["website", "个人网站"],
];

export default function ProfilePage() {
  const { data } = useApi<{ profile: Profile; commonQuestions: string[] }>("/profile", []);
  const asked = useApi<{ asked: AskedQuestion[] }>("/profile/asked", ["profile", "run"]);
  const [p, setP] = useState<Profile | null>(null);
  const [dirty, setDirty] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    if (data && !dirty) setP(data.profile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  if (!p) return null;

  const edit = (fn: (d: Profile) => void) => {
    const d = structuredClone(p);
    fn(d);
    setP(d);
    setDirty(true);
  };
  const save = () =>
    run("save", async () => {
      const r = await api<{ profile: Profile }>("/profile", { method: "PUT", body: p });
      setP(r.profile);
      setDirty(false);
    }, "资料库已保存");

  const importPdf = (f: File) =>
    run("import", async () => {
      const r = await api<{ profile: Profile }>("/profile/import", { raw: f });
      setP(r.profile);
      setDirty(true);
      toast("已从 PDF 读出内容，核对后点「保存」才会生效");
    });

  const norm = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim();
  const have = new Set(p.answers.map((a) => norm(a.q)));
  const templates = (data?.commonQuestions ?? []).filter((q) => !have.has(norm(q)));
  const pendingAsked = (asked.data?.asked ?? []).filter((a) => !have.has(norm(a.q)));
  const unanswered = p.answers.filter((a) => !a.a.trim()).length;
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const nav: Array<[string, string, string?]> = [
    ["p-basics", "基本信息", !p.basics.name || !p.basics.email || !p.basics.phone ? "没填全" : undefined],
    ["p-resume", "简历内容"],
    ["p-skills", "技能"],
    ["p-facts", "素材库", p.extraFacts.trim() ? undefined : "空"],
    ["p-answers", "常见问题", unanswered || pendingAsked.length ? `${unanswered + pendingAsked.length} 个待填` : undefined],
  ];

  return (
    <div className="mx-auto max-w-4xl pb-20">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">资料库</h1>
          <p className="mt-1 text-sm text-muted">改简历、填申请表都只从这里取材料：模型可以挑选、排序、换说法，但不会加进这里没有的经历、数字或技能。</p>
        </div>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept="application/pdf" hidden onChange={(e) => e.target.files?.[0] && importPdf(e.target.files[0])} />
          <Button busy={busy === "import"} onClick={() => fileRef.current?.click()}>
            从 PDF 导入
          </Button>
          <a href="/api/profile/resume.html" target="_blank" rel="noreferrer">
            <Button>看原版简历</Button>
          </a>
        </div>
      </header>

      <nav className="scroll-clean sticky top-0 z-[5] -mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-line bg-paper/95 px-4 py-2 backdrop-blur md:-mx-8 md:px-8" aria-label="跳到">
        {nav.map(([id, label, hint]) => (
          <button key={id} onClick={() => jump(id)} className="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] text-muted hover:bg-white hover:text-ink">
            {label}
            {hint && <span className="rounded-full bg-amber-100 px-1.5 text-[11px] leading-4 text-amber-800">{hint}</span>}
          </button>
        ))}
      </nav>

      <div className="space-y-5">
        <Card className="scroll-mt-16 p-5">
          <h2 id="p-basics" className="mb-3 scroll-mt-16 font-medium">基本信息</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {BASICS.map(([k, label, ph]) => (
              <Field key={k} label={label}>
                <input className={inputCls} placeholder={ph} value={p.basics[k]} onChange={(e) => edit((d) => (d.basics[k] = e.target.value))} />
              </Field>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="p-resume" className="scroll-mt-16 font-medium">简历内容</h2>
            <Button size="sm" onClick={() => edit((d) => d.sections.push({ id: rid("sec"), heading: "New Section", entries: [] }))}>
              加一个板块
            </Button>
          </div>
          <Field label="简介（可选，一两句）">
            <textarea className={`${inputCls} text-[13px]`} value={p.summary} onChange={(e) => edit((d) => (d.summary = e.target.value))} />
          </Field>
          <div className="mt-4 space-y-4">
            {p.sections.map((s, si) => (
              <div key={s.id} className="rounded-md border border-line">
                <div className="flex items-center gap-2 border-b border-line bg-paper/70 px-3 py-2">
                  <input
                    className="min-w-0 flex-1 bg-transparent text-sm font-semibold tracking-wide uppercase outline-none"
                    value={s.heading}
                    onChange={(e) => edit((d) => (d.sections[si].heading = e.target.value))}
                  />
                  <IconBtn title="上移" disabled={si === 0} onClick={() => edit((d) => d.sections.splice(si - 1, 0, d.sections.splice(si, 1)[0]))}>↑</IconBtn>
                  <IconBtn title="下移" disabled={si === p.sections.length - 1} onClick={() => edit((d) => d.sections.splice(si + 1, 0, d.sections.splice(si, 1)[0]))}>↓</IconBtn>
                  <IconBtn title="删除板块" onClick={() => confirm(`删除板块「${s.heading}」？`) && edit((d) => d.sections.splice(si, 1))}>×</IconBtn>
                </div>
                <div className="divide-y divide-line">
                  {s.entries.map((e, ei) => (
                    <div key={e.id} className="space-y-2 p-3">
                      <div className="grid gap-2 sm:grid-cols-[1fr_180px]">
                        <input className={`${inputCls} font-medium`} placeholder="学校 / 公司 / 项目（纯列表可留空）" value={e.title} onChange={(ev) => edit((d) => (d.sections[si].entries[ei].title = ev.target.value))} />
                        <input className={inputCls} placeholder="时间" value={e.dates} onChange={(ev) => edit((d) => (d.sections[si].entries[ei].dates = ev.target.value))} />
                        <input className={inputCls} placeholder="学位 / 职位" value={e.subtitle} onChange={(ev) => edit((d) => (d.sections[si].entries[ei].subtitle = ev.target.value))} />
                        <input className={inputCls} placeholder="地点" value={e.location} onChange={(ev) => edit((d) => (d.sections[si].entries[ei].location = ev.target.value))} />
                      </div>
                      <div className="space-y-1.5 pl-1">
                        {e.bullets.map((b, bi) => (
                          <div key={b.id} className="group flex gap-2">
                            <span className="mt-2.5 size-1 shrink-0 rounded-full bg-stone-400" />
                            <textarea
                              className={`${inputCls} text-[13px] leading-snug`}
                              value={b.text}
                              onChange={(ev) => edit((d) => (d.sections[si].entries[ei].bullets[bi].text = ev.target.value))}
                            />
                            <IconBtn title="删除这条" onClick={() => edit((d) => d.sections[si].entries[ei].bullets.splice(bi, 1))}>×</IconBtn>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-3 pl-1 text-xs">
                        <button className="text-brand-700 hover:underline" onClick={() => edit((d) => d.sections[si].entries[ei].bullets.push({ id: rid("b"), text: "" }))}>
                          + 加一条要点
                        </button>
                        <button className="text-muted hover:text-red-700" onClick={() => confirm("删除这一条经历？") && edit((d) => d.sections[si].entries.splice(ei, 1))}>
                          删除这条经历
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  className="w-full border-t border-line px-3 py-2 text-left text-xs text-brand-700 hover:bg-paper"
                  onClick={() => edit((d) => d.sections[si].entries.push({ id: rid("ent"), title: "", dates: "", subtitle: "", location: "", bullets: [{ id: rid("b"), text: "" }] }))}
                >
                  + 在「{s.heading}」里加一条经历
                </button>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="p-skills" className="scroll-mt-16 font-medium">技能</h2>
            <div className="flex items-center gap-2 text-xs text-muted">
              标题
              <input className={`${inputCls} w-40! text-xs`} value={p.skillsHeading} onChange={(e) => edit((d) => (d.skillsHeading = e.target.value))} />
              放在
              <select className={`${inputCls} w-auto! text-xs`} value={p.skillsPosition} onChange={(e) => edit((d) => (d.skillsPosition = Number(e.target.value)))}>
                {p.sections.map((s, i) => (
                  <option key={s.id} value={i}>
                    「{s.heading}」之前
                  </option>
                ))}
                <option value={p.sections.length}>最后</option>
              </select>
            </div>
          </div>
          <div className="space-y-2">
            {p.skills.map((g, gi) => (
              <div key={g.id} className="flex items-center gap-2">
                <input className={`${inputCls} w-40! shrink-0 font-medium`} value={g.label} placeholder="分组" onChange={(e) => edit((d) => (d.skills[gi].label = e.target.value))} />
                <input
                  className={`${inputCls} min-w-0 flex-1 text-[13px]`}
                  value={g.items.join(", ")}
                  placeholder="用逗号分隔"
                  onChange={(e) => edit((d) => (d.skills[gi].items = e.target.value.split(",").map((x) => x.trimStart())))}
                  onBlur={() => edit((d) => (d.skills[gi].items = d.skills[gi].items.map((x) => x.trim()).filter(Boolean)))}
                />
                <IconBtn title="删除分组" onClick={() => edit((d) => d.skills.splice(gi, 1))}>×</IconBtn>
              </div>
            ))}
          </div>
          <button className="mt-2 text-xs text-brand-700 hover:underline" onClick={() => edit((d) => d.skills.push({ id: rid("sk"), label: "", items: [] }))}>
            + 加一个技能分组
          </button>
        </Card>

        <Card className="p-5">
          <h2 id="p-facts" className="scroll-mt-16 font-medium">素材库</h2>
          <p className="mt-1 mb-3 text-[13px] text-muted">
            简历上还没写、但属实的东西：实习、项目、具体做了什么、数字。改简历时模型可以从这里挑内容放进去（会标出来让你核对）。一条一句，写得越具体越好。
          </p>
          <textarea
            className={`${inputCls} min-h-40 text-[13px] leading-relaxed`}
            placeholder={"例如：\nATAP 实习（公司名、职位、起止时间）：做了什么、用了什么技术、结果如何。\n个人项目：名字、技术栈、做了什么。"}
            value={p.extraFacts}
            onChange={(e) => edit((d) => (d.extraFacts = e.target.value))}
          />
        </Card>

        <Card className="p-5">
          <h2 id="p-answers" className="scroll-mt-16 font-medium">申请表常见问题</h2>
          <p className="mt-1 mb-3 text-[13px] text-muted">填表遇到这些问题就直接用这里的答案；空着的会在第一次遇到时问你，你答完可以顺手记进来。</p>
          <div className="space-y-2">
            {p.answers.map((a, ai) => (
              <div key={a.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <input className={`${inputCls} text-[13px]`} value={a.q} placeholder="问题" onChange={(e) => edit((d) => (d.answers[ai].q = e.target.value))} />
                <input
                  className={`${inputCls} text-[13px] ${a.a.trim() ? "" : "border-amber-200 bg-amber-50/50"}`}
                  value={a.a}
                  placeholder="未填（遇到时会问你）"
                  onChange={(e) => edit((d) => (d.answers[ai].a = e.target.value))}
                />
                <IconBtn title="删除" onClick={() => edit((d) => d.answers.splice(ai, 1))}>×</IconBtn>
              </div>
            ))}
          </div>
          <button className="mt-2 text-xs text-brand-700 hover:underline" onClick={() => edit((d) => d.answers.push({ id: rid("qa"), q: "", a: "" }))}>
            + 加一个问题
          </button>
          {templates.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <div className="mb-2 text-xs text-muted">申请表常问、你还没加的（点一下加进来）：</div>
              <div className="flex flex-wrap gap-1.5">
                {templates.map((q) => (
                  <button
                    key={q}
                    className="rounded-full border border-line bg-white px-2.5 py-0.5 text-xs text-muted hover:border-brand-200 hover:text-brand-700"
                    onClick={() => edit((d) => d.answers.push({ id: rid("qa"), q, a: "" }))}
                  >
                    + {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {pendingAsked.length > 0 && (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50/60 p-3">
              <div className="mb-2 text-[13px] font-medium text-amber-900">填表时问过你、还没记进来的</div>
              <ul className="space-y-2">
                {pendingAsked.map((a) => (
                  <li key={a.q} className="flex flex-col gap-1 text-[13px] sm:flex-row sm:items-center sm:gap-3">
                    <div className="min-w-0 flex-1">
                      <div>{a.q}</div>
                      <div className="text-xs text-muted">
                        {a.a ? <>你当时答：<span className="text-ink">{a.a}</span> · </> : null}
                        {a.times > 1 ? `问过 ${a.times} 次` : "问过 1 次"}
                        {a.job && ` · 最近在「${a.job}」`} · {ago(a.ts)}
                      </div>
                    </div>
                    <button
                      className="shrink-0 self-start rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs text-amber-900 hover:bg-amber-100 sm:self-auto"
                      onClick={() => edit((d) => d.answers.push({ id: rid("qa"), q: a.q, a: a.a }))}
                    >
                      {a.a ? "记进来" : "加进来再填"}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-xs text-muted">记进来之后点底部「保存」才生效。</div>
            </div>
          )}
        </Card>
      </div>

      <div className={`fixed inset-x-0 bottom-0 z-10 border-t border-line bg-white/95 backdrop-blur transition-transform md:left-56 ${dirty ? "translate-y-0" : "translate-y-full"}`}>
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3 md:px-8">
          <span className="text-sm text-muted">有改动还没保存</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => { if (data) setP(data.profile); setDirty(false); }}>
              放弃改动
            </Button>
            <Button variant="primary" busy={busy === "save"} onClick={save}>
              保存
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function IconBtn({ children, title, onClick, disabled }: { children: string; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button title={title} disabled={disabled} onClick={onClick} className="grid size-7 shrink-0 place-items-center rounded text-stone-400 hover:bg-black/5 hover:text-ink disabled:opacity-30">
      {children}
    </button>
  );
}
