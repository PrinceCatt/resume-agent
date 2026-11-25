// Demo mode: rule-based stand-ins for the three model calls, so the whole flow (read job →
// tailor → fill → stop for your confirmation) can be tried without an API key. It only knows
// simple forms; the real agent is the DeepSeek one.
import type { JobJd } from "./jobs.ts";
import type { JobRow } from "./jobs.ts";
import type { Profile } from "./profile.ts";
import type { TailorOutput } from "./tailor.ts";
import type { ToolCall } from "./llm.ts";
import type { El, Obs } from "./observe.ts";

const TECH = [
  "Python", "Java", "C++", "C", "JavaScript", "TypeScript", "Go", "Rust", "SQL", "MySQL", "PostgreSQL", "Redis", "MongoDB",
  "Spring Boot", "Spring", "React", "Vue", "Node.js", "HTML", "CSS", "Docker", "Kubernetes", "AWS", "GCP", "Azure", "Linux",
  "Git", "Machine Learning", "Deep Learning", "PyTorch", "TensorFlow", "LLM", "NLP", "Data Structures", "Algorithms",
  "REST", "Microservices", "Embedded", "ARM", "ROS", "Testing", "CI/CD", "Kafka", "Spark", "Excel",
];

export function mockExtractJob(text: string, url: string, pageTitle: string): JobJd {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const title = (pageTitle.split(/[|\-–—]/)[0] || lines[0] || "").trim().slice(0, 100);
  let company = "";
  try {
    company = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
  } catch {
    /* pasted text without a URL */
  }
  const m = text.match(/(?:company|about)\s*[:：]\s*([^\n.。]{2,60})/i);
  if (m) company = m[1].trim();
  const lower = text.toLowerCase();
  const keywords = TECH.filter((k) => new RegExp(`(^|[^a-z])${k.toLowerCase().replace(/[+.]/g, "\\$&")}([^a-z]|$)`).test(lower));
  const req = lines.filter((l) => /^[-•*·]/.test(l)).map((l) => l.replace(/^[-•*·]\s*/, "")).slice(0, 8);
  return {
    title,
    company,
    location: /singapore/i.test(text) ? "Singapore" : "",
    summary: "（演示模式：没有调用模型，以下是按关键词粗略提取的结果）",
    requirements: req,
    niceToHave: [],
    keywords,
    language: /[一-鿿]{20,}/.test(text) ? "zh" : "en",
    closed: /no longer accepting|position (has been )?filled|job (is )?closed|已关闭|停止招聘/i.test(text),
    fit: null,
    facts: mockFacts(text),
  };
}

/** Demo-mode conditions: the obvious phrases only. */
function mockFacts(text: string): NonNullable<JobJd["facts"]> {
  const years = text.match(/(\d{1,2})\s*\+?\s*(?:years?|yrs)\b/i);
  const type = /\bintern(ship)?\b|实习/i.test(text) ? "internship" : /part[- ]time|兼职/i.test(text) ? "parttime" : /\bcontract\b/i.test(text) ? "contract" : /full[- ]time|全职/i.test(text) ? "fulltime" : "unknown";
  return {
    type,
    hours: "",
    months: Number(text.match(/(\d{1,2})[- ]months?\b/i)?.[1]) || null,
    start: "",
    minYears: years ? Number(years[1]) : /no (prior )?experience (is )?(required|needed)|fresh grad/i.test(text) ? 0 : null,
    degree: /\b(bachelor|degree)\b|本科/i.test(text) ? "bachelor" : /\bdiploma\b/i.test(text) ? "diploma" : "",
    student: "",
    workAuth: /singapore(an)? citizens? only|only singapore(an)? citizens?/i.test(text) ? "citizen" : /citizens? (and|or|\/) (pr|permanent residents?)/i.test(text) ? "citizen_pr" : "",
    salary: text.match(/S?\$\s?\d[\d,]*(\s*[-–]\s*S?\$?\s?\d[\d,]*)?/)?.[0] ?? "",
    materials: /cover(ing)? letter|求职信/i.test(text) ? ["cover_letter"] : [],
    coverLetterAsk: "",
    workplace: /\bremote\b/i.test(text) ? "remote" : /\bhybrid\b/i.test(text) ? "hybrid" : "",
  };
}

/** Demo-mode fit: the share of the posting's keywords that appear anywhere in the profile. */
export function mockFit(jd: JobJd, profile: Profile): NonNullable<JobJd["fit"]> {
  const text = [profile.summary, profile.extraFacts, ...profile.sections.flatMap((s) => s.entries.flatMap((e) => [e.title, e.subtitle, ...e.bullets.map((b) => b.text)])), ...profile.skills.flatMap((g) => g.items)]
    .join("\n")
    .toLowerCase();
  const has = jd.keywords.filter((k) => text.includes(k.toLowerCase()));
  const miss = jd.keywords.filter((k) => !has.includes(k));
  const score = jd.keywords.length ? Math.round(30 + (60 * has.length) / jd.keywords.length) : 50;
  return {
    score,
    verdict: "演示模式：只按关键词重合度粗估，没有真正理解岗位要求。",
    strengths: has.length ? [`资料里有：${has.slice(0, 6).join("、")}`] : [],
    gaps: miss.length ? [`资料里没找到：${miss.slice(0, 6).join("、")}`] : [],
  };
}

export function mockTailor(master: Profile, jd: JobJd): TailorOutput {
  const kw = jd.keywords.map((k) => k.toLowerCase());
  const rank = (s: string) => (kw.some((k) => s.toLowerCase().includes(k)) ? 0 : 1);
  return {
    summary: master.summary,
    sections: master.sections.map((s) => ({
      id: s.id,
      entries: s.entries.map((e) => ({
        id: e.id,
        bullets: [...e.bullets].sort((a, b) => rank(a.text) - rank(b.text)).map((b) => ({ src: b.id, text: b.text })),
      })),
    })),
    skills: master.skills.map((g) => ({ id: g.id, items: [...g.items].sort((a, b) => rank(a) - rank(b)) })),
    skillsPosition: master.skillsPosition,
    notes: ["演示模式：没有调用模型，只把和岗位关键词相关的要点、技能排到了前面，措辞没改。"],
    coverLetter: "",
  };
}

export type MockMemory = { answers: Map<string, string>; asked: Set<string>; done: Set<string>; submitRequested: number; n: number };
export function newMockMemory(): MockMemory {
  return { answers: new Map(), asked: new Set(), done: new Set(), submitRequested: 0, n: 0 };
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((w) => w.length > 1));
function overlap(a: string, b: string) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  return [...A].filter((w) => B.has(w)).length / Math.min(A.size, B.size);
}

function fromAnswers(label: string, profile: Profile, mem: MockMemory) {
  for (const [q, a] of mem.answers) if (a && overlap(label, q) >= 0.5) return a;
  let best = "";
  let score = 0;
  for (const qa of profile.answers) {
    const s = overlap(label, qa.q);
    if (qa.a.trim() && s > score) {
      score = s;
      best = qa.a.trim();
    }
  }
  return score >= 0.5 ? best : "";
}

function guess(label: string, profile: Profile, job: JobRow, mem: MockMemory): string {
  const b = profile.basics;
  const L = label.toLowerCase();
  const edu = profile.sections.find((s) => /education/i.test(s.heading))?.entries[0];
  if (/first name|given name|名字/.test(L)) return b.firstName;
  if (/last name|surname|family name|姓氏/.test(L)) return b.lastName;
  if (/full name|^name\b|your name|姓名/.test(L)) return b.name;
  if (/e-?mail|邮箱/.test(L)) return b.email;
  if (/country code|区号/.test(L)) return b.phoneCountryCode;
  if (/phone|mobile|电话|手机/.test(L)) return b.phone;
  if (/linkedin/.test(L)) return b.linkedin;
  if (/github/.test(L)) return b.github;
  if (/website|portfolio|个人网站/.test(L)) return b.website;
  if (/school|university|college|学校|院校/.test(L)) return edu?.title ?? "";
  if (/degree|学位|专业/.test(L)) return edu?.subtitle ?? "";
  if (/cover letter|求职信/.test(L)) return job.cover_letter ?? "";
  const fromBank = fromAnswers(label, profile, mem);
  if (fromBank) return fromBank;
  if (/city|location|所在地|居住地/.test(L)) return b.location;
  return "";
}

const DECLINE = /decline|prefer not|don.?t wish|not to (say|disclose)|不愿|不透露/i;
const EEO = /gender|race|ethnic|veteran|disabilit|性别|种族|民族/i;
const FINAL = /\bsubmit\b|send application|提交|投递|发送/i;
const NEXT = /\bnext\b|continue|review|下一步|继续/i;

export function mockDecide(obs: Obs, profile: Profile, job: JobRow, mem: MockMemory): ToolCall[] {
  const calls: ToolCall[] = [];
  const call = (name: string, args: object) => calls.push({ id: `mock_${++mem.n}`, type: "function", function: { name, arguments: JSON.stringify(args) } });

  if (/thank you for (applying|your application)|application (has been )?(received|submitted)|申请已提交|投递成功/i.test(obs.excerpt)) {
    call("finish", { outcome: "submitted", note: "页面显示已收到申请" });
    return calls;
  }
  const fields = obs.elements.filter((e) => !["button", "link", "option"].includes(e.kind) && !e.disabled);
  const buttons = obs.elements.filter((e) => (e.kind === "button" || e.kind === "link") && !e.disabled);
  if (!fields.some((e) => e.kind !== "checkbox")) {
    const apply = buttons.find((e) => /apply|申请/i.test(e.text));
    if (apply && !mem.done.has(apply.id)) {
      mem.done.add(apply.id);
      call("click", { id: apply.id });
    } else call("need_manual", { reason: "演示模式没找到申请表或申请按钮，请在浏览器里看一下" });
    return calls;
  }

  const file = fields.find((e) => e.kind === "file" && !e.value && /resume|cv|简历/i.test(`${e.label} ${e.group}`));
  if (file && !mem.done.has(file.id)) {
    mem.done.add(file.id);
    call("upload", { id: file.id, file: "resume" });
    return calls;
  }

  let missing: El | null = null;
  const radioGroups = new Map<string, El[]>();
  for (const e of fields) {
    if (e.kind === "radio") {
      radioGroups.set(e.group, [...(radioGroups.get(e.group) ?? []), e]);
      continue;
    }
    if (mem.done.has(e.id)) continue;
    if (e.kind === "file") continue;
    if (e.kind === "checkbox") {
      if (e.required && !e.checked && /agree|consent|acknowledge|confirm|privacy|同意|确认/i.test(`${e.label} ${e.group}`)) {
        mem.done.add(e.id);
        call("check", { id: e.id, checked: true });
      }
      continue;
    }
    if (e.value) continue;
    if (e.kind === "select" && e.options) {
      const want = EEO.test(e.label) ? e.options.find((o) => DECLINE.test(o)) ?? "" : /country|国家/i.test(e.label) ? "Singapore" : guess(e.label, profile, job, mem);
      if (want) {
        mem.done.add(e.id);
        call("select", { id: e.id, option: want });
      } else if (e.required) missing ??= e;
      continue;
    }
    const v = guess(e.label, profile, job, mem);
    if (v) {
      mem.done.add(e.id);
      call(e.kind === "combobox" ? "choose" : "fill", { id: e.id, ...(e.kind === "combobox" ? { text: v } : { value: v }) });
    } else if (e.required) missing ??= e;
  }
  for (const [group, radios] of radioGroups) {
    if (radios.some((r) => r.checked) || radios.some((r) => mem.done.has(r.id))) continue;
    const want = EEO.test(group) ? radios.find((r) => DECLINE.test(r.label))?.label ?? "" : fromAnswers(group, profile, mem);
    const pick = want ? radios.find((r) => r.label.toLowerCase().startsWith(want.toLowerCase().slice(0, 3))) ?? radios.find((r) => overlap(r.label, want) > 0) : null;
    if (pick) {
      mem.done.add(pick.id);
      call("check", { id: pick.id, checked: true });
    } else if (radios.some((r) => r.required)) missing ??= { ...radios[0], label: group };
  }
  if (calls.length) return calls;

  if (missing) {
    const key = missing.label || missing.id;
    if (!mem.asked.has(key)) {
      mem.asked.add(key);
      call("ask_user", { question: `「${missing.label}」这一项资料库里没有，该填什么？`, field_label: missing.label });
      return calls;
    }
    call("need_manual", { reason: `演示模式不会填「${missing.label}」，请在浏览器里填好后点继续` });
    mem.asked.delete(key);
    return calls;
  }

  const submit = buttons.find((e) => FINAL.test(e.text)) ?? buttons.find((e) => e.submitType && !NEXT.test(e.text));
  const next = buttons.find((e) => NEXT.test(e.text) && !mem.done.has(e.id));
  if (submit) {
    mem.submitRequested++;
    if (mem.submitRequested > 3) call("need_manual", { reason: "提交后页面没有出现确认信息，请在浏览器里看一下" });
    else call("request_submit", { id: submit.id, summary: "演示模式：已按资料库填写所有能识别的字段，请核对后确认。" });
  } else if (next) {
    mem.done.add(next.id);
    call("click", { id: next.id });
  } else call("need_manual", { reason: "演示模式没找到下一步或提交按钮" });
  return calls;
}

/** Demo-mode interview prep: template questions built from the posting's keywords and the profile's bullets. */
export function mockPrep(jd: JobJd, profile: Profile, lang: "en" | "zh") {
  const zh = lang === "zh";
  const bullets = profile.sections.flatMap((s) => s.entries.flatMap((e) => e.bullets.map((b) => ({ id: b.id, text: b.text, where: e.title || s.heading }))));
  const skills = profile.skills.flatMap((g) => g.items).join(" ").toLowerCase();
  const about = (k: string) => bullets.filter((b) => b.text.toLowerCase().includes(k.toLowerCase())).slice(0, 2);
  const have = jd.keywords.filter((k) => about(k).length || skills.includes(k.toLowerCase()));
  const miss = jd.keywords.filter((k) => !have.includes(k));
  const edu = profile.sections.find((s) => /educ|教育/i.test(s.heading))?.entries[0];
  const name = profile.basics.name || "I";
  // The pitch leads with work or a project, not a school bullet.
  const lead = bullets.find((b) => !profile.sections.some((s) => /educ|教育/i.test(s.heading) && s.entries.some((e) => (e.title || s.heading) === b.where))) ?? bullets[0];
  const sentence = (t: string) => (/[.!?。！？]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);
  const role = jd.title || (zh ? "这个岗位" : "this role");
  const questions = [
    {
      q: zh ? "先简单介绍一下你自己。" : "Tell me about yourself.",
      kind: "behavioral",
      why: "几乎每场面试的开场题，用下面的自我介绍回答。",
      points: [...(edu ? [{ text: `${edu.title}${edu.subtitle ? ` · ${edu.subtitle}` : ""}`, src: edu.id }] : []), ...bullets.slice(0, 2).map((b) => ({ text: `${b.where}: ${b.text}`, src: b.id }))],
    },
    {
      q: zh ? `为什么想加入${jd.company || "我们"}、做${role}？` : `Why do you want this ${role} role${jd.company ? ` at ${jd.company}` : ""}?`,
      kind: "role",
      why: "考察你对岗位和公司的了解、动机是否清楚。",
      points: [
        have.length
          ? { text: zh ? `把岗位要的 ${have.slice(0, 3).join("、")} 和你用过它们的经历对上` : `Connect the ${have.slice(0, 3).join(", ")} the role asks for with where you used them`, src: "tip" }
          : { text: zh ? "结合岗位描述讲你想学什么" : "Connect what the role offers with what you want to learn", src: "tip" },
      ],
    },
    ...have.slice(0, 5).map((k) => ({
      q: zh ? `讲一个你用 ${k} 做过的项目。` : `Walk me through something you built with ${k}.`,
      kind: "technical",
      why: `岗位关键词里有 ${k}，你的资料里也有，面试官大概率会深挖。`,
      points: about(k).length
        ? about(k).map((b) => ({ text: `${b.where}: ${b.text}`, src: b.id }))
        : [{ text: zh ? `技能栏里写了 ${k}：准备一个具体例子` : `${k} is in your skills list: prepare one concrete example`, src: "tip" }],
    })),
    ...miss.slice(0, 2).map((k) => ({
      q: zh ? `你对 ${k} 熟悉吗？` : `How familiar are you with ${k}?`,
      kind: "technical",
      why: `岗位要 ${k}，你的资料里没有。`,
      points: [{ text: zh ? `诚实说没用过 ${k}，讲你会怎么上手，以及相近的经验` : `Say honestly you have not used ${k}; explain how you would pick it up and what is closest in your experience`, src: "tip" }],
    })),
  ];
  return {
    pitch: zh
      ? `我是${name}${edu ? `，${edu.title}${edu.subtitle ? edu.subtitle : ""}` : ""}。${lead ? `我做过${lead.where}：${lead.text}。` : ""}${have.length ? ` 这和${role}需要的 ${have.slice(0, 3).join("、")} 很对口。` : ""}`
      : `I'm ${name}${edu ? `, ${edu.subtitle ? `${edu.subtitle} at ` : ""}${edu.title}` : ""}.${lead ? ` At ${lead.where}, I ${sentence(lead.text.replace(/^[A-Z]/, (c) => c.toLowerCase()))}` : ""}${have.length ? ` That is why ${role} fits me: it asks for ${have.slice(0, 3).join(", ")}, which I have used.` : ""}`,
    questions,
    toAsk: zh
      ? ["这个岗位前三个月最重要的事情是什么？", "团队现在的技术栈和开发流程是怎样的？", "你们怎么评价一个实习生 / 新人做得好？"]
      : ["What would success look like in the first three months?", "What does the team's stack and development process look like?", "How do you give feedback to interns or new joiners?"],
    gaps: miss.length ? [{ gap: `资料里没有：${miss.slice(0, 4).join("、")}`, how: "不要硬说会；讲相近经验和学习计划。" }] : [],
    _demo: "演示模式：按模板生成，不是模型写的",
  };
}

/** Demo-mode email drafts. */
export function mockDraft(kind: "followup" | "thanks", jd: JobJd, profile: Profile, lang: "en" | "zh", extra: string) {
  const name = profile.basics.name || "";
  const role = jd.title || (lang === "zh" ? "该岗位" : "the position");
  if (lang === "zh") {
    return kind === "followup"
      ? { subject: `关于${role}的申请进度`, body: `您好，\n\n我前段时间申请了贵司的${role}，想冒昧问一下目前的进度。我对这个岗位依然很感兴趣，期待有机会进一步沟通。\n\n谢谢！\n${name}` }
      : { subject: `感谢面试机会 —— ${role}`, body: `您好，\n\n谢谢您今天抽时间和我聊${role}。${extra ? `关于${extra}的讨论让我对团队有了更多了解。` : ""}我对这个机会很期待，如有需要补充的材料请随时告诉我。\n\n祝好，\n${name}` };
  }
  return kind === "followup"
    ? { subject: `Following up on my application: ${role}`, body: `Dear Hiring Team,\n\nI applied for the ${role} position${jd.company ? ` at ${jd.company}` : ""} a while ago and wanted to ask whether there is any update on my application. I remain very interested in the role and would welcome the chance to discuss it.\n\nThank you for your time.\n\nBest regards,\n${name}` }
    : { subject: `Thank you: ${role} interview`, body: `Dear Hiring Team,\n\nThank you for taking the time to speak with me about the ${role} position.${extra ? ` I especially enjoyed our discussion about ${extra}.` : ""} The conversation made me even more excited about the role, and I would be glad to provide anything else you need.\n\nBest regards,\n${name}` };
}
