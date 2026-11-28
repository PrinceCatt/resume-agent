// Helpers that give Go the JavaScript semantics the TypeScript server relies on: what \s matches in a
// regular expression, string lengths and slices in UTF-16 code units, JSON.stringify without HTML
// escaping, and the loose typing of values parsed from JSON (truthiness, Number(), String()).
package app

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"
	"unicode/utf8"
)

// The characters JavaScript's \s matches (Go's \s is ASCII only).
const jsSpaceChars = `\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// jsRegexSource rewrites a JavaScript pattern for Go's RE2: \s and \S get JavaScript's meaning.
func jsRegexSource(src string) string {
	var b strings.Builder
	inClass := false
	for i := 0; i < len(src); i++ {
		c := src[i]
		if c == '\\' && i+1 < len(src) {
			n := src[i+1]
			switch {
			case n == 's' && inClass:
				b.WriteString(jsSpaceChars)
			case n == 's':
				b.WriteString("[" + jsSpaceChars + "]")
			case n == 'S' && !inClass:
				b.WriteString("[^" + jsSpaceChars + "]")
			default:
				b.WriteByte(c)
				b.WriteByte(n)
			}
			i++
			continue
		}
		if c == '[' && !inClass {
			inClass = true
		} else if c == ']' && inClass {
			inClass = false
		}
		b.WriteByte(c)
	}
	return b.String()
}

// jsRe compiles a JavaScript regular expression (source and flags such as "i", "m").
func jsRe(src, flags string) *regexp.Regexp {
	prefix := ""
	if flags != "" {
		f := ""
		for _, c := range flags {
			switch c {
			case 'i', 'm', 's':
				f += string(c)
			}
		}
		if f != "" {
			prefix = "(?" + f + ")"
		}
	}
	return regexp.MustCompile(prefix + jsRegexSource(src))
}

var reCache sync.Map

// jsReCached compiles once per (source, flags), for patterns built at run time.
func jsReCached(src, flags string) *regexp.Regexp {
	key := flags + "\x00" + src
	if r, ok := reCache.Load(key); ok {
		return r.(*regexp.Regexp)
	}
	r := jsRe(src, flags)
	reCache.Store(key, r)
	return r
}

// u16len is JavaScript's String.length: UTF-16 code units.
func u16len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// u16cut returns the byte offset of UTF-16 unit `n` (never splitting a surrogate pair: it stops before it).
func u16cut(s string, n int) int {
	if n <= 0 {
		return 0
	}
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			return i
		}
		units += w
	}
	return len(s)
}

// u16slice is s.slice(0, n) for n >= 0.
func u16slice(s string, n int) string { return s[:u16cut(s, n)] }

// u16from is s.slice(n).
func u16from(s string, n int) string { return s[u16cut(s, n):] }

// trunc keeps s as is up to n units, else its first n units plus "…" (used for log lines).
func trunc(s string, n int) string {
	if u16len(s) <= n {
		return s
	}
	return u16slice(s, n)
}

// jsTrim is String.prototype.trim (Unicode whitespace and the BOM).
func jsTrim(s string) string {
	return strings.TrimFunc(s, isJSSpace)
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

var reWS = jsRe(`\s+`, "")

// squashSpace is s.replace(/\s+/g, " ").trim().
func squashSpace(s string) string { return jsTrim(reWS.ReplaceAllString(s, " ")) }

// jsonStr is JSON.stringify for one value: no HTML escaping, no trailing newline.
func jsonStr(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "null"
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

// parseAny is JSON.parse into plain values (maps, slices, float64, string, bool, nil); ok is false on bad JSON.
func parseAny(s string) (any, bool) {
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		return nil, false
	}
	return v, true
}

// ---- loose values (what JSON.parse gives JavaScript)

// obj returns v as a map, or nil.
func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// arr returns v as a slice, or nil.
func arr(v any) []any {
	a, _ := v.([]any)
	return a
}

// get follows keys (string) and indexes (int) like a?.b?.[0]; nil when anything is missing.
func get(v any, path ...any) any {
	for _, p := range path {
		switch k := p.(type) {
		case string:
			m, ok := v.(map[string]any)
			if !ok {
				return nil
			}
			v = m[k]
		case int:
			a, ok := v.([]any)
			if !ok || k < 0 || k >= len(a) {
				return nil
			}
			v = a[k]
		}
	}
	return v
}

// has reports whether the key is present (so undefined and null can be told apart).
func has(m map[string]any, k string) bool {
	if m == nil {
		return false
	}
	_, ok := m[k]
	return ok
}

// truthy is JavaScript truthiness for parsed JSON.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int:
		return x != 0
	case int64:
		return x != 0
	case string:
		return x != ""
	}
	return true
}

// jsString is String(v) for parsed JSON (null and undefined as "" where the TS code does `v == null ? ""`).
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return numStr(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = jsString(e)
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	}
	return ""
}

// numStr formats a number the way JavaScript prints it (for the integers and short decimals used here).
func numStr(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 0) {
		if f > 0 {
			return "Infinity"
		}
		return "-Infinity"
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// strOr returns v when it is a string, else "".
func strOr(v any) string {
	s, _ := v.(string)
	return s
}

// jsNumber is Number(v): NaN for undefined, objects and text that is not a number.
func jsNumber(v any, present bool) float64 {
	if !present {
		return math.NaN()
	}
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case string:
		return parseJSNumber(x)
	case []any:
		if len(x) == 0 {
			return 0
		}
		if len(x) == 1 {
			return jsNumber(x[0], true)
		}
	}
	return math.NaN()
}

func parseJSNumber(s string) float64 {
	t := jsTrim(s)
	if t == "" {
		return 0
	}
	lower := strings.ToLower(t)
	if strings.HasPrefix(lower, "0x") {
		if n, err := strconv.ParseInt(t[2:], 16, 64); err == nil {
			return float64(n)
		}
		return math.NaN()
	}
	switch t {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if strings.ContainsAny(lower, "abcdfghijklmnopqrstuvwxyz_") || strings.Contains(lower, "inf") || strings.Contains(lower, "nan") {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

// finite reports Number.isFinite(v): only real numbers, never strings.
func finite(v any) (float64, bool) {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// jsRound is Math.round (halves go up).
func jsRound(x float64) float64 {
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// fixed is Number.prototype.toFixed.
func fixed(x float64, d int) string {
	return strconv.FormatFloat(x, 'f', d, 64)
}

// stringsOf keeps the strings of a parsed JSON array.
func stringsOf(v any) []string {
	out := []string{}
	for _, e := range arr(v) {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// uniq keeps the first of each string, in order (new Set(...)).
func uniq(xs []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

func contains(xs []string, x string) bool {
	for _, e := range xs {
		if e == x {
			return true
		}
	}
	return false
}

// nonNil turns a nil slice into an empty one, so it marshals as [] like the TS arrays do.
func nonNil[T any](xs []T) []T {
	if xs == nil {
		return []T{}
	}
	return xs
}

// u16Less compares strings by UTF-16 code units (JavaScript's default sort and comparison).
func u16Less(a, b string) bool {
	ua := utf16.Encode([]rune(a))
	ub := utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

// validUTF8 replaces invalid bytes, so text from pages can go into JSON.
func validUTF8(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	return strings.ToValidUTF8(s, "�")
}
