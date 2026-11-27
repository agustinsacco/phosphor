import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { openStore, type HostStore } from './store'
import { reconcile } from './reconcile'

let root: string
let brain: string
let store: HostStore
beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'host-reconcile-reserved-')))
  brain = join(root, 'state', 'brain', 'Brain')
  mkdirSync(brain, { recursive: true })
  store = await openStore(join(root, 'lanes'), process.getuid?.())
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

function transcript(cwd: string): void {
  const directory = sessionDirForCwd(cwd, join(root, 'sessions'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `${randomUUID()}.jsonl`),
    JSON.stringify({ type: 'session', id: randomUUID(), cwd }) + '\n',
  )
}

it('never adopts a reserved lane’s transcripts, even when its folder is a repository', async () => {
  const harbor = join(root, 'harbor')
  mkdirSync(harbor)
  store.syncRepositories([harbor, brain])
  transcript(harbor)
  transcript(brain)
  const counts = await reconcile(store, join(root, 'sessions'), () => {}, undefined, undefined, [
    brain,
  ])
  expect(counts.added).toBe(1)
  expect(store.listLanes().map((lane) => lane.cwd)).toEqual([harbor])
})

it('retires a row an older Host stored for the reserved folder', async () => {
  const [repository] = store.syncRepositories([brain])
  const directory = sessionDirForCwd(brain, join(root, 'sessions'))
  mkdirSync(directory, { recursive: true })
  const sessionFile = join(directory, `${randomUUID()}.jsonl`)
  writeFileSync(
    sessionFile,
    JSON.stringify({ type: 'session', id: randomUUID(), cwd: brain }) + '\n',
  )
  const old = store.ensureLane({ repositoryId: repository!.id, cwd: brain, sessionFile })
  const inner = join(brain, 'notes')
  mkdirSync(inner)
  const nested = store.ensureLane({ repositoryId: repository!.id, cwd: inner, sessionFile: null })
  const counts = await reconcile(store, join(root, 'sessions'), () => {}, undefined, undefined, [
    brain,
  ])
  expect(counts.removed).toBe(2)
  expect(store.listLanes()).toEqual([])
  expect(store.getLane(old.laneId)?.removedAt).not.toBeNull()
  expect(store.getLane(nested.laneId)?.removedAt).not.toBeNull()
  // The transcript stays: Brain Agent's lane continues it.
  expect(existsSync(sessionFile)).toBe(true)
})
