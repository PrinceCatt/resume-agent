// Job intake: read the posting (headless first, the signed-in window if the page needs it),
// then pull out title, company, requirements and keywords.
package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

type JobJd struct {
	Title    string `json:"title"`
	Company  string `json:"company"`
	Location string `json:"location"`
	// Two or three sentences in Chinese, for the list view.
	Summary      string   `json:"summary"`
	Requirements []string `json:"requirements"`
	NiceToHave   []string `json:"niceToHave"`
	Keywords     []string `json:"keywords"`
	Language     string   `json:"language"`
	Closed       bool     `json:"closed"`
	// How well the profile meets the posting, judged when the job is read.
	Fit *Fit `json:"fit"`
	// The posting's conditions as fields, for filtering and statistics. null on jobs read before 2026-11-13.
	Facts *JobFacts `json:"facts"`
	// Fingerprint of everything the model read (prompt, profile, posting, model), so re-reading an unchanged job costs nothing.
	Src string `json:"src,omitempty"`
}

var Materials = []string{"cover_letter", "transcript", "portfolio", "references", "other"}

// JobFacts holds only what the posting states; "" / null / [] when it does not say.
type JobFacts struct {
	Type           string   `json:"type"`
	Hours          string   `json:"hours"`
	Months         *float64 `json:"months"`
	Start          string   `json:"start"`
	MinYears       *float64 `json:"minYears"`
	Degree         string   `json:"degree"`
	Student        string   `json:"student"`
	WorkAuth       string   `json:"workAuth"`
	Salary         string   `json:"salary"`
	Materials      []string `json:"materials"`
	CoverLetterAsk string   `json:"coverLetterAsk"`
	Workplace      string   `json:"workplace"`
}

// Fit: unsupported = tools a strength names that the profile never mentions (the score may be inflated);
// conflict = a clear clash with what the candidate is looking for; it caps the score.
type Fit struct {
	Score       float64  `json:"score"`
	Verdict     string   `json:"verdict"`
	Strengths   []string `json:"strengths"`
	Gaps        []string `json:"gaps"`
	Unsupported []string `json:"unsupported,omitzero"`
	Conflict    string   `json:"conflict,omitempty"`
}

const FitConflictCap = 45

var ProgressKinds = []string{"applied", "screening", "interview", "offer", "rejected", "withdrawn"}

// asksCoverLetter: the posting asks for a cover letter.
func asksCoverLetter(jd *JobJd) bool {
	return jd != nil && jd.Facts != nil && contains(jd.Facts.Materials, "cover_letter")
}

// Job is a row of the jobs table.
type Job struct {
	ID          int64
	URL         string
	Title       *string
	Company     *string
	Location    *string
	Stage       string // new | parsed | tailored | applied | skipped
	Busy        *string
	Error       *string
	JDText      *string
	JD          *string
	Tailored    *string
	CoverLetter *string
	ResumeFile  *string
	CoverFile   *string
	AutoApply   int64
	Progress    *string
	ProgressAt  *string
	AppliedAt   *string
	Notes       *string
	Notice      *string
	Prep        *string
	Drafts      *string
	Held        *string // tailor | apply
	CreatedAt   string
	UpdatedAt   string
}

func sv(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func jobFromRow(m map[string]any) *Job {
	return &Job{
		ID: asInt(m["id"]), URL: jsString(m["url"]), Title: asStrPtr(m["title"]), Company: asStrPtr(m["company"]),
		Location: asStrPtr(m["location"]), Stage: jsString(m["stage"]), Busy: asStrPtr(m["busy"]), Error: asStrPtr(m["error"]),
		JDText: asStrPtr(m["jd_text"]), JD: asStrPtr(m["jd"]), Tailored: asStrPtr(m["tailored"]), CoverLetter: asStrPtr(m["cover_letter"]),
		ResumeFile: asStrPtr(m["resume_file"]), CoverFile: asStrPtr(m["cover_file"]), AutoApply: asInt(m["auto_apply"]),
		Progress: asStrPtr(m["progress"]), ProgressAt: asStrPtr(m["progress_at"]), AppliedAt: asStrPtr(m["applied_at"]),
		Notes: asStrPtr(m["notes"]), Notice: asStrPtr(m["notice"]), Prep: asStrPtr(m["prep"]), Drafts: asStrPtr(m["drafts"]),
		Held: asStrPtr(m["held"]), CreatedAt: jsString(m["created_at"]), UpdatedAt: jsString(m["updated_at"]),
	}
}

// bgQueue reads job pages and tailors, two at a time.
var bgQueue = newQueue(func() int { return 2 })

func getJob(id int64) *Job {
	m := queryMap("SELECT * FROM jobs WHERE id = ?", id)
	if m == nil {
		return nil
	}
	return jobFromRow(m)
}

func listJobs() []*Job {
	out := []*Job{}
	for _, m := range queryMaps("SELECT * FROM jobs ORDER BY id DESC") {
		out = append(out, jobFromRow(m))
	}
	return out
}

// P is a column patch: values are string, int/int64 or nil (NULL).
type P map[string]any

var reColumn = regexp.MustCompile(`^[a-z_]+$`)

func setJob(id int64, patch P) {
	_, hasProgress := patch["progress"]
	var cur *Job
	if patch["stage"] == "applied" || hasProgress {
		cur = getJob(id)
	}
	if cur != nil && patch["stage"] == "applied" {
		// The first time a job counts as applied starts its follow-up tracking.
		if _, ok := patch["applied_at"]; cur.AppliedAt == nil && !ok {
			patch["applied_at"] = sqlNow()
		}
		if _, ok := patch["progress"]; cur.Progress == nil && !ok {
			patch["progress"] = "applied"
			patch["progress_at"] = sqlNow()
		}
	}
	if len(patch) == 0 {
		return
	}
	keys := make([]string, 0, len(patch))
	for k := range patch {
		if !reColumn.MatchString(k) {
			panic(fmt.Sprintf("bad column %q", k))
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	sets := make([]string, len(keys))
	args := make([]any, 0, len(keys)+1)
	for i, k := range keys {
		sets[i] = k + " = ?"
		args = append(args, patch[k])
	}
	args = append(args, id)
	mustExec("UPDATE jobs SET "+strings.Join(sets, ", ")+", updated_at = datetime('now') WHERE id = ?", args...)
	if p, ok := patch["progress"].(string); ok && cur != nil && p != sv(cur.Progress) {
		logp := func(prog, ts string) {
			mustExec("INSERT INTO progress_log (job_id, progress, ts) VALUES (?, ?, ?)", id, prog, ts)
		}
		if queryMap("SELECT 1 AS x FROM progress_log WHERE job_id = ?", id) == nil {
			// Every history starts with "applied": a job applied before the log existed gets it (and where it
			// stood) dated from the job; one marked straight as "test" or "interview" gets it now.
			if cur.Progress != nil {
				logp("applied", firstNonEmpty(sv(cur.AppliedAt), cur.UpdatedAt))
				if *cur.Progress != "applied" {
					logp(*cur.Progress, firstNonEmpty(sv(cur.ProgressAt), cur.UpdatedAt))
				}
			} else if p != "applied" {
				at, _ := patch["applied_at"].(string)
				logp("applied", firstNonEmpty(at, sv(cur.AppliedAt), sqlNow()))
			}
		}
		at, _ := patch["progress_at"].(string)
		logp(p, firstNonEmpty(at, sqlNow()))
	}
	emit("job", id)
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}

// progressReached is how far a job got after applying, from its log plus its current progress.
func progressReached(jobID int64, current string) map[string]bool {
	seen := map[string]bool{}
	for _, p := range queryStrings("SELECT progress FROM progress_log WHERE job_id = ?", jobID) {
		seen[p] = true
	}
	if current != "" {
		seen[current] = true
	}
	return seen
}

type ProgressEntry struct {
	Progress string `json:"progress"`
	Ts       string `json:"ts"`
}

func progressLog(jobID int64) []ProgressEntry {
	out := []ProgressEntry{}
	for _, m := range queryMaps("SELECT progress, ts FROM progress_log WHERE job_id = ? ORDER BY ts, id", jobID) {
		out = append(out, ProgressEntry{jsString(m["progress"]), jsString(m["ts"])})
	}
	return out
}

// daysSinceSQL is the days since a stored UTC time (false when it cannot be read).
func daysSinceSQL(t string) (float64, bool) {
	d, ok := utcOf(t)
	if !ok {
		return 0, false
	}
	return float64(time.Since(d).Milliseconds()) / 86_400_000, true
}

// afterParse hands a freshly read job to the pipeline (set by the server, so jobs.go needs no tailor/agent import).
var afterParse func(id int64)

var (
	reHTTP       = regexp.MustCompile(`(?i)^https?://`)
	reTrackParam = regexp.MustCompile(`(?i)^(utm_|ref$|refid$|trk|trackingid$|src$|source$|gh_src$|lever-(source|origin)|fbclid$|gclid$|mc_|_hs|origin$)`)
)

// normalizeURL reduces a link to what identifies the posting: no tracking parameters, fragment, www or trailing slash.
func normalizeURL(raw string) string {
	t := jsTrim(raw)
	full := t
	if !reHTTP.MatchString(t) {
		full = "https://" + t
	}
	u, err := url.Parse(full)
	if err != nil || u.Host == "" || strings.ContainsAny(u.Hostname(), " <>\"{}|\\^`") {
		return strings.ToLower(t)
	}
	type kv struct{ k, v string }
	params := []kv{}
	if u.RawQuery != "" {
		for _, part := range strings.Split(u.RawQuery, "&") {
			if part == "" {
				continue
			}
			k, v, _ := strings.Cut(part, "=")
			params = append(params, kv{formDecode(k), formDecode(v)})
		}
	}
	kept := []kv{}
	for _, p := range params {
		if !reTrackParam.MatchString(p.k) {
			kept = append(kept, p)
		}
	}
	sort.SliceStable(kept, func(i, j int) bool { return u16Less(kept[i].k, kept[j].k) })
	q := make([]string, len(kept))
	for i, p := range kept {
		q[i] = formEncode(p.k) + "=" + formEncode(p.v)
	}
	host := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	path = strings.TrimRight(path, "/")
	out := host + path
	if len(q) > 0 {
		out += "?" + strings.Join(q, "&")
	}
	return out
}

// formDecode / formEncode are application/x-www-form-urlencoded as URLSearchParams does it.
func formDecode(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			b.WriteByte(unhex(s[i+1])<<4 | unhex(s[i+2]))
			i += 2
			continue
		}
		b.WriteByte(s[i])
	}
	return validUTF8(b.String())
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

func unhex(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	}
	return c - 'A' + 10
}

func formEncode(s string) string {
	const hexd = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '*' || c == '-' || c == '.' || c == '_':
			b.WriteByte(c)
		case c == ' ':
			b.WriteByte('+')
		default:
			b.WriteByte('%')
			b.WriteByte(hexd[c>>4])
			b.WriteByte(hexd[c&15])
		}
	}
	return b.String()
}

type Duplicate struct {
	URL string `json:"url"`
	ID  int64  `json:"id"`
}

type AddResult struct {
	IDs        []int64     `json:"ids"`
	Duplicates []Duplicate `json:"duplicates"`
}

func addJobs(urls []string, jdText string, autoApply bool) AddResult {
	res := AddResult{IDs: []int64{}, Duplicates: []Duplicate{}}
	known := map[string]int64{}
	for _, m := range queryMaps("SELECT id, url FROM jobs WHERE url != ''") {
		known[normalizeURL(jsString(m["url"]))] = asInt(m["id"])
	}
	clean := []string{}
	for _, u := range urls {
		if t := jsTrim(u); t != "" {
			clean = append(clean, t)
		}
	}
	auto := 0
	if autoApply {
		auto = 1
	}
	for _, raw := range clean {
		u := raw
		if !reHTTP.MatchString(raw) {
			u = "https://" + raw
		}
		key := normalizeURL(u)
		if dup, ok := known[key]; ok {
			seen := false
			for _, d := range res.Duplicates {
				if d.ID == dup {
					seen = true
				}
			}
			if !seen {
				res.Duplicates = append(res.Duplicates, Duplicate{u, dup})
			}
			continue
		}
		var text any
		if len(clean) == 1 && jdText != "" {
			text = jdText
		}
		_, id := mustExec("INSERT INTO jobs (url, jd_text, auto_apply) VALUES (?, ?, ?)", u, text, auto)
		res.IDs = append(res.IDs, id)
		known[key] = id
		queueParse(id)
	}
	if len(clean) == 0 && jdText != "" {
		_, id := mustExec("INSERT INTO jobs (url, jd_text, auto_apply) VALUES ('', ?, 0)", jdText)
		res.IDs = append(res.IDs, id)
		queueParse(id)
	}
	emit("job")
	return res
}

func queueParse(id int64) {
	setJob(id, P{"busy": "parsing", "error": nil, "notice": nil})
	bgQueue.Push(func() {
		err := catch(func() error { return parseJob(id) })
		if err != nil {
			setJob(id, P{"busy": nil, "error": err.Error()})
			return
		}
		// Only the first read hands off to tailoring and applying. Re-reading a posting refreshes it and
		// the fit; before this check it re-tailored and started a second application on a submitted job.
		j := getJob(id)
		if j != nil && j.AutoApply != 0 && j.Stage != "applied" && queryMap("SELECT 1 AS x FROM runs WHERE job_id = ?", id) == nil && afterParse != nil {
			afterParse(id)
		}
	})
}

// catch runs f and turns a panic into an error (the TS code's try/catch around everything a task does).
func catch(f func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			switch x := r.(type) {
			case error:
				err = x
			default:
				err = fmt.Errorf("%v", x)
			}
		}
	}()
	return f()
}

var reLoginWall = jsRe(`sign in to (view|see|continue)|log in to (view|continue)|join now to see|登录后查看|请先登录|扫码登录`, "i")

type pageText struct {
	Title string
	Text  string
}

var reManyBlank = regexp.MustCompile(`\n{3,}`)

func readPage(p *Page) pageText {
	_ = p.WaitDOMContentLoaded(30 * time.Second)
	// Wait until the text stops growing: single-page sites (MyCareersFuture) fill the posting in after
	// load, and a fixed 2.5 s caught only its header.
	last := -1
	for i := 0; i < 12; i++ {
		if i == 0 {
			time.Sleep(1500 * time.Millisecond)
		} else {
			time.Sleep(1000 * time.Millisecond)
		}
		var n int
		if err := p.Eval(`document.body?.innerText.length ?? 0`, &n); err != nil {
			n = 0
		}
		if n == last && n > 600 {
			break
		}
		last = n
	}
	parts := []string{}
	for _, f := range p.Frames() {
		var t string
		if err := p.EvalIn(f.ID, `(document.body?.innerText ?? "").trim()`, &t); err != nil {
			continue // detached or cross-process frame
		}
		if u16len(t) > 40 {
			parts = append(parts, t)
		}
	}
	title := p.Title()
	return pageText{Title: title, Text: u16slice(reManyBlank.ReplaceAllString(strings.Join(parts, "\n\n"), "\n\n"), 24_000)}
}

func fetchPostingText(u string) (pageText, error) {
	if mcf := mcfPostingText(u); mcf != nil {
		return *mcf, nil
	}
	site := siteFor(u)
	// JobStreet, Glassdoor and Indeed show a headless browser a bot check, so they go straight to the
	// assistant's own window, where you are signed in.
	if site == nil || !site.VisibleOnly {
		got := pageText{}
		if b, err := getHeadless(); err == nil {
			if page, err := b.NewPage(pageOpts{locale: "en-US"}); err == nil {
				if err := page.Goto(u, 45*time.Second); err == nil {
					got = readPage(page)
				}
				page.Close()
			}
		}
		if u16len(got.Text) >= 600 && !reLoginWall.MatchString(u16slice(got.Text, 3000)) && !isCheckPage(got.Title, got.Text) {
			return got, nil
		}
	}
	// Sites that need a signed-in session: read it in a tab of your own browser (where you're signed in).
	vis, err := newVisiblePage(u)
	if err != nil {
		return pageText{}, err
	}
	keep := false
	defer func() {
		if keep {
			vis.BringToFront()
		} else {
			vis.Close()
		}
	}()
	got := readPage(vis)
	name := "这个网站"
	if site != nil {
		name = site.Name
	}
	// Never save a check page or a sign-in wall as the posting. The tab stays open for you to deal with.
	if isCheckPage(got.Title, got.Text) {
		keep = true
		return pageText{}, errors.New(name + "打开时出现了人机验证：浏览器里已经开着这个岗位的标签页，你自己过一下验证，再点「重新读取岗位」。")
	}
	if reLoginWall.MatchString(u16slice(got.Text, 3000)) {
		keep = true
		return pageText{}, errors.New(name + "要先登录才能看：在浏览器里开着的那个标签页上登录后，再点「重新读取岗位」。")
	}
	return got, nil
}

var extractSystem = `You read job postings. Return JSON with exactly these keys:
{"title": string, "company": string, "location": string,
 "summary": string (2-3 sentences in Simplified Chinese: what the role does and who it wants),
 "requirements": string[] (must-haves, short, in the posting's language),
 "niceToHave": string[],
 "keywords": string[] (8-20 concrete skills/tools/domains a recruiter or ATS would scan for, as written in the posting),
 "language": "en" | "zh" (language of the posting),
 "closed": boolean (true only if the page says the job is closed / no longer accepting applications),
 "facts": {"type": "fulltime"|"parttime"|"internship"|"contract"|"unknown",
   "hours": "full"|"part"|"" (internships and contracts: full-time or part-time hours, e.g. "at least 4 days a week" is full; "" if not stated),
   "months": number|null (internship or contract length in months),
   "start": string (start date as written, "" if not stated),
   "minYears": number|null (minimum years of work experience required; 0 if it says no experience needed or fresh graduates welcome; null if not stated),
   "degree": "none"|"diploma"|"bachelor"|"master"|"phd"|"" (minimum education required),
   "student": "enrolled"|"graduated"|"" ("enrolled" if applicants must be current students; "graduated" if they must already hold the qualification, e.g. "graduated within the last 2 years", "2024-2026 graduates"),
   "workAuth": "citizen"|"citizen_pr"|"" (open only to Singapore citizens / only to citizens and PRs; "" if not restricted),
   "salary": string (as written, "" if none),
   "materials": array of "cover_letter"|"transcript"|"portfolio"|"references"|"other" (documents applicants are asked to send besides the resume/CV; [] if none mentioned),
   "coverLetterAsk": string (what the posting wants the cover letter to address, in the posting's language; "" if nothing specific),
   "workplace": "onsite"|"hybrid"|"remote"|""},
 "fit": {"score": integer 0-100, "verdict": string, "strengths": string[], "gaps": string[], "conflict": "fulltime_internship"|"start_date"|"graduates_only"|"work_auth"|""} | null}
"facts" come only from the posting text: never guess; use ""/null/[] when it does not say.
"fit" compares the posting with CANDIDATE. Be strict and honest, like a recruiter screening: score how well the candidate meets the MUST-haves (level, years of experience, degree, required skills, work authorization if stated); nice-to-haves only move it a little. A student applying to a role that requires several years of experience scores low. verdict: one sentence in Simplified Chinese on whether it is worth applying. strengths/gaps: up to 4 short points each in Simplified Chinese, citing concrete items from the posting and the candidate. A strength may only name skills, tools and experience written in CANDIDATE; something the posting wants that CANDIDATE does not mention is a gap, never a strength, and it must not raise the score. Use null if there is no candidate profile.
When CANDIDATE includes WHAT THE CANDIDATE IS LOOKING FOR, also check the posting against it, and judge internships and full-time jobs separately:
- Internship: if the candidate wants part-time internships, an internship with full-time hours (full-time, 5 days a week, 40 hours) is a clear conflict however well the dates fit: it goes first in gaps, the verdict must not call it a match with what they want, and the score is 45 or lower. An internship for enrolled students that starts after their graduation date is a conflict too. If the hours are not stated, say in gaps that the hours need checking, without lowering the score much.
- Full-time job: one they would start after graduating. Graduating later is not a conflict unless the posting states a start date before the graduation date or requires the degree to be completed already. A wish for part-time internships is about internships only and never lowers a full-time job's score.
Other clear conflicts (a STATED start date before they can start, a role only for people who have already graduated) also go first in gaps and lower the score a lot. Something the posting does not state is not a conflict.
"conflict": the kind of clear conflict, or "" if none. Only these count: "fulltime_internship" (an internship whose posting states full-time hours, when the candidate wants part-time internships), "start_date" (a start date the posting STATES that the candidate cannot meet: before they can start, or after their graduation for an internship that needs enrolled students), "graduates_only" (only for people who already hold the qualification), "work_auth" (limited to citizens or PR and CANDIDATE is neither). Still studying and graduating later is never a conflict for a full-time job. A conflict caps the score at ` + fmt.Sprint(FitConflictCap) + `.
If the text is not a job posting, return title "", fit null, and explain in summary.`

// Saved answers that say what the candidate is after, given to the fit check. Before this, a
// 6-month full-time internship scored 82 for someone looking for full-time jobs and part-time
// internships, because the score only saw skills.
var prefIDs = []string{"qa_jobtype", "qa_grad", "qa_start", "qa_dur", "qa_auth", "qa_visa"}

func searchPrefs(p Profile) string {
	lines := []string{}
	for _, id := range prefIDs {
		for _, a := range p.Answers {
			if a.ID == id {
				if jsTrim(a.A) != "" {
					lines = append(lines, "- "+a.Q+": "+jsTrim(a.A))
				}
				break
			}
		}
	}
	if len(lines) == 0 {
		return ""
	}
	return "WHAT THE CANDIDATE IS LOOKING FOR\n" + strings.Join(lines, "\n")
}

// Job sites print far more than the posting. LinkedIn's signed-out page wraps a 2,000–5,000 character posting in
// sign-in chrome, "Similar jobs" and "People also viewed": stored, it was 24,000 characters, and reading postings was
// three quarters of the DeepSeek bill (2026-11-13). MyCareersFuture's old page dumps carry a cookie banner and footer.
var (
	reLinkedinTail  = jsRe(`^(?:Referrals increase your chances\b.*|Get notified about new .*|Sign in to create job alert|Similar jobs|Show more jobs like this|People also viewed|Similar Searches|Explore top content on LinkedIn.*|Looking for a job\?)\s*$`, "m")
	reLinkedinNoise = jsRe(`^(?:Skip to main content|LinkedIn|Jobs|Clear text|Sign in|Join now|Apply|Save|Show more|Show less|See who you know|Report this job|Use AI to assess how you fit|Get AI-powered advice on this job and more exclusive features\.|Am I a good fit for this job\?|Tailor my resume|See who .+ has hired for this role|Direct message the job poster from .+)$`, "")
	mcfHead         = "The machine translation for this job description is powered by Microsoft Translator."
	reMcfTail       = jsRe(`^(?:More jobs from this company|Log in to Apply|A collaboration between)\s*$`, "m")
	reMcfNoise      = jsRe(`^(?:See how you compare with other applicants|Log in to view|Tell employers what skills you have|The more skills you have, the better your job match\.|\d+% skills matched|Add these skills if you have them|Report issue|BETA|NEW!)$`, "")
	reLinkedinHost  = regexp.MustCompile(`(^|\.)linkedin\.com$`)
	reMcfHost       = regexp.MustCompile(`(^|\.)mycareersfuture\.gov\.sg$`)
	reTrailingBlank = regexp.MustCompile(`[ \t]+\n`)
)

// trimPosting returns the posting without the site around it, so the model is paid to read the posting only.
// Other sites' text comes back as it was.
func trimPosting(text, rawURL string) string {
	host := ""
	if u, err := url.Parse(rawURL); err == nil && u.Scheme != "" {
		host = strings.ToLower(u.Hostname())
	}
	cut := func(t string, tail, noise *regexp.Regexp) string {
		if loc := tail.FindStringIndex(t); loc != nil && loc[0] > 0 {
			t = t[:loc[0]]
		}
		lines := []string{}
		for _, l := range strings.Split(t, "\n") {
			if !noise.MatchString(jsTrim(l)) {
				lines = append(lines, l)
			}
		}
		return strings.Join(lines, "\n")
	}
	t := text
	switch {
	case reLinkedinHost.MatchString(host):
		t = cut(t, reLinkedinTail, reLinkedinNoise)
	case reMcfHost.MatchString(host) && strings.Contains(t, mcfHead):
		t = cut(t[strings.Index(t, mcfHead)+len(mcfHead):], reMcfTail, reMcfNoise)
	default:
		return text
	}
	return jsTrim(reManyBlank.ReplaceAllString(reTrailingBlank.ReplaceAllString(t, "\n"), "\n\n"))
}

func parseJob(id int64) error {
	job := getJob(id)
	if job == nil {
		return nil
	}
	if ready := llmReady(); !ready.OK {
		return errors.New(ready.Reason)
	}
	text := sv(job.JDText)
	pageTitle := ""
	if text == "" && job.URL != "" {
		got, err := fetchPostingText(job.URL)
		if err != nil {
			return err
		}
		text = got.Text
		pageTitle = got.Title
	}
	// Stored as trimmed too, so tailoring and interview prep read the same short text.
	text = trimPosting(text, job.URL)
	if u16len(jsTrim(text)) < 80 {
		return errors.New("没读到岗位内容：页面可能要登录，在你的浏览器里登录该网站后再点「重新读取岗位」，或直接粘贴 JD 文本。")
	}

	profile := getProfile()
	prefs := searchPrefs(profile)
	candidate := "(no profile yet)"
	if len(profile.Sections) > 0 {
		facts := profile.ExtraFacts
		if facts == "" {
			facts = "(none)"
		}
		candidate = profileForPrompt(profile, false) + "\n\nEXTRA FACTS\n" + facts
		if prefs != "" {
			candidate += "\n\n" + prefs
		}
	}
	// CANDIDATE goes first: it is the same for every job, so after the first read DeepSeek serves the system
	// prompt and the profile from its cache (billed at about a tenth) and only the posting is new.
	input := "CANDIDATE\n" + candidate + "\n\nURL: " + job.URL + "\nPage title: " + pageTitle + "\n\nPOSTING\n" + u16slice(text, 12_000)
	sum := sha256.Sum256([]byte(GetSettings().Model + "\n" + extractSystem + "\n" + input))
	src := hex.EncodeToString(sum[:])[:20]
	prev := jobJd(job)
	var jd *JobJd
	reused := false
	switch {
	case isDemo():
		jd = mockExtractJob(text, job.URL, pageTitle)
		if len(profile.Sections) > 0 {
			f := mockFit(jd, profile)
			jd.Fit = &f
		}
	case prev != nil && prev.Src == src:
		// Re-reading a job whose posting, profile and prompt are all unchanged would pay for the same answer
		// again (three bulk re-reads were most of the 2026-11-13 bill). Its checks already ran on the same profile.
		jd = prev
		reused = true
	default:
		raw, err := chatJSON(extractSystem, input, 4096, &UsageTag{JobID: id, Kind: "parse"})
		if err != nil {
			return err
		}
		jd = normalizeJd(raw)
		jd.Src = src
	}
	if !reused {
		if jd.Fit != nil && len(profile.Sections) > 0 {
			f := checkFit(*jd.Fit, profileText(profile), jd.Keywords)
			jd.Fit = &f
		}
		jd.Fit = capForPrefs(jd.Fit, jd.Facts, prefs)
	}

	stage := job.Stage
	if stage == "new" {
		stage = "parsed"
	}
	var errMsg any
	if jd.Closed {
		errMsg = "页面显示这个岗位已关闭"
	}
	setJob(id, P{
		"jd_text":  text,
		"jd":       jsonStr(jd),
		"title":    nullIfEmpty(firstNonEmpty(jd.Title, pageTitle)),
		"company":  nullIfEmpty(jd.Company),
		"location": nullIfEmpty(jd.Location),
		"stage":    stage,
		"busy":     nil,
		"error":    errMsg,
	})
	return nil
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func normalizeJd(raw any) *JobJd {
	s := func(v any) string {
		if x, ok := v.(string); ok {
			return jsTrim(x)
		}
		return ""
	}
	a := func(v any) []string {
		out := []string{}
		for _, e := range arr(v) {
			if t := s(e); t != "" {
				out = append(out, t)
			}
		}
		return out
	}
	kw := uniq(a(get(raw, "keywords")))
	if len(kw) > 25 {
		kw = kw[:25]
	}
	lang := "en"
	if get(raw, "language") == "zh" {
		lang = "zh"
	}
	facts := normalizeFacts(get(raw, "facts"))
	return &JobJd{
		Title:        s(get(raw, "title")),
		Company:      s(get(raw, "company")),
		Location:     s(get(raw, "location")),
		Summary:      s(get(raw, "summary")),
		Requirements: a(get(raw, "requirements")),
		NiceToHave:   a(get(raw, "niceToHave")),
		Keywords:     kw,
		Language:     lang,
		Closed:       get(raw, "closed") == true,
		Fit:          normalizeFit(get(raw, "fit"), has(obj(raw), "fit"), normalizeFacts(get(raw, "facts"))),
		Facts:        facts,
	}
}

func oneOf(v any, ok []string) string {
	if s, isStr := v.(string); isStr && contains(ok, s) {
		return s
	}
	return ""
}

// normalizeFacts keeps only known values: "" / null / [] for anything else.
func normalizeFacts(raw any) *JobFacts {
	var m map[string]any
	switch x := raw.(type) {
	case map[string]any:
		m = x
	case []any:
		m = map[string]any{}
	default:
		return nil
	}
	s := func(v any) string {
		if x, ok := v.(string); ok {
			return jsTrim(x)
		}
		return ""
	}
	num := func(k string, maxV float64) *float64 {
		v, present := m[k]
		var n float64
		switch x := v.(type) {
		case string:
			if jsTrim(x) == "" {
				return nil
			}
			n = jsNumber(x, true)
		case float64:
			n = x
		default:
			_ = present
			return nil
		}
		if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > maxV {
			return nil
		}
		r := jsRound(n*10) / 10
		return &r
	}
	typ := oneOf(m["type"], []string{"fulltime", "parttime", "internship", "contract", "unknown"})
	if typ == "" {
		typ = "unknown"
	}
	mats := []string{}
	for _, x := range arr(m["materials"]) {
		if s, ok := x.(string); ok && contains(Materials, s) && !contains(mats, s) {
			mats = append(mats, s)
		}
	}
	return &JobFacts{
		Type:           typ,
		Hours:          oneOf(m["hours"], []string{"full", "part"}),
		Months:         num("months", 60),
		Start:          u16slice(s(m["start"]), 60),
		MinYears:       num("minYears", 30),
		Degree:         oneOf(m["degree"], []string{"none", "diploma", "bachelor", "master", "phd"}),
		Student:        oneOf(m["student"], []string{"enrolled", "graduated"}),
		WorkAuth:       oneOf(m["workAuth"], []string{"citizen", "citizen_pr"}),
		Salary:         u16slice(s(m["salary"]), 80),
		Materials:      mats,
		CoverLetterAsk: u16slice(s(m["coverLetterAsk"]), 400),
		Workplace:      oneOf(m["workplace"], []string{"onsite", "hybrid", "remote"}),
	}
}

// conflicts are the clashes that cap a fit, each with the posting condition that must back it up.
var conflicts = map[string]struct {
	label  string
	backed func(f *JobFacts) bool
}{
	"fulltime_internship": {"全职实习，和你想找的兼职实习不符", func(f *JobFacts) bool { return f.Type == "internship" && f.Hours == "full" }},
	"start_date":          {"开始时间对不上你的时间", func(f *JobFacts) bool { return f.Start != "" }},
	"graduates_only":      {"只招已经毕业的", func(f *JobFacts) bool { return f.Student == "graduated" }},
	"work_auth":           {"只招公民 / PR", func(f *JobFacts) bool { return f.WorkAuth != "" }},
}

var (
	rePartTimeIntern = jsRe(`part[- ]?time intern|兼职实习`, "i")
	reFullTimeIntern = jsRe(`full[- ]?time intern|全职实习`, "i")
)

// wantsPartTimeInternsOnly: their wishes name part-time internships and do not also accept full-time ones.
func wantsPartTimeInternsOnly(prefs string) bool {
	return rePartTimeIntern.MatchString(prefs) && !reFullTimeIntern.MatchString(prefs)
}

// capForPrefs: a full-time internship for someone who wants part-time ones is a clash the posting's stated hours
// settle on their own; the model left it out on about a third of them (2026-11-13), so it is added here.
func capForPrefs(fit *Fit, facts *JobFacts, prefs string) *Fit {
	if fit == nil || fit.Conflict != "" || facts == nil || !wantsPartTimeInternsOnly(prefs) || !conflicts["fulltime_internship"].backed(facts) {
		return fit
	}
	out := *fit
	out.Conflict = conflicts["fulltime_internship"].label
	out.Score = math.Min(fit.Score, FitConflictCap)
	return &out
}

// normalizeFit: the model names a clash but does not always lower the score for it (a full-time internship scored 78
// for someone who wants part-time ones, 2026-11-13), so the cap is applied here. Asked for a free-text clash, it also
// made some up ("not graduated yet" on full-time jobs), so it picks a kind and the posting's own conditions
// (extracted in the same answer) must back it up.
func normalizeFit(raw any, present bool, facts *JobFacts) *Fit {
	m := obj(raw)
	if !truthy(raw) {
		return nil
	}
	sc, scPresent := m["score"]
	score := jsNumber(sc, scPresent)
	if math.IsNaN(score) || math.IsInf(score, 0) {
		return nil
	}
	a := func(v any) []string {
		out := []string{}
		for _, e := range arr(v) {
			if s, ok := e.(string); ok && jsTrim(s) != "" {
				out = append(out, jsTrim(s))
			}
		}
		if len(out) > 5 {
			out = out[:5]
		}
		return out
	}
	conflict := ""
	if c, ok := m["conflict"].(string); ok {
		if kind, ok := conflicts[jsTrim(c)]; ok && facts != nil && kind.backed(facts) {
			conflict = kind.label
		}
	}
	top := 100.0
	if conflict != "" {
		top = FitConflictCap
	}
	verdict := ""
	if v, ok := m["verdict"].(string); ok {
		verdict = jsTrim(v)
	}
	return &Fit{
		Score:     math.Max(0, math.Min(top, jsRound(score))),
		Verdict:   verdict,
		Strengths: a(m["strengths"]),
		Gaps:      a(m["gaps"]),
		Conflict:  conflict,
	}
}

// checkFit marks strengths that credit the candidate with a tool the profile never mentions.
func checkFit(fit Fit, profile string, keywords []string) Fit {
	unsupported := []string{}
	strengths := []string{}
	for _, st := range fit.Strengths {
		missing := unsupportedTerms(st, profile, keywords)
		for _, t := range missing {
			if !contains(unsupported, t) {
				unsupported = append(unsupported, t)
			}
		}
		if len(missing) > 0 {
			strengths = append(strengths, st+"（资料库里没找到："+strings.Join(missing, "、")+"）")
		} else {
			strengths = append(strengths, st)
		}
	}
	out := fit
	out.Strengths = strengths
	out.Unsupported = unsupported
	return out
}

func jobJd(job *Job) *JobJd {
	if job == nil || job.JD == nil || *job.JD == "" {
		return nil
	}
	var jd *JobJd
	if err := json.Unmarshal([]byte(*job.JD), &jd); err != nil || jd == nil {
		return nil
	}
	jd.Requirements = nonNil(jd.Requirements)
	jd.NiceToHave = nonNil(jd.NiceToHave)
	jd.Keywords = nonNil(jd.Keywords)
	if jd.Fit != nil {
		jd.Fit.Strengths = nonNil(jd.Fit.Strengths)
		jd.Fit.Gaps = nonNil(jd.Fit.Gaps)
	}
	if jd.Facts != nil {
		jd.Facts.Materials = nonNil(jd.Facts.Materials)
	}
	return jd
}
