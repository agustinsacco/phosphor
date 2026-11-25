/**
 * Tables later Hosts keep beside the lane store. Created on every open,
 * outside SCHEMA and with no `user_version` change, the `lane_marks`
 * precedent: `phosphor update --rollback` leaves an older Host that ignores
 * them, and SQLite still cascades a deleted lane's rows for it.
 *
 * A released table never changes shape (`IF NOT EXISTS` cannot alter it), so
 * values the code may extend stay unconstrained here and are checked in code.
 */

import { AGENT_OPS_SCHEMA } from '@phosphor/session-runtime/ops/audit'

/** A lane the service paused for an update; Continue is `lane.resume`. */
const LANE_PAUSES = `
CREATE TABLE IF NOT EXISTS lane_pauses (
  lane_id TEXT PRIMARY KEY NOT NULL REFERENCES lanes(lane_id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(reason IN ('service-update')),
  paused_at INTEGER NOT NULL,
  was TEXT NOT NULL CHECK(was IN ('idle','aborted'))
) STRICT;
`

/** Per-lane owner facts: `created_by`, `lineage`, `rewound_from`, `context_files`, `unread_seed`, `model_scan`. */
const LANE_PREFS = `
CREATE TABLE IF NOT EXISTS lane_prefs (
  lane_id TEXT NOT NULL REFERENCES lanes(lane_id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (lane_id, key)
) STRICT;
`

/** The agent-control audit log; rows arrive redacted. One home: session-runtime's audit store. */
const AGENT_OPS = AGENT_OPS_SCHEMA

/** The SHA-256 of the daemon's own last policy write and the snapshot it accepted. One row. */
const AGENT_POLICY_META = `
CREATE TABLE IF NOT EXISTS agent_policy_meta (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id = 1),
  written_sha256 TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  written_at INTEGER NOT NULL
) STRICT;
`

/** `ops.run` work that outlasts the answer deadline; `job.status` and `job.list` read it. */
const AGENT_JOBS = `
CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  principal TEXT NOT NULL,
  op TEXT NOT NULL,
  state TEXT NOT NULL,
  progress TEXT,
  result TEXT CHECK(result IS NULL OR json_valid(result)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`

/** Desktop's one-time move into this daemon, keyed by its `migrationId`. */
const OWNER_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS owner_migrations (
  migration_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL,
  began_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  detail TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS owner_migration_staging (
  migration_id TEXT NOT NULL REFERENCES owner_migrations(migration_id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  digest TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  staged_at INTEGER NOT NULL,
  PRIMARY KEY (migration_id, section)
) STRICT;
`

export const ADDITIVE_TABLES = [
  'lane_pauses',
  'lane_prefs',
  'agent_ops',
  'agent_policy_meta',
  'agent_jobs',
  'owner_migrations',
  'owner_migration_staging',
] as const

export const ADDITIVE_SCHEMA = [
  LANE_PAUSES,
  LANE_PREFS,
  AGENT_OPS,
  AGENT_POLICY_META,
  AGENT_JOBS,
  OWNER_MIGRATIONS,
].join('')
