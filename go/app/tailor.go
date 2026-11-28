// Tailoring: the model picks, orders and rewords; this file rebuilds the resume from the master
// profile and rejects anything it cannot trace back to it.
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
	"time"
)

type TailorBullet struct {
	Src  string `json:"src"`
	Text string `json:"text"`
	Fact string `json:"fact,omitempty"`
}

type TailorEntry struct {
	ID       string         `json:"id"`
	Title    string         `json:"title,omitempty"`
	Subtitle *string        `json:"subtitle,omitempty"`
	Dates    *string        `json:"dates,omitempty"`
	Location *string        `json:"location,omitempty"`
	Bullets  []TailorBullet `json:"bullets,omitempty"`
}

type TailorSection struct {
	ID      string        `json:"id"`
	Heading string        `json:"heading,omitempty"`
	Entries []TailorEntry `json:"entries,omitempty"`
}

type TailorSkill struct {
	ID    string   `json:"id"`
	Items []string `json:"items"`
}

// TailorOutput is what the model (or demo mode) returns.
type TailorOutput struct {
	Summary        string          `json:"summary,omitempty"`
	Sections       []TailorSection `json:"sections,omitempty"`
	Skills         []TailorSkill   `json:"skills,omitempty"`
	SkillsPosition *float64        `json:"skillsPosition,omitempty"`
	Notes          []string        `json:"notes,omitempty"`
	CoverLetter    string          `json:"coverLetter,omitempty"`
}

type Coverage struct {
	Keywords []string `json:"keywords"`
	Before   []string `json:"before"`
	After    []string `json:"after"`
}

type Tailored struct {
	Doc ResumeDoc `json:"doc"`
	// Original text of every bullet the model rewrote, keyed by the new bullet id.
	Origin      map[string]string `json:"origin"`
	Notes       []string          `json:"notes"`
	Warnings    []string          `json:"warnings"`
	Coverage    Coverage          `json:"coverage"`
	GeneratedAt string            `json:"generatedAt"`
	Scale       *float64          `json:"scale,omitempty"`
}

func parseTailored(s *string) *Tailored {
	if s == nil || *s == "" {
		return nil
	}
	var t *Tailored
	if json.Unmarshal([]byte(*s), &t) != nil || t == nil {
		return nil
	}
	fixTailored(t)
	return t
}

func fixTailored(t *Tailored) {
	if t.Origin == nil {
		t.Origin = map[string]string{}
	}
	t.Notes = nonNil(t.Notes)
	t.Warnings = nonNil(t.Warnings)
	t.Coverage.Keywords = nonNil(t.Coverage.Keywords)
	t.Coverage.Before = nonNil(t.Coverage.Before)
	t.Coverage.After = nonNil(t.Coverage.After)
	t.Doc = normalizeDoc(t.Doc)
}

func normalizeDoc(d ResumeDoc) ResumeDoc {
	d.Sections = nonNil(d.Sections)
	for i := range d.Sections {
		d.Sections[i].Entries = nonNil(d.Sections[i].Entries)
		for j := range d.Sections[i].Entries {
			d.Sections[i].Entries[j].Bullets = nonNil(d.Sections[i].Entries[j].Bullets)
		}
	}
	d.Skills = nonNil(d.Skills)
	for i := range d.Skills {
		d.Skills[i].Items = nonNil(d.Skills[i].Items)
	}
	return d
}

var reNumber = regexp.MustCompile(`\d+(?:[.,]\d+)?%?`)

func norm(s string) string { return strings.ToLower(squashSpace(s)) }

func numbersIn(s string) []string {
	out := []string{}
	for _, n := range reNumber.FindAllString(s, -1) {
		out = append(out, strings.ReplaceAll(n, ",", ""))
	}
	return out
}

func docText(doc ResumeDoc) string {
	parts := []string{doc.Summary}
	for _, s := range doc.Sections {
		parts = append(parts, s.Heading)
		for _, e := range s.Entries {
			parts = append(parts, e.Title, e.Subtitle)
			for _, b := range e.Bullets {
				parts = append(parts, b.Text)
			}
		}
	}
	for _, g := range doc.Skills {
		parts = append(parts, g.Label)
		parts = append(parts, g.Items...)
	}
	return strings.Join(parts, "\n")
}

func coverage(doc ResumeDoc, keywords []string) []string {
	raw := docText(doc)
	t := norm(raw)
	// "ROS" is covered by "Robot Operating System", "Vue" by "Vue3".
	out := []string{}
	for _, k := range keywords {
		if strings.Contains(t, norm(k)) || mentions(raw, k) {
			out = append(out, k)
		}
	}
	return out
}

// profileHas reports whether the profile (resume and extra facts) mentions a skill, aliases included.
func profileHas(p Profile) func(string) bool {
	raw := docText(masterDoc(p)) + "\n" + p.ExtraFacts
	t := norm(raw)
	return func(k string) bool { return strings.Contains(t, norm(k)) || mentions(raw, k) }
}

func masterDoc(p Profile) ResumeDoc {
	return ResumeDoc{Basics: p.Basics, Summary: p.Summary, Sections: p.Sections, Skills: p.Skills, SkillsHeading: p.SkillsHeading, SkillsPosition: p.SkillsPosition}
}

type Assembled struct {
	Doc         ResumeDoc
	Origin      map[string]string
	Notes       []string
	Warnings    []string
	CoverLetter string
}

var (
	reEducation = jsRe(`education|学历|教育`, "i")
	reWordSplit = regexp.MustCompile(`[^A-Za-z0-9\x{4e00}-\x{9fff}]+`)
)

// assemble rebuilds a resume from the model's choices; everything structural comes from the master profile.
func assemble(master Profile, out TailorOutput, jd *JobJd) Assembled {
	warnings := []string{}
	origin := map[string]string{}
	facts := norm(master.ExtraFacts)
	profileTxt := norm(profileForPrompt(master, false) + "\n" + master.ExtraFacts)
	profileNumbers := map[string]bool{}
	for _, n := range numbersIn(profileTxt) {
		profileNumbers[n] = true
	}
	type bref struct {
		bullet Bullet
		entry  Entry
	}
	bulletByID := map[string]bref{}
	for _, s := range master.Sections {
		for _, e := range s.Entries {
			for _, b := range e.Bullets {
				bulletByID[b.ID] = bref{b, e}
			}
		}
	}

	// A rewritten bullet may only use numbers from its own entry (bullets of one entry can be merged).
	checkText := func(text, source, where string) string {
		srcNums := map[string]bool{}
		for _, n := range numbersIn(norm(source)) {
			srcNums[n] = true
		}
		bad := []string{}
		for _, n := range numbersIn(text) {
			if !srcNums[n] {
				bad = append(bad, n)
			}
		}
		if len(bad) > 0 {
			return where + "：数字 " + strings.Join(bad, ", ") + " 在原始资料里找不到，已改回原文"
		}
		srcLower := norm(source) + "\n" + profileTxt
		unknown := []string{}
		for _, k := range jd.Keywords {
			if strings.Contains(norm(text), norm(k)) && !strings.Contains(srcLower, norm(k)) {
				unknown = append(unknown, k)
			}
		}
		if len(unknown) > 0 {
			warnings = append(warnings, where+"：出现了资料里没有的「"+strings.Join(unknown, "」「")+"」，请核对是否属实")
		}
		return ""
	}

	findSection := func(id string) *Section {
		for i := range master.Sections {
			if master.Sections[i].ID == id {
				return &master.Sections[i]
			}
		}
		return nil
	}
	findEntry := func(ms *Section, id string) *Entry {
		if ms != nil {
			for i := range ms.Entries {
				if ms.Entries[i].ID == id {
					return &ms.Entries[i]
				}
			}
		}
		for si := range master.Sections {
			for i := range master.Sections[si].Entries {
				if master.Sections[si].Entries[i].ID == id {
					return &master.Sections[si].Entries[i]
				}
			}
		}
		return nil
	}

	sections := []Section{}
	usedEntries := map[string]bool{}
	for _, osec := range out.Sections {
		ms := findSection(osec.ID)
		if ms == nil && osec.Heading == "" {
			continue
		}
		entries := []Entry{}
		for _, oe := range osec.Entries {
			me := findEntry(ms, oe.ID)
			if me != nil && usedEntries[me.ID] {
				continue
			}
			bullets := []Bullet{}
			for _, ob := range oe.Bullets {
				text := jsTrim(ob.Text)
				if text == "" {
					continue
				}
				src, hasSrc := bulletByID[ob.Src]
				meID := "new"
				if me != nil {
					meID = me.ID
				}
				id := fmt.Sprintf("t_%d_%s_%d", len(bullets), meID, len(sections))
				switch {
				case hasSrc:
					entryText := strings.Join(append([]string{src.entry.Title, src.entry.Subtitle, src.entry.Dates}, bulletTexts(src.entry.Bullets)...), "\n")
					title := src.entry.Title
					if me != nil && me.Title != "" {
						title = me.Title
					}
					if problem := checkText(text, entryText, "「"+title+"」的一条要点"); problem != "" {
						warnings = append(warnings, problem)
						bullets = append(bullets, Bullet{ID: id, Text: src.bullet.Text})
					} else {
						bullets = append(bullets, Bullet{ID: id, Text: text})
						if norm(text) != norm(src.bullet.Text) {
							origin[id] = src.bullet.Text
						}
					}
				case ob.Src == "fact" && ob.Fact != "" && strings.Contains(facts, u16slice(norm(ob.Fact), 60)):
					if problem := checkText(text, master.ExtraFacts, "素材库里的一条"); problem != "" {
						warnings = append(warnings, problem)
						bullets = append(bullets, Bullet{ID: id, Text: jsTrim(ob.Fact)})
					} else {
						bullets = append(bullets, Bullet{ID: id, Text: text})
					}
					origin[id] = "（素材库）" + jsTrim(ob.Fact)
				default:
					warnings = append(warnings, "去掉了一条找不到出处的要点：「"+u16slice(text, 60)+"」")
				}
			}
			if me != nil {
				usedEntries[me.ID] = true
				e := *me
				if len(bullets) > 0 || len(me.Bullets) == 0 {
					e.Bullets = bullets
				} else {
					e.Bullets = me.Bullets[:min(2, len(me.Bullets))]
				}
				entries = append(entries, e)
			} else if len(bullets) > 0 && oe.Title != "" {
				// A new entry built from the extra facts: its header must be traceable too.
				missing := []string{}
				for _, w := range reWordSplit.Split(oe.Title+" "+deref(oe.Subtitle), -1) {
					if u16len(w) >= 3 && !strings.Contains(facts, strings.ToLower(w)) {
						missing = append(missing, w)
					}
				}
				if len(missing) > 0 {
					warnings = append(warnings, "新条目「"+oe.Title+"」里的 "+strings.Join(missing, ", ")+" 在素材库里找不到，请核对")
				}
				warnings = append(warnings, "新增了素材库里的条目「"+oe.Title+"」，请核对标题和日期")
				entries = append(entries, Entry{ID: fmt.Sprintf("new_%d_%d", len(entries), len(sections)), Title: oe.Title, Subtitle: deref(oe.Subtitle), Dates: deref(oe.Dates), Location: deref(oe.Location), Bullets: bullets})
			}
		}
		if len(entries) > 0 {
			id, heading := fmt.Sprintf("newsec_%d", len(sections)), osec.Heading
			if ms != nil {
				id, heading = ms.ID, ms.Heading
			}
			sections = append(sections, Section{ID: id, Heading: heading, Entries: entries})
		}
	}

	// Education is never dropped.
	for _, ms := range master.Sections {
		if !reEducation.MatchString(ms.Heading) {
			continue
		}
		found := false
		for _, s := range sections {
			if s.ID == ms.ID {
				found = true
			}
		}
		if !found {
			sections = append([]Section{ms}, sections...)
			warnings = append(warnings, "模型漏掉了教育经历，已按原样补回")
		}
	}

	allSkills := map[string]string{}
	for _, g := range master.Skills {
		for _, it := range g.Items {
			allSkills[norm(it)] = it
		}
	}
	skills := []SkillGroup{}
	for _, og := range out.Skills {
		var mg *SkillGroup
		for i := range master.Skills {
			if master.Skills[i].ID == og.ID {
				mg = &master.Skills[i]
				break
			}
		}
		if mg == nil {
			continue
		}
		items := []string{}
		for _, it := range og.Items {
			if hit, ok := allSkills[norm(it)]; ok {
				items = append(items, hit)
			} else if strings.Contains(facts, norm(it)) {
				items = append(items, jsTrim(it))
				warnings = append(warnings, "技能「"+it+"」来自素材库，请核对")
			} else {
				warnings = append(warnings, "去掉了资料里没有的技能「"+it+"」")
			}
		}
		g := *mg
		g.Items = uniq(items)
		if len(g.Items) > 0 {
			skills = append(skills, g)
		}
	}

	summary := jsTrim(out.Summary)
	if summary != "" {
		bad := []string{}
		for _, n := range numbersIn(summary) {
			if !profileNumbers[n] {
				bad = append(bad, n)
			}
		}
		if len(bad) > 0 {
			warnings = append(warnings, "简介里的数字 "+strings.Join(bad, ", ")+" 找不到出处，简介已去掉")
			summary = ""
		}
	}
	coverLetter := jsTrim(out.CoverLetter)
	warnings = append(warnings, coverLetterWarnings(master, coverLetter, jd)...)

	doc := ResumeDoc{Basics: master.Basics, Summary: summary, Sections: sections, Skills: skills, SkillsHeading: master.SkillsHeading, SkillsPosition: master.SkillsPosition}
	if len(sections) == 0 {
		doc.Sections = master.Sections
	}
	if len(skills) == 0 {
		doc.Skills = master.Skills
	}
	if out.SkillsPosition != nil && !math.IsNaN(*out.SkillsPosition) && !math.IsInf(*out.SkillsPosition, 0) {
		doc.SkillsPosition = int(math.Max(0, math.Floor(*out.SkillsPosition)))
	}
	return Assembled{Doc: doc, Origin: origin, Notes: nonNil(out.Notes), Warnings: warnings, CoverLetter: coverLetter}
}

func bulletTexts(bs []Bullet) []string {
	out := make([]string, len(bs))
	for i, b := range bs {
		out[i] = b.Text
	}
	return out
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// coverLetterWarnings: numbers in a cover letter that neither the profile nor the posting's title and company contain.
func coverLetterWarnings(master Profile, text string, jd *JobJd) []string {
	profileNumbers := map[string]bool{}
	for _, n := range numbersIn(norm(profileForPrompt(master, false) + "\n" + master.ExtraFacts)) {
		profileNumbers[n] = true
	}
	bad := []string{}
	for _, n := range numbersIn(text) {
		if !profileNumbers[n] && !strings.Contains(norm(jd.Title+jd.Company), n) {
			bad = append(bad, n)
		}
	}
	if len(bad) > 0 {
		return []string{"求职信里的数字 " + strings.Join(bad, ", ") + " 找不到出处，请核对"}
	}
	return []string{}
}

// wantsCoverLetter: write one when the settings say always, or when this posting asks for one.
func wantsCoverLetter(always bool, jd *JobJd) bool { return always || asksCoverLetter(jd) }

func coverAsk(jd *JobJd) string {
	if jd.Facts != nil && jd.Facts.CoverLetterAsk != "" {
		return "\nThe posting asks the cover letter to address: " + jd.Facts.CoverLetterAsk
	}
	return ""
}

func tailorSystem(lang string, withCover bool) string {
	language := "English"
	if lang == "zh" {
		language = "Simplified Chinese"
	}
	cover := `""`
	if withCover {
		cover = `string (in the posting's language, 3 short paragraphs, ≤220 words, addressed "Dear Hiring Manager," and signed with the candidate's name; only facts; if the posting says what the letter should address, answer that with true facts)`
	}
	return `You tailor a candidate's resume to one job posting. Return JSON only.

HARD RULES
1. Use only facts in PROFILE or EXTRA FACTS. Never invent employers, titles, dates, numbers, metrics, tools, technologies, or achievements. If the job asks for something the candidate lacks, leave it out.
2. You may: choose which sections, entries and bullets to include; reorder them so the most relevant come first; reword a bullet to use the posting's vocabulary when it stays true; tighten wording; merge two bullets of the same entry.
3. Every bullet must cite "src": the [id] of the profile bullet it is based on, or "fact" plus "fact": the exact sentence copied from EXTRA FACTS.
4. Refer to existing sections and entries by their [id]. A genuinely new entry (only from EXTRA FACTS, e.g. an internship or project missing from the resume) uses "id":"new" with title, subtitle, dates, location — copied from the facts. A new section uses "id":"new" and "heading".
5. Skills: refer to skill groups by [id]; list only items that appear in the profile skills (or EXTRA FACTS); put the most relevant first; drop irrelevant ones.
6. Fit one A4 page: about 14-18 bullets in total, each under ~25 words. Always keep Education. Prefer dropping old school activities over relevant work.
7. Write the resume in ` + language + `.

JSON SHAPE
{"summary": string (optional, ≤2 sentences, only facts; "" if not useful),
 "sections": [{"id": string, "heading"?: string, "entries": [{"id": string, "title"?: string, "subtitle"?: string, "dates"?: string, "location"?: string, "bullets": [{"src": string, "text": string, "fact"?: string}]}]}],
 "skills": [{"id": string, "items": string[]}],
 "skillsPosition": number (index among your sections before which the skills block goes),
 "notes": string[] (3-6 short notes in Simplified Chinese: what you emphasised or dropped and why),
 "coverLetter": ` + cover + `}`
}

const coverSystem = `You write a cover letter for one job posting from a candidate's profile. Return JSON {"coverLetter": string}.
- Use only facts in PROFILE or EXTRA FACTS. Never invent employers, titles, dates, numbers, tools or achievements; if the job wants something the candidate lacks, do not claim it.
- In the posting's language, 3 short paragraphs, at most 220 words, addressed "Dear Hiring Manager," and signed with the candidate's name.
- If the posting says what the letter should address, answer that with true facts.`

// parseTailorOutput reads the model's answer loosely, as the TS code trusts its shape but tolerates gaps.
func parseTailorOutput(raw any) TailorOutput {
	out := TailorOutput{}
	if s, ok := get(raw, "summary").(string); ok {
		out.Summary = s
	}
	sstr := func(v any) string {
		if s, ok := v.(string); ok {
			return s
		}
		return ""
	}
	optStr := func(m map[string]any, k string) *string {
		if s, ok := m[k].(string); ok {
			return &s
		}
		return nil
	}
	for _, s := range arr(get(raw, "sections")) {
		m := obj(s)
		if m == nil {
			continue
		}
		sec := TailorSection{ID: jsString(m["id"]), Heading: sstr(m["heading"])}
		for _, e := range arr(m["entries"]) {
			em := obj(e)
			if em == nil {
				continue
			}
			ent := TailorEntry{ID: jsString(em["id"]), Title: sstr(em["title"]), Subtitle: optStr(em, "subtitle"), Dates: optStr(em, "dates"), Location: optStr(em, "location")}
			for _, b := range arr(em["bullets"]) {
				bm := obj(b)
				if bm == nil {
					continue
				}
				ent.Bullets = append(ent.Bullets, TailorBullet{Src: jsString(bm["src"]), Text: jsString(bm["text"]), Fact: sstr(bm["fact"])})
			}
			sec.Entries = append(sec.Entries, ent)
		}
		out.Sections = append(out.Sections, sec)
	}
	for _, g := range arr(get(raw, "skills")) {
		gm := obj(g)
		if gm == nil {
			continue
		}
		items := []string{}
		for _, it := range arr(gm["items"]) {
			items = append(items, jsString(it))
		}
		out.Skills = append(out.Skills, TailorSkill{ID: jsString(gm["id"]), Items: items})
	}
	if f, ok := get(raw, "skillsPosition").(float64); ok {
		out.SkillsPosition = &f
	}
	for _, n := range arr(get(raw, "notes")) {
		if s, ok := n.(string); ok {
			out.Notes = append(out.Notes, s)
		}
	}
	if s, ok := get(raw, "coverLetter").(string); ok {
		out.CoverLetter = s
	}
	return out
}

type CoverResult struct {
	File     string   `json:"file"`
	Text     string   `json:"text"`
	Warnings []string `json:"warnings"`
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// writeCoverLetter writes a cover letter for a job that has none, when a form asks for one mid-application. Also writes its PDF.
func writeCoverLetter(id int64) (CoverResult, error) {
	job := getJob(id)
	if job == nil {
		return CoverResult{}, errors.New("岗位不存在")
	}
	if jsTrim(sv(job.CoverLetter)) != "" && job.CoverFile != nil && fileExists(*job.CoverFile) {
		return CoverResult{File: *job.CoverFile, Text: *job.CoverLetter, Warnings: []string{}}, nil
	}
	jd := jobJd(job)
	if jd == nil {
		return CoverResult{}, errors.New("先解析岗位")
	}
	if ready := llmReady(); !ready.OK {
		return CoverResult{}, errors.New(ready.Reason)
	}
	master := getProfile()
	var text string
	if isDemo() {
		text = "Dear Hiring Manager,\n\nI am applying for the " + jd.Title + " role at " + jd.Company + ".\n\n（演示模式：没有调用模型）\n\n" + master.Basics.Name
	} else {
		facts := master.ExtraFacts
		if facts == "" {
			facts = "(none)"
		}
		raw, err := chatJSON(coverSystem, "PROFILE\n"+profileForPrompt(master, false)+"\n\nEXTRA FACTS\n"+facts+"\n\nJOB POSTING\nTitle: "+jd.Title+"\nCompany: "+jd.Company+"\nRequirements:\n- "+strings.Join(jd.Requirements, "\n- ")+coverAsk(jd)+"\n\nFull text:\n"+u16slice(trimPosting(sv(job.JDText), job.URL), 6000), 1500, &UsageTag{JobID: id, Kind: "tailor"})
		if err != nil {
			return CoverResult{}, err
		}
		text, _ = get(raw, "coverLetter").(string)
	}
	text = jsTrim(text)
	if text == "" {
		return CoverResult{}, errors.New("没写出求职信")
	}
	warnings := coverLetterWarnings(master, text, jd)
	if parseTailored(job.Tailored) == nil {
		if err := renderMasterFiles(id); err != nil {
			return CoverResult{}, err
		}
	}
	t := parseTailored(getJob(id).Tailored)
	if len(warnings) > 0 {
		t.Warnings = append(t.Warnings, warnings...)
	}
	setJob(id, P{"cover_letter": text, "tailored": jsonStr(t)})
	if err := renderJobFiles(id); err != nil {
		return CoverResult{}, err
	}
	return CoverResult{File: sv(getJob(id).CoverFile), Text: text, Warnings: warnings}, nil
}

func tailorJob(id int64) error {
	job := getJob(id)
	if job == nil {
		return nil
	}
	jd := jobJd(job)
	if jd == nil {
		return errors.New("先解析岗位")
	}
	if ready := llmReady(); !ready.OK {
		return errors.New(ready.Reason)
	}
	master := getProfile()
	if len(master.Sections) == 0 {
		return errors.New("资料库是空的：先到「资料库」填写或导入简历")
	}
	settings := GetSettings()
	lang := settings.ResumeLanguage
	if lang == "auto" {
		lang = jd.Language
	}
	var out TailorOutput
	if isDemo() {
		out = mockTailor(master, jd)
	} else {
		facts := master.ExtraFacts
		if facts == "" {
			facts = "(none)"
		}
		// PROFILE first, the same in every tailoring call, so DeepSeek can serve it from its cache.
		user := "PROFILE\n" + profileForPrompt(master, true) + "\n\nEXTRA FACTS\n" + facts + "\n\nJOB POSTING\nTitle: " + jd.Title + "\nCompany: " + jd.Company + "\nLocation: " + jd.Location + "\nRequirements:\n- " + strings.Join(jd.Requirements, "\n- ") + "\nNice to have:\n- " + strings.Join(jd.NiceToHave, "\n- ") + "\nKeywords: " + strings.Join(jd.Keywords, ", ") + coverAsk(jd) + "\n\nFull text:\n" + u16slice(trimPosting(sv(job.JDText), job.URL), 8000)
		raw, err := chatJSON(tailorSystem(lang, wantsCoverLetter(settings.CoverLetter, jd)), user, 6000, &UsageTag{JobID: id, Kind: "tailor"})
		if err != nil {
			return err
		}
		out = parseTailorOutput(raw)
	}
	built := assemble(master, out, jd)
	tailored := Tailored{
		Doc:         built.Doc,
		Origin:      built.Origin,
		Notes:       built.Notes,
		Warnings:    built.Warnings,
		Coverage:    Coverage{Keywords: nonNil(jd.Keywords), Before: coverage(masterDoc(master), jd.Keywords), After: coverage(built.Doc, jd.Keywords)},
		GeneratedAt: isoNow(),
	}
	setJob(id, P{"tailored": jsonStr(tailored), "cover_letter": nullIfEmpty(built.CoverLetter)})
	if err := renderJobFiles(id); err != nil {
		return err
	}
	stage := "tailored"
	if job.Stage == "applied" {
		stage = "applied"
	}
	setJob(id, P{"stage": stage, "busy": nil, "error": nil, "notice": nil})
	return nil
}

// renderJobFiles (re)writes the job's resume and cover letter PDFs from what is saved.
func renderJobFiles(id int64) error {
	job := getJob(id)
	t := parseTailored(job.Tailored)
	if t == nil {
		return errors.New("还没有定制简历")
	}
	base := fileBaseName(t.Doc)
	dir := filepath.Join(FilesDir, fmt.Sprintf("job-%d", id))
	resumePath := filepath.Join(dir, base+"_Resume.pdf")
	scale, err := writePdf(resumePath, func(s float64) string { return resumeHtml(t.Doc, s) }, true)
	if err != nil {
		return err
	}
	var coverPath any
	if jsTrim(sv(job.CoverLetter)) != "" {
		cp := filepath.Join(dir, base+"_Cover_Letter.pdf")
		letter := *job.CoverLetter
		if _, err := writePdf(cp, func(float64) string { return coverLetterHtml(t.Doc, letter) }, false); err != nil {
			return err
		}
		coverPath = cp
	}
	t.Scale = &scale
	setJob(id, P{"resume_file": resumePath, "cover_file": coverPath, "tailored": jsonStr(t)})
	return nil
}

// renderMasterFiles: the untailored resume, used when you apply without tailoring.
func renderMasterFiles(id int64) error {
	master := getProfile()
	tailored := Tailored{Doc: masterDoc(master), Origin: map[string]string{}, Notes: []string{"未定制：使用资料库原版简历"}, Warnings: []string{}, Coverage: Coverage{Keywords: []string{}, Before: []string{}, After: []string{}}, GeneratedAt: isoNow()}
	setJob(id, P{"tailored": jsonStr(tailored)})
	return renderJobFiles(id)
}

func queueTailor(id int64, then func()) {
	setJob(id, P{"busy": "tailoring", "error": nil})
	bgQueue.Push(func() {
		if err := catch(func() error { return tailorJob(id) }); err != nil {
			setJob(id, P{"busy": nil, "error": err.Error()})
			return
		}
		if then != nil {
			then()
		}
	})
}

var _ = time.Now
