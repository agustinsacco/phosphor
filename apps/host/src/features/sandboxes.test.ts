import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { readOwnerFolders, writeOwnerFolders } from '../config/folders-file'
import { openStore, type HostStore } from '../lanes/store'
import { createWorkspaceLeases } from '../owner/lease'
import { createHostSandboxes, type SandboxPorts } from './sandboxes'

let root: string, store: HostStore, p: SandboxPorts
const uid = process.getuid?.()
function config(changes: boolean) {
  writeFileSync(
    p.configPath,
    JSON.stringify({
      version: 1,
      pi: { executable: process.execPath },
      repositories: [],
      allowRepositoryChanges: changes,
    }),
    // The loader refuses a config others can write; CI runners use umask 002.
    { mode: 0o600 },
  )
}
beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'host-sandboxes-')))
  store = await openStore(join(root, 'state'), uid)
  p = {
    local: true,
    uid,
    stateDirectory: join(root, 'state'),
    configPath: join(root, 'config.json'),
    home: root,
    env: { PI_CODING_AGENT_DIR: join(root, 'pi'), CLAUDE_CONFIG_DIR: join(root, 'claude') },
    store,
    leases: createWorkspaceLeases(() => []),
    live: () => false,
    trashItem: async (path) => renameSync(path, join(root, 'trash-' + basename(path))),
    changed: vi.fn(),
  }
  config(true)
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

it('creates under the canonical imported root, renames transcripts and their lane id, then trashes both', async () => {
  const base = join(root, 'boxes'),
    alias = join(root, 'alias')
  mkdirSync(base)
  symlinkSync(base, alias)
  writeOwnerFolders(root, uid, { version: 1, items: [], sandboxRoot: alias })
  const service = createHostSandboxes(p)
  const { path } = await service.create('scratch')
  expect(service.list()).toMatchObject([{ path: join(base, 'scratch') }])
  const sessions = join(root, 'pi', 'sessions')
  const dir = sessionDirForCwd(path, sessions)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'one.jsonl')
  writeFileSync(file, JSON.stringify({ type: 'session', cwd: path }) + '\n')
  const lane = store.ensureLane({
    repositoryId: store.listRepositories()[0]!.id,
    cwd: path,
    sessionFile: file,
  })
  const renamed = join(base, 'new')
  await service.change(join(alias, 'scratch'), 'new', true)
  const transcript = join(sessionDirForCwd(renamed, sessions), 'one.jsonl')
  expect(JSON.parse(readFileSync(transcript, 'utf8'))).toMatchObject({ cwd: renamed })
  expect(store.getLane(lane.laneId)).toMatchObject({
    cwd: renamed,
    sessionFile: transcript,
    repositoryId: store.listRepositories()[0]!.id,
  })
  expect(readOwnerFolders(root, uid)?.items).toMatchObject([{ path: renamed, sandbox: true }])
  await service.change(renamed, null, true)
  expect(store.getLane(lane.laneId)?.removedAt).not.toBeNull()
  expect(store.listRepositories()).toEqual([])
  expect(existsSync(join(root, 'trash-new'))).toBe(true)
  expect(existsSync(transcript)).toBe(false)
})

it('checks live and archived descendants, existing leases, and the current config before mutation', async () => {
  const service = createHostSandboxes(p)
  const { path } = await service.create('mine')
  const held = await p.leases.take('desktop', [path], 120000)
  expect(held).toHaveProperty('leaseId')
  await expect(service.change(path, null, true)).rejects.toMatchObject({ code: 'busy' })
  if ('leaseId' in held) p.leases.release('desktop', held.leaseId)
  p.live = () => true
  await expect(service.change(path, 'two', false)).rejects.toMatchObject({ code: 'busy' })
  p.live = () => false
  const lane = store.ensureLane({
    repositoryId: store.listRepositories()[0]!.id,
    cwd: join(path, 'nested'),
    sessionFile: null,
  })
  store.archives.mark(lane.laneId)
  await expect(service.change(path, null, true)).rejects.toMatchObject({ code: 'busy' })
  config(false)
  await expect(service.create('no')).rejects.toMatchObject({ code: 'forbidden' })
  await expect(service.change(path, 'two', false)).rejects.toMatchObject({ code: 'forbidden' })
  expect(service.list()).toMatchObject([{ name: 'mine' }])
})

it('refuses a rename onto an occupied transcript directory without moving the workspace', async () => {
  const service = createHostSandboxes(p)
  const { path } = await service.create('one')
  const other = join(p.stateDirectory, 'sandboxes', 'two')
  const sessions = join(root, 'pi', 'sessions')
  mkdirSync(sessionDirForCwd(other, sessions), { recursive: true })
  await expect(service.change(path, 'two', true)).rejects.toThrow()
  expect(existsSync(path)).toBe(true)
  expect(existsSync(other)).toBe(false)
})
