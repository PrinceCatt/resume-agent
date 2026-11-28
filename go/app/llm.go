// DeepSeek through its OpenAI-compatible chat completions API. Any other OpenAI-compatible
// endpoint works by changing baseUrl/model in settings.
package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// UsageTag says what a call was for, so token use can be shown per job.
// Kind: parse | tailor | apply | import | test | prep | email.
type UsageTag struct {
	JobID int64 // 0 = none
	Kind  string
}

type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// Message is one chat message. Content is a pointer so an assistant turn with only tool calls sends null.
type Message struct {
	Role       string     `json:"role"`
	Content    *string    `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

func textMsg(role, content string) Message { return Message{Role: role, Content: &content} }

func (m Message) text() string {
	if m.Content == nil {
		return ""
	}
	return *m.Content
}

// ToolDef is a function tool; Parameters is raw JSON so property order stays as written.
type ToolDef struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}

type LlmError struct{ msg string }

func (e *LlmError) Error() string { return e.msg }

// LlmState is { ok: true } or { ok: false, reason, code: "no_key" | "no_balance" }.
type LlmState struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
	Code   string `json:"code,omitempty"`
}

var (
	// httpClient is replaced in tests (like the TS tests replace globalThis.fetch).
	httpClient = &http.Client{}
	// retryDelay is the back-off unit between attempts (1.5 s, longer each time).
	retryDelay = 1500 * time.Millisecond

	// noBalance is set when DeepSeek answered 402 or its balance endpoint says the account cannot be used.
	// Until it clears (a call that works, a balance check that shows money, a new key), nothing calls the
	// model: on 2026-11-13 an empty balance failed every queued job one by one with the same error.
	noBalanceMu sync.Mutex
	noBalance   *string
)

func llmReady() LlmState {
	s := GetSettings()
	if s.LLMMode == "demo" {
		return LlmState{OK: true}
	}
	if s.APIKey == "" {
		return LlmState{OK: false, Code: "no_key", Reason: "还没填 DeepSeek API key：到「设置」里填上，或者先切到演示模式。"}
	}
	noBalanceMu.Lock()
	nb := noBalance
	noBalanceMu.Unlock()
	if nb != nil {
		bal := ""
		if *nb != "" {
			bal = "（" + *nb + "）"
		}
		return LlmState{OK: false, Code: "no_balance", Reason: "DeepSeek 账户余额不足" + bal + "：充值后点岗位页上的「充好了，继续」。"}
	}
	return LlmState{OK: true}
}

// setNoBalance marks the balance as used up (with what DeepSeek shows, maybe "") or clears it (nil).
func setNoBalance(balance *string) {
	noBalanceMu.Lock()
	was := noBalance != nil
	if balance == nil {
		noBalance = nil
	} else {
		b := *balance
		noBalance = &b
	}
	now := noBalance != nil
	noBalanceMu.Unlock()
	if was != now {
		emit("settings")
	}
}

func strp(s string) *string { return &s }

type Balance struct {
	Available bool    `json:"available"`
	Total     float64 `json:"total"`
	Currency  string  `json:"currency"`
}

var (
	balanceMu    sync.Mutex
	balanceCache *struct {
		at    time.Time
		key   string
		value *Balance
	}
)

func money(b Balance) string {
	sym := "¥"
	if b.Currency == "USD" {
		sym = "$"
	}
	return sym + fixed(b.Total, 2)
}

var reDeepseekHost = regexp.MustCompile(`(^|\.)deepseek\.com$`)

func hostOf(u string) string {
	p, err := url.Parse(u)
	if err != nil {
		return ""
	}
	return strings.ToLower(p.Hostname())
}

// getBalance is DeepSeek's balance (a free call). nil for other providers, demo mode, no key, or when it cannot be read.
func getBalance(fresh bool) *Balance {
	s := GetSettings()
	if s.LLMMode != "deepseek" || s.APIKey == "" || !reDeepseekHost.MatchString(hostOf(s.BaseURL)) {
		return nil
	}
	balanceMu.Lock()
	if !fresh && balanceCache != nil && balanceCache.key == s.APIKey && time.Since(balanceCache.at) < 60*time.Second {
		v := balanceCache.value
		balanceMu.Unlock()
		return v
	}
	balanceMu.Unlock()
	var value *Balance
	func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(s.BaseURL, "/")+"/user/balance", nil)
		if err != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+s.APIKey)
		req.Header.Set("Accept", "application/json")
		res, err := httpClient.Do(req)
		if err != nil {
			// offline or the endpoint moved: say nothing rather than block
			return
		}
		defer res.Body.Close()
		if res.StatusCode < 200 || res.StatusCode > 299 {
			return
		}
		var b any
		if json.NewDecoder(res.Body).Decode(&b) != nil {
			return
		}
		infos := arr(get(b, "balance_infos"))
		var info any
		for _, i := range infos {
			if get(i, "currency") == "CNY" {
				info = i
				break
			}
		}
		if info == nil && len(infos) > 0 {
			info = infos[0]
		}
		total := jsNumber(get(info, "total_balance"), has(obj(info), "total_balance"))
		if math.IsNaN(total) {
			total = 0
		}
		cur := "CNY"
		if c := get(info, "currency"); c != nil {
			cur = jsString(c)
		}
		value = &Balance{Available: get(b, "is_available") == true, Total: total, Currency: cur}
	}()
	balanceMu.Lock()
	balanceCache = &struct {
		at    time.Time
		key   string
		value *Balance
	}{time.Now(), s.APIKey, value}
	balanceMu.Unlock()
	if value != nil {
		if value.Available {
			setNoBalance(nil)
		} else {
			setNoBalance(strp(money(*value)))
		}
	}
	return value
}

func isDemo() bool { return GetSettings().LLMMode == "demo" }

type ChatOpts struct {
	Messages    []Message
	Tools       []ToolDef
	JSON        bool
	Temperature *float64
	MaxTokens   int
	Usage       *UsageTag
}

// chat sends one chat completion. 429 and 5xx are retried (three attempts); 402 marks the balance as used up.
func chat(opts ChatOpts) (content string, toolCalls []ToolCall, err error) {
	s := GetSettings()
	if s.APIKey == "" {
		return "", nil, &LlmError{"没有 API key"}
	}
	temp := 0.2
	if opts.Temperature != nil {
		temp = *opts.Temperature
	}
	maxTokens := opts.MaxTokens
	if maxTokens == 0 {
		maxTokens = 4096
	}
	body := map[string]any{
		"model":       s.Model,
		"messages":    opts.Messages,
		"temperature": temp,
		"max_tokens":  maxTokens,
	}
	if len(opts.Tools) > 0 {
		body["tools"] = opts.Tools
		body["tool_choice"] = "auto"
	}
	if opts.JSON {
		body["response_format"] = map[string]string{"type": "json_object"}
	}
	payload := []byte(jsonStr(body))
	endpoint := strings.TrimRight(s.BaseURL, "/") + "/chat/completions"

	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		c, calls, retry, err := chatOnce(endpoint, s.APIKey, payload, opts.Usage)
		if err == nil {
			return c, calls, nil
		}
		if !retry {
			return "", nil, err
		}
		lastErr = err
		time.Sleep(retryDelay * time.Duration(attempt+1))
	}
	return "", nil, lastErr
}

func chatOnce(endpoint, key string, payload []byte, usage *UsageTag) (string, []ToolCall, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", nil, false, &LlmError{err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	res, err := httpClient.Do(req)
	if err != nil {
		return "", nil, true, err
	}
	defer res.Body.Close()
	if res.StatusCode == 429 || res.StatusCode >= 500 {
		return "", nil, true, &LlmError{fmt.Sprintf("模型接口 %d", res.StatusCode)}
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		text, _ := io.ReadAll(res.Body)
		hint := ""
		if res.StatusCode == 401 {
			hint = "（API key 不对）"
		} else if res.StatusCode == 402 {
			hint = "（账户余额不足）"
		}
		if res.StatusCode == 402 {
			noBalanceMu.Lock()
			prev := ""
			if noBalance != nil {
				prev = *noBalance
			}
			noBalanceMu.Unlock()
			setNoBalance(&prev)
		}
		return "", nil, false, &LlmError{fmt.Sprintf("模型接口 %d%s: %s", res.StatusCode, hint, u16slice(validUTF8(string(text)), 300))}
	}
	var data struct {
		Choices []struct {
			Message struct {
				Content   *string    `json:"content"`
				ToolCalls []ToolCall `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		Usage map[string]any `json:"usage"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		return "", nil, true, err
	}
	noBalanceMu.Lock()
	nb := noBalance != nil
	noBalanceMu.Unlock()
	if nb {
		setNoBalance(nil)
	}
	recordUsage(usage, data.Usage)
	content := ""
	var calls []ToolCall
	if len(data.Choices) > 0 {
		if c := data.Choices[0].Message.Content; c != nil {
			content = *c
		}
		calls = data.Choices[0].Message.ToolCalls
	}
	return content, nonNil(calls), false, nil
}

func recordUsage(tag *UsageTag, u map[string]any) {
	if u == nil {
		return
	}
	n := func(k string) int64 {
		if f, ok := finite(u[k]); ok {
			return int64(jsRound(f))
		}
		return 0
	}
	kind := "test"
	var jobID any
	if tag != nil {
		kind = tag.Kind
		if tag.JobID != 0 {
			jobID = tag.JobID
		}
	}
	defer func() { _ = recover() }() // never let bookkeeping break a call
	if _, err := tryExec("INSERT INTO usage (job_id, kind, prompt_tokens, completion_tokens, cache_hit_tokens) VALUES (?, ?, ?, ?, ?)",
		jobID, kind, n("prompt_tokens"), n("completion_tokens"), n("prompt_cache_hit_tokens")); err != nil {
		// The job may have been deleted while the call was running.
		_, _ = tryExec("INSERT INTO usage (job_id, kind, prompt_tokens, completion_tokens, cache_hit_tokens) VALUES (NULL, ?, ?, ?, ?)",
			kind, n("prompt_tokens"), n("completion_tokens"), n("prompt_cache_hit_tokens"))
	}
}

var (
	reFenceStart = jsRe("^```(?:json)?"+`\s*`, "i")
	reFenceEnd   = regexp.MustCompile("```$")
)

// chatJSON is a JSON-mode call; tolerates a fenced block. The answer comes back parsed (maps, slices…).
func chatJSON(system, user string, maxTokens int, usage *UsageTag) (any, error) {
	content, _, err := chat(ChatOpts{
		Messages: []Message{
			// JSON mode needs the word "json" in the prompt. Output costs four times what uncached input does, and
			// pretty-printed JSON spends a token or so per line on line breaks and indentation.
			textMsg("system", system+"\n\nRespond with a single json object, minified: no line breaks or indentation."),
			textMsg("user", user),
		},
		JSON:      true,
		MaxTokens: maxTokens,
		Usage:     usage,
	})
	if err != nil {
		return nil, err
	}
	text := reFenceEnd.ReplaceAllString(reFenceStart.ReplaceAllString(jsTrim(content), ""), "")
	v, ok := parseAny(text)
	if !ok {
		return nil, &LlmError{"模型没有返回合法 JSON：" + u16slice(text, 200)}
	}
	return v, nil
}
