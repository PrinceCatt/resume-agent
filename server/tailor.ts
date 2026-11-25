// Tailoring: the model picks, orders and rewords; this file rebuilds the resume from the master
// profile and rejects anything it cannot trace back to it.
import path from "node:path";
import { FILES_DIR, parseJson } from "./db.ts";
import fs from "node:fs";
import { asksCoverLetter, getJob, jobJd, setJob, bgQueue, trimPosting, type JobJd } from "./jobs.ts";
import { getProfile, profileForPrompt, type Bullet, type Entry, type Profile, type Section } from "./profile.ts";
import { chatJson, isDemo, llmReady } from "./llm.ts";
import { getSettings } from "./settings.ts";
import { coverLetterHtml, fileBaseName, resumeHtml, writePdf, type ResumeDoc } from "./render.ts";
import { mockTailor } from "./mock.ts";
import { mentions } from "./terms.ts";

export type TailorOutput = {
  summary?: string;
  sections?: Array<{
    id: string;
    heading?: string;
    entries?: Array<{
      id: string;
      title?: string;
      subtitle?: string;
      dates?: string;
      location?: string;
      bullets?: Array<{ src: string; text: string; fact?: string }>;
    }>;
  }>;
  skills?: Array<{ id: string; items: string[] }>;
  skillsPosition?: number;
  notes?: string[];
  coverLetter?: string;
};

export type Tailored = {
  doc: ResumeDoc;
  /** Original text of every bullet the model rewrote, keyed by the new bullet id. */
  origin: Record<string, string>;
  notes: string[];
  warnings: string[];
  coverage: { keywords: string[]; before: string[]; after: string[] };
  generatedAt: string;
  scale?: number;
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const numbersIn = (s: string) => (s.match(/\d+(?:[.,]\d+)?%?/g) ?? []).map((n) => n.replace(/,/g, ""));

export function docText(doc: ResumeDoc) {
  return [
    doc.summary,
    ...doc.sections.flatMap((s) => [s.heading, ...s.entries.flatMap((e) => [e.title, e.subtitle, ...e.bullets.map((b) => b.text)])]),
    ...doc.skills.flatMap((g) => [g.label, ...g.items]),
  ].join("\n");
}

export function coverage(doc: ResumeDoc, keywords: string[]) {
  const raw = docText(doc);
  const t = norm(raw);
  // "ROS" is covered by "Robot Operating System", "Vue" by "Vue3".
  return keywords.filter((k) => t.includes(norm(k)) || mentions(raw, k));
}

/** Whether the profile (resume and extra facts) mentions a skill, aliases included. */
export function profileHas(p: Profile): (keyword: string) => boolean {
  const raw = docText(masterDoc(p)) + "\n" + p.extraFacts;
  const t = norm(raw);
  return (k) => t.includes(norm(k)) || mentions(raw, k);
}

function masterDoc(p: Profile): ResumeDoc {
  return {
    basics: p.basics,
    summary: p.summary,
    sections: p.sections,
    skills: p.skills,
    skillsHeading: p.skillsHeading,
    skillsPosition: p.skillsPosition,
  };
}

/** Rebuilds a resume from the model's choices; everything structural comes from the master profile. */
export function assemble(master: Profile, out: TailorOutput, jd: JobJd): Omit<Tailored, "generatedAt" | "coverage"> & { coverLetter: string } {
  const warnings: string[] = [];
  const origin: Record<string, string> = {};
  const facts = norm(master.extraFacts);
  const profileText = norm(profileForPrompt(master, { withIds: false }) + "\n" + master.extraFacts);
  const profileNumbers = new Set(numbersIn(profileText));
  const bulletById = new Map<string, { bullet: Bullet; entry: Entry }>();
  for (const s of master.sections) for (const e of s.entries) for (const b of e.bullets) bulletById.set(b.id, { bullet: b, entry: e });

  // A rewritten bullet may only use numbers from its own entry (bullets of one entry can be merged).
  const checkText = (text: string, source: string, where: string) => {
    const srcNums = new Set(numbersIn(norm(source)));
    const bad = numbersIn(text).filter((n) => !srcNums.has(n));
    if (bad.length) return `${where}：数字 ${bad.join(", ")} 在原始资料里找不到，已改回原文`;
    const srcLower = norm(source) + "\n" + profileText;
    const unknown = jd.keywords.filter((k) => norm(text).includes(norm(k)) && !srcLower.includes(norm(k)));
    if (unknown.length) warnings.push(`${where}：出现了资料里没有的「${unknown.join("」「")}」，请核对是否属实`);
    return null;
  };

  const sections: Section[] = [];
  const usedEntries = new Set<string>();
  for (const os of out.sections ?? []) {
    const ms = master.sections.find((s) => s.id === os.id);
    const isNew = !ms;
    if (isNew && !os.heading) continue;
    const entries: Entry[] = [];
    for (const oe of os.entries ?? []) {
      const me = ms?.entries.find((e) => e.id === oe.id) ?? master.sections.flatMap((s) => s.entries).find((e) => e.id === oe.id);
      if (me && usedEntries.has(me.id)) continue;
      const bullets: Bullet[] = [];
      for (const ob of oe.bullets ?? []) {
        const text = (ob.text ?? "").trim();
        if (!text) continue;
        const src = bulletById.get(ob.src);
        const id = `t_${bullets.length}_${me?.id ?? "new"}_${sections.length}`;
        if (src) {
          const entryText = [src.entry.title, src.entry.subtitle, src.entry.dates, ...src.entry.bullets.map((b) => b.text)].join("\n");
          const problem = checkText(text, entryText, `「${me?.title || src.entry.title}」的一条要点`);
          if (problem) {
            warnings.push(problem);
            bullets.push({ id, text: src.bullet.text });
          } else {
            bullets.push({ id, text });
            if (norm(text) !== norm(src.bullet.text)) origin[id] = src.bullet.text;
          }
        } else if (ob.src === "fact" && ob.fact && facts.includes(norm(ob.fact).slice(0, 60))) {
          const problem = checkText(text, master.extraFacts, "素材库里的一条");
          if (problem) {
            warnings.push(problem);
            bullets.push({ id, text: ob.fact.trim() });
          } else bullets.push({ id, text });
          origin[id] = `（素材库）${ob.fact.trim()}`;
        } else {
          warnings.push(`去掉了一条找不到出处的要点：「${text.slice(0, 60)}」`);
        }
      }
      if (me) {
        usedEntries.add(me.id);
        entries.push({ ...me, bullets: bullets.length || !me.bullets.length ? bullets : me.bullets.slice(0, 2) });
      } else if (bullets.length && oe.title) {
        // A new entry built from the extra facts: its header must be traceable too.
        const missing = (oe.title + " " + (oe.subtitle ?? ""))
          .split(/[^A-Za-z0-9一-鿿]+/)
          .filter((w) => w.length >= 3 && !facts.includes(w.toLowerCase()));
        if (missing.length) warnings.push(`新条目「${oe.title}」里的 ${missing.join(", ")} 在素材库里找不到，请核对`);
        warnings.push(`新增了素材库里的条目「${oe.title}」，请核对标题和日期`);
        entries.push({ id: `new_${entries.length}_${sections.length}`, title: oe.title, subtitle: oe.subtitle ?? "", dates: oe.dates ?? "", location: oe.location ?? "", bullets });
      }
    }
    if (entries.length) sections.push({ id: ms?.id ?? `newsec_${sections.length}`, heading: ms?.heading ?? os.heading!, entries });
  }

  // Education is never dropped.
  for (const ms of master.sections) {
    if (/education|学历|教育/i.test(ms.heading) && !sections.some((s) => s.id === ms.id)) {
      sections.unshift(ms);
      warnings.push("模型漏掉了教育经历，已按原样补回");
    }
  }

  const allSkills = new Map<string, string>();
  for (const g of master.skills) for (const it of g.items) allSkills.set(norm(it), it);
  const skills = (out.skills ?? [])
    .map((og) => {
      const mg = master.skills.find((g) => g.id === og.id);
      if (!mg) return null;
      const items: string[] = [];
      for (const it of og.items ?? []) {
        const hit = allSkills.get(norm(it));
        if (hit) items.push(hit);
        else if (facts.includes(norm(it))) {
          items.push(it.trim());
          warnings.push(`技能「${it}」来自素材库，请核对`);
        } else warnings.push(`去掉了资料里没有的技能「${it}」`);
      }
      return { ...mg, items: [...new Set(items)] };
    })
    .filter((g): g is NonNullable<typeof g> => !!g && g.items.length > 0);

  let summary = (out.summary ?? "").trim();
  if (summary) {
    const bad = numbersIn(summary).filter((n) => !profileNumbers.has(n));
    if (bad.length) {
      warnings.push(`简介里的数字 ${bad.join(", ")} 找不到出处，简介已去掉`);
      summary = "";
    }
  }
  const coverLetter = (out.coverLetter ?? "").trim();
  warnings.push(...coverLetterWarnings(master, coverLetter, jd));

  const doc: ResumeDoc = {
    basics: master.basics,
    summary,
    sections: sections.length ? sections : master.sections,
    skills: skills.length ? skills : master.skills,
    skillsHeading: master.skillsHeading,
    skillsPosition: Number.isFinite(out.skillsPosition) ? Math.max(0, Math.floor(out.skillsPosition!)) : master.skillsPosition,
  };
  return { doc, origin, notes: (out.notes ?? []).filter((n) => typeof n === "string"), warnings, coverLetter };
}

/** Numbers in a cover letter that neither the profile nor the posting's title and company contain. */
export function coverLetterWarnings(master: Profile, text: string, jd: JobJd): string[] {
  const profileNumbers = new Set(numbersIn(norm(profileForPrompt(master, { withIds: false }) + "\n" + master.extraFacts)));
  const bad = numbersIn(text).filter((n) => !profileNumbers.has(n) && !norm(jd.title + jd.company).includes(n));
  return bad.length ? [`求职信里的数字 ${bad.join(", ")} 找不到出处，请核对`] : [];
}

/** Write a cover letter when the settings say always, or when this posting asks for one. */
export const wantsCoverLetter = (always: boolean, jd: JobJd) => always || asksCoverLetter(jd);

const coverAsk = (jd: JobJd) => (jd.facts?.coverLetterAsk ? `\nThe posting asks the cover letter to address: ${jd.facts.coverLetterAsk}` : "");

function tailorSystem(lang: "en" | "zh", withCover: boolean) {
  return `You tailor a candidate's resume to one job posting. Return JSON only.

HARD RULES
1. Use only facts in PROFILE or EXTRA FACTS. Never invent employers, titles, dates, numbers, metrics, tools, technologies, or achievements. If the job asks for something the candidate lacks, leave it out.
2. You may: choose which sections, entries and bullets to include; reorder them so the most relevant come first; reword a bullet to use the posting's vocabulary when it stays true; tighten wording; merge two bullets of the same entry.
3. Every bullet must cite "src": the [id] of the profile bullet it is based on, or "fact" plus "fact": the exact sentence copied from EXTRA FACTS.
4. Refer to existing sections and entries by their [id]. A genuinely new entry (only from EXTRA FACTS, e.g. an internship or project missing from the resume) uses "id":"new" with title, subtitle, dates, location — copied from the facts. A new section uses "id":"new" and "heading".
5. Skills: refer to skill groups by [id]; list only items that appear in the profile skills (or EXTRA FACTS); put the most relevant first; drop irrelevant ones.
6. Fit one A4 page: about 14-18 bullets in total, each under ~25 words. Always keep Education. Prefer dropping old school activities over relevant work.
7. Write the resume in ${lang === "zh" ? "Simplified Chinese" : "English"}.

JSON SHAPE
{"summary": string (optional, ≤2 sentences, only facts; "" if not useful),
 "sections": [{"id": string, "heading"?: string, "entries": [{"id": string, "title"?: string, "subtitle"?: string, "dates"?: string, "location"?: string, "bullets": [{"src": string, "text": string, "fact"?: string}]}]}],
 "skills": [{"id": string, "items": string[]}],
 "skillsPosition": number (index among your sections before which the skills block goes),
 "notes": string[] (3-6 short notes in Simplified Chinese: what you emphasised or dropped and why),
 "coverLetter": ${withCover ? `string (in the posting's language, 3 short paragraphs, ≤220 words, addressed "Dear Hiring Manager," and signed with the candidate's name; only facts; if the posting says what the letter should address, answer that with true facts)` : `""`}}`;
}

const COVER_SYSTEM = `You write a cover letter for one job posting from a candidate's profile. Return JSON {"coverLetter": string}.
- Use only facts in PROFILE or EXTRA FACTS. Never invent employers, titles, dates, numbers, tools or achievements; if the job wants something the candidate lacks, do not claim it.
- In the posting's language, 3 short paragraphs, at most 220 words, addressed "Dear Hiring Manager," and signed with the candidate's name.
- If the posting says what the letter should address, answer that with true facts.`;

/** A cover letter for a job that has none, when a form asks for one mid-application. Also writes its PDF. */
export async function writeCoverLetter(id: number): Promise<{ file: string; text: string; warnings: string[] }> {
  const job = getJob(id);
  if (!job) throw new Error("岗位不存在");
  if (job.cover_letter?.trim() && job.cover_file && fs.existsSync(job.cover_file)) return { file: job.cover_file, text: job.cover_letter, warnings: [] };
  const jd = jobJd(job);
  if (!jd) throw new Error("先解析岗位");
  const ready = llmReady();
  if (!ready.ok) throw new Error(ready.reason);
  const master = getProfile();
  const out = isDemo()
    ? { coverLetter: `Dear Hiring Manager,\n\nI am applying for the ${jd.title} role at ${jd.company}.\n\n（演示模式：没有调用模型）\n\n${master.basics.name}` }
    : await chatJson<{ coverLetter?: string }>(
        COVER_SYSTEM,
        `PROFILE\n${profileForPrompt(master, { withIds: false })}\n\nEXTRA FACTS\n${master.extraFacts || "(none)"}\n\nJOB POSTING\nTitle: ${jd.title}\nCompany: ${jd.company}\nRequirements:\n- ${jd.requirements.join("\n- ")}${coverAsk(jd)}\n\nFull text:\n${trimPosting(job.jd_text ?? "", job.url).slice(0, 6000)}`,
        1500,
        { jobId: id, kind: "tailor" },
      );
  const text = (out.coverLetter ?? "").trim();
  if (!text) throw new Error("没写出求职信");
  const warnings = coverLetterWarnings(master, text, jd);
  if (!parseJson<Tailored | null>(job.tailored, null)) await renderMasterFiles(id);
  const t = parseJson<Tailored>(getJob(id)!.tailored, null as never);
  if (warnings.length) t.warnings = [...t.warnings, ...warnings];
  setJob(id, { cover_letter: text, tailored: JSON.stringify(t) });
  await renderJobFiles(id);
  return { file: getJob(id)!.cover_file!, text, warnings };
}

export async function tailorJob(id: number) {
  if (!getJob(id)) return;
  const ready = llmReady();
  if (!ready.ok) throw new Error(ready.reason);
  const p = tailorPrompt(id);
  const out: TailorOutput = isDemo() ? mockTailor(p.master, p.jd) : await chatJson<TailorOutput>(p.system, p.input, 6000, { jobId: id, kind: "tailor" });
  await saveTailoring(id, p, out);
}

/** What tailoring sends to the model; in skill mode it is handed to the AI assistant instead. */
export function tailorPrompt(id: number) {
  const job = getJob(id);
  if (!job) throw new Error("岗位不存在");
  const jd = jobJd(job);
  if (!jd) throw new Error("先解析岗位");
  const master = getProfile();
  if (!master.sections.length) throw new Error("资料库是空的：先到「资料库」填写或导入简历");
  const settings = getSettings();
  const lang = settings.resumeLanguage === "auto" ? jd.language : settings.resumeLanguage;
  return {
    job,
    jd,
    master,
    system: tailorSystem(lang, wantsCoverLetter(settings.coverLetter, jd)),
    // PROFILE first, the same in every tailoring call, so DeepSeek can serve it from its cache.
    input: `PROFILE\n${profileForPrompt(master, { withIds: true })}\n\nEXTRA FACTS\n${master.extraFacts || "(none)"}\n\nJOB POSTING\nTitle: ${jd.title}\nCompany: ${jd.company}\nLocation: ${jd.location}\nRequirements:\n- ${jd.requirements.join("\n- ")}\nNice to have:\n- ${jd.niceToHave.join("\n- ")}\nKeywords: ${jd.keywords.join(", ")}${coverAsk(jd)}\n\nFull text:\n${trimPosting(job.jd_text ?? "", job.url).slice(0, 8000)}`,
  };
}

/**
 * Skill mode: an AI assistant answered the tailoring prompt itself. The answer goes through the same
 * source check (`assemble`) as DeepSeek's: unsourced bullets are dropped, new numbers and tools are flagged.
 */
export async function saveSkillTailoring(id: number, raw: unknown) {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as TailorOutput).sections)) throw new Error("要一个 JSON 对象，至少有 sections（按改简历提示词里的格式）");
  const p = tailorPrompt(id);
  await saveTailoring(id, p, raw as TailorOutput);
  return parseJson<Tailored>(getJob(id)!.tailored, null as never);
}

async function saveTailoring(id: number, p: ReturnType<typeof tailorPrompt>, out: TailorOutput) {
  const { job, jd, master } = p;
  const built = assemble(master, out, jd);
  const tailored: Tailored = {
    doc: built.doc,
    origin: built.origin,
    notes: built.notes,
    warnings: built.warnings,
    coverage: { keywords: jd.keywords, before: coverage(masterDoc(master), jd.keywords), after: coverage(built.doc, jd.keywords) },
    generatedAt: new Date().toISOString(),
  };
  setJob(id, { tailored: JSON.stringify(tailored), cover_letter: built.coverLetter || null });
  await renderJobFiles(id);
  setJob(id, { stage: job.stage === "applied" ? "applied" : "tailored", busy: null, error: null, notice: null });
}

/** (Re)writes the job's resume and cover letter PDFs from what is saved. */
export async function renderJobFiles(id: number) {
  const job = getJob(id)!;
  const t = parseJson<Tailored | null>(job.tailored, null);
  if (!t) throw new Error("还没有定制简历");
  const base = fileBaseName(t.doc);
  const dir = path.join(FILES_DIR, `job-${id}`);
  const resumePath = path.join(dir, `${base}_Resume.pdf`);
  const { scale } = await writePdf(resumePath, (s) => resumeHtml(t.doc, s), true);
  let coverPath: string | null = null;
  if (job.cover_letter?.trim()) {
    coverPath = path.join(dir, `${base}_Cover_Letter.pdf`);
    await writePdf(coverPath, () => coverLetterHtml(t.doc, job.cover_letter!), false);
  }
  t.scale = scale;
  setJob(id, { resume_file: resumePath, cover_file: coverPath, tailored: JSON.stringify(t) });
}

/** The untailored resume, used when you apply without tailoring. */
export async function renderMasterFiles(id: number) {
  const master = getProfile();
  const doc = masterDoc(master);
  const tailored: Tailored = { doc, origin: {}, notes: ["未定制：使用资料库原版简历"], warnings: [], coverage: { keywords: [], before: [], after: [] }, generatedAt: new Date().toISOString() };
  setJob(id, { tailored: JSON.stringify(tailored) });
  await renderJobFiles(id);
}

export function queueTailor(id: number, then?: () => void) {
  setJob(id, { busy: "tailoring", error: null });
  bgQueue.push(async () => {
    try {
      await tailorJob(id);
      then?.();
    } catch (e) {
      setJob(id, { busy: null, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

export { masterDoc };
