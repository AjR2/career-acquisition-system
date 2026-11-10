/**
 * Ordered schema migrations. Never edit an applied migration; add a new one.
 */
export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "init",
    sql: `
CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  ats TEXT NOT NULL CHECK (ats IN ('greenhouse','lever','ashby')),
  token TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'B',
  active INTEGER NOT NULL DEFAULT 1,
  last_fetch_at TEXT,
  last_fetch_status TEXT,
  last_error TEXT,
  UNIQUE (ats, token)
);

CREATE TABLE postings (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  ats TEXT NOT NULL,
  ats_job_id TEXT NOT NULL,
  company_name TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  apply_url TEXT,
  location_raw TEXT,
  description_text TEXT,
  content_hash TEXT NOT NULL,
  dedupe_hash TEXT NOT NULL,
  duplicate_of INTEGER REFERENCES postings(id),
  state TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  closed_at TEXT,
  employment_type TEXT,
  lane TEXT,
  comp_json TEXT,
  location_json TEXT,
  eligibility_json TEXT,
  flags_json TEXT,
  ai_policy_text TEXT,
  questions_json TEXT,
  -- Normalized posting (without raw payload) so rules can be re-run offline.
  normalized_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (ats, company_id, ats_job_id)
);
CREATE INDEX postings_state ON postings(state);
CREATE INDEX postings_dedupe ON postings(dedupe_hash);

-- Raw listing snapshots. A new row is written whenever the content changes.
CREATE TABLE posting_snapshots (
  id INTEGER PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES postings(id),
  retrieved_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  UNIQUE (posting_id, content_hash)
);

-- Immutable event log: every state change and external action.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  posting_id INTEGER REFERENCES postings(id),
  kind TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  actor TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX events_posting ON events(posting_id);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','skipped')),
  stats_json TEXT,
  error TEXT
);

-- Lease that prevents duplicate concurrent runs.
CREATE TABLE leases (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    name: "llm_suitability_materials",
    sql: `
-- Every model call, for spend tracking and the daily cap.
CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  local_date TEXT NOT NULL,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  posting_id INTEGER REFERENCES postings(id),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT
);
CREATE INDEX llm_calls_date ON llm_calls(local_date);

ALTER TABLE postings ADD COLUMN analysis_json TEXT;
ALTER TABLE postings ADD COLUMN suitability_score REAL;
ALTER TABLE postings ADD COLUMN suitability_json TEXT;
ALTER TABLE postings ADD COLUMN attention_reason TEXT;

-- Versioned application materials. Approval (Session 4) binds to content_hash.
CREATE TABLE materials (
  id INTEGER PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES postings(id),
  kind TEXT NOT NULL CHECK (kind IN ('resume','cover_letter')),
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  rendered_md TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('validated','failed','superseded','approved')),
  validation_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (posting_id, kind, version)
);
`,
  },
  {
    id: 3,
    name: "approvals_submissions",
    sql: `
-- Every user decision on a queue item. Approval binds to an exact material version and claims file.
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES postings(id),
  material_id INTEGER REFERENCES materials(id),
  material_hash TEXT,
  claims_hash TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject','defer','revise','release','skip','resolve_submitted','resolve_not_sent','status_update')),
  note TEXT,
  answers_json TEXT,
  decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX decisions_posting ON decisions(posting_id);

-- One row per assisted submission attempt. The idempotency key prevents applying twice to the same role.
CREATE TABLE submissions (
  id INTEGER PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES postings(id),
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  material_hash TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('started','submitted','uncertain')),
  filled_json TEXT,
  confirmation_json TEXT,
  evidence_path TEXT
);
`,
  },
];
