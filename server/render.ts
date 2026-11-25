// Resume and cover letter as HTML (the UI previews it) and as PDF (what gets uploaded).
import fs from "node:fs";
import path from "node:path";
import type { Profile } from "./profile.ts";
import { getHeadless } from "./browser.ts";

export type ResumeDoc = Pick<Profile, "basics" | "summary" | "sections" | "skills" | "skillsHeading" | "skillsPosition">;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function contactLine(doc: ResumeDoc) {
  const b = doc.basics;
  const phone = b.phone ? `${b.phoneCountryCode && !b.phone.startsWith("+") ? b.phoneCountryCode + " " : ""}${b.phone}` : "";
  return [phone, b.email, b.linkedin, b.github, b.website].filter(Boolean).map(esc).join(" &bull; ");
}

export function resumeHtml(doc: ResumeDoc, scale = 1) {
  const blocks: string[] = doc.sections.map((s) => {
    const entries = s.entries
      .map((e) => {
        const head =
          e.title || e.dates
            ? `<div class="row"><span class="b">${esc(e.title)}</span><span class="b">${esc(e.dates)}</span></div>`
            : "";
        const sub =
          e.subtitle || e.location
            ? `<div class="row"><span class="b">${esc(e.subtitle)}</span><span>${esc(e.location)}</span></div>`
            : "";
        const bullets = e.bullets.length ? `<ul>${e.bullets.map((x) => `<li>${esc(x.text)}</li>`).join("")}</ul>` : "";
        return `<div class="entry">${head}${sub}${bullets}</div>`;
      })
      .join("");
    return `<section><h2>${esc(s.heading)}</h2>${entries}</section>`;
  });
  const skills = doc.skills.filter((g) => g.items.length);
  if (skills.length) {
    const html = `<section><h2>${esc(doc.skillsHeading || "Skills")}</h2><ul>${skills
      .map((g) => `<li>${g.label ? `<span class="b">${esc(g.label)}:</span> ` : ""}${g.items.map(esc).join(" | ")}</li>`)
      .join("")}</ul></section>`;
    blocks.splice(Math.min(doc.skillsPosition, blocks.length), 0, html);
  }
  const summary = doc.summary ? `<p class="summary">${esc(doc.summary)}</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.basics.name)} Resume</title>
<style>
@page { size: A4; margin: 12mm 15mm; }
* { box-sizing: border-box; }
html { background: #fff; }
body { margin: 0; font-family: Arial, "Helvetica Neue", Helvetica, "Microsoft YaHei", sans-serif; color: #111; font-size: ${(10.6 * scale).toFixed(2)}pt; line-height: 1.22; }
.page { width: 180mm; margin: 0 auto; }
header { text-align: right; margin-bottom: ${(6 * scale).toFixed(1)}pt; }
header h1 { margin: 0; font-size: ${(21 * scale).toFixed(1)}pt; letter-spacing: .3pt; text-transform: uppercase; }
header .contact { margin-top: 1pt; }
.summary { margin: 0 0 ${(4 * scale).toFixed(1)}pt; }
section { margin-top: ${(8 * scale).toFixed(1)}pt; }
h2 { margin: 0 0 ${(3 * scale).toFixed(1)}pt; font-size: ${(11.6 * scale).toFixed(1)}pt; text-transform: uppercase; border-bottom: 2.2pt double #111; padding-bottom: 1pt; }
.entry { margin-bottom: ${(4 * scale).toFixed(1)}pt; break-inside: avoid; }
.row { display: flex; justify-content: space-between; gap: 12pt; }
.b { font-weight: 700; }
ul { margin: 1pt 0 0; padding-left: 16pt; }
li { margin: 0.6pt 0; }
</style></head><body><div class="page">
<header><h1>${esc(doc.basics.name)}</h1><div class="contact">${contactLine(doc)}</div></header>
${summary}${blocks.join("\n")}
</div></body></html>`;
}

export function coverLetterHtml(doc: ResumeDoc, letter: string) {
  const paras = letter
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.basics.name)} Cover Letter</title>
<style>
@page { size: A4; margin: 22mm 22mm; }
body { margin: 0; font-family: Arial, "Helvetica Neue", Helvetica, "Microsoft YaHei", sans-serif; font-size: 11pt; line-height: 1.45; color: #111; }
header { margin-bottom: 18pt; }
header h1 { margin: 0; font-size: 18pt; text-transform: uppercase; }
p { margin: 0 0 10pt; }
</style></head><body>
<header><h1>${esc(doc.basics.name)}</h1><div>${contactLine(doc)}</div></header>
<p>${esc(date)}</p>${paras}
</body></html>`;
}

const PRINTABLE_HEIGHT_PX = ((297 - 24) * 96) / 25.4;

/** Writes a PDF; for resumes, shrinks the type a little (down to 86%) to stay on one page. */
export async function writePdf(outPath: string, html: (scale: number) => string, fitOnePage: boolean) {
  const browser = await getHeadless();
  const page = await browser.newPage();
  try {
    let chosen = 1;
    if (fitOnePage) {
      for (const scale of [1, 0.96, 0.93, 0.9, 0.86]) {
        chosen = scale;
        await page.setContent(html(scale), { waitUntil: "load" });
        await page.emulateMedia({ media: "print" });
        const h = await page.evaluate(() => document.querySelector(".page")?.getBoundingClientRect().height ?? 0);
        if (h <= PRINTABLE_HEIGHT_PX - 4) break;
      }
    }
    await page.setContent(html(chosen), { waitUntil: "load" });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.pdf({ path: outPath, preferCSSPageSize: true, printBackground: true });
    return { scale: chosen };
  } finally {
    await page.close();
  }
}

export function fileBaseName(doc: ResumeDoc) {
  const name = doc.basics.name
    .trim()
    .split(/\s+/)
    .map((w) => (/^[A-Za-z]/.test(w) ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join("_");
  return name.replace(/[\\/:*?"<>|]/g, "") || "Resume";
}
