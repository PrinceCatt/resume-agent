// The master profile: everything a tailored resume or an application answer may draw on.
// Tailoring may select, reorder and reword what is here, never add to it.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, get, run } from "./db.ts";

export type Bullet = { id: string; text: string };
export type Entry = {
  id: string;
  /** Left of the first line, bold (school, company, project). Empty for a plain bullet list. */
  title: string;
  /** Right of the first line. */
  dates: string;
  /** Left of the second line (degree, role). */
  subtitle: string;
  /** Right of the second line. */
  location: string;
  bullets: Bullet[];
};
export type Section = { id: string; heading: string; entries: Entry[] };
export type SkillGroup = { id: string; label: string; items: string[] };
export type Answer = { id: string; q: string; a: string };
export type Basics = {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneCountryCode: string;
  location: string;
  linkedin: string;
  github: string;
  website: string;
};
export type Profile = {
  basics: Basics;
  summary: string;
  sections: Section[];
  skills: SkillGroup[];
  skillsHeading: string;
  /** Index in sections before which the skills block is printed. */
  skillsPosition: number;
  /** Material that is true but not on the resume (internships, projects, numbers). */
  extraFacts: string;
  /** Answers to recurring application questions; an empty answer means "ask me". */
  answers: Answer[];
};

let seq = 0;
export function newId(prefix: string) {
  seq = (seq + 1) % 1000;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

export const EMPTY_PROFILE: Profile = {
  basics: { name: "", firstName: "", lastName: "", email: "", phone: "", phoneCountryCode: "+65", location: "", linkedin: "", github: "", website: "" },
  summary: "",
  sections: [],
  skills: [],
  skillsHeading: "Technical Skills",
  skillsPosition: 2,
  extraFacts: "",
  answers: [],
};

/** Questions most application forms ask; answers start empty so the agent asks the first time. */
export const COMMON_QUESTIONS = [
  "Are you legally authorized to work in Singapore?",
  "Will you now or in the future require visa sponsorship?",
  "Earliest start date / availability",
  "Internship duration you are available for",
  "Expected salary / stipend",
  "Notice period",
  "Graduation date",
  "Gender (voluntary self-identification)",
  "Race / ethnicity (voluntary self-identification)",
  "How did you hear about this job?",
];

const SEED_FILE = path.join(DATA_DIR, "seed-profile.json");

export function getProfile(): Profile {
  const row = get<{ data: string }>("SELECT data FROM profile WHERE id = 1");
  if (row) return normalizeProfile(JSON.parse(row.data));
  const seed = fs.existsSync(SEED_FILE) ? normalizeProfile(JSON.parse(fs.readFileSync(SEED_FILE, "utf8"))) : EMPTY_PROFILE;
  saveProfile(seed);
  return seed;
}

export function saveProfile(p: Profile): Profile {
  const clean = normalizeProfile(p);
  run(
    "INSERT INTO profile (id, data, updated_at) VALUES (1, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    JSON.stringify(clean),
  );
  return clean;
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Fills in missing fields and ids so the rest of the code can trust the shape. */
export function normalizeProfile(raw: any): Profile {
  const b = raw?.basics ?? {};
  return {
    basics: {
      name: str(b.name),
      firstName: str(b.firstName),
      lastName: str(b.lastName),
      email: str(b.email),
      phone: str(b.phone),
      phoneCountryCode: str(b.phoneCountryCode) || "+65",
      location: str(b.location),
      linkedin: str(b.linkedin),
      github: str(b.github),
      website: str(b.website),
    },
    summary: str(raw?.summary),
    sections: arr<any>(raw?.sections).map((s) => ({
      id: str(s.id) || newId("sec"),
      heading: str(s.heading),
      entries: arr<any>(s.entries).map((e) => ({
        id: str(e.id) || newId("ent"),
        title: str(e.title),
        dates: str(e.dates),
        subtitle: str(e.subtitle),
        location: str(e.location),
        bullets: arr<any>(e.bullets)
          .map((x) => (typeof x === "string" ? { id: "", text: x } : x))
          .map((x) => ({ id: str(x.id) || newId("b"), text: str(x.text) }))
          .filter((x) => x.text.trim()),
      })),
    })),
    skills: arr<any>(raw?.skills).map((g) => ({
      id: str(g.id) || newId("sk"),
      label: str(g.label),
      items: arr<unknown>(g.items).map(str).map((s) => s.trim()).filter(Boolean),
    })),
    skillsHeading: str(raw?.skillsHeading) || "Technical Skills",
    skillsPosition: Number.isFinite(raw?.skillsPosition) ? Math.max(0, Math.floor(raw.skillsPosition)) : 2,
    extraFacts: str(raw?.extraFacts),
    answers: arr<any>(raw?.answers).map((a) => ({ id: str(a.id) || newId("qa"), q: str(a.q), a: str(a.a) })),
  };
}

/** Plain-text dump with ids, for prompts. */
export function profileForPrompt(p: Profile, opts: { withIds: boolean }) {
  const lines: string[] = [];
  const b = p.basics;
  lines.push(`Name: ${b.name} (first: ${b.firstName}, last: ${b.lastName})`);
  lines.push(`Email: ${b.email} | Phone: ${b.phoneCountryCode} ${b.phone} | Location: ${b.location}`);
  if (b.linkedin) lines.push(`LinkedIn: ${b.linkedin}`);
  if (b.github) lines.push(`GitHub: ${b.github}`);
  if (b.website) lines.push(`Website: ${b.website}`);
  if (p.summary) lines.push(`Summary: ${p.summary}`);
  for (const s of p.sections) {
    lines.push("", `## ${s.heading}${opts.withIds ? ` [${s.id}]` : ""}`);
    for (const e of s.entries) {
      const head = [e.title, e.subtitle, e.location, e.dates].filter(Boolean).join(" | ");
      if (head) lines.push(`- ${head}${opts.withIds ? ` [${e.id}]` : ""}`);
      else if (opts.withIds) lines.push(`- (list) [${e.id}]`);
      for (const x of e.bullets) lines.push(`    * ${x.text}${opts.withIds ? ` [${x.id}]` : ""}`);
    }
  }
  lines.push("", "## Skills");
  for (const g of p.skills) lines.push(`- ${g.label}${opts.withIds ? ` [${g.id}]` : ""}: ${g.items.join(", ")}`);
  return lines.join("\n");
}

/** Extracts the text layer of a PDF resume (no OCR). */
export async function pdfText(buf: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: buf, useSystemFonts: true }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    const out: string[] = [];
    let lastY: number | null = null;
    for (const it of content.items as Array<{ str: string; transform: number[]; hasEOL?: boolean }>) {
      const y = it.transform?.[5] ?? 0;
      if (lastY !== null && Math.abs(y - lastY) > 2 && line) {
        out.push(line);
        line = "";
      }
      line += it.str;
      lastY = y;
      if (it.hasEOL) {
        out.push(line);
        line = "";
        lastY = null;
      }
    }
    if (line) out.push(line);
    pages.push(out.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n"));
  }
  await doc.loadingTask.destroy();
  return pages.join("\n\n");
}
