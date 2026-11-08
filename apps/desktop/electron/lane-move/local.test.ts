import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import { openMemoryStore } from '@phosphor/memory-engine/service'
import { DEFAULT_BRAIN_PREFS } from '@phosphor/shared/brain'
import { createMemoryClient } from '@phosphor/brain-runtime/memory-client'
import { createMemoryHandler } from '@phosphor/brain-runtime/memory-worker-handler'
import type { MemoryRequest, MemoryResponse } from '@phosphor/brain-runtime/memory-protocol'

const state = vi.hoisted(() => ({
  root: '',
  profile: '',
  openStore: vi.fn(),
  embeddings: vi.fn(),
  requests: [] as MemoryRequest[],
  authorityError: '',
  registry: { list: () => [], get: () => undefined, on: vi.fn(), off: vi.fn() },
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => state.profile,
    getAppPath: () => '/synthetic/apps/desktop',
    isPackaged: false,
  },
}))
vi.mock('../registry', () => ({ registry: state.registry }))
vi.mock('../pi/session-runtime', () => ({
  desktopSessions: { create: vi.fn(), disposeBrain: vi.fn() },
  setSessionMemory: vi.fn(),
}))
vi.mock('../pi/pi-paths', () => ({ piSessionsRoot: () => state.root }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
vi.mock('../brain/memory-service', () => ({ createDesktopMemory: state.openStore }))
vi.mock('../brain/embedding-service', () => ({ createBrainEmbeddings: state.embeddings }))
vi.mock('../brain/learning-host', () => ({ createDesktopLearningHost: () => undefined }))
vi.mock('../brain/processor-resolver', () => ({ resolveBrainProcessor: vi.fn() }))
vi.mock('../fs/git-worktrees', () => ({
  addWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  startPoint: vi.fn(),
}))
vi.mock('./runtime', () => ({
  localTransferRuntime: async () => ({ piVersion: '1.4.0', claudeVersion: null, models: null }),
}))

const nativeId = '11111111-2222-4333-8444-555555555555'
let home: string
let cwd: string
let file: string
let original: string
let closeWorker: (() => void) | undefined

function database() {
  return openMemoryStore({
    directory: join(state.profile, 'brain'),
    Database: loadSqlite().DatabaseSync,
  })
}
function worker() {
  const engine = database()
  const handle = createMemoryHandler(engine)
  let receive!: (response: MemoryResponse) => void
  closeWorker = () => engine.close()
  return createMemoryClient({
    post(request) {
      state.requests.push(request)
      const response: MemoryResponse =
        state.authorityError && request.method === 'excludedSource'
          ? { id: request.id, ok: false, error: state.authorityError }
          : handle(request)
      queueMicrotask(() => receive(response))
    },
    onMessage(listener) {
      receive = listener
    },
    onExit() {},
    kill() {},
  })
}
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  home = await realpath(await mkdtemp(join(tmpdir(), 'local-move-brain-')))
  cwd = join(home, 'folder')
  state.profile = join(home, 'profile')
  state.root = join(home, 'sessions')
  state.requests = []
  state.authorityError = ''
  await mkdir(cwd)
  await mkdir(join(state.root, 'folder'), { recursive: true })
  file = join(state.root, 'folder', `2026-11-06T13-46-35-141Z_${nativeId}.jsonl`)
  original =
    [
      { type: 'session', version: 3, id: nativeId, cwd },
      {
        type: 'message',
        id: 'old-user',
        parentId: null,
        message: { role: 'user', content: 'Synthetic input' },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n'
  await writeFile(file, original)
  state.openStore.mockImplementation(worker)
  state.embeddings.mockReturnValue({
    status: () => ({ phase: 'missing' }),
    setEnabled: async () => {},
    dispose() {},
  })
})
afterEach(async () => {
  const runtime = await import('../brain/runtime')
  await runtime.disposeBrain()
  closeWorker?.()
  closeWorker = undefined
  await rm(home, { recursive: true, force: true })
})

it.each([
  { nonempty: false, enabled: true },
  { nonempty: true, enabled: true },
  { nonempty: false, enabled: false },
  { nonempty: true, enabled: false },
])(
  'refuses a historical Brain recipient: %j, even with recall off',
  async ({ nonempty, enabled }) => {
    const engine = database()
    engine.setPrefs({ ...DEFAULT_BRAIN_PREFS, enabled: true, recall: true, workspaces: [cwd] })
    const evidence = nonempty
      ? engine.capture({
          scope: cwd,
          sessionId: 'independent',
          entryId: 'witness',
          parentId: null,
          rootIds: ['witness'],
          branch: null,
          role: 'user',
          label: 'Synthetic',
          observedAt: Date.now(),
          text: 'Independent synthetic evidence',
        })!
      : null
    for (const sessionId of ['old-runtime', nativeId])
      engine.recordDelivery({ sessionId, evidenceIds: evidence ? [evidence.id] : [], claimIds: [] })
    engine.setPrefs({ ...engine.snapshot().prefs, enabled, recall: false })
    const before = engine.snapshot()
    engine.close()

    const { localLanes } = await import('./local')
    const inspection = await localLanes.inspect(file, false)
    expect('blockers' in inspection ? inspection.blockers : undefined).toEqual([
      expect.stringMatching(/Brain.*recipient/i),
    ])
    const archive = join(home, 'refused.bundle')
    await expect(localLanes.export(file, false, archive)).rejects.toThrow(/Brain.*recipient/i)
    await expect(readFile(archive)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(file, 'utf8')).toBe(original)
    expect(
      state.requests
        .filter((request) => request.method === 'excludedSource')
        .map((request) => request.args),
    ).toEqual([[nativeId], [nativeId]])
    const { brainService } = await import('../brain/runtime')
    expect((await (await brainService()).api.status()).snapshot).toEqual(before)
  },
)

import type * as Os from 'node:os'
import type { SessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import type * as PathLock from '../pi/session-path-lock'

const lockObservation = vi.hoisted(() => ({ queued: undefined as (() => void) | undefined }))
vi.mock('../pi/session-path-lock', async (original) => {
  const actual = await original<typeof PathLock>()
  const withSessionPath: SessionPathRuntime['withSessionPath'] = (path, run) => {
    const operation = actual.withSessionPath(path, run)
    lockObservation.queued?.()
    return operation
  }
  return { ...actual, withSessionPath }
})
afterEach(() => {
  lockObservation.queued = undefined
})

// Every transfer-side pairing/ledger probe stays inside this synthetic profile.
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => state.profile,
}))
beforeEach(() => {
  vi.stubEnv('PI_CODING_AGENT_DIR', join(state.profile, 'agent'))
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', state.root)
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(state.profile, 'claude'))
})
afterEach(() => vi.unstubAllEnvs())

it('allows a clean source with no Brain store, without creating profile files or workers', async () => {
  const { localLanes } = await import('./local')
  expect(await localLanes.inspect(file, false)).toHaveProperty('facts.sessionId', nativeId)
  const archive = join(home, 'clean.bundle')
  await localLanes.export(file, false, archive)
  const { openArchive } = await import('@phosphor/session-runtime/lane-transfer/archive')
  expect((await openArchive(archive)).manifest.source.sessionId).toBe(nativeId)
  expect(await readFile(file, 'utf8')).toBe(original)
  expect(state.openStore).not.toHaveBeenCalled()
  expect(state.embeddings).not.toHaveBeenCalled()
  await expect(readFile(join(state.profile, 'brain/memory.sqlite'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  const { stat } = await import('node:fs/promises')
  await expect(stat(state.profile)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('allows a clean source with an existing disabled Brain store and preserves ordinary Move', async () => {
  database().close()
  const { localLanes } = await import('./local')
  expect(await localLanes.inspect(file, false)).toHaveProperty('facts.sessionId', nativeId)
  const archive = join(home, 'clean-existing.bundle')
  await localLanes.export(file, false, archive)
  const target = join(home, 'target')
  await mkdir(target)
  const { installLane } = await import('@phosphor/session-runtime/lane-transfer/install')
  const { openArchive } = await import('@phosphor/session-runtime/lane-transfer/archive')
  const { sessionTaken } = await import('@phosphor/session-runtime/lane-transfer/move')
  const paths = { home: state.profile, env: process.env }
  const installed = await installLane({
    archive: await openArchive(archive),
    plan: { mode: 'folder', branch: null, workspace: 'target', blockers: [] },
    cwd: target,
    paths,
    labels: { from: 'This Mac', to: 'This Mac' },
    attachmentsDir: null,
    sessionTaken: sessionTaken(paths),
  })
  expect(installed.sessionId).not.toBe(nativeId)
  const copied = await readFile(installed.sessionFile, 'utf8')
  expect(copied).toContain('Synthetic input')
  expect(copied).toContain('phosphor-lane-moved')
  expect(await readFile(file, 'utf8')).toBe(original)
  expect(state.requests.filter((request) => request.method === 'excludedSource')).toHaveLength(2)
})

it('rechecks new delivery under the export path lock after a successful inspection', async () => {
  database().close()
  const { localLanes } = await import('./local')
  expect(await localLanes.inspect(file, false)).toHaveProperty('facts')
  const { withSessionPath } = await import('../pi/session-path-lock')
  const { deferred } = await import('@phosphor/brain-runtime/__fixtures__/adapter-fixture')
  const release = deferred<void>()
  const entered = deferred<void>()
  const held = withSessionPath(file, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const archive = join(home, 'new-recipient.bundle')
  const queued = deferred<void>()
  lockObservation.queued = () => queued.resolve()
  const exporting = expect(localLanes.export(file, false, archive)).rejects.toThrow(
    /Brain.*recipient/i,
  )
  await queued.promise
  try {
    const engine = database()
    engine.recordDelivery({ sessionId: nativeId, evidenceIds: [], claimIds: [] })
    engine.close()
    expect(state.requests.filter((request) => request.method === 'excludedSource')).toHaveLength(1)
  } finally {
    release.resolve()
  }
  await held
  await exporting
  await expect(readFile(archive)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(file, 'utf8')).toBe(original)
  expect(state.requests.filter((request) => request.method === 'excludedSource')).toHaveLength(2)
})

it('rereads actual header identity at locked export instead of trusting inspection', async () => {
  const { localLanes } = await import('./local')
  expect(await localLanes.inspect(file, false)).toHaveProperty('facts')
  const { withSessionPath } = await import('../pi/session-path-lock')
  const { deferred } = await import('@phosphor/brain-runtime/__fixtures__/adapter-fixture')
  const release = deferred<void>()
  const held = withSessionPath(file, () => release.promise)
  const archive = join(home, 'changed-header.bundle')
  const queued = deferred<void>()
  lockObservation.queued = () => queued.resolve()
  const exporting = expect(localLanes.export(file, false, archive)).rejects.toThrow(
    /format.*cannot move/,
  )
  await queued.promise
  try {
    await writeFile(file, original.replace(nativeId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'))
  } finally {
    release.resolve()
  }
  await held
  await exporting
  await expect(readFile(archive)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(state.openStore).not.toHaveBeenCalled()
})

it('visibly refuses worker authority errors during inspection and before archive writes', async () => {
  database().close()
  const { localLanes } = await import('./local')
  expect(await localLanes.inspect(file, false)).toHaveProperty('facts')
  state.authorityError = 'Synthetic worker unavailable'
  expect(await localLanes.inspect(file, false)).toEqual({
    blockers: [expect.stringMatching(/Brain exclusion could not be checked/)],
  })
  const archive = join(home, 'authority-error.bundle')
  await expect(localLanes.export(file, false, archive)).rejects.toThrow(
    /Brain exclusion could not be checked/,
  )
  await expect(readFile(archive)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(file, 'utf8')).toBe(original)
  expect(state.openStore).toHaveBeenCalledOnce()
})

it('does not mistake failure to open an existing authority for a fresh profile', async () => {
  database().close()
  state.openStore.mockImplementation(() => {
    throw new Error('Synthetic database unavailable')
  })
  const { localLanes } = await import('./local')
  expect(await localLanes.inspect(file, true)).toEqual({
    blockers: [expect.stringMatching(/Brain exclusion could not be checked/)],
  })
  const archive = join(home, 'open-error.bundle')
  await expect(localLanes.export(file, true, archive)).rejects.toThrow(
    /Brain exclusion could not be checked/,
  )
  await expect(readFile(archive)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(file, 'utf8')).toBe(original)
})

it('refuses invalid source header IDs before consulting Brain', async () => {
  await writeFile(file, original.replace(nativeId, 'not-a-native-uuid'))
  const { localLanes } = await import('./local')
  expect(await localLanes.inspect(file, false)).toEqual({
    blockers: [expect.stringMatching(/format.*cannot move/)],
  })
  expect(state.openStore).not.toHaveBeenCalled()
})
