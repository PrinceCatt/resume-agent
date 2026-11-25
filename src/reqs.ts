// What postings ask for, as labels, filters and counts. Plain functions (no React) so the job list,
// the Excel export and the tests use the same rules.
import type { JobFacts, JobView, Material } from "./api.ts";

export const TYPE_LABEL: Record<JobFacts["type"], string> = { fulltime: "Full-time", parttime: "Part-time", internship: "Internship", contract: "Contract", unknown: "Not stated" };
export const DEGREE_LABEL: Record<Exclude<JobFacts["degree"], "">, string> = { none: "Any education", diploma: "Diploma", bachelor: "Bachelor's", master: "Master's", phd: "PhD" };
export const MATERIAL_LABEL: Record<Material, string> = { cover_letter: "Cover letter", transcript: "Transcript", portfolio: "Portfolio", references: "References", other: "Other documents" };
export const AUTH_LABEL: Record<Exclude<JobFacts["workAuth"], "">, string> = { citizen: "Citizens only", citizen_pr: "Citizens/PR only" };

/** "Part-time internship" with the hours stated, "Internship" without. */
const internLabel = (f: JobFacts) => (f.hours === "part" ? "Part-time internship" : f.hours === "full" ? "Full-time internship" : "Internship");
const monthsLabel = (n: number | null) => (n ? `, ${n} ${n === 1 ? "month" : "months"}` : "");

/** "Part-time internship, 3 months", "Full-time", "" */
export function typeLabel(f: JobFacts) {
  if (f.type === "internship") return `${internLabel(f)}${monthsLabel(f.months)}`;
  if (f.type === "contract") return `Contract${monthsLabel(f.months)}`;
  return f.type === "unknown" ? "" : TYPE_LABEL[f.type];
}

export const yearsLabel = (n: number) => (n === 0 ? "No experience needed" : `${n}+ ${n === 1 ? "year" : "years"} of experience`);

/** Short labels for a job's conditions, in a fixed order; the warning ones are flagged. */
export function factChips(f: JobFacts | null): Array<{ text: string; warn?: boolean }> {
  if (!f) return [];
  const out: Array<{ text: string; warn?: boolean }> = [];
  const t = typeLabel(f);
  if (t) out.push({ text: t });
  if (f.minYears !== null) out.push({ text: yearsLabel(f.minYears), warn: f.minYears >= 2 });
  if (f.student === "graduated") out.push({ text: "Graduates only", warn: true });
  if (f.student === "enrolled") out.push({ text: "Current students only" });
  if (f.workAuth) out.push({ text: AUTH_LABEL[f.workAuth], warn: true });
  for (const m of f.materials) out.push({ text: `Asks for ${MATERIAL_LABEL[m].toLowerCase()}` });
  if (f.start) out.push({ text: `Starts ${f.start}` });
  return out;
}

export const KINDS = ["fulltime", "intern_part", "intern_full", "parttime"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABEL: Record<Kind, string> = { fulltime: "Full-time", intern_part: "Part-time internship", intern_full: "Full-time internship", parttime: "Part-time" };

/** The kinds a job could be; an internship with no stated hours could be either. */
function kindsOf(f: JobFacts): Kind[] {
  if (f.type === "fulltime" || f.type === "parttime") return [f.type];
  if (f.type !== "internship") return [];
  return f.hours === "part" ? ["intern_part"] : f.hours === "full" ? ["intern_full"] : ["intern_part", "intern_full"];
}

export type ReqFilter = {
  /** Empty: any type. An internship whose hours the posting doesn't give matches either internship kind. */
  types: Kind[];
  /** Keep jobs asking for at most this many years (jobs that don't say are kept). null: off. */
  maxYears: number | null;
  hideCitizenOnly: boolean;
  /** Hide roles only for people who have already graduated. */
  hideGraduatedOnly: boolean;
  coverLetter: "any" | "yes" | "no";
  /** 0: off. */
  minFit: number;
  hideClosed: boolean;
  /** "": off. Jobs whose keywords include it (any case). */
  keyword: string;
};

export const NO_FILTER: ReqFilter = { types: [], maxYears: null, hideCitizenOnly: false, hideGraduatedOnly: false, coverLetter: "any", minFit: 0, hideClosed: false, keyword: "" };

export const isFiltering = (f: ReqFilter) => JSON.stringify(f) !== JSON.stringify(NO_FILTER);

/** Reads a saved filter, dropping anything malformed. */
export function readFilter(raw: string | null): ReqFilter {
  try {
    const o = JSON.parse(raw ?? "null");
    if (!o || typeof o !== "object") return NO_FILTER;
    return {
      // "internship" was one kind before part-time and full-time internships were told apart.
      types: Array.isArray(o.types) ? [...new Set<Kind>(o.types.flatMap((t: unknown) => (t === "internship" ? ["intern_part", "intern_full"] : KINDS.includes(t as Kind) ? [t] : [])))] : [],
      maxYears: typeof o.maxYears === "number" ? o.maxYears : null,
      hideCitizenOnly: o.hideCitizenOnly === true,
      hideGraduatedOnly: o.hideGraduatedOnly === true,
      coverLetter: o.coverLetter === "yes" || o.coverLetter === "no" ? o.coverLetter : "any",
      minFit: typeof o.minFit === "number" ? o.minFit : 0,
      hideClosed: o.hideClosed === true,
      keyword: typeof o.keyword === "string" ? o.keyword : "",
    };
  } catch {
    return NO_FILTER;
  }
}

const isClosed = (j: JobView) => !!j.jd?.closed;

/** Does the job pass the filter? A job read before conditions were recorded passes the conditions it cannot be judged on. */
export function passes(j: JobView, f: ReqFilter): boolean {
  const facts = j.jd?.facts ?? null;
  if (f.hideClosed && isClosed(j)) return false;
  if (f.minFit && (j.jd?.fit?.score ?? -1) < f.minFit) return false;
  if (f.keyword && !(j.jd?.keywords ?? []).some((k) => k.toLowerCase() === f.keyword.toLowerCase())) return false;
  if (!facts) return f.types.length === 0 && f.coverLetter !== "yes";
  if (f.types.length && !kindsOf(facts).some((k) => f.types.includes(k))) return false;
  if (f.maxYears !== null && facts.minYears !== null && facts.minYears > f.maxYears) return false;
  if (f.hideCitizenOnly && facts.workAuth) return false;
  if (f.hideGraduatedOnly && facts.student === "graduated") return false;
  const cl = facts.materials.includes("cover_letter");
  if (f.coverLetter === "yes" && !cl) return false;
  if (f.coverLetter === "no" && cl) return false;
  return true;
}

export type ReqStats = {
  total: number;
  /** Jobs read before conditions were recorded. */
  noFacts: number;
  types: Array<{ label: string; n: number }>;
  years: Array<{ label: string; n: number }>;
  limits: Array<{ label: string; n: number }>;
  materials: Array<{ label: string; n: number }>;
  /** Most-asked skills; have = the profile mentions it. */
  keywords: Array<{ k: string; n: number; have: boolean }>;
};

export function reqStats(jobs: JobView[], topK = 24): ReqStats {
  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const types = new Map<string, number>();
  const years = new Map<string, number>();
  const limits = new Map<string, number>();
  const materials = new Map<string, number>();
  const kw = new Map<string, { k: string; n: number; have: boolean; forms: Map<string, number> }>();
  let noFacts = 0;
  for (const j of jobs) {
    const have = new Set((j.kwHave ?? []).map((k) => k.toLowerCase()));
    for (const k of new Set((j.jd?.keywords ?? []).map((x) => x.trim()).filter(Boolean))) {
      const key = k.toLowerCase();
      const e = kw.get(key) ?? { k, n: 0, have: false, forms: new Map<string, number>() };
      e.n++;
      count(e.forms, k);
      e.have ||= have.has(key);
      kw.set(key, e);
    }
    if (isClosed(j)) count(limits, "Closed");
    const f = j.jd?.facts;
    if (!f) {
      noFacts++;
      continue;
    }
    count(types, typeLabel(f) ? (f.type === "internship" ? internLabel(f) : TYPE_LABEL[f.type]) : "Not stated");
    count(years, f.minYears === null ? "Not stated" : f.minYears === 0 ? "No experience" : f.minYears <= 1 ? "1 year" : f.minYears <= 2 ? "2 years" : "3+ years");
    if (f.workAuth) count(limits, AUTH_LABEL[f.workAuth]);
    if (f.student === "graduated") count(limits, "Graduates only");
    if (f.student === "enrolled") count(limits, "Current students only");
    for (const m of f.materials) count(materials, `Asks for ${MATERIAL_LABEL[m].toLowerCase()}`);
  }
  const ordered = (m: Map<string, number>, order?: string[]) =>
    [...m.entries()]
      .map(([label, n]) => ({ label, n }))
      .sort((a, b) => (order ? order.indexOf(a.label) - order.indexOf(b.label) : b.n - a.n));
  return {
    total: jobs.length,
    noFacts,
    types: ordered(types),
    years: ordered(years, ["No experience", "1 year", "2 years", "3+ years", "Not stated"]),
    limits: ordered(limits),
    materials: ordered(materials),
    // Shown the way most postings write it ("Go", not the one posting's "GO").
    keywords: [...kw.values()]
      .map(({ forms, n, have }) => ({ k: [...forms.entries()].sort((a, b) => b[1] - a[1])[0][0], n, have }))
      .sort((a, b) => b.n - a.n || a.k.localeCompare(b.k))
      .slice(0, topK),
  };
}
