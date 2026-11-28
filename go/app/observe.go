// Page snapshot for the agent: every form control, button and action link in every frame (open
// shadow roots included), tagged with a data-ra-id the agent refers to. The in-page script is
// server/observe.ts's collect(), generated into observe.js.
package app

import (
	_ "embed"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
)

//go:generate node ../tools/gen-observe-js.mjs

//go:embed observe.js
var collectJS string

type El struct {
	ID          string   `json:"id"`
	Kind        string   `json:"kind"` // text/email/tel/... | textarea | select | combobox | radio | checkbox | file | button | link | option | editable
	Label       string   `json:"label"`
	Group       string   `json:"group"`
	Value       string   `json:"value"`
	Checked     *bool    `json:"checked"`
	Required    bool     `json:"required"`
	Disabled    bool     `json:"disabled"`
	Invalid     bool     `json:"invalid"`
	Hidden      bool     `json:"hidden"`
	Options     []string `json:"options"`
	OptionCount int      `json:"optionCount"`
	Text        string   `json:"text"`
	Href        string   `json:"href"`
	SubmitType  bool     `json:"submitType"`
	InForm      bool     `json:"inForm"`
	// Inside the dialog that is open on top of the page (LinkedIn Easy Apply, a cookie notice).
	InDialog bool `json:"inDialog"`
}

// Obs: Omitted = ordinary buttons and links left out to keep the snapshot small.
type Obs struct {
	URL      string   `json:"url"`
	Title    string   `json:"title"`
	Errors   []string `json:"errors"`
	Elements []El     `json:"elements"`
	Excerpt  string   `json:"excerpt"`
	Omitted  int      `json:"omitted,omitempty"`
}

// observe reads the page; more lists every ordinary button and link too (up to the cap).
func observe(p *Page, more bool) Obs {
	elements := []El{}
	errs := []string{}
	excerpt, title := "", ""
	omitted := 0
	ordinary := 40
	if more {
		ordinary = 260
	}
	for _, f := range p.Frames() {
		if !f.Main {
			w, h, ok := p.FrameBox(f.ID)
			if !ok || w < 60 || h < 60 {
				continue
			}
		}
		arg := map[string]any{"prefix": p.framePrefix(f.ID), "ordinary": ordinary}
		var r struct {
			Elements []El     `json:"elements"`
			Omitted  int      `json:"omitted"`
			Errors   []string `json:"errors"`
			Excerpt  string   `json:"excerpt"`
			Title    string   `json:"title"`
		}
		if err := p.evalCtx(f.ID, collectJS+"("+jsonStr(arg)+")", &r, 25*time.Second); err != nil {
			continue // frame navigated mid-read
		}
		elements = append(elements, r.Elements...)
		errs = append(errs, r.Errors...)
		omitted += r.Omitted
		if f.Main {
			excerpt = r.Excerpt
			title = r.Title
		} else if len(r.Elements) > 0 {
			excerpt += "\n[frame] " + u16slice(r.Excerpt, 900)
		}
	}
	errs = uniq(errs)
	if len(errs) > 12 {
		errs = errs[:12]
	}
	return Obs{URL: p.URL(), Title: title, Errors: errs, Elements: elements, Excerpt: excerpt, Omitted: omitted}
}

var reTrailingDigits = regexp.MustCompile(`\d+$`)

// locate finds an element of the latest snapshot by its id.
func locate(p *Page, id string) *Locator {
	prefix := reTrailingDigits.ReplaceAllString(id, "")
	frame := p.frameOfPrefix(prefix)
	if frame == "" {
		return nil
	}
	alive := false
	for _, f := range p.Frames() {
		if f.ID == frame {
			alive = true
		}
	}
	if !alive {
		return nil
	}
	return p.Locator(frame, `[data-ra-id="`+strings.ReplaceAll(id, `"`, "")+`"]`)
}

func q(s string) string {
	if u16len(s) > 140 {
		s = u16slice(s, 140) + "…"
	}
	return jsonStr(s)
}

func qs(xs []string) string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[i] = q(x)
	}
	return strings.Join(out, " ; ")
}

// formatObs is the compact text form of a snapshot for the model.
func formatObs(o Obs, step int) string {
	lines := []string{"STEP " + strconv.Itoa(step) + " — page snapshot", "URL: " + o.URL, "Title: " + o.Title}
	if len(o.Errors) > 0 {
		lines = append(lines, "Errors/alerts on page: "+qs(o.Errors))
	}
	lines = append(lines, "Elements:")
	dialogOpen := false
	for _, e := range o.Elements {
		if e.InDialog {
			dialogOpen = true
		}
	}
	if dialogOpen {
		lines = append(lines, "  -- inside the dialog open on top of the page (work here first) --")
	}
	lastGroup := ""
	behind := false
	for _, e := range o.Elements {
		if dialogOpen && !e.InDialog && !behind {
			behind = true
			lastGroup = ""
			lines = append(lines, "  -- behind the dialog (usually not usable until it closes) --")
		}
		choice := e.Kind == "radio" || e.Kind == "checkbox"
		if choice && e.Group != "" && e.Group != lastGroup {
			lines = append(lines, "  group "+q(e.Group)+":")
		}
		lastGroup = ""
		if choice {
			lastGroup = e.Group
		}
		indent := ""
		if lastGroup != "" {
			indent = "    "
		}
		lines = append(lines, indent+elLine(e, true))
	}
	if len(o.Elements) == 0 {
		lines = append(lines, "  (no interactive elements found)")
	}
	if o.Omitted != 0 {
		lines = append(lines, "  ("+strconv.Itoa(o.Omitted)+" more ordinary buttons/links not listed, e.g. long lists of other jobs, menus; every form field, every button inside a form and every apply/next/submit-like button IS listed. If you need one that is not listed, scroll once: the next snapshot lists them all)")
	}
	lines = append(lines, "Visible text (start):", u16slice(o.Excerpt, 1800))
	return strings.Join(lines, "\n")
}

func elLine(e El, options bool) string {
	flags := []string{}
	for _, f := range []struct {
		on   bool
		name string
	}{{e.Required, "*required"}, {e.Disabled, "disabled"}, {e.Invalid, "INVALID"}, {e.Hidden, "hidden"}} {
		if f.on {
			flags = append(flags, f.name)
		}
	}
	line := "[" + e.ID + "] " + e.Kind
	plain := e.Kind == "button" || e.Kind == "link" || e.Kind == "option"
	if plain {
		line += " " + q(e.Text)
	} else {
		line += " " + q(e.Label)
	}
	if len(flags) > 0 {
		line += " " + strings.Join(flags, " ")
	}
	switch {
	case e.Kind == "radio" || e.Kind == "checkbox":
		if e.Checked != nil && *e.Checked {
			line += " [x]"
		} else {
			line += " [ ]"
		}
	case e.Kind == "file":
		if e.Value != "" {
			line += " file=" + q(e.Value)
		} else {
			line += " (no file)"
		}
	case !plain:
		line += " = " + q(e.Value)
	}
	if options && e.Options != nil {
		line += " options: " + strings.Join(e.Options, " | ")
		if e.OptionCount > len(e.Options) {
			line += " … (+" + strconv.Itoa(e.OptionCount-len(e.Options)) + " more)"
		}
	}
	return line
}

// layout is the page's URL and the same elements in the same order, labels and options. Values are left out.
func layout(o Obs) string {
	els := make([]any, len(o.Elements))
	for i, e := range o.Elements {
		var opts any
		if e.Options != nil {
			opts = e.Options
		}
		els[i] = []any{e.ID, e.Kind, e.Label, e.Group, e.Text, opts, e.OptionCount, e.InDialog}
	}
	return jsonStr([]any{o.URL, els})
}

func elState(e El) string {
	var checked any
	if e.Checked != nil {
		checked = *e.Checked
	}
	return jsonStr([]any{e.Value, checked, e.Required, e.Disabled, e.Invalid, e.Hidden})
}

const DeltaMark = " — same page and elements as the STEP "

// formatDelta: after a turn that only filled fields the page usually keeps its layout, so only the elements
// that changed since the last full snapshot are sent ("" when a full snapshot should go instead).
func formatDelta(base, cur Obs, baseStep, step int) string {
	if layout(base) != layout(cur) {
		return ""
	}
	lines := []string{"STEP " + strconv.Itoa(step) + DeltaMark + strconv.Itoa(baseStep) + " snapshot above (ids unchanged). Elements that changed since then:"}
	changed := 0
	for i, e := range cur.Elements {
		if elState(e) == elState(base.Elements[i]) {
			continue
		}
		changed++
		extra := ""
		if (e.Kind == "radio" || e.Kind == "checkbox") && e.Group != "" {
			extra = " (group " + q(e.Group) + ")"
		}
		lines = append(lines, "  "+elLine(e, false)+extra)
	}
	if changed == 0 {
		lines = append(lines, "  (none)")
	}
	if len(cur.Errors) > 0 {
		lines = append(lines, "Errors/alerts on page now: "+qs(cur.Errors))
	} else if len(base.Errors) > 0 {
		lines = append(lines, "Errors/alerts on page now: none")
	}
	if cur.Excerpt == base.Excerpt {
		lines = append(lines, "Visible text: unchanged.")
	} else {
		lines = append(lines, "Visible text (start), now:", u16slice(cur.Excerpt, 1800))
	}
	text := strings.Join(lines, "\n")
	if float64(u16len(text)) < float64(u16len(formatObs(cur, step)))*0.6 {
		return text
	}
	return ""
}

var _ = json.Marshal
