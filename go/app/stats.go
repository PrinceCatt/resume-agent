// Numbers for the stats page: how far applications get, how fast replies come, and whether the fit
// score and the job site make a difference.
package app

import (
	"math"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

var knownSites = []struct {
	re   *regexp.Regexp
	name string
}{
	{regexp.MustCompile(`greenhouse\.io$`), "Greenhouse"},
	{regexp.MustCompile(`lever\.co$`), "Lever"},
	{regexp.MustCompile(`linkedin\.com$`), "LinkedIn"},
	{regexp.MustCompile(`(myworkdayjobs|workday)\.com$`), "Workday"},
	{regexp.MustCompile(`mycareersfuture\.gov\.sg$`), "MyCareersFuture"},
	{regexp.MustCompile(`ashbyhq\.com$`), "Ashby"},
	{regexp.MustCompile(`smartrecruiters\.com$`), "SmartRecruiters"},
	{regexp.MustCompile(`(^|\.)indeed\.`), "Indeed"},
	{regexp.MustCompile(`(^|\.)glassdoor\.`), "Glassdoor"},
	{regexp.MustCompile(`(^|\.)jobstreet\.`), "JobStreet"},
	{regexp.MustCompile(`zhipin\.com$`), "BOSS直聘"},
	{regexp.MustCompile(`nowcoder\.com$`), "牛客"},
	{regexp.MustCompile(`^(localhost|127\.0\.0\.1)$`), "本地测试页"},
}

var reTwoPart = regexp.MustCompile(`^(com|gov|edu|org|net|co|ac)$`)

// siteOf: where a posting lives, a known job board by name, otherwise the site's own name.
func siteOf(raw string) string {
	if raw == "" {
		return "粘贴的 JD"
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "其他"
	}
	h := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	for _, k := range knownSites {
		if k.re.MatchString(h) {
			return k.name
		}
	}
	parts := strings.Split(h, ".")
	twoPart := len(parts) >= 3 && reTwoPart.MatchString(parts[len(parts)-2])
	i := len(parts) - 2
	if twoPart {
		i = len(parts) - 3
	}
	if i >= 0 && i < len(parts) {
		return parts[i]
	}
	return h
}

var (
	replyProgress    = []string{"screening", "interview", "offer", "rejected"}
	positiveProgress = []string{"screening", "interview", "offer"}
)

// weekStart is Monday 00:00 local time of the week containing d.
func weekStart(d time.Time) time.Time {
	l := d.Local()
	x := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, time.Local)
	return x.AddDate(0, 0, -((int(x.Weekday()) + 6) % 7))
}

type Bucket struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Applied  int    `json:"applied"`
	Replied  int    `json:"replied"`
	Positive int    `json:"positive"`
}

type Funnel struct {
	Added     int `json:"added"`
	Parsed    int `json:"parsed"`
	Tailored  int `json:"tailored"`
	Applied   int `json:"applied"`
	Replied   int `json:"replied"`
	Interview int `json:"interview"`
	Offer     int `json:"offer"`
}

type WeekRow struct {
	Start   string `json:"start"`
	Added   int    `json:"added"`
	Applied int    `json:"applied"`
}

type Stats struct {
	Funnel       Funnel `json:"funnel"`
	ResponseRate struct {
		Applied int `json:"applied"`
		Replied int `json:"replied"`
		Recent  int `json:"recent"`
	} `json:"responseRate"`
	MedianReplyDays *float64  `json:"medianReplyDays"`
	Ended           int       `json:"ended"`
	Weekly          []WeekRow `json:"weekly"`
	ByFit           []Bucket  `json:"byFit"`
	BySite          []Bucket  `json:"bySite"`
	Upcoming        int       `json:"upcoming"`
	Tokens          int64     `json:"tokens"`
}

func stats() Stats {
	jobs := listJobs()
	var st Stats
	mature, matureReplied := 0, 0
	replyDays := []float64{}
	fit := []*Bucket{{Key: "high", Label: "70 分以上"}, {Key: "mid", Label: "50–69 分"}, {Key: "low", Label: "50 分以下"}, {Key: "none", Label: "没有评分"}}
	siteOrder := []string{}
	sites := map[string]*Bucket{}

	const weeksN = 10
	thisWeek := weekStart(time.Now())
	type wk struct {
		start   string
		t       time.Time
		added   int
		applied int
	}
	weeks := make([]*wk, weeksN)
	for i := range weeks {
		d := thisWeek.AddDate(0, 0, -7*(weeksN-1-i))
		weeks[i] = &wk{start: d.Format("2006-01-02"), t: d}
	}
	weekOf := func(s string) *wk {
		if s == "" {
			return nil
		}
		t, ok := utcOf(s)
		if !ok {
			return nil
		}
		ws := weekStart(t)
		for _, w := range weeks {
			if w.t.Equal(ws) {
				return w
			}
		}
		return nil
	}

	for _, j := range jobs {
		if j.Stage == "skipped" {
			continue
		}
		st.Funnel.Added++
		if w := weekOf(j.CreatedAt); w != nil {
			w.added++
		}
		if j.JD != nil && *j.JD != "" {
			st.Funnel.Parsed++
		}
		if j.Tailored != nil && *j.Tailored != "" {
			st.Funnel.Tailored++
		}
		if j.Stage != "applied" {
			continue
		}
		st.Funnel.Applied++
		appliedAt := j.UpdatedAt
		if j.AppliedAt != nil {
			appliedAt = *j.AppliedAt
		}
		if w := weekOf(appliedAt); w != nil {
			w.applied++
		}
		cur := "applied"
		if j.Progress != nil {
			cur = *j.Progress
		}
		reached := progressReached(j.ID, cur)
		replied, positive := false, false
		for _, p := range replyProgress {
			if reached[p] {
				replied = true
			}
		}
		for _, p := range positiveProgress {
			if reached[p] {
				positive = true
			}
		}
		if replied {
			st.Funnel.Replied++
		}
		if reached["interview"] || reached["offer"] {
			st.Funnel.Interview++
		}
		if reached["offer"] {
			st.Funnel.Offer++
		}
		if cur == "rejected" || cur == "withdrawn" {
			st.Ended++
		}
		at, okAt := utcOf(appliedAt)
		age := math.NaN()
		if okAt {
			age = float64(time.Since(at).Milliseconds()) / 86_400_000
		}
		if age >= 7 {
			mature++
			if replied {
				matureReplied++
			}
		}
		if replied {
			first := ""
			if m := queryMap("SELECT MIN(ts) AS ts FROM progress_log WHERE job_id = ? AND progress != 'applied'", j.ID); m != nil && m["ts"] != nil {
				first = jsString(m["ts"])
			} else if cur != "applied" && j.ProgressAt != nil {
				first = *j.ProgressAt
			}
			if first != "" {
				if f, ok := utcOf(first); ok && okAt {
					if d := float64(f.Sub(at).Milliseconds()) / 86_400_000; d >= 0 {
						replyDays = append(replyDays, d)
					}
				}
			}
		}
		b := fit[3]
		if jd := jobJd(j); jd != nil && jd.Fit != nil {
			switch s := jd.Fit.Score; {
			case s >= 70:
				b = fit[0]
			case s >= 50:
				b = fit[1]
			default:
				b = fit[2]
			}
		}
		name := siteOf(j.URL)
		if _, ok := sites[name]; !ok {
			sites[name] = &Bucket{Key: name, Label: name}
			siteOrder = append(siteOrder, name)
		}
		for _, x := range []*Bucket{b, sites[name]} {
			x.Applied++
			if replied {
				x.Replied++
			}
			if positive {
				x.Positive++
			}
		}
	}

	sort.Float64s(replyDays)
	if len(replyDays) > 0 {
		m := jsRound(replyDays[(len(replyDays)-1)/2]*10) / 10
		st.MedianReplyDays = &m
	}
	st.ResponseRate.Applied = mature
	st.ResponseRate.Replied = matureReplied
	st.ResponseRate.Recent = st.Funnel.Applied - mature
	st.Weekly = []WeekRow{}
	for _, w := range weeks {
		st.Weekly = append(st.Weekly, WeekRow{w.start, w.added, w.applied})
	}
	st.ByFit = []Bucket{}
	for _, b := range fit {
		if b.Applied > 0 {
			st.ByFit = append(st.ByFit, *b)
		}
	}
	bySite := []Bucket{}
	for _, n := range siteOrder {
		bySite = append(bySite, *sites[n])
	}
	sort.SliceStable(bySite, func(i, j int) bool { return bySite[i].Applied > bySite[j].Applied })
	if len(bySite) > 8 {
		bySite = bySite[:8]
	}
	st.BySite = bySite
	st.Upcoming = len(listEvents(nil, true))
	st.Tokens = queryInt("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS n FROM usage")
	return st
}

type AskedQuestion struct {
	Q     string `json:"q"`
	A     string `json:"a"`
	Times int    `json:"times"`
	Job   string `json:"job"`
	Ts    string `json:"ts"`
}

var reRememberedMark = regexp.MustCompile(`（已记入资料库）$`)

// askedQuestions: questions the agent asked you that are not in the profile's answers yet, with what you said.
func askedQuestions(similar func(a, b string) float64, answers []Answer) []AskedQuestion {
	rows := queryMaps(`SELECT s.id, s.run_id, s.kind, s.text, s.ts, r.job_id, j.title, j.company
     FROM run_steps s JOIN runs r ON r.id = s.run_id JOIN jobs j ON j.id = r.job_id
     WHERE (s.kind = 'ask' AND s.text LIKE '问你：%') OR (s.kind = 'note' AND s.text LIKE '你的回答：%')
     ORDER BY s.run_id, s.id`)
	order := []string{}
	out := map[string]*AskedQuestion{}
	for i, r := range rows {
		if jsString(r["kind"]) != "ask" {
			continue
		}
		q := jsTrim(strings.TrimPrefix(jsString(r["text"]), "问你："))
		a := ""
		if i+1 < len(rows) {
			next := rows[i+1]
			if asInt(next["run_id"]) == asInt(r["run_id"]) && jsString(next["kind"]) == "note" {
				a = jsTrim(reRememberedMark.ReplaceAllString(strings.TrimPrefix(jsString(next["text"]), "你的回答："), ""))
			}
		}
		if q == "" {
			continue
		}
		known := false
		for _, x := range answers {
			if jsTrim(x.A) != "" && similar(x.Q, q) >= 0.8 {
				known = true
				break
			}
		}
		if known {
			continue
		}
		key := strings.ToLower(reWS.ReplaceAllString(q, " "))
		job := []string{}
		for _, x := range []any{r["title"], r["company"]} {
			if s := jsString(x); x != nil && s != "" {
				job = append(job, s)
			}
		}
		prev, had := out[key]
		item := &AskedQuestion{Q: q, A: a, Times: 1, Job: strings.Join(job, " · "), Ts: jsString(r["ts"])}
		if had {
			if item.A == "" {
				item.A = prev.A
			}
			item.Times = prev.Times + 1
		} else {
			order = append(order, key)
		}
		out[key] = item
	}
	list := []AskedQuestion{}
	for _, k := range order {
		list = append(list, *out[k])
	}
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Times != list[j].Times {
			return list[i].Times > list[j].Times
		}
		return list[j].Ts < list[i].Ts
	})
	if len(list) > 30 {
		list = list[:30]
	}
	return list
}
