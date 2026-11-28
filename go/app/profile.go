// The master profile: everything a tailored resume or an application answer may draw on.
// Tailoring may select, reorder and reword what is here, never add to it.
package app

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Bullet struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

type Entry struct {
	ID string `json:"id"`
	// Left of the first line, bold (school, company, project). Empty for a plain bullet list.
	Title string `json:"title"`
	// Right of the first line.
	Dates string `json:"dates"`
	// Left of the second line (degree, role).
	Subtitle string `json:"subtitle"`
	// Right of the second line.
	Location string   `json:"location"`
	Bullets  []Bullet `json:"bullets"`
}

type Section struct {
	ID      string  `json:"id"`
	Heading string  `json:"heading"`
	Entries []Entry `json:"entries"`
}

type SkillGroup struct {
	ID    string   `json:"id"`
	Label string   `json:"label"`
	Items []string `json:"items"`
}

type Answer struct {
	ID string `json:"id"`
	Q  string `json:"q"`
	A  string `json:"a"`
}

type Basics struct {
	Name             string `json:"name"`
	FirstName        string `json:"firstName"`
	LastName         string `json:"lastName"`
	Email            string `json:"email"`
	Phone            string `json:"phone"`
	PhoneCountryCode string `json:"phoneCountryCode"`
	Location         string `json:"location"`
	LinkedIn         string `json:"linkedin"`
	GitHub           string `json:"github"`
	Website          string `json:"website"`
}

type Profile struct {
	Basics        Basics       `json:"basics"`
	Summary       string       `json:"summary"`
	Sections      []Section    `json:"sections"`
	Skills        []SkillGroup `json:"skills"`
	SkillsHeading string       `json:"skillsHeading"`
	// Index in sections before which the skills block is printed.
	SkillsPosition int `json:"skillsPosition"`
	// Material that is true but not on the resume (internships, projects, numbers).
	ExtraFacts string `json:"extraFacts"`
	// Answers to recurring application questions; an empty answer means "ask me".
	Answers []Answer `json:"answers"`
}

var (
	idMu  sync.Mutex
	idSeq int
)

func newID(prefix string) string {
	idMu.Lock()
	idSeq = (idSeq + 1) % 1000
	seq := idSeq
	idMu.Unlock()
	return prefix + "_" + strconv.FormatInt(time.Now().UnixMilli(), 36) + strconv.FormatInt(int64(seq), 36)
}

func emptyProfile() Profile {
	return Profile{
		Basics:         Basics{PhoneCountryCode: "+65"},
		Sections:       []Section{},
		Skills:         []SkillGroup{},
		SkillsHeading:  "Technical Skills",
		SkillsPosition: 2,
		Answers:        []Answer{},
	}
}

// CommonQuestions are questions most application forms ask; answers start empty so the agent asks the first time.
var CommonQuestions = []string{
	"Are you legally authorized to work in Singapore?",
	"Will you now or in the future require visa sponsorship?",
	"Earliest start date / availability",
	"Internship duration you are available for",
	"Expected salary / stipend",
	"Notice period",
	"Graduation date",
	"Gender (voluntary self-identification)",
	"Race / ethnicity (voluntary self-identification)",
	"How did you hear about this job?",
}

func getProfile() Profile {
	row := queryMap("SELECT data FROM profile WHERE id = 1")
	if row != nil {
		v, _ := parseAny(jsString(row["data"]))
		return normalizeProfile(v)
	}
	seed := emptyProfile()
	if b, err := os.ReadFile(filepath.Join(DataDir, "seed-profile.json")); err == nil {
		if v, ok := parseAny(string(b)); ok {
			seed = normalizeProfile(v)
		}
	}
	saveProfile(seed)
	return seed
}

func saveProfile(p Profile) Profile {
	clean := normalizeProfile(toAny(p))
	mustExec("INSERT INTO profile (id, data, updated_at) VALUES (1, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at", jsonStr(clean))
	return clean
}

// toAny turns a typed value into the plain maps JSON.parse would give.
func toAny(v any) any {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	out, _ := parseAny(string(b))
	return out
}

// str is `typeof v === "string" ? v : v == null ? "" : String(v)`.
func str(v any) string { return jsString(v) }

// normalizeProfile fills in missing fields and ids so the rest of the code can trust the shape.
func normalizeProfile(raw any) Profile {
	b := get(raw, "basics")
	p := Profile{
		Basics: Basics{
			Name:             str(get(b, "name")),
			FirstName:        str(get(b, "firstName")),
			LastName:         str(get(b, "lastName")),
			Email:            str(get(b, "email")),
			Phone:            str(get(b, "phone")),
			PhoneCountryCode: str(get(b, "phoneCountryCode")),
			Location:         str(get(b, "location")),
			LinkedIn:         str(get(b, "linkedin")),
			GitHub:           str(get(b, "github")),
			Website:          str(get(b, "website")),
		},
		Summary:       str(get(raw, "summary")),
		Sections:      []Section{},
		Skills:        []SkillGroup{},
		SkillsHeading: str(get(raw, "skillsHeading")),
		ExtraFacts:    str(get(raw, "extraFacts")),
		Answers:       []Answer{},
	}
	if p.Basics.PhoneCountryCode == "" {
		p.Basics.PhoneCountryCode = "+65"
	}
	if p.SkillsHeading == "" {
		p.SkillsHeading = "Technical Skills"
	}
	for _, s := range arr(get(raw, "sections")) {
		sec := Section{ID: str(get(s, "id")), Heading: str(get(s, "heading")), Entries: []Entry{}}
		if sec.ID == "" {
			sec.ID = newID("sec")
		}
		for _, e := range arr(get(s, "entries")) {
			ent := Entry{
				ID:       str(get(e, "id")),
				Title:    str(get(e, "title")),
				Dates:    str(get(e, "dates")),
				Subtitle: str(get(e, "subtitle")),
				Location: str(get(e, "location")),
				Bullets:  []Bullet{},
			}
			if ent.ID == "" {
				ent.ID = newID("ent")
			}
			for _, x := range arr(get(e, "bullets")) {
				var id, text string
				if t, ok := x.(string); ok {
					text = t
				} else {
					id = str(get(x, "id"))
					text = str(get(x, "text"))
				}
				if id == "" {
					id = newID("b")
				}
				if jsTrim(text) != "" {
					ent.Bullets = append(ent.Bullets, Bullet{ID: id, Text: text})
				}
			}
			sec.Entries = append(sec.Entries, ent)
		}
		p.Sections = append(p.Sections, sec)
	}
	for _, g := range arr(get(raw, "skills")) {
		grp := SkillGroup{ID: str(get(g, "id")), Label: str(get(g, "label")), Items: []string{}}
		if grp.ID == "" {
			grp.ID = newID("sk")
		}
		for _, it := range arr(get(g, "items")) {
			if t := jsTrim(str(it)); t != "" {
				grp.Items = append(grp.Items, t)
			}
		}
		p.Skills = append(p.Skills, grp)
	}
	if f, ok := finite(get(raw, "skillsPosition")); ok {
		p.SkillsPosition = int(math.Max(0, math.Floor(f)))
	} else {
		p.SkillsPosition = 2
	}
	for _, a := range arr(get(raw, "answers")) {
		ans := Answer{ID: str(get(a, "id")), Q: str(get(a, "q")), A: str(get(a, "a"))}
		if ans.ID == "" {
			ans.ID = newID("qa")
		}
		p.Answers = append(p.Answers, ans)
	}
	return p
}

// profileForPrompt is a plain-text dump (with ids when asked), for prompts.
func profileForPrompt(p Profile, withIDs bool) string {
	lines := []string{}
	b := p.Basics
	lines = append(lines, "Name: "+b.Name+" (first: "+b.FirstName+", last: "+b.LastName+")")
	lines = append(lines, "Email: "+b.Email+" | Phone: "+b.PhoneCountryCode+" "+b.Phone+" | Location: "+b.Location)
	if b.LinkedIn != "" {
		lines = append(lines, "LinkedIn: "+b.LinkedIn)
	}
	if b.GitHub != "" {
		lines = append(lines, "GitHub: "+b.GitHub)
	}
	if b.Website != "" {
		lines = append(lines, "Website: "+b.Website)
	}
	if p.Summary != "" {
		lines = append(lines, "Summary: "+p.Summary)
	}
	tag := func(id string) string {
		if withIDs {
			return " [" + id + "]"
		}
		return ""
	}
	for _, s := range p.Sections {
		lines = append(lines, "", "## "+s.Heading+tag(s.ID))
		for _, e := range s.Entries {
			parts := []string{}
			for _, x := range []string{e.Title, e.Subtitle, e.Location, e.Dates} {
				if x != "" {
					parts = append(parts, x)
				}
			}
			head := strings.Join(parts, " | ")
			if head != "" {
				lines = append(lines, "- "+head+tag(e.ID))
			} else if withIDs {
				lines = append(lines, "- (list) ["+e.ID+"]")
			}
			for _, x := range e.Bullets {
				lines = append(lines, "    * "+x.Text+tag(x.ID))
			}
		}
	}
	lines = append(lines, "", "## Skills")
	for _, g := range p.Skills {
		lines = append(lines, "- "+g.Label+tag(g.ID)+": "+strings.Join(g.Items, ", "))
	}
	return strings.Join(lines, "\n")
}
