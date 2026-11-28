// The application agent: looks at the page, asks the model what to do, does it, repeats.
// It never clicks a final submit on its own: it stops at request_submit and waits for you.
package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type ReviewField struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type pendingAsk struct {
	Kind     string `json:"kind"`
	Question string `json:"question"`
	Field    string `json:"field"`
}

type pendingManual struct {
	Kind   string `json:"kind"`
	Reason string `json:"reason"`
}

type pendingReview struct {
	Kind       string        `json:"kind"`
	Summary    string        `json:"summary"`
	Fields     []ReviewField `json:"fields"`
	Screenshot string        `json:"screenshot"`
	TargetText string        `json:"targetText"`
	URL        string        `json:"url"`
}

// UserReply: answer | resume | confirm | revise | cancel.
type UserReply struct {
	Type     string `json:"type"`
	Answer   string `json:"answer"`
	Remember bool   `json:"remember"`
	Feedback string `json:"feedback"`
}

type live struct {
	mu           sync.Mutex
	page         *Page
	broughtFront bool
	// Every tab this run opened, closed together when it is done.
	tabs          []*Page
	waiter        chan UserReply
	cancelled     bool
	filled        int
	submitClicked bool
	mock          *MockMemory
}

func (l *live) cur() *Page {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.page
}

func (l *live) isCancelled() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.cancelled
}

var (
	errCancelled   = errors.New("cancelled")
	errBrowserGone = errors.New("browser gone")
)

var (
	liveMu   sync.Mutex
	liveRuns = map[int64]*live{}
	runQueue = newQueue(func() int { return GetSettings().Concurrency })
)

func getLive(id int64) *live {
	liveMu.Lock()
	defer liveMu.Unlock()
	return liveRuns[id]
}

var browserHookOnce sync.Once

func initAgent() {
	browserHookOnce.Do(func() {
		onBrowserClosed(func() {
			liveMu.Lock()
			ids := []int64{}
			ls := []*live{}
			for id, l := range liveRuns {
				ids = append(ids, id)
				ls = append(ls, l)
			}
			liveMu.Unlock()
			for i, l := range ls {
				l.mu.Lock()
				l.cancelled = true
				w := l.waiter
				l.waiter = nil
				l.mu.Unlock()
				if w != nil {
					w <- UserReply{Type: "cancel"}
				}
				addStep(ids[i], "error", "和浏览器的连接断开了（浏览器关掉了、扩展被停用，或在设置里换了浏览器）")
			}
		})
	})
}

type Run struct {
	ID         int64
	JobID      int64
	Status     string
	Pending    *string
	Outcome    *string
	Steps      int64
	CreatedAt  string
	UpdatedAt  string
	FinishedAt *string
}

func runFromRow(m map[string]any) *Run {
	return &Run{ID: asInt(m["id"]), JobID: asInt(m["job_id"]), Status: jsString(m["status"]), Pending: asStrPtr(m["pending"]), Outcome: asStrPtr(m["outcome"]), Steps: asInt(m["steps"]), CreatedAt: jsString(m["created_at"]), UpdatedAt: jsString(m["updated_at"]), FinishedAt: asStrPtr(m["finished_at"])}
}

func getRun(id int64) *Run {
	m := queryMap("SELECT * FROM runs WHERE id = ?", id)
	if m == nil {
		return nil
	}
	return runFromRow(m)
}

func setRun(id int64, patch P) {
	keys := []string{}
	args := []any{}
	for _, k := range []string{"status", "pending", "outcome", "steps", "finished_at"} {
		if v, ok := patch[k]; ok {
			keys = append(keys, k+" = ?")
			args = append(args, v)
		}
	}
	args = append(args, id)
	mustExec("UPDATE runs SET "+strings.Join(keys, ", ")+", updated_at = datetime('now') WHERE id = ?", args...)
	emit("run", id)
}

func addStep(runID int64, kind, text string) {
	mustExec("INSERT INTO run_steps (run_id, kind, text) VALUES (?, ?, ?)", runID, kind, u16slice(text, 1000))
	emit("run", runID)
}

type RunStep struct {
	ID   int64  `json:"id"`
	Ts   string `json:"ts"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

func runSteps(runID int64) []RunStep {
	out := []RunStep{}
	for _, m := range queryMaps("SELECT id, ts, kind, text FROM run_steps WHERE run_id = ? ORDER BY id", runID) {
		out = append(out, RunStep{asInt(m["id"]), jsString(m["ts"]), jsString(m["kind"]), jsString(m["text"])})
	}
	return out
}

var activeStatuses = []string{"queued", "running", "need_user", "awaiting_confirm"}

// runSlotFree: whether a new run would start filling right away instead of waiting in the queue.
func runSlotFree() bool {
	return runQueue.Size() < max(1, GetSettings().Concurrency)
}

func startRun(jobID int64) (int64, error) {
	initAgent()
	if ready := llmReady(); !ready.OK {
		return 0, errors.New(ready.Reason)
	}
	job := getJob(jobID)
	if job == nil {
		return 0, errors.New("岗位不存在")
	}
	if job.URL == "" {
		return 0, errors.New("这个岗位没有链接，没法自动投递")
	}
	if m := queryMap("SELECT * FROM runs WHERE job_id = ? AND status IN (?,?,?,?)", jobID, "queued", "running", "need_user", "awaiting_confirm"); m != nil {
		return asInt(m["id"]), nil
	}
	_, id := mustExec("INSERT INTO runs (job_id) VALUES (?)", jobID)
	liveMu.Lock()
	liveRuns[id] = &live{mock: newMockMemory()}
	liveMu.Unlock()
	emit("run", id)
	runQueue.Push(func() { execRun(id) })
	return id, nil
}

func reply(runID int64, r UserReply) bool {
	l := getLive(runID)
	if l == nil {
		return false
	}
	l.mu.Lock()
	if r.Type == "cancel" {
		l.cancelled = true
		if l.waiter == nil {
			// Not waiting on you: it stops at the next step.
			l.mu.Unlock()
			setRun(runID, P{"status": "cancelled", "pending": nil, "finished_at": isoNow()})
			return true
		}
	}
	w := l.waiter
	l.waiter = nil
	l.mu.Unlock()
	if w == nil {
		return false
	}
	w <- r
	return true
}

func focusRun(runID int64) bool {
	l := getLive(runID)
	if l == nil {
		return false
	}
	p := l.cur()
	if p == nil || p.IsClosed() {
		return false
	}
	p.BringToFront()
	return true
}

func waitForUser(runID int64, l *live, status string, pending any) (UserReply, error) {
	ch := make(chan UserReply, 1)
	l.mu.Lock()
	l.waiter = ch
	l.mu.Unlock()
	setRun(runID, P{"status": status, "pending": jsonStr(pending)})
	r := <-ch
	if r.Type == "cancel" {
		return r, errCancelled
	}
	setRun(runID, P{"status": "running", "pending": nil})
	return r, nil
}

// prop is one tool parameter, kept in order.
type prop struct{ name, schema string }

func tool(name, description string, props ...prop) ToolDef {
	var b strings.Builder
	b.WriteString(`{"type":"object","properties":{`)
	req := []string{}
	for i, p := range props {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(jsonStr(p.name) + ":" + p.schema)
		req = append(req, p.name)
	}
	b.WriteString(`},"required":` + jsonStr(req) + `}`)
	t := ToolDef{Type: "function"}
	t.Function.Name = name
	t.Function.Description = description
	t.Function.Parameters = json.RawMessage(b.String())
	return t
}

const strT = `{"type":"string"}`

var tools = []ToolDef{
	tool("fill", "Type a value into a text input, textarea or editable field (replaces what is there).", prop{"id", strT}, prop{"value", strT}),
	tool("select", "Choose an option of a native <select> by its visible text.", prop{"id", strT}, prop{"option", strT}),
	tool("choose", "For searchable dropdowns/autocomplete (kind=combobox, location/school pickers): types the text and clicks the best matching suggestion.", prop{"id", strT}, prop{"text", strT}),
	tool("check", "Tick or untick a checkbox, or pick a radio button (checked=true).", prop{"id", strT}, prop{"checked", `{"type":"boolean"}`}),
	tool("click", "Click a button, link or option. Ends the turn (the page may change). Final submit buttons are blocked: use request_submit.", prop{"id", strT}),
	tool("upload", "Attach a file to a file input or to an upload button.", prop{"id", strT}, prop{"file", `{"type":"string","enum":["resume","cover_letter"]}`}),
	tool("write_cover_letter", "The form asks for a cover letter (upload or text box) and FILES says none is available: writes one from the profile. Returns its text; afterwards upload(file=cover_letter) works."),
	tool("scroll", "Scroll the page to load more content.", prop{"direction", `{"type":"string","enum":["down","up"]}`}),
	tool("wait", "Wait for the page (max 10 s).", prop{"seconds", `{"type":"number"}`}),
	tool("goto", "Open a URL in this tab (e.g. the application link found on the page).", prop{"url", strT}),
	tool("ask_user", "Ask the candidate for information a REQUIRED field needs that is not in the profile/answers. Question in Simplified Chinese.", prop{"question", strT}, prop{"field_label", `{"type":"string","description":"The form field's label, verbatim"}`}),
	tool("need_manual", "Hand over to the human for sign-in, account creation, passwords, verification codes, CAPTCHAs, or when stuck. Reason in Simplified Chinese.", prop{"reason", strT}),
	tool("request_submit", "Everything required is filled: ask the candidate to approve clicking the final submit button.", prop{"id", `{"type":"string","description":"id of the final submit/apply/send button"}`}, prop{"summary", `{"type":"string","description":"Simplified Chinese: what was filled, anything uncertain, consent boxes ticked"}`}),
	tool("finish", "End this application.", prop{"outcome", `{"type":"string","enum":["submitted","already_applied","closed","failed"]}`}, prop{"note", `{"type":"string","description":"Simplified Chinese"}`}),
}

func agentSystem(p Profile, job *Job, tailored *Tailored) string {
	jd := jobJd(job)
	answers := []string{}
	for _, a := range p.Answers {
		ans := jsTrim(a.A)
		if ans == "" {
			ans = "(unknown — ask if a required field needs it)"
		}
		answers = append(answers, "- Q: "+a.Q+"\n  A: "+ans)
	}
	answerText := strings.Join(answers, "\n")
	if answerText == "" {
		answerText = "(none)"
	}
	facts := p.ExtraFacts
	if facts == "" {
		facts = "(none)"
	}
	title, company := sv(job.Title), sv(job.Company)
	if jd != nil {
		title, company = jd.Title, jd.Company
	}
	resume, cover := "not available", "not available"
	if job.ResumeFile != nil && *job.ResumeFile != "" {
		resume = filepath.Base(*job.ResumeFile)
	}
	if job.CoverFile != nil && *job.CoverFile != "" {
		cover = filepath.Base(*job.CoverFile)
	}
	letter := jsTrim(sv(job.CoverLetter))
	if letter == "" {
		letter = "(none)"
	}
	summary := ""
	if tailored != nil && tailored.Doc.Summary != "" {
		summary = "\nRESUME SUMMARY LINE\n" + tailored.Doc.Summary
	}
	// Same for every application up to JOB (the date sits there too), so DeepSeek serves the rules and the
	// profile from its cache on the next application as well, not only on the next step.
	return `You fill in a job application form in a real browser on behalf of the candidate below. The candidate approves the final submission; you never submit on your own.

HOW YOU WORK
- Each turn you get a snapshot of the current page: interactive elements with ids like [f0_12], their labels, current values and options. When the page kept its layout, you get only the elements that changed since the last full snapshot; the rest is as that snapshot shows. Act only through the tools, with ids from the LATEST snapshot. Several tools per turn are fine (e.g. fill all simple fields at once); a click ends the turn.
- On a job description page, click the button or link that starts the application (Apply / Easy Apply / Apply now / 申请 / 投递).
- Sign-in, account creation, passwords, verification codes, CAPTCHAs, Singpass, or anything else only the human can do: call need_manual with a short Chinese explanation. Never type passwords. Never try to get around a CAPTCHA.
- If there is a resume/CV upload, upload the resume first: many forms auto-fill from it. Then check and correct the auto-filled values against the profile.
- Fill fields only with facts from CANDIDATE PROFILE and ANSWERS. Never guess or invent (dates, salary, GPA, addresses, ID numbers, referees…).
- "How many years of (work) experience with X": use a saved answer if there is one; otherwise count only the dated jobs, internships and projects in CANDIDATE PROFILE that used X, in whole years rounded DOWN (a few months is 0). Study and coursework are not work experience. Never round up to look better; if you are unsure, ask_user.
- "Have you completed / do you have a <degree or level of education>": Yes only if CANDIDATE PROFILE shows that qualification finished before today. A degree still in progress (graduation date after today) is No, even if it is the level asked about; say "in progress, graduating <date>" where there is a text box for it. A value the site pre-filled or remembered is not evidence either way: check it against the profile like any other value.
- If a REQUIRED field needs something that is not there, call ask_user (Chinese question, field_label = the field's label verbatim). Leave optional fields you have no facts for empty.
- Voluntary demographic questions (gender, race, veteran, disability): use ANSWERS if present, otherwise the "decline / prefer not to say" option.
- Required consent checkboxes (privacy notice, data processing, declaration that the information is accurate) may be ticked; list them in your request_submit summary. Leave optional marketing/newsletter boxes unticked.
- type=date inputs take YYYY-MM-DD. Look for a separate country-code field before typing a phone number.
- Native select → select. Searchable dropdowns and autocompletes (kind=combobox, or a text box that pops suggestions like Location/School) → choose.
- Cover letter: upload the cover_letter file to a cover-letter upload; paste COVER LETTER text into a cover-letter text box. If the form asks for a cover letter (required, or an optional field the posting itself asks for) and none is available, call write_cover_letter, then upload or paste it. Do not write one for an optional field nobody asked for.
- Multi-step forms: complete the step, then click Next / Continue / Review.
- When everything required is filled and only the final submit/send/apply button remains, call request_submit with that button's id and a Chinese summary. The click tool blocks final submits.
- After approval the system clicks it. If the next snapshot shows a confirmation/thank-you message, call finish(outcome="submitted"). If it shows validation errors, fix them and call request_submit again.
- Job closed → finish("closed"). Already applied → finish("already_applied"). Stuck after a few attempts → need_manual explaining the problem in Chinese.

CANDIDATE PROFILE
` + profileForPrompt(p, false) + `

EXTRA FACTS (true, may be used to answer questions)
` + facts + `

ANSWERS
` + answerText + `

JOB
` + title + ` at ` + company + ` — ` + job.URL + `
Today is ` + time.Now().UTC().Format("2006-01-02") + `.

FILES FOR upload
- resume: ` + resume + `
- cover_letter: ` + cover + `

COVER LETTER TEXT
` + letter + `
` + summary
}

var (
	reStrongSubmit = jsRe(`\bsubmit\b|send application|complete (my )?application|finish application|confirm (and )?(send|apply)|提交|投递|确认申请|发送简历|立即沟通|^send$|^发送$`, "i")
	reStepWords    = jsRe(`\bnext\b|continue|review|save|search|upload|attach|add|下一步|继续|保存|搜索|上传|添加`, "i")
	reApplyWord    = jsRe(`\bapply\b|申请`, "i")
)

// isFinalSubmit: true when clicking this would plausibly send the application. Errs towards asking you.
func isFinalSubmit(el El, filled int) bool {
	label := jsTrim(el.Text + " " + el.Label)
	if reStrongSubmit.MatchString(label) {
		return true
	}
	if filled > 0 && reApplyWord.MatchString(label) {
		return true
	}
	if filled > 0 && el.SubmitType && !reStepWords.MatchString(label) {
		return true
	}
	return false
}

func settle(p *Page) {
	_ = p.WaitDOMContentLoaded(15 * time.Second)
	time.Sleep(700 * time.Millisecond)
}

// within fails when f takes longer than d (f keeps running; its result is ignored).
func within[T any](d time.Duration, what string, f func() (T, error)) (T, error) {
	type res struct {
		v   T
		err error
	}
	ch := make(chan res, 1)
	go func() {
		var r res
		r.err = catch(func() error {
			var err error
			r.v, err = f()
			return err
		})
		ch <- r
	}()
	select {
	case r := <-ch:
		return r.v, r.err
	case <-time.After(d):
		var zero T
		return zero, fmt.Errorf("%s timed out after %vs", what, d.Seconds())
	}
}

// ensureVisible brings the run's tab to the front if it is hidden (a background tab gets no animation
// frames, and clicks and scrolls hang).
func ensureVisible(runID int64, l *live, p *Page) {
	state, err := within(5*time.Second, "visibility check", func() (string, error) {
		var s string
		err := p.Eval(`document.visibilityState`, &s)
		return s, err
	})
	if err != nil {
		state = "unknown"
	}
	if state == "visible" {
		return
	}
	p.BringToFront()
	time.Sleep(400 * time.Millisecond)
	l.mu.Lock()
	first := !l.broughtFront
	l.broughtFront = true
	l.mu.Unlock()
	if first {
		addStep(runID, "note", "助手的标签页在后台，已切到前台（后台标签页浏览器会暂停渲染，点击和滚动会卡住）")
	}
}

var reSimSplit = regexp.MustCompile(`[^a-z0-9\x{4e00}-\x{9fff}]+`)

func similarity(a, b string) float64 {
	na, nb := norm(a), norm(b)
	if na == "" || nb == "" {
		return 0
	}
	if na == nb {
		return 1
	}
	if strings.HasPrefix(nb, na) || strings.HasPrefix(na, nb) {
		return 0.9
	}
	if strings.Contains(nb, na) || strings.Contains(na, nb) {
		return 0.8
	}
	set := func(s string) map[string]bool {
		m := map[string]bool{}
		for _, t := range reSimSplit.Split(s, -1) {
			if t != "" {
				m[t] = true
			}
		}
		return m
	}
	ta, tb := set(na), set(nb)
	inter := 0
	for t := range ta {
		if tb[t] {
			inter++
		}
	}
	if inter == 0 {
		return 0
	}
	return 0.7 * float64(inter) / float64(max(len(ta), len(tb)))
}

func bestMatch(want string, options []string) int {
	best, score := -1, 0.0
	for i, o := range options {
		if s := similarity(want, o); s > score {
			score = s
			best = i
		}
	}
	if score >= 0.3 {
		return best
	}
	return -1
}

func reviewFields(obs Obs) []ReviewField {
	out := []ReviewField{}
	for _, e := range obs.Elements {
		switch e.Kind {
		case "button", "link", "option":
			continue
		case "radio":
			if e.Checked != nil && *e.Checked {
				out = append(out, ReviewField{strOr2(e.Group, "选项"), e.Label})
			}
		case "checkbox":
			if e.Checked != nil && *e.Checked {
				out = append(out, ReviewField{strOr2(e.Group, "勾选"), e.Label})
			}
		default:
			if e.Value != "" {
				out = append(out, ReviewField{strOr2(e.Label, e.Kind), e.Value})
			}
		}
	}
	return out
}

func strOr2(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// liveShotName is the latest view of the run's tab, shown live in the UI and kept as the last screen.
func liveShotName(runID int64) string { return fmt.Sprintf("run-%d-live.jpg", runID) }

func snapshot(runID int64, p *Page) {
	_ = p.Screenshot(filepath.Join(ShotsDir, liveShotName(runID)), false, 55, 5*time.Second)
}

// releaseTabs closes a finished run's tabs (only tabs the run opened).
func releaseTabs(l *live) {
	l.mu.Lock()
	tabs := append([]*Page{}, l.tabs...)
	l.mu.Unlock()
	for _, t := range tabs {
		if !t.IsClosed() {
			t.Close()
		}
	}
}

func isStep(m Message) bool { return m.Role == "user" && strings.HasPrefix(m.text(), "STEP ") }

func execRun(runID int64) {
	l := getLive(runID)
	if l == nil {
		return
	}
	defer func() {
		l.mu.Lock()
		l.waiter = nil
		l.mu.Unlock()
		liveMu.Lock()
		delete(liveRuns, runID)
		liveMu.Unlock()
	}()
	err := catch(func() error { return runLoop(runID, l) })
	if err == nil {
		return
	}
	if errors.Is(err, errCancelled) || l.isCancelled() {
		setRun(runID, P{"status": "cancelled", "pending": nil, "finished_at": isoNow()})
		addStep(runID, "note", "已放弃这次投递")
		releaseTabs(l)
		return
	}
	// Keep the screen it stopped on: it usually explains the failure.
	if p := l.cur(); p != nil && !p.IsClosed() {
		snapshot(runID, p)
	}
	msg := err.Error()
	if errors.Is(err, errBrowserGone) {
		msg = "页面被关掉了"
	}
	setRun(runID, P{"status": "failed", "outcome": msg, "pending": nil, "finished_at": isoNow()})
	addStep(runID, "error", msg)
}

func runLoop(runID int64, l *live) error {
	if l.isCancelled() {
		return errCancelled
	}
	setRun(runID, P{"status": "running"})
	job := getJob(getRun(runID).JobID)
	if job.ResumeFile == nil || !fileExists(*job.ResumeFile) {
		if job.Tailored != nil {
			addStep(runID, "note", "重新生成简历 PDF")
			if err := renderJobFiles(job.ID); err != nil {
				return err
			}
		} else {
			addStep(runID, "note", "还没定制简历，先用资料库原版生成 PDF")
			if err := renderMasterFiles(job.ID); err != nil {
				return err
			}
		}
		job = getJob(job.ID)
	}
	settings := GetSettings()
	demo := isDemo()
	tailored := parseTailored(job.Tailored)
	profile := getProfile()

	page, err := newVisiblePage("")
	if err != nil {
		return err
	}
	l.mu.Lock()
	l.page = page
	l.tabs = append(l.tabs, page)
	l.mu.Unlock()
	var follow func(p *Page)
	follow = func(p *Page) {
		p.OnPopup(func(np *Page) {
			l.mu.Lock()
			l.page = np
			l.tabs = append(l.tabs, np)
			l.mu.Unlock()
			follow(np)
			addStep(runID, "note", "申请页在新标签页打开，已切换过去")
			// Some apply forms (Indeed's) close their tab when done: carry on in the tab that opened it.
			np.OnClose(func() {
				l.mu.Lock()
				back := l.page == np && !p.IsClosed()
				if back {
					l.page = p
				}
				l.mu.Unlock()
				if back {
					addStep(runID, "note", "那个标签页关掉了，回到原来的页面")
				}
			})
		})
	}
	follow(page)
	addStep(runID, "action", "打开 "+job.URL)
	if err := page.Goto(job.URL, 45*time.Second); err != nil {
		return err
	}

	messages := []Message{textMsg("system", agentSystem(profile, job, tailored))}
	noted := map[string]bool{}
	var base *Obs
	baseStep := 0
	more := false
	idle, stuck := 0, 0
	for step := 1; step <= settings.MaxSteps; step++ {
		if l.isCancelled() {
			return errCancelled
		}
		pg := l.cur()
		if pg.IsClosed() {
			return errBrowserGone
		}
		ensureVisible(runID, l, pg)
		settle(pg)
		snapshot(runID, pg)
		obs, err := within(30*time.Second, "reading the page", func() (Obs, error) { return observe(pg, more), nil })
		if err != nil {
			ensureVisible(runID, l, pg)
			if obs, err = within(30*time.Second, "reading the page", func() (Obs, error) { return observe(pg, more), nil }); err != nil {
				return err
			}
		}
		// A bot check ("Just a moment…") is yours to pass; asking the model about it only wastes a step.
		if isCheckPage(obs.Title, obs.Excerpt) {
			name := "网站"
			if s := siteFor(obs.URL); s != nil {
				name = s.Name
			}
			addStep(runID, "ask", "需要你手动处理："+name+"在做人机验证")
			pg.BringToFront()
			if _, err := waitForUser(runID, l, "need_user", pendingManual{"manual", name + "在做人机验证：请在浏览器里助手开的那个标签页上自己完成，然后点「处理好了，继续」。"}); err != nil {
				return err
			}
			addStep(runID, "note", "你处理完了，继续")
			continue
		}
		// What this site's flow usually looks like, the first time one of its pages is open.
		if site := siteFor(obs.URL); site != nil && !noted[site.Key] {
			noted[site.Key] = true
			messages = append(messages, textMsg("user", "SITE NOTES — you are now on "+site.Name+". Hints from earlier use of this site; the page in front of you wins if it differs.\n"+site.Playbook))
			if step > 1 {
				addStep(runID, "note", "进入 "+site.Name)
			}
		}
		delta := ""
		if base != nil {
			delta = formatDelta(*base, obs, baseStep, step)
		}
		if delta != "" {
			for i := range messages {
				if isStep(messages[i]) && strings.Contains(messages[i].text(), DeltaMark) {
					messages[i].Content = strp("(older update omitted)")
				}
			}
			messages = append(messages, textMsg("user", delta))
		} else {
			for i := range messages {
				if isStep(messages[i]) {
					messages[i].Content = strp("(older snapshot omitted)")
				}
			}
			messages = append(messages, textMsg("user", formatObs(obs, step)))
			o := obs
			base, baseStep = &o, step
		}

		var calls []ToolCall
		content := ""
		if demo {
			profile = getProfile()
			l.mu.Lock()
			calls = mockDecide(obs, profile, job, l.mock)
			l.mu.Unlock()
		} else {
			content, calls, err = chat(ChatOpts{Messages: messages, Tools: tools, MaxTokens: 2500, Usage: &UsageTag{JobID: job.ID, Kind: "apply"}})
			if err != nil {
				return err
			}
		}
		if l.isCancelled() {
			return errCancelled
		}
		if t := jsTrim(content); t != "" {
			addStep(runID, "model", t)
		}
		if len(calls) == 0 {
			c := content
			if c == "" {
				c = "(no action)"
			}
			messages = append(messages, textMsg("assistant", c))
			idle++
			if idle >= 3 {
				return errors.New("模型连续几步没有动作")
			}
			messages = append(messages, textMsg("user", "Use the tools to act. If you are done or stuck, call finish or need_manual."))
			continue
		}
		idle = 0
		am := Message{Role: "assistant", ToolCalls: calls}
		if content != "" {
			am.Content = strp(content)
		}
		messages = append(messages, am)

		endTurn := false
		var finished *finishInfo
		progressed := false
		// You may have switched tabs while the model was thinking.
		if p := l.cur(); p != nil && !p.IsClosed() {
			ensureVisible(runID, l, p)
		}
		anyError := false
		for _, c := range calls {
			var result string
			if endTurn || finished != nil {
				result = "Skipped: an earlier action ended this turn; look at the new snapshot."
			} else {
				// Tools that wait for you have no time limit; everything that acts on the page does.
				waitsForYou := contains([]string{"ask_user", "need_manual", "request_submit", "finish", "write_cover_letter"}, c.Function.Name)
				var out toolOut
				if waitsForYou {
					out, err = execTool(runID, l, c, obs, job)
				} else {
					out, err = within(60*time.Second, c.Function.Name, func() (toolOut, error) { return execTool(runID, l, c, obs, job) })
					if err != nil && !errors.Is(err, errCancelled) && !errors.Is(err, errBrowserGone) {
						addStep(runID, "error", c.Function.Name+" 卡住了 60 秒，跳过")
						out, err = toolOut{result: "ERROR: " + err.Error() + ". Look at the new snapshot before trying again.", endTurn: true}, nil
					}
				}
				if err != nil {
					return err
				}
				result = out.result
				endTurn = out.endTurn
				finished = out.finished
				if !contains([]string{"scroll", "wait"}, c.Function.Name) && !strings.HasPrefix(result, "ERROR") && !strings.HasPrefix(result, "BLOCKED") {
					progressed = true
				}
			}
			if strings.HasPrefix(result, "ERROR") {
				anyError = true
			}
			messages = append(messages, Message{Role: "tool", ToolCallID: c.ID, Content: strp(result)})
		}
		more = anyError
		for _, c := range calls {
			if c.Function.Name == "scroll" {
				more = true
			}
		}
		// A test run once scrolled 40 times looking for a button the snapshot had dropped.
		if progressed {
			stuck = 0
		} else {
			stuck++
		}
		if stuck >= 8 {
			return errors.New("连续 8 步只在滚动、等待或出错，没有进展，停下了；浏览器里的页面保留着，你可以接手")
		}
		setRun(runID, P{"steps": step})
		if finished != nil {
			ok := finished.outcome == "submitted" || finished.outcome == "already_applied"
			status := "failed"
			if finished.outcome == "submitted" {
				status = "submitted"
			} else if ok {
				status = "finished"
			}
			outcome := finished.note
			if outcome == "" {
				outcome = finished.outcome
			}
			setRun(runID, P{"status": status, "outcome": outcome, "pending": nil, "finished_at": isoNow()})
			if ok {
				setJob(job.ID, P{"stage": "applied"})
			}
			kind := "error"
			if ok {
				kind = "note"
			}
			text := "结束：" + finished.outcome
			if finished.note != "" {
				text += " — " + finished.note
			}
			addStep(runID, kind, text)
			if ok {
				time.AfterFunc(4*time.Second, func() { releaseTabs(l) })
			}
			return nil
		}
	}
	return fmt.Errorf("走了 %d 步还没填完，停下了；浏览器里的页面保留着，你可以接手", settings.MaxSteps)
}

type finishInfo struct{ outcome, note string }

type toolOut struct {
	result   string
	endTurn  bool
	finished *finishInfo
}

var reRequiredMark = jsRe(`\s*(\*|\(required\)|（必填）)\s*$`, "i")

func execTool(runID int64, l *live, c ToolCall, obs Obs, job *Job) (out toolOut, err error) {
	page := l.cur()
	argsText := c.Function.Arguments
	if argsText == "" {
		argsText = "{}"
	}
	argsAny, ok := parseAny(argsText)
	if !ok {
		return toolOut{result: "ERROR: arguments were not valid JSON"}, nil
	}
	args := obj(argsAny)
	if args == nil {
		args = map[string]any{}
	}
	name := c.Function.Name
	idArg, hasID := args["id"].(string)
	var el *El
	var loc *Locator
	if hasID {
		for i := range obs.Elements {
			if obs.Elements[i].ID == idArg {
				el = &obs.Elements[i]
				break
			}
		}
		loc = locate(page, idArg)
	}
	needEl := func() *toolOut {
		if el == nil || loc == nil {
			return &toolOut{result: "ERROR: no element [" + jsString(args["id"]) + "] in the latest snapshot"}
		}
		return nil
	}
	what := ""
	if el != nil {
		what = "「" + u16slice(firstNonEmpty(el.Label, el.Text, el.Group, el.ID), 50) + "」"
	}

	defer func() {
		r := recover()
		var e error
		switch {
		case r != nil:
			e = fmt.Errorf("%v", r)
		case err != nil && !errors.Is(err, errCancelled) && !errors.Is(err, errBrowserGone):
			e = err
		default:
			return
		}
		if errors.Is(e, errCancelled) {
			err = e
			return
		}
		if page.IsClosed() {
			err = errBrowserGone
			return
		}
		msg := u16slice(strings.SplitN(e.Error(), "\n", 2)[0], 300)
		addStep(runID, "error", name+what+" 出错："+msg)
		out, err = toolOut{result: "ERROR: " + msg}, nil
	}()

	switch name {
	case "fill":
		if bad := needEl(); bad != nil {
			return *bad, nil
		}
		value := jsString(args["value"])
		if el.Kind == "file" {
			return toolOut{result: "ERROR: this is a file input; use upload"}, nil
		}
		if el.Kind == "select" {
			c2 := c
			c2.Function.Name = "select"
			c2.Function.Arguments = jsonObj("id", args["id"], "option", value)
			return execTool(runID, l, c2, obs, job)
		}
		if err := loc.Fill(value, 8*time.Second); err != nil {
			return toolOut{}, err
		}
		l.mu.Lock()
		l.filled++
		l.mu.Unlock()
		addStep(runID, "action", "填写"+what+"："+u16slice(value, 80))
		return toolOut{result: "OK filled " + firstNonEmpty(what, idArg)}, nil

	case "select":
		if bad := needEl(); bad != nil {
			return *bad, nil
		}
		var opts []struct {
			V string `json:"v"`
			T string `json:"t"`
		}
		if err := loc.Evaluate(`(s) => Array.from(s.options).map((o) => ({ v: o.value, t: o.text.trim() }))`, &opts); err != nil {
			return toolOut{}, err
		}
		texts := make([]string, len(opts))
		for i, o := range opts {
			texts[i] = o.T
		}
		want := jsString(args["option"])
		i := bestMatch(want, texts)
		if i < 0 {
			return toolOut{result: `ERROR: no option like "` + want + `". Options: ` + strings.Join(texts[:min(60, len(texts))], " | ")}, nil
		}
		if err := loc.SelectOption(opts[i].V, 8*time.Second); err != nil {
			return toolOut{}, err
		}
		l.mu.Lock()
		l.filled++
		l.mu.Unlock()
		addStep(runID, "action", "选择"+what+"："+opts[i].T)
		return toolOut{result: `OK selected "` + opts[i].T + `"`}, nil

	case "choose":
		if bad := needEl(); bad != nil {
			return *bad, nil
		}
		text := jsString(args["text"])
		if err := loc.Click(8 * time.Second); err != nil {
			return toolOut{}, err
		}
		if err := loc.Fill(text, 3*time.Second); err != nil {
			if err := loc.PressSequentially(text, 40*time.Millisecond, 8*time.Second); err != nil {
				return toolOut{}, err
			}
		}
		time.Sleep(1200 * time.Millisecond)
		type cand struct {
			text  string
			idx   int
			frame string
		}
		cands := []cand{}
		for _, f := range page.Frames() {
			var found []string
			if err := page.EvalIn(f.ID, `(() => {
  const sel = '[role=option], [class*="select__option"], [class*="Select-option"], .pac-item, li[id*="option"], [class*="autocomplete"] li, [class*="suggestion"]';
  return Array.from(document.querySelectorAll(sel))
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .slice(0, 40)
    .map((e, i) => { e.setAttribute("data-ra-opt", String(i)); return e.innerText.replace(/\s+/g, " ").trim(); });
})()`, &found); err != nil {
				continue
			}
			for idx, t := range found {
				if t != "" {
					cands = append(cands, cand{t, idx, f.ID})
				}
			}
		}
		if len(cands) == 0 {
			addStep(runID, "action", "输入"+what+"："+text+"（没有出现候选项）")
			return toolOut{result: "Typed the text, but no suggestions appeared. If this is a plain text box the typed value may be enough; otherwise try different wording."}, nil
		}
		texts := make([]string, len(cands))
		for i, cd := range cands {
			texts[i] = cd.text
		}
		i := bestMatch(text, texts)
		if i < 0 {
			return toolOut{result: `Typed "` + text + `". Suggestions shown: ` + strings.Join(texts[:min(25, len(texts))], " | ") + ". Call choose again with the exact suggestion text."}, nil
		}
		cd := cands[i]
		if err := page.Locator(cd.frame, fmt.Sprintf(`[data-ra-opt="%d"]`, cd.idx)).Click(6 * time.Second); err != nil {
			return toolOut{}, err
		}
		l.mu.Lock()
		l.filled++
		l.mu.Unlock()
		addStep(runID, "action", "选择"+what+"："+u16slice(cd.text, 80))
		return toolOut{result: `OK chose "` + cd.text + `"`}, nil

	case "check":
		if bad := needEl(); bad != nil {
			return *bad, nil
		}
		want := args["checked"] != false
		if err := loc.SetChecked(want, 4*time.Second); err != nil {
			if err := loc.Evaluate(`(e) => (e.labels?.[0] ?? e).click()`, nil); err != nil {
				return toolOut{}, err
			}
			time.Sleep(200 * time.Millisecond)
		}
		if now, err := loc.IsChecked(); err == nil && now != want {
			verb := "untick"
			if want {
				verb = "tick"
			}
			return toolOut{result: "ERROR: could not " + verb + " it; try clicking its label instead"}, nil
		}
		l.mu.Lock()
		l.filled++
		l.mu.Unlock()
		var label string
		if el.Kind == "radio" {
			if el.Group != "" {
				label = "「" + u16slice(el.Group, 40) + "」"
			}
			label += "选「" + u16slice(el.Label, 40) + "」"
		} else if want {
			label = "勾选" + what
		} else {
			label = "取消勾选" + what
		}
		addStep(runID, "action", label)
		if want {
			return toolOut{result: "OK checked"}, nil
		}
		return toolOut{result: "OK unchecked"}, nil

	case "click":
		if bad := needEl(); bad != nil {
			return *bad, nil
		}
		l.mu.Lock()
		filled := l.filled
		l.mu.Unlock()
		if isFinalSubmit(*el, filled) {
			addStep(runID, "guard", "拦下了对"+what+"的点击：这像是最终提交，要等你确认")
			return toolOut{result: "BLOCKED: this looks like the final submit. Do not click it. If everything required is filled, call request_submit with this id; otherwise finish filling first."}, nil
		}
		if err := loc.Click(8 * time.Second); err != nil {
			return toolOut{}, err
		}
		addStep(runID, "action", "点击"+what)
		settle(l.cur())
		return toolOut{result: "OK clicked", endTurn: true}, nil

	case "upload":
		if bad := needEl(); bad != nil {
			return *bad, nil
		}
		now := getJob(job.ID) // a cover letter may have been written during this run
		if now == nil {
			now = job
		}
		which := jsString(args["file"])
		file := sv(now.ResumeFile)
		if which == "cover_letter" {
			file = sv(now.CoverFile)
		}
		if file == "" || !fileExists(file) {
			hint := ""
			if which == "cover_letter" {
				hint = "; call write_cover_letter first"
			}
			return toolOut{result: "ERROR: " + which + " is not available" + hint}, nil
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return toolOut{}, err
		}
		base := filepath.Base(file)
		if el.Kind == "file" {
			err = loc.SetInputFiles(base, "application/pdf", data, 8*time.Second)
		} else {
			err = loc.UploadThroughChooser(base, "application/pdf", data, 8*time.Second)
		}
		if err != nil {
			return toolOut{}, err
		}
		l.mu.Lock()
		l.filled++
		l.mu.Unlock()
		kind := "简历"
		if which == "cover_letter" {
			kind = "求职信"
		}
		addStep(runID, "action", "上传"+kind+"："+base)
		time.Sleep(2 * time.Second)
		return toolOut{result: "OK attached " + base + ". The form may have auto-filled fields from it; check them.", endTurn: true}, nil

	case "write_cover_letter":
		addStep(runID, "note", "这个申请要求求职信，按资料库写一封")
		cl, err := writeCoverLetter(job.ID)
		if err != nil {
			return toolOut{}, err
		}
		extra := ""
		if len(cl.Warnings) > 0 {
			extra = "（" + strings.Join(cl.Warnings, "；") + "）"
		}
		addStep(runID, "action", "写好了求职信："+filepath.Base(cl.File)+extra)
		return toolOut{result: `OK cover letter ready as file "cover_letter" (` + filepath.Base(cl.File) + "). Text, for a text box:\n" + cl.Text}, nil

	case "scroll":
		dy := 900.0
		if args["direction"] == "up" {
			dy = -900
		}
		// The wheel scrolls whatever pane is under the mouse; if it doesn't come back, scroll the window instead.
		if _, err := within(5*time.Second, "scroll", func() (bool, error) { return true, page.MouseWheel(dy) }); err != nil {
			_ = page.Eval(fmt.Sprintf("window.scrollBy(0, %v)", dy), nil)
		}
		time.Sleep(600 * time.Millisecond)
		return toolOut{result: "OK scrolled", endTurn: true}, nil

	case "wait":
		s := jsNumber(args["seconds"], has(args, "seconds"))
		if math.IsNaN(s) || s == 0 {
			s = 2
		}
		time.Sleep(time.Duration(math.Min(10, math.Max(0.5, s)) * float64(time.Second)))
		return toolOut{result: "OK waited", endTurn: true}, nil

	case "goto":
		u := jsString(args["url"])
		if !reHTTP.MatchString(u) {
			return toolOut{result: "ERROR: only http(s) URLs"}, nil
		}
		if err := page.Goto(u, 45*time.Second); err != nil {
			return toolOut{}, err
		}
		addStep(runID, "action", "打开 "+u)
		return toolOut{result: "OK opened", endTurn: true}, nil

	case "ask_user":
		field := jsTrim(jsString(args["field_label"]))
		question := jsTrim(jsString(args["question"]))
		if question == "" {
			question = "「" + field + "」该填什么？"
		}
		addStep(runID, "ask", "问你："+question)
		r, err := waitForUser(runID, l, "need_user", pendingAsk{"ask", question, field})
		if err != nil {
			return toolOut{}, err
		}
		if r.Type != "answer" {
			return toolOut{result: "The user did not answer; leave the field empty if it is optional, otherwise call need_manual.", endTurn: true}, nil
		}
		answer := jsTrim(r.Answer)
		mark := ""
		if r.Remember {
			mark = "（已记入资料库）"
		}
		addStep(runID, "note", "你的回答："+answer+mark)
		l.mu.Lock()
		l.mock.setAnswer(firstNonEmpty(field, question), answer)
		l.mu.Unlock()
		if r.Remember && answer != "" {
			p := getProfile()
			qtext := jsTrim(reRequiredMark.ReplaceAllString(firstNonEmpty(field, question), ""))
			hit := false
			for i := range p.Answers {
				if similarity(p.Answers[i].Q, qtext) >= 0.8 {
					p.Answers[i].A = answer
					hit = true
					break
				}
			}
			if !hit {
				p.Answers = append(p.Answers, Answer{ID: newID("qa"), Q: qtext, A: answer})
			}
			saveProfile(p)
			emit("profile")
		}
		return toolOut{result: "User answered: " + jsonStr(answer), endTurn: true}, nil

	case "need_manual":
		reason := "需要你在浏览器里处理一下"
		if v, ok := args["reason"]; ok && v != nil {
			reason = jsString(v)
		}
		addStep(runID, "ask", "需要你手动处理："+reason)
		page.BringToFront()
		if _, err := waitForUser(runID, l, "need_user", pendingManual{"manual", reason}); err != nil {
			return toolOut{}, err
		}
		addStep(runID, "note", "你处理完了，继续")
		return toolOut{result: "The user says they handled it in the browser. Look at the new snapshot.", endTurn: true}, nil

	case "request_submit":
		if bad := needEl(); bad != nil {
			return *bad, nil
		}
		summary := jsString(args["summary"])
		shot := fmt.Sprintf("run-%d-%d.jpg", runID, time.Now().UnixMilli())
		if err := page.Screenshot(filepath.Join(ShotsDir, shot), true, 70, 15*time.Second); err != nil {
			_ = page.Screenshot(filepath.Join(ShotsDir, shot), false, 70, 15*time.Second)
		}
		addStep(runID, "ask", "填好了，等你确认提交（按钮"+what+"）")
		r, err := waitForUser(runID, l, "awaiting_confirm", pendingReview{
			Kind: "review", Summary: summary, Fields: reviewFields(obs), Screenshot: shot, TargetText: firstNonEmpty(el.Text, el.Label), URL: page.URL(),
		})
		if err != nil {
			return toolOut{}, err
		}
		if r.Type == "revise" {
			addStep(runID, "note", "你要求修改："+r.Feedback)
			return toolOut{result: "Not approved yet. The candidate's feedback: " + jsonStr(r.Feedback) + ". Make the changes, then call request_submit again.", endTurn: true}, nil
		}
		if r.Type != "confirm" {
			return toolOut{result: "Not approved.", endTurn: true}, nil
		}
		target := locate(page, idArg)
		if target == nil {
			return toolOut{result: "ERROR: the submit button is gone; look at the new snapshot", endTurn: true}, nil
		}
		if err := target.Click(10 * time.Second); err != nil {
			return toolOut{}, err
		}
		l.mu.Lock()
		l.submitClicked = true
		l.mu.Unlock()
		addStep(runID, "action", "你确认了，已点击"+what)
		settle(page)
		time.Sleep(2500 * time.Millisecond)
		return toolOut{result: "The candidate approved and the system clicked the submit button. If the new snapshot shows a confirmation, call finish(submitted). If it shows errors, fix them and call request_submit again. If it is another step, continue.", endTurn: true}, nil

	case "finish":
		outcome, _ := args["outcome"].(string)
		if !contains([]string{"submitted", "already_applied", "closed", "failed"}, outcome) {
			outcome = "failed"
		}
		note := ""
		if v, ok := args["note"]; ok && v != nil {
			note = jsString(v)
		}
		l.mu.Lock()
		clicked := l.submitClicked
		l.mu.Unlock()
		if outcome == "submitted" && !clicked {
			note += "（提交按钮不是经确认步骤点的，可能是你在浏览器里自己点的）"
		}
		return toolOut{result: "OK", endTurn: true, finished: &finishInfo{outcome, note}}, nil
	}
	return toolOut{result: "ERROR: unknown tool " + name}, nil
}

type RunListRow struct {
	Run
	JobTitle   *string
	JobCompany *string
	JobURL     string
}

func listRuns(jobID int64, active bool) []RunListRow {
	where := []string{}
	params := []any{}
	if jobID != 0 {
		where = append(where, "r.job_id = ?")
		params = append(params, jobID)
	}
	if active {
		where = append(where, "r.status IN ('queued','running','need_user','awaiting_confirm')")
	}
	w := ""
	if len(where) > 0 {
		w = "WHERE " + strings.Join(where, " AND ")
	}
	out := []RunListRow{}
	for _, m := range queryMaps("SELECT r.*, j.title AS job_title, j.company AS job_company, j.url AS job_url FROM runs r JOIN jobs j ON j.id = r.job_id "+w+" ORDER BY r.id DESC LIMIT 200", params...) {
		out = append(out, RunListRow{Run: *runFromRow(m), JobTitle: asStrPtr(m["job_title"]), JobCompany: asStrPtr(m["job_company"]), JobURL: jsString(m["job_url"])})
	}
	return out
}

func isLive(runID int64) bool { return getLive(runID) != nil }
