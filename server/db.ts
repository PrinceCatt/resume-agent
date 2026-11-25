// SQLite through Node's built-in driver (node:sqlite). Everything personal (profile, jobs,
// the API key, screenshots) lives under data/, which is gitignored.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(import.meta.dirname, "..", "data"));
export const FILES_DIR = path.join(DATA_DIR, "files");
export const SHOTS_DIR = path.join(DATA_DIR, "shots");
for (const d of [FILES_DIR, SHOTS_DIR]) fs.mkdirSync(d, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "app.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

export type Row = Record<string, any>;
type Param = string | number | bigint | null | Uint8Array;

export function all<T = Row>(sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T = Row>(sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: Param[]): { changes: number; id: number } {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
}

db.exec(`
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
`);

// Columns added after the first version; existing databases get them on start.
function addColumn(table: string, col: string, def: string) {
  if (!all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
// After applying: applied | screening | interview | offer | rejected | withdrawn
addColumn("jobs", "progress", "TEXT");
addColumn("jobs", "progress_at", "TEXT");
addColumn("jobs", "applied_at", "TEXT");
addColumn("jobs", "notes", "TEXT");
// Why the automatic pipeline stopped short (not an error), e.g. a low fit score.
addColumn("jobs", "notice", "TEXT");
// Interview prep (JSON) and email drafts (JSON keyed by kind), written on request.
addColumn("jobs", "prep", "TEXT");
addColumn("jobs", "drafts", "TEXT");
// The batch step waiting for DeepSeek's off-peak hours or a free slot: tailor | apply | null (server/batch.ts).
addColumn("jobs", "held", "TEXT");

/** UTC in SQLite's own datetime('now') format, so stored times compare as strings. */
export function sqlNow() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
