import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import { remoteLaneResourceKey } from '@shared/remote-host'
import { backupDirFor, backupUserData } from '../backup'
import { MIGRATION_DIR, journalWriter, newJournal } from '../journal'
import { buildPlan } from '../plan'
import { MACHINE_ID, MIGRATION_ID, REPO, planFacts, session } from './plan-facts'
import { baseRoutines } from './base-desktop'

export const otherPin = remoteLaneResourceKey('other', 'lane')
export const source = session(1).path
export const ports = { routinesFile: 'routines.sqlite' as const }
export const permit = { allowed: true, brand: 'migration-permit' } as const
export function world() {
  const userData = mkdtempSync(join(tmpdir(), 'device-cutover-'))
  const file = join(userData, 'config.json')
  const read = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const write = (config: Record<string, unknown>) => writeFileSync(file, JSON.stringify(config))
  const draft = (key: string) => ({
    key,
    text: 'hello',
    workspacePath: REPO,
    attachments: [{ kind: 'image', blobId: 'image-cleared' }],
  })
  const config = {
    theme: 'dark',
    lastSessionPath: source,
    lastWorkspacePath: REPO,
    recentWorkspaces: [{ path: userData, name: 'existing', lastOpenedAt: 1 }],
    pinnedSessions: [source, otherPin],
    laneMarkers: { [source]: 'a', [otherPin]: 'b' },
    collapsedWorkspaces: [REPO, 'host:other/repo:z', 'missing'],
    sessionOrder: [source, 'host:other/lane:l', 'missing'],
    drafts: Object.fromEntries(
      [`session:${source}`, `home:${REPO}`, 'home:missing', 'session:missing', otherPin].map(
        (key) => [key, draft(key)],
      ),
    ),
  }
  write(config)
  baseRoutines(userData)
  const db = new (loadSqlite().DatabaseSync)(join(userData, ports.routinesFile))
  db.prepare('INSERT INTO routines VALUES (?,?)').run('r', '{"name":"routine"}')
  db.close()
  const dir = join(userData, MIGRATION_DIR)
  const backupDir = backupDirFor(dir, MIGRATION_ID)
  backupUserData({ userData, backupDir, migrationId: MIGRATION_ID, ...ports })
  const journal = {
    ...newJournal({ migrationId: MIGRATION_ID, desktopVersion: 'v', at: new Date().toISOString() }),
    state: 'committed' as const,
    machineId: MACHINE_ID,
  }
  const writer = journalWriter(dir, permit)
  writer.write(journal)
  const plan = buildPlan(planFacts())
  return { userData, backupDir, journal, plan, config, read, write, writer }
}
