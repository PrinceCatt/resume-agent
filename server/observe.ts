// Page snapshot for the agent: every form control, button and action link in every frame
// (open shadow roots included), tagged with a data-ra-id the agent refers to.
import type { Frame, Locator, Page } from "playwright-core";

export type El = {
  id: string;
  kind: string; // text/email/tel/... | textarea | select | combobox | radio | checkbox | file | button | link | option | editable
  label: string;
  group: string;
  value: string;
  checked: boolean | null;
  required: boolean;
  disabled: boolean;
  invalid: boolean;
  hidden: boolean;
  options: string[] | null;
  optionCount: number;
  text: string;
  href: string;
  submitType: boolean;
  inForm: boolean;
  /** Inside the dialog that is open on top of the page (LinkedIn Easy Apply, a cookie notice). */
  inDialog: boolean;
};

/** omitted: ordinary buttons and links left out to keep the snapshot small. */
export type Obs = {
  url: string;
  title: string;
  errors: string[];
  elements: El[];
  excerpt: string;
  omitted?: number;
};

// Runs inside the page. Must stay self-contained (it is serialized).
function collect(arg: { prefix: string; ordinary: number }) {
  const prefix = arg.prefix;
  const W = window as any;
  W.__raN = W.__raN || 0;
  const txt = (s: any) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  const ACTION = /apply|submit|next|continue|review|send|sign in|log ?in|upload|申请|投递|提交|下一步|继续|登录|上传|沟通|发送/i;
  // Buttons outside a form that still matter: cookie and consent notices, adding or editing an entry.
  const KEEP = /accept|agree|allow|consent|got it|\badd\b|\bedit\b|remove|\bdone\b|confirm|^ok$|同意|接受|允许|添加|编辑|删除|确定|知道了/i;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.02;
  };
  const byId = (id: string | null) => (id ? (document.getElementById(id) as HTMLElement | null) : null);
  const CHOICE = "input[type=radio], input[type=checkbox], [role=radio], [role=checkbox]";
  const sameName = (el: any): any[] =>
    el.name ? Array.from((el.getRootNode() as Document | ShadowRoot).querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)) : [el];
  // The words drawn next to a radio or checkbox: its label's text, else the nearest wrapper that
  // holds this one control and some text (LinkedIn's 2026 Easy Apply leaves the label empty and
  // prints "Yes"/"No" in a <p> beside it).
  const optionText = (el: any): string => {
    const own = el.labels ? txt((Array.from(el.labels) as HTMLElement[]).map((l) => l.innerText).join(" ")) : "";
    if (own) return own;
    let node: HTMLElement | null = el.parentElement;
    for (let d = 0; d < 4 && node; d++, node = node.parentElement) {
      if (node.querySelectorAll(CHOICE).length > 1) break;
      const t = txt(node.innerText);
      if (t) return t.length < 160 ? t : "";
    }
    return "";
  };
  // LinkedIn's 2026 Easy Apply also gives every option of a question the question itself as its
  // aria-label. When all options of one radio name share an aria-label, it names the group, not
  // the option; read as the option, the model saw two identical choices and "Yes" as the question.
  const sharedAria = (el: any): string => {
    const al = el.getAttribute("aria-label");
    if (!al || !el.name) return "";
    const all = sameName(el);
    return all.length > 1 && all.every((i) => i.getAttribute("aria-label") === al) ? txt(al) : "";
  };
  const labelOf = (el: any): string => {
    if (el.tagName === "INPUT" && (el.type === "radio" || el.type === "checkbox")) {
      const q = sharedAria(el);
      const own = el.labels ? txt((Array.from(el.labels) as HTMLElement[]).map((l) => l.innerText).join(" ")) : "";
      if (q) {
        const o = optionText(el);
        if (o && o !== q) return o.slice(0, 180);
      } else if (!own && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby")) {
        const o = optionText(el);
        if (o) return o.slice(0, 180);
      }
    }
    const parts: string[] = [];
    if (el.labels && el.labels.length) for (const l of Array.from(el.labels) as HTMLElement[]) parts.push(l.innerText);
    const lb = el.getAttribute("aria-labelledby");
    if (lb)
      parts.push(
        lb
          .split(/\s+/)
          .map((i: string) => byId(i)?.innerText || "")
          .join(" "),
      );
    const al = el.getAttribute("aria-label");
    if (al) parts.push(al);
    if (!txt(parts.join(""))) {
      const l = el.closest("label");
      if (l) parts.push(l.innerText);
    }
    if (!txt(parts.join(""))) {
      let node: Element | null = el;
      for (let d = 0; d < 4 && node && !txt(parts.join("")); d++) {
        let sib = node.previousElementSibling as HTMLElement | null;
        while (sib && !txt(parts.join(""))) {
          const t = txt(sib.innerText);
          if (t && t.length < 220) parts.push(t);
          sib = sib.previousElementSibling as HTMLElement | null;
        }
        node = node.parentElement;
      }
    }
    if (!txt(parts.join("")) && el.placeholder) parts.push(el.placeholder);
    if (!txt(parts.join("")) && el.name) parts.push(el.name);
    const desc = el.getAttribute("aria-describedby");
    let out = txt(parts.join(" "));
    if (desc && out.length < 60) {
      const d = txt(
        desc
          .split(/\s+/)
          .map((i: string) => byId(i)?.innerText || "")
          .join(" "),
      );
      if (d && d.length < 120) out += ` (${d})`;
    }
    return out.slice(0, 180);
  };
  const groupOf = (el: any): string => {
    const fs = el.closest("fieldset");
    const lg = fs && fs.querySelector("legend");
    if (lg)
      return txt(lg.innerText)
        .replace(/\s*\*$/, "")
        .slice(0, 220);
    const rg = el.closest("[role=radiogroup],[role=group]");
    if (rg) {
      const l = rg.getAttribute("aria-label") || byId(rg.getAttribute("aria-labelledby"))?.innerText;
      if (l) return txt(l).slice(0, 220);
    }
    const shared = sharedAria(el);
    if (shared) return shared.slice(0, 220);
    if (el.name && (el.type === "radio" || el.type === "checkbox")) {
      const all = sameName(el);
      if (all.length > 1) {
        let a: HTMLElement | null = el.parentElement;
        while (a && a.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`).length < all.length) a = a.parentElement;
        if (a) {
          // The options' own words are not the question.
          const options = new Set(all.map((i) => optionText(i)).filter(Boolean));
          const lines = String(a.innerText || "")
            .split("\n")
            .map(txt)
            .filter((l) => l && !options.has(l));
          if (lines[0]) return lines[0].slice(0, 220);
          // Only the options inside: the question is printed just before the group.
          for (let node: HTMLElement | null = a, d = 0; node && d < 3; node = node.parentElement, d++) {
            const prev = node.previousElementSibling as HTMLElement | null;
            const t = prev ? txt(prev.innerText) : "";
            if (t && t.length < 220 && !options.has(t)) return t.replace(/\s*\*$/, "");
          }
        }
      }
    }
    return "";
  };

  const roots: Array<Document | ShadowRoot> = [document];
  const nodes: Element[] = [];
  const SEL =
    'input:not([type=hidden]), textarea, select, button, a[href], [role=button], [role=combobox], [role=radio], [role=checkbox], [role=switch], [role=textbox], [role=option], [contenteditable="true"]';
  while (roots.length) {
    const r = roots.shift()!;
    for (const el of Array.from(r.querySelectorAll("*"))) if ((el as any).shadowRoot) roots.push((el as any).shadowRoot);
    nodes.push(...Array.from(r.querySelectorAll(SEL)));
  }
  // An open dialog sits on top of the page: list its controls first, so a busy page behind it
  // (LinkedIn's job list) cannot push them past the element cap.
  const dialog =
    (Array.from(document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open], [aria-modal="true"]')) as HTMLElement[])
      .filter((d) => visible(d) && d.querySelector(SEL))
      .pop() ?? null;

  const out: any[] = [];
  const seen = new Set<Element>();
  for (const el of nodes as any[]) {
    if (seen.has(el)) continue;
    seen.add(el);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const type = (el.getAttribute("type") || "").toLowerCase();
    const isFile = tag === "input" && type === "file";
    const vis = visible(el);
    // File inputs are usually hidden behind a styled button: keep them when their surroundings show.
    const fileShown =
      isFile && !vis && !!el.parentElement && (visible(el.parentElement) || (!!el.parentElement.parentElement && visible(el.parentElement.parentElement)));
    // Same for radios and checkboxes drawn by their label: LinkedIn's Easy Apply yes/no questions
    // keep the real input at opacity 0, so they used to vanish from the snapshot and the model
    // could not answer them.
    const labelShown =
      !vis && tag === "input" && (type === "radio" || type === "checkbox") && !!el.labels && (Array.from(el.labels) as Element[]).some(visible);
    if (!vis && !fileShown && !labelShown) continue;
    if (tag === "input" && (type === "submit" || type === "button" || type === "reset" || type === "image")) {
      /* treated as a button below */
    }
    let kind = "";
    if (isFile) kind = "file";
    else if (tag === "select") kind = "select";
    else if (tag === "textarea") kind = "textarea";
    else if (tag === "input" && (type === "radio" || type === "checkbox")) kind = type;
    else if (tag === "input" && (type === "submit" || type === "button" || type === "image")) kind = "button";
    else if (tag === "input" && type === "reset") continue;
    else if (role === "combobox" || (tag === "input" && el.getAttribute("aria-autocomplete"))) kind = "combobox";
    else if (tag === "input") kind = type || "text";
    else if (role === "radio" || role === "checkbox" || role === "switch") kind = role === "switch" ? "checkbox" : role;
    else if (role === "option") kind = "option";
    else if (role === "textbox" || el.isContentEditable) kind = "editable";
    else if (tag === "button" || role === "button") kind = "button";
    else if (tag === "a") kind = "link";
    if (!kind) continue;
    const text =
      kind === "button" || kind === "link" || kind === "option" ? txt(el.innerText || el.value || el.getAttribute("aria-label") || el.title).slice(0, 120) : "";
    if (kind === "link" && !(ACTION.test(text) || el.closest("form"))) continue;
    if ((kind === "button" || kind === "link") && !text) continue;

    let id = el.getAttribute("data-ra-id");
    if (!id) {
      id = prefix + ++W.__raN;
      el.setAttribute("data-ra-id", id);
    }
    let value = "";
    let checked: boolean | null = null;
    let options: string[] | null = null;
    let optionCount = 0;
    if (kind === "file")
      value = Array.from(el.files || [])
        .map((f: any) => f.name)
        .join(", ");
    else if (kind === "select") {
      const opts = Array.from(el.options as ArrayLike<HTMLOptionElement>);
      optionCount = opts.length;
      options = opts.slice(0, 40).map((o) => txt(o.text));
      value = el.selectedIndex >= 0 ? txt(opts[el.selectedIndex]?.text) : "";
      if (el.selectedIndex >= 0 && !opts[el.selectedIndex]?.value) value = "";
    } else if (kind === "radio" || kind === "checkbox") {
      checked = tag === "input" ? !!el.checked : el.getAttribute("aria-checked") === "true";
    } else if (kind === "editable") value = txt(el.innerText).slice(0, 300);
    else if (kind !== "button" && kind !== "link" && kind !== "option") value = String(el.value ?? "").slice(0, 300);
    if (kind === "combobox" && !value) value = txt(el.innerText).slice(0, 120);

    let label = kind === "button" || kind === "link" || kind === "option" ? "" : labelOf(el);
    // Many forms mark required fields only with an asterisk in the label.
    const starred = /\*\s*$|\(required\)\s*$|（必填）\s*$/i.test(label);
    label = label.replace(/\s*(\*|\(required\)|（必填）)\s*$/i, "");
    out.push({
      id,
      kind,
      label,
      group: kind === "radio" || kind === "checkbox" ? groupOf(el) : "",
      value,
      checked,
      required: !!(el.required || el.getAttribute("aria-required") === "true" || starred),
      disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true"),
      invalid: el.getAttribute("aria-invalid") === "true",
      hidden: !vis && !labelShown,
      options,
      optionCount,
      text,
      href: kind === "link" ? String(el.href || "").slice(0, 200) : "",
      submitType: (tag === "button" && (el.type === "submit" || !el.getAttribute("type")) && !!el.form) || (tag === "input" && type === "submit"),
      inForm: !!el.closest("form"),
      inDialog: !!dialog && dialog.contains(el),
      pri:
        dialog && dialog.contains(el)
          ? 0
          : (kind !== "button" && kind !== "link" && kind !== "option") || ACTION.test(text) || KEEP.test(text) || !!el.closest("form")
            ? 1
            : 2,
      idx: out.length,
    });
  }
  // Keep the snapshot small without losing what matters: everything in an open dialog, every form
  // field, every button inside a form and every apply/next/submit-like button come first; ordinary
  // buttons and links (a long "similar jobs" list with Save/Hide on each, menus) only up to `ordinary`,
  // fewer behind an open dialog. Before the priorities, such a list pushed a job page's own Apply button
  // past the cap; before the ordinary limit, it filled the cap and was most of a 3,500-token snapshot
  // sent every step (2026-11-15). The agent asks for all of them after a turn that scrolled or failed.
  const CAP = 260;
  const ordinaryCap = arg.ordinary >= CAP ? CAP : dialog ? Math.min(arg.ordinary, 15) : arg.ordinary;
  const kept: any[] = [];
  let ordinary = 0;
  for (const e of [...out].sort((a, b) => a.pri - b.pri || a.idx - b.idx)) {
    if (kept.length >= CAP) break;
    if (e.pri === 2 && ordinary++ >= ordinaryCap) continue;
    kept.push(e);
  }
  const omitted = out.length - kept.length;
  kept.sort((a, b) => Number(b.inDialog) - Number(a.inDialog) || a.idx - b.idx);
  for (const e of kept) {
    delete e.pri;
    delete e.idx;
  }

  const errors: string[] = [];
  for (const e of Array.from(
    document.querySelectorAll(
      '[role=alert], .error, .errors, .field-error, .invalid-feedback, [class*="error-message"], [class*="errorMessage"], [data-testid*="error"]',
    ),
  ) as HTMLElement[]) {
    if (!visible(e)) continue;
    const t = txt(e.innerText);
    if (t && t.length < 240 && !errors.includes(t)) errors.push(t);
    if (errors.length >= 10) break;
  }
  return {
    elements: kept,
    omitted,
    errors,
    excerpt: txt(document.body?.innerText || "").slice(0, 1800),
    title: document.title,
  };
}

const frameIds = new WeakMap<Frame, string>();
let frameSeq = 0;
function framePrefix(f: Frame) {
  let p = frameIds.get(f);
  if (!p) {
    p = `f${frameSeq++}_`;
    frameIds.set(f, p);
  }
  return p;
}

/** more: list every ordinary button and link too (up to the cap), for when the agent is looking for one. */
export async function observe(page: Page, more = false): Promise<Obs> {
  const elements: El[] = [];
  const errors: string[] = [];
  let excerpt = "";
  let title = "";
  let omitted = 0;
  for (const f of page.frames()) {
    if (f.isDetached()) continue;
    const main = f === page.mainFrame();
    if (!main) {
      const box = await f
        .frameElement()
        .then((h) => h.boundingBox())
        .catch(() => null);
      if (!box || box.width < 60 || box.height < 60) continue;
    }
    try {
      const r = await f.evaluate(collect, { prefix: framePrefix(f), ordinary: more ? 260 : 40 });
      elements.push(...(r.elements as El[]));
      errors.push(...r.errors);
      omitted += r.omitted;
      if (main) {
        excerpt = r.excerpt;
        title = r.title;
      } else if (r.elements.length) excerpt += `\n[frame] ${r.excerpt.slice(0, 900)}`;
    } catch {
      /* frame navigated mid-read */
    }
  }
  return {
    url: page.url(),
    title,
    errors: [...new Set(errors)].slice(0, 12),
    elements,
    excerpt,
    omitted,
  };
}

export function locate(page: Page, id: string): Locator | null {
  const prefix = id.replace(/\d+$/, "");
  const frame = page.frames().find((f) => frameIds.get(f) === prefix);
  if (!frame || frame.isDetached()) return null;
  return frame.locator(`[data-ra-id="${id.replace(/"/g, "")}"]`).first();
}

const q = (s: string) => JSON.stringify(s.length > 140 ? s.slice(0, 140) + "…" : s);

/** Compact text form of a snapshot for the model. */
export function formatObs(o: Obs, step: number) {
  const lines: string[] = [`STEP ${step} — page snapshot`, `URL: ${o.url}`, `Title: ${o.title}`];
  if (o.errors.length) lines.push(`Errors/alerts on page: ${o.errors.map((e) => q(e)).join(" ; ")}`);
  lines.push("Elements:");
  const dialogOpen = o.elements.some((e) => e.inDialog);
  if (dialogOpen) lines.push("  -- inside the dialog open on top of the page (work here first) --");
  let lastGroup = "";
  let behind = false;
  for (const e of o.elements) {
    if (dialogOpen && !e.inDialog && !behind) {
      behind = true;
      lastGroup = "";
      lines.push("  -- behind the dialog (usually not usable until it closes) --");
    }
    if ((e.kind === "radio" || e.kind === "checkbox") && e.group && e.group !== lastGroup) {
      lines.push(`  group ${q(e.group)}:`);
    }
    lastGroup = e.kind === "radio" || e.kind === "checkbox" ? e.group : "";
    lines.push((lastGroup ? "    " : "") + elLine(e));
  }
  if (!o.elements.length) lines.push("  (no interactive elements found)");
  if (o.omitted)
    lines.push(
      `  (${o.omitted} more ordinary buttons/links not listed, e.g. long lists of other jobs, menus; every form field, every button inside a form and every apply/next/submit-like button IS listed. If you need one that is not listed, scroll once: the next snapshot lists them all)`,
    );
  lines.push("Visible text (start):", o.excerpt.slice(0, 1800));
  return lines.join("\n");
}

function elLine(e: El, options = true) {
  const flags = [e.required ? "*required" : "", e.disabled ? "disabled" : "", e.invalid ? "INVALID" : "", e.hidden ? "hidden" : ""].filter(Boolean).join(" ");
  let line = `[${e.id}] ${e.kind}`;
  if (e.kind === "button" || e.kind === "link" || e.kind === "option") line += ` ${q(e.text)}`;
  else line += ` ${q(e.label)}`;
  if (flags) line += ` ${flags}`;
  if (e.kind === "radio" || e.kind === "checkbox") line += e.checked ? " [x]" : " [ ]";
  else if (e.kind === "file") line += e.value ? ` file=${q(e.value)}` : " (no file)";
  else if (e.kind !== "button" && e.kind !== "link" && e.kind !== "option") line += ` = ${q(e.value)}`;
  if (options && e.options) line += ` options: ${e.options.join(" | ")}${e.optionCount > e.options.length ? ` … (+${e.optionCount - e.options.length} more)` : ""}`;
  return line;
}

/** The page's layout: its URL and the same elements in the same order, labels and options. Values are left out. */
const layout = (o: Obs) => JSON.stringify([o.url, o.elements.map((e) => [e.id, e.kind, e.label, e.group, e.text, e.options, e.optionCount, e.inDialog])]);
const state = (e: El) => JSON.stringify([e.value, e.checked, e.required, e.disabled, e.invalid, e.hidden]);
export const DELTA_MARK = " — same page and elements as the STEP ";

/**
 * After a turn that only filled fields, the page usually has the same layout and only new values. Sending
 * the whole snapshot again cost 3,500–4,000 uncached tokens a step; this sends the elements that changed
 * since the last full snapshot (which stays in the conversation, so DeepSeek serves it from its cache).
 * null when the layout changed or the changes are not much smaller than the page: send a full snapshot.
 */
export function formatDelta(base: Obs, cur: Obs, baseStep: number, step: number): string | null {
  if (layout(base) !== layout(cur)) return null;
  const changed = cur.elements.filter((e, i) => state(e) !== state(base.elements[i]));
  const lines = [`STEP ${step}${DELTA_MARK}${baseStep} snapshot above (ids unchanged). Elements that changed since then:`];
  for (const e of changed) lines.push(`  ${elLine(e, false)}${(e.kind === "radio" || e.kind === "checkbox") && e.group ? ` (group ${q(e.group)})` : ""}`);
  if (!changed.length) lines.push("  (none)");
  if (cur.errors.length) lines.push(`Errors/alerts on page now: ${cur.errors.map((x) => q(x)).join(" ; ")}`);
  else if (base.errors.length) lines.push("Errors/alerts on page now: none");
  if (cur.excerpt === base.excerpt) lines.push("Visible text: unchanged.");
  else lines.push("Visible text (start), now:", cur.excerpt.slice(0, 1800));
  const text = lines.join("\n");
  return text.length < formatObs(cur, step).length * 0.6 ? text : null;
}
