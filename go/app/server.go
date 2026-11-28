// The HTTP API (server/index.ts): same routes, JSON shapes and event stream, so the React UI works
// against either backend.
package app

import (
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Root is the repository folder: /fixtures and the built UI (dist/) are served from here.
var Root string

var localHosts = []string{"127.0.0.1", "localhost", "[::1]", "::1"}

var rePortSuffix = regexp.MustCompile(`:\d+$`)

// guard only answers requests addressed to this machine, and only accepts writes from its own pages:
// the API can submit applications and returns personal data.
func guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := rePortSuffix.ReplaceAllString(r.Host, "")
		if !contains(localHosts[:3], host) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Host == "" || !contains(localHosts, u.Hostname()) {
					http.Error(w, "forbidden origin", http.StatusForbidden)
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, jsonStr(v))
}

type req struct {
	r    *http.Request
	body map[string]any
	raw  any
}

func (q *req) id() int64 {
	n, err := strconv.ParseInt(q.r.PathValue("id"), 10, 64)
	if err != nil {
		return -1
	}
	return n
}

// wrap turns a handler's result into JSON and its error into 400 {error}, like the TS wrap().
func wrap(fn func(q *req) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := &req{r: r, body: map[string]any{}}
		if strings.Contains(r.Header.Get("Content-Type"), "json") && r.Body != nil {
			b, err := io.ReadAll(io.LimitReader(r.Body, 4<<20+1))
			if err != nil || len(b) > 4<<20 {
				writeJSON(w, 413, map[string]string{"error": "request entity too large"})
				return
			}
			if len(strings.TrimSpace(string(b))) > 0 {
				v, ok := parseAny(string(b))
				if !ok {
					writeJSON(w, 400, map[string]string{"error": "invalid JSON body"})
					return
				}
				q.raw = v
				if m, ok := v.(map[string]any); ok {
					q.body = m
				}
			}
		}
		var out any
		err := catch(func() error {
			var err error
			out, err = fn(q)
			return err
		})
		if err != nil {
			log.Printf("%s %s: %v", r.Method, r.URL.Path, err)
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		if out != nil {
			writeJSON(w, 200, out)
		}
	}
}

type RunBrief struct {
	ID      int64   `json:"id"`
	Status  string  `json:"status"`
	Outcome *string `json:"outcome"`
	Steps   int64   `json:"steps"`
	Live    bool    `json:"live"`
}

type JobView struct {
	ID         int64      `json:"id"`
	URL        string     `json:"url"`
	Title      *string    `json:"title"`
	Company    *string    `json:"company"`
	Location   *string    `json:"location"`
	Stage      string     `json:"stage"`
	Busy       *string    `json:"busy"`
	Held       *string    `json:"held"`
	Error      *string    `json:"error"`
	Notice     *string    `json:"notice"`
	AutoApply  bool       `json:"autoApply"`
	CreatedAt  string     `json:"createdAt"`
	UpdatedAt  string     `json:"updatedAt"`
	Progress   *string    `json:"progress"`
	ProgressAt *string    `json:"progressAt"`
	AppliedAt  *string    `json:"appliedAt"`
	Notes      string     `json:"notes"`
	JD         *JobJd     `json:"jd"`
	KwHave     []string   `json:"kwHave"`
	HasResume  bool       `json:"hasResume"`
	HasCover   bool       `json:"hasCover"`
	Coverage   *Coverage  `json:"coverage"`
	Warnings   int        `json:"warnings"`
	Tokens     int64      `json:"tokens"`
	Cost       float64    `json:"cost"`
	NextEvent  *NextEvent `json:"nextEvent"`
	HasPrep    bool       `json:"hasPrep"`
	Run        *RunBrief  `json:"run"`
}

func truthyStr(p *string) bool { return p != nil && *p != "" }

func jobView(j *Job, hasKw func(string) bool) JobView {
	if hasKw == nil {
		hasKw = profileHas(getProfile())
	}
	runs := listRuns(j.ID, false)
	jd := jobJd(j)
	tailored := parseTailored(j.Tailored)
	applied := j.Stage == "applied"
	used := usageRows("WHERE job_id = ?", j.ID)
	v := JobView{
		ID: j.ID, URL: j.URL, Title: j.Title, Company: j.Company, Location: j.Location, Stage: j.Stage, Busy: j.Busy, Held: j.Held,
		Error: j.Error, Notice: j.Notice, AutoApply: j.AutoApply != 0, CreatedAt: j.CreatedAt, UpdatedAt: j.UpdatedAt,
		Progress: j.Progress, ProgressAt: j.ProgressAt, AppliedAt: j.AppliedAt, Notes: sv(j.Notes), JD: jd, KwHave: []string{},
		HasResume: truthyStr(j.ResumeFile), HasCover: truthyStr(j.CoverFile), HasPrep: truthyStr(j.Prep), NextEvent: nextEvent(j.ID),
	}
	// Jobs applied before tracking existed count as "applied" from their last update.
	if applied {
		if v.Progress == nil {
			v.Progress = strp("applied")
		}
		if v.ProgressAt == nil {
			v.ProgressAt = strp(j.UpdatedAt)
		}
		if v.AppliedAt == nil {
			v.AppliedAt = strp(j.UpdatedAt)
		}
	}
	if jd != nil {
		for _, k := range jd.Keywords {
			if hasKw(k) {
				v.KwHave = append(v.KwHave, k)
			}
		}
	}
	if tailored != nil {
		c := tailored.Coverage
		v.Coverage = &c
		v.Warnings = len(tailored.Warnings)
	}
	for _, r := range used {
		v.Tokens += r.PromptTokens + r.CompletionTokens
	}
	v.Cost = sumRmb(used)
	if len(runs) > 0 {
		r := runs[0]
		v.Run = &RunBrief{ID: r.ID, Status: r.Status, Outcome: r.Outcome, Steps: r.Steps, Live: isLive(r.ID)}
	}
	return v
}

// shotOf is the run's latest screenshot, with its time so the browser refetches it when it changes.
func shotOf(runID int64) *string {
	st, err := os.Stat(filepath.Join(ShotsDir, liveShotName(runID)))
	if err != nil {
		return nil
	}
	return strp(fmt.Sprintf("%s?t=%d", liveShotName(runID), st.ModTime().UnixMilli()))
}

func runView(r RunListRow) map[string]any {
	var pending any
	if r.Pending != nil {
		if v, ok := parseAny(*r.Pending); ok {
			pending = v
		}
	}
	return map[string]any{
		"id": r.ID, "job_id": r.JobID, "status": r.Status, "pending": pending, "outcome": r.Outcome, "steps": r.Steps,
		"created_at": r.CreatedAt, "updated_at": r.UpdatedAt, "finished_at": r.FinishedAt,
		"job_title": r.JobTitle, "job_company": r.JobCompany, "job_url": r.JobURL,
		"live": isLive(r.ID), "shot": shotOf(r.ID),
	}
}

func profileStats() map[string]any {
	p := getProfile()
	bullets, answered := 0, 0
	for _, s := range p.Sections {
		for _, e := range s.Entries {
			bullets += len(e.Bullets)
		}
	}
	for _, a := range p.Answers {
		if jsTrim(a.A) != "" {
			answered++
		}
	}
	return map[string]any{
		"basics":   p.Basics.Name != "" && p.Basics.Email != "" && p.Basics.Phone != "",
		"sections": len(p.Sections),
		"bullets":  bullets,
		"facts":    u16len(jsTrim(p.ExtraFacts)),
		"answers":  len(p.Answers),
		"answered": answered,
	}
}

var (
	reTokenPrefix   = regexp.MustCompile(`^PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*`)
	reQuoteEnds     = regexp.MustCompile(`^["']|["']$`)
	reBalanceErr    = regexp.MustCompile(`余额不足|模型接口 402`)
	reHTTPStart     = regexp.MustCompile(`^https?://`)
	reShotName      = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
	reWhitespaceRun = jsRe(`\s+`, "")
)

func clampNum(v any, lo, hi float64, orZero bool) float64 {
	n := jsNumber(v, true)
	if orZero && (math.IsNaN(n) || n == 0) {
		n = 0
	}
	return math.Min(hi, math.Max(lo, math.Floor(n)))
}

func idsOf(v any) []int64 {
	a, ok := v.([]any)
	if !ok {
		return nil
	}
	out := []int64{}
	for _, x := range a {
		n := jsNumber(x, true)
		if !math.IsNaN(n) {
			out = append(out, int64(n))
		}
	}
	return out
}

const importSystem = `Convert a resume into JSON. Copy text faithfully; do not add, embellish or translate anything.
Shape: {"basics":{"name","firstName","lastName","email","phone","phoneCountryCode","location","linkedin","github","website"},
"summary": string,
"sections":[{"heading": string, "entries":[{"title": string (school/company/organisation/project, bold left), "dates": string, "subtitle": string (degree/role), "location": string, "bullets": string[]}]}],
"skills":[{"label": string, "items": string[]}],
"skillsHeading": string, "skillsPosition": number (index of the section the skills block came before)}
Put the technical skills and languages into "skills", not into "sections". A section that is only a list (e.g. awards) is one entry with empty title and the items as bullets.`

var stageLabel = map[string]string{"new": "新加入", "parsed": "已读取", "tailored": "简历已改好", "applied": "已投递", "skipped": "已跳过"}
var progLabel = map[string]string{"applied": "等回音", "screening": "笔试/测评", "interview": "面试中", "offer": "Offer", "rejected": "未通过", "withdrawn": "我放弃了"}

func csvLocal(p *string) string {
	if p == nil || *p == "" {
		return ""
	}
	t, ok := parseISO(*p)
	if !ok {
		return *p
	}
	return t.Local().Format("2006-01-02 15:04")
}

var reCSVQuote = regexp.MustCompile(`[",\n\r]`)

func csvCell(s string) string {
	if reCSVQuote.MatchString(s) {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

func jobsCSV(w http.ResponseWriter, r *http.Request) {
	rows := [][]string{{"岗位", "公司", "地点", "链接", "状态", "进展", "投递时间", "进展更新", "下一个日程", "匹配度", "类型", "经验要求", "学历", "申请限制", "要交的材料", "薪资", "备注", "加入时间"}}
	hasKw := profileHas(getProfile())
	for _, j := range listJobs() {
		v := jobView(j, hasKw)
		var f *JobFacts
		if v.JD != nil {
			f = v.JD.Facts
		}
		stage := stageLabel[v.Stage]
		if stage == "" {
			stage = v.Stage
		}
		prog := ""
		if v.Progress != nil {
			prog = progLabel[*v.Progress]
		}
		next := ""
		if v.NextEvent != nil {
			next = EventLabel[v.NextEvent.Kind] + " " + csvLocal(&v.NextEvent.At)
		}
		score := ""
		if v.JD != nil && v.JD.Fit != nil {
			score = numStr(v.JD.Fit.Score)
		}
		typ, years, degree, limits, mats, salary := "", "", "", "", "", ""
		if f != nil {
			typ = typeLabel(f)
			if typ == "" {
				typ = "没写"
			}
			years = "没写"
			if f.MinYears != nil {
				years = yearsLabel(*f.MinYears)
			}
			degree = DegreeLabel[f.Degree]
			lim := []string{}
			if f.WorkAuth != "" {
				lim = append(lim, AuthLabel[f.WorkAuth])
			}
			if f.Student == "graduated" {
				lim = append(lim, "须已毕业")
			}
			if f.Student == "enrolled" {
				lim = append(lim, "须在读")
			}
			if v.JD.Closed {
				lim = append(lim, "已关闭")
			}
			limits = strings.Join(lim, "、")
			ms := []string{}
			for _, m := range f.Materials {
				ms = append(ms, MaterialLabel[m])
			}
			mats = strings.Join(ms, "、")
			salary = f.Salary
		}
		rows = append(rows, []string{sv(v.Title), sv(v.Company), sv(v.Location), v.URL, stage, prog, csvLocal(v.AppliedAt), csvLocal(v.ProgressAt), next, score, typ, years, degree, limits, mats, salary, v.Notes, csvLocal(&v.CreatedAt)})
	}
	lines := make([]string, len(rows))
	for i, row := range rows {
		cells := make([]string, len(row))
		for k, c := range row {
			cells[k] = csvCell(c)
		}
		lines[i] = strings.Join(cells, ",")
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="jobs-`+time.Now().Format("20060102")+`.csv"`)
	_, _ = io.WriteString(w, "\xef\xbb\xbf"+strings.Join(lines, "\r\n"))
}

func sendFile(w http.ResponseWriter, r *http.Request, file, disposition string) {
	if disposition != "" {
		w.Header().Set("Content-Disposition", disposition)
	}
	http.ServeFile(w, r, file)
}

func usageSum(where string) map[string]any {
	rows := usageRows(where)
	var in, out, cached int64
	for _, r := range rows {
		in += r.PromptTokens
		out += r.CompletionTokens
		cached += r.CacheHitTokens
	}
	return map[string]any{"calls": len(rows), "input": in, "output": out, "cached": cached, "rmb": sumRmb(rows)}
}

// Handler is the whole API plus /fixtures and the built UI.
func Handler() http.Handler {
	initAgent()
	afterParse = func(id int64) {
		j := getJob(id)
		if j == nil {
			return
		}
		jd := jobJd(j)
		if jd != nil && jd.Closed {
			return
		}
		minFit := GetSettings().MinFit
		if minFit > 0 && jd != nil && jd.Fit != nil && jd.Fit.Score < float64(minFit) {
			setJob(id, P{"auto_apply": 0, "notice": fmt.Sprintf("匹配度 %s，低于你设的 %d 分，所以没有自动改简历和投递", numStr(jd.Fit.Score), minFit)})
			return
		}
		advance(id)
	}

	mux := http.NewServeMux()
	h := func(pattern string, fn func(q *req) (any, error)) { mux.HandleFunc(pattern, wrap(fn)) }

	// ---- state & settings
	h("GET /api/state", func(q *req) (any, error) {
		bs := browserState()
		return map[string]any{
			"settings":    PublicSettings(),
			"browserOpen": browserOpen(),
			"browser":     map[string]any{"status": bs.Status, "error": bs.Error, "tokenSet": bs.TokenSet, "extensionUrl": ExtensionURL},
			"demo":        isDemo(),
			"llm":         llmReady(),
			"profile":     profileStats(),
			"sites":       loginSites(),
		}, nil
	})
	h("GET /api/usage", func(q *req) (any, error) {
		type kindRow struct {
			Kind   string  `json:"kind"`
			Calls  int     `json:"calls"`
			Tokens int64   `json:"tokens"`
			Rmb    float64 `json:"rmb"`
		}
		order := []string{}
		kinds := map[string]*kindRow{}
		for _, r := range usageRows("") {
			k, ok := kinds[r.Kind]
			if !ok {
				k = &kindRow{Kind: r.Kind}
				kinds[r.Kind] = k
				order = append(order, r.Kind)
			}
			k.Calls++
			k.Tokens += r.PromptTokens + r.CompletionTokens
			k.Rmb += callRmb(r)
		}
		byKind := []kindRow{}
		for _, k := range order {
			byKind = append(byKind, *kinds[k])
		}
		sort.SliceStable(byKind, func(i, j int) bool { return byKind[i].Rmb > byKind[j].Rmb })
		return map[string]any{
			"today":  usageSum("WHERE ts >= datetime('now', 'localtime', 'start of day', 'utc')"),
			"month":  usageSum("WHERE ts >= datetime('now', 'localtime', 'start of month', 'utc')"),
			"total":  usageSum(""),
			"byKind": byKind,
		}, nil
	})
	mux.HandleFunc("GET /api/events", addClient)
	h("PUT /api/settings", func(q *req) (any, error) {
		patch := map[string]any{}
		for k, v := range q.body {
			patch[k] = v
		}
		if s, ok := q.body["apiKey"].(string); ok {
			patch["apiKey"] = jsTrim(s)
		}
		// The extension's status page shows (and its copy button copies) "PLAYWRIGHT_MCP_EXTENSION_TOKEN=…".
		if s, ok := q.body["extensionToken"].(string); ok {
			patch["extensionToken"] = reQuoteEnds.ReplaceAllString(reTokenPrefix.ReplaceAllString(jsTrim(s), ""), "")
		}
		if v, ok := patch["concurrency"]; ok {
			patch["concurrency"] = clampNum(v, 1, 4, false)
		}
		if v, ok := patch["minFit"]; ok {
			patch["minFit"] = clampNum(v, 0, 100, true)
		}
		if v, ok := patch["maxSteps"]; ok {
			patch["maxSteps"] = clampNum(v, 10, 120, false)
		}
		before := GetSettings()
		SaveSettings(patch)
		after := GetSettings()
		// A different browser or token needs a fresh connection (runs in progress are cancelled).
		if after.BrowserChannel != before.BrowserChannel || after.ExtensionToken != before.ExtensionToken {
			go closeAll()
		}
		// Another key, endpoint or mode: the old "balance used up" no longer says anything.
		if after.APIKey != before.APIKey || after.BaseURL != before.BaseURL || after.LLMMode != before.LLMMode {
			setNoBalance(nil)
			goSafely("balance", func() { getBalance(true) })
		}
		// Turning the off-peak wait off starts whatever was waiting.
		pump(time.Now())
		emit("settings")
		return PublicSettings(), nil
	})
	h("GET /api/balance", func(q *req) (any, error) { return map[string]any{"balance": getBalance(false)}, nil })
	// "充好了，继续": checks the balance, then retries what stopped on it.
	h("POST /api/llm/resume", func(q *req) (any, error) {
		if b := getBalance(true); b != nil && !b.Available {
			return nil, errors.New("DeepSeek 显示余额还是不够（" + money(*b) + "），到账后再点")
		}
		setNoBalance(nil)
		retried := 0
		for _, j := range listJobs() {
			if j.Error == nil || !reBalanceErr.MatchString(*j.Error) || truthyStr(j.Busy) {
				continue
			}
			setJob(j.ID, P{"error": nil})
			switch {
			case !truthyStr(j.JD):
				queueParse(j.ID)
			case j.AutoApply != 0 && j.Stage != "applied" && j.Stage != "skipped":
				advance(j.ID)
			default:
				continue
			}
			retried++
		}
		pump(time.Now())
		return map[string]any{"retried": retried}, nil
	})
	h("POST /api/settings/test", func(q *req) (any, error) {
		r, err := chatJSON(`Reply with JSON {"ok": true}.`, "ping", 20, &UsageTag{Kind: "test"})
		if err != nil {
			return nil, err
		}
		return map[string]any{"ok": get(r, "ok") == true, "model": GetSettings().Model}, nil
	})
	h("POST /api/browser/open", func(q *req) (any, error) {
		if u, ok := q.body["url"].(string); ok && reHTTPStart.MatchString(u) {
			if _, err := newVisiblePage(u); err != nil {
				return nil, err
			}
		} else {
			goSafely("reconnect", func() { _ = reconnect() })
		}
		return map[string]any{"ok": true}, nil
	})

	// ---- finding jobs
	h("POST /api/discover", func(q *req) (any, error) {
		b := q.body
		queries := []string{}
		for _, x := range arr(b["queries"]) {
			s := ""
			if x != nil {
				s = jsTrim(jsString(x))
			}
			if s != "" && len(queries) < 8 {
				queries = append(queries, s)
			}
		}
		if len(queries) == 0 {
			return nil, errors.New("至少填一个关键词")
		}
		kind := "fulltime"
		if k, _ := b["kind"].(string); k == "parttime" || k == "internship" {
			kind = k
		}
		sources := []string{}
		for _, x := range arr(b["sources"]) {
			if x == "linkedin" || x == "mcf" {
				sources = append(sources, x.(string))
			}
		}
		if len(sources) == 0 {
			return nil, errors.New("至少选一个网站")
		}
		num := func(k string, dflt float64) float64 {
			n := jsNumber(b[k], has(b, k))
			if math.IsNaN(n) || n == 0 {
				return dflt
			}
			return n
		}
		days := int(math.Min(30, math.Max(1, jsRound(num("days", 7)))))
		perQuery := int(math.Min(50, math.Max(10, jsRound(num("perQuery", 25)))))
		return searchJobs(SearchSpec{Queries: queries, Kind: kind, Days: days, Sources: sources, EasyApplyOnly: b["easyApplyOnly"] != false, PerQuery: perQuery, HideSenior: b["hideSenior"] != false}), nil
	})

	// ---- profile
	h("GET /api/profile", func(q *req) (any, error) {
		return map[string]any{"profile": getProfile(), "commonQuestions": CommonQuestions}, nil
	})
	h("PUT /api/profile", func(q *req) (any, error) {
		p := saveProfile(normalizeProfile(q.raw))
		emit("profile")
		return map[string]any{"profile": p}, nil
	})
	mux.HandleFunc("GET /api/profile/resume.html", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, resumeHtml(masterDoc(getProfile()), 1))
	})
	mux.HandleFunc("POST /api/profile/import", wrap(func(q *req) (any, error) {
		if isDemo() {
			return nil, errors.New("从 PDF 导入需要模型：先在设置里填 DeepSeek key 并关闭演示模式")
		}
		if ready := llmReady(); !ready.OK {
			return nil, errors.New(ready.Reason)
		}
		ct := q.r.Header.Get("Content-Type")
		var buf []byte
		if strings.HasPrefix(ct, "application/pdf") || strings.HasPrefix(ct, "application/octet-stream") {
			b, err := io.ReadAll(io.LimitReader(q.r.Body, 15<<20+1))
			if err != nil {
				return nil, err
			}
			if len(b) > 15<<20 {
				return nil, errors.New("request entity too large")
			}
			buf = b
		}
		if len(buf) == 0 {
			return nil, errors.New("没收到文件")
		}
		text, err := pdfText(buf)
		if err != nil {
			return nil, err
		}
		if u16len(text) < 100 {
			return nil, errors.New("PDF 里读不到文字（可能是扫描件）")
		}
		out, err := chatJSON(importSystem, u16slice(text, 20_000), 6000, &UsageTag{Kind: "import"})
		if err != nil {
			return nil, err
		}
		cur := getProfile()
		m := map[string]any{}
		for k, v := range obj(out) {
			m[k] = v
		}
		m["extraFacts"] = cur.ExtraFacts
		m["answers"] = toAny(cur.Answers)
		return map[string]any{"profile": normalizeProfile(m), "text": text}, nil
	}))

	// ---- jobs
	h("GET /api/jobs", func(q *req) (any, error) {
		hasKw := profileHas(getProfile())
		views := []JobView{}
		for _, j := range listJobs() {
			views = append(views, jobView(j, hasKw))
		}
		return map[string]any{"jobs": views}, nil
	})
	h("POST /api/jobs", func(q *req) (any, error) {
		urls := []string{}
		if a, ok := q.body["urls"].([]any); ok {
			for _, x := range a {
				urls = append(urls, jsString(x))
			}
		} else {
			s := ""
			if v, ok := q.body["urls"]; ok && v != nil {
				s = jsString(v)
			}
			urls = reWhitespaceRun.Split(s, -1)
		}
		jdText := ""
		if s, ok := q.body["jdText"].(string); ok {
			jdText = jsTrim(s)
		}
		any := false
		for _, u := range urls {
			if jsTrim(u) != "" {
				any = true
			}
		}
		if !any && jdText == "" {
			return nil, errors.New("请粘贴岗位链接或 JD")
		}
		return addJobs(urls, jdText, truthy(q.body["autoApply"])), nil
	})
	mux.HandleFunc("GET /api/jobs.csv", jobsCSV)
	h("GET /api/jobs/{id}", func(q *req) (any, error) {
		j := getJob(q.id())
		if j == nil {
			return nil, errors.New("岗位不存在")
		}
		rows := listRuns(j.ID, false)
		runs := []map[string]any{}
		for _, r := range rows {
			runs = append(runs, runView(r))
		}
		profile := getProfile()
		jd := jobJd(j)
		steps := []RunStep{}
		if len(rows) > 0 {
			steps = runSteps(rows[0].ID)
		}
		var prepRaw, draftsRaw any
		if j.Prep != nil {
			prepRaw, _ = parseAny(*j.Prep)
		}
		draftsRaw = map[string]any{}
		if j.Drafts != nil {
			if v, ok := parseAny(*j.Drafts); ok {
				draftsRaw = v
			}
		}
		prepping, prepError := prepState(j.ID)
		var tailored any
		if t := parseTailored(j.Tailored); t != nil {
			tailored = t
		}
		var jobID = j.ID
		return map[string]any{
			"job": struct {
				JobView
				JDText      *string `json:"jdText"`
				CoverLetter string  `json:"coverLetter"`
			}{jobView(j, nil), j.JDText, sv(j.CoverLetter)},
			"tailored":  tailored,
			"runs":      runs,
			"steps":     steps,
			"events":    listEvents(&jobID, false),
			"log":       progressLog(j.ID),
			"prep":      prepView(prepRaw, profile, jd),
			"drafts":    draftsView(draftsRaw, profile, jd),
			"prepping":  prepping,
			"prepError": prepError,
		}, nil
	})
	h("PATCH /api/jobs/{id}", func(q *req) (any, error) {
		j := getJob(q.id())
		if j == nil {
			return nil, errors.New("岗位不存在")
		}
		b := q.body
		patch := P{}
		if b["stage"] == "skipped" || b["stage"] == "applied" {
			patch["stage"] = b["stage"].(string)
			patch["held"] = nil
		}
		if b["stage"] == "restore" {
			switch {
			case truthyStr(j.Tailored):
				patch["stage"] = "tailored"
			case truthyStr(j.JD):
				patch["stage"] = "parsed"
			default:
				patch["stage"] = "new"
			}
		}
		if s, ok := b["jdText"].(string); ok {
			patch["jd_text"] = s
		}
		if s, ok := b["url"].(string); ok {
			patch["url"] = jsTrim(s)
		}
		if s, ok := b["notes"].(string); ok {
			patch["notes"] = u16slice(s, 5000)
		}
		if s, ok := b["progress"].(string); ok && contains(ProgressKinds, s) {
			patch["progress"] = s
			patch["progress_at"] = sqlNow()
			// Recording progress on a job you applied to by hand marks it applied.
			if j.Stage != "applied" {
				patch["stage"] = "applied"
			}
		}
		setJob(j.ID, patch)
		return jobView(getJob(j.ID), nil), nil
	})
	h("DELETE /api/jobs/{id}", func(q *req) (any, error) {
		id := q.id()
		runIDs := []int64{}
		for _, r := range listRuns(id, false) {
			runIDs = append(runIDs, r.ID)
		}
		for _, r := range listRuns(id, true) {
			reply(r.ID, UserReply{Type: "cancel"})
		}
		mustExec("DELETE FROM jobs WHERE id = ?", id)
		// Its PDFs and screenshots go too.
		_ = os.RemoveAll(filepath.Join(FilesDir, fmt.Sprintf("job-%d", id)))
		if entries, err := os.ReadDir(ShotsDir); err == nil {
			for _, e := range entries {
				for _, r := range runIDs {
					if strings.HasPrefix(e.Name(), fmt.Sprintf("run-%d-", r)) {
						_ = os.Remove(filepath.Join(ShotsDir, e.Name()))
					}
				}
			}
		}
		emit("job", id)
		return map[string]any{"ok": true}, nil
	})
	// A button on one job runs now, even while batch work waits for off-peak; it takes the job out of the wait.
	h("POST /api/jobs/{id}/parse", func(q *req) (any, error) {
		setJob(q.id(), P{"held": nil})
		queueParse(q.id())
		return map[string]any{"ok": true}, nil
	})
	h("POST /api/jobs/{id}/tailor", func(q *req) (any, error) {
		setJob(q.id(), P{"held": nil})
		queueTailor(q.id(), nil)
		return map[string]any{"ok": true}, nil
	})
	h("POST /api/jobs/{id}/cover-letter", func(q *req) (any, error) {
		cl, err := writeCoverLetter(q.id())
		if err != nil {
			return nil, err
		}
		return map[string]any{"text": cl.Text}, nil
	})
	h("POST /api/jobs/{id}/apply", func(q *req) (any, error) {
		runID, err := startRun(q.id())
		if err != nil {
			return nil, err
		}
		setJob(q.id(), P{"notice": nil, "held": nil})
		return map[string]any{"runId": runID}, nil
	})
	// Whatever is left for each job: read → tailor → fill (the last two wait for off-peak when that is on).
	h("POST /api/jobs/pipeline", func(q *req) (any, error) {
		for _, id := range idsOf(q.body["ids"]) {
			j := getJob(id)
			if j == nil || truthyStr(j.Busy) || truthyStr(j.Held) || j.Stage == "applied" || j.Stage == "skipped" {
				continue
			}
			// You picked these by hand, so a low fit score does not stop them.
			setJob(id, P{"auto_apply": 1, "notice": nil})
			if !truthyStr(j.JD) {
				queueParse(id)
			} else {
				advance(id)
			}
		}
		return map[string]any{"ok": true}, nil
	})
	h("POST /api/jobs/run-now", func(q *req) (any, error) {
		runNow(idsOf(q.body["ids"]))
		return map[string]any{"ok": true}, nil
	})
	h("PUT /api/jobs/{id}/tailored", func(q *req) (any, error) {
		j := getJob(q.id())
		if j == nil {
			return nil, errors.New("岗位不存在")
		}
		t := parseTailored(j.Tailored)
		if t == nil {
			return nil, errors.New("还没有定制简历")
		}
		m := map[string]any{}
		for k, v := range obj(q.body["doc"]) {
			m[k] = v
		}
		m["extraFacts"] = ""
		m["answers"] = []any{}
		doc := normalizeProfile(m)
		t.Doc = ResumeDoc{Basics: t.Doc.Basics, Summary: doc.Summary, Sections: doc.Sections, Skills: doc.Skills, SkillsHeading: doc.SkillsHeading, SkillsPosition: doc.SkillsPosition}
		t.Coverage.After = coverage(t.Doc, t.Coverage.Keywords)
		var letter any = j.CoverLetter
		if s, ok := q.body["coverLetter"].(string); ok {
			letter = s
		} else if j.CoverLetter == nil {
			letter = nil
		} else {
			letter = *j.CoverLetter
		}
		setJob(j.ID, P{"tailored": jsonStr(t), "cover_letter": letter})
		if err := renderJobFiles(j.ID); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})
	mux.HandleFunc("GET /api/jobs/{id}/resume.html", func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		var t *Tailored
		if j := getJob(id); j != nil {
			t = parseTailored(j.Tailored)
		}
		if t == nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(404)
			_, _ = io.WriteString(w, "还没有定制简历")
			return
		}
		scale := 1.0
		if t.Scale != nil {
			scale = *t.Scale
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, resumeHtml(t.Doc, scale))
	})
	for _, rc := range []struct{ route, col string }{{"resume.pdf", "resume"}, {"cover.pdf", "cover"}} {
		mux.HandleFunc("GET /api/jobs/{id}/"+rc.route, func(w http.ResponseWriter, r *http.Request) {
			id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
			file := ""
			if j := getJob(id); j != nil {
				if rc.col == "resume" {
					file = sv(j.ResumeFile)
				} else {
					file = sv(j.CoverFile)
				}
			}
			if file == "" || !fileExists(file) {
				http.Error(w, "not found", 404)
				return
			}
			kind := "inline"
			if r.URL.Query().Get("download") != "" {
				kind = "attachment"
			}
			sendFile(w, r, file, kind+`; filename="`+filepath.Base(file)+`"`)
		})
	}

	// ---- schedule (interviews, tests, deadlines)
	h("GET /api/schedule", func(q *req) (any, error) {
		return map[string]any{"events": listEvents(nil, q.r.URL.Query().Get("upcoming") == "1")}, nil
	})
	h("POST /api/jobs/{id}/schedule", func(q *req) (any, error) {
		id, err := addEvent(q.id(), q.body)
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": id}, nil
	})
	h("PATCH /api/schedule/{id}", func(q *req) (any, error) {
		if err := updateEvent(q.id(), q.body); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})
	h("DELETE /api/schedule/{id}", func(q *req) (any, error) {
		deleteEvent(q.id())
		return map[string]any{"ok": true}, nil
	})
	mux.HandleFunc("GET /api/schedule/{id}/calendar.ics", func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		ev := getEvent(id)
		if ev == nil {
			http.Error(w, "not found", 404)
			return
		}
		w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="event-%d.ics"`, ev.ID))
		_, _ = io.WriteString(w, icsFor(*ev))
	})

	// ---- after applying: interview prep, email drafts, stats
	h("POST /api/jobs/{id}/prep", func(q *req) (any, error) {
		if err := queuePrep(q.id()); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})
	h("POST /api/jobs/{id}/draft", func(q *req) (any, error) {
		kind, _ := q.body["kind"].(string)
		if !contains(DraftKinds, kind) {
			return nil, errors.New("bad kind")
		}
		extra := ""
		if s, ok := q.body["extra"].(string); ok {
			extra = u16slice(jsTrim(s), 1000)
		}
		d, err := makeDraft(q.id(), kind, extra)
		if err != nil {
			return nil, err
		}
		return map[string]any{"draft": d}, nil
	})
	h("GET /api/stats", func(q *req) (any, error) { return stats(), nil })
	h("GET /api/profile/asked", func(q *req) (any, error) {
		return map[string]any{"asked": askedQuestions(similarity, getProfile().Answers)}, nil
	})

	// ---- runs
	h("GET /api/runs", func(q *req) (any, error) {
		runs := []map[string]any{}
		for _, r := range listRuns(0, q.r.URL.Query().Get("active") == "1") {
			runs = append(runs, runView(r))
		}
		return map[string]any{"runs": runs}, nil
	})
	h("GET /api/runs/{id}", func(q *req) (any, error) {
		for _, r := range listRuns(0, false) {
			if r.ID == q.id() {
				return map[string]any{"run": runView(r), "steps": runSteps(r.ID)}, nil
			}
		}
		return nil, errors.New("没有这条记录")
	})
	h("POST /api/runs/{id}/reply", func(q *req) (any, error) {
		typ, _ := q.body["type"].(string)
		if !contains([]string{"answer", "resume", "confirm", "revise", "cancel"}, typ) {
			return nil, errors.New("bad reply")
		}
		r := getRun(q.id())
		if r == nil {
			return nil, errors.New("没有这条记录")
		}
		if typ == "confirm" && r.Status != "awaiting_confirm" {
			return nil, errors.New("这份申请现在不在等确认")
		}
		ur := UserReply{Type: typ, Answer: jsString(q.body["answer"]), Remember: q.body["remember"] == true, Feedback: jsString(q.body["feedback"])}
		if q.body["answer"] == nil {
			ur.Answer = ""
		}
		if q.body["feedback"] == nil {
			ur.Feedback = ""
		}
		if !reply(r.ID, ur) {
			return nil, errors.New("这次填写已经结束了")
		}
		return map[string]any{"ok": true}, nil
	})
	h("POST /api/runs/{id}/focus", func(q *req) (any, error) { return map[string]any{"ok": focusRun(q.id())}, nil })
	mux.HandleFunc("GET /api/shots/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if !reShotName.MatchString(name) {
			w.WriteHeader(400)
			return
		}
		file := filepath.Join(ShotsDir, name)
		if st, err := os.Stat(file); err != nil || st.IsDir() {
			w.WriteHeader(404)
			return
		}
		sendFile(w, r, file, "")
	})

	// ---- profile helpers for the UI
	h("POST /api/profile/answers", func(q *req) (any, error) {
		p := getProfile()
		qtext := ""
		if v, ok := q.body["q"]; ok && v != nil {
			qtext = jsTrim(jsString(v))
		}
		if qtext == "" {
			return nil, errors.New("问题不能为空")
		}
		a := ""
		if v, ok := q.body["a"]; ok && v != nil {
			a = jsString(v)
		}
		p.Answers = append(p.Answers, Answer{ID: newID("qa"), Q: qtext, A: a})
		p = saveProfile(p)
		emit("profile")
		return map[string]any{"profile": p}, nil
	})
	// pdf.js for the PDF import, served same-origin to the headless page that runs it.
	mux.HandleFunc("GET /api/_pdfjs/{file}", servePdfjs)

	// ---- static: the test job pages and, when built, the UI
	mux.Handle("GET /fixtures/", http.StripPrefix("/fixtures/", http.FileServer(http.Dir(filepath.Join(Root, "fixtures")))))
	dist := filepath.Join(Root, "dist")
	if st, err := os.Stat(dist); err == nil && st.IsDir() {
		files := http.FileServer(http.Dir(dist))
		mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				http.NotFound(w, r)
				return
			}
			clean := filepath.Join(dist, filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/")))
			if st, err := os.Stat(clean); err == nil && !st.IsDir() && strings.HasPrefix(clean, dist) {
				files.ServeHTTP(w, r)
				return
			}
			if r.URL.Path == "/" {
				files.ServeHTTP(w, r)
				return
			}
			http.ServeFile(w, r, filepath.Join(dist, "index.html"))
		})
	}
	return guard(mux)
}

// DistExists reports whether the built UI is there to serve.
func DistExists() bool {
	st, err := os.Stat(filepath.Join(Root, "dist"))
	return err == nil && st.IsDir()
}

// Background starts what the TS server starts on load: the off-peak pump and the first balance check.
func Background() {
	go func() {
		t := time.NewTicker(10 * time.Second)
		for range t.C {
			safely("pump", func() { pump(time.Now()) })
		}
	}()
	safely("pump", func() { pump(time.Now()) })
	// Know about an empty balance before the first job runs into it (the balance endpoint is free).
	goSafely("balance", func() { getBalance(true) })
}

// Shutdown closes the browsers this server opened (their throwaway profiles go with them).
func Shutdown() { closeAll() }
