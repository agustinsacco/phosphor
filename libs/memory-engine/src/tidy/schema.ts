/** Additive v6 migration. No corpus backfill or model work during startup. */
export const tidySchema = `
CREATE TABLE tidy_suggestions(id TEXT PRIMARY KEY, pair_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL, source TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','applied','dismissed','cleared')),
  subject_type TEXT NOT NULL CHECK(subject_type IN ('entity','memory')), first_id TEXT NOT NULL, second_id TEXT,
  reason TEXT NOT NULL, verdict TEXT CHECK(verdict IN ('same','different','conflict','replaces')),
  verdict_reason TEXT, newer_id TEXT, model TEXT, problem TEXT, session_id TEXT, title TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX tidy_suggestions_page ON tidy_suggestions(state,created_at DESC,id);
CREATE INDEX tidy_suggestions_kind ON tidy_suggestions(state,kind,created_at DESC,id);
CREATE INDEX tidy_suggestions_pending ON tidy_suggestions(state,verdict,created_at,id);
CREATE INDEX tidy_suggestions_first ON tidy_suggestions(subject_type,first_id);
CREATE INDEX tidy_suggestions_second ON tidy_suggestions(subject_type,second_id);
CREATE INDEX tidy_suggestions_lane ON tidy_suggestions(session_id,state);
CREATE TABLE tidy_operations(id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  automatic INTEGER NOT NULL CHECK(automatic IN (0,1)), summary TEXT NOT NULL,
  created_at INTEGER NOT NULL, undone_at INTEGER,
  suggestion_id TEXT REFERENCES tidy_suggestions(id) ON DELETE SET NULL,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('entity','memory')), first_id TEXT NOT NULL, second_id TEXT NOT NULL);
CREATE INDEX tidy_operations_recent ON tidy_operations(created_at DESC,id);
CREATE INDEX tidy_operations_automatic ON tidy_operations(automatic,created_at DESC);
CREATE TABLE tidy_operation_rows(operation_id TEXT NOT NULL REFERENCES tidy_operations(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL, row_key TEXT NOT NULL,
  before_image TEXT NOT NULL CHECK(json_valid(before_image) AND json_extract(before_image,'$.version')=1),
  after_hash TEXT, PRIMARY KEY(operation_id,table_name,row_key)) WITHOUT ROWID;
CREATE TABLE tidy_operation_memories(operation_id TEXT NOT NULL REFERENCES tidy_operations(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL, memory_n INTEGER NOT NULL, PRIMARY KEY(operation_id,memory_id)) WITHOUT ROWID;
CREATE INDEX tidy_operation_memories_memory ON tidy_operation_memories(memory_id,operation_id);
CREATE TABLE tidy_memory_keys(memory INTEGER PRIMARY KEY REFERENCES memories(n) ON DELETE CASCADE, fingerprint TEXT NOT NULL);
CREATE INDEX tidy_memory_keys_fingerprint ON tidy_memory_keys(fingerprint,memory);
CREATE TABLE tidy_sweep(singleton INTEGER PRIMARY KEY CHECK(singleton=1), phase TEXT NOT NULL,
  cursor INTEGER NOT NULL, entities INTEGER NOT NULL, memories INTEGER NOT NULL,
  total_entities INTEGER NOT NULL, total_memories INTEGER NOT NULL, entity_max INTEGER NOT NULL,
  memory_max INTEGER NOT NULL, limited_checks INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
INSERT INTO tidy_sweep VALUES(1,'entities',0,0,0,0,0,0,0,0,NULL,NULL);
-- Unused legacy checkpoint; every Brain still has it, so the schemas stay equal.
CREATE TABLE tidy_run(singleton INTEGER PRIMARY KEY CHECK(singleton=1), state TEXT NOT NULL,
  done INTEGER NOT NULL, total INTEGER NOT NULL, found INTEGER NOT NULL, error TEXT, model TEXT,
  started_at INTEGER, finished_at INTEGER, folded INTEGER NOT NULL DEFAULT 0, message TEXT);
INSERT INTO tidy_run VALUES(1,'idle',0,0,0,NULL,NULL,NULL,NULL,0,NULL);
PRAGMA user_version=6;
`
