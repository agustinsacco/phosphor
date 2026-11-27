import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { answerFor } from '@phosphor/brain-runtime/__fixtures__/pipeline'
import { LANE_ENTRIES } from '@phosphor/brain-runtime/__fixtures__/lane'
import type { BrainEmbeddings } from '@phosphor/brain-runtime/embedding/embedding-port'
import type { ModelCallInput } from '@phosphor/brain-runtime/model-call'
import { inProcessSearch } from '@phosphor/brain-runtime/search/in-process'
import { openBrainSearch } from '@phosphor/memory-engine/search'
import { DEFAULT_BRAIN_PREFS } from '@phosphor/shared/brain'
import { BRAIN_APPROVAL, BRAIN_SURFACE } from '@phosphor/shared/host-brain'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { bindBrainLink } from '../api/__fixtures__/brain-link'
import { createAdapterChain, type FrameLinkFactory } from '../api/adapter'
import type { BrainSurfaceBinding } from '../api/brain-adapter'
import { hostLinks } from '../api/server'
import type { HostBrainAdmission } from '../brain-handover/gate'
import { acquireInstallLock } from '@phosphor/session-runtime/host-install/lock'
import { selectLocalBrainOwner } from '@phosphor/session-runtime/brain/local-owner'
import { pinBrainCompatibility } from '../update/brain-compatibility'
import { syntheticBrainBundle } from '../update/__fixtures__/brain-package'
import { fixture } from '../update/__fixtures__/release'
import * as packagedRuntime from './packaged-runtime'
import { openStore } from '../lanes/store'
import { createRunBrain, HOST_BRAIN_OFF_GENERATION, qualifiedRunBrain } from './run'

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function readyEmbeddings(): BrainEmbeddings {
  return {
    status: () => ({
      phase: 'ready',
      receivedBytes: 0,
      totalBytes: 0,
      modelId: 'fake',
      dimensions: 768,
    }),
    setEnabled: async () => {},
    download: async () => {},
    remove: async () => {},
    embed: async (texts) => texts.map(() => [1, ...Array<number>(767).fill(0)]),
    dispose() {},
  }
}

/** A Host with one ordinary lane in Harbor, its transcript saved by pi, and no Desktop. */
async function host(
  overrides: {
    admission?: () => HostBrainAdmission
    local?: boolean
    beforeOpen?: () => void
    state?: string
  } = {},
) {
  const state = overrides.state ?? (await mkdtemp(join(tmpdir(), 'harbor-run-brain-')))
  mkdirSync(state, { recursive: true, mode: 0o700 })
  cleanups.push(() => rm(state, { recursive: true, force: true }))
  const store = await openStore(state, process.getuid?.(), {})
  cleanups.push(() => store.close())
  const repo = join(state, 'Harbor')
  const sessions = join(state, 'sessions')
  mkdirSync(repo)
  mkdirSync(sessions)
  const piId = randomUUID()
  const file = join(sessions, 'harbor.jsonl')
  const entries = LANE_ENTRIES.map((e) =>
    e.type === 'session' ? { ...e, id: piId, cwd: repo } : e,
  )
  await writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n'))
  const repositoryId = store.syncRepositories([repo])[0]!.id
  const lane = store.ensureLane({ repositoryId, cwd: repo, sessionFile: file, title: 'Harbor' })
  const reader = vi.fn(async (input: ModelCallInput) => ({
    text: answerFor(input),
    usage: { tokens: 10, cost: 0 },
  }))
  const run = createRunBrain({
    stateDirectory: state,
    resourceRoot: '/res',
    pi: { binaryPath: '/not-a-provider', prefixArgs: [] },
    env: {},
    busy: () => false,
    log: vi.fn(),
    packaged: { searchWorker: '/none/search.js', embeddingWorker: '/none/embedding.js' },
    store,
    sessionsRoot: sessions,
    ...(overrides.local ? { local: true } : {}),
    ...(overrides.beforeOpen ? { beforeOpen: overrides.beforeOpen } : {}),
    ...(overrides.admission ? { admission: overrides.admission } : {}),
    embeddings: () => readyEmbeddings(),
    openSearch: inProcessSearch((path) => openBrainSearch({ path, Database: DatabaseSync })),
    runModelCall: reader,
  })
  cleanups.push(() => run.brain.dispose())
  return { state, store, lane, piId, run, reader, link: listener(run.surface) }
}

/** The frame chain both listeners build (`hostLinks`): owner, Brain, machine guard, ops. */
const listener = (brain?: BrainSurfaceBinding) =>
  createAdapterChain(hostLinks(undefined, undefined, brain), undefined) as FrameLinkFactory

const offExpected = { generation: HOST_BRAIN_OFF_GENERATION, revision: 0 }
const enable = {
  method: 'brain:setPrefs',
  args: [{ ...DEFAULT_BRAIN_PREFS, enabled: true }],
  expected: offExpected,
}

/** The local CLI's one-use approval: ask, the owner approves on its surface, confirm once. */
async function approved(
  cli: ReturnType<typeof bindBrainLink>,
  owner: ReturnType<typeof bindBrainLink>,
  args: Record<string, unknown>,
  write: boolean,
) {
  const ask = await cli.run(BRAIN_SURFACE, args, write)
  if (ask.status !== 'confirm') throw new Error(`expected approval, got ${ask.status}`)
  expect(
    await owner.run(BRAIN_APPROVAL, { action: 'answer', id: ask.confirmId, approved: true }, true),
  ).toMatchObject({ status: 'ok' })
  const confirm = { confirmId: ask.confirmId, digest: ask.digest }
  const result = await cli.run(BRAIN_SURFACE, args, write, { confirm })
  return { result, again: () => cli.run(BRAIN_SURFACE, args, write, { confirm }) }
}

const refusal = (result: OpsRunResult) =>
  result.status === 'ok'
    ? (result.data as { brainRefusal?: string } | null)?.brainRefusal
    : result.status

it('serves no Brain from a bundle that is not qualified, and the listener says unsupported', async () => {
  const state = await mkdtemp(join(tmpdir(), 'harbor-unqualified-'))
  cleanups.push(() => rm(state, { recursive: true, force: true }))
  const built = qualifiedRunBrain(state, {} as never)
  expect(built).toBeUndefined()
  const owner = bindBrainLink('owner', listener(), ['read'])
  expect(await owner.run(BRAIN_SURFACE, { method: 'brain:status', args: [] })).toMatchObject({
    status: 'denied',
    code: 'unsupported',
  })
  expect(existsSync(join(state, 'brain'))).toBe(false)
})

it('shows a fresh Host off to its signed owner, creates nothing, and enables once from the local CLI', async () => {
  const h = await host()
  expect(h.run.surface).toBeDefined()
  const owner = bindBrainLink('owner', h.link, ['read', 'configure', 'control'])
  const status = await owner.run(BRAIN_SURFACE, { method: 'brain:status', args: [] })
  expect(status).toMatchObject({
    status: 'ok',
    data: { generation: HOST_BRAIN_OFF_GENERATION, revision: 0, prefs: { enabled: false } },
  })
  expect(await owner.run(BRAIN_SURFACE, { method: 'brain:prefs', args: [] })).toMatchObject({
    status: 'ok',
    data: { enabled: false },
  })
  expect(refusal(await owner.run(BRAIN_SURFACE, { method: 'brain:ask', args: ['Harbor'] }))).toBe(
    'disabled',
  )
  expect(existsSync(h.run.brain.directory)).toBe(false)

  const cli = bindBrainLink('local', h.link)
  const once = await approved(cli, owner, enable, true)
  expect(once.result).toMatchObject({ status: 'ok', data: { prefs: { enabled: true } } })
  expect(existsSync(join(h.run.brain.directory, 'brain.sqlite'))).toBe(true)
  // The approval is spent: the same confirmation does not run a second write.
  expect(await once.again()).toMatchObject({ status: 'denied' })
})

it('refuses to create a Brain while ownership is ambiguous, and serves nothing during a move', async () => {
  let moving = false
  const move = await host({
    admission: () =>
      moving ? { state: 'handover', migrationId: randomUUID() } : { state: 'open' },
  })
  const mover = bindBrainLink('owner', move.link, ['read', 'configure'])
  moving = true
  expect(refusal(await mover.run(BRAIN_SURFACE, enable, true))).toBe('unavailable')
  moving = false
  expect(await mover.run(BRAIN_SURFACE, enable, true)).toMatchObject({
    status: 'ok',
    data: { prefs: { enabled: true } },
  })
  moving = true
  expect(refusal(await mover.run(BRAIN_SURFACE, { method: 'brain:status', args: [] }))).toBe(
    'unavailable',
  )
})

it('reads a Host lane by its Host lane ID with no Desktop, then stops answering once disposed', async () => {
  const h = await host()
  const owner = bindBrainLink('owner', h.link, ['read', 'configure', 'control'])
  expect(await owner.run(BRAIN_SURFACE, enable, true)).toMatchObject({
    status: 'ok',
    data: { prefs: { enabled: true } },
  })
  const live = await owner.run(BRAIN_SURFACE, { method: 'brain:status', args: [] })
  const { generation, revision } = (live as { data: { generation: string; revision: number } }).data
  const queued = await owner.run(
    BRAIN_SURFACE,
    { method: 'brain:queue', args: [h.lane.laneId], expected: { generation, revision } },
    true,
  )
  expect(queued).toMatchObject({ status: 'ok' })
  expect(refusal(queued)).toBeUndefined()
  await vi.waitFor(
    async () =>
      expect(
        await owner.run(BRAIN_SURFACE, { method: 'brain:laneState', args: [h.lane.laneId] }),
      ).toMatchObject({ status: 'ok', data: { lastRead: { memories: expect.any(Number) } } }),
    { timeout: 20_000 },
  )
  expect(h.reader).toHaveBeenCalled()
  // A lane ID the Host does not list resolves to nothing.
  expect(
    refusal(await owner.run(BRAIN_SURFACE, { method: 'brain:laneState', args: [randomUUID()] })),
  ).toBe('not-found')
  await h.run.brain.dispose()
  expect(refusal(await owner.run(BRAIN_SURFACE, { method: 'brain:status', args: [] }))).toBe(
    'unavailable',
  )
}, 60_000)

it('does not open or create a local service Brain before first owner selection, even with no legacy registration', async () => {
  const h = await host({ local: true })
  const owner = bindBrainLink('owner', h.link, ['read', 'configure'])
  expect(refusal(await owner.run(BRAIN_SURFACE, enable, true))).toBe('unavailable')
  await expect(h.run.brain.open()).rejects.toThrow()
  expect(existsSync(h.run.brain.directory)).toBe(false)
})

it('allows only the durable native owner to open or enable', async () => {
  const legacy = await host({ local: true })
  selectLocalBrainOwner(legacy.state, 'desktop')
  await expect(legacy.run.brain.open()).rejects.toThrow()
  expect(existsSync(legacy.run.brain.directory)).toBe(false)
  const native = await host({ local: true })
  expect(selectLocalBrainOwner(native.state, 'host')).toBe(true)
  expect(native.run.brain.state()).toBe('off')
  const owner = bindBrainLink('owner', native.link, ['read', 'configure'])
  expect(await owner.run(BRAIN_SURFACE, enable, true)).toMatchObject({
    status: 'ok',
    data: { prefs: { enabled: true } },
  })
  expect(selectLocalBrainOwner(native.state, 'desktop')).toBe(false)
  expect(existsSync(join(native.run.brain.directory, 'brain.sqlite'))).toBe(true)
})

it.each(['enable', 'open', 'service'] as const)(
  'pins the selected release before standalone %s even with a custom state root',
  async (entry) => {
    const f = fixture()
    cleanups.push(f.cleanup)
    syntheticBrainBundle(f.old)
    const resolve = packagedRuntime.resolvePackagedBrainRuntime
    const qualification = vi
      .spyOn(packagedRuntime, 'resolvePackagedBrainRuntime')
      .mockImplementation((root) =>
        resolve(root, {
          platform: 'darwin',
          arch: 'arm64',
          version: packagedRuntime.packagedNodeVersion,
        }),
      )
    cleanups.push(() => {
      qualification.mockRestore()
    })
    const pin = join(f.lib, '.brain-required')
    const beforeOpen = () =>
      pinBrainCompatibility({ home: f.home, uid: f.context.uid, ...f.context.update })
    const h = await host({ state: join(f.home, 'Kestrel', 'phosphor-host'), beforeOpen })
    expect(h.run.brain.state()).toBe('off')
    expect(existsSync(pin)).toBe(false)
    if (entry === 'service') {
      const legacy = await host()
      await legacy.run.brain.open()
      await legacy.run.brain.dispose()
      // Move a synthetic existing Brain into the custom root without writing an install pin.
      cpSync(legacy.run.brain.directory, h.run.brain.directory, { recursive: true })
    }
    const unlock = acquireInstallLock(f.lib)
    try {
      await expect(h.run.brain[entry]()).rejects.toThrow('Install lock:')
      expect(existsSync(pin)).toBe(false)
      expect(existsSync(h.run.brain.directory)).toBe(entry === 'service')
    } finally {
      unlock()
    }
    expect(await h.run.brain[entry]()).toBeDefined()
    expect(readFileSync(pin, 'utf8')).toBe('1\n')
  },
)
