package app

import (
	"log"
	"runtime/debug"
	"sync"
)

// Task is background work (reading a job page, tailoring, filling a form).
type Task func()

// Queue is a tiny in-process queue with a concurrency limit (server/tasks.ts). PushFn and SizeFn
// can be replaced in tests, like the TS tests replace bgQueue.push and its size getter.
type Queue struct {
	mu          sync.Mutex
	waiting     []Task
	active      int
	concurrency func() int
	PushFn      func(Task)
	SizeFn      func() int
}

func newQueue(concurrency func() int) *Queue {
	q := &Queue{concurrency: concurrency}
	return q
}

func (q *Queue) Push(t Task) {
	if q.PushFn != nil {
		q.PushFn(t)
		return
	}
	q.mu.Lock()
	q.waiting = append(q.waiting, t)
	q.mu.Unlock()
	q.pump()
}

func (q *Queue) Size() int {
	if q.SizeFn != nil {
		return q.SizeFn()
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.waiting) + q.active
}

func (q *Queue) pump() {
	q.mu.Lock()
	defer q.mu.Unlock()
	for q.active < max(1, q.concurrency()) && len(q.waiting) > 0 {
		t := q.waiting[0]
		q.waiting = q.waiting[1:]
		q.active++
		go func() {
			defer func() {
				q.mu.Lock()
				q.active--
				q.mu.Unlock()
				q.pump()
			}()
			safely("task", t)
		}()
	}
}

// safely runs f and logs a panic instead of crashing the server.
func safely(what string, f func()) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[%s] %v\n%s", what, r, debug.Stack())
		}
	}()
	f()
}

// goSafely starts f in a goroutine that cannot crash the server.
func goSafely(what string, f func()) {
	go safely(what, f)
}
