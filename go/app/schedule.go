// Interviews, tests, calls and deadlines on a job: listed on the jobs page, reminded in the
// browser, and downloadable as calendar files.
package app

import (
	"errors"
	"math"
	"regexp"
	"strings"
	"time"
)

var EventKinds = []string{"interview", "test", "call", "deadline", "other"}

var EventLabel = map[string]string{"interview": "面试", "test": "笔试/测评", "call": "电话沟通", "deadline": "投递截止", "other": "日程"}

// EventView is an event row with its job's title, company and link.
type EventView struct {
	ID         int64   `json:"id"`
	JobID      int64   `json:"job_id"`
	Kind       string  `json:"kind"`
	At         string  `json:"at"`
	Minutes    int64   `json:"minutes"`
	Note       string  `json:"note"`
	Done       int64   `json:"done"`
	CreatedAt  string  `json:"created_at"`
	JobTitle   *string `json:"job_title"`
	JobCompany *string `json:"job_company"`
	JobURL     string  `json:"job_url"`
}

func eventFromRow(m map[string]any) EventView {
	return EventView{ID: asInt(m["id"]), JobID: asInt(m["job_id"]), Kind: jsString(m["kind"]), At: jsString(m["at"]), Minutes: asInt(m["minutes"]), Note: jsString(m["note"]), Done: asInt(m["done"]), CreatedAt: jsString(m["created_at"]), JobTitle: asStrPtr(m["job_title"]), JobCompany: asStrPtr(m["job_company"]), JobURL: jsString(m["job_url"])}
}

// toSQLTime: any time the browser sends (ISO with Z or an offset) → UTC "YYYY-MM-DD HH:MM:SS"; "" if unreadable.
func toSQLTime(v any) string {
	s, ok := v.(string)
	if !ok || jsTrim(s) == "" {
		return ""
	}
	t, ok := parseISO(jsTrim(s))
	if !ok {
		return ""
	}
	return toSQL(t)
}

const eventSelect = `SELECT e.*, j.title AS job_title, j.company AS job_company, j.url AS job_url FROM events e JOIN jobs j ON j.id = e.job_id`

// listEvents: upcoming = not done and not more than three hours past (an interview that is running still shows).
func listEvents(jobID *int64, upcoming bool) []EventView {
	where := []string{}
	params := []any{}
	if jobID != nil {
		where = append(where, "e.job_id = ?")
		params = append(params, *jobID)
	}
	if upcoming {
		where = append(where, "e.done = 0 AND e.at >= datetime('now', '-3 hours')")
	}
	w := ""
	if len(where) > 0 {
		w = " WHERE " + strings.Join(where, " AND ")
	}
	out := []EventView{}
	for _, m := range queryMaps(eventSelect+w+" ORDER BY e.at, e.id", params...) {
		out = append(out, eventFromRow(m))
	}
	return out
}

type NextEvent struct {
	ID   int64  `json:"id"`
	Kind string `json:"kind"`
	At   string `json:"at"`
}

func nextEvent(jobID int64) *NextEvent {
	m := queryMap("SELECT id, kind, at FROM events WHERE job_id = ? AND done = 0 AND at >= datetime('now', '-3 hours') ORDER BY at LIMIT 1", jobID)
	if m == nil {
		return nil
	}
	return &NextEvent{asInt(m["id"]), jsString(m["kind"]), jsString(m["at"])}
}

var progressRank = map[string]int{"applied": 0, "screening": 1, "interview": 2}

func addEvent(jobID int64, input map[string]any) (int64, error) {
	job := getJob(jobID)
	if job == nil {
		return 0, errors.New("岗位不存在")
	}
	kind := "other"
	if k, ok := input["kind"].(string); ok && contains(EventKinds, k) {
		kind = k
	}
	at := toSQLTime(input["at"])
	if at == "" {
		return 0, errors.New("时间不对")
	}
	minutes := int64(0)
	if kind != "deadline" {
		minutes = clampMinutes(input["minutes"], has(input, "minutes"))
	}
	note := ""
	if s, ok := input["note"].(string); ok {
		note = u16slice(jsTrim(s), 500)
	}
	_, id := mustExec("INSERT INTO events (job_id, kind, at, minutes, note) VALUES (?, ?, ?, ?, ?)", jobID, kind, at, minutes, note)
	// An interview or a test on an applied job moves its progress forward (never back, never past an outcome).
	want := ""
	if kind == "interview" {
		want = "interview"
	} else if kind == "test" {
		want = "screening"
	}
	cur := sv(job.Progress)
	if job.Progress == nil && job.Stage == "applied" {
		cur = "applied"
	}
	if want != "" && job.Stage == "applied" && cur != "" {
		if r, ok := progressRank[cur]; ok && r < progressRank[want] {
			setJob(jobID, P{"progress": want, "progress_at": sqlNow()})
		}
	}
	emit("schedule", jobID)
	emit("job", jobID)
	return id, nil
}

func clampMinutes(v any, present bool) int64 {
	n := jsRound(jsNumber(v, present))
	if !math.IsNaN(n) && !math.IsInf(n, 0) && n > 0 {
		return int64(math.Min(n, 24*60))
	}
	return 60
}

func updateEvent(id int64, input map[string]any) error {
	ev := queryMap("SELECT * FROM events WHERE id = ?", id)
	if ev == nil {
		return errors.New("没有这条日程")
	}
	type kv struct {
		k string
		v any
	}
	patch := []kv{}
	set := func(k string, v any) {
		for i := range patch {
			if patch[i].k == k {
				patch[i].v = v
				return
			}
		}
		patch = append(patch, kv{k, v})
	}
	kind := jsString(ev["kind"])
	if k, ok := input["kind"].(string); ok && contains(EventKinds, k) {
		set("kind", k)
		kind = k
	}
	if v, ok := input["at"]; ok {
		at := toSQLTime(v)
		if at == "" {
			return errors.New("时间不对")
		}
		set("at", at)
	}
	if v, ok := input["minutes"]; ok {
		set("minutes", clampMinutes(v, true))
	}
	if kind == "deadline" {
		set("minutes", 0)
	}
	if s, ok := input["note"].(string); ok {
		set("note", u16slice(jsTrim(s), 500))
	}
	if b, ok := input["done"].(bool); ok {
		d := 0
		if b {
			d = 1
		}
		set("done", d)
	}
	if len(patch) > 0 {
		sets := []string{}
		args := []any{}
		for _, p := range patch {
			sets = append(sets, p.k+" = ?")
			args = append(args, p.v)
		}
		args = append(args, id)
		mustExec("UPDATE events SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...)
	}
	jobID := asInt(ev["job_id"])
	emit("schedule", jobID)
	emit("job", jobID)
	return nil
}

func deleteEvent(id int64) {
	ev := queryMap("SELECT * FROM events WHERE id = ?", id)
	if ev == nil {
		return
	}
	mustExec("DELETE FROM events WHERE id = ?", id)
	jobID := asInt(ev["job_id"])
	emit("schedule", jobID)
	emit("job", jobID)
}

func getEvent(id int64) *EventView {
	m := queryMap(eventSelect+" WHERE e.id = ?", id)
	if m == nil {
		return nil
	}
	ev := eventFromRow(m)
	return &ev
}

var (
	reURLInNote = regexp.MustCompile(`https?://\S+`)
	icsEsc      = strings.NewReplacer(`\`, `\\`, ";", `\;`, ",", `\,`, "\r\n", `\n`, "\n", `\n`)
)

// icsFor is an .ics file with one event and a reminder (an hour before; a day before for a deadline).
func icsFor(ev EventView) string {
	start, _ := utcOf(ev.At)
	minDur := int64(15)
	if ev.Kind == "deadline" {
		minDur = 0
	}
	end := start.Add(time.Duration(max(ev.Minutes, minDur)) * time.Minute)
	stamp := func(t time.Time) string { return t.UTC().Format("20060102T150405Z") }
	parts := []string{}
	for _, x := range []string{sv(ev.JobTitle), sv(ev.JobCompany)} {
		if x != "" {
			parts = append(parts, x)
		}
	}
	job := strings.Join(parts, " @ ")
	if job == "" {
		job = ev.JobURL
	}
	desc := []string{}
	for _, x := range []string{ev.Note, ev.JobURL} {
		if x != "" {
			desc = append(desc, x)
		}
	}
	lines := []string{
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//resume-agent//CN",
		"CALSCALE:GREGORIAN",
		"BEGIN:VEVENT",
		"UID:resume-agent-event-" + numStr(float64(ev.ID)) + "@localhost",
		"DTSTAMP:" + stamp(time.Now()),
		"DTSTART:" + stamp(start),
		"DTEND:" + stamp(end),
		"SUMMARY:" + icsEsc.Replace(EventLabel[ev.Kind]+" · "+job),
		"DESCRIPTION:" + icsEsc.Replace(strings.Join(desc, "\n")),
	}
	if link := reURLInNote.FindString(ev.Note); link != "" {
		lines = append(lines, "URL:"+link, "LOCATION:"+icsEsc.Replace(link))
	} else if ev.Note != "" && u16len(ev.Note) < 120 {
		lines = append(lines, "LOCATION:"+icsEsc.Replace(ev.Note))
	}
	trigger := "-PT1H"
	if ev.Kind == "deadline" {
		trigger = "-P1D"
	}
	lines = append(lines,
		"BEGIN:VALARM",
		"ACTION:DISPLAY",
		"DESCRIPTION:"+icsEsc.Replace(EventLabel[ev.Kind]),
		"TRIGGER:"+trigger,
		"END:VALARM",
		"END:VEVENT",
		"END:VCALENDAR",
	)
	// Lines longer than 75 octets are folded, as the format requires.
	for i, l := range lines {
		lines[i] = fold(l)
	}
	return strings.Join(lines, "\r\n") + "\r\n"
}

func fold(line string) string {
	if len(line) <= 75 {
		return line
	}
	out := []string{}
	cur := ""
	n := 0
	for _, ch := range line {
		b := len(string(ch))
		limit := 75
		if len(out) > 0 {
			limit = 74
		}
		if n+b > limit {
			out = append(out, cur)
			cur, n = "", 0
		}
		cur += string(ch)
		n += b
	}
	out = append(out, cur)
	return strings.Join(out, "\r\n ")
}
