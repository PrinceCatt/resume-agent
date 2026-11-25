// What postings ask for, as labels, filters and counts. Plain functions (no React) so the job list,
// the Excel export and the tests use the same rules.
import type { JobFacts, JobView, Material } from "./api.ts";

export const TYPE_LABEL: Record<JobFacts["type"], string> = { fulltime: "全职", parttime: "兼职", internship: "实习", contract: "合同工", unknown: "没写" };
export const DEGREE_LABEL: Record<Exclude<JobFacts["degree"], "">, string> = { none: "不限学历", diploma: "大专", bachelor: "本科", master: "硕士", phd: "博士" };
export const MATERIAL_LABEL: Record<Material, string> = { cover_letter: "求职信", transcript: "成绩单", portfolio: "作品集", references: "推荐人", other: "其他材料" };
export const AUTH_LABEL: Record<Exclude<JobFacts["workAuth"], "">, string> = { citizen: "仅限公民", citizen_pr: "仅限公民/PR" };

/** "兼职实习 3 个月", "全职", "" */
export function typeLabel(f: JobFacts) {
  if (f.type === "internship") return `${f.hours === "part" ? "兼职" : f.hours === "full" ? "全职" : ""}实习${f.months ? ` ${f.months} 个月` : ""}`;
  if (f.type === "contract") return `合同工${f.months ? ` ${f.months} 个月` : ""}`;
  return f.type === "unknown" ? "" : TYPE_LABEL[f.type];
}

export const yearsLabel = (n: number) => (n === 0 ? "不要经验" : `${n} 年以上经验`);

/** Short labels for a job's conditions, in a fixed order; the warning ones are flagged. */
export function factChips(f: JobFacts | null): Array<{ text: string; warn?: boolean }> {
  if (!f) return [];
  const out: Array<{ text: string; warn?: boolean }> = [];
  const t = typeLabel(f);
  if (t) out.push({ text: t });
  if (f.minYears !== null) out.push({ text: yearsLabel(f.minYears), warn: f.minYears >= 2 });
  if (f.student === "graduated") out.push({ text: "须已毕业", warn: true });
  if (f.student === "enrolled") out.push({ text: "须在读" });
  if (f.workAuth) out.push({ text: AUTH_LABEL[f.workAuth], warn: true });
  for (const m of f.materials) out.push({ text: `要${MATERIAL_LABEL[m]}` });
  if (f.start) out.push({ text: `开始 ${f.start}` });
  return out;
}

export const KINDS = ["fulltime", "intern_part", "intern_full", "parttime"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABEL: Record<Kind, string> = { fulltime: "全职", intern_part: "兼职实习", intern_full: "全职实习", parttime: "兼职" };

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
    if (isClosed(j)) count(limits, "已关闭");
    const f = j.jd?.facts;
    if (!f) {
      noFacts++;
      continue;
    }
    count(types, typeLabel(f) ? (f.type === "internship" ? `${f.hours === "part" ? "兼职" : f.hours === "full" ? "全职" : ""}实习` : TYPE_LABEL[f.type]) : "没写");
    count(years, f.minYears === null ? "没写" : f.minYears === 0 ? "不要经验" : f.minYears <= 1 ? "1 年" : f.minYears <= 2 ? "2 年" : "3 年以上");
    if (f.workAuth) count(limits, AUTH_LABEL[f.workAuth]);
    if (f.student === "graduated") count(limits, "须已毕业");
    if (f.student === "enrolled") count(limits, "须在读");
    for (const m of f.materials) count(materials, `要${MATERIAL_LABEL[m]}`);
  }
  const ordered = (m: Map<string, number>, order?: string[]) =>
    [...m.entries()]
      .map(([label, n]) => ({ label, n }))
      .sort((a, b) => (order ? order.indexOf(a.label) - order.indexOf(b.label) : b.n - a.n));
  return {
    total: jobs.length,
    noFacts,
    types: ordered(types),
    years: ordered(years, ["不要经验", "1 年", "2 年", "3 年以上", "没写"]),
    limits: ordered(limits),
    materials: ordered(materials),
    // Shown the way most postings write it ("Go", not the one posting's "GO").
    keywords: [...kw.values()]
      .map(({ forms, n, have }) => ({ k: [...forms.entries()].sort((a, b) => b[1] - a[1])[0][0], n, have }))
      .sort((a, b) => b.n - a.n || a.k.localeCompare(b.k))
      .slice(0, topK),
  };
}
