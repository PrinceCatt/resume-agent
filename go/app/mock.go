// Demo mode: rule-based stand-ins for the model calls, so the whole flow (read job → tailor → fill →
// stop for your confirmation) can be tried without an API key. It only knows simple forms; the real
// agent is the DeepSeek one.
package app

import (
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

var mockTech = []string{
	"Python", "Java", "C++", "C", "JavaScript", "TypeScript", "Go", "Rust", "SQL", "MySQL", "PostgreSQL", "Redis", "MongoDB",
	"Spring Boot", "Spring", "React", "Vue", "Node.js", "HTML", "CSS", "Docker", "Kubernetes", "AWS", "GCP", "Azure", "Linux",
	"Git", "Machine Learning", "Deep Learning", "PyTorch", "TensorFlow", "LLM", "NLP", "Data Structures", "Algorithms",
	"REST", "Microservices", "Embedded", "ARM", "ROS", "Testing", "CI/CD", "Kafka", "Spark", "Excel",
}

var (
	reTitleSplit   = regexp.MustCompile(`[|\-–—]`)
	reCompanyLine  = jsRe(`(?:company|about)\s*[:：]\s*([^\n.。]{2,60})`, "i")
	reBulletLine   = regexp.MustCompile(`^[-•*·]`)
	reBulletPrefix = jsRe(`^[-•*·]\s*`, "")
	reSingapore    = jsRe(`singapore`, "i")
	reManyHan      = regexp.MustCompile(`[\x{4e00}-\x{9fff}]{20,}`)
	reClosedJob    = jsRe(`no longer accepting|position (has been )?filled|job (is )?closed|已关闭|停止招聘`, "i")
)

func mockExtractJob(text, rawURL, pageTitle string) *JobJd {
	lines := []string{}
	for _, l := range strings.Split(text, "\n") {
		if t := jsTrim(l); t != "" {
			lines = append(lines, t)
		}
	}
	title := reTitleSplit.Split(pageTitle, -1)[0]
	if title == "" && len(lines) > 0 {
		title = lines[0]
	}
	title = u16slice(jsTrim(title), 100)
	company := ""
	if u, err := url.Parse(rawURL); err == nil && u.Host != "" {
		company = strings.Split(strings.TrimPrefix(strings.ToLower(u.Hostname()), "www."), ".")[0]
	}
	if m := reCompanyLine.FindStringSubmatch(text); m != nil {
		company = jsTrim(m[1])
	}
	lower := strings.ToLower(text)
	keywords := []string{}
	for _, k := range mockTech {
		if jsReCached(`(^|[^a-z])`+regexp.QuoteMeta(strings.ToLower(k))+`([^a-z]|$)`, "").MatchString(lower) {
			keywords = append(keywords, k)
		}
	}
	req := []string{}
	for _, l := range lines {
		if reBulletLine.MatchString(l) && len(req) < 8 {
			req = append(req, reBulletPrefix.ReplaceAllString(l, ""))
		}
	}
	location := ""
	if reSingapore.MatchString(text) {
		location = "Singapore"
	}
	lang := "en"
	if reManyHan.MatchString(text) {
		lang = "zh"
	}
	return &JobJd{
		Title:        title,
		Company:      company,
		Location:     location,
		Summary:      "（演示模式：没有调用模型，以下是按关键词粗略提取的结果）",
		Requirements: req,
		NiceToHave:   []string{},
		Keywords:     keywords,
		Language:     lang,
		Closed:       reClosedJob.MatchString(text),
		Fit:          nil,
		Facts:        mockFacts(text),
	}
}

var (
	reMockYears    = jsRe(`(\d{1,2})\s*\+?\s*(?:years?|yrs)\b`, "i")
	reMockIntern   = jsRe(`\bintern(ship)?\b|实习`, "i")
	reMockPartTime = jsRe(`part[- ]time|兼职`, "i")
	reMockContract = jsRe(`\bcontract\b`, "i")
	reMockFullTime = jsRe(`full[- ]time|全职`, "i")
	reMockMonths   = jsRe(`(\d{1,2})[- ]months?\b`, "i")
	reMockNoExp    = jsRe(`no (prior )?experience (is )?(required|needed)|fresh grad`, "i")
	reMockBachelor = jsRe(`\b(bachelor|degree)\b|本科`, "i")
	reMockDiploma  = jsRe(`\bdiploma\b`, "i")
	reMockCitizen  = jsRe(`singapore(an)? citizens? only|only singapore(an)? citizens?`, "i")
	reMockCitPR    = jsRe(`citizens? (and|or|/) (pr|permanent residents?)`, "i")
	reMockSalary   = jsRe(`S?\$\s?\d[\d,]*(\s*[-–]\s*S?\$?\s?\d[\d,]*)?`, "")
	reMockCover    = jsRe(`cover(ing)? letter|求职信`, "i")
	reMockRemote   = jsRe(`\bremote\b`, "i")
	reMockHybrid   = jsRe(`\bhybrid\b`, "i")
)

// mockFacts: demo-mode conditions, the obvious phrases only.
func mockFacts(text string) *JobFacts {
	typ := "unknown"
	switch {
	case reMockIntern.MatchString(text):
		typ = "internship"
	case reMockPartTime.MatchString(text):
		typ = "parttime"
	case reMockContract.MatchString(text):
		typ = "contract"
	case reMockFullTime.MatchString(text):
		typ = "fulltime"
	}
	var months *float64
	if m := reMockMonths.FindStringSubmatch(text); m != nil {
		if n := parseJSNumber(m[1]); n != 0 && !math.IsNaN(n) {
			months = &n
		}
	}
	var minYears *float64
	if m := reMockYears.FindStringSubmatch(text); m != nil {
		n := parseJSNumber(m[1])
		minYears = &n
	} else if reMockNoExp.MatchString(text) {
		z := 0.0
		minYears = &z
	}
	degree := ""
	if reMockBachelor.MatchString(text) {
		degree = "bachelor"
	} else if reMockDiploma.MatchString(text) {
		degree = "diploma"
	}
	auth := ""
	if reMockCitizen.MatchString(text) {
		auth = "citizen"
	} else if reMockCitPR.MatchString(text) {
		auth = "citizen_pr"
	}
	mats := []string{}
	if reMockCover.MatchString(text) {
		mats = []string{"cover_letter"}
	}
	workplace := ""
	if reMockRemote.MatchString(text) {
		workplace = "remote"
	} else if reMockHybrid.MatchString(text) {
		workplace = "hybrid"
	}
	return &JobFacts{
		Type: typ, Hours: "", Months: months, Start: "", MinYears: minYears, Degree: degree, Student: "",
		WorkAuth: auth, Salary: reMockSalary.FindString(text), Materials: mats, CoverLetterAsk: "", Workplace: workplace,
	}
}

// mockFit: the share of the posting's keywords that appear anywhere in the profile.
func mockFit(jd *JobJd, p Profile) Fit {
	parts := []string{p.Summary, p.ExtraFacts}
	for _, s := range p.Sections {
		for _, e := range s.Entries {
			parts = append(parts, e.Title, e.Subtitle)
			parts = append(parts, bulletTexts(e.Bullets)...)
		}
	}
	for _, g := range p.Skills {
		parts = append(parts, g.Items...)
	}
	text := strings.ToLower(strings.Join(parts, "\n"))
	has, miss := []string{}, []string{}
	for _, k := range jd.Keywords {
		if strings.Contains(text, strings.ToLower(k)) {
			has = append(has, k)
		}
	}
	for _, k := range jd.Keywords {
		if !contains(has, k) {
			miss = append(miss, k)
		}
	}
	score := 50.0
	if len(jd.Keywords) > 0 {
		score = jsRound(30 + 60*float64(len(has))/float64(len(jd.Keywords)))
	}
	f := Fit{Score: score, Verdict: "演示模式：只按关键词重合度粗估，没有真正理解岗位要求。", Strengths: []string{}, Gaps: []string{}}
	if len(has) > 0 {
		f.Strengths = []string{"资料里有：" + strings.Join(has[:min(6, len(has))], "、")}
	}
	if len(miss) > 0 {
		f.Gaps = []string{"资料里没找到：" + strings.Join(miss[:min(6, len(miss))], "、")}
	}
	return f
}

func mockTailor(master Profile, jd *JobJd) TailorOutput {
	kw := []string{}
	for _, k := range jd.Keywords {
		kw = append(kw, strings.ToLower(k))
	}
	rank := func(s string) int {
		ls := strings.ToLower(s)
		for _, k := range kw {
			if strings.Contains(ls, k) {
				return 0
			}
		}
		return 1
	}
	out := TailorOutput{Notes: []string{"演示模式：没有调用模型，只把和岗位关键词相关的要点、技能排到了前面，措辞没改。"}}
	for _, s := range master.Sections {
		sec := TailorSection{ID: s.ID, Entries: []TailorEntry{}}
		for _, e := range s.Entries {
			bs := append([]Bullet{}, e.Bullets...)
			sort.SliceStable(bs, func(i, j int) bool { return rank(bs[i].Text) < rank(bs[j].Text) })
			ent := TailorEntry{ID: e.ID, Bullets: []TailorBullet{}}
			for _, b := range bs {
				ent.Bullets = append(ent.Bullets, TailorBullet{Src: b.ID, Text: b.Text})
			}
			sec.Entries = append(sec.Entries, ent)
		}
		out.Sections = append(out.Sections, sec)
	}
	for _, g := range master.Skills {
		items := append([]string{}, g.Items...)
		sort.SliceStable(items, func(i, j int) bool { return rank(items[i]) < rank(items[j]) })
		out.Skills = append(out.Skills, TailorSkill{ID: g.ID, Items: items})
	}
	pos := float64(master.SkillsPosition)
	out.SkillsPosition = &pos
	out.Summary = master.Summary
	return out
}

// MockMemory is what demo mode remembers during one run.
type MockMemory struct {
	answerKeys      []string
	answers         map[string]string
	asked           map[string]bool
	done            map[string]bool
	submitRequested int
	n               int
}

func newMockMemory() *MockMemory {
	return &MockMemory{answers: map[string]string{}, asked: map[string]bool{}, done: map[string]bool{}}
}

func (m *MockMemory) setAnswer(q, a string) {
	if _, ok := m.answers[q]; !ok {
		m.answerKeys = append(m.answerKeys, q)
	}
	m.answers[q] = a
}

var reMockWordSplit = regexp.MustCompile(`[^a-z0-9\x{4e00}-\x{9fff}]+`)

func mockWords(s string) map[string]bool {
	out := map[string]bool{}
	for _, w := range reMockWordSplit.Split(strings.ToLower(s), -1) {
		if u16len(w) > 1 {
			out[w] = true
		}
	}
	return out
}

func overlap(a, b string) float64 {
	A, B := mockWords(a), mockWords(b)
	if len(A) == 0 || len(B) == 0 {
		return 0
	}
	n := 0
	for w := range A {
		if B[w] {
			n++
		}
	}
	return float64(n) / float64(min(len(A), len(B)))
}

func fromAnswers(label string, p Profile, mem *MockMemory) string {
	for _, q := range mem.answerKeys {
		if a := mem.answers[q]; a != "" && overlap(label, q) >= 0.5 {
			return a
		}
	}
	best, score := "", 0.0
	for _, qa := range p.Answers {
		s := overlap(label, qa.Q)
		if jsTrim(qa.A) != "" && s > score {
			score = s
			best = jsTrim(qa.A)
		}
	}
	if score >= 0.5 {
		return best
	}
	return ""
}

var (
	reGFirst    = regexp.MustCompile(`first name|given name|名字`)
	reGLast     = regexp.MustCompile(`last name|surname|family name|姓氏`)
	reGFull     = regexp.MustCompile(`full name|^name\b|your name|姓名`)
	reGEmail    = regexp.MustCompile(`e-?mail|邮箱`)
	reGCode     = regexp.MustCompile(`country code|区号`)
	reGPhone    = regexp.MustCompile(`phone|mobile|电话|手机`)
	reGLinkedin = regexp.MustCompile(`linkedin`)
	reGGithub   = regexp.MustCompile(`github`)
	reGWebsite  = regexp.MustCompile(`website|portfolio|个人网站`)
	reGSchool   = regexp.MustCompile(`school|university|college|学校|院校`)
	reGDegree   = regexp.MustCompile(`degree|学位|专业`)
	reGCover    = regexp.MustCompile(`cover letter|求职信`)
	reGCity     = regexp.MustCompile(`city|location|所在地|居住地`)
	reEduHead   = jsRe(`education`, "i")
)

func guess(label string, p Profile, job *Job, mem *MockMemory) string {
	b := p.Basics
	L := strings.ToLower(label)
	var edu *Entry
	for _, s := range p.Sections {
		if reEduHead.MatchString(s.Heading) {
			if len(s.Entries) > 0 {
				edu = &s.Entries[0]
			}
			break
		}
	}
	switch {
	case reGFirst.MatchString(L):
		return b.FirstName
	case reGLast.MatchString(L):
		return b.LastName
	case reGFull.MatchString(L):
		return b.Name
	case reGEmail.MatchString(L):
		return b.Email
	case reGCode.MatchString(L):
		return b.PhoneCountryCode
	case reGPhone.MatchString(L):
		return b.Phone
	case reGLinkedin.MatchString(L):
		return b.LinkedIn
	case reGGithub.MatchString(L):
		return b.GitHub
	case reGWebsite.MatchString(L):
		return b.Website
	case reGSchool.MatchString(L):
		if edu == nil {
			return ""
		}
		return edu.Title
	case reGDegree.MatchString(L):
		if edu == nil {
			return ""
		}
		return edu.Subtitle
	case reGCover.MatchString(L):
		return sv(job.CoverLetter)
	}
	if v := fromAnswers(label, p, mem); v != "" {
		return v
	}
	if reGCity.MatchString(L) {
		return b.Location
	}
	return ""
}

var (
	reDecline   = jsRe(`decline|prefer not|don.?t wish|not to (say|disclose)|不愿|不透露`, "i")
	reEEO       = jsRe(`gender|race|ethnic|veteran|disabilit|性别|种族|民族`, "i")
	reFinal     = jsRe(`\bsubmit\b|send application|提交|投递|发送`, "i")
	reNext      = jsRe(`\bnext\b|continue|review|下一步|继续`, "i")
	reThanks    = jsRe(`thank you for (applying|your application)|application (has been )?(received|submitted)|申请已提交|投递成功`, "i")
	reApplyBtn  = jsRe(`apply|申请`, "i")
	reResumeIn  = jsRe(`resume|cv|简历`, "i")
	reConsent   = jsRe(`agree|consent|acknowledge|confirm|privacy|同意|确认`, "i")
	reCountry   = jsRe(`country|国家`, "i")
)

// jsonObj builds a JSON object with keys in the given order (JSON.stringify of an object literal).
func jsonObj(kv ...any) string {
	var b strings.Builder
	b.WriteByte('{')
	for i := 0; i+1 < len(kv); i += 2 {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(jsonStr(kv[i].(string)))
		b.WriteByte(':')
		b.WriteString(jsonStr(kv[i+1]))
	}
	b.WriteByte('}')
	return b.String()
}

func mockDecide(obs Obs, p Profile, job *Job, mem *MockMemory) []ToolCall {
	calls := []ToolCall{}
	call := func(name, args string) {
		mem.n++
		c := ToolCall{ID: fmt.Sprintf("mock_%d", mem.n), Type: "function"}
		c.Function.Name = name
		c.Function.Arguments = args
		calls = append(calls, c)
	}
	if reThanks.MatchString(obs.Excerpt) {
		call("finish", jsonObj("outcome", "submitted", "note", "页面显示已收到申请"))
		return calls
	}
	fields, buttons := []El{}, []El{}
	for _, e := range obs.Elements {
		if e.Disabled {
			continue
		}
		switch e.Kind {
		case "button", "link":
			buttons = append(buttons, e)
		case "option":
		default:
			fields = append(fields, e)
		}
	}
	anyField := false
	for _, e := range fields {
		if e.Kind != "checkbox" {
			anyField = true
		}
	}
	if !anyField {
		var apply *El
		for i := range buttons {
			if reApplyBtn.MatchString(buttons[i].Text) {
				apply = &buttons[i]
				break
			}
		}
		if apply != nil && !mem.done[apply.ID] {
			mem.done[apply.ID] = true
			call("click", jsonObj("id", apply.ID))
		} else {
			call("need_manual", jsonObj("reason", "演示模式没找到申请表或申请按钮，请在浏览器里看一下"))
		}
		return calls
	}

	for _, e := range fields {
		if e.Kind == "file" && e.Value == "" && reResumeIn.MatchString(e.Label+" "+e.Group) {
			if !mem.done[e.ID] {
				mem.done[e.ID] = true
				call("upload", jsonObj("id", e.ID, "file", "resume"))
				return calls
			}
			break
		}
	}

	var missing *El
	groupOrder := []string{}
	radioGroups := map[string][]El{}
	for _, e := range fields {
		if e.Kind == "radio" {
			if _, ok := radioGroups[e.Group]; !ok {
				groupOrder = append(groupOrder, e.Group)
			}
			radioGroups[e.Group] = append(radioGroups[e.Group], e)
			continue
		}
		if mem.done[e.ID] || e.Kind == "file" {
			continue
		}
		if e.Kind == "checkbox" {
			if e.Required && !(e.Checked != nil && *e.Checked) && reConsent.MatchString(e.Label+" "+e.Group) {
				mem.done[e.ID] = true
				call("check", jsonObj("id", e.ID, "checked", true))
			}
			continue
		}
		if e.Value != "" {
			continue
		}
		if e.Kind == "select" && e.Options != nil {
			want := ""
			switch {
			case reEEO.MatchString(e.Label):
				for _, o := range e.Options {
					if reDecline.MatchString(o) {
						want = o
						break
					}
				}
			case reCountry.MatchString(e.Label):
				want = "Singapore"
			default:
				want = guess(e.Label, p, job, mem)
			}
			if want != "" {
				mem.done[e.ID] = true
				call("select", jsonObj("id", e.ID, "option", want))
			} else if e.Required && missing == nil {
				m := e
				missing = &m
			}
			continue
		}
		v := guess(e.Label, p, job, mem)
		if v != "" {
			mem.done[e.ID] = true
			if e.Kind == "combobox" {
				call("choose", jsonObj("id", e.ID, "text", v))
			} else {
				call("fill", jsonObj("id", e.ID, "value", v))
			}
		} else if e.Required && missing == nil {
			m := e
			missing = &m
		}
	}
	for _, group := range groupOrder {
		radios := radioGroups[group]
		skip := false
		for _, r := range radios {
			if (r.Checked != nil && *r.Checked) || mem.done[r.ID] {
				skip = true
			}
		}
		if skip {
			continue
		}
		want := ""
		if reEEO.MatchString(group) {
			for _, r := range radios {
				if reDecline.MatchString(r.Label) {
					want = r.Label
					break
				}
			}
		} else {
			want = fromAnswers(group, p, mem)
		}
		var pick *El
		if want != "" {
			prefix := u16slice(strings.ToLower(want), 3)
			for i := range radios {
				if strings.HasPrefix(strings.ToLower(radios[i].Label), prefix) {
					pick = &radios[i]
					break
				}
			}
			if pick == nil {
				for i := range radios {
					if overlap(radios[i].Label, want) > 0 {
						pick = &radios[i]
						break
					}
				}
			}
		}
		if pick != nil {
			mem.done[pick.ID] = true
			call("check", jsonObj("id", pick.ID, "checked", true))
		} else if missing == nil {
			for _, r := range radios {
				if r.Required {
					m := radios[0]
					m.Label = group
					missing = &m
					break
				}
			}
		}
	}
	if len(calls) > 0 {
		return calls
	}

	if missing != nil {
		key := missing.Label
		if key == "" {
			key = missing.ID
		}
		if !mem.asked[key] {
			mem.asked[key] = true
			call("ask_user", jsonObj("question", "「"+missing.Label+"」这一项资料库里没有，该填什么？", "field_label", missing.Label))
			return calls
		}
		call("need_manual", jsonObj("reason", "演示模式不会填「"+missing.Label+"」，请在浏览器里填好后点继续"))
		delete(mem.asked, key)
		return calls
	}

	var submit, next *El
	for i := range buttons {
		if reFinal.MatchString(buttons[i].Text) {
			submit = &buttons[i]
			break
		}
	}
	if submit == nil {
		for i := range buttons {
			if buttons[i].SubmitType && !reNext.MatchString(buttons[i].Text) {
				submit = &buttons[i]
				break
			}
		}
	}
	for i := range buttons {
		if reNext.MatchString(buttons[i].Text) && !mem.done[buttons[i].ID] {
			next = &buttons[i]
			break
		}
	}
	switch {
	case submit != nil:
		mem.submitRequested++
		if mem.submitRequested > 3 {
			call("need_manual", jsonObj("reason", "提交后页面没有出现确认信息，请在浏览器里看一下"))
		} else {
			call("request_submit", jsonObj("id", submit.ID, "summary", "演示模式：已按资料库填写所有能识别的字段，请核对后确认。"))
		}
	case next != nil:
		mem.done[next.ID] = true
		call("click", jsonObj("id", next.ID))
	default:
		call("need_manual", jsonObj("reason", "演示模式没找到下一步或提交按钮"))
	}
	return calls
}

type StoredPoint struct {
	Text string `json:"text"`
	Src  string `json:"src"`
}

type StoredQuestion struct {
	Q      string      `json:"q"`
	Kind   string      `json:"kind"`
	Why    string      `json:"why"`
	Points []StoredPoint `json:"points"`
}

type PrepGap struct {
	Gap string `json:"gap"`
	How string `json:"how"`
}

type mockPrepOut struct {
	Pitch     string         `json:"pitch"`
	Questions []StoredQuestion `json:"questions"`
	ToAsk     []string       `json:"toAsk"`
	Gaps      []PrepGap      `json:"gaps"`
	Demo      string         `json:"_demo"`
}

var (
	reEducOrZh = jsRe(`educ|教育`, "i")
	reEndPunct = regexp.MustCompile(`[.!?。！？]$`)
	reLeadCap  = regexp.MustCompile(`^[A-Z]`)
)

// mockPrep: template interview questions built from the posting's keywords and the profile's bullets.
func mockPrep(jd *JobJd, p Profile, lang string) any {
	zh := lang == "zh"
	type pb struct{ id, text, where string }
	bullets := []pb{}
	for _, s := range p.Sections {
		for _, e := range s.Entries {
			where := e.Title
			if where == "" {
				where = s.Heading
			}
			for _, b := range e.Bullets {
				bullets = append(bullets, pb{b.ID, b.Text, where})
			}
		}
	}
	allSkills := []string{}
	for _, g := range p.Skills {
		allSkills = append(allSkills, g.Items...)
	}
	skills := strings.ToLower(strings.Join(allSkills, " "))
	about := func(k string) []pb {
		out := []pb{}
		for _, b := range bullets {
			if strings.Contains(strings.ToLower(b.text), strings.ToLower(k)) && len(out) < 2 {
				out = append(out, b)
			}
		}
		return out
	}
	have, miss := []string{}, []string{}
	for _, k := range jd.Keywords {
		if len(about(k)) > 0 || strings.Contains(skills, strings.ToLower(k)) {
			have = append(have, k)
		}
	}
	for _, k := range jd.Keywords {
		if !contains(have, k) {
			miss = append(miss, k)
		}
	}
	var edu *Entry
	for _, s := range p.Sections {
		if reEducOrZh.MatchString(s.Heading) {
			if len(s.Entries) > 0 {
				edu = &s.Entries[0]
			}
			break
		}
	}
	name := p.Basics.Name
	if name == "" {
		name = "I"
	}
	// The pitch leads with work or a project, not a school bullet.
	var lead *pb
	for i := range bullets {
		isEdu := false
		for _, s := range p.Sections {
			if !reEducOrZh.MatchString(s.Heading) {
				continue
			}
			for _, e := range s.Entries {
				w := e.Title
				if w == "" {
					w = s.Heading
				}
				if w == bullets[i].where {
					isEdu = true
				}
			}
		}
		if !isEdu {
			lead = &bullets[i]
			break
		}
	}
	if lead == nil && len(bullets) > 0 {
		lead = &bullets[0]
	}
	sentence := func(t string) string {
		t = jsTrim(t)
		if reEndPunct.MatchString(t) {
			return t
		}
		return t + "."
	}
	role := jd.Title
	if role == "" {
		if zh {
			role = "这个岗位"
		} else {
			role = "this role"
		}
	}
	top3 := have[:min(3, len(have))]
	pick := func(a, b string) string {
		if zh {
			return a
		}
		return b
	}

	intro := StoredQuestion{Q: pick("先简单介绍一下你自己。", "Tell me about yourself."), Kind: "behavioral", Why: "几乎每场面试的开场题，用下面的自我介绍回答。", Points: []StoredPoint{}}
	if edu != nil {
		t := edu.Title
		if edu.Subtitle != "" {
			t += " · " + edu.Subtitle
		}
		intro.Points = append(intro.Points, StoredPoint{t, edu.ID})
	}
	for _, b := range bullets[:min(2, len(bullets))] {
		intro.Points = append(intro.Points, StoredPoint{b.where + ": " + b.text, b.id})
	}
	company := jd.Company
	why := StoredQuestion{Kind: "role", Why: "考察你对岗位和公司的了解、动机是否清楚。"}
	if zh {
		c := company
		if c == "" {
			c = "我们"
		}
		why.Q = "为什么想加入" + c + "、做" + role + "？"
	} else {
		at := ""
		if company != "" {
			at = " at " + company
		}
		why.Q = "Why do you want this " + role + " role" + at + "?"
	}
	if len(have) > 0 {
		why.Points = []StoredPoint{{pick("把岗位要的 "+strings.Join(top3, "、")+" 和你用过它们的经历对上", "Connect the "+strings.Join(top3, ", ")+" the role asks for with where you used them"), "tip"}}
	} else {
		why.Points = []StoredPoint{{pick("结合岗位描述讲你想学什么", "Connect what the role offers with what you want to learn"), "tip"}}
	}
	questions := []StoredQuestion{intro, why}
	for _, k := range have[:min(5, len(have))] {
		q := StoredQuestion{Q: pick("讲一个你用 "+k+" 做过的项目。", "Walk me through something you built with "+k+"."), Kind: "technical", Why: "岗位关键词里有 " + k + "，你的资料里也有，面试官大概率会深挖。", Points: []StoredPoint{}}
		if ab := about(k); len(ab) > 0 {
			for _, b := range ab {
				q.Points = append(q.Points, StoredPoint{b.where + ": " + b.text, b.id})
			}
		} else {
			q.Points = append(q.Points, StoredPoint{pick("技能栏里写了 "+k+"：准备一个具体例子", k+" is in your skills list: prepare one concrete example"), "tip"})
		}
		questions = append(questions, q)
	}
	for _, k := range miss[:min(2, len(miss))] {
		questions = append(questions, StoredQuestion{
			Q: pick("你对 "+k+" 熟悉吗？", "How familiar are you with "+k+"?"), Kind: "technical", Why: "岗位要 " + k + "，你的资料里没有。",
			Points: []StoredPoint{{pick("诚实说没用过 "+k+"，讲你会怎么上手，以及相近的经验", "Say honestly you have not used "+k+"; explain how you would pick it up and what is closest in your experience"), "tip"}},
		})
	}
	var pitch string
	if zh {
		pitch = "我是" + name
		if edu != nil {
			pitch += "，" + edu.Title + edu.Subtitle
		}
		pitch += "。"
		if lead != nil {
			pitch += "我做过" + lead.where + "：" + lead.text + "。"
		}
		if len(have) > 0 {
			pitch += " 这和" + role + "需要的 " + strings.Join(top3, "、") + " 很对口。"
		}
	} else {
		pitch = "I'm " + name
		if edu != nil {
			pitch += ", "
			if edu.Subtitle != "" {
				pitch += edu.Subtitle + " at "
			}
			pitch += edu.Title
		}
		pitch += "."
		if lead != nil {
			pitch += " At " + lead.where + ", I " + sentence(reLeadCap.ReplaceAllStringFunc(lead.text, strings.ToLower))
		}
		if len(have) > 0 {
			pitch += " That is why " + role + " fits me: it asks for " + strings.Join(top3, ", ") + ", which I have used."
		}
	}
	toAsk := []string{"What would success look like in the first three months?", "What does the team's stack and development process look like?", "How do you give feedback to interns or new joiners?"}
	if zh {
		toAsk = []string{"这个岗位前三个月最重要的事情是什么？", "团队现在的技术栈和开发流程是怎样的？", "你们怎么评价一个实习生 / 新人做得好？"}
	}
	gaps := []PrepGap{}
	if len(miss) > 0 {
		gaps = append(gaps, PrepGap{"资料里没有：" + strings.Join(miss[:min(4, len(miss))], "、"), "不要硬说会；讲相近经验和学习计划。"})
	}
	return toAny(mockPrepOut{Pitch: pitch, Questions: questions, ToAsk: toAsk, Gaps: gaps, Demo: "演示模式：按模板生成，不是模型写的"})
}

// mockDraft: demo-mode email drafts.
func mockDraft(kind string, jd *JobJd, p Profile, lang, extra string) (subject, body string) {
	name := p.Basics.Name
	role := jd.Title
	if role == "" {
		if lang == "zh" {
			role = "该岗位"
		} else {
			role = "the position"
		}
	}
	if lang == "zh" {
		if kind == "followup" {
			return "关于" + role + "的申请进度", "您好，\n\n我前段时间申请了贵司的" + role + "，想冒昧问一下目前的进度。我对这个岗位依然很感兴趣，期待有机会进一步沟通。\n\n谢谢！\n" + name
		}
		ex := ""
		if extra != "" {
			ex = "关于" + extra + "的讨论让我对团队有了更多了解。"
		}
		return "感谢面试机会 —— " + role, "您好，\n\n谢谢您今天抽时间和我聊" + role + "。" + ex + "我对这个机会很期待，如有需要补充的材料请随时告诉我。\n\n祝好，\n" + name
	}
	if kind == "followup" {
		at := ""
		if jd.Company != "" {
			at = " at " + jd.Company
		}
		return "Following up on my application: " + role, "Dear Hiring Team,\n\nI applied for the " + role + " position" + at + " a while ago and wanted to ask whether there is any update on my application. I remain very interested in the role and would welcome the chance to discuss it.\n\nThank you for your time.\n\nBest regards,\n" + name
	}
	ex := ""
	if extra != "" {
		ex = " I especially enjoyed our discussion about " + extra + "."
	}
	return "Thank you: " + role + " interview", "Dear Hiring Team,\n\nThank you for taking the time to speak with me about the " + role + " position." + ex + " The conversation made me even more excited about the role, and I would be glad to provide anything else you need.\n\nBest regards,\n" + name
}
