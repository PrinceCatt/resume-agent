// Batch work (一键处理, and the automatic pipeline after a job is read) can wait for DeepSeek's off-peak
// hours, when every call costs half. Reading a posting never waits. Tailoring and form filling are the
// cost, so while the setting is on their next step waits in jobs.held and starts from here — off-peak
// only, and only when a slot is free. Work already running is never stopped.
package app

import (
	"sync"
	"time"
)

// goNow: jobs you told to go now; the rest of their steps skip the wait. Kept in memory, like the queues.
var (
	goNowMu sync.Mutex
	goNow   = map[int64]bool{}
)

// holding: whether batch steps wait at all (the setting is on and DeepSeek, which has the peak price, is the model).
func holding() bool {
	s := GetSettings()
	return s.OffPeakOnly && s.LLMMode == "deepseek"
}

func nextStep(j *Job) string {
	if j.Stage == "applied" || j.Stage == "skipped" || j.JD == nil || *j.JD == "" {
		return ""
	}
	if j.Tailored != nil && *j.Tailored != "" {
		return "apply"
	}
	return "tailor"
}

func startStep(j *Job) {
	step := nextStep(j)
	setJob(j.ID, P{"held": nil})
	switch step {
	case "tailor":
		id := j.ID
		queueTailor(id, func() { advance(id) })
	case "apply":
		goNowMu.Lock()
		delete(goNow, j.ID)
		goNowMu.Unlock()
		if _, err := startRun(j.ID); err != nil {
			setJob(j.ID, P{"error": err.Error()})
		}
	}
}

// advance: the next step of a job in a batch (tailor, then fill): now, or held until off-peak and a free slot.
func advance(id int64) {
	j := getJob(id)
	if j == nil || nextStep(j) == "" {
		return
	}
	goNowMu.Lock()
	now := goNow[id]
	goNowMu.Unlock()
	if !holding() || now {
		startStep(j)
		return
	}
	setJob(id, P{"held": nextStep(j)})
	pump(time.Now())
}

// pump starts held steps while it is off-peak and a slot is free; all of them at once if the setting was turned off.
func pump(now time.Time) {
	held := queryMaps("SELECT id, held FROM jobs WHERE held IS NOT NULL ORDER BY CASE held WHEN 'apply' THEN 0 ELSE 1 END, updated_at, id")
	gate := holding()
	// No key or no balance: starting them would only fail each one. They keep waiting.
	ready := llmReady().OK
	for _, h := range held {
		j := getJob(asInt(h["id"]))
		if j == nil {
			continue
		}
		if nextStep(j) == "" {
			setJob(j.ID, P{"held": nil})
			continue
		}
		if !ready || (gate && isPeak(now)) {
			continue
		}
		var free bool
		if jsString(h["held"]) == "apply" {
			free = runSlotFree()
		} else {
			free = bgQueue.Size() < 2
		}
		if !gate || free {
			startStep(j)
		}
	}
}

// runNow ("现在就跑"): held jobs (these, or all of them) start now and skip the wait for their remaining steps.
func runNow(ids []int64) {
	held := []int64{}
	for _, m := range queryMaps("SELECT id FROM jobs WHERE held IS NOT NULL") {
		held = append(held, asInt(m["id"]))
	}
	for _, id := range held {
		if ids != nil {
			want := false
			for _, x := range ids {
				if x == id {
					want = true
				}
			}
			if !want {
				continue
			}
		}
		goNowMu.Lock()
		goNow[id] = true
		goNowMu.Unlock()
		if j := getJob(id); j != nil {
			startStep(j)
		}
	}
}
