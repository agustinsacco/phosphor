/**
 * The daemon's artifact library (reconcile-v2 #4): `artifact.list` lists every
 * artifact in `<state>/artifacts`, a deleted conversation's too, in the shape
 * M5c's `ownerLibrary` parses; `artifact.read` takes both key forms.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  ownerLibrary,
  ownerVersion,
  type OwnerArtifactOp,
} from '@phosphor/host-client/owner-artifacts'
import { ArtifactLibrary } from '@phosphor/session-runtime/artifacts/artifact-library'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type { OpRunContext } from '@phosphor/session-runtime/ops/ports'
import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import { ARTIFACT_LIMITS, parseArtifactList } from '@phosphor/shared/host-protocol-artifacts'
import { utf8Length } from '@phosphor/shared/host-protocol'
import { createArtifactsFeature } from '../../features/artifacts'
import { openStore, type HostStore } from '../../lanes/store'
import { artifactImporter } from '../../owner/import/artifacts'
import { artifactHandlers } from './artifacts'
import type { DaemonHandlerDeps } from './index'

const uid = process.getuid?.()
let root: string, state: string, store: HostStore, repositoryId: string
let deps: DaemonHandlerDeps
let log: ReturnType<typeof vi.fn>
let feature: ReturnType<typeof createArtifactsFeature>
/** Built once, as `domainHandlers` builds them for the daemon. */
let handlers: Readonly<Record<string, OpHandler>>

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'p4c-artifact-library-')))
  state = join(root, 'xdg', 'phosphor-host')
  store = await openStore(state, uid)
  mkdirSync(join(root, 'repo'))
  repositoryId = store.syncRepositories([join(root, 'repo')])[0]!.id
  feature = createArtifactsFeature({
    store,
    env: { XDG_STATE_HOME: join(root, 'xdg') },
    home: root,
    log: () => {},
  })
  log = vi.fn()
  deps = {
    store,
    stateDirectory: state,
    selfIds: () => [],
    log,
    lanes: {
      calls: {
        capabilityFor: (m: string) => (feature.methods.includes(m) ? feature.capability : null),
        call: (m: string, p: unknown) => feature.call(m, p),
      },
    },
  } as unknown as DaemonHandlerDeps
  handlers = artifactHandlers(deps)
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** pi 1.5 names sessions with uuidv7. */
const v7 = () => {
  const id = randomUUID()
  return `${id.slice(0, 14)}7${id.slice(15)}`
}
const desktop = () => join(root, 'userData', 'artifacts')

/** A pi session that saved one artifact, indexed by Desktop's library. */
async function desktopSession(slug: string, at: string, content = `# ${slug}`) {
  const sessionId = v7()
  const dir = join(root, 'sessions', '--repo--')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`)
  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: at, cwd: join(root, 'repo') },
    {
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: at,
      message: {
        role: 'toolResult',
        toolName: 'artifact_create',
        toolCallId: `call-${slug}`,
        details: { id: slug, title: slug, type: 'markdown', content, version: 1 },
      },
    },
  ]
  writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''))
  await new ArtifactLibrary(desktop).indexFile(file)
  return { file, sessionId }
}

/** Desktop's library marks a gone session's artifacts deleted. */
async function deleteSession(file: string) {
  rmSync(file)
  await new ArtifactLibrary(desktop).indexFile(file)
}

const importDesktopLibrary = () =>
  artifactImporter({
    stateDirectory: state,
    configPath: join(root, 'config.json'),
    uid,
    sessionsRoot: join(root, 'sessions'),
    log: () => {},
  }).apply(
    { section: 'artifacts', sourceDir: desktop() },
    { migrationId: randomUUID(), merge: false, store },
  )

const lane = (file: string) =>
  store.ensureLane({ repositoryId, cwd: join(root, 'repo'), sessionFile: file })

function context(page?: string, principal: object = { kind: 'local', clientId: 'owner' }) {
  return {
    principal,
    signal: new AbortController().signal,
    log: () => {},
    ...(page ? { page } : {}),
  } as unknown as OpRunContext
}
const run: OwnerArtifactOp = async (req) => {
  const result = await handlers[req.op]!(req.args, context(req.page))
  return { status: 'ok', applies: 'now', ...result } as Awaited<ReturnType<OwnerArtifactOp>>
}

it('lists and reads a live lane’s and deleted conversations’ imported artifacts, as ownerLibrary parses them', async () => {
  const live = await desktopSession('live', '2026-01-01T00:00:01.000Z', 'live body')
  const removed = await desktopSession('removed', '2026-01-01T00:00:02.000Z', 'removed body')
  const gone = await desktopSession('gone', '2026-01-01T00:00:03.000Z', 'gone body')
  await deleteSession(removed.file)
  await deleteSession(gone.file)
  await importDesktopLibrary()
  const liveLane = lane(live.file)
  const removedLane = lane(removed.file)
  store.markRemoved(removedLane.laneId)

  const rows = await ownerLibrary(run)
  expect(rows.map((r) => [r.laneId, r.slug, r.sessionDeleted])).toEqual([
    [liveLane.laneId, 'live', undefined],
    [gone.sessionId, 'gone', true],
    [removed.sessionId, 'removed', true],
  ])
  const contents = await Promise.all(
    rows.map(async (r) => (await ownerVersion(run, r, r.versions[0]!)).content),
  )
  expect(contents).toEqual(['live body', 'gone body', 'removed body'])

  // A removed lane's id names its conversation too, as artifact.remove takes it.
  const byLane = await artifactHandlers(deps)['artifact.read']!(
    { key: `${removedLane.laneId}/removed` },
    context(),
  )
  expect(byLane.data).toMatchObject({
    key: `${removedLane.laneId}/removed`,
    content: 'removed body',
  })
  // A live lane's session id names that lane.
  const bySession = await artifactHandlers(deps)['artifact.read']!(
    { key: `${live.sessionId}/live` },
    context(),
  )
  expect(bySession.data).toMatchObject({ content: 'live body' })
})

it('never puts a deleted conversation on the wire artifacts.list frame or in one lane’s list', async () => {
  const live = await desktopSession('live', '2026-01-01T00:00:01.000Z')
  const gone = await desktopSession('gone', '2026-01-01T00:00:02.000Z')
  await deleteSession(gone.file)
  await importDesktopLibrary()
  const liveLane = lane(live.file)
  const wire = await feature.call('artifacts.list', {})
  expect(wire).toMatchObject({ ok: true, data: [{ laneId: liveLane.laneId, slug: 'live' }] })
  expect((wire as { data: unknown[] }).data).toHaveLength(1)
  expect(parseArtifactList((wire as { data: unknown }).data)).not.toBeNull()

  const laneContext = {
    ...context(),
    lane: { ref: liveLane.laneId },
  } as unknown as OpRunContext
  deps = { ...deps, selfIds: () => [liveLane.laneId] } as DaemonHandlerDeps
  const handlers = artifactHandlers(deps)
  const own = await handlers['artifact.list']!({ lane: 'self' }, laneContext)
  expect(own.data).toEqual([expect.objectContaining({ key: `${liveLane.laneId}/live` })])
  await expect(
    handlers['artifact.read']!({ key: `${gone.sessionId}/gone`, lane: 'self' }, laneContext),
  ).rejects.toBeInstanceOf(OpRefusal)
})

it('refuses a deleted conversation’s artifact to a connection without the artifacts capability', async () => {
  const gone = await desktopSession('gone', '2026-01-01T00:00:02.000Z')
  await deleteSession(gone.file)
  await importDesktopLibrary()
  const surface = { kind: 'surface', clientId: 'c', label: 'Phone', caps: [] }
  const handlers = artifactHandlers(deps)
  await expect(handlers['artifact.list']!({}, context(undefined, surface))).rejects.toEqual(
    new OpRefusal('forbidden', 'This connection cannot call artifacts.list.'),
  )
  await expect(
    handlers['artifact.read']!({ key: `${gone.sessionId}/gone` }, context(undefined, surface)),
  ).rejects.toEqual(new OpRefusal('forbidden', 'This connection cannot call artifacts.read.'))
})

/** An index the store wrote for a gone session, straight to disk. */
function storedIndex(
  sessionId: string,
  artifacts: { slug: string; at: number; versions?: number }[],
) {
  const dir = join(state, 'artifacts', 'sessions')
  mkdirSync(dir, { recursive: true })
  const index = {
    format: 1,
    sessionId,
    sessionFile: join(root, 'gone', `x_${sessionId}.jsonl`),
    cwd: join(root, 'repo'),
    deleted: true,
    scan: { offset: 0, size: 0, mtimeMs: 0, signature: '', leafId: null },
    artifacts: Object.fromEntries(
      artifacts.map(({ slug, at, versions = 1 }) => [
        slug,
        {
          slug,
          title: slug,
          type: 'markdown',
          versions: Array.from({ length: versions }, (_, i) => ({
            version: i + 1,
            toolCallId: `${slug}-${i}`,
            entryId: `${slug}-${i}`,
            sha256: '0'.repeat(64),
            bytes: 1,
            createdAt: new Date(at + i).toISOString(),
            title: versions > 1 ? 'x'.repeat(1000) : slug,
            onBranch: true,
          })),
        },
      ]),
    ),
  }
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(index))
}

it('drops and logs once a deleted conversation’s row the shared parser rejects', async () => {
  const live = await desktopSession('live', '2026-01-01T00:00:01.000Z')
  await importDesktopLibrary()
  lane(live.file)
  const good = v7()
  storedIndex(good, [
    { slug: 'kept', at: 1 },
    { slug: 'Not_A_Slug', at: 2 },
  ])
  storedIndex('legacy-session-0001', [{ slug: 'legacy', at: 3 }])
  const rows = await ownerLibrary(run)
  expect(rows.map((r) => r.slug)).toEqual(['live', 'kept'])
  await ownerLibrary(run)
  expect(log).toHaveBeenCalledTimes(1)
  expect(log).toHaveBeenCalledWith('artifacts', 'library rows dropped', { invalid: 2, overCaps: 0 })
})

it('keeps live rows first and the newest deleted rows within 2000 rows, dropping the oldest', async () => {
  const live = await desktopSession('live', '2026-01-01T00:00:01.000Z')
  await importDesktopLibrary()
  lane(live.file)
  for (let s = 0; s < 21; s++)
    storedIndex(
      v7(),
      Array.from({ length: 100 }, (_, i) => ({ slug: `a-${s}-${i}`, at: (s * 100 + i) * 1000 })),
    )
  const rows = await ownerLibrary(run)
  expect(rows).toHaveLength(ARTIFACT_LIMITS.count)
  expect(rows[0]).toMatchObject({ slug: 'live' })
  expect(rows[1]).toMatchObject({ slug: 'a-20-99', sessionDeleted: true })
  expect(rows.at(-1)).toMatchObject({ slug: 'a-1-1' })
  expect(log).toHaveBeenCalledWith('artifacts', 'library rows dropped', {
    invalid: 0,
    overCaps: 101,
  })
})

it('keeps deleted rows within 4 MiB of metadata, newest first, and drops one past a page', async () => {
  const live = await desktopSession('live', '2026-01-01T00:00:01.000Z')
  await importDesktopLibrary()
  lane(live.file)
  for (let s = 0; s < 6; s++)
    storedIndex(v7(), [{ slug: `big-${s}`, at: s * 1_000_000, versions: 900 }])
  storedIndex(v7(), [{ slug: 'too-big-for-a-page', at: 9e9, versions: 1000 }])
  const rows = await ownerLibrary(run)
  const bytes = rows.reduce((sum, r) => sum + utf8Length(JSON.stringify(r)), 0)
  expect(bytes).toBeLessThanOrEqual(ARTIFACT_LIMITS.metadataBytes)
  expect(rows.map((r) => r.slug)).toEqual(['live', 'big-5', 'big-4', 'big-3', 'big-2'])
  expect(log).toHaveBeenCalledWith('artifacts', 'library rows dropped', {
    invalid: 1,
    overCaps: 2,
  })
}, 20_000)
