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
    expect(inspection.blockers).toEqual([expect.stringMatching(/Brain.*recipient/i)])
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
