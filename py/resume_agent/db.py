"""SQLite through the standard library. Same file (data/app.db) and schema as server/db.ts, so either
backend can open a database the other created. Everything personal lives under data/, which is gitignored."""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("DATA_DIR") or (ROOT / "data")).resolve()
FILES_DIR = DATA_DIR / "files"
SHOTS_DIR = DATA_DIR / "shots"
for _d in (FILES_DIR, SHOTS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

Row = dict[str, Any]


def _dict_factory(cursor: sqlite3.Cursor, row: tuple) -> Row:
    return {d[0]: row[i] for i, d in enumerate(cursor.description)}


# Autocommit, like node:sqlite: every statement is its own transaction.
db = sqlite3.connect(DATA_DIR / "app.db", isolation_level=None, check_same_thread=False)
db.row_factory = _dict_factory
db.executescript("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")


def all_rows(sql: str, *params: Any) -> list[Row]:
    return db.execute(sql, params).fetchall()


def get(sql: str, *params: Any) -> Row | None:
    return db.execute(sql, params).fetchone()


def run(sql: str, *params: Any) -> dict[str, int]:
    cur = db.execute(sql, params)
    return {"changes": cur.rowcount, "id": cur.lastrowid or 0}


db.executescript(
    """
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
"""
)


def _add_column(table: str, col: str, definition: str) -> None:
    """Columns added after the first version; existing databases get them on start."""
    if not any(c["name"] == col for c in all_rows(f"PRAGMA table_info({table})")):
        db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {definition}")


# After applying: applied | screening | interview | offer | rejected | withdrawn
_add_column("jobs", "progress", "TEXT")
_add_column("jobs", "progress_at", "TEXT")
_add_column("jobs", "applied_at", "TEXT")
_add_column("jobs", "notes", "TEXT")
# Why the automatic pipeline stopped short (not an error), e.g. a low fit score.
_add_column("jobs", "notice", "TEXT")
# Interview prep (JSON) and email drafts (JSON keyed by kind), written on request.
_add_column("jobs", "prep", "TEXT")
_add_column("jobs", "drafts", "TEXT")
# The batch step waiting for DeepSeek's off-peak hours or a free slot: tailor | apply | null (batch.py).
_add_column("jobs", "held", "TEXT")


def sql_now() -> str:
    """UTC in SQLite's own datetime('now') format, so stored times compare as strings."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def iso_now() -> str:
    """new Date().toISOString()."""
    return to_iso(datetime.now(timezone.utc))


def to_iso(d: datetime) -> str:
    """Date.prototype.toISOString for an aware datetime."""
    d = d.astimezone(timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def parse_sql_time(t: str) -> datetime | None:
    """A stored UTC time ("YYYY-MM-DD HH:MM:SS" or ISO with Z / offset) as an aware datetime."""
    if not t:
        return None
    s = t.strip().replace(" ", "T", 1)
    if s.endswith(("Z", "z")):
        s = s[:-1] + "+00:00"
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d


def parse_json(s: str | None, fallback: Any) -> Any:
    if not s:
        return fallback
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return fallback
