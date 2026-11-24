import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createSessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import type { LaneEditingPorts } from '../editing'
import { loadSqlite } from '../sqlite'
import { prepareStateFile } from '../state-dir'
import { openStore, type HostStore, type StoredLane, type StorePorts } from '../store'

const uid = process.getuid?.()

export interface EditingFixture {
  readonly root: string
  readonly repo: string
  readonly sessions: string
  readonly stateDirectory: string
  readonly store: HostStore
  /** A second connection to `state.sqlite`, as the ops service holds one. */
  readonly db: DatabaseSync
  readonly ports: LaneEditingPorts
  /** Files a pi owns: label and jump refuse them, as the runtime's registry does. */
  readonly open: Set<string>
  readonly announced: string[]
  /** A stopped lane over a session file written from `lines`. */
  lane(name: string, lines: readonly string[]): StoredLane
  prefs(laneId: string): Record<string, string>
  close(): void
}

/** A temp Host: its store, `state.sqlite`, one repository and the runtime's path lock. */
export async function editingFixture(storePorts: StorePorts = {}): Promise<EditingFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-editing-')))
  const repo = join(root, 'repo')
  const sessions = join(root, 'sessions')
  const stateDirectory = join(root, 'state')
  mkdirSync(repo)
  mkdirSync(sessions)
  const store = await openStore(stateDirectory, uid, storePorts)
  const sqlite = await loadSqlite()
  const db: DatabaseSync = new sqlite.DatabaseSync(prepareStateFile(stateDirectory, uid))
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
  const paths = createSessionPathRuntime()
  const open = new Set<string>()
  const announced: string[] = []
  const repository = store.syncRepositories([repo])[0]!
  const ports: LaneEditingPorts = {
    store,
    db,
    announce: (laneId) => announced.push(laneId),
    runtime: {
      mutateStoppedSession: (path, change) =>
        paths.withSessionPath(path, async () => {
          if (open.has(path)) throw new Error('Stop the lane before changing its saved files.')
          return change()
        }),
      withSessionFile: (path, read) => paths.withSessionPath(path, read),
    },
  }
  return {
    root,
    repo,
    sessions,
    stateDirectory,
    store,
    db,
    ports,
    open,
    announced,
    lane(name, lines) {
      const file = join(sessions, `${name}.jsonl`)
      writeFileSync(file, lines.join(''))
      return store.ensureLane({
        repositoryId: repository.id,
        cwd: repo,
        sessionFile: file,
        worktree: false,
        title: 'Source',
      })
    },
    prefs(laneId) {
      const rows = db
        .prepare('SELECT key, value FROM lane_prefs WHERE lane_id=? ORDER BY key')
        .all(laneId)
      return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]))
    },
    close() {
      db.close()
      store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** One JSONL line. */
export const line = (value: unknown): string => JSON.stringify(value) + '\n'

/** A pi session: header, a user message `u1`, its answer `a1`, a second user message `u2`. */
export function transcript(cwd: string, id = '11111111-1111-4111-8111-111111111111'): string[] {
  const at = '2026-08-01T10:00:00.000Z'
  const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
  return [
    line({ type: 'session', version: 3, id, timestamp: at, cwd }),
    line({ type: 'message', id: 'u1', parentId: null, timestamp: at, message: user('first') }),
    line({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: at,
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    }),
    line({ type: 'message', id: 'u2', parentId: 'a1', timestamp: at, message: user('second') }),
  ]
}
