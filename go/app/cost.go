// What the logged model calls cost in RMB, priced by the time of each call: DeepSeek charges half outside
// its peak hours. Prices are DeepSeek's list for deepseek-chat / V4 Flash, per million tokens, as of
// 2026-11-14 (api-docs.deepseek.com/zh-cn/quick_start/pricing). An estimate: the DeepSeek console has the bill.
package app

import "time"

type price struct{ hit, miss, out float64 }

var (
	pricePeak = price{hit: 0.04, miss: 2, out: 8}
	priceOff  = price{hit: 0.02, miss: 1, out: 4}
)

// UsageRow is one logged call. Ts is UTC in SQLite's datetime('now') format.
type UsageRow struct {
	Kind             string
	PromptTokens     int64
	CacheHitTokens   int64
	CompletionTokens int64
	Ts               string
}

// callRmb is one call's cost in RMB.
func callRmb(r UsageRow) float64 {
	t, _ := utcOf(r.Ts)
	p := priceOff
	if isPeak(t) {
		p = pricePeak
	}
	hit := min(r.CacheHitTokens, r.PromptTokens)
	return (float64(r.PromptTokens-hit)*p.miss + float64(hit)*p.hit + float64(r.CompletionTokens)*p.out) / 1e6
}

func sumRmb(rows []UsageRow) float64 {
	s := 0.0
	for _, r := range rows {
		s += callRmb(r)
	}
	return s
}

// usageRows returns the usage rows matching a WHERE clause (or all of them).
func usageRows(where string, params ...any) []UsageRow {
	out := []UsageRow{}
	for _, m := range queryMaps("SELECT kind, prompt_tokens, cache_hit_tokens, completion_tokens, ts FROM usage "+where, params...) {
		out = append(out, UsageRow{
			Kind:             jsString(m["kind"]),
			PromptTokens:     asInt(m["prompt_tokens"]),
			CacheHitTokens:   asInt(m["cache_hit_tokens"]),
			CompletionTokens: asInt(m["completion_tokens"]),
			Ts:               jsString(m["ts"]),
		})
	}
	return out
}

// ---- DeepSeek's peak hours (src/offpeak.ts): Beijing time (UTC+8, the same clock as Singapore)
// Monday to Friday 9:00–12:00 and 14:00–18:00. Public holidays count as normal weekdays.

var beijing = time.FixedZone("UTC+8", 8*3600)

func isPeak(d time.Time) bool {
	bj := d.In(beijing)
	day := bj.Weekday()
	m := bj.Hour()*60 + bj.Minute()
	return day >= time.Monday && day <= time.Friday && ((m >= 9*60 && m < 12*60) || (m >= 14*60 && m < 18*60))
}

// peakEnds is when the current peak ends (12:00 or 18:00 Beijing time); false when it is off-peak now.
func peakEnds(d time.Time) (time.Time, bool) {
	if !isPeak(d) {
		return time.Time{}, false
	}
	bj := d.In(beijing)
	h := 18
	if bj.Hour() < 12 {
		h = 12
	}
	return time.Date(bj.Year(), bj.Month(), bj.Day(), h, 0, 0, 0, beijing), true
}
