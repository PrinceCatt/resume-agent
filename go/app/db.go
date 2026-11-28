// SQLite through modernc.org/sqlite (pure Go, no cgo). Same file, schema and migrations as the
// TypeScript server (server/db.ts), so either backend can open a data/app.db the other created.
package app

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

var (
	DataDir  string
	FilesDir string
	ShotsDir string
	db       *sql.DB
)

const schema = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  title TEXT,
  company TEXT,
  location TEXT,
  -- new -> parsed -> tailored -> applied | skipped
  stage TEXT NOT NULL DEFAULT 'new',
  -- background task in flight: parsing | tailoring | null
  busy TEXT,
  error TEXT,
  jd_text TEXT,
  jd TEXT,
  tailored TEXT,
  cover_letter TEXT,
  resume_file TEXT,
  cover_file TEXT,
  auto_apply INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- queued | running | need_user | awaiting_confirm | submitted | finished | failed | cancelled | interrupted
  status TEXT NOT NULL DEFAULT 'queued',
  -- what the run is waiting on: {kind:'ask'|'manual', ...} or the review for awaiting_confirm
  pending TEXT,
  outcome TEXT,
  steps INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS run_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_steps_run ON run_steps(run_id, id);
CREATE INDEX IF NOT EXISTS runs_job ON runs(job_id, id);
-- Tokens each model call used; kept after a job is deleted so totals stay right.
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS usage_job ON usage(job_id);
-- Interviews, tests, calls and deadlines you put on a job.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- interview | test | call | deadline | other
  kind TEXT NOT NULL,
  -- UTC, same format as datetime('now')
  at TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 60,
  note TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_at ON events(done, at);
CREATE INDEX IF NOT EXISTS events_job ON events(job_id, at);
-- Every change of a job's after-applying progress, so stats can count how far each one got.
CREATE TABLE IF NOT EXISTS progress_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  progress TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS progress_log_job ON progress_log(job_id, id);
`

// Init opens (or creates) DATA_DIR/app.db and brings its schema up to date. It also does what the TS
// modules do when they load: jobs and runs that were in flight when the program stopped are marked.
func Init(dataDir string) error {
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return err
	}
	DataDir = abs
	FilesDir = filepath.Join(DataDir, "files")
	ShotsDir = filepath.Join(DataDir, "shots")
	for _, d := range []string{FilesDir, ShotsDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	if db != nil {
		db.Close()
	}
	dsn := "file:" + filepath.ToSlash(filepath.Join(DataDir, "app.db")) +
		"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"
	d, err := sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	// One connection, like node:sqlite's single handle: no "database is locked" between our own queries.
	d.SetMaxOpenConns(1)
	d.SetConnMaxLifetime(0)
	if _, err := d.Exec(schema); err != nil {
		return fmt.Errorf("schema: %w", err)
	}
	db = d
	// Columns added after the first version; existing databases get them on start.
	// After applying: applied | screening | interview | offer | rejected | withdrawn
	addColumn("jobs", "progress", "TEXT")
	addColumn("jobs", "progress_at", "TEXT")
	addColumn("jobs", "applied_at", "TEXT")
	addColumn("jobs", "notes", "TEXT")
	// Why the automatic pipeline stopped short (not an error), e.g. a low fit score.
	addColumn("jobs", "notice", "TEXT")
	// Interview prep (JSON) and email drafts (JSON keyed by kind), written on request.
	addColumn("jobs", "prep", "TEXT")
	addColumn("jobs", "drafts", "TEXT")
	// The batch step waiting for DeepSeek's off-peak hours or a free slot: tailor | apply | null (batch.go).
	addColumn("jobs", "held", "TEXT")

	// The queue lives in memory, so a restart drops whatever was reading or tailoring. Without this the job
	// showed "读取岗位中" for good, with no button to try again.
	mustExec("UPDATE jobs SET error = CASE busy WHEN 'parsing' THEN '程序重启，读取中断了，再点一次' ELSE '程序重启，改简历中断了，再点一次' END, busy = NULL WHERE busy IS NOT NULL")
	// A restart loses the browser tabs, so anything that was mid-flight is over.
	mustExec("UPDATE runs SET status = 'interrupted', pending = NULL, outcome = COALESCE(outcome, '程序重启，这次填写中断了'), finished_at = datetime('now') WHERE status IN ('queued','running','need_user','awaiting_confirm')")
	return nil
}

func addColumn(table, col, def string) {
	for _, c := range queryMaps(fmt.Sprintf("PRAGMA table_info(%s)", table)) {
		if c["name"] == col {
			return
		}
	}
	mustExec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, col, def))
}

// dbError is what the "must" helpers panic with; request handlers and background tasks recover it.
type dbError struct{ err error }

func (e dbError) Error() string { return e.err.Error() }

// mustExec runs a statement and returns (changes, last insert id). It panics on a database error.
func mustExec(q string, args ...any) (int64, int64) {
	r, err := db.Exec(q, args...)
	if err != nil {
		panic(dbError{fmt.Errorf("%w (%s)", err, q)})
	}
	n, _ := r.RowsAffected()
	id, _ := r.LastInsertId()
	return n, id
}

// tryExec is mustExec that returns the error (for statements that may fail on purpose, like a foreign key).
func tryExec(q string, args ...any) (int64, error) {
	r, err := db.Exec(q, args...)
	if err != nil {
		return 0, err
	}
	id, _ := r.LastInsertId()
	return id, nil
}

// queryMaps returns every row as a column → value map (int64, float64, string, nil), like node:sqlite's all().
func queryMaps(q string, args ...any) []map[string]any {
	rows, err := db.Query(q, args...)
	if err != nil {
		panic(dbError{fmt.Errorf("%w (%s)", err, q)})
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := []map[string]any{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			panic(dbError{err})
		}
		m := make(map[string]any, len(cols))
		for i, c := range cols {
			if b, ok := vals[i].([]byte); ok {
				m[c] = string(b)
			} else {
				m[c] = vals[i]
			}
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		panic(dbError{err})
	}
	return out
}

// queryMap is get(): the first row or nil.
func queryMap(q string, args ...any) map[string]any {
	rows := queryMaps(q, args...)
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}

// queryInt returns the first column of the first row as an integer (0 when there is none).
func queryInt(q string, args ...any) int64 {
	var n sql.NullInt64
	if err := db.QueryRow(q, args...).Scan(&n); err != nil && err != sql.ErrNoRows {
		panic(dbError{err})
	}
	return n.Int64
}

// queryStrings returns the first column of every row.
func queryStrings(q string, args ...any) []string {
	out := []string{}
	for _, r := range queryMaps(q, args...) {
		for _, v := range r {
			out = append(out, jsString(v))
		}
	}
	return out
}

func asInt(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case float64:
		return int64(x)
	case int:
		return int64(x)
	}
	return 0
}

func asStrPtr(v any) *string {
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		return &x
	}
	s := jsString(v)
	return &s
}

// sqlNow is UTC in SQLite's own datetime('now') format, so stored times compare as strings.
func sqlNow() string { return time.Now().UTC().Format("2006-01-02 15:04:05") }

// isoNow is new Date().toISOString().
func isoNow() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

// parseSQLTime reads a stored UTC time ("YYYY-MM-DD HH:MM:SS", or ISO with Z or an offset).
func parseSQLTime(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	if t, ok := parseISO(s); ok {
		return t, true
	}
	return time.Time{}, false
}

// closeDB closes the database (tests remove their data folder afterwards).
func closeDB() {
	if db != nil {
		_ = db.Close()
		db = nil
	}
}
