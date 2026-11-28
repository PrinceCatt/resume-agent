// Finding jobs to add: searches LinkedIn's public job search (the list a signed-out visitor sees)
// and MyCareersFuture's search API, merges and de-duplicates the results, and marks the ones
// already in your list. Nothing is added here; you pick what goes in.
package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type SearchSpec struct {
	Queries []string `json:"queries"`
	Kind    string   `json:"kind"` // fulltime | parttime | internship
	// Posted within the last N days.
	Days    int      `json:"days"`
	Sources []string `json:"sources"` // linkedin | mcf
	// LinkedIn only: just jobs with Easy Apply.
	EasyApplyOnly bool `json:"easyApplyOnly"`
	// Results to fetch per query per source.
	PerQuery int `json:"perQuery"`
	// Leave out senior/lead/manager titles.
	HideSenior bool `json:"hideSenior"`
}

type FoundJob struct {
	Source   string `json:"source"`
	Title    string `json:"title"`
	Company  string `json:"company"`
	Location string `json:"location"`
	// YYYY-MM-DD when known.
	Posted string `json:"posted"`
	URL    string `json:"url"`
	Salary string `json:"salary"`
	// Set when this posting is already in your job list.
	ExistingID *int64 `json:"existingId"`
}

var reSenior = jsRe(`\b(senior|snr|sr|lead|staff|principal|manager|head|director|architect|vp|avp|chief)\b|\b(\d+|five|ten)\s*\+?\s*(years|yrs)\b`, "i")

// seniorTitle: true for a title that is plainly not entry level.
func seniorTitle(title string) bool { return reSenior.MatchString(title) }

const discoverUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

var (
	reHexEntity  = regexp.MustCompile(`(?i)&#x([0-9a-f]+);`)
	reDecEntity  = regexp.MustCompile(`&#(\d+);`)
	reNameEntity = regexp.MustCompile(`(?i)&([a-z]+);`)
	reTag        = regexp.MustCompile(`<[^>]+>`)
	entities     = map[string]string{"amp": "&", "lt": "<", "gt": ">", "quot": `"`, "apos": "'", "nbsp": " "}
)

func codePoint(n int64) string {
	if n < 0 || n > 0x10ffff {
		return ""
	}
	return string(rune(n))
}

func decodeEntities(s string) string {
	s = reHexEntity.ReplaceAllStringFunc(s, func(m string) string {
		n, _ := strconv.ParseInt(reHexEntity.FindStringSubmatch(m)[1], 16, 64)
		return codePoint(n)
	})
	s = reDecEntity.ReplaceAllStringFunc(s, func(m string) string {
		n, _ := strconv.ParseInt(reDecEntity.FindStringSubmatch(m)[1], 10, 64)
		return codePoint(n)
	})
	return reNameEntity.ReplaceAllStringFunc(s, func(m string) string {
		if v, ok := entities[strings.ToLower(reNameEntity.FindStringSubmatch(m)[1])]; ok {
			return v
		}
		return m
	})
}

func cleanHTML(html string) string {
	return squashSpace(decodeEntities(reTag.ReplaceAllString(html, " ")))
}

var (
	reLiSplit    = jsRe(`<li[\s>]`, "")
	reCardHref   = regexp.MustCompile(`class="base-card__full-link[^"]*"[^>]*?href="([^"]+)"`)
	reViewHref   = regexp.MustCompile(`href="(https://[a-z]+\.linkedin\.com/jobs/view/[^"]+)"`)
	reCardTitle  = regexp.MustCompile(`(?s)<h3[^>]*base-search-card__title[^>]*>(.*?)</h3>`)
	reSrOnly     = regexp.MustCompile(`(?s)<span class="sr-only">(.*?)</span>`)
	reCardCo     = regexp.MustCompile(`(?s)<h4[^>]*base-search-card__subtitle[^>]*>(.*?)</h4>`)
	reCardLoc    = regexp.MustCompile(`(?s)job-search-card__location[^>]*>(.*?)</span>`)
	reCardTime   = regexp.MustCompile(`<time[^>]*datetime="([^"]+)"`)
	reCardSalary = regexp.MustCompile(`(?s)job-search-card__salary-info[^>]*>(.*?)</span>`)
)

func group1(re *regexp.Regexp, s string) (string, bool) {
	if m := re.FindStringSubmatch(s); m != nil {
		return m[1], true
	}
	return "", false
}

// parseLinkedInCards reads job cards from LinkedIn's public search fragment (jobs-guest/…/seeMoreJobPostings).
func parseLinkedInCards(html string) []FoundJob {
	out := []FoundJob{}
	chunks := reLiSplit.Split(html, -1)
	for _, chunk := range chunks[1:] {
		href, ok := group1(reCardHref, chunk)
		if !ok {
			if href, ok = group1(reViewHref, chunk); !ok {
				continue
			}
		}
		u := strings.SplitN(decodeEntities(href), "?", 2)[0]
		titleHTML, ok := group1(reCardTitle, chunk)
		if !ok {
			titleHTML, _ = group1(reSrOnly, chunk)
		}
		title := cleanHTML(titleHTML)
		co, _ := group1(reCardCo, chunk)
		loc, _ := group1(reCardLoc, chunk)
		posted, _ := group1(reCardTime, chunk)
		sal, _ := group1(reCardSalary, chunk)
		if title != "" {
			out = append(out, FoundJob{Source: "linkedin", Title: title, Company: cleanHTML(co), Location: cleanHTML(loc), Posted: posted, URL: u, Salary: cleanHTML(sal)})
		}
	}
	return out
}

func httpDo(method, u string, body []byte, headers map[string]string) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return 0, nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	return res.StatusCode, b, err
}

func searchLinkedIn(q string, spec SearchSpec) ([]FoundJob, error) {
	out := []FoundJob{}
	for start := 0; start < spec.PerQuery; start += 10 {
		params := [][2]string{{"keywords", q}, {"location", "Singapore"}, {"f_TPR", fmt.Sprintf("r%d", spec.Days*86400)}, {"start", strconv.Itoa(start)}}
		switch spec.Kind {
		case "fulltime":
			params = append(params, [2]string{"f_JT", "F"}, [2]string{"f_E", "2"}) // entry level
		case "parttime":
			params = append(params, [2]string{"f_JT", "P"})
		default:
			params = append(params, [2]string{"f_JT", "I"})
		}
		if spec.EasyApplyOnly {
			params = append(params, [2]string{"f_AL", "true"})
		}
		qs := make([]string, len(params))
		for i, p := range params {
			qs[i] = formEncode(p[0]) + "=" + formEncode(p[1])
		}
		status, body, err := httpDo("GET", "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?"+strings.Join(qs, "&"), nil, map[string]string{"user-agent": discoverUA, "accept-language": "en-US,en;q=0.9"})
		if err != nil {
			return nil, err
		}
		if status == 429 {
			return nil, errors.New("LinkedIn 暂时不让搜了（请求太频繁），过几分钟再试")
		}
		if status < 200 || status > 299 {
			return nil, fmt.Errorf("LinkedIn 搜索出错（%d）", status)
		}
		cards := parseLinkedInCards(string(body))
		out = append(out, cards...)
		if len(cards) < 10 {
			break
		}
	}
	if len(out) > spec.PerQuery {
		out = out[:max(spec.PerQuery, 0)]
	}
	return out, nil
}

func mcfCompany(r any) string {
	if truthy(get(r, "metadata", "isPostedOnBehalf")) && !truthy(get(r, "metadata", "isHideHiringEmployerName")) {
		if v := get(r, "hiringCompany", "name"); truthy(v) {
			return jsString(v)
		}
	}
	if v := get(r, "postedCompany", "name"); truthy(v) {
		return jsString(v)
	}
	return ""
}

func orQ(v any) string {
	if v == nil {
		return "?"
	}
	return jsString(v)
}

// mapMcf maps results from MyCareersFuture's search API.
func mapMcf(results []any) []FoundJob {
	out := []FoundJob{}
	for _, r := range results {
		if !truthy(get(r, "metadata", "jobDetailsUrl")) || !truthy(get(r, "title")) {
			continue
		}
		s := get(r, "salary")
		salary := ""
		if truthy(s) && (truthy(get(s, "minimum")) || truthy(get(s, "maximum"))) && !truthy(get(r, "metadata", "isHideSalary")) {
			salary = "S$" + orQ(get(s, "minimum")) + "–" + orQ(get(s, "maximum"))
			if get(s, "type", "salaryType") == "Monthly" {
				salary += "/月"
			}
		}
		location := ""
		if v := get(r, "address", "districts", 0, "location"); truthy(v) {
			location = jsString(v)
		} else if a, ok := get(r, "address").([]any); ok && len(a) > 0 {
			if v := get(a[0], "location"); truthy(v) {
				location = jsString(v)
			}
		}
		if location == "" {
			location = "Singapore"
		}
		posted := ""
		if v := get(r, "metadata", "newPostingDate"); v != nil {
			posted = jsString(v)
		}
		out = append(out, FoundJob{Source: "mcf", Title: jsTrim(jsString(get(r, "title"))), Company: jsTrim(mcfCompany(r)), Location: location, Posted: posted, URL: jsString(get(r, "metadata", "jobDetailsUrl")), Salary: salary})
	}
	return out
}

func searchMcf(q string, spec SearchSpec) ([]FoundJob, error) {
	body := map[string]any{"search": q, "sortBy": []string{"new_posting_date"}}
	switch spec.Kind {
	case "fulltime":
		body["positionLevels"] = []string{"Fresh/entry level"}
		body["employmentTypes"] = []string{"Full Time"}
	case "parttime":
		body["employmentTypes"] = []string{"Part Time"}
	default:
		body["employmentTypes"] = []string{"Internship/Attachment"}
	}
	b, _ := json.Marshal(body)
	status, res, err := httpDo("POST", fmt.Sprintf("https://api.mycareersfuture.gov.sg/v2/search?limit=%d&page=0", min(50, spec.PerQuery)), b, map[string]string{"user-agent": discoverUA, "content-type": "application/json"})
	if err != nil {
		return nil, err
	}
	if status < 200 || status > 299 {
		return nil, fmt.Errorf("MyCareersFuture 搜索出错（%d）", status)
	}
	j, _ := parseAny(string(res))
	since := time.Now().Add(-time.Duration(spec.Days) * 24 * time.Hour).UTC().Format("2006-01-02")
	out := []FoundJob{}
	for _, f := range mapMcf(arr(get(j, "results"))) {
		if (f.Posted == "" || f.Posted >= since) && relevantTitle(f.Title, q) {
			out = append(out, f)
		}
	}
	return out, nil
}

var (
	filler         = map[string]bool{"part": true, "full": true, "time": true, "intern": true, "internship": true, "interns": true, "junior": true, "senior": true, "graduate": true, "fresh": true, "entry": true, "level": true, "the": true, "and": true, "for": true, "with": true, "job": true, "jobs": true, "role": true}
	reQueryWords   = regexp.MustCompile(`[^a-z0-9+#]+`)
	reMcfID        = regexp.MustCompile(`(?i)mycareersfuture\.gov\.sg/job/[^?#]*?([0-9a-f]{32})`)
	reLinkedinView = regexp.MustCompile(`(?i)linkedin\.com/jobs/view/(?:[^/?#]*-)?(\d{6,})`)
)

// relevantTitle: MyCareersFuture's search is fuzzy, so a title is kept only when it carries one of the query's own words.
func relevantTitle(title, query string) bool {
	words := []string{}
	for _, w := range reQueryWords.Split(strings.ToLower(query), -1) {
		if len(w) >= 2 && !filler[w] {
			words = append(words, w)
		}
	}
	if len(words) == 0 {
		return true
	}
	t := " " + reQueryWords.ReplaceAllString(strings.ToLower(title), " ") + " "
	for _, w := range words {
		if strings.Contains(t, " "+w+" ") || strings.Contains(t, " "+w+"s ") {
			return true
		}
	}
	return false
}

var (
	reBlockEnd   = regexp.MustCompile(`(?i)</(p|li|h\d|div|ul|ol)>|<br\s*/?>`)
	reLiOpen     = regexp.MustCompile(`(?i)<li[^>]*>`)
	reSpacesTabs = regexp.MustCompile(`[ \t]+`)
	reBlankRuns  = jsRe(`\n\s*\n\s*(\n\s*)+`, "")
)

func names(xs any, k string) string {
	out := []string{}
	for _, x := range arr(xs) {
		if v := get(x, k); truthy(v) {
			out = append(out, jsString(v))
		}
	}
	return strings.Join(out, ", ")
}

// mcfJobText is the plain text of a MyCareersFuture job from its API record.
func mcfJobText(j any) pageText {
	html := ""
	if v := get(j, "description"); v != nil {
		html = jsString(v)
	}
	description := jsTrim(reBlankRuns.ReplaceAllString(reSpacesTabs.ReplaceAllString(decodeEntities(reTag.ReplaceAllString(reLiOpen.ReplaceAllString(reBlockEnd.ReplaceAllString(html, "\n"), "• "), "")), " "), "\n\n"))
	company := mcfCompany(j)
	s := get(j, "salary")
	title := ""
	if v := get(j, "title"); v != nil {
		title = jsTrim(jsString(v))
	}
	line := func(cond bool, text string) string {
		if cond {
			return text
		}
		return ""
	}
	status := get(j, "status", "jobStatus")
	salaryLine := ""
	if truthy(s) && (truthy(get(s, "minimum")) || truthy(get(s, "maximum"))) && !truthy(get(j, "metadata", "isHideSalary")) {
		st := ""
		if v := get(s, "type", "salaryType"); v != nil {
			st = jsString(v)
		}
		salaryLine = jsTrim("Salary: S$" + orQ(get(s, "minimum")) + " to S$" + orQ(get(s, "maximum")) + " " + st)
	}
	minYears := get(j, "minimumYearsExperience")
	lines := []string{
		title,
		company,
		line(truthy(status) && status != "Open", "Status: "+jsString(status)+" (no longer accepting applications)"),
		line(names(get(j, "employmentTypes"), "employmentType") != "", "Employment type: "+names(get(j, "employmentTypes"), "employmentType")),
		line(names(get(j, "positionLevels"), "position") != "", "Position level: "+names(get(j, "positionLevels"), "position")),
		line(minYears != nil, "Minimum years of experience: "+jsString(minYears)),
		salaryLine,
		"",
		description,
		line(names(get(j, "skills"), "skill") != "", "\nSkills: "+names(get(j, "skills"), "skill")),
	}
	full := title
	if company != "" {
		full = title + " | " + company
	}
	return pageText{Title: full, Text: u16slice(jsTrim(reManyBlank.ReplaceAllString(strings.Join(lines, "\n"), "\n\n")), 24_000)}
}

// mcfPostingText: MyCareersFuture pages are a single-page app whose text can look like a sign-in wall; its own API has the whole posting.
func mcfPostingText(u string) *pageText {
	m := reMcfID.FindStringSubmatch(u)
	if m == nil {
		return nil
	}
	status, body, err := httpDo("GET", "https://api.mycareersfuture.gov.sg/v2/jobs/"+strings.ToLower(m[1]), nil, map[string]string{"user-agent": discoverUA, "accept": "application/json"})
	if err != nil || status < 200 || status > 299 {
		return nil
	}
	j, ok := parseAny(string(body))
	if !ok {
		return nil
	}
	got := mcfJobText(j)
	if u16len(got.Text) > 200 {
		return &got
	}
	return nil
}

// jobKey is one key per posting: LinkedIn serves the same job under sg./www. and with or without the title slug.
func jobKey(u string) string {
	if m := reLinkedinView.FindStringSubmatch(u); m != nil {
		return "linkedin:" + m[1]
	}
	if m := reMcfID.FindStringSubmatch(u); m != nil {
		return "mcf:" + strings.ToLower(m[1])
	}
	return normalizeURL(u)
}

var (
	reCoSuffix  = regexp.MustCompile(`\b(pte|ltd|private|limited|inc|llc)\b\.?`)
	reMergeNorm = regexp.MustCompile(`[^a-z0-9\x{4e00}-\x{9fff}]+`)
)

// mergeFound drops repeats (same posting, or the same title at the same company from the other site) and marks jobs already in the list.
func mergeFound(lists [][]FoundJob, known map[string]int64) []FoundJob {
	seen := map[string]bool{}
	out := []FoundJob{}
	n := func(s string) string {
		return jsTrim(reMergeNorm.ReplaceAllString(reCoSuffix.ReplaceAllString(strings.ToLower(s), ""), " "))
	}
	for _, list := range lists {
		for _, f := range list {
			k1 := jobKey(f.URL)
			k2 := n(f.Title) + "|" + n(f.Company)
			if seen[k1] || seen[k2] {
				continue
			}
			seen[k1] = true
			seen[k2] = true
			if id, ok := known[k1]; ok {
				f.ExistingID = &id
			} else {
				f.ExistingID = nil
			}
			out = append(out, f)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[j].Posted < out[i].Posted })
	return out
}

type SearchResult struct {
	Found  []FoundJob `json:"found"`
	Errors []string   `json:"errors"`
	Hidden int        `json:"hidden"`
}

func searchJobs(spec SearchSpec) SearchResult {
	var mu sync.Mutex
	errs := []string{}
	type task struct{ q, src string }
	tasks := []task{}
	for _, q := range spec.Queries {
		for _, src := range spec.Sources {
			tasks = append(tasks, task{q, src})
		}
	}
	lists := make([][]FoundJob, len(tasks))
	var wg sync.WaitGroup
	for i, t := range tasks {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var got []FoundJob
			err := catch(func() error {
				var err error
				if t.src == "linkedin" {
					got, err = searchLinkedIn(t.q, spec)
				} else {
					got, err = searchMcf(t.q, spec)
				}
				return err
			})
			if err != nil {
				mu.Lock()
				if !contains(errs, err.Error()) {
					errs = append(errs, err.Error())
				}
				mu.Unlock()
				got = nil
			}
			lists[i] = got
		}()
	}
	wg.Wait()
	known := map[string]int64{}
	for _, m := range queryMaps("SELECT id, url FROM jobs WHERE url != ''") {
		known[jobKey(jsString(m["url"]))] = asInt(m["id"])
	}
	merged := mergeFound(lists, known)
	found := merged
	if spec.HideSenior {
		found = []FoundJob{}
		for _, f := range merged {
			if !seniorTitle(f.Title) {
				found = append(found, f)
			}
		}
	}
	return SearchResult{Found: found, Errors: errs, Hidden: len(merged) - len(found)}
}
