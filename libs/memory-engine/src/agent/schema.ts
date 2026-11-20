/** Additive side tables: older v7 applications can still open the same Brain. */
export const agentSchema = `
CREATE TABLE IF NOT EXISTS agent_notes(operation_id TEXT NOT NULL REFERENCES tidy_operations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('made','undid')), run_id TEXT, reason TEXT NOT NULL,
  job_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(operation_id,role)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS agent_notes_run ON agent_notes(run_id);
CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN
  ('queued','running','done','stopped','failed')), total INTEGER NOT NULL DEFAULT 0,
  queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, error TEXT,
  session_path TEXT, rules_changed INTEGER NOT NULL DEFAULT 0);
`
