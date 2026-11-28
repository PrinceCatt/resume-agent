package app

import (
	"encoding/json"
	"math"
)

// Settings mirrors server/settings.ts; stored one JSON value per key in the settings table.
type Settings struct {
	// "deepseek" calls the API; "demo" runs a rule-based stand-in so the flow can be tried without a key.
	LLMMode string `json:"llmMode"`
	APIKey  string `json:"apiKey"`
	BaseURL string `json:"baseUrl"`
	Model   string `json:"model"`
	// Which of your own browsers forms are filled in (through the Playwright Extension installed there).
	BrowserChannel string `json:"browserChannel"`
	// The Playwright Extension's token: kept on the server like the API key.
	ExtensionToken string `json:"extensionToken"`
	// How many application forms are filled at the same time.
	Concurrency    int    `json:"concurrency"`
	MaxSteps       int    `json:"maxSteps"`
	CoverLetter    bool   `json:"coverLetter"`
	ResumeLanguage string `json:"resumeLanguage"`
	// The automatic pipeline stops after reading a job whose fit score is below this (0 = never).
	MinFit int `json:"minFit"`
	// Batch tailoring and form filling wait for DeepSeek's off-peak hours (half price).
	OffPeakOnly bool `json:"offPeakOnly"`
}

var DefaultSettings = Settings{
	LLMMode:        "deepseek",
	APIKey:         "",
	BaseURL:        "https://api.deepseek.com",
	Model:          "deepseek-chat",
	BrowserChannel: "msedge",
	ExtensionToken: "",
	Concurrency:    2,
	MaxSteps:       40,
	CoverLetter:    true,
	ResumeLanguage: "auto",
	MinFit:         0,
	OffPeakOnly:    false,
}

// settingKinds is typeof DEFAULT_SETTINGS[k] for each key, in the TS key order.
var settingKinds = []struct{ key, kind string }{
	{"llmMode", "string"}, {"apiKey", "string"}, {"baseUrl", "string"}, {"model", "string"},
	{"browserChannel", "string"}, {"extensionToken", "string"}, {"concurrency", "number"},
	{"maxSteps", "number"}, {"coverLetter", "boolean"}, {"resumeLanguage", "string"},
	{"minFit", "number"}, {"offPeakOnly", "boolean"},
}

func GetSettings() Settings {
	s := DefaultSettings
	for _, r := range queryMaps("SELECT key, value FROM settings") {
		key := jsString(r["key"])
		val := jsString(r["value"])
		applySetting(&s, key, val)
	}
	return s
}

// applySetting sets one stored value; a row that does not parse keeps the default (like the TS try/catch).
func applySetting(s *Settings, key, raw string) {
	var err error
	switch key {
	case "llmMode":
		err = json.Unmarshal([]byte(raw), &s.LLMMode)
	case "apiKey":
		err = json.Unmarshal([]byte(raw), &s.APIKey)
	case "baseUrl":
		err = json.Unmarshal([]byte(raw), &s.BaseURL)
	case "model":
		err = json.Unmarshal([]byte(raw), &s.Model)
	case "browserChannel":
		err = json.Unmarshal([]byte(raw), &s.BrowserChannel)
	case "extensionToken":
		err = json.Unmarshal([]byte(raw), &s.ExtensionToken)
	case "concurrency":
		s.Concurrency = intSetting(raw, s.Concurrency)
	case "maxSteps":
		s.MaxSteps = intSetting(raw, s.MaxSteps)
	case "coverLetter":
		err = json.Unmarshal([]byte(raw), &s.CoverLetter)
	case "resumeLanguage":
		err = json.Unmarshal([]byte(raw), &s.ResumeLanguage)
	case "minFit":
		s.MinFit = intSetting(raw, s.MinFit)
	case "offPeakOnly":
		err = json.Unmarshal([]byte(raw), &s.OffPeakOnly)
	}
	_ = err
}

func intSetting(raw string, dflt int) int {
	var f float64
	if err := json.Unmarshal([]byte(raw), &f); err != nil || math.IsNaN(f) {
		return dflt
	}
	return int(f)
}

// SaveSettings stores the keys of patch that exist in the defaults and have the default's type.
func SaveSettings(patch map[string]any) Settings {
	for _, k := range settingKinds {
		v, ok := patch[k.key]
		if !ok || v == nil {
			continue
		}
		kind := ""
		switch x := v.(type) {
		case string:
			kind = "string"
		case bool:
			kind = "boolean"
		case float64:
			if math.IsNaN(x) || math.IsInf(x, 0) {
				continue
			}
			kind = "number"
		case int:
			kind = "number"
			v = float64(x)
		}
		if kind != k.kind {
			continue
		}
		mustExec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k.key, jsonStr(v))
	}
	return GetSettings()
}

// PublicSettings is what the browser UI gets: the API key and the extension token never leave the server.
func PublicSettings() map[string]any {
	s := GetSettings()
	hint := ""
	if s.APIKey != "" {
		hint = u16slice(s.APIKey, 3) + "…" + lastU16(s.APIKey, 4)
	}
	return map[string]any{
		"llmMode":           s.LLMMode,
		"baseUrl":           s.BaseURL,
		"model":             s.Model,
		"browserChannel":    s.BrowserChannel,
		"concurrency":       s.Concurrency,
		"maxSteps":          s.MaxSteps,
		"coverLetter":       s.CoverLetter,
		"resumeLanguage":    s.ResumeLanguage,
		"minFit":            s.MinFit,
		"offPeakOnly":       s.OffPeakOnly,
		"hasKey":            len(s.APIKey) > 0,
		"keyHint":           hint,
		"hasExtensionToken": len(s.ExtensionToken) > 0,
	}
}

// lastU16 is s.slice(-n).
func lastU16(s string, n int) string {
	l := u16len(s)
	if n >= l {
		return s
	}
	return u16from(s, l-n)
}
