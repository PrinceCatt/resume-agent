// The two promises this app makes: it never clicks a final submit on its own, and a tailored
// resume contains nothing that isn't in the master profile. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Keep the real data/ folder out of it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "resume-agent-test-"));
const { isFinalSubmit } = await import("./agent.ts");
const { assemble } = await import("./tailor.ts");
const { normalizeProfile } = await import("./profile.ts");
type El = import("./observe.ts").El;

const button = (text: string, extra: Partial<El> = {}): El => ({
  id: "f0_1",
  kind: "button",
  label: "",
  group: "",
  value: "",
  checked: null,
  required: false,
  disabled: false,
  invalid: false,
  hidden: false,
  options: null,
  optionCount: 0,
  text,
  href: "",
  submitType: false,
  inForm: true,
  inDialog: false,
  ...extra,
});

test("final-submit guard", () => {
  assert.equal(isFinalSubmit(button("Submit Application"), 0), true);
  assert.equal(isFinalSubmit(button("Submit"), 5), true);
  assert.equal(isFinalSubmit(button("Send application"), 3), true);
  assert.equal(isFinalSubmit(button("立即沟通"), 0), true);
  assert.equal(isFinalSubmit(button("提交申请"), 0), true);
  // Starting an application is fine; "Apply" once fields are filled is not.
  assert.equal(isFinalSubmit(button("Apply for this job"), 0), false);
  assert.equal(isFinalSubmit(button("Easy Apply"), 0), false);
  assert.equal(isFinalSubmit(button("Apply"), 4), true);
  // Step buttons in multi-page forms pass, even as type=submit.
  assert.equal(isFinalSubmit(button("Next", { submitType: true }), 4), false);
  assert.equal(isFinalSubmit(button("Review your application", { submitType: true }), 4), false);
  assert.equal(isFinalSubmit(button("Continue"), 4), false);
  // An unnamed form submit after filling counts as final.
  assert.equal(isFinalSubmit(button("Done", { submitType: true }), 4), true);
});

const master = normalizeProfile({
  basics: { name: "Test Person" },
  sections: [
    {
      id: "sec_edu",
      heading: "Education",
      entries: [
        {
          id: "e_edu",
          title: "Example University",
          dates: "2023 - 2027",
          bullets: [{ id: "b_gpa", text: "GPA 3.8" }],
        },
      ],
    },
    {
      id: "sec_exp",
      heading: "Experience",
      entries: [
        {
          id: "e_orb",
          title: "Course Project",
          dates: "2024",
          bullets: [
            {
              id: "b1",
              text: "Built a full-stack blog website with Spring Boot and Vue",
            },
            { id: "b2", text: "Deployed on an Ubuntu server with Nginx" },
          ],
        },
      ],
    },
  ],
  skills: [{ id: "sk", label: "Programming", items: ["Java", "Python"] }],
  extraFacts: "Interned at Example Labs as a backend intern from May 2026 to Nov 2026.\nWrote data pipelines in Python processing 2 million records.",
});
const jd = {
  title: "Backend Intern",
  company: "Acme",
  location: "",
  summary: "",
  requirements: [],
  niceToHave: [],
  keywords: ["Kubernetes", "Java"],
  language: "en" as const,
  closed: false,
  fit: null,
  facts: null,
};

test("tailoring keeps only traceable content", () => {
  const out = assemble(
    master,
    {
      sections: [
        {
          id: "sec_exp",
          entries: [
            {
              id: "e_orb",
              bullets: [
                {
                  src: "b1",
                  text: "Built a full-stack web app with Spring Boot, serving 10,000 users",
                }, // invented number
                {
                  src: "b2",
                  text: "Deployed and operated the service on Ubuntu behind Nginx",
                }, // fine rewrite
                { src: "made_up", text: "Led a team of 8 engineers" }, // no source
              ],
            },
          ],
        },
        {
          id: "new",
          heading: "Work Experience",
          entries: [
            {
              id: "new",
              title: "Example Labs",
              subtitle: "Backend Intern",
              dates: "May 2026 - Nov 2026",
              bullets: [
                {
                  src: "fact",
                  fact: "Wrote data pipelines in Python processing 2 million records.",
                  text: "Built Python data pipelines processing 2 million records",
                },
              ],
            },
          ],
        },
      ],
      skills: [{ id: "sk", items: ["Java", "Kubernetes", "Python"] }],
    },
    jd,
  );
  const exp = out.doc.sections.find((s) => s.id === "sec_exp")!;
  const texts = exp.entries[0].bullets.map((b) => b.text);
  assert.ok(texts.includes("Built a full-stack blog website with Spring Boot and Vue"), "invented number reverted to the original");
  assert.ok(texts.includes("Deployed and operated the service on Ubuntu behind Nginx"));
  assert.ok(!texts.some((t) => t.includes("team of 8")), "unsourced bullet dropped");
  assert.deepEqual(out.doc.skills[0].items, ["Java", "Python"], "skill not in profile dropped");
  assert.ok(out.doc.sections[0].heading === "Education", "education put back first");
  const work = out.doc.sections.find((s) => s.heading === "Work Experience")!;
  assert.equal(work.entries[0].bullets[0].text, "Built Python data pipelines processing 2 million records");
  assert.ok(
    out.warnings.some((w) => w.includes("10")),
    "number warning",
  );
  assert.ok(
    out.warnings.some((w) => w.includes("Kubernetes")),
    "skill warning",
  );
  assert.ok(
    out.warnings.some((w) => w.includes("Example Labs")),
    "new entry flagged for review",
  );
});

test("the same posting pasted twice is added once", async () => {
  const { normalizeUrl, addJobs, bgQueue } = await import("./jobs.ts");
  // Keep the background reader from trying to open these pages.
  bgQueue.push = () => {};
  assert.equal(normalizeUrl("https://www.linkedin.com/jobs/view/123/?trackingId=abc&refId=x"), normalizeUrl("linkedin.com/jobs/view/123"));
  assert.equal(normalizeUrl("https://jobs.lever.co/acme/42?lever-source=LinkedIn#apply"), normalizeUrl("https://jobs.lever.co/acme/42/"));
  assert.notEqual(normalizeUrl("https://example.com/jobs?id=1"), normalizeUrl("https://example.com/jobs?id=2"));
  const first = addJobs({
    urls: ["https://jobs.lever.co/acme/42", "https://jobs.lever.co/acme/42/?utm_source=x"],
    autoApply: false,
  });
  assert.equal(first.ids.length, 1);
  assert.equal(first.duplicates.length, 1);
  const again = addJobs({
    urls: ["jobs.lever.co/acme/42#top", "https://jobs.lever.co/acme/43"],
    autoApply: false,
  });
  assert.equal(again.ids.length, 1);
  assert.deepEqual(
    again.duplicates.map((d) => d.id),
    first.ids,
  );
});

test("marking a job applied starts its follow-up record once", async () => {
  const { addJobs, getJob, setJob, bgQueue } = await import("./jobs.ts");
  bgQueue.push = () => {};
  const [id] = addJobs({
    urls: ["https://example.com/careers/9"],
    autoApply: false,
  }).ids;
  setJob(id, { stage: "applied" });
  const a = getJob(id)!;
  assert.equal(a.progress, "applied");
  assert.ok(a.applied_at);
  setJob(id, { progress: "interview" });
  setJob(id, { stage: "applied" });
  const b = getJob(id)!;
  assert.equal(b.progress, "interview", "applying again does not reset progress");
  assert.equal(b.applied_at, a.applied_at, "first applied date is kept");
});

test("an interview on the calendar moves progress forward, and stats count how far each job got", async () => {
  const { addJobs, getJob, setJob, bgQueue, progressLog } = await import("./jobs.ts");
  const { addEvent, getEvent, icsFor } = await import("./schedule.ts");
  const { stats } = await import("./stats.ts");
  bgQueue.push = () => {};
  const [a, b] = addJobs({
    urls: ["https://boards.greenhouse.io/acme/jobs/1", "https://boards.greenhouse.io/acme/jobs/2"],
    autoApply: false,
  }).ids;
  setJob(a, { stage: "applied" });
  setJob(b, { stage: "applied" });
  const ev = addEvent(a, {
    kind: "interview",
    at: "2030-01-02T06:00:00.000Z",
    note: "https://meet.example.com/abc",
  });
  assert.equal(getJob(a)!.progress, "interview");
  addEvent(a, { kind: "test", at: "2030-01-03T06:00:00Z" });
  assert.equal(getJob(a)!.progress, "interview", "a test after the interview does not move it back");
  setJob(a, { progress: "rejected" });
  assert.deepEqual(
    progressLog(a).map((l) => l.progress),
    ["applied", "interview", "rejected"],
  );

  const gh = stats().bySite.find((s) => s.label === "Greenhouse")!;
  assert.deepEqual([gh.applied, gh.replied, gh.positive], [2, 1, 1], "a rejection after an interview still counts as having got that far");

  const ics = icsFor(getEvent(ev)!);
  assert.ok(ics.includes("DTSTART:20300102T060000Z"));
  assert.ok(ics.includes("TRIGGER:-PT1H"));
  assert.ok(
    ics.split("\r\n").every((l) => Buffer.byteLength(l, "utf8") <= 75),
    "long lines are folded",
  );
});

test("marking a job straight as a test round still starts its history with applied", async () => {
  const { addJobs, setJob, bgQueue, progressLog } = await import("./jobs.ts");
  const { sqlNow } = await import("./db.ts");
  bgQueue.push = () => {};
  const [id] = addJobs({
    urls: ["https://example.com/careers/77"],
    autoApply: false,
  }).ids;
  // What PATCH /api/jobs/:id { progress: "screening" } does for a job you applied to by hand.
  setJob(id, {
    progress: "screening",
    progress_at: sqlNow(),
    stage: "applied",
  });
  assert.deepEqual(
    progressLog(id).map((l) => l.progress),
    ["applied", "screening"],
  );
});

test("questions the agent asked show up until they are answered in the profile", async () => {
  const { addJobs, bgQueue } = await import("./jobs.ts");
  const { run } = await import("./db.ts");
  const { similarity } = await import("./agent.ts");
  const { askedQuestions } = await import("./stats.ts");
  bgQueue.push = () => {};
  const [jobId] = addJobs({
    urls: ["https://example.com/careers/88"],
    autoApply: false,
  }).ids;
  const { id: runId } = run("INSERT INTO runs (job_id, status) VALUES (?, 'finished')", jobId);
  run("INSERT INTO run_steps (run_id, kind, text) VALUES (?, 'ask', ?)", runId, "问你：What is your notice period?");
  run("INSERT INTO run_steps (run_id, kind, text) VALUES (?, 'note', ?)", runId, "你的回答：Immediately（已记入资料库）");
  run("INSERT INTO run_steps (run_id, kind, text) VALUES (?, 'ask', ?)", runId, "问你：Do you have a driving licence?");
  const open = askedQuestions(similarity, [{ q: "What is your notice period?", a: "" }]);
  assert.deepEqual(
    open.map((a) => `${a.q} = ${a.a}`).sort(),
    ["Do you have a driving licence? = ", "What is your notice period? = Immediately"],
    "an empty saved answer still counts as open",
  );
  const left = askedQuestions(similarity, [{ q: "What is your notice period?", a: "Immediately" }]);
  assert.deepEqual(
    left.map((a) => a.q),
    ["Do you have a driving licence?"],
    "an answered question drops off",
  );
});

test("tools the profile never mentions are caught, short acronyms only in capitals", async () => {
  const { profileText, unsupportedTerms } = await import("./terms.ts");
  const p = profileText(master);
  assert.deepEqual(unsupportedTerms("Built ROS nodes in Java and wrote JUnit tests", p), ["ROS", "JUnit"]);
  assert.deepEqual(unsupportedTerms("Used JavaScript on a robotic arm", p), ["JavaScript"], "Java is not found inside JavaScript, and an arm is not ARM");
  assert.deepEqual(
    unsupportedTerms("熟悉 Spring Boot 和 Nginx，有 Kubernetes 经验", p, ["Kubernetes"]),
    ["Kubernetes"],
    "works inside Chinese text, and posting keywords count",
  );
});

test("interview talking points must name a profile line that backs them", async () => {
  const { checkPoint } = await import("./prep.ts");
  const kind = (raw: unknown) => checkPoint(raw, master, jd).kind;
  assert.equal(kind({ text: "Built a blog with Spring Boot and Vue", src: "b1" }), "fact");
  assert.equal(checkPoint({ text: "Built a blog", src: "[b1]" }, master, jd).from, "Course Project");
  assert.equal(
    kind({
      text: "Processed 2 million records in Python",
      src: "fact",
      fact: "Wrote data pipelines in Python processing 2 million records.",
    }),
    "fact",
  );
  assert.equal(
    kind({
      text: "Interned at Example Labs",
      src: "fact",
      fact: "Interned at Google.",
    }),
    "unsure",
    "a quoted fact that is not in EXTRA FACTS",
  );
  assert.equal(kind({ text: "Explain how you would design the API", src: "tip" }), "tip");
  assert.equal(kind({ text: "Used Kubernetes to deploy the blog", src: "tip" }), "unsure", "a claim labelled as a tip");
  assert.equal(kind({ text: "Deployed the blog on Kubernetes", src: "b2" }), "unsure", "a real source, but a tool the profile lacks");
  assert.equal(kind({ text: "Served 5000 users", src: "b1" }), "unsure", "a number the profile lacks");
  assert.equal(kind({ text: "Led a team of four", src: "b9" }), "unsure", "an id that does not exist");
  assert.equal(kind("Built a blog"), "unsure", "an old plain-string point");
});

test("a fit strength crediting a missing tool is marked", async () => {
  const { checkFit } = await import("./jobs.ts");
  const { profileText } = await import("./terms.ts");
  const fit = checkFit(
    {
      score: 88,
      verdict: "",
      strengths: ["有 ROS 机器人项目经验", "熟悉 Java"],
      gaps: [],
    },
    profileText(master),
    jd.keywords,
  );
  assert.deepEqual(fit.unsupported, ["ROS"]);
  assert.equal(fit.strengths[0], "有 ROS 机器人项目经验（资料库里没找到：ROS）");
  assert.equal(fit.strengths[1], "熟悉 Java");
});

test("a tool counts when the profile writes it another way or with a version", async () => {
  const { unsupportedTerms } = await import("./terms.ts");
  const p = "Skills: Robot Operating System (familiar), Vue3, HTML5, k8s basics";
  assert.deepEqual(unsupportedTerms("Built ROS nodes with a Vue front end on Kubernetes", p), []);
  assert.deepEqual(unsupportedTerms("Wrote Golang services", "Let's go"), ["Golang"], "a two-letter alias only counts in its own case");
});

test("prep flags are worked out when read, so adding the fact to the profile clears them", async () => {
  const { prepView } = await import("./prep.ts");
  const saved = {
    pitch: "I build ROS robots.",
    questions: [
      {
        q: "Q",
        kind: "technical",
        why: "",
        points: [{ text: "Wrote ROS nodes for the robot", src: "b1" }],
      },
    ],
    toAsk: [],
    gaps: [],
    generatedAt: "",
  };
  const before = prepView(saved, master, jd)!;
  assert.equal(before.questions[0].points[0].kind, "unsure");
  assert.deepEqual(before.pitchWarnings, ["提到了 ROS，资料库里没有"]);
  const withRos = normalizeProfile({
    ...master,
    skills: [...master.skills, { id: "sk2", label: "Robotics", items: ["Robot Operating System"] }],
  });
  const after = prepView(saved, withRos, jd)!;
  assert.equal(after.questions[0].points[0].kind, "fact");
  assert.deepEqual(after.pitchWarnings, []);
});

test("job sites are recognised by their links, and bot-check screens are told apart from pages", async () => {
  const { siteFor, isCheckPage } = await import("./sites.ts");
  assert.equal(siteFor("https://sg.linkedin.com/jobs/view/software-engineer-intern-at-acme-4475507408")?.key, "linkedin");
  assert.equal(siteFor("https://www.linkedin.com/jobs/view/4475507408/")?.key, "linkedin");
  assert.equal(siteFor("https://sg.jobstreet.com/job/81234567")?.key, "jobstreet");
  assert.equal(siteFor("https://www.glassdoor.sg/job-listing/software-engineer-intern-acme-JV_KO0,24.htm")?.key, "glassdoor");
  assert.equal(siteFor("https://smartapply.indeed.com/beta/indeedapply/form/contact-info")?.key, "indeed");
  assert.equal(siteFor("https://www.mycareersfuture.gov.sg/job/information-technology/intern-d5cfb9f5586c337bc00c90c5def60d9e")?.key, "mcf");
  assert.equal(siteFor("https://acme.wd3.myworkdayjobs.com/en-US/careers/job/Singapore/Intern_R123")?.key, "workday");
  assert.equal(siteFor("http://127.0.0.1:8791/fixtures/site-indeed-apply.html")?.key, "indeed", "local mock pages stand in for a site");
  assert.equal(siteFor("https://boards.greenhouse.io/acme/jobs/1"), null);
  assert.equal(siteFor("https://notlinkedin.com/jobs/1"), null);
  assert.equal(siteFor("https://sg.jobstreet.com/job/1")?.visibleOnly, true);
  assert.equal(isCheckPage("Just a moment...", "Checking if the site connection is secure"), true);
  assert.equal(isCheckPage("Blocked - Indeed.com", ""), true);
  assert.equal(isCheckPage("Software Engineer Intern - Acme", "Verify you are human by completing the action below."), true);
  assert.equal(isCheckPage("Software Engineer Intern - Acme", "We are looking for a security engineer who can wait a moment."), false);
});

test("controls inside an open dialog are listed first and marked", async () => {
  const { formatObs } = await import("./observe.ts");
  const text = formatObs(
    {
      url: "https://www.linkedin.com/jobs/view/1",
      title: "Job",
      errors: [],
      excerpt: "",
      elements: [
        { ...button("Next"), id: "f0_9", inDialog: true },
        { ...button("Save job 1"), id: "f0_1" },
      ],
    },
    3,
  );
  const lines = text.split("\n");
  const at = (s: string) => lines.findIndex((l) => l.includes(s));
  assert.ok(at("inside the dialog") < at('"Next"') && at('"Next"') < at("behind the dialog") && at("behind the dialog") < at('"Save job 1"'));
});

test("the API key and the browser extension token stay on the server", async () => {
  const { saveSettings, publicSettings, getSettings } = await import("./settings.ts");
  saveSettings({
    apiKey: "sk-test-1234567890",
    extensionToken: "ext-token-abcdef",
  });
  assert.equal(getSettings().extensionToken, "ext-token-abcdef");
  const pub = publicSettings() as Record<string, unknown>;
  const text = JSON.stringify(pub);
  assert.ok(!("apiKey" in pub) && !("extensionToken" in pub));
  assert.ok(!text.includes("ext-token-abcdef") && !text.includes("sk-test-1234567890"));
  assert.equal(pub.hasExtensionToken, true);
  saveSettings({ apiKey: "", extensionToken: "" });
  assert.equal((publicSettings() as Record<string, unknown>).hasExtensionToken, false);
});

test("what the candidate is looking for reaches the fit check, empty answers left out", async () => {
  const { searchPrefs } = await import("./jobs.ts");
  const p = normalizeProfile({
    sections: [],
    answers: [
      {
        id: "qa_jobtype",
        q: "What type of role are you looking for?",
        a: "Full-time entry-level roles",
      },
      { id: "qa_grad", q: "Graduation date", a: "May 2027" },
      { id: "qa_dur", q: "Internship duration you are available for", a: "" },
      { id: "qa_gender", q: "Gender", a: "Decline" },
    ],
  });
  const text = searchPrefs(p);
  assert.match(text, /^WHAT THE CANDIDATE IS LOOKING FOR/);
  assert.match(text, /Full-time entry-level roles/);
  assert.match(text, /May 2027/);
  assert.ok(!/duration/i.test(text) && !/Gender/.test(text));
  assert.equal(searchPrefs(normalizeProfile({ sections: [], answers: [] })), "");
});

// Shaped like LinkedIn's public search fragment (jobs-guest/…/seeMoreJobPostings), trimmed.
const LI_CARDS = `
<li>
  <div class="base-card relative w-full base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:4481637634">
    <a class="base-card__full-link absolute top-0 right-0 bottom-0 left-0 p-0 z-[2]" href="https://sg.linkedin.com/jobs/view/graduate-software-engineer-at-hcltech-4481637634?position=1&amp;pageNum=0&amp;refId=abc&amp;trackingId=xyz" data-tracking-control-name="public_jobs_jserp-result_search-card">
      <span class="sr-only">Graduate Software Engineer</span>
    </a>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title">
        Graduate Software Engineer
      </h3>
      <h4 class="base-search-card__subtitle">
        <a class="hidden-nested-link" href="https://sg.linkedin.com/company/hcltech">HCLTech</a>
      </h4>
      <div class="base-search-card__metadata">
        <span class="job-search-card__location">Singapore, Singapore</span>
        <span class="job-search-card__salary-info">S$4,000 - S$5,000</span>
        <time class="job-search-card__listdate" datetime="2026-11-10">3 days ago</time>
      </div>
    </div>
  </div>
</li>
<li>
  <div class="base-card base-search-card job-search-card">
    <a class="base-card__full-link" href="https://sg.linkedin.com/jobs/view/backend-engineer-at-r&amp;d-labs-4400000001?position=2">
      <span class="sr-only">Backend Engineer</span>
    </a>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title">Backend Engineer (Java &amp; Go)</h3>
      <h4 class="base-search-card__subtitle"><a href="#">R&amp;D Labs Pte. Ltd.</a></h4>
      <div class="base-search-card__metadata">
        <span class="job-search-card__location">Central Region, Singapore</span>
        <time class="job-search-card__listdate--new" datetime="2026-11-12">1 day ago</time>
      </div>
    </div>
  </div>
</li>`;

test("job search: LinkedIn cards are read, links lose their tracking", async () => {
  const { parseLinkedInCards } = await import("./discover.ts");
  const cards = parseLinkedInCards(LI_CARDS);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], {
    source: "linkedin",
    title: "Graduate Software Engineer",
    company: "HCLTech",
    location: "Singapore, Singapore",
    posted: "2026-11-10",
    url: "https://sg.linkedin.com/jobs/view/graduate-software-engineer-at-hcltech-4481637634",
    salary: "S$4,000 - S$5,000",
  });
  assert.equal(cards[1].title, "Backend Engineer (Java & Go)");
  assert.equal(cards[1].company, "R&D Labs Pte. Ltd.");
  assert.equal(cards[1].salary, "");
  assert.equal(parseLinkedInCards("<html><body>No matching jobs found.</body></html>").length, 0);
});

test("job search: MyCareersFuture results name the real employer and hide hidden pay", async () => {
  const { mapMcf } = await import("./discover.ts");
  const out = mapMcf([
    {
      title: " Software Engineer ",
      postedCompany: { name: "TALENT AGENCY PTE. LTD." },
      hiringCompany: { name: "ACME ROBOTICS PTE. LTD." },
      metadata: {
        jobDetailsUrl: "https://www.mycareersfuture.gov.sg/job/information-technology/software-engineer-acme-0123456789abcdef0123456789abcdef",
        newPostingDate: "2026-11-11",
        isPostedOnBehalf: true,
        isHideSalary: false,
      },
      salary: { minimum: 4000, maximum: 5500, type: { salaryType: "Monthly" } },
      address: { districts: [{ location: "Central" }] },
    },
    {
      title: "Backend Developer",
      postedCompany: { name: "BETA PTE. LTD." },
      metadata: {
        jobDetailsUrl: "https://www.mycareersfuture.gov.sg/job/it/backend-beta-fedcba9876543210fedcba9876543210",
        newPostingDate: "2026-11-09",
        isHideSalary: true,
      },
      salary: { minimum: 3000, maximum: 4000 },
    },
    { title: "No link", metadata: {} },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, "Software Engineer");
  assert.equal(out[0].company, "ACME ROBOTICS PTE. LTD.");
  assert.equal(out[0].salary, "S$4000–5500/月");
  assert.equal(out[0].location, "Central");
  assert.equal(out[1].company, "BETA PTE. LTD.");
  assert.equal(out[1].salary, "");
});

test("job search: one posting is listed once, and postings already in the list are marked", async () => {
  const { mergeFound, jobKey } = await import("./discover.ts");
  assert.equal(jobKey("https://sg.linkedin.com/jobs/view/graduate-software-engineer-at-hcltech-4481637634?refId=1"), "linkedin:4481637634");
  assert.equal(jobKey("https://www.linkedin.com/jobs/view/4481637634/"), "linkedin:4481637634");
  const base = { location: "Singapore", salary: "" };
  const fromLinkedIn = [
    {
      ...base,
      source: "linkedin" as const,
      title: "Graduate Software Engineer",
      company: "HCLTech",
      posted: "2026-11-10",
      url: "https://sg.linkedin.com/jobs/view/graduate-software-engineer-at-hcltech-4481637634",
    },
    {
      ...base,
      source: "linkedin" as const,
      title: "Backend Engineer",
      company: "R&D Labs Pte. Ltd.",
      posted: "2026-11-12",
      url: "https://sg.linkedin.com/jobs/view/backend-engineer-at-r-d-labs-4400000001",
    },
  ];
  const secondQuery = [
    {
      ...fromLinkedIn[0],
      url: "https://www.linkedin.com/jobs/view/4481637634/",
    },
  ];
  const fromMcf = [
    {
      ...base,
      source: "mcf" as const,
      title: "Backend Engineer",
      company: "R&D LABS PTE LTD",
      posted: "2026-11-11",
      url: "https://www.mycareersfuture.gov.sg/job/it/backend-engineer-rd-0123456789abcdef0123456789abcdef",
    },
    {
      ...base,
      source: "mcf" as const,
      title: "Software Engineer",
      company: "Acme",
      posted: "",
      url: "https://www.mycareersfuture.gov.sg/job/it/software-engineer-acme-fedcba9876543210fedcba9876543210",
    },
  ];
  const known = new Map([[jobKey("https://sg.linkedin.com/jobs/view/graduate-software-engineer-at-hcltech-4481637634"), 20]]);
  const out = mergeFound([fromLinkedIn, secondQuery, fromMcf], known);
  assert.deepEqual(
    out.map((f) => [f.title, f.source, f.existingId]),
    [
      ["Backend Engineer", "linkedin", null],
      ["Graduate Software Engineer", "linkedin", 20],
      ["Software Engineer", "mcf", null],
    ],
  );
});

test("job search: senior titles are recognised, entry-level ones are not", async () => {
  const { seniorTitle } = await import("./discover.ts");
  for (const t of ["Senior Java Software Engineer", "Sr. Backend Engineer", "Lead Java Developer", "Staff Software Engineer, GenAI", "Engineering Manager", "Backend Engineer (5+ years)", "Head of Platform"])
    assert.ok(seniorTitle(t), t);
  for (const t of ["Junior Fullstack Software Engineer", "Graduate Software Engineer", "Software Engineer, Singpass", "Backend Developer", "Leading-edge AI Engineer Intern"])
    assert.ok(!seniorTitle(t), t);
});

test("job search: MyCareersFuture titles must carry a word of the query", async () => {
  const { relevantTitle } = await import("./discover.ts");
  assert.ok(relevantTitle("Java Developer", "software developer"));
  assert.ok(relevantTitle("Software Engineering Intern", "software engineer intern"));
  assert.ok(relevantTitle("Engineer, Firmware Development (SSD)", "embedded software engineer"));
  assert.ok(!relevantTitle("Business Development Associate", "software developer"));
  assert.ok(!relevantTitle("(FULL / PART TIME) Business Development Assistant", "part time developer"));
  assert.ok(!relevantTitle("#FreshGrads 🎓 This one's for you!", "graduate software engineer"));
});

test("a MyCareersFuture posting is read from its API record, closed ones say so", async () => {
  const { mcfJobText } = await import("./discover.ts");
  const got = mcfJobText({
    title: "Software Engineer",
    description: "<p><strong>JOB DESCRIPTION</strong></p><ul><li>Embedded system development</li><li>C/C++ &amp; Linux</li></ul>",
    postedCompany: { name: "AGENCY PTE. LTD." },
    hiringCompany: { name: "REALTEK SINGAPORE PRIVATE LIMITED" },
    metadata: { isPostedOnBehalf: true, isHideSalary: false },
    employmentTypes: [{ employmentType: "Full Time" }],
    positionLevels: [{ position: "Fresh/entry level" }],
    minimumYearsExperience: 0,
    salary: { minimum: 4500, maximum: 7500, type: { salaryType: "Monthly" } },
    skills: [{ skill: "Linux" }, { skill: "Firmware" }],
    status: { jobStatus: "Closed" },
  });
  assert.equal(got.title, "Software Engineer | REALTEK SINGAPORE PRIVATE LIMITED");
  assert.match(got.text, /Status: Closed/);
  assert.match(got.text, /Position level: Fresh\/entry level/);
  assert.match(got.text, /Minimum years of experience: 0/);
  assert.match(got.text, /• Embedded system development\n• C\/C\+\+ & Linux/);
  assert.match(got.text, /Skills: Linux, Firmware/);
  assert.ok(!/<[a-z]/.test(got.text));
});

test("posting conditions: only known values are kept, nothing is made up", async () => {
  const { normalizeFacts, asksCoverLetter } = await import("./jobs.ts");
  const f = normalizeFacts({
    type: "internship",
    hours: "part",
    months: "6",
    minYears: 99,
    degree: "bachelor",
    student: "maybe",
    workAuth: "citizen_pr",
    salary: "S$1,200 / month",
    materials: ["cover_letter", "cover_letter", "selfie", "transcript"],
    coverLetterAsk: "Why you want to join",
    workplace: "hybrid",
  })!;
  assert.equal(f.type, "internship");
  assert.equal(f.months, 6);
  assert.equal(f.minYears, null, "an impossible number is dropped, not clamped");
  assert.equal(f.student, "", "an unknown value becomes empty");
  assert.deepEqual(f.materials, ["cover_letter", "transcript"]);
  assert.equal(normalizeFacts(undefined), null, "no conditions from the model: none recorded");
  assert.equal(normalizeFacts({})?.type, "unknown");
  assert.deepEqual(normalizeFacts({ materials: "cover_letter" })?.materials, []);
  assert.equal(asksCoverLetter({ ...jd, facts: f }), true);
  assert.equal(asksCoverLetter({ ...jd, facts: { ...f, materials: [] } }), false);
  assert.equal(asksCoverLetter(null), false);
});

test("cover letters: written when the settings say always or the posting asks; invented numbers flagged", async () => {
  const { wantsCoverLetter, coverLetterWarnings } = await import("./tailor.ts");
  const { normalizeFacts } = await import("./jobs.ts");
  const asks = { ...jd, facts: normalizeFacts({ materials: ["cover_letter"] }) };
  assert.equal(wantsCoverLetter(false, jd), false);
  assert.equal(wantsCoverLetter(true, jd), true);
  assert.equal(wantsCoverLetter(false, asks), true);
  assert.deepEqual(coverLetterWarnings(master, "My pipelines processed 2 million records.", jd), []);
  assert.equal(coverLetterWarnings(master, "I led a team of 12 engineers.", jd).length, 1);
});

test("requirement filters and counts over the job list", async () => {
  const { passes, reqStats, readFilter, NO_FILTER, factChips } = await import("../src/reqs.ts");
  const { normalizeFacts } = await import("./jobs.ts");
  const job = (id: number, facts: unknown, keywords: string[], kwHave: string[] = [], extra: object = {}) =>
    ({ id, jd: { ...jd, keywords, facts: facts === null ? null : normalizeFacts(facts), ...extra }, kwHave }) as never;
  const ft = job(1, { type: "fulltime", minYears: 0, materials: ["cover_letter"] }, ["Java", "React"], ["Java"]);
  const senior = job(2, { type: "fulltime", minYears: 3, workAuth: "citizen" }, ["Java", "Go"]);
  const intern = job(3, { type: "internship", hours: "part", months: 6, student: "enrolled" }, ["python"], ["python"], { closed: true });
  const old = job(4, null, ["Java"]);
  const all = [ft, senior, intern, old];
  const keep = (f: object) => all.filter((j) => passes(j, { ...NO_FILTER, ...f })).map((j: { id: number }) => j.id);

  assert.deepEqual(keep({}), [1, 2, 3, 4]);
  assert.deepEqual(keep({ types: ["fulltime"] }), [1, 2], "a job read before conditions existed cannot match a type");
  assert.deepEqual(keep({ types: ["intern_part"] }), [3]);
  assert.deepEqual(keep({ types: ["intern_full"] }), []);
  const openHours = job(5, { type: "internship" }, []);
  assert.ok(passes(openHours, { ...NO_FILTER, types: ["intern_part"] }) && passes(openHours, { ...NO_FILTER, types: ["intern_full"] }), "hours not stated: either kind");
  assert.deepEqual(keep({ maxYears: 1 }), [1, 3, 4]);
  assert.deepEqual(keep({ hideCitizenOnly: true }), [1, 3, 4]);
  assert.deepEqual(keep({ coverLetter: "yes" }), [1]);
  assert.deepEqual(keep({ coverLetter: "no" }), [2, 3, 4]);
  assert.deepEqual(keep({ hideClosed: true }), [1, 2, 4]);
  assert.deepEqual(keep({ keyword: "java" }), [1, 2, 4]);

  const s = reqStats(all);
  assert.equal(s.noFacts, 1);
  assert.deepEqual(s.types, [{ label: "全职", n: 2 }, { label: "兼职实习", n: 1 }]);
  assert.deepEqual(s.years.map((y) => y.label), ["不要经验", "3 年以上", "没写"]);
  assert.deepEqual(s.keywords[0], { k: "Java", n: 3, have: true });
  assert.ok(s.limits.some((l) => l.label === "已关闭" && l.n === 1));
  assert.ok(s.materials.some((m) => m.label === "要求职信" && m.n === 1));

  assert.deepEqual(readFilter("not json"), NO_FILTER);
  assert.deepEqual(readFilter(JSON.stringify({ types: ["fulltime", "bogus"], minFit: "x" })).types, ["fulltime"]);
  assert.deepEqual(readFilter(JSON.stringify({ types: ["internship"] })).types, ["intern_part", "intern_full"], "a filter saved before the split keeps both");
  assert.deepEqual(
    factChips(normalizeFacts({ type: "internship", hours: "part", months: 6, minYears: 2, workAuth: "citizen" })).map((c) => `${c.text}${c.warn ? "!" : ""}`),
    ["兼职实习 6 个月", "2 年以上经验!", "仅限公民!"],
  );
});

test("a fit that clashes with what the candidate wants is capped, only when the posting backs the clash", async () => {
  const { normalizeFit, normalizeFacts, FIT_CONFLICT_CAP } = await import("./jobs.ts");
  const fit = (conflict: string, score = 78) => ({ score, verdict: "x", strengths: [], gaps: [], conflict });
  const fullIntern = normalizeFacts({ type: "internship", hours: "full", months: 6 });
  const clash = normalizeFit(fit("fulltime_internship"), fullIntern)!;
  assert.equal(clash.score, FIT_CONFLICT_CAP);
  assert.match(clash.conflict ?? "", /全职实习/);
  assert.equal(normalizeFit(fit("fulltime_internship", 30), fullIntern)!.score, 30, "a lower score stays");
  const job = normalizeFacts({ type: "fulltime", hours: "full" });
  const madeUp = normalizeFit(fit("graduates_only"), job)!;
  assert.equal(madeUp.score, 78, "a clash the posting does not state is dropped");
  assert.ok(!("conflict" in madeUp));
  assert.equal(normalizeFit(fit("graduates_only"), normalizeFacts({ type: "fulltime", student: "graduated" }))!.score, FIT_CONFLICT_CAP);
  assert.equal(normalizeFit(fit("fulltime_internship"), normalizeFacts({ type: "internship" }))!.score, 78, "hours not stated: no clash");
  assert.equal(normalizeFit(fit("全职岗位，你还没毕业"), job)!.score, 78, "free text is not a kind");
  assert.ok(!("conflict" in normalizeFit(fit(""), job)!));
});

test("a full-time internship is capped for someone who wants part-time ones, even when the model missed it", async () => {
  const { capForPrefs, normalizeFacts, FIT_CONFLICT_CAP } = await import("./jobs.ts");
  const fit = { score: 88, verdict: "x", strengths: [], gaps: [] };
  const prefs = "WHAT THE CANDIDATE IS LOOKING FOR\n- What type of role?: Full-time entry-level roles (main choice); part-time internships as a second option";
  const full = normalizeFacts({ type: "internship", hours: "full" });
  assert.equal(capForPrefs(fit, full, prefs)!.score, FIT_CONFLICT_CAP);
  assert.equal(capForPrefs(fit, normalizeFacts({ type: "internship" }), prefs)!.score, 88, "hours not stated");
  assert.equal(capForPrefs(fit, normalizeFacts({ type: "fulltime", hours: "full" }), prefs)!.score, 88, "a full-time job is not an internship");
  assert.equal(capForPrefs(fit, full, "- Role: part-time or full-time internships")!.score, 88, "full-time internships accepted too");
  assert.equal(capForPrefs(fit, full, "")!.score, 88);
  const named = { ...fit, score: 40, conflict: "只招已经毕业的" };
  assert.equal(capForPrefs(named, full, prefs), named, "an existing conflict is kept as it is");
});

test("postings are read without the site around them: LinkedIn's similar jobs, MyCareersFuture's footer", async () => {
  const { trimPosting } = await import("./jobs.ts");
  const linkedin = [
    "Skip to main content", "LinkedIn", "Jobs", "Clear text", "Sign in", "Join now",
    "Software Engineer, Singpass", "GovTech Singapore  Singapore, Singapore", "1 day ago  41 applicants",
    "See who GovTech Singapore has hired for this role", "Apply", "Save", "Use AI to assess how you fit", "Am I a good fit for this job?", "Tailor my resume",
    "What the role is", "Build Singpass. Requirements: Java or Go.", "Show more", "Seniority level", "Entry level", "Employment type", "Full-time",
    "Referrals increase your chances of interviewing at GovTech Singapore by 2x", "See who you know",
    "Similar jobs", "Senior Software Engineer", "Changi Airport Group", "People also viewed", "Software Engineer, Google Ads Team", "Google",
  ].join("\n");
  const t = trimPosting(linkedin, "https://sg.linkedin.com/jobs/view/software-engineer-singpass-at-govtech-singapore-4436070851");
  assert.match(t, /^Software Engineer, Singpass\nGovTech Singapore/, "title and company kept");
  assert.match(t, /Requirements: Java or Go\./);
  assert.match(t, /Employment type\nFull-time/, "the criteria block is part of the posting");
  for (const gone of ["Join now", "Tailor my resume", "Show more", "Similar jobs", "Changi Airport", "Google Ads", "Referrals"]) assert.ok(!t.includes(gone), gone);

  const mcf = [
    "By continuing to browse our site you agree to our use of cookies.", "Close", "Log In",
    "The machine translation for this job description is powered by Microsoft Translator.",
    "ACTXA PTE. LTD.", "Software Engineering Intern - IN26009", "Internship/Attachment", "Requirements", "Currently pursuing a Bachelor's degree.",
    "See how you compare with other applicants", "Log in to view", "Add these skills if you have them", "Python",
    "More jobs from this company", "Log in to Apply", "Privacy Statement",
  ].join("\n");
  const m = trimPosting(mcf, "https://www.mycareersfuture.gov.sg/job/information-technology/software-engineering-intern-in26009-actxa-7ecd1263");
  assert.match(m, /^ACTXA PTE\. LTD\.\nSoftware Engineering Intern/);
  assert.match(m, /Currently pursuing a Bachelor's degree\.\nPython$/, "MyCareersFuture's skill tags stay");
  for (const gone of ["cookies", "See how you compare", "Log in", "Privacy Statement"]) assert.ok(!m.includes(gone), gone);

  const other = "Apply\nSimilar jobs\nSave";
  assert.equal(trimPosting(other, "https://careers.example.com/job/1"), other, "other sites come back as they were");
  assert.equal(trimPosting(other, ""), other, "pasted text without a link too");
  const fromApi = "Title\n\nRequirements\n• C++";
  assert.equal(trimPosting(fromApi, "https://www.mycareersfuture.gov.sg/job/x-1234"), fromApi, "MyCareersFuture text from its API has no page around it");
});

test("off-peak: DeepSeek's peak is weekdays 9-12 and 14-18 Beijing time", async () => {
  const { isPeak, peakEnds } = await import("../src/offpeak.ts");
  const bj = (s: string) => new Date(`${s}+08:00`);
  // Friday 13 November 2026.
  assert.equal(isPeak(bj("2026-11-13T08:59")), false);
  assert.equal(isPeak(bj("2026-11-13T09:00")), true);
  assert.equal(peakEnds(bj("2026-11-13T10:30"))?.toISOString(), bj("2026-11-13T12:00").toISOString());
  assert.equal(isPeak(bj("2026-11-13T12:30")), false, "lunch break");
  assert.equal(peakEnds(bj("2026-11-13T17:59"))?.toISOString(), bj("2026-11-13T18:00").toISOString());
  assert.equal(isPeak(bj("2026-11-13T18:00")), false);
  assert.equal(isPeak(bj("2026-11-14T10:00")), false, "Saturday");
  assert.equal(peakEnds(bj("2026-11-13T20:00")), null);
});

test("batch tailoring waits for off-peak and a free slot; a job you push goes now", async () => {
  const { addJobs, getJob, setJob, bgQueue } = await import("./jobs.ts");
  const { saveSettings } = await import("./settings.ts");
  const { pump, runNow } = await import("./batch.ts");
  const pushed: unknown[] = [];
  bgQueue.push = (t) => void pushed.push(t);
  const [a, b] = addJobs({ urls: ["https://example.com/batch/1", "https://example.com/batch/2"], autoApply: true }).ids;
  const jd = JSON.stringify({ title: "Intern", keywords: [] });
  const hold = (id: number, extra = {}) => setJob(id, { busy: null, jd, stage: "parsed", held: "tailor", ...extra });
  const peak = new Date("2026-11-13T10:00+08:00");
  const off = new Date("2026-11-13T20:00+08:00");
  saveSettings({ offPeakOnly: true, llmMode: "deepseek", apiKey: "sk-test" });
  hold(a);
  hold(b);
  pushed.length = 0;

  pump(peak);
  assert.equal(getJob(a)!.held, "tailor", "nothing starts at peak");
  assert.equal(pushed.length, 0);

  Object.defineProperty(bgQueue, "size", { get: () => 2, configurable: true });
  pump(off);
  assert.equal(getJob(a)!.held, "tailor", "off-peak, but no free slot: still waits");
  Object.defineProperty(bgQueue, "size", { get: () => 0, configurable: true });

  pump(off);
  assert.equal(getJob(a)!.held, null);
  assert.equal(getJob(a)!.busy, "tailoring");
  assert.equal(pushed.length, 2, "both start off-peak");

  hold(a);
  runNow([a]);
  assert.equal(getJob(a)!.busy, "tailoring", "现在就跑 skips the wait whatever the time");

  hold(b, { stage: "skipped" });
  pump(peak);
  assert.equal(getJob(b)!.held, null, "a skipped job stops waiting");

  hold(b);
  saveSettings({ offPeakOnly: false });
  pump(peak);
  assert.equal(getJob(b)!.held, null, "turning the setting off starts what was waiting");
  assert.equal(getJob(b)!.busy, "tailoring");

  const { setNoBalance } = await import("./llm.ts");
  hold(a, { busy: null });
  setNoBalance("¥-0.06");
  pump(off);
  assert.equal(getJob(a)!.held, "tailor", "an empty balance keeps it waiting instead of failing it");
  setNoBalance(null);
  pump(off);
  assert.equal(getJob(a)!.held, null);
  saveSettings({ apiKey: "" });
});

test("costs are priced by the time of each call; an empty balance stops calls before they are made", async () => {
  const { callRmb } = await import("./cost.ts");
  const row = { prompt_tokens: 1_000_000, cache_hit_tokens: 500_000, completion_tokens: 100_000 };
  // Friday 13 November 2026, UTC: 02:00 is 10:00 in Beijing (peak), 12:00 is 20:00 (off-peak).
  assert.equal(callRmb({ ...row, ts: "2026-11-13 02:00:00" }).toFixed(2), (0.5 * 2 + 0.5 * 0.04 + 0.1 * 8).toFixed(2));
  assert.equal(callRmb({ ...row, ts: "2026-11-13 12:00:00" }).toFixed(2), (0.5 * 1 + 0.5 * 0.02 + 0.1 * 4).toFixed(2));

  const { llmReady, setNoBalance, chat } = await import("./llm.ts");
  const { saveSettings } = await import("./settings.ts");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"error":{"message":"Insufficient Balance"}}', { status: 402 })) as typeof fetch;
  try {
    saveSettings({ apiKey: "sk-test", llmMode: "deepseek" });
    setNoBalance(null);
    assert.equal(llmReady().ok, true);
    await assert.rejects(chat({ messages: [{ role: "user", content: "hi" }] }), /402/);
    const r = llmReady();
    assert.ok(!r.ok && r.code === "no_balance", "a 402 marks the balance as used up");
    const { parseJob, addJobs, bgQueue, getJob } = await import("./jobs.ts");
    bgQueue.push = () => {};
    const [id] = addJobs({ urls: [], jdText: "Data Analyst at Example. SQL and Python required. ".repeat(3), autoApply: false }).ids;
    let calls = 0;
    globalThis.fetch = (async () => (calls++, new Response("{}", { status: 500 }))) as typeof fetch;
    await assert.rejects(parseJob(id), /余额不足/);
    assert.equal(calls, 0, "no call is made while the balance is empty");
    assert.equal(getJob(id)!.jd, null);
  } finally {
    globalThis.fetch = realFetch;
    setNoBalance(null);
    saveSettings({ apiKey: "" });
  }
});

test("a page that kept its layout is sent as the fields that changed, anything else in full", async () => {
  const { formatDelta, formatObs } = await import("./observe.ts");
  const field = (id: string, label: string, value = ""): El => ({ ...button(""), id, kind: "text", label, value });
  const page = (els: El[], excerpt = "Apply to Acme\nPersonal details"): import("./observe.ts").Obs => ({ url: "https://jobs.example.com/apply", title: "Apply", errors: [], elements: els, excerpt });
  const many = Array.from({ length: 20 }, (_, i) => field(`f0_${i + 10}`, `Question ${i + 1}`));
  const before = page([field("f0_1", "First name"), field("f0_2", "Phone"), button("Next", { id: "f0_3" }), ...many]);
  const after = page([field("f0_1", "First name", "Ada"), field("f0_2", "Phone"), button("Next", { id: "f0_3" }), ...many]);

  const d = formatDelta(before, after, 3, 4)!;
  assert.ok(d, "values changed, layout did not");
  assert.match(d, /^STEP 4 — same page and elements as the STEP 3 snapshot/);
  assert.match(d, /\[f0_1\] text "First name" = "Ada"/);
  assert.ok(!d.includes("Phone") && !d.includes("Question 1"), "unchanged elements are not repeated");
  assert.match(d, /Visible text: unchanged\./);
  assert.ok(d.length < formatObs(after, 4).length / 3, "much smaller than the full snapshot");

  const relabelled = page([field("f0_1", "Given name", "Ada"), field("f0_2", "Phone"), button("Next", { id: "f0_3" }), ...many]);
  assert.equal(formatDelta(before, relabelled, 3, 4), null, "a changed label means a full snapshot");
  const moved = { ...after, url: "https://jobs.example.com/apply/step-2" };
  assert.equal(formatDelta(before, moved, 3, 4), null, "another URL means a full snapshot");
  const allChanged = page(before.elements.map((e) => (e.kind === "text" ? { ...e, value: "x" } : e)));
  assert.equal(formatDelta(before, allChanged, 3, 4), null, "when nearly everything changed, the full snapshot is not much bigger");

  const withError = { ...after, errors: ["Phone is required"], excerpt: "Apply to Acme\nPhone is required" };
  const e = formatDelta(before, withError, 3, 4)!;
  assert.match(e, /Errors\/alerts on page now: "Phone is required"/);
  assert.match(e, /Visible text \(start\), now:\nApply to Acme\nPhone is required/);
});

test("re-reading a job with the same posting, profile and prompt does not call the model again", async () => {
  const { addJobs, getJob, setJob, bgQueue, parseJob } = await import("./jobs.ts");
  const { saveSettings } = await import("./settings.ts");
  bgQueue.push = () => {};
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    const content = JSON.stringify({ title: "Software Intern", company: "Acme", location: "Singapore", summary: "", requirements: ["Python"], niceToHave: [], keywords: ["Python"], language: "en", closed: false, facts: null, fit: null });
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
  }) as typeof fetch;
  try {
    saveSettings({ apiKey: "sk-test", llmMode: "deepseek" });
    const [id] = addJobs({ urls: [], jdText: "Software Intern at Acme. Requirements: Python, SQL. Apply by December. ".repeat(3), autoApply: false }).ids;
    setJob(id, { busy: null });
    await parseJob(id);
    assert.equal(calls, 1);
    assert.equal(getJob(id)!.title, "Software Intern");
    await parseJob(id);
    assert.equal(calls, 1, "nothing changed: the saved reading is reused");
    setJob(id, { jd_text: `${getJob(id)!.jd_text} Java is a plus.` });
    await parseJob(id);
    assert.equal(calls, 2, "a changed posting is read again");
  } finally {
    globalThis.fetch = realFetch;
    saveSettings({ apiKey: "" });
  }
});

test("skill mode: an AI assistant's reading gets the same checks as DeepSeek's, without a key or a model call", async () => {
  const { addJobs, getJob, jobJd, setJob, bgQueue, readPrompt, saveSkillReading, FIT_CONFLICT_CAP } = await import("./jobs.ts");
  const { saveProfile, getProfile } = await import("./profile.ts");
  const { saveSettings } = await import("./settings.ts");
  const { saveSkillTailoring } = await import("./tailor.ts");
  bgQueue.push = () => {};
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  const before = getProfile();
  try {
    saveSettings({ apiKey: "", llmMode: "deepseek" });
    saveProfile({
      ...master,
      answers: [{ id: "qa_jobtype", q: "What type of role?", a: "Full-time entry-level roles first; part-time internships second" }],
    });
    const [id] = addJobs({ urls: [], jdText: "Backend Intern at Acme, 6 months, full-time (40 hours a week). Requirements: Java, Spring Boot. ".repeat(2), autoApply: false }).ids;
    setJob(id, { busy: null });

    const p = await readPrompt(id);
    assert.match(p.system, /Return JSON/i, "the prompt is the app's own reading prompt");
    assert.match(p.input, /^CANDIDATE\n/, "the profile goes first, as in the app's call");
    assert.match(p.input, /WHAT THE CANDIDATE IS LOOKING FOR/);

    const jd = await saveSkillReading(id, {
      title: "Backend Intern",
      company: "Acme",
      location: "Singapore",
      summary: "后端实习",
      requirements: ["Java", "Spring Boot"],
      keywords: ["Java", "Spring Boot", "Java"],
      facts: { type: "internship", hours: "full", months: 6, workAuth: "anyone" },
      fit: { score: 90, verdict: "strong", strengths: ["Spring Boot project"], gaps: [] },
    });
    assert.equal(calls, 0, "no model was called");
    assert.equal(jd.fit!.score, FIT_CONFLICT_CAP, "a full-time internship is capped for someone who wants part-time ones");
    assert.ok(jd.fit!.conflict, "and the conflict is named");
    assert.equal(jd.facts!.workAuth, "", "values outside the allowed set are dropped");
    assert.deepEqual(jd.keywords, ["Java", "Spring Boot"], "keywords are de-duplicated");
    assert.equal(jd.src, undefined, "a later read by the app's own model is not mistaken for this one");
    const job = getJob(id)!;
    assert.equal(job.stage, "parsed");
    assert.equal(job.title, "Backend Intern");
    assert.equal(jobJd(job)!.fit!.score, FIT_CONFLICT_CAP);

    await assert.rejects(() => saveSkillReading(id, "not json"), /JSON/);
    await assert.rejects(() => saveSkillReading(id, { location: "Singapore" }), /title/);
    await assert.rejects(() => saveSkillTailoring(id, { summary: "no sections" }), /sections/);
  } finally {
    globalThis.fetch = realFetch;
    saveProfile(before);
  }
});
