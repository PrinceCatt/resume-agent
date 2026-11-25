import { useEffect, useRef, useState } from "react";
import { api, ago, useApi, type AskedQuestion, type Basics, type Profile } from "../api.ts";
import { Button, Card, Field, inputCls, toast, useAction } from "../components/ui.tsx";

const rid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const BASICS: Array<[keyof Basics, string, string?]> = [
  ["name", "Name (as shown on the resume)", "Alex Tan"],
  ["firstName", "First name"],
  ["lastName", "Last name"],
  ["email", "Email"],
  ["phoneCountryCode", "Country code", "+65"],
  ["phone", "Phone"],
  ["location", "Location"],
  ["linkedin", "LinkedIn"],
  ["github", "GitHub"],
  ["website", "Website"],
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
    }, "Profile saved");

  const importPdf = (f: File) =>
    run("import", async () => {
      const r = await api<{ profile: Profile }>("/profile/import", { raw: f });
      setP(r.profile);
      setDirty(true);
      toast("Read the PDF. Check the result, then click \"Save\" to keep it");
    });

  const norm = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim();
  const have = new Set(p.answers.map((a) => norm(a.q)));
  const templates = (data?.commonQuestions ?? []).filter((q) => !have.has(norm(q)));
  const pendingAsked = (asked.data?.asked ?? []).filter((a) => !have.has(norm(a.q)));
  const unanswered = p.answers.filter((a) => !a.a.trim()).length;
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const nav: Array<[string, string, string?]> = [
    ["p-basics", "Basics", !p.basics.name || !p.basics.email || !p.basics.phone ? "incomplete" : undefined],
    ["p-resume", "Resume"],
    ["p-skills", "Skills"],
    ["p-facts", "Extra facts", p.extraFacts.trim() ? undefined : "empty"],
    ["p-answers", "Common questions", unanswered || pendingAsked.length ? `${unanswered + pendingAsked.length} to fill in` : undefined],
  ];

  return (
    <div className="mx-auto max-w-4xl pb-20">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
          <p className="mt-1 text-sm text-muted">Tailored resumes and application forms use only what is here: the model may pick, reorder and reword, but never adds experience, numbers or skills that are not in it.</p>
        </div>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept="application/pdf" hidden onChange={(e) => e.target.files?.[0] && importPdf(e.target.files[0])} />
          <Button busy={busy === "import"} onClick={() => fileRef.current?.click()}>
            Import from PDF
          </Button>
          <a href="/api/profile/resume.html" target="_blank" rel="noreferrer">
            <Button>View original resume</Button>
          </a>
        </div>
      </header>

      <nav className="scroll-clean sticky top-0 z-[5] -mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-line bg-paper/95 px-4 py-2 backdrop-blur md:-mx-8 md:px-8" aria-label="Jump to">
        {nav.map(([id, label, hint]) => (
          <button key={id} onClick={() => jump(id)} className="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] text-muted hover:bg-white hover:text-ink">
            {label}
            {hint && <span className="rounded-full bg-amber-100 px-1.5 text-[11px] leading-4 text-amber-800">{hint}</span>}
          </button>
        ))}
      </nav>

      <div className="space-y-5">
        <Card className="scroll-mt-16 p-5">
          <h2 id="p-basics" className="mb-3 scroll-mt-16 font-medium">Basics</h2>
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
            <h2 id="p-resume" className="scroll-mt-16 font-medium">Resume</h2>
            <Button size="sm" onClick={() => edit((d) => d.sections.push({ id: rid("sec"), heading: "New Section", entries: [] }))}>
              Add a section
            </Button>
          </div>
          <Field label="Summary (optional, a sentence or two)">
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
                  <IconBtn title="Move up" disabled={si === 0} onClick={() => edit((d) => d.sections.splice(si - 1, 0, d.sections.splice(si, 1)[0]))}>↑</IconBtn>
                  <IconBtn title="Move down" disabled={si === p.sections.length - 1} onClick={() => edit((d) => d.sections.splice(si + 1, 0, d.sections.splice(si, 1)[0]))}>↓</IconBtn>
                  <IconBtn title="Delete section" onClick={() => confirm(`Delete the section "${s.heading}"?`) && edit((d) => d.sections.splice(si, 1))}>×</IconBtn>
                </div>
                <div className="divide-y divide-line">
                  {s.entries.map((e, ei) => (
                    <div key={e.id} className="space-y-2 p-3">
                      <div className="grid gap-2 sm:grid-cols-[1fr_180px]">
                        <input className={`${inputCls} font-medium`} placeholder="School / company / project (leave empty for a plain list)" value={e.title} onChange={(ev) => edit((d) => (d.sections[si].entries[ei].title = ev.target.value))} />
                        <input className={inputCls} placeholder="Dates" value={e.dates} onChange={(ev) => edit((d) => (d.sections[si].entries[ei].dates = ev.target.value))} />
                        <input className={inputCls} placeholder="Degree / role" value={e.subtitle} onChange={(ev) => edit((d) => (d.sections[si].entries[ei].subtitle = ev.target.value))} />
                        <input className={inputCls} placeholder="Location" value={e.location} onChange={(ev) => edit((d) => (d.sections[si].entries[ei].location = ev.target.value))} />
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
                            <IconBtn title="Delete this bullet" onClick={() => edit((d) => d.sections[si].entries[ei].bullets.splice(bi, 1))}>×</IconBtn>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-3 pl-1 text-xs">
                        <button className="text-brand-700 hover:underline" onClick={() => edit((d) => d.sections[si].entries[ei].bullets.push({ id: rid("b"), text: "" }))}>
                          + Add a bullet
                        </button>
                        <button className="text-muted hover:text-red-700" onClick={() => confirm("Delete this entry?") && edit((d) => d.sections[si].entries.splice(ei, 1))}>
                          Delete this entry
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  className="w-full border-t border-line px-3 py-2 text-left text-xs text-brand-700 hover:bg-paper"
                  onClick={() => edit((d) => d.sections[si].entries.push({ id: rid("ent"), title: "", dates: "", subtitle: "", location: "", bullets: [{ id: rid("b"), text: "" }] }))}
                >
                  + Add an entry to "{s.heading}"
                </button>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="p-skills" className="scroll-mt-16 font-medium">Skills</h2>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              Heading
              <input className={`${inputCls} w-40! text-xs`} value={p.skillsHeading} onChange={(e) => edit((d) => (d.skillsHeading = e.target.value))} />
              Placed
              <select className={`${inputCls} w-auto! text-xs`} value={p.skillsPosition} onChange={(e) => edit((d) => (d.skillsPosition = Number(e.target.value)))}>
                {p.sections.map((s, i) => (
                  <option key={s.id} value={i}>
                    before "{s.heading}"
                  </option>
                ))}
                <option value={p.sections.length}>at the end</option>
              </select>
            </div>
          </div>
          <div className="space-y-2">
            {p.skills.map((g, gi) => (
              <div key={g.id} className="flex items-center gap-2">
                <input className={`${inputCls} w-40! shrink-0 font-medium`} value={g.label} placeholder="Group" onChange={(e) => edit((d) => (d.skills[gi].label = e.target.value))} />
                <input
                  className={`${inputCls} min-w-0 flex-1 text-[13px]`}
                  value={g.items.join(", ")}
                  placeholder="Separated by commas"
                  onChange={(e) => edit((d) => (d.skills[gi].items = e.target.value.split(",").map((x) => x.trimStart())))}
                  onBlur={() => edit((d) => (d.skills[gi].items = d.skills[gi].items.map((x) => x.trim()).filter(Boolean)))}
                />
                <IconBtn title="Delete group" onClick={() => edit((d) => d.skills.splice(gi, 1))}>×</IconBtn>
              </div>
            ))}
          </div>
          <button className="mt-2 text-xs text-brand-700 hover:underline" onClick={() => edit((d) => d.skills.push({ id: rid("sk"), label: "", items: [] }))}>
            + Add a skill group
          </button>
        </Card>

        <Card className="p-5">
          <h2 id="p-facts" className="scroll-mt-16 font-medium">Extra facts</h2>
          <p className="mt-1 mb-3 text-[13px] text-muted">
            True things your resume doesn't say yet: internships, projects, what exactly you did, numbers. When tailoring, the model may pick from here (and marks it for you to check). One sentence per fact; the more specific the better.
          </p>
          <textarea
            className={`${inputCls} min-h-40 text-[13px] leading-relaxed`}
            placeholder={"For example:\nInternship (company, role, start and end dates): what you did, which technologies, what came of it.\nPersonal project: name, tech stack, what you built."}
            value={p.extraFacts}
            onChange={(e) => edit((d) => (d.extraFacts = e.target.value))}
          />
        </Card>

        <Card className="p-5">
          <h2 id="p-answers" className="scroll-mt-16 font-medium">Common application questions</h2>
          <p className="mt-1 mb-3 text-[13px] text-muted">When a form asks one of these, the answer here is used. Empty ones are asked the first time they come up, and you can save your answer then.</p>
          <div className="space-y-2">
            {p.answers.map((a, ai) => (
              <div key={a.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <input className={`${inputCls} text-[13px]`} value={a.q} placeholder="Question" onChange={(e) => edit((d) => (d.answers[ai].q = e.target.value))} />
                <input
                  className={`${inputCls} text-[13px] ${a.a.trim() ? "" : "border-amber-200 bg-amber-50/50"}`}
                  value={a.a}
                  placeholder="Empty (you will be asked when it comes up)"
                  onChange={(e) => edit((d) => (d.answers[ai].a = e.target.value))}
                />
                <IconBtn title="Delete" onClick={() => edit((d) => d.answers.splice(ai, 1))}>×</IconBtn>
              </div>
            ))}
          </div>
          <button className="mt-2 text-xs text-brand-700 hover:underline" onClick={() => edit((d) => d.answers.push({ id: rid("qa"), q: "", a: "" }))}>
            + Add a question
          </button>
          {templates.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <div className="mb-2 text-xs text-muted">Often asked on forms and not added yet (click to add):</div>
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
              <div className="mb-2 text-[13px] font-medium text-amber-900">Asked while filling in forms, not saved yet</div>
              <ul className="space-y-2">
                {pendingAsked.map((a) => (
                  <li key={a.q} className="flex flex-col gap-1 text-[13px] sm:flex-row sm:items-center sm:gap-3">
                    <div className="min-w-0 flex-1">
                      <div>{a.q}</div>
                      <div className="text-xs text-muted">
                        {a.a ? <>You answered: <span className="text-ink">{a.a}</span> · </> : null}
                        {a.times > 1 ? `asked ${a.times} times` : "asked once"}
                        {a.job && ` · last for "${a.job}"`} · {ago(a.ts)}
                      </div>
                    </div>
                    <button
                      className="shrink-0 self-start rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs text-amber-900 hover:bg-amber-100 sm:self-auto"
                      onClick={() => edit((d) => d.answers.push({ id: rid("qa"), q: a.q, a: a.a }))}
                    >
                      {a.a ? "Save" : "Add and fill in"}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-xs text-muted">Click "Save" at the bottom afterwards to keep them.</div>
            </div>
          )}
        </Card>
      </div>

      <div className={`fixed inset-x-0 bottom-0 z-10 border-t border-line bg-white/95 backdrop-blur transition-transform md:left-56 ${dirty ? "translate-y-0" : "translate-y-full"}`}>
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3 md:px-8">
          <span className="text-sm text-muted">Unsaved changes</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => { if (data) setP(data.profile); setDirty(false); }}>
              Discard
            </Button>
            <Button variant="primary" busy={busy === "save"} onClick={save}>
              Save
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
