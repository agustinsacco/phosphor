/**
 * A scratch local-mode daemon for the section importers: a private state
 * folder, a config folder, pi's sessions root and an open lane store, all
 * under one temporary folder. Nothing here touches a real HOME path.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type HostStore, type StoreLimits } from '../../../lanes/store'
import type { MigrationImportContext } from '../../migrate'
import type { ImportPorts } from '../ports'

export const uid = process.getuid?.()

export interface ScratchHost {
  readonly root: string
  readonly state: string
  readonly config: string
  readonly sessions: string
  readonly store: HostStore
  readonly ports: ImportPorts
  readonly events: { event: string; fields?: Record<string, unknown> }[]
  context(merge?: boolean): MigrationImportContext
  /** A real folder under the scratch root. */
  folder(name: string): string
  /** A pi session file `<sessions>/<dir>/<ts>_<uuid>.jsonl` with a header. */
  session(dir: string, id?: string): string
  close(): void
}

export async function scratchHost(limits: Partial<StoreLimits> = {}): Promise<ScratchHost> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'p4b-import-')))
  const state = join(root, 'state')
  const configDir = join(root, 'config')
  const sessions = join(root, 'sessions')
  for (const dir of [state, configDir, sessions]) mkdirSync(dir, { mode: 0o700 })
  const config = join(configDir, 'config.json')
  writeFileSync(
    config,
    `${JSON.stringify({ version: 1, pi: { executable: '/usr/bin/pi' }, repositories: [] }, null, 2)}\n`,
    { mode: 0o600 },
  )
  const store = await openStore(state, uid, { limits })
  const events: ScratchHost['events'] = []
  const ports: ImportPorts = {
    stateDirectory: state,
    configPath: config,
    uid,
    sessionsRoot: sessions,
    log: (event, fields) => events.push({ event, ...(fields ? { fields } : {}) }),
  }
  let clock = Date.parse('2026-01-01T00:00:00Z')
  return {
    root,
    state,
    config,
    sessions,
    store,
    ports,
    events,
    context: (merge = false) => ({ migrationId: randomUUID(), merge, store }),
    folder(name) {
      const path = join(root, 'work', name)
      mkdirSync(path, { recursive: true })
      return path
    },
    session(dir, id = randomUUID()) {
      const folder = join(sessions, dir)
      mkdirSync(folder, { recursive: true })
      const stamp = new Date((clock += 1000)).toISOString().replace(/[:.]/g, '-')
      const file = join(folder, `${stamp}_${id}.jsonl`)
      writeFileSync(file, `${JSON.stringify({ type: 'session', id, cwd: '/' })}\n`)
      return file
    },
    close() {
      store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** The importer's begin snapshot folder, made as the migration makes it. */
export function snapshotFolder(host: ScratchHost, section: string): string {
  const folder = join(host.root, 'snapshot', section)
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  return folder
}
