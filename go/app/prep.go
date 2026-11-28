// After applying: interview prep (likely questions with talking points from the profile) and short
// email drafts (a follow-up, a thank-you). Same rule as tailoring: only facts from the profile.
package app

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

var DraftKinds = []string{"followup", "thanks"}

var (
	prepMu     sync.Mutex
	prepping   = map[int64]bool{}
	prepErrors = map[int64]string{}
)

func prepState(id int64) (bool, *string) {
	prepMu.Lock()
	defer prepMu.Unlock()
	var e *string
	if v, ok := prepErrors[id]; ok {
		e = &v
	}
	return prepping[id], e
}

type prepCtx struct {
	job              *Job
	jd               *JobJd
	profile          Profile
	lang, langName   string
	posting          string
	candidate        string
	candidateWithIDs string
}

func prepContext(id int64) (*prepCtx, error) {
	job := getJob(id)
	if job == nil {
		return nil, errors.New("岗位不存在")
	}
	jd := jobJd(job)
	if jd == nil {
		return nil, errors.New("先读取岗位")
	}
	if ready := llmReady(); !ready.OK {
		return nil, errors.New(ready.Reason)
	}
	profile := getProfile()
	if len(profile.Sections) == 0 {
		return nil, errors.New("资料库是空的：先到「资料库」填写或导入简历")
	}
	s := GetSettings()
	lang := s.ResumeLanguage
	if lang == "auto" {
		lang = jd.Language
	}
	langName := "English"
	if lang == "zh" {
		langName = "Simplified Chinese"
	}
	facts := profile.ExtraFacts
	if facts == "" {
		facts = "(none)"
	}
	posting := "Title: " + jd.Title + "\nCompany: " + jd.Company + "\nLocation: " + jd.Location + "\nRequirements:\n- " + strings.Join(jd.Requirements, "\n- ") + "\nNice to have:\n- " + strings.Join(jd.NiceToHave, "\n- ") + "\nKeywords: " + strings.Join(jd.Keywords, ", ") + "\n\nFull text:\n" + u16slice(trimPosting(sv(job.JDText), job.URL), 8000)
	return &prepCtx{
		job: job, jd: jd, profile: profile, lang: lang, langName: langName, posting: posting,
		candidate:        profileForPrompt(profile, false) + "\n\nEXTRA FACTS\n" + facts,
		candidateWithIDs: profileForPrompt(profile, true) + "\n\nEXTRA FACTS\n" + facts,
	}, nil
}

func prepSystem(langName string) string {
	return `You coach a candidate for the interviews of one specific job.
Use ONLY facts from CANDIDATE (the profile, whose lines carry [ids], and EXTRA FACTS). Never invent experience, employers, tools, tests, methods, durations, team sizes, numbers or results: if CANDIDATE does not say they did it, they did not. Where the candidate lacks something the job needs, say so plainly and suggest an honest way to handle it.
Every talking point is one of two kinds:
- experience: something CANDIDATE says the candidate did or has. "src" is the [id] of the profile line it comes from (a bullet, an entry or a skills group), or "fact" with "fact" set to the exact sentence copied from EXTRA FACTS. Stay within what that line says.
- tip: advice on how to answer (structure, what to explain, what to admit). "src" is "tip". It must be phrased as advice ("Explain…", "Walk through…", "Admit that…") and must not describe anything as done by the candidate.
Return JSON:
{"pitch": string (a 30-45 second self-introduction for this role, first person, in ` + langName + `, only facts from CANDIDATE),
 "questions": [{"q": string (in ` + langName + `), "kind": "behavioral" | "technical" | "role" | "resume", "why": string (one sentence in Simplified Chinese: why an interviewer for this role would ask it), "points": [{"text": string (in ` + langName + `), "src": string, "fact"?: string}] (2-4 points; prefer experience points, use tips where CANDIDATE has nothing relevant)}]
   (8-12 questions, the ones most likely for THIS posting: its must-haves and keywords, and what on the candidate's resume an interviewer would probe),
 "toAsk": string[] (3-5 questions for the candidate to ask the interviewer, in ` + langName + `, specific to this role and company),
 "gaps": [{"gap": string (Simplified Chinese), "how": string (Simplified Chinese: an honest way to handle it in the interview)}] (0-4 items)}`
}

// queuePrep starts writing the prep in the background; the job emits when it is done.
func queuePrep(id int64) error {
	prepMu.Lock()
	busy := prepping[id]
	prepMu.Unlock()
	if busy {
		return nil
	}
	ctx, err := prepContext(id) // fails early (no profile, no key) so the button can say why
	if err != nil {
		return err
	}
	prepMu.Lock()
	prepping[id] = true
	delete(prepErrors, id)
	prepMu.Unlock()
	emit("job", id)
	goSafely("prep", func() {
		err := catch(func() error {
			var raw any
			if isDemo() {
				raw = mockPrep(ctx.jd, ctx.profile, ctx.lang)
			} else {
				var err error
				raw, err = chatJSON(prepSystem(ctx.langName), "JOB POSTING\n"+ctx.posting+"\n\nCANDIDATE\n"+ctx.candidateWithIDs, 5000, &UsageTag{JobID: id, Kind: "prep"})
				if err != nil {
					return err
				}
			}
			prep := normalizePrep(raw)
			if len(prep.Questions) == 0 {
				return errors.New("模型没有给出面试题，再试一次")
			}
			if getJob(id) != nil {
				setJob(id, P{"prep": jsonStr(prep)})
			}
			return nil
		})
		prepMu.Lock()
		if err != nil {
			prepErrors[id] = err.Error()
		}
		delete(prepping, id)
		prepMu.Unlock()
		emit("job", id)
	})
	return nil
}

var reClaim = jsRe(`^(i\s+|i've\s+|i have\s+)?(used|built|led|developed|implemented|created|designed|worked|completed|learned|collaborated|encountered|deployed|wrote|managed|optimi[sz]ed|debugged|resolved|identified|overcame|applied|conducted|participated)\b|^我(做|用|负责|参与|完成|写|学|搭|开发|设计|带)`, "i")

var reBrackets = regexp.MustCompile(`^\[|\]$`)

// PrepPointView: fact = experience from the profile (from = where); tip = how to answer; unsure = reads like
// experience but has no source, or names something the profile lacks (from = why).
type PrepPointView struct {
	Text string `json:"text"`
	Kind string `json:"kind"`
	From string `json:"from"`
}

// checkPoint sorts a talking point into fact / tip / unsure by checking its source against the profile.
func checkPoint(raw any, p Profile, keywords []string) PrepPointView {
	text := ""
	if s, ok := raw.(string); ok {
		text = jsTrim(s)
	} else if s, ok := get(raw, "text").(string); ok {
		text = jsTrim(s)
	}
	src := ""
	if s, ok := get(raw, "src").(string); ok {
		src = reBrackets.ReplaceAllString(jsTrim(s), "")
	}
	if strings.ToLower(src) == "tip" {
		if reClaim.MatchString(text) {
			return PrepPointView{text, "unsure", "写得像你做过的事，但没有标出处"}
		}
		return PrepPointView{text, "tip", ""}
	}
	where := map[string]string{}
	for _, s := range p.Sections {
		where[s.ID] = s.Heading
		for _, e := range s.Entries {
			w := e.Title
			if w == "" {
				w = s.Heading
			}
			where[e.ID] = w
			for _, b := range e.Bullets {
				where[b.ID] = w
			}
		}
	}
	for _, g := range p.Skills {
		where[g.ID] = strOr2(g.Label, "技能")
	}
	from := where[src]
	if fact, ok := get(raw, "fact").(string); from == "" && src == "fact" && ok && jsTrim(fact) != "" && strings.Contains(norm(p.ExtraFacts), norm(fact)) {
		from = "素材库"
	}
	if from == "" {
		return PrepPointView{text, "unsure", "资料库里找不到出处"}
	}
	ptext := profileText(p)
	if missing := unsupportedTerms(text, ptext, keywords); len(missing) > 0 {
		return PrepPointView{text, "unsure", "出自「" + from + "」，但资料库里没有 " + strings.Join(missing, "、")}
	}
	nums := map[string]bool{}
	for _, n := range numbersIn(ptext) {
		nums[n] = true
	}
	bad := []string{}
	for _, n := range numbersIn(text) {
		if !nums[n] {
			bad = append(bad, n)
		}
	}
	if len(bad) > 0 {
		return PrepPointView{text, "unsure", "出自「" + from + "」，但资料库里没有 " + strings.Join(bad, "、") + " 这个数字"}
	}
	return PrepPointView{text, "fact", from}
}

type storedPointOut struct {
	Text string `json:"text"`
	Src  string `json:"src"`
	Fact string `json:"fact,omitempty"`
}

type storedQuestionOut struct {
	Q      string           `json:"q"`
	Kind   string           `json:"kind"`
	Why    string           `json:"why"`
	Points []storedPointOut `json:"points"`
}

type StoredPrep struct {
	Pitch       string              `json:"pitch"`
	Questions   []storedQuestionOut `json:"questions"`
	ToAsk       []string            `json:"toAsk"`
	Gaps        []PrepGap           `json:"gaps"`
	GeneratedAt string              `json:"generatedAt"`
}

func normalizePrep(raw any) StoredPrep {
	s := func(v any) string {
		if x, ok := v.(string); ok {
			return jsTrim(x)
		}
		return ""
	}
	kinds := []string{"behavioral", "technical", "role", "resume"}
	out := StoredPrep{Pitch: s(get(raw, "pitch")), Questions: []storedQuestionOut{}, ToAsk: []string{}, Gaps: []PrepGap{}, GeneratedAt: isoNow()}
	for _, qv := range arr(get(raw, "questions")) {
		q := storedQuestionOut{Q: s(get(qv, "q")), Kind: "role", Why: s(get(qv, "why")), Points: []storedPointOut{}}
		if k, ok := get(qv, "kind").(string); ok && contains(kinds, k) {
			q.Kind = k
		}
		for _, pv := range arr(get(qv, "points")) {
			t := get(pv, "text")
			if t == nil {
				t = pv
			}
			pt := storedPointOut{Text: s(t), Src: s(get(pv, "src")), Fact: s(get(pv, "fact"))}
			if pt.Text != "" && len(q.Points) < 5 {
				q.Points = append(q.Points, pt)
			}
		}
		if q.Q != "" && len(out.Questions) < 15 {
			out.Questions = append(out.Questions, q)
		}
	}
	for _, x := range arr(get(raw, "toAsk")) {
		if t := s(x); t != "" && len(out.ToAsk) < 6 {
			out.ToAsk = append(out.ToAsk, t)
		}
	}
	for _, g := range arr(get(raw, "gaps")) {
		pg := PrepGap{Gap: s(get(g, "gap")), How: s(get(g, "how"))}
		if pg.Gap != "" && len(out.Gaps) < 5 {
			out.Gaps = append(out.Gaps, pg)
		}
	}
	return out
}

// prepView is the saved prep with every point and the pitch checked against the profile as it is now.
func prepView(raw any, p Profile, jd *JobJd) any {
	m := obj(raw)
	if m == nil {
		return nil
	}
	qs, ok := m["questions"].([]any)
	if !ok {
		return nil
	}
	ptext := profileText(p)
	nums := map[string]bool{}
	for _, n := range numbersIn(ptext) {
		nums[n] = true
	}
	keywords := []string{}
	if jd != nil {
		keywords = jd.Keywords
	}
	pitch, _ := m["pitch"].(string)
	warnings := []string{}
	for _, t := range unsupportedTerms(pitch, ptext, keywords) {
		warnings = append(warnings, "提到了 "+t+"，资料库里没有")
	}
	for _, n := range numbersIn(pitch) {
		if !nums[n] {
			warnings = append(warnings, "数字 "+n+" 资料库里没有")
		}
	}
	out := map[string]any{}
	for k, v := range m {
		out[k] = v
	}
	out["pitchWarnings"] = warnings
	questions := []any{}
	for _, qv := range qs {
		qm := map[string]any{}
		for k, v := range obj(qv) {
			qm[k] = v
		}
		points := []any{}
		for _, pv := range arr(get(qv, "points")) {
			switch {
			case func() bool { _, ok := pv.(string); return ok }():
				points = append(points, PrepPointView{pv.(string), "unsure", "早先生成的，没有标出处：重新生成一次"})
			case func() bool { _, k := get(pv, "kind").(string); _, s := get(pv, "src").(string); return k && !s }():
				points = append(points, pv)
			default:
				points = append(points, checkPoint(pv, p, keywords))
			}
		}
		qm["points"] = points
		questions = append(questions, qm)
	}
	out["questions"] = questions
	return out
}

type StoredDraft struct {
	Subject     string `json:"subject"`
	Body        string `json:"body"`
	Extra       string `json:"extra"`
	GeneratedAt string `json:"generatedAt"`
}

type DraftView struct {
	StoredDraft
	Warnings []string `json:"warnings"`
}

// draftWarnings: tools an email names that neither the profile nor the user's notes mention.
func draftWarnings(d StoredDraft, p Profile, jd *JobJd) []string {
	keywords := []string{}
	if jd != nil {
		keywords = jd.Keywords
	}
	out := []string{}
	for _, t := range unsupportedTerms(d.Subject+"\n"+d.Body, profileText(p)+"\n"+d.Extra, keywords) {
		out = append(out, "提到了 "+t+"，资料库里没有：说的是对方的技术就没事，别写成你会")
	}
	return out
}

func draftsView(raw any, p Profile, jd *JobJd) map[string]any {
	out := map[string]any{}
	for _, k := range DraftKinds {
		v := get(raw, k)
		if !truthy(get(v, "body")) {
			continue
		}
		d := StoredDraft{Subject: jsString(get(v, "subject")), Body: jsString(get(v, "body")), Extra: jsString(get(v, "extra")), GeneratedAt: jsString(get(v, "generatedAt"))}
		m := map[string]any{}
		for kk, vv := range obj(v) {
			m[kk] = vv
		}
		m["warnings"] = draftWarnings(d, p, jd)
		out[k] = m
	}
	return out
}

func draftSystem(kind, langName string, days *float64) string {
	var body string
	if kind == "followup" {
		when := "recently"
		if days != nil && *days >= 2 {
			when = strconv.FormatFloat(math.Round(*days), 'f', -1, 64) + " days ago"
		}
		body = "It follows up on an application submitted " + when + " with no reply yet: ask politely about the status, restate interest in one sentence that cites one concrete, relevant fact from CANDIDATE. At most 120 words."
	} else {
		body = "It thanks the interviewer(s) after an interview: thank them, recall what NOTES says was discussed (if NOTES is empty, stay general but specific to this role), restate interest with one concrete, relevant fact from CANDIDATE. At most 150 words."
	}
	return `You write one short, polite email for a job candidate, in ` + langName + `.
` + body + `
Use only facts from CANDIDATE; never invent experience, numbers or details of the interview. Address it to the person NOTES names, otherwise "Dear Hiring Team," (or "您好，" in Chinese). Sign with the candidate's name. No placeholders in brackets.
Return JSON {"subject": string, "body": string}.`
}

func makeDraft(id int64, kind, extra string) (DraftView, error) {
	ctx, err := prepContext(id)
	if err != nil {
		return DraftView{}, err
	}
	var days *float64
	if ctx.job.AppliedAt != nil && *ctx.job.AppliedAt != "" {
		if d, ok := daysSinceSQL(*ctx.job.AppliedAt); ok {
			days = &d
		} else {
			nan := math.NaN()
			days = &nan
		}
	}
	var subject, body string
	if isDemo() {
		subject, body = mockDraft(kind, ctx.jd, ctx.profile, ctx.lang, extra)
	} else {
		notes := extra
		if notes == "" {
			notes = "(none)"
		}
		raw, err := chatJSON(draftSystem(kind, ctx.langName, days), "JOB POSTING\n"+u16slice(ctx.posting, 3000)+"\n\nCANDIDATE\n"+ctx.candidate+"\n\nNOTES\n"+notes, 1200, &UsageTag{JobID: id, Kind: "email"})
		if err != nil {
			return DraftView{}, err
		}
		if s, ok := get(raw, "subject").(string); ok {
			subject = s
		}
		if s, ok := get(raw, "body").(string); ok {
			body = s
		}
	}
	draft := StoredDraft{Subject: jsTrim(subject), Body: jsTrim(body), Extra: extra, GeneratedAt: isoNow()}
	if draft.Body == "" {
		return DraftView{}, errors.New("模型没有写出邮件，再试一次")
	}
	drafts := map[string]any{}
	if j := getJob(id); j != nil && j.Drafts != nil {
		if v, ok := parseAny(*j.Drafts); ok {
			if m := obj(v); m != nil {
				drafts = m
			}
		}
	}
	drafts[kind] = draft
	setJob(id, P{"drafts": jsonStr(drafts)})
	return DraftView{StoredDraft: draft, Warnings: draftWarnings(draft, ctx.profile, ctx.jd)}, nil
}
