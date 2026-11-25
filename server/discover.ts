// Finding jobs to add: searches LinkedIn's public job search (the list a signed-out visitor sees)
// and MyCareersFuture's search API, merges and de-duplicates the results, and marks the ones
// already in your list. Nothing is added here; you pick what goes in, and from there the usual
// read → fit score → tailor pipeline runs.
import { all } from "./db.ts";
import { normalizeUrl } from "./jobs.ts";

export type Source = "linkedin" | "mcf";
export type Kind = "fulltime" | "parttime" | "internship";
export type SearchSpec = {
  queries: string[];
  kind: Kind;
  /** Posted within the last N days. */
  days: number;
  sources: Source[];
  /** LinkedIn only: just jobs with Easy Apply (filled inside LinkedIn, no company-site account). */
  easyApplyOnly: boolean;
  /** Results to fetch per query per source. */
  perQuery: number;
  /** Leave out senior/lead/manager titles: LinkedIn's "entry level" filter lets many through. */
  hideSenior: boolean;
};

const SENIOR = /\b(senior|snr|sr|lead|staff|principal|manager|head|director|architect|vp|avp|chief)\b|\b(\d+|five|ten)\s*\+?\s*(years|yrs)\b/i;
/** True for a title that is plainly not entry level. */
export const seniorTitle = (title: string) => SENIOR.test(title);
export type FoundJob = {
  source: Source;
  title: string;
  company: string;
  location: string;
  /** YYYY-MM-DD when known. */
  posted: string;
  url: string;
  salary: string;
  /** Set when this posting is already in your job list. */
  existingId: number | null;
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
function decode(s: string) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
const clean = (html: string) =>
  decode(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

/** Job cards from LinkedIn's public search fragment (jobs-guest/…/seeMoreJobPostings). */
export function parseLinkedInCards(html: string): Omit<FoundJob, "existingId">[] {
  const out: Omit<FoundJob, "existingId">[] = [];
  for (const chunk of html.split(/<li[\s>]/).slice(1)) {
    const href =
      chunk.match(/class="base-card__full-link[^"]*"[^>]*?href="([^"]+)"/)?.[1] ??
      chunk.match(/href="(https:\/\/[a-z]+\.linkedin\.com\/jobs\/view\/[^"]+)"/)?.[1];
    if (!href) continue;
    const url = decode(href).split("?")[0];
    const title = clean(
      chunk.match(/<h3[^>]*base-search-card__title[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? chunk.match(/<span class="sr-only">([\s\S]*?)<\/span>/)?.[1] ?? "",
    );
    const company = clean(chunk.match(/<h4[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/)?.[1] ?? "");
    const location = clean(chunk.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "");
    const posted = chunk.match(/<time[^>]*datetime="([^"]+)"/)?.[1] ?? "";
    const salary = clean(chunk.match(/job-search-card__salary-info[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "");
    if (title)
      out.push({
        source: "linkedin",
        title,
        company,
        location,
        posted,
        url,
        salary,
      });
  }
  return out;
}

async function searchLinkedIn(q: string, spec: SearchSpec): Promise<Omit<FoundJob, "existingId">[]> {
  const out: Omit<FoundJob, "existingId">[] = [];
  for (let start = 0; start < spec.perQuery; start += 10) {
    const p = new URLSearchParams({
      keywords: q,
      location: "Singapore",
      f_TPR: `r${spec.days * 86400}`,
      start: String(start),
    });
    if (spec.kind === "fulltime") {
      p.set("f_JT", "F");
      p.set("f_E", "2"); // entry level
    } else if (spec.kind === "parttime") p.set("f_JT", "P");
    else p.set("f_JT", "I");
    if (spec.easyApplyOnly) p.set("f_AL", "true");
    const r = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p}`, {
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 429) throw new Error("LinkedIn is refusing searches for now (too many requests); try again in a few minutes");
    if (!r.ok) throw new Error(`LinkedIn search failed (${r.status})`);
    const cards = parseLinkedInCards(await r.text());
    out.push(...cards);
    if (cards.length < 10) break;
  }
  return out.slice(0, spec.perQuery);
}

/** Results from MyCareersFuture's search API mapped to FoundJob. */
export function mapMcf(results: any[]): Omit<FoundJob, "existingId">[] {
  return results
    .filter((r) => r?.metadata?.jobDetailsUrl && r?.title)
    .map((r) => {
      const s = r.salary;
      const salary =
        s && (s.minimum || s.maximum) && !r.metadata.isHideSalary
          ? `S$${s.minimum ?? "?"}–${s.maximum ?? "?"}${s.type?.salaryType === "Monthly" ? "/month" : ""}`
          : "";
      const company = (r.metadata.isPostedOnBehalf && !r.metadata.isHideHiringEmployerName && r.hiringCompany?.name) || r.postedCompany?.name || "";
      const location = (r.address?.districts?.[0]?.location as string) || (Array.isArray(r.address) ? r.address[0]?.location : "") || "Singapore";
      return {
        source: "mcf" as const,
        title: String(r.title).trim(),
        company: String(company).trim(),
        location,
        posted: String(r.metadata.newPostingDate ?? ""),
        url: r.metadata.jobDetailsUrl,
        salary,
      };
    });
}

async function searchMcf(q: string, spec: SearchSpec): Promise<Omit<FoundJob, "existingId">[]> {
  const body: Record<string, unknown> = {
    search: q,
    sortBy: ["new_posting_date"],
  };
  if (spec.kind === "fulltime") {
    body.positionLevels = ["Fresh/entry level"];
    body.employmentTypes = ["Full Time"];
  } else if (spec.kind === "parttime") body.employmentTypes = ["Part Time"];
  else body.employmentTypes = ["Internship/Attachment"];
  const r = await fetch(`https://api.mycareersfuture.gov.sg/v2/search?limit=${Math.min(50, spec.perQuery)}&page=0`, {
    method: "POST",
    headers: { "user-agent": UA, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`MyCareersFuture search failed (${r.status})`);
  const j = (await r.json()) as { results?: any[] };
  const since = new Date(Date.now() - spec.days * 86_400_000).toISOString().slice(0, 10);
  return mapMcf(j.results ?? []).filter((f) => (!f.posted || f.posted >= since) && relevantTitle(f.title, q));
}

const FILLER = new Set(["part", "full", "time", "intern", "internship", "interns", "junior", "senior", "graduate", "fresh", "entry", "level", "the", "and", "for", "with", "job", "jobs", "role"]);
/** MyCareersFuture's search is fuzzy: "developer" also brings back "Business Development" sales roles.
 *  Keep a title only when it carries one of the query's own words. */
export function relevantTitle(title: string, query: string) {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length >= 2 && !FILLER.has(w));
  if (!words.length) return true;
  const t = ` ${title.toLowerCase().replace(/[^a-z0-9+#]+/g, " ")} `;
  return words.some((w) => t.includes(` ${w} `) || t.includes(` ${w}s `));
}

/** Plain text of a MyCareersFuture job from its API record. */
export function mcfJobText(j: any): { title: string; text: string } {
  const html = String(j?.description ?? "");
  const description = decode(
    html
      .replace(/<\/(p|li|h\d|div|ul|ol)>|<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*(\n\s*)+/g, "\n\n")
    .trim();
  const company = (j?.metadata?.isPostedOnBehalf && !j?.metadata?.isHideHiringEmployerName && j?.hiringCompany?.name) || j?.postedCompany?.name || "";
  const names = (xs: any[] | undefined, k: string) =>
    (xs ?? [])
      .map((x) => x?.[k])
      .filter(Boolean)
      .join(", ");
  const s = j?.salary;
  const title = String(j?.title ?? "").trim();
  const lines = [
    title,
    company,
    j?.status?.jobStatus && j.status.jobStatus !== "Open" ? `Status: ${j.status.jobStatus} (no longer accepting applications)` : "",
    names(j?.employmentTypes, "employmentType") ? `Employment type: ${names(j.employmentTypes, "employmentType")}` : "",
    names(j?.positionLevels, "position") ? `Position level: ${names(j.positionLevels, "position")}` : "",
    j?.minimumYearsExperience != null ? `Minimum years of experience: ${j.minimumYearsExperience}` : "",
    s && (s.minimum || s.maximum) && !j?.metadata?.isHideSalary ? `Salary: S$${s.minimum ?? "?"} to S$${s.maximum ?? "?"} ${s.type?.salaryType ?? ""}`.trim() : "",
    "",
    description,
    names(j?.skills, "skill") ? `\nSkills: ${names(j.skills, "skill")}` : "",
  ];
  return {
    title: company ? `${title} | ${company}` : title,
    text: lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 24_000),
  };
}

/** MyCareersFuture pages are a single-page app whose text can look like a sign-in wall; its own API has the whole posting. */
export async function mcfPostingText(url: string): Promise<{ title: string; text: string } | null> {
  const id = url.match(/mycareersfuture\.gov\.sg\/job\/[^?#]*?([0-9a-f]{32})/i)?.[1];
  if (!id) return null;
  const r = await fetch(`https://api.mycareersfuture.gov.sg/v2/jobs/${id.toLowerCase()}`, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const got = mcfJobText(await r.json());
  return got.text.length > 200 ? got : null;
}

/** One key per posting: LinkedIn serves the same job under sg./www. and with or without the title slug. */
export function jobKey(url: string) {
  const li = url.match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/i);
  if (li) return `linkedin:${li[1]}`;
  const mcf = url.match(/mycareersfuture\.gov\.sg\/job\/[^?#]*?([0-9a-f]{32})/i);
  if (mcf) return `mcf:${mcf[1].toLowerCase()}`;
  return normalizeUrl(url);
}

/** Drops repeats (same posting, or the same title at the same company from the other site) and marks jobs already in the list. */
export function mergeFound(lists: Omit<FoundJob, "existingId">[][], known: Map<string, number>): FoundJob[] {
  const seen = new Set<string>();
  const out: FoundJob[] = [];
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(pte|ltd|private|limited|inc|llc)\b\.?/g, "")
      .replace(/[^a-z0-9一-鿿]+/g, " ")
      .trim();
  for (const list of lists)
    for (const f of list) {
      const k1 = jobKey(f.url);
      const k2 = `${norm(f.title)}|${norm(f.company)}`;
      if (seen.has(k1) || seen.has(k2)) continue;
      seen.add(k1);
      seen.add(k2);
      out.push({ ...f, existingId: known.get(k1) ?? null });
    }
  return out.sort((a, b) => (b.posted || "").localeCompare(a.posted || ""));
}

export async function searchJobs(spec: SearchSpec): Promise<{ found: FoundJob[]; errors: string[]; hidden: number }> {
  const errors: string[] = [];
  const tasks: Promise<Omit<FoundJob, "existingId">[]>[] = [];
  for (const q of spec.queries)
    for (const src of spec.sources)
      tasks.push(
        (src === "linkedin" ? searchLinkedIn(q, spec) : searchMcf(q, spec)).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          if (!errors.includes(msg)) errors.push(msg);
          return [];
        }),
      );
  const lists = await Promise.all(tasks);
  const known = new Map<string, number>();
  for (const j of all<{ id: number; url: string }>("SELECT id, url FROM jobs WHERE url != ''")) known.set(jobKey(j.url), j.id);
  const merged = mergeFound(lists, known);
  const found = spec.hideSenior ? merged.filter((f) => !seniorTitle(f.title)) : merged;
  return { found, errors, hidden: merged.length - found.length };
}
