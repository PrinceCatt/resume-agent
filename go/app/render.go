// Resume and cover letter as HTML (the UI previews it) and as PDF (what gets uploaded).
package app

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// ResumeDoc is the part of a profile a resume is printed from.
type ResumeDoc struct {
	Basics         Basics       `json:"basics"`
	Summary        string       `json:"summary"`
	Sections       []Section    `json:"sections"`
	Skills         []SkillGroup `json:"skills"`
	SkillsHeading  string       `json:"skillsHeading"`
	SkillsPosition int          `json:"skillsPosition"`
}

var htmlEsc = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")

func esc(s string) string { return htmlEsc.Replace(s) }

func contactLine(doc ResumeDoc) string {
	b := doc.Basics
	phone := ""
	if b.Phone != "" {
		if b.PhoneCountryCode != "" && !strings.HasPrefix(b.Phone, "+") {
			phone = b.PhoneCountryCode + " "
		}
		phone += b.Phone
	}
	parts := []string{}
	for _, x := range []string{phone, b.Email, b.LinkedIn, b.GitHub, b.Website} {
		if x != "" {
			parts = append(parts, esc(x))
		}
	}
	return strings.Join(parts, " &bull; ")
}

func resumeHtml(doc ResumeDoc, scale float64) string {
	blocks := []string{}
	for _, s := range doc.Sections {
		var entries strings.Builder
		for _, e := range s.Entries {
			head, sub, bullets := "", "", ""
			if e.Title != "" || e.Dates != "" {
				head = `<div class="row"><span class="b">` + esc(e.Title) + `</span><span class="b">` + esc(e.Dates) + `</span></div>`
			}
			if e.Subtitle != "" || e.Location != "" {
				sub = `<div class="row"><span class="b">` + esc(e.Subtitle) + `</span><span>` + esc(e.Location) + `</span></div>`
			}
			if len(e.Bullets) > 0 {
				var li strings.Builder
				for _, x := range e.Bullets {
					li.WriteString("<li>" + esc(x.Text) + "</li>")
				}
				bullets = "<ul>" + li.String() + "</ul>"
			}
			entries.WriteString(`<div class="entry">` + head + sub + bullets + `</div>`)
		}
		blocks = append(blocks, "<section><h2>"+esc(s.Heading)+"</h2>"+entries.String()+"</section>")
	}
	skills := []SkillGroup{}
	for _, g := range doc.Skills {
		if len(g.Items) > 0 {
			skills = append(skills, g)
		}
	}
	if len(skills) > 0 {
		heading := doc.SkillsHeading
		if heading == "" {
			heading = "Skills"
		}
		var li strings.Builder
		for _, g := range skills {
			label := ""
			if g.Label != "" {
				label = `<span class="b">` + esc(g.Label) + `:</span> `
			}
			items := make([]string, len(g.Items))
			for i, it := range g.Items {
				items[i] = esc(it)
			}
			li.WriteString("<li>" + label + strings.Join(items, " | ") + "</li>")
		}
		html := "<section><h2>" + esc(heading) + "</h2><ul>" + li.String() + "</ul></section>"
		at := min(max(doc.SkillsPosition, 0), len(blocks))
		blocks = append(blocks[:at], append([]string{html}, blocks[at:]...)...)
	}
	summary := ""
	if doc.Summary != "" {
		summary = `<p class="summary">` + esc(doc.Summary) + `</p>`
	}
	f := func(x float64, d int) string { return fixed(x*scale, d) }
	return `<!doctype html><html><head><meta charset="utf-8"><title>` + esc(doc.Basics.Name) + ` Resume</title>
<style>
@page { size: A4; margin: 12mm 15mm; }
* { box-sizing: border-box; }
html { background: #fff; }
body { margin: 0; font-family: Arial, "Helvetica Neue", Helvetica, "Microsoft YaHei", sans-serif; color: #111; font-size: ` + f(10.6, 2) + `pt; line-height: 1.22; }
.page { width: 180mm; margin: 0 auto; }
header { text-align: right; margin-bottom: ` + f(6, 1) + `pt; }
header h1 { margin: 0; font-size: ` + f(21, 1) + `pt; letter-spacing: .3pt; text-transform: uppercase; }
header .contact { margin-top: 1pt; }
.summary { margin: 0 0 ` + f(4, 1) + `pt; }
section { margin-top: ` + f(8, 1) + `pt; }
h2 { margin: 0 0 ` + f(3, 1) + `pt; font-size: ` + f(11.6, 1) + `pt; text-transform: uppercase; border-bottom: 2.2pt double #111; padding-bottom: 1pt; }
.entry { margin-bottom: ` + f(4, 1) + `pt; break-inside: avoid; }
.row { display: flex; justify-content: space-between; gap: 12pt; }
.b { font-weight: 700; }
ul { margin: 1pt 0 0; padding-left: 16pt; }
li { margin: 0.6pt 0; }
</style></head><body><div class="page">
<header><h1>` + esc(doc.Basics.Name) + `</h1><div class="contact">` + contactLine(doc) + `</div></header>
` + summary + strings.Join(blocks, "\n") + `
</div></body></html>`
}

var reParaSplit = jsRe(`\n\s*\n`, "")

func coverLetterHtml(doc ResumeDoc, letter string) string {
	var paras strings.Builder
	for _, p := range reParaSplit.Split(letter, -1) {
		if t := jsTrim(p); t != "" {
			paras.WriteString("<p>" + strings.ReplaceAll(esc(t), "\n", "<br>") + "</p>")
		}
	}
	date := time.Now().Format("2 January 2006")
	return `<!doctype html><html><head><meta charset="utf-8"><title>` + esc(doc.Basics.Name) + ` Cover Letter</title>
<style>
@page { size: A4; margin: 22mm 22mm; }
body { margin: 0; font-family: Arial, "Helvetica Neue", Helvetica, "Microsoft YaHei", sans-serif; font-size: 11pt; line-height: 1.45; color: #111; }
header { margin-bottom: 18pt; }
header h1 { margin: 0; font-size: 18pt; text-transform: uppercase; }
p { margin: 0 0 10pt; }
</style></head><body>
<header><h1>` + esc(doc.Basics.Name) + `</h1><div>` + contactLine(doc) + `</div></header>
<p>` + esc(date) + `</p>` + paras.String() + `
</body></html>`
}

const printableHeightPx = (297.0 - 24) * 96 / 25.4

// writePdf writes a PDF; for resumes, shrinks the type a little (down to 86%) to stay on one page.
func writePdf(outPath string, html func(scale float64) string, fitOnePage bool) (float64, error) {
	b, err := getHeadless()
	if err != nil {
		return 0, err
	}
	page, err := b.NewPage(pageOpts{})
	if err != nil {
		return 0, err
	}
	defer page.Close()
	chosen := 1.0
	if fitOnePage {
		for _, scale := range []float64{1, 0.96, 0.93, 0.9, 0.86} {
			chosen = scale
			if err := page.SetContent(html(scale)); err != nil {
				return 0, err
			}
			if err := page.EmulatePrint(); err != nil {
				return 0, err
			}
			var h float64
			if err := page.Eval(`document.querySelector(".page")?.getBoundingClientRect().height ?? 0`, &h); err != nil {
				return 0, err
			}
			if h <= printableHeightPx-4 {
				break
			}
		}
	}
	if err := page.SetContent(html(chosen)); err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return 0, err
	}
	if err := page.PrintPDF(outPath); err != nil {
		return 0, fmt.Errorf("page.pdf: %v", err)
	}
	return chosen, nil
}

var (
	reBadFileChars = regexp.MustCompile(`[\\/:*?"<>|]`)
	reStartsLatin  = regexp.MustCompile(`^[A-Za-z]`)
)

func fileBaseName(doc ResumeDoc) string {
	words := strings.FieldsFunc(jsTrim(doc.Basics.Name), isJSSpace)
	for i, w := range words {
		if reStartsLatin.MatchString(w) {
			r, n := utf8.DecodeRuneInString(w)
			words[i] = string(unicode.ToUpper(r)) + strings.ToLower(w[n:])
		}
	}
	name := reBadFileChars.ReplaceAllString(strings.Join(words, "_"), "")
	if name == "" {
		return "Resume"
	}
	return name
}
