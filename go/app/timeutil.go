package app

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	reHasZone = regexp.MustCompile(`[zZ]|[+-]\d\d:?\d\d$`)
	reISO     = regexp.MustCompile(`^([+-]\d{6}|\d{4})(?:-(\d\d)(?:-(\d\d))?)?(?:[T ](\d\d):(\d\d)(?::(\d\d)(?:[.,](\d+))?)?)?\s*(Z|z|[+-]\d\d(?::?\d\d)?)?$`)
)

// parseISO reads a time the way the TS code does with
// new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`): no zone means UTC.
func parseISO(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	if !reHasZone.MatchString(s) {
		s = strings.Replace(s, " ", "T", 1) + "Z"
	}
	m := reISO.FindStringSubmatch(s)
	if m == nil {
		for _, layout := range []string{time.RFC1123Z, time.RFC1123, time.RFC3339Nano} {
			if t, err := time.Parse(layout, s); err == nil {
				return t, true
			}
		}
		return time.Time{}, false
	}
	num := func(x string, dflt int) int {
		if x == "" {
			return dflt
		}
		n, _ := strconv.Atoi(x)
		return n
	}
	year := num(m[1], 0)
	month := num(m[2], 1)
	day := num(m[3], 1)
	hour, min, sec := num(m[4], 0), num(m[5], 0), num(m[6], 0)
	nsec := 0
	if m[7] != "" {
		frac := (m[7] + "000000000")[:9]
		nsec, _ = strconv.Atoi(frac)
	}
	if month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || min > 59 || sec > 59 {
		return time.Time{}, false
	}
	loc := time.UTC
	if z := m[8]; z != "" && z != "Z" && z != "z" {
		sign := 1
		if z[0] == '-' {
			sign = -1
		}
		digits := strings.ReplaceAll(z[1:], ":", "")
		h, _ := strconv.Atoi(digits[:2])
		mm := 0
		if len(digits) >= 4 {
			mm, _ = strconv.Atoi(digits[2:4])
		}
		loc = time.FixedZone("", sign*(h*3600+mm*60))
	} else if z == "" && m[4] != "" {
		// A date-time without a zone is local time in JavaScript; every caller here appends Z first.
		loc = time.Local
	}
	t := time.Date(year, time.Month(month), day, hour, min, sec, nsec, loc)
	if t.Day() != day {
		return time.Time{}, false
	}
	return t, true
}

// toISO is Date.prototype.toISOString.
func toISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// toSQL is a time in SQLite's datetime('now') format (UTC).
func toSQL(t time.Time) string { return t.UTC().Format("2006-01-02 15:04:05") }

// utcOf reads a stored "YYYY-MM-DD HH:MM:SS" UTC time (new Date(`${s.replace(" ", "T")}Z`)).
func utcOf(s string) (time.Time, bool) {
	return parseISO(strings.Replace(s, " ", "T", 1) + "Z")
}
