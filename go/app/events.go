// Server-sent events: the UI refetches whatever a message names, so payloads stay tiny.
package app

import (
	"fmt"
	"net/http"
	"sync"
	"time"
)

type sseClient struct {
	ch chan string
}

var (
	clientsMu sync.Mutex
	clients   = map[*sseClient]struct{}{}
)

func addClient(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "retry: 2000\n\n")
	flusher.Flush()
	c := &sseClient{ch: make(chan string, 256)}
	clientsMu.Lock()
	clients[c] = struct{}{}
	clientsMu.Unlock()
	defer func() {
		clientsMu.Lock()
		delete(clients, c)
		clientsMu.Unlock()
	}()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-c.ch:
			if _, err := fmt.Fprint(w, msg); err != nil {
				return
			}
			flusher.Flush()
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

type eventMsg struct {
	Type string `json:"type"`
	ID   *int64 `json:"id,omitempty"`
}

// emit tells every open page that something changed: "job" | "run" | "profile" | "settings" | "browser" | "schedule".
func emit(typ string, id ...int64) {
	m := eventMsg{Type: typ}
	if len(id) > 0 {
		v := id[0]
		m.ID = &v
	}
	msg := "data: " + jsonStr(m) + "\n\n"
	clientsMu.Lock()
	defer clientsMu.Unlock()
	for c := range clients {
		select {
		case c.ch <- msg:
		default:
			// A client that stopped reading misses this one; it refetches on reconnect.
		}
	}
}
