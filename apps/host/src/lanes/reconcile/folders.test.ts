import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ScanState } from '../reconcile'
import { openStore, type HostStore } from '../store'
import { discoverFolders, RECONCILE_LIMITS } from './folders'

let root: string
let repository: string
let store: HostStore
let state: ScanState
beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'host-reconcile-folders-')))
  repository = join(root, 'repo')
  mkdirSync(repository)
  store = await openStore(join(root, 'state'), process.getuid?.())
  state = {
    repositories: store.syncRepositories([repository]),
    known: [],
    folders: new Map(),
    added: 0,
    removed: 0,
    skipped: 0,
    liveLanes: 0,
    admissionsFull: false,
  }
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

it('keeps configured roots when worktrees are missing or not a directory', async () => {
  await discoverFolders(state)
  expect([...state.folders.keys()]).toEqual([repository])
  expect(state.skipped).toBe(0)
  mkdirSync(join(repository, '.phosphor'))
  writeFileSync(join(repository, '.phosphor', 'worktrees'), '')
  await discoverFolders(state)
  expect([...state.folders.keys()]).toEqual([repository])
  expect(state.skipped).toBe(1)
})

it('refuses non-directory entries and symlinks even to an internal directory', async () => {
  const directory = join(repository, '.phosphor', 'worktrees')
  mkdirSync(directory, { recursive: true })
  const internal = join(repository, 'internal')
  mkdirSync(internal)
  writeFileSync(join(directory, 'file'), '')
  symlinkSync(internal, join(directory, 'link'))
  await discoverFolders(state)
  expect([...state.folders.keys()]).toEqual([repository])
  expect(state.skipped).toBe(2)
})

it('refuses a symlinked worktrees root and an escape through a parent symlink', async () => {
  const outside = join(root, 'outside')
  mkdirSync(join(outside, 'worktrees', 'topic'), { recursive: true })
  mkdirSync(join(repository, '.phosphor'))
  symlinkSync(join(outside, 'worktrees'), join(repository, '.phosphor', 'worktrees'))
  await discoverFolders(state)
  expect(state.skipped).toBe(1)
  rmSync(join(repository, '.phosphor'), { recursive: true })
  symlinkSync(outside, join(repository, '.phosphor'))
  await discoverFolders(state)
  expect(state.skipped).toBe(2)
  expect([...state.folders.keys()]).toEqual([repository])
})

it('discovers at most 256 worktree entries per repository', async () => {
  const directory = join(repository, '.phosphor', 'worktrees')
  for (let i = 0; i <= RECONCILE_LIMITS.worktreesPerRepository; i++)
    mkdirSync(join(directory, String(i)), { recursive: true })
  await discoverFolders(state)
  expect(state.folders.size).toBe(RECONCILE_LIMITS.worktreesPerRepository + 1)
  expect(state.skipped).toBe(1)
})

it('keeps known missing worktrees, resolves aliases and ignores inactive repositories', async () => {
  const repositoryId = state.repositories[0]!.id
  const cwd = join(root, 'missing-worktree')
  store.ensureLane({ repositoryId, cwd, sessionFile: null, worktree: true })
  const alias = join(root, 'alias')
  symlinkSync(repository, alias)
  store.ensureLane({ repositoryId, cwd: alias, sessionFile: null, worktree: true })
  state.known = store.listLanes()
  state.known.push({
    ...state.known[0]!,
    laneId: randomUUID(),
    repositoryId: '0000000000000000',
    cwd: join(root, 'inactive'),
  })
  await discoverFolders(state)
  expect([...state.folders.keys()]).toEqual([repository, cwd])
  expect(state.skipped).toBe(0)
})

it('checks abort before mutating the next repository folder', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(discoverFolders(state, controller.signal)).rejects.toBe(controller.signal.reason)
  expect(state.folders.size).toBe(0)
})
