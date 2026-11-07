import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { openStore, type HostStore } from '../lanes/store'
import { hostStateDirectory } from '../lanes/state-dir'
import type { FeatureContext, HostFeature } from './feature'
import { createLaneTransferFeatures } from './lane-transfer'

const SESSION = '01a1b11c-7705-7534-964e-c100db3101ce'
const stores: HostStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

/** One Host: its own home, state, store and a plain folder configured as a repository. */
async function host(name: string, running = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `transfer-${name}-`)))
  const env: NodeJS.ProcessEnv = {}
  const state = hostStateDirectory(env, home)
  mkdirSync(state, { recursive: true, mode: 0o700 })
  const store = await openStore(state, process.getuid?.())
  stores.push(store)
  const root = join(home, 'notes')
  mkdirSync(root)
  store.syncRepositories([root])
  const announced: string[] = []
  const context: FeatureContext = { store, env, home, log: () => {} }
  const [exporter, importer] = createLaneTransferFeatures(context, store, {
    sessionFor: () => (running ? 'live' : null),
    announce: (laneId) => announced.push(laneId),
  }) as [HostFeature, HostFeature]
  const call = async (feature: HostFeature, method: string, params: unknown) => {
    const result = await feature.call(method, params, () => true)
    if (!result.ok) throw new Error(result.error.code)
    return result.data as Record<string, unknown>
  }
  const settle = async (feature: HostFeature, method: string, params: unknown) => {
    for (;;) {
      const status = await call(feature, method, params)
      if (status.state !== 'running') return status
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  return { home, root: realpathSync(root), store, announced, exporter, importer, call, settle }
}

function admitLane(h: Awaited<ReturnType<typeof host>>) {
  const dir = sessionDirForCwd(h.root, join(h.home, '.pi', 'agent', 'sessions'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `2026-11-06T13-46-35-141Z_${SESSION}.jsonl`)
  const lines = [
    { type: 'session', version: 3, id: SESSION, cwd: h.root },
    { type: 'session_info', id: 'a1', parentId: null, name: 'Sort The Notes' },
  ]
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const repositoryId = h.store.listRepositories()[0]!.id
  return h.store.ensureLane({ repositoryId, cwd: h.root, sessionFile: file, worktree: false })
    .laneId
}

describe('moving a lane between two Hosts', () => {
  it('exports a stopped lane and admits it as a lane of the target repository', async () => {
    const a = await host('a')
    const b = await host('b')
    const laneId = admitLane(a)
    const inspected = await a.call(a.exporter, 'laneTransfer.inspect', { laneId })
    expect(inspected.facts).toMatchObject({
      sessionId: SESSION,
      title: 'Sort The Notes',
      git: null,
    })

    const repositoryId = b.store.listRepositories()[0]!.id
    const plan = await b.call(b.importer, 'laneTransfer.check', {
      repositoryId,
      source: inspected.facts,
      branchPrefix: 'phosphor/',
      sameMachine: false,
    })
    expect(plan).toEqual({ mode: 'folder', branch: null, workspace: 'notes', blockers: [] })

    const { exportId } = await a.call(a.exporter, 'laneTransfer.export', { laneId })
    const exported = await a.settle(a.exporter, 'laneTransfer.exportStatus', { exportId })
    const { size, sha256 } = exported.value as { size: number; sha256: string }
    const { importId } = await b.call(b.importer, 'laneTransfer.begin', {
      repositoryId,
      size,
      sha256,
      branchPrefix: 'phosphor/',
      sameMachine: false,
      notice: { from: 'bee1', to: 'bee2' },
      marks: { pinned: true, marker: '🚀' },
    })
    for (let offset = 0; offset < size;) {
      const { data } = await a.call(a.exporter, 'laneTransfer.read', { exportId, offset })
      await b.call(b.importer, 'laneTransfer.chunk', { importId, offset, data })
      offset += Buffer.from(data as string, 'base64').length
    }
    await b.call(b.importer, 'laneTransfer.commit', { importId })
    const imported = await b.settle(b.importer, 'laneTransfer.importStatus', { importId })
    const newLane = (imported.value as { laneId: string }).laneId
    const lane = b.store.getLane(newLane)!
    expect(lane).toMatchObject({ cwd: b.root, title: 'Sort The Notes', pinned: true, marker: '🚀' })
    expect(b.announced).toEqual([newLane])
    const header = JSON.parse(readFileSync(lane.sessionFile!, 'utf8').split('\n')[0]!) as object
    expect(header).toMatchObject({ id: SESSION, cwd: b.root })
    // The source lane is untouched.
    expect(a.store.getLane(laneId)?.removedAt).toBeNull()
  })

  it('refuses names the Host cannot preserve rather than silently shortening them', async () => {
    const a = await host('long-name')
    const b = await host('long-target')
    const laneId = admitLane(a)
    const path = a.store.getLane(laneId)!.sessionFile!
    const text = readFileSync(path, 'utf8').replace('Sort The Notes', 'x'.repeat(81))
    writeFileSync(path, text)
    const { facts } = await a.call(a.exporter, 'laneTransfer.inspect', { laneId })
    const plan = await b.call(b.importer, 'laneTransfer.check', {
      repositoryId: b.store.listRepositories()[0]!.id,
      source: facts,
      branchPrefix: '',
      sameMachine: false,
    })
    expect(plan.blockers).toContain('This Host cannot preserve a lane name longer than 80 characters.')
  })

  it('refuses a running lane and a bundle that does not match its hash', async () => {
    const running = await host('running', true)
    expect(
      await running.call(running.exporter, 'laneTransfer.inspect', { laneId: admitLane(running) }),
    ).toEqual({
      blockers: ['Stop this lane before moving it. Its saved transcript is what moves.'],
    })
    const b = await host('mismatch')
    const repositoryId = b.store.listRepositories()[0]!.id
    const { importId } = await b.call(b.importer, 'laneTransfer.begin', {
      repositoryId,
      size: 4,
      sha256: '0'.repeat(64),
      branchPrefix: '',
      sameMachine: false,
      notice: { from: 'a', to: 'b' },
      marks: { pinned: false, marker: null },
    })
    await b.call(b.importer, 'laneTransfer.chunk', { importId, offset: 0, data: 'AAAAAA==' })
    await b.call(b.importer, 'laneTransfer.commit', { importId })
    expect(await b.settle(b.importer, 'laneTransfer.importStatus', { importId })).toEqual({
      blockers: ['The lane bundle is damaged.'],
    })
    expect(b.store.listLanes()).toEqual([])
  })
})
