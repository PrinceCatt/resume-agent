// Port of server/core.test.ts. The two promises this app makes: it never clicks a final submit on its
// own, and a tailored resume contains nothing that isn't in the master profile. Run: go test ./...
package app

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// Keep the real data/ folder out of it: a fresh folder under the repository's gitignored tmp/.
func TestMain(m *testing.M) {
	base := filepath.Join("..", "..", "tmp")
	_ = os.MkdirAll(base, 0o755)
	dir, err := os.MkdirTemp(base, "go-test-")
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	if err := Init(dir); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	retryDelay = time.Millisecond
	// Keep the background reader from trying to open these pages.
	bgQueue.PushFn = func(Task) {}
	code := m.Run()
	closeDB()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// ---- small assertion helpers

func eq[T comparable](t *testing.T, got, want T, msg ...string) {
	t.Helper()
	if got != want {
		t.Errorf("%s: got %v, want %v", strings.Join(msg, " "), got, want)
	}
}

func ok(t *testing.T, cond bool, msg ...string) {
	t.Helper()
	if !cond {
		t.Errorf("expected true: %s", strings.Join(msg, " "))
	}
}

func eqList(t *testing.T, got, want []string, msg ...string) {
	t.Helper()
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if !slices.Equal(got, want) {
		t.Errorf("%s: got %q, want %q", strings.Join(msg, " "), got, want)
	}
}

func match(t *testing.T, s, re string, msg ...string) {
	t.Helper()
	if !regexp.MustCompile(re).MatchString(s) {
		t.Errorf("%s: %q does not match /%s/", strings.Join(msg, " "), s, re)
	}
}

func js(s string) any {
	v, okk := parseAny(s)
	if !okk {
		panic("bad JSON in test: " + s)
	}
	return v
}

func button(text string) El {
	return El{ID: "f0_1", Kind: "button", Text: text, InForm: true}
}

func submitButton(text string) El {
	b := button(text)
	b.SubmitType = true
	return b
}

func TestFinalSubmitGuard(t *testing.T) {
	eq(t, isFinalSubmit(button("Submit Application"), 0), true)
	eq(t, isFinalSubmit(button("Submit"), 5), true)
	eq(t, isFinalSubmit(button("Send application"), 3), true)
	eq(t, isFinalSubmit(button("立即沟通"), 0), true)
	eq(t, isFinalSubmit(button("提交申请"), 0), true)
	// Starting an application is fine; "Apply" once fields are filled is not.
	eq(t, isFinalSubmit(button("Apply for this job"), 0), false)
	eq(t, isFinalSubmit(button("Easy Apply"), 0), false)
	eq(t, isFinalSubmit(button("Apply"), 4), true)
	// Step buttons in multi-page forms pass, even as type=submit.
	eq(t, isFinalSubmit(submitButton("Next"), 4), false)
	eq(t, isFinalSubmit(submitButton("Review your application"), 4), false)
	eq(t, isFinalSubmit(button("Continue"), 4), false)
	// An unnamed form submit after filling counts as final.
	eq(t, isFinalSubmit(submitButton("Done"), 4), true)
}

const masterJSON = `{
  "basics": {"name": "Test Person"},
  "sections": [
    {"id": "sec_edu", "heading": "Education", "entries": [
      {"id": "e_edu", "title": "Example University", "dates": "2023 - 2027", "bullets": [{"id": "b_gpa", "text": "GPA 3.8"}]}
    ]},
    {"id": "sec_exp", "heading": "Experience", "entries": [
      {"id": "e_orb", "title": "Course Project", "dates": "2024", "bullets": [
        {"id": "b1", "text": "Built a full-stack blog website with Spring Boot and Vue"},
        {"id": "b2", "text": "Deployed on an Ubuntu server with Nginx"}
      ]}
    ]}
  ],
  "skills": [{"id": "sk", "label": "Programming", "items": ["Java", "Python"]}],
  "extraFacts": "Interned at Example Labs as a backend intern from May 2026 to Nov 2026.\nWrote data pipelines in Python processing 2 million records."
}`

var master = normalizeProfile(js(masterJSON))

func testJD() *JobJd {
	return &JobJd{Title: "Backend Intern", Company: "Acme", Requirements: []string{}, NiceToHave: []string{}, Keywords: []string{"Kubernetes", "Java"}, Language: "en"}
}

func withFacts(f *JobFacts) *JobJd {
	j := testJD()
	j.Facts = f
	return j
}

func TestTailoringKeepsOnlyTraceableContent(t *testing.T) {
	out := assemble(master, parseTailorOutput(js(`{
    "sections": [
      {"id": "sec_exp", "entries": [{"id": "e_orb", "bullets": [
        {"src": "b1", "text": "Built a full-stack web app with Spring Boot, serving 10,000 users"},
        {"src": "b2", "text": "Deployed and operated the service on Ubuntu behind Nginx"},
        {"src": "made_up", "text": "Led a team of 8 engineers"}
      ]}]},
      {"id": "new", "heading": "Work Experience", "entries": [{"id": "new", "title": "Example Labs", "subtitle": "Backend Intern", "dates": "May 2026 - Nov 2026", "bullets": [
        {"src": "fact", "fact": "Wrote data pipelines in Python processing 2 million records.", "text": "Built Python data pipelines processing 2 million records"}
      ]}]}
    ],
    "skills": [{"id": "sk", "items": ["Java", "Kubernetes", "Python"]}]
  }`)), testJD())
	var exp, work *Section
	for i := range out.Doc.Sections {
		s := &out.Doc.Sections[i]
		if s.ID == "sec_exp" {
			exp = s
		}
		if s.Heading == "Work Experience" {
			work = s
		}
	}
	if exp == nil || work == nil {
		t.Fatalf("sections missing: %+v", out.Doc.Sections)
	}
	texts := []string{}
	for _, b := range exp.Entries[0].Bullets {
		texts = append(texts, b.Text)
	}
	ok(t, slices.Contains(texts, "Built a full-stack blog website with Spring Boot and Vue"), "invented number reverted to the original")
	ok(t, slices.Contains(texts, "Deployed and operated the service on Ubuntu behind Nginx"))
	ok(t, !slices.ContainsFunc(texts, func(s string) bool { return strings.Contains(s, "team of 8") }), "unsourced bullet dropped")
	eqList(t, out.Doc.Skills[0].Items, []string{"Java", "Python"}, "skill not in profile dropped")
	eq(t, out.Doc.Sections[0].Heading, "Education", "education put back first")
	eq(t, work.Entries[0].Bullets[0].Text, "Built Python data pipelines processing 2 million records")
	has := func(s string) bool {
		return slices.ContainsFunc(out.Warnings, func(w string) bool { return strings.Contains(w, s) })
	}
	ok(t, has("10"), "number warning")
	ok(t, has("Kubernetes"), "skill warning")
	ok(t, has("Example Labs"), "new entry flagged for review")
}

func TestSamePostingPastedTwiceIsAddedOnce(t *testing.T) {
	eq(t, normalizeURL("https://www.linkedin.com/jobs/view/123/?trackingId=abc&refId=x"), normalizeURL("linkedin.com/jobs/view/123"))
	eq(t, normalizeURL("https://jobs.lever.co/acme/42?lever-source=LinkedIn#apply"), normalizeURL("https://jobs.lever.co/acme/42/"))
	ok(t, normalizeURL("https://example.com/jobs?id=1") != normalizeURL("https://example.com/jobs?id=2"))
	first := addJobs([]string{"https://jobs.lever.co/acme/42", "https://jobs.lever.co/acme/42/?utm_source=x"}, "", false)
	eq(t, len(first.IDs), 1)
	eq(t, len(first.Duplicates), 1)
	again := addJobs([]string{"jobs.lever.co/acme/42#top", "https://jobs.lever.co/acme/43"}, "", false)
	eq(t, len(again.IDs), 1)
	eq(t, len(again.Duplicates), 1)
	if len(again.Duplicates) == 1 && len(first.IDs) == 1 {
		eq(t, again.Duplicates[0].ID, first.IDs[0])
	}
}

func TestMarkingAppliedStartsFollowUpOnce(t *testing.T) {
	id := addJobs([]string{"https://example.com/careers/9"}, "", false).IDs[0]
	setJob(id, P{"stage": "applied"})
	a := getJob(id)
	eq(t, sv(a.Progress), "applied")
	ok(t, truthyStr(a.AppliedAt))
	setJob(id, P{"progress": "interview"})
	setJob(id, P{"stage": "applied"})
	b := getJob(id)
	eq(t, sv(b.Progress), "interview", "applying again does not reset progress")
	eq(t, sv(b.AppliedAt), sv(a.AppliedAt), "first applied date is kept")
}

func progresses(id int64) []string {
	out := []string{}
	for _, l := range progressLog(id) {
		out = append(out, l.Progress)
	}
	return out
}

func TestInterviewMovesProgressAndStatsCountHowFar(t *testing.T) {
	ids := addJobs([]string{"https://boards.greenhouse.io/acme/jobs/1", "https://boards.greenhouse.io/acme/jobs/2"}, "", false).IDs
	a, b := ids[0], ids[1]
	setJob(a, P{"stage": "applied"})
	setJob(b, P{"stage": "applied"})
	ev, err := addEvent(a, map[string]any{"kind": "interview", "at": "2030-01-02T06:00:00.000Z", "note": "https://meet.example.com/abc"})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, sv(getJob(a).Progress), "interview")
	if _, err := addEvent(a, map[string]any{"kind": "test", "at": "2030-01-03T06:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	eq(t, sv(getJob(a).Progress), "interview", "a test after the interview does not move it back")
	setJob(a, P{"progress": "rejected"})
	eqList(t, progresses(a), []string{"applied", "interview", "rejected"})

	var gh *Bucket
	for _, s := range stats().BySite {
		if s.Label == "Greenhouse" {
			gh = &s
		}
	}
	if gh == nil {
		t.Fatal("no Greenhouse bucket")
	}
	eq(t, fmt.Sprint(gh.Applied, gh.Replied, gh.Positive), "2 1 1", "a rejection after an interview still counts as having got that far")

	ics := icsFor(*getEvent(ev))
	ok(t, strings.Contains(ics, "DTSTART:20300102T060000Z"))
	ok(t, strings.Contains(ics, "TRIGGER:-PT1H"))
	for _, l := range strings.Split(ics, "\r\n") {
		ok(t, len(l) <= 75, "long lines are folded: "+l)
	}
}

func TestStraightToTestRoundStartsWithApplied(t *testing.T) {
	id := addJobs([]string{"https://example.com/careers/77"}, "", false).IDs[0]
	// What PATCH /api/jobs/:id { progress: "screening" } does for a job you applied to by hand.
	setJob(id, P{"progress": "screening", "progress_at": sqlNow(), "stage": "applied"})
	eqList(t, progresses(id), []string{"applied", "screening"})
}

func TestAskedQuestionsShowUntilAnswered(t *testing.T) {
	jobID := addJobs([]string{"https://example.com/careers/88"}, "", false).IDs[0]
	runID, _ := mustExec("INSERT INTO runs (job_id, status) VALUES (?, 'finished')", jobID)
	mustExec("INSERT INTO run_steps (run_id, kind, text) VALUES (?, 'ask', ?)", runID, "问你：What is your notice period?")
	mustExec("INSERT INTO run_steps (run_id, kind, text) VALUES (?, 'note', ?)", runID, "你的回答：Immediately（已记入资料库）")
	mustExec("INSERT INTO run_steps (run_id, kind, text) VALUES (?, 'ask', ?)", runID, "问你：Do you have a driving licence?")
	open := askedQuestions(similarity, []Answer{{Q: "What is your notice period?", A: ""}})
	got := []string{}
	for _, a := range open {
		got = append(got, a.Q+" = "+a.A)
	}
	sort.Strings(got)
	eqList(t, got, []string{"Do you have a driving licence? = ", "What is your notice period? = Immediately"}, "an empty saved answer still counts as open")
	left := askedQuestions(similarity, []Answer{{Q: "What is your notice period?", A: "Immediately"}})
	got = []string{}
	for _, a := range left {
		got = append(got, a.Q)
	}
	eqList(t, got, []string{"Do you have a driving licence?"}, "an answered question drops off")
}

func TestUnsupportedTerms(t *testing.T) {
	p := profileText(master)
	eqList(t, unsupportedTerms("Built ROS nodes in Java and wrote JUnit tests", p, nil), []string{"ROS", "JUnit"})
	eqList(t, unsupportedTerms("Used JavaScript on a robotic arm", p, nil), []string{"JavaScript"}, "Java is not found inside JavaScript, and an arm is not ARM")
	eqList(t, unsupportedTerms("熟悉 Spring Boot 和 Nginx，有 Kubernetes 经验", p, []string{"Kubernetes"}), []string{"Kubernetes"}, "works inside Chinese text, and posting keywords count")
}

func TestTalkingPointsNeedABackingLine(t *testing.T) {
	kw := testJD().Keywords
	kind := func(raw any) string { return checkPoint(raw, master, kw).Kind }
	eq(t, kind(js(`{"text": "Built a blog with Spring Boot and Vue", "src": "b1"}`)), "fact")
	eq(t, checkPoint(js(`{"text": "Built a blog", "src": "[b1]"}`), master, kw).From, "Course Project")
	eq(t, kind(js(`{"text": "Processed 2 million records in Python", "src": "fact", "fact": "Wrote data pipelines in Python processing 2 million records."}`)), "fact")
	eq(t, kind(js(`{"text": "Interned at Example Labs", "src": "fact", "fact": "Interned at Google."}`)), "unsure", "a quoted fact that is not in EXTRA FACTS")
	eq(t, kind(js(`{"text": "Explain how you would design the API", "src": "tip"}`)), "tip")
	eq(t, kind(js(`{"text": "Used Kubernetes to deploy the blog", "src": "tip"}`)), "unsure", "a claim labelled as a tip")
	eq(t, kind(js(`{"text": "Deployed the blog on Kubernetes", "src": "b2"}`)), "unsure", "a real source, but a tool the profile lacks")
	eq(t, kind(js(`{"text": "Served 5000 users", "src": "b1"}`)), "unsure", "a number the profile lacks")
	eq(t, kind(js(`{"text": "Led a team of four", "src": "b9"}`)), "unsure", "an id that does not exist")
	eq(t, kind("Built a blog"), "unsure", "an old plain-string point")
}

func TestFitStrengthCreditingMissingToolIsMarked(t *testing.T) {
	fit := checkFit(Fit{Score: 88, Strengths: []string{"有 ROS 机器人项目经验", "熟悉 Java"}, Gaps: []string{}}, profileText(master), testJD().Keywords)
	eqList(t, fit.Unsupported, []string{"ROS"})
	eq(t, fit.Strengths[0], "有 ROS 机器人项目经验（资料库里没找到：ROS）")
	eq(t, fit.Strengths[1], "熟悉 Java")
}

func TestToolAliasesAndVersions(t *testing.T) {
	p := "Skills: Robot Operating System (familiar), Vue3, HTML5, k8s basics"
	eqList(t, unsupportedTerms("Built ROS nodes with a Vue front end on Kubernetes", p, nil), []string{})
	eqList(t, unsupportedTerms("Wrote Golang services", "Let's go", nil), []string{"Golang"}, "a two-letter alias only counts in its own case")
}

func TestPrepFlagsWorkedOutWhenRead(t *testing.T) {
	saved := js(`{"pitch": "I build ROS robots.", "questions": [{"q": "Q", "kind": "technical", "why": "", "points": [{"text": "Wrote ROS nodes for the robot", "src": "b1"}]}], "toAsk": [], "gaps": [], "generatedAt": ""}`)
	view := func(p Profile) (string, []string) {
		v := prepView(saved, p, testJD()).(map[string]any)
		q := v["questions"].([]any)[0].(map[string]any)
		return q["points"].([]any)[0].(PrepPointView).Kind, v["pitchWarnings"].([]string)
	}
	k, w := view(master)
	eq(t, k, "unsure")
	eqList(t, w, []string{"提到了 ROS，资料库里没有"})
	m := obj(js(masterJSON))
	m["skills"] = js(`[{"id": "sk", "label": "Programming", "items": ["Java", "Python"]}, {"id": "sk2", "label": "Robotics", "items": ["Robot Operating System"]}]`)
	k, w = view(normalizeProfile(m))
	eq(t, k, "fact")
	eqList(t, w, []string{})
}

func TestJobSitesAndBotChecks(t *testing.T) {
	key := func(u string) string {
		if s := siteFor(u); s != nil {
			return s.Key
		}
		return ""
	}
	eq(t, key("https://sg.linkedin.com/jobs/view/software-engineer-intern-at-acme-4475507408"), "linkedin")
	eq(t, key("https://www.linkedin.com/jobs/view/4475507408/"), "linkedin")
	eq(t, key("https://sg.jobstreet.com/job/81234567"), "jobstreet")
	eq(t, key("https://www.glassdoor.sg/job-listing/software-engineer-intern-acme-JV_KO0,24.htm"), "glassdoor")
	eq(t, key("https://smartapply.indeed.com/beta/indeedapply/form/contact-info"), "indeed")
	eq(t, key("https://www.mycareersfuture.gov.sg/job/information-technology/intern-d5cfb9f5586c337bc00c90c5def60d9e"), "mcf")
	eq(t, key("https://acme.wd3.myworkdayjobs.com/en-US/careers/job/Singapore/Intern_R123"), "workday")
	eq(t, key("http://127.0.0.1:8791/fixtures/site-indeed-apply.html"), "indeed", "local mock pages stand in for a site")
	eq(t, key("https://boards.greenhouse.io/acme/jobs/1"), "")
	eq(t, key("https://notlinkedin.com/jobs/1"), "")
	eq(t, siteFor("https://sg.jobstreet.com/job/1").VisibleOnly, true)
	eq(t, isCheckPage("Just a moment...", "Checking if the site connection is secure"), true)
	eq(t, isCheckPage("Blocked - Indeed.com", ""), true)
	eq(t, isCheckPage("Software Engineer Intern - Acme", "Verify you are human by completing the action below."), true)
	eq(t, isCheckPage("Software Engineer Intern - Acme", "We are looking for a security engineer who can wait a moment."), false)
}

func TestDialogControlsListedFirst(t *testing.T) {
	next := button("Next")
	next.ID, next.InDialog = "f0_9", true
	save := button("Save job 1")
	text := formatObs(Obs{URL: "https://www.linkedin.com/jobs/view/1", Title: "Job", Errors: []string{}, Elements: []El{next, save}}, 3)
	lines := strings.Split(text, "\n")
	at := func(s string) int {
		return slices.IndexFunc(lines, func(l string) bool { return strings.Contains(l, s) })
	}
	ok(t, at("inside the dialog") >= 0 && at("inside the dialog") < at(`"Next"`) && at(`"Next"`) < at("behind the dialog") && at("behind the dialog") < at(`"Save job 1"`), text)
}

func TestSecretsStayOnTheServer(t *testing.T) {
	SaveSettings(map[string]any{"apiKey": "sk-test-1234567890", "extensionToken": "ext-token-abcdef"})
	eq(t, GetSettings().ExtensionToken, "ext-token-abcdef")
	pub := PublicSettings()
	text := jsonStr(pub)
	_, k1 := pub["apiKey"]
	_, k2 := pub["extensionToken"]
	ok(t, !k1 && !k2)
	ok(t, !strings.Contains(text, "ext-token-abcdef") && !strings.Contains(text, "sk-test-1234567890"))
	eq(t, pub["hasExtensionToken"], any(true))
	SaveSettings(map[string]any{"apiKey": "", "extensionToken": ""})
	eq(t, PublicSettings()["hasExtensionToken"], any(false))
}

func TestCandidatePrefsReachFitCheck(t *testing.T) {
	p := normalizeProfile(js(`{"sections": [], "answers": [
    {"id": "qa_jobtype", "q": "What type of role are you looking for?", "a": "Full-time entry-level roles"},
    {"id": "qa_grad", "q": "Graduation date", "a": "May 2027"},
    {"id": "qa_dur", "q": "Internship duration you are available for", "a": ""},
    {"id": "qa_gender", "q": "Gender", "a": "Decline"}
  ]}`))
	text := searchPrefs(p)
	match(t, text, `^WHAT THE CANDIDATE IS LOOKING FOR`)
	match(t, text, `Full-time entry-level roles`)
	match(t, text, `May 2027`)
	ok(t, !regexp.MustCompile(`(?i)duration`).MatchString(text) && !strings.Contains(text, "Gender"))
	eq(t, searchPrefs(normalizeProfile(js(`{"sections": [], "answers": []}`))), "")
}

// Shaped like LinkedIn's public search fragment (jobs-guest/…/seeMoreJobPostings), trimmed.
const liCards = `
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
</li>`

func TestLinkedInCards(t *testing.T) {
	cards := parseLinkedInCards(liCards)
	if len(cards) != 2 {
		t.Fatalf("got %d cards", len(cards))
	}
	eq(t, cards[0], FoundJob{Source: "linkedin", Title: "Graduate Software Engineer", Company: "HCLTech", Location: "Singapore, Singapore", Posted: "2026-11-10", URL: "https://sg.linkedin.com/jobs/view/graduate-software-engineer-at-hcltech-4481637634", Salary: "S$4,000 - S$5,000"})
	eq(t, cards[1].Title, "Backend Engineer (Java & Go)")
	eq(t, cards[1].Company, "R&D Labs Pte. Ltd.")
	eq(t, cards[1].Salary, "")
	eq(t, len(parseLinkedInCards("<html><body>No matching jobs found.</body></html>")), 0)
}

func TestMcfResults(t *testing.T) {
	out := mapMcf(js(`[
    {"title": " Software Engineer ", "postedCompany": {"name": "TALENT AGENCY PTE. LTD."}, "hiringCompany": {"name": "ACME ROBOTICS PTE. LTD."},
     "metadata": {"jobDetailsUrl": "https://www.mycareersfuture.gov.sg/job/information-technology/software-engineer-acme-0123456789abcdef0123456789abcdef", "newPostingDate": "2026-11-11", "isPostedOnBehalf": true, "isHideSalary": false},
     "salary": {"minimum": 4000, "maximum": 5500, "type": {"salaryType": "Monthly"}}, "address": {"districts": [{"location": "Central"}]}},
    {"title": "Backend Developer", "postedCompany": {"name": "BETA PTE. LTD."},
     "metadata": {"jobDetailsUrl": "https://www.mycareersfuture.gov.sg/job/it/backend-beta-fedcba9876543210fedcba9876543210", "newPostingDate": "2026-11-09", "isHideSalary": true},
     "salary": {"minimum": 3000, "maximum": 4000}},
    {"title": "No link", "metadata": {}}
  ]`).([]any))
	if len(out) != 2 {
		t.Fatalf("got %d", len(out))
	}
	eq(t, out[0].Title, "Software Engineer")
	eq(t, out[0].Company, "ACME ROBOTICS PTE. LTD.")
	eq(t, out[0].Salary, "S$4000–5500/月")
	eq(t, out[0].Location, "Central")
	eq(t, out[1].Company, "BETA PTE. LTD.")
	eq(t, out[1].Salary, "")
}

func TestSearchDedupeAndKnownMarks(t *testing.T) {
	eq(t, jobKey("https://sg.linkedin.com/jobs/view/graduate-software-engineer-at-hcltech-4481637634?refId=1"), "linkedin:4481637634")
	eq(t, jobKey("https://www.linkedin.com/jobs/view/4481637634/"), "linkedin:4481637634")
	f := func(source, title, company, posted, u string) FoundJob {
		return FoundJob{Source: source, Title: title, Company: company, Location: "Singapore", Posted: posted, URL: u}
	}
	fromLinkedIn := []FoundJob{
		f("linkedin", "Graduate Software Engineer", "HCLTech", "2026-11-10", "https://sg.linkedin.com/jobs/view/graduate-software-engineer-at-hcltech-4481637634"),
		f("linkedin", "Backend Engineer", "R&D Labs Pte. Ltd.", "2026-11-12", "https://sg.linkedin.com/jobs/view/backend-engineer-at-r-d-labs-4400000001"),
	}
	second := fromLinkedIn[0]
	second.URL = "https://www.linkedin.com/jobs/view/4481637634/"
	fromMcf := []FoundJob{
		f("mcf", "Backend Engineer", "R&D LABS PTE LTD", "2026-11-11", "https://www.mycareersfuture.gov.sg/job/it/backend-engineer-rd-0123456789abcdef0123456789abcdef"),
		f("mcf", "Software Engineer", "Acme", "", "https://www.mycareersfuture.gov.sg/job/it/software-engineer-acme-fedcba9876543210fedcba9876543210"),
	}
	known := map[string]int64{jobKey("https://sg.linkedin.com/jobs/view/graduate-software-engineer-at-hcltech-4481637634"): 20}
	got := []string{}
	for _, j := range mergeFound([][]FoundJob{fromLinkedIn, {second}, fromMcf}, known) {
		ex := "null"
		if j.ExistingID != nil {
			ex = fmt.Sprint(*j.ExistingID)
		}
		got = append(got, j.Title+"|"+j.Source+"|"+ex)
	}
	eqList(t, got, []string{"Backend Engineer|linkedin|null", "Graduate Software Engineer|linkedin|20", "Software Engineer|mcf|null"})
}

func TestSeniorTitles(t *testing.T) {
	for _, s := range []string{"Senior Java Software Engineer", "Sr. Backend Engineer", "Lead Java Developer", "Staff Software Engineer, GenAI", "Engineering Manager", "Backend Engineer (5+ years)", "Head of Platform"} {
		ok(t, seniorTitle(s), s)
	}
	for _, s := range []string{"Junior Fullstack Software Engineer", "Graduate Software Engineer", "Software Engineer, Singpass", "Backend Developer", "Leading-edge AI Engineer Intern"} {
		ok(t, !seniorTitle(s), s)
	}
}

func TestMcfTitlesCarryAQueryWord(t *testing.T) {
	ok(t, relevantTitle("Java Developer", "software developer"))
	ok(t, relevantTitle("Software Engineering Intern", "software engineer intern"))
	ok(t, relevantTitle("Engineer, Firmware Development (SSD)", "embedded software engineer"))
	ok(t, !relevantTitle("Business Development Associate", "software developer"))
	ok(t, !relevantTitle("(FULL / PART TIME) Business Development Assistant", "part time developer"))
	ok(t, !relevantTitle("#FreshGrads "+string(rune(0x1F393))+" This one's for you!", "graduate software engineer"))
}

func TestMcfPostingFromAPIRecord(t *testing.T) {
	got := mcfJobText(js(`{
    "title": "Software Engineer",
    "description": "<p><strong>JOB DESCRIPTION</strong></p><ul><li>Embedded system development</li><li>C/C++ &amp; Linux</li></ul>",
    "postedCompany": {"name": "AGENCY PTE. LTD."}, "hiringCompany": {"name": "REALTEK SINGAPORE PRIVATE LIMITED"},
    "metadata": {"isPostedOnBehalf": true, "isHideSalary": false},
    "employmentTypes": [{"employmentType": "Full Time"}], "positionLevels": [{"position": "Fresh/entry level"}],
    "minimumYearsExperience": 0, "salary": {"minimum": 4500, "maximum": 7500, "type": {"salaryType": "Monthly"}},
    "skills": [{"skill": "Linux"}, {"skill": "Firmware"}], "status": {"jobStatus": "Closed"}
  }`))
	eq(t, got.Title, "Software Engineer | REALTEK SINGAPORE PRIVATE LIMITED")
	match(t, got.Text, `Status: Closed`)
	match(t, got.Text, `Position level: Fresh/entry level`)
	match(t, got.Text, `Minimum years of experience: 0`)
	match(t, got.Text, `• Embedded system development\n• C/C\+\+ & Linux`)
	match(t, got.Text, `Skills: Linux, Firmware`)
	ok(t, !regexp.MustCompile(`<[a-z]`).MatchString(got.Text))
}

func TestPostingConditionsOnlyKnownValues(t *testing.T) {
	f := normalizeFacts(js(`{"type": "internship", "hours": "part", "months": "6", "minYears": 99, "degree": "bachelor", "student": "maybe", "workAuth": "citizen_pr", "salary": "S$1,200 / month", "materials": ["cover_letter", "cover_letter", "selfie", "transcript"], "coverLetterAsk": "Why you want to join", "workplace": "hybrid"}`))
	eq(t, f.Type, "internship")
	ok(t, f.Months != nil && *f.Months == 6)
	ok(t, f.MinYears == nil, "an impossible number is dropped, not clamped")
	eq(t, f.Student, "", "an unknown value becomes empty")
	eqList(t, f.Materials, []string{"cover_letter", "transcript"})
	ok(t, normalizeFacts(nil) == nil, "no conditions from the model: none recorded")
	eq(t, normalizeFacts(map[string]any{}).Type, "unknown")
	eqList(t, normalizeFacts(js(`{"materials": "cover_letter"}`)).Materials, []string{})
	eq(t, asksCoverLetter(withFacts(f)), true)
	noMat := *f
	noMat.Materials = []string{}
	eq(t, asksCoverLetter(withFacts(&noMat)), false)
	eq(t, asksCoverLetter(nil), false)
}

func TestCoverLetterRules(t *testing.T) {
	asks := withFacts(normalizeFacts(js(`{"materials": ["cover_letter"]}`)))
	eq(t, wantsCoverLetter(false, testJD()), false)
	eq(t, wantsCoverLetter(true, testJD()), true)
	eq(t, wantsCoverLetter(false, asks), true)
	eqList(t, coverLetterWarnings(master, "My pipelines processed 2 million records.", testJD()), []string{})
	eq(t, len(coverLetterWarnings(master, "I led a team of 12 engineers.", testJD())), 1)
}

// The requirement filters themselves (passes, reqStats, readFilter, factChips) live in src/reqs.ts and run
// in the browser; the server only uses the labels, which the job list CSV prints.
func TestRequirementLabels(t *testing.T) {
	f := normalizeFacts(js(`{"type": "internship", "hours": "part", "months": 6, "minYears": 2, "workAuth": "citizen"}`))
	eq(t, typeLabel(f), "兼职实习 6 个月")
	eq(t, yearsLabel(*f.MinYears), "2 年以上经验")
	eq(t, yearsLabel(0), "不要经验")
	eq(t, typeLabel(normalizeFacts(js(`{"type": "fulltime"}`))), "全职")
	eq(t, AuthLabel[f.WorkAuth], "仅限公民")
}

func fitIn(conflict string, score float64) any {
	return map[string]any{"score": score, "verdict": "x", "strengths": []any{}, "gaps": []any{}, "conflict": conflict}
}

func TestFitConflictCap(t *testing.T) {
	fullIntern := normalizeFacts(js(`{"type": "internship", "hours": "full", "months": 6}`))
	clash := normalizeFit(fitIn("fulltime_internship", 78), true, fullIntern)
	eq(t, clash.Score, float64(FitConflictCap))
	match(t, clash.Conflict, `全职实习`)
	eq(t, normalizeFit(fitIn("fulltime_internship", 30), true, fullIntern).Score, 30.0, "a lower score stays")
	job := normalizeFacts(js(`{"type": "fulltime", "hours": "full"}`))
	madeUp := normalizeFit(fitIn("graduates_only", 78), true, job)
	eq(t, madeUp.Score, 78.0, "a clash the posting does not state is dropped")
	eq(t, madeUp.Conflict, "")
	ok(t, !strings.Contains(jsonStr(madeUp), "conflict"))
	eq(t, normalizeFit(fitIn("graduates_only", 78), true, normalizeFacts(js(`{"type": "fulltime", "student": "graduated"}`))).Score, float64(FitConflictCap))
	eq(t, normalizeFit(fitIn("fulltime_internship", 78), true, normalizeFacts(js(`{"type": "internship"}`))).Score, 78.0, "hours not stated: no clash")
	eq(t, normalizeFit(fitIn("全职岗位，你还没毕业", 78), true, job).Score, 78.0, "free text is not a kind")
	ok(t, !strings.Contains(jsonStr(normalizeFit(fitIn("", 78), true, job)), "conflict"))
}

func TestFullTimeInternshipCappedForPartTimeSeeker(t *testing.T) {
	fit := &Fit{Score: 88, Verdict: "x", Strengths: []string{}, Gaps: []string{}}
	prefs := "WHAT THE CANDIDATE IS LOOKING FOR\n- What type of role?: Full-time entry-level roles (main choice); part-time internships as a second option"
	full := normalizeFacts(js(`{"type": "internship", "hours": "full"}`))
	eq(t, capForPrefs(fit, full, prefs).Score, float64(FitConflictCap))
	eq(t, capForPrefs(fit, normalizeFacts(js(`{"type": "internship"}`)), prefs).Score, 88.0, "hours not stated")
	eq(t, capForPrefs(fit, normalizeFacts(js(`{"type": "fulltime", "hours": "full"}`)), prefs).Score, 88.0, "a full-time job is not an internship")
	eq(t, capForPrefs(fit, full, "- Role: part-time or full-time internships").Score, 88.0, "full-time internships accepted too")
	eq(t, capForPrefs(fit, full, "").Score, 88.0)
	named := &Fit{Score: 40, Verdict: "x", Strengths: []string{}, Gaps: []string{}, Conflict: "只招已经毕业的"}
	ok(t, capForPrefs(named, full, prefs) == named, "an existing conflict is kept as it is")
}

func TestPostingsReadWithoutTheSiteAround(t *testing.T) {
	linkedin := strings.Join([]string{
		"Skip to main content", "LinkedIn", "Jobs", "Clear text", "Sign in", "Join now",
		"Software Engineer, Singpass", "GovTech Singapore  Singapore, Singapore", "1 day ago  41 applicants",
		"See who GovTech Singapore has hired for this role", "Apply", "Save", "Use AI to assess how you fit", "Am I a good fit for this job?", "Tailor my resume",
		"What the role is", "Build Singpass. Requirements: Java or Go.", "Show more", "Seniority level", "Entry level", "Employment type", "Full-time",
		"Referrals increase your chances of interviewing at GovTech Singapore by 2x", "See who you know",
		"Similar jobs", "Senior Software Engineer", "Changi Airport Group", "People also viewed", "Software Engineer, Google Ads Team", "Google",
	}, "\n")
	tt := trimPosting(linkedin, "https://sg.linkedin.com/jobs/view/software-engineer-singpass-at-govtech-singapore-4436070851")
	match(t, tt, `^Software Engineer, Singpass\nGovTech Singapore`, "title and company kept")
	match(t, tt, `Requirements: Java or Go\.`)
	match(t, tt, `Employment type\nFull-time`, "the criteria block is part of the posting")
	for _, gone := range []string{"Join now", "Tailor my resume", "Show more", "Similar jobs", "Changi Airport", "Google Ads", "Referrals"} {
		ok(t, !strings.Contains(tt, gone), gone)
	}

	mcf := strings.Join([]string{
		"By continuing to browse our site you agree to our use of cookies.", "Close", "Log In",
		"The machine translation for this job description is powered by Microsoft Translator.",
		"ACTXA PTE. LTD.", "Software Engineering Intern - IN26009", "Internship/Attachment", "Requirements", "Currently pursuing a Bachelor's degree.",
		"See how you compare with other applicants", "Log in to view", "Add these skills if you have them", "Python",
		"More jobs from this company", "Log in to Apply", "Privacy Statement",
	}, "\n")
	m := trimPosting(mcf, "https://www.mycareersfuture.gov.sg/job/information-technology/software-engineering-intern-in26009-actxa-7ecd1263")
	match(t, m, `^ACTXA PTE\. LTD\.\nSoftware Engineering Intern`)
	match(t, m, `Currently pursuing a Bachelor's degree\.\nPython$`, "MyCareersFuture's skill tags stay")
	for _, gone := range []string{"cookies", "See how you compare", "Log in", "Privacy Statement"} {
		ok(t, !strings.Contains(m, gone), gone)
	}
	other := "Apply\nSimilar jobs\nSave"
	eq(t, trimPosting(other, "https://careers.example.com/job/1"), other, "other sites come back as they were")
	eq(t, trimPosting(other, ""), other, "pasted text without a link too")
	fromAPI := "Title\n\nRequirements\n• C++"
	eq(t, trimPosting(fromAPI, "https://www.mycareersfuture.gov.sg/job/x-1234"), fromAPI, "MyCareersFuture text from its API has no page around it")
}

func TestOffPeakWindows(t *testing.T) {
	cst := time.FixedZone("CST", 8*3600)
	bj := func(day, h, m int) time.Time { return time.Date(2026, 11, day, h, m, 0, 0, cst) }
	// Friday 13 November 2026.
	eq(t, isPeak(bj(13, 8, 59)), false)
	eq(t, isPeak(bj(13, 9, 0)), true)
	end, okk := peakEnds(bj(13, 10, 30))
	ok(t, okk && end.Equal(bj(13, 12, 0)))
	eq(t, isPeak(bj(13, 12, 30)), false, "lunch break")
	end, okk = peakEnds(bj(13, 17, 59))
	ok(t, okk && end.Equal(bj(13, 18, 0)))
	eq(t, isPeak(bj(13, 18, 0)), false)
	eq(t, isPeak(bj(14, 10, 0)), false, "Saturday")
	_, okk = peakEnds(bj(13, 20, 0))
	eq(t, okk, false)
}

// bgQueue hooks are shared state: tests that replace them restore the no-op afterwards.
var queueMu sync.Mutex

func TestBatchWaitsForOffPeakAndAFreeSlot(t *testing.T) {
	queueMu.Lock()
	defer queueMu.Unlock()
	pushed := 0
	bgQueue.PushFn = func(Task) { pushed++ }
	defer func() { bgQueue.PushFn = func(Task) {}; bgQueue.SizeFn = nil }()
	ids := addJobs([]string{"https://example.com/batch/1", "https://example.com/batch/2"}, "", true).IDs
	a, b := ids[0], ids[1]
	jd := jsonStr(map[string]any{"title": "Intern", "keywords": []any{}})
	hold := func(id int64, extra P) {
		p := P{"busy": nil, "jd": jd, "stage": "parsed", "held": "tailor"}
		for k, v := range extra {
			p[k] = v
		}
		setJob(id, p)
	}
	cst := time.FixedZone("CST", 8*3600)
	peak := time.Date(2026, 11, 13, 10, 0, 0, 0, cst)
	off := time.Date(2026, 11, 13, 20, 0, 0, 0, cst)
	SaveSettings(map[string]any{"offPeakOnly": true, "llmMode": "deepseek", "apiKey": "sk-test"})
	defer SaveSettings(map[string]any{"apiKey": "", "offPeakOnly": false})
	hold(a, nil)
	hold(b, nil)
	pushed = 0

	pump(peak)
	eq(t, sv(getJob(a).Held), "tailor", "nothing starts at peak")
	eq(t, pushed, 0)

	bgQueue.SizeFn = func() int { return 2 }
	pump(off)
	eq(t, sv(getJob(a).Held), "tailor", "off-peak, but no free slot: still waits")
	bgQueue.SizeFn = func() int { return 0 }

	pump(off)
	ok(t, getJob(a).Held == nil)
	eq(t, sv(getJob(a).Busy), "tailoring")
	eq(t, pushed, 2, "both start off-peak")

	hold(a, nil)
	runNow([]int64{a})
	eq(t, sv(getJob(a).Busy), "tailoring", "现在就跑 skips the wait whatever the time")

	hold(b, P{"stage": "skipped"})
	pump(peak)
	ok(t, getJob(b).Held == nil, "a skipped job stops waiting")

	hold(b, nil)
	SaveSettings(map[string]any{"offPeakOnly": false})
	pump(peak)
	ok(t, getJob(b).Held == nil, "turning the setting off starts what was waiting")
	eq(t, sv(getJob(b).Busy), "tailoring")

	hold(a, P{"busy": nil})
	setNoBalance(strp("¥-0.06"))
	pump(off)
	eq(t, sv(getJob(a).Held), "tailor", "an empty balance keeps it waiting instead of failing it")
	setNoBalance(nil)
	pump(off)
	ok(t, getJob(a).Held == nil)
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func respond(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}

func withHTTP(t *testing.T, f roundTrip) {
	old := httpClient
	httpClient = &http.Client{Transport: f}
	t.Cleanup(func() { httpClient = old })
}

func TestCostsAndEmptyBalance(t *testing.T) {
	queueMu.Lock()
	defer queueMu.Unlock()
	row := UsageRow{PromptTokens: 1_000_000, CacheHitTokens: 500_000, CompletionTokens: 100_000}
	// Friday 13 November 2026, UTC: 02:00 is 10:00 in Beijing (peak), 12:00 is 20:00 (off-peak).
	row.Ts = "2026-11-13 02:00:00"
	eq(t, fixed(callRmb(row), 2), fixed(0.5*2+0.5*0.04+0.1*8, 2))
	row.Ts = "2026-11-13 12:00:00"
	eq(t, fixed(callRmb(row), 2), fixed(0.5*1+0.5*0.02+0.1*4, 2))

	withHTTP(t, func(*http.Request) (*http.Response, error) {
		return respond(402, `{"error":{"message":"Insufficient Balance"}}`), nil
	})
	SaveSettings(map[string]any{"apiKey": "sk-test", "llmMode": "deepseek"})
	defer func() {
		setNoBalance(nil)
		SaveSettings(map[string]any{"apiKey": ""})
	}()
	setNoBalance(nil)
	eq(t, llmReady().OK, true)
	_, _, err := chat(ChatOpts{Messages: []Message{textMsg("user", "hi")}})
	ok(t, err != nil && strings.Contains(err.Error(), "402"), fmt.Sprint(err))
	r := llmReady()
	ok(t, !r.OK && r.Code == "no_balance", "a 402 marks the balance as used up")

	id := addJobs(nil, strings.Repeat("Data Analyst at Example. SQL and Python required. ", 3), false).IDs[0]
	calls := 0
	withHTTP(t, func(*http.Request) (*http.Response, error) { calls++; return respond(500, "{}"), nil })
	err = parseJob(id)
	ok(t, err != nil && strings.Contains(err.Error(), "余额不足"), fmt.Sprint(err))
	eq(t, calls, 0, "no call is made while the balance is empty")
	ok(t, getJob(id).JD == nil)
}

func field(id, label, value string) El {
	return El{ID: id, Kind: "text", Label: label, Value: value, InForm: true}
}

func TestDeltaSnapshots(t *testing.T) {
	page := func(els []El, excerpt string) Obs {
		return Obs{URL: "https://jobs.example.com/apply", Title: "Apply", Errors: []string{}, Elements: els, Excerpt: excerpt}
	}
	const ex = "Apply to Acme\nPersonal details"
	many := []El{}
	for i := range 20 {
		many = append(many, field(fmt.Sprintf("f0_%d", i+10), fmt.Sprintf("Question %d", i+1), ""))
	}
	next := button("Next")
	next.ID = "f0_3"
	mk := func(first string, value string) []El {
		return append([]El{field("f0_1", first, value), field("f0_2", "Phone", ""), next}, many...)
	}
	before := page(mk("First name", ""), ex)
	after := page(mk("First name", "Ada"), ex)

	d := formatDelta(before, after, 3, 4)
	ok(t, d != "", "values changed, layout did not")
	match(t, d, `^STEP 4 — same page and elements as the STEP 3 snapshot`)
	match(t, d, `\[f0_1\] text "First name" = "Ada"`)
	ok(t, !strings.Contains(d, "Phone") && !strings.Contains(d, "Question 1"), "unchanged elements are not repeated")
	match(t, d, `Visible text: unchanged\.`)
	ok(t, u16len(d) < u16len(formatObs(after, 4))/3, "much smaller than the full snapshot")

	eq(t, formatDelta(before, page(mk("Given name", "Ada"), ex), 3, 4), "", "a changed label means a full snapshot")
	moved := after
	moved.URL = "https://jobs.example.com/apply/step-2"
	eq(t, formatDelta(before, moved, 3, 4), "", "another URL means a full snapshot")
	all := []El{}
	for _, e := range before.Elements {
		if e.Kind == "text" {
			e.Value = "x"
		}
		all = append(all, e)
	}
	eq(t, formatDelta(before, page(all, ex), 3, 4), "", "when nearly everything changed, the full snapshot is not much bigger")

	withError := after
	withError.Errors = []string{"Phone is required"}
	withError.Excerpt = "Apply to Acme\nPhone is required"
	e := formatDelta(before, withError, 3, 4)
	match(t, e, `Errors/alerts on page now: "Phone is required"`)
	match(t, e, `Visible text \(start\), now:\nApply to Acme\nPhone is required`)
}

func TestReReadingSamePostingReusesTheReading(t *testing.T) {
	queueMu.Lock()
	defer queueMu.Unlock()
	calls := 0
	content := jsonStr(map[string]any{"title": "Software Intern", "company": "Acme", "location": "Singapore", "summary": "", "requirements": []any{"Python"}, "niceToHave": []any{}, "keywords": []any{"Python"}, "language": "en", "closed": false, "facts": nil, "fit": nil})
	withHTTP(t, func(*http.Request) (*http.Response, error) {
		calls++
		return respond(200, jsonStr(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}, "usage": map[string]any{"prompt_tokens": 100, "completion_tokens": 20}})), nil
	})
	SaveSettings(map[string]any{"apiKey": "sk-test", "llmMode": "deepseek"})
	defer SaveSettings(map[string]any{"apiKey": ""})
	setNoBalance(nil)
	id := addJobs(nil, strings.Repeat("Software Intern at Acme. Requirements: Python, SQL. Apply by December. ", 3), false).IDs[0]
	setJob(id, P{"busy": nil})
	if err := parseJob(id); err != nil {
		t.Fatal(err)
	}
	eq(t, calls, 1)
	eq(t, sv(getJob(id).Title), "Software Intern")
	if err := parseJob(id); err != nil {
		t.Fatal(err)
	}
	eq(t, calls, 1, "nothing changed: the saved reading is reused")
	setJob(id, P{"jd_text": sv(getJob(id).JDText) + " Java is a plus."})
	if err := parseJob(id); err != nil {
		t.Fatal(err)
	}
	eq(t, calls, 2, "a changed posting is read again")
}

// ---- Go-only checks of the HTTP layer

func TestGuardRejectsForeignHostsAndOrigins(t *testing.T) {
	h := guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	try := func(method, host, origin string) int {
		r, _ := http.NewRequest(method, "http://"+host+"/api/state", nil)
		r.Host = host
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := &recorder{header: http.Header{}}
		h.ServeHTTP(w, r)
		return w.code
	}
	eq(t, try("GET", "127.0.0.1:8791", ""), 204)
	eq(t, try("GET", "localhost:5191", ""), 204)
	eq(t, try("GET", "[::1]:8791", ""), 204)
	eq(t, try("GET", "evil.example:8791", ""), 403, "DNS rebinding")
	eq(t, try("POST", "127.0.0.1:8791", "http://localhost:5191"), 204)
	eq(t, try("POST", "127.0.0.1:8791", "http://[::1]:5191"), 204)
	eq(t, try("POST", "127.0.0.1:8791", "https://evil.example"), 403, "cross-site write")
	eq(t, try("POST", "127.0.0.1:8791", "null"), 403)
	eq(t, try("GET", "127.0.0.1:8791", "https://evil.example"), 204, "reads are not origin-checked")
}

type recorder struct {
	header http.Header
	code   int
}

func (r *recorder) Header() http.Header         { return r.header }
func (r *recorder) Write(b []byte) (int, error) { return len(b), nil }
func (r *recorder) WriteHeader(code int)        { r.code = code }

func TestCSVCells(t *testing.T) {
	eq(t, csvCell("plain"), "plain")
	eq(t, csvCell(`a,b`), `"a,b"`)
	eq(t, csvCell(`say "hi"`), `"say ""hi"""`)
	eq(t, csvCell("two\nlines"), "\"two\nlines\"")
}
