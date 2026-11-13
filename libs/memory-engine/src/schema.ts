import { all, one, run, transaction, type Context } from './database'
import { prefs, setPrefs } from './prefs'

export function initialize(ctx: Context): void {
  ctx.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL')
  const version = one<{ user_version: number }>(ctx, 'PRAGMA user_version')!.user_version
  if (version > 4) throw new Error('This Brain database requires a newer application.')
  if (version !== 4) reset(ctx)
}
export function reset(ctx: Context): void {
  const hasMeta = one(ctx, "SELECT 1 FROM sqlite_master WHERE name='meta'")
  const previous = hasMeta ? prefs(ctx) : undefined
  ctx.db.exec('PRAGMA foreign_keys = OFF')
  try {
    transaction(ctx, () => {
      // Defensive SQLite (Electron) refuses to drop FTS shadow tables; dropping each virtual
      // table first removes its own, so only virtual and ordinary tables are dropped here.
      const tables = all<{ name: string; type: string }>(
        ctx,
        "SELECT name,type FROM pragma_table_list WHERE schema='main' AND type IN ('virtual','table') ORDER BY type='table'",
      )
      for (const { name } of tables) {
        if (!name.startsWith('sqlite_'))
          ctx.db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`)
      }
      ctx.db.exec(schema)
      for (const [key, value] of Object.entries({
        revision: '0',
        generation: ctx.id(),
        memories: '0',
        entities: '0',
        entity_bits: '0',
        memory_bits: '0',
      })) {
        run(ctx, 'INSERT INTO meta VALUES (?,?)', key, value)
      }
      setPrefs(ctx, { ...(previous ?? prefs(ctx)), review: true })
    })
  } finally {
    ctx.db.exec('PRAGMA foreign_keys = ON')
  }
  ctx.db.exec('VACUUM')
}

const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE entities(n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, label TEXT NOT NULL, kind TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  memories INTEGER NOT NULL DEFAULT 0, connections INTEGER NOT NULL DEFAULT 0);
CREATE INDEX entities_connections ON entities(connections DESC);
CREATE TABLE entity_names(n INTEGER PRIMARY KEY, entity INTEGER NOT NULL REFERENCES entities(n) ON DELETE CASCADE,
  name TEXT NOT NULL, folded TEXT NOT NULL, UNIQUE(entity, folded));
CREATE INDEX entity_names_folded ON entity_names(folded, entity);
CREATE TABLE entity_keys(namespace TEXT NOT NULL, value TEXT NOT NULL,
  entity INTEGER NOT NULL REFERENCES entities(n) ON DELETE CASCADE, PRIMARY KEY(namespace, value)) WITHOUT ROWID;
CREATE INDEX entity_keys_entity ON entity_keys(entity);
CREATE VIRTUAL TABLE entity_words USING fts5(text);
CREATE VIRTUAL TABLE entity_words_vocab USING fts5vocab(entity_words, 'row');
CREATE VIRTUAL TABLE entity_grams USING fts5(name, tokenize='trigram');
CREATE TABLE merges(n INTEGER PRIMARY KEY, source_id TEXT NOT NULL, target INTEGER NOT NULL REFERENCES entities(n) ON DELETE CASCADE,
  label TEXT NOT NULL, reason TEXT NOT NULL, recorded_at INTEGER NOT NULL);
CREATE INDEX merges_target ON merges(target);
CREATE TABLE memories(n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, summary TEXT NOT NULL, type TEXT NOT NULL,
  epistemic TEXT NOT NULL, scope TEXT NOT NULL, branch TEXT, valid_from INTEGER, valid_to INTEGER,
  observed_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','superseded','disputed')),
  origin_session TEXT, origin_title TEXT, job_id TEXT);
CREATE INDEX memories_recent ON memories(state, observed_at DESC);
CREATE INDEX memories_job ON memories(job_id);
CREATE TABLE mentions(memory INTEGER NOT NULL REFERENCES memories(n) ON DELETE CASCADE,
  entity INTEGER NOT NULL REFERENCES entities(n), PRIMARY KEY(memory, entity)) WITHOUT ROWID;
CREATE INDEX mentions_entity ON mentions(entity, memory);
CREATE TABLE relations(n INTEGER PRIMARY KEY, memory INTEGER NOT NULL REFERENCES memories(n) ON DELETE CASCADE,
  subject INTEGER NOT NULL REFERENCES entities(n), predicate TEXT NOT NULL, object INTEGER NOT NULL REFERENCES entities(n),
  live INTEGER NOT NULL, observed_at INTEGER NOT NULL,
  UNIQUE(memory, subject, predicate, object), CHECK(subject <> object));
CREATE INDEX relations_out ON relations(subject, live, predicate, observed_at DESC);
CREATE INDEX relations_in ON relations(object, live, predicate, observed_at DESC);
CREATE TABLE evidence(n INTEGER PRIMARY KEY, session_id TEXT, entry_id TEXT NOT NULL, role TEXT NOT NULL,
  label TEXT NOT NULL, observed_at INTEGER NOT NULL, text TEXT NOT NULL);
CREATE TABLE citations(memory INTEGER NOT NULL REFERENCES memories(n) ON DELETE CASCADE,
  evidence INTEGER NOT NULL REFERENCES evidence(n), quote TEXT NOT NULL, PRIMARY KEY(memory, evidence, quote)) WITHOUT ROWID;
CREATE INDEX citations_evidence ON citations(evidence);
CREATE TABLE relation_support(relation INTEGER NOT NULL REFERENCES relations(n) ON DELETE CASCADE,
  evidence INTEGER NOT NULL REFERENCES evidence(n), quote TEXT NOT NULL, PRIMARY KEY(relation, evidence, quote)) WITHOUT ROWID;
CREATE INDEX relation_support_evidence ON relation_support(evidence);
CREATE TABLE memory_links(source INTEGER NOT NULL REFERENCES memories(n) ON DELETE CASCADE,
  target INTEGER NOT NULL REFERENCES memories(n) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('supersedes','conflicts','resolves')), recorded_at INTEGER NOT NULL,
  PRIMARY KEY(source, target, kind)) WITHOUT ROWID;
CREATE INDEX memory_links_target ON memory_links(target, kind);
CREATE VIRTUAL TABLE memory_words USING fts5(summary);
CREATE VIRTUAL TABLE memory_words_vocab USING fts5vocab(memory_words, 'row');
CREATE TABLE memory_vectors(memory INTEGER PRIMARY KEY REFERENCES memories(n) ON DELETE CASCADE, vector BLOB NOT NULL);
CREATE TABLE memory_bits(memory INTEGER PRIMARY KEY REFERENCES memories(n) ON DELETE CASCADE, bits BLOB NOT NULL);
CREATE TABLE entity_vectors(entity INTEGER PRIMARY KEY REFERENCES entities(n) ON DELETE CASCADE, vector BLOB NOT NULL);
CREATE TABLE entity_bits(entity INTEGER PRIMARY KEY REFERENCES entities(n) ON DELETE CASCADE, bits BLOB NOT NULL);
CREATE TRIGGER entity_bits_insert AFTER INSERT ON entity_bits BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+(1) WHERE key='entity_bits'; END;
CREATE TRIGGER entity_bits_delete AFTER DELETE ON entity_bits BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+(-1) WHERE key='entity_bits'; END;
CREATE TRIGGER memory_bits_insert AFTER INSERT ON memory_bits BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+(1) WHERE key='memory_bits'; END;
CREATE TRIGGER memory_bits_delete AFTER DELETE ON memory_bits BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+(-1) WHERE key='memory_bits'; END;
CREATE TABLE jobs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_path TEXT NOT NULL, title TEXT NOT NULL,
  scope TEXT NOT NULL, branch TEXT, model TEXT NOT NULL, state TEXT NOT NULL, memories INTEGER NOT NULL,
  leaf_id TEXT, error TEXT, queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, usage TEXT,
  extractor INTEGER NOT NULL, progress TEXT, computed_revision INTEGER);
CREATE INDEX jobs_session ON jobs(session_id, state);
CREATE TABLE job_parts(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, part TEXT NOT NULL,
  input_hash TEXT NOT NULL, state TEXT NOT NULL, output TEXT, PRIMARY KEY(job_id, part, input_hash)) WITHOUT ROWID;
CREATE TABLE proposals(job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, payload TEXT NOT NULL);
CREATE TABLE proposal_vectors(job_id TEXT NOT NULL REFERENCES proposals(job_id) ON DELETE CASCADE, kind TEXT NOT NULL,
  idx INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(job_id, kind, idx)) WITHOUT ROWID;
CREATE TABLE extractions(job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_path TEXT NOT NULL, title TEXT NOT NULL,
  leaf_id TEXT, model TEXT NOT NULL, thinking TEXT NOT NULL, calls TEXT NOT NULL, outcomes TEXT NOT NULL, error TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL);
PRAGMA user_version = 4;
`
