import type { Context } from './database'
import { all, one, transaction } from './database'

export function initialize(ctx: Context): void {
  ctx.db.exec('PRAGMA foreign_keys = ON')
  const version = one<{ user_version: number }>(ctx, 'PRAGMA user_version')!.user_version
  if (version === 3) return
  if (version === 2) {
    transaction(ctx, () => {
      ctx.db.exec('ALTER TABLE memories ADD COLUMN job_id TEXT')
      ctx.db.exec(extractionsSchema)
      ctx.db.exec('PRAGMA user_version = 3')
    })
    return
  }
  if (version > 3) throw new Error('This Brain database requires a newer application.')
  ctx.db.exec('PRAGMA foreign_keys = OFF')
  try {
    transaction(ctx, () => {
      // FTS shadow tables disappear with their parent; skip names already removed.
      const tables = all<{ name: string }>(ctx, "SELECT name FROM sqlite_master WHERE type='table'")
      for (const { name } of tables) {
        if (!name.startsWith('sqlite_'))
          ctx.db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`)
      }
      ctx.db.exec(schema)
    })
  } finally {
    ctx.db.exec('PRAGMA foreign_keys = ON')
  }
}

const extractionsSchema = `
CREATE TABLE extractions(job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
 session_path TEXT NOT NULL, title TEXT NOT NULL, leaf_id TEXT, model TEXT NOT NULL,
 thinking TEXT NOT NULL, prompt TEXT NOT NULL, answer TEXT NOT NULL, trace TEXT NOT NULL,
 outcomes TEXT NOT NULL, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL);
`
const schema = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('revision', '0');
CREATE TABLE entities(id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL,
  aliases TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE memories(id TEXT PRIMARY KEY, scope TEXT NOT NULL, subject_id TEXT NOT NULL,
  predicate TEXT NOT NULL, object_id TEXT, literal TEXT, summary TEXT NOT NULL,
  type TEXT NOT NULL, kind TEXT NOT NULL, branch TEXT, valid_from INTEGER,
  recorded_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','superseded')),
  origin_session TEXT, origin_title TEXT, job_id TEXT);
CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED, text);
CREATE TABLE vectors(memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  vector BLOB NOT NULL);
CREATE TABLE evidence(id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, role TEXT NOT NULL,
  label TEXT NOT NULL, observed_at INTEGER NOT NULL, text TEXT NOT NULL);
CREATE TABLE citations(memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(id), quote TEXT NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_path TEXT NOT NULL,
  title TEXT NOT NULL, scope TEXT NOT NULL, branch TEXT, model TEXT NOT NULL, state TEXT NOT NULL,
  memories INTEGER NOT NULL, leaf_id TEXT, error TEXT, queued_at INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER, usage TEXT);
CREATE INDEX jobs_session ON jobs(session_id, state);
CREATE TABLE proposals(job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  extraction TEXT NOT NULL);
CREATE TABLE proposal_vectors(job_id TEXT NOT NULL REFERENCES proposals(job_id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(job_id, idx));
CREATE TABLE deliveries(session_id TEXT NOT NULL,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, delivered_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, memory_id));
${extractionsSchema}
PRAGMA user_version = 3;
`
