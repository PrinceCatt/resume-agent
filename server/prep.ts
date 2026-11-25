// After applying: interview prep (likely questions with talking points from the profile) and
// short email drafts (a follow-up, a thank-you). Same rule as tailoring: only facts from the
// profile, never invented experience.
import { parseJson } from "./db.ts";
import { emit } from "./events.ts";
import { daysSinceSql, getJob, jobJd, setJob, trimPosting } from "./jobs.ts";
import { chatJson, isDemo, llmReady } from "./llm.ts";
import { mockDraft, mockPrep } from "./mock.ts";
import { getProfile, profileForPrompt, type Profile } from "./profile.ts";
import { getSettings } from "./settings.ts";
import { profileText, unsupportedTerms } from "./terms.ts";
import type { JobJd } from "./jobs.ts";

/** As the model wrote it: src is a profile id, "fact" (with the EXTRA FACTS sentence) or "tip". */
type StoredPoint = { text: string; src: string; fact?: string };
/**
 * As shown, checked against the profile at read time (so adding a fact to the profile clears a flag):
 * fact = experience from the profile (from = where); tip = how to answer, claims nothing;
 * unsure = reads like experience but has no source, or names something the profile lacks (from = why).
 */
export type PrepPoint = { text: string; kind: "fact" | "tip" | "unsure"; from: string };
type Question<P> = { q: string; kind: "behavioral" | "technical" | "role" | "resume"; why: string; points: P[] };
export type PrepQuestion = Question<PrepPoint>;
type StoredPrep = { pitch: string; questions: Question<StoredPoint>[]; toAsk: string[]; gaps: Array<{ gap: string; how: string }>; generatedAt: string };
export type Prep = Omit<StoredPrep, "questions"> & {
  questions: PrepQuestion[];
  /** Things the pitch says that the profile does not back up. */
  pitchWarnings: string[];
};
export const DRAFT_KINDS = ["followup", "thanks"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
type StoredDraft = { subject: string; body: string; extra: string; generatedAt: string };
export type Draft = StoredDraft & { warnings: string[] };

const prepping = new Set<number>();
const prepErrors = new Map<number, string>();
export const prepState = (id: number) => ({ prepping: prepping.has(id), prepError: prepErrors.get(id) ?? null });

function context(id: number) {
  const job = getJob(id);
  if (!job) throw new Error("岗位不存在");
  const jd = jobJd(job);
  if (!jd) throw new Error("先读取岗位");
  const ready = llmReady();
  if (!ready.ok) throw new Error(ready.reason);
  const profile = getProfile();
  if (!profile.sections.length) throw new Error("资料库是空的：先到「资料库」填写或导入简历");
  const s = getSettings();
  const lang = s.resumeLanguage === "auto" ? jd.language : s.resumeLanguage;
  const posting = `Title: ${jd.title}\nCompany: ${jd.company}\nLocation: ${jd.location}\nRequirements:\n- ${jd.requirements.join("\n- ")}\nNice to have:\n- ${jd.niceToHave.join("\n- ")}\nKeywords: ${jd.keywords.join(", ")}\n\nFull text:\n${trimPosting(job.jd_text ?? "", job.url).slice(0, 8000)}`;
  const candidate = `${profileForPrompt(profile, { withIds: false })}\n\nEXTRA FACTS\n${profile.extraFacts || "(none)"}`;
  const candidateWithIds = `${profileForPrompt(profile, { withIds: true })}\n\nEXTRA FACTS\n${profile.extraFacts || "(none)"}`;
  return { job, jd, profile, lang, langName: lang === "zh" ? "Simplified Chinese" : "English", posting, candidate, candidateWithIds };
}

const prepSystem = (langName: string) => `You coach a candidate for the interviews of one specific job.
Use ONLY facts from CANDIDATE (the profile, whose lines carry [ids], and EXTRA FACTS). Never invent experience, employers, tools, tests, methods, durations, team sizes, numbers or results: if CANDIDATE does not say they did it, they did not. Where the candidate lacks something the job needs, say so plainly and suggest an honest way to handle it.
Every talking point is one of two kinds:
- experience: something CANDIDATE says the candidate did or has. "src" is the [id] of the profile line it comes from (a bullet, an entry or a skills group), or "fact" with "fact" set to the exact sentence copied from EXTRA FACTS. Stay within what that line says.
- tip: advice on how to answer (structure, what to explain, what to admit). "src" is "tip". It must be phrased as advice ("Explain…", "Walk through…", "Admit that…") and must not describe anything as done by the candidate.
Return JSON:
{"pitch": string (a 30-45 second self-introduction for this role, first person, in ${langName}, only facts from CANDIDATE),
 "questions": [{"q": string (in ${langName}), "kind": "behavioral" | "technical" | "role" | "resume", "why": string (one sentence in Simplified Chinese: why an interviewer for this role would ask it), "points": [{"text": string (in ${langName}), "src": string, "fact"?: string}] (2-4 points; prefer experience points, use tips where CANDIDATE has nothing relevant)}]
   (8-12 questions, the ones most likely for THIS posting: its must-haves and keywords, and what on the candidate's resume an interviewer would probe),
 "toAsk": string[] (3-5 questions for the candidate to ask the interviewer, in ${langName}, specific to this role and company),
 "gaps": [{"gap": string (Simplified Chinese), "how": string (Simplified Chinese: an honest way to handle it in the interview)}] (0-4 items)}`;

/** Starts writing the prep in the background; the job emits when it is done. */
export function queuePrep(id: number) {
  if (prepping.has(id)) return;
  const ctx = context(id); // throws early (no profile, no key) so the button can say why
  prepping.add(id);
  prepErrors.delete(id);
  emit("job", id);
  void (async () => {
    try {
      const raw = isDemo()
        ? mockPrep(ctx.jd, ctx.profile, ctx.lang)
        : await chatJson<any>(prepSystem(ctx.langName), `JOB POSTING\n${ctx.posting}\n\nCANDIDATE\n${ctx.candidateWithIds}`, 5000, { jobId: id, kind: "prep" });
      const prep = normalizePrep(raw);
      if (!prep.questions.length) throw new Error("模型没有给出面试题，再试一次");
      if (getJob(id)) setJob(id, { prep: JSON.stringify(prep) });
    } catch (e) {
      prepErrors.set(id, e instanceof Error ? e.message : String(e));
    } finally {
      prepping.delete(id);
      emit("job", id);
    }
  })();
}

const numbersIn = (t: string) => (t.match(/\d+(?:[.,]\d+)?%?/g) ?? []).map((n) => n.replace(/,/g, ""));
const squash = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
// A "tip" that opens like a résumé line is a claim in disguise.
const CLAIM = /^(i\s+|i've\s+|i have\s+)?(used|built|led|developed|implemented|created|designed|worked|completed|learned|collaborated|encountered|deployed|wrote|managed|optimi[sz]ed|debugged|resolved|identified|overcame|applied|conducted|participated)\b|^我(做|用|负责|参与|完成|写|学|搭|开发|设计|带)/i;

/** Sorts each talking point into fact / tip / unsure by checking its source against the profile. */
export function checkPoint(raw: any, profile: Profile, jd: Pick<JobJd, "keywords">): PrepPoint {
  const text = typeof raw === "string" ? raw.trim() : typeof raw?.text === "string" ? raw.text.trim() : "";
  const src = typeof raw?.src === "string" ? raw.src.trim().replace(/^\[|\]$/g, "") : "";
  if (src.toLowerCase() === "tip") return CLAIM.test(text) ? { text, kind: "unsure", from: "写得像你做过的事，但没有标出处" } : { text, kind: "tip", from: "" };
  const where = new Map<string, string>();
  for (const s of profile.sections) {
    where.set(s.id, s.heading);
    for (const e of s.entries) {
      where.set(e.id, e.title || s.heading);
      for (const b of e.bullets) where.set(b.id, e.title || s.heading);
    }
  }
  for (const g of profile.skills) where.set(g.id, g.label || "技能");
  let from = where.get(src) ?? "";
  if (!from && src === "fact" && typeof raw?.fact === "string" && raw.fact.trim() && squash(profile.extraFacts).includes(squash(raw.fact))) from = "素材库";
  if (!from) return { text, kind: "unsure", from: "资料库里找不到出处" };
  const ptext = profileText(profile);
  const missing = unsupportedTerms(text, ptext, jd.keywords);
  if (missing.length) return { text, kind: "unsure", from: `出自「${from}」，但资料库里没有 ${missing.join("、")}` };
  const nums = new Set(numbersIn(ptext));
  const badNums = numbersIn(text).filter((n) => !nums.has(n));
  if (badNums.length) return { text, kind: "unsure", from: `出自「${from}」，但资料库里没有 ${badNums.join("、")} 这个数字` };
  return { text, kind: "fact", from };
}

function normalizePrep(raw: any): StoredPrep {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const a = (v: unknown, n: number) => (Array.isArray(v) ? v.map(s).filter(Boolean).slice(0, n) : []);
  const kinds = ["behavioral", "technical", "role", "resume"];
  const point = (p: any): StoredPoint => ({ text: s(p?.text ?? p), src: s(p?.src), ...(s(p?.fact) ? { fact: s(p.fact) } : {}) });
  return {
    pitch: s(raw?.pitch),
    questions: (Array.isArray(raw?.questions) ? raw.questions : [])
      .map((q: any) => ({
        q: s(q?.q),
        kind: kinds.includes(q?.kind) ? q.kind : "role",
        why: s(q?.why),
        points: (Array.isArray(q?.points) ? q.points : []).map(point).filter((p: StoredPoint) => p.text).slice(0, 5),
      }))
      .filter((q: Question<StoredPoint>) => q.q)
      .slice(0, 15),
    toAsk: a(raw?.toAsk, 6),
    gaps: (Array.isArray(raw?.gaps) ? raw.gaps : []).map((g: any) => ({ gap: s(g?.gap), how: s(g?.how) })).filter((g: { gap: string }) => g.gap).slice(0, 5),
    generatedAt: new Date().toISOString(),
  };
}

/** The saved prep with every point and the pitch checked against the profile as it is now. */
export function prepView(raw: any, profile: Profile, jd: Pick<JobJd, "keywords"> | null): Prep | null {
  if (!raw || !Array.isArray(raw.questions)) return null;
  const ptext = profileText(profile);
  const nums = new Set(numbersIn(ptext));
  const keywords = jd?.keywords ?? [];
  const pitch = typeof raw.pitch === "string" ? raw.pitch : "";
  return {
    ...raw,
    pitchWarnings: [
      ...unsupportedTerms(pitch, ptext, keywords).map((t) => `提到了 ${t}，资料库里没有`),
      ...numbersIn(pitch).filter((n) => !nums.has(n)).map((n) => `数字 ${n} 资料库里没有`),
    ],
    questions: raw.questions.map((q: any) => ({
      ...q,
      points: (q.points ?? []).map((p: any): PrepPoint =>
        typeof p === "string"
          ? { text: p, kind: "unsure", from: "早先生成的，没有标出处：重新生成一次" }
          : typeof p?.kind === "string" && typeof p?.src !== "string"
            ? p
            : checkPoint(p, profile, { keywords }),
      ),
    })),
  };
}

/** Tools an email names that neither the profile nor the user's notes mention. */
export function draftWarnings(d: StoredDraft, profile: Profile, jd: Pick<JobJd, "keywords"> | null): string[] {
  // Names the notes mention (the interviewer's stack) are fine; anything else is worth a look.
  return unsupportedTerms(`${d.subject}\n${d.body}`, `${profileText(profile)}\n${d.extra}`, jd?.keywords ?? []).map(
    (t) => `提到了 ${t}，资料库里没有：说的是对方的技术就没事，别写成你会`,
  );
}

export function draftsView(raw: any, profile: Profile, jd: Pick<JobJd, "keywords"> | null) {
  const out: Partial<Record<DraftKind, Draft>> = {};
  for (const k of DRAFT_KINDS) if (raw?.[k]?.body) out[k] = { ...raw[k], warnings: draftWarnings(raw[k], profile, jd) };
  return out;
}

const draftSystem = (kind: DraftKind, langName: string, days: number | null) => `You write one short, polite email for a job candidate, in ${langName}.
${
  kind === "followup"
    ? `It follows up on an application submitted ${days !== null && days >= 2 ? `${Math.round(days)} days ago` : "recently"} with no reply yet: ask politely about the status, restate interest in one sentence that cites one concrete, relevant fact from CANDIDATE. At most 120 words.`
    : `It thanks the interviewer(s) after an interview: thank them, recall what NOTES says was discussed (if NOTES is empty, stay general but specific to this role), restate interest with one concrete, relevant fact from CANDIDATE. At most 150 words.`
}
Use only facts from CANDIDATE; never invent experience, numbers or details of the interview. Address it to the person NOTES names, otherwise "Dear Hiring Team," (or "您好，" in Chinese). Sign with the candidate's name. No placeholders in brackets.
Return JSON {"subject": string, "body": string}.`;

export async function makeDraft(id: number, kind: DraftKind, extra: string) {
  const ctx = context(id);
  const days = ctx.job.applied_at ? daysSinceSql(ctx.job.applied_at) : null;
  const raw = isDemo()
    ? mockDraft(kind, ctx.jd, ctx.profile, ctx.lang, extra)
    : await chatJson<any>(
        draftSystem(kind, ctx.langName, days),
        `JOB POSTING\n${ctx.posting.slice(0, 3000)}\n\nCANDIDATE\n${ctx.candidate}\n\nNOTES\n${extra || "(none)"}`,
        1200,
        { jobId: id, kind: "email" },
      );
  const draft: StoredDraft = {
    subject: typeof raw?.subject === "string" ? raw.subject.trim() : "",
    body: typeof raw?.body === "string" ? raw.body.trim() : "",
    extra,
    generatedAt: new Date().toISOString(),
  };
  if (!draft.body) throw new Error("模型没有写出邮件，再试一次");
  const drafts = parseJson<Partial<Record<DraftKind, StoredDraft>>>(getJob(id)?.drafts, {});
  drafts[kind] = draft;
  setJob(id, { drafts: JSON.stringify(drafts) });
  return { ...draft, warnings: draftWarnings(draft, ctx.profile, ctx.jd) } satisfies Draft;
}
