import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LANE_TRANSFER_LIMITS } from '@shared/host-protocol-lane-transfer'
import type { LaneMoveRequest } from '@shared/lane-move'
import { createLaneMoves } from './move'
import { LANE_MOVE_ERRORS } from './remote'

// Host-to-Host moves never reach This Mac's side; its git and pi bindings stay out of the test.
vi.mock('./local', () => ({ localLanes: {} }))

/*
 * Desktop's Host-to-Host "Move to…" through its public entry: what the plan
 * asks each Host, the calls and parameters of one move, and how a refusal, a
 * damaged bundle, an oversized bundle, a lost connection and a second move end.
 */

const exportId = 'e'.repeat(32)
const importId = 'f'.repeat(32)
const laneId = '11111111-2222-4333-8444-555555555555'
const newLaneId = '66666666-7777-4888-9999-000000000000'
const repositoryId = 'a'.repeat(16)
const facts = {
  sessionId: '01a0272a-7be5-46ed-b420-36b363924622',
  title: 'Research',
  workspace: 'app',
  cwd: '/work/app',
  git: null,
  bytes: 20,
  transcriptBytes: 20,
}
const plan = { mode: 'folder', branch: null, workspace: 'notes', blockers: [] }

const roots: string[] = []
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})

type Call = { method: string; params: Record<string, unknown> }

/** A ready Host that answers every transfer call; `answers` and `call` can be edited per test. */
function fakeHost(bytes: Uint8Array) {
  let generation = 1
  const calls: Call[] = []
  const received: Buffer[] = []
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const answers: Record<string, (params: Record<string, unknown>) => unknown> = {
    'laneTransfer.inspect': () => ({ facts }),
    'laneTransfer.check': () => plan,
    'laneTransfer.export': () => ({ exportId }),
    'laneTransfer.exportStatus': () => ({
      state: 'done',
      value: { size: bytes.length, sha256 },
    }),
    'laneTransfer.read': ({ offset }) => ({
      data: Buffer.from(
        bytes.subarray(offset as number, (offset as number) + LANE_TRANSFER_LIMITS.chunkBytes),
      ).toString('base64'),
    }),
    'laneTransfer.release': () => ({}),
    'laneTransfer.begin': () => ({ importId }),
    'laneTransfer.chunk': ({ data }) => {
      received.push(Buffer.from(data as string, 'base64'))
      return {}
    },
    'laneTransfer.commit': () => ({}),
    'laneTransfer.importStatus': () => ({ state: 'done', value: { laneId: newLaneId } }),
  }
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    return { ok: true, data: answers[method]!(params) }
  })
  const connection = {
    snapshot: () => ({
      state: 'ready',
      laneTransfer: true,
      capabilities: ['sessions.read', 'sessions.control', 'workspaces.write'],
    }),
    incarnation: () => ({ generation }),
    call,
  }
  return {
    connection,
    calls,
    call,
    answers,
    sha256,
    received: () => Buffer.concat(received),
    methods: () => calls.map((c) => c.method),
    reconnect: () => {
      generation++
    },
  }
}
type FakeHost = ReturnType<typeof fakeHost>

async function moves(hosts: Record<string, FakeHost>, prefix = 'me') {
  const temp = await mkdtemp(join(tmpdir(), 'lane-move-char-'))
  roots.push(temp)
  const labels: Record<string, string> = { a: 'Studio\nBox', b: '' }
  const service = createLaneMoves({
    connection: ((hostId: string) => hosts[hostId]?.connection) as never,
    label: (hostId) => labels[hostId] ?? hostId,
    branchPrefix: () => prefix,
    tempDir: () => temp,
  })
  return { service, temp }
}

const request = (target = 'b'): LaneMoveRequest => ({
  source: { machine: 'a', laneId },
  target: { machine: target, repositoryId },
  marks: { pinned: true, marker: '🔬' },
})

it('plans by inspecting the source Host and checking the target with the normalized prefix', async () => {
  const a = fakeHost(new Uint8Array(20))
  const b = fakeHost(new Uint8Array(0))
  const { service } = await moves({ a, b })
  expect(await service.plan(request())).toEqual({ ...plan, bytes: 20 })
  expect(a.calls).toEqual([{ method: 'laneTransfer.inspect', params: { laneId } }])
  expect(b.calls).toEqual([
    {
      method: 'laneTransfer.check',
      params: { repositoryId, source: facts, branchPrefix: 'me/', sameMachine: false },
    },
  ])
})

it('plans a move between folders of one Host as the same machine', async () => {
  const a = fakeHost(new Uint8Array(20))
  const { service } = await moves({ a })
  expect(await service.plan(request('a'))).toEqual({ ...plan, bytes: 20 })
  expect(a.calls.at(-1)?.params.sameMachine).toBe(true)
})

it('returns the source Host’s blockers as a refused plan without asking the target', async () => {
  const a = fakeHost(new Uint8Array(20))
  const b = fakeHost(new Uint8Array(0))
  a.answers['laneTransfer.inspect'] = () => ({ blockers: ['Stop this lane first.'] })
  const { service } = await moves({ a, b })
  expect(await service.plan(request())).toEqual({
    mode: 'folder',
    branch: null,
    workspace: '',
    blockers: ['Stop this lane first.'],
    bytes: 0,
  })
  expect(b.calls).toEqual([])
})

it('rejects a plan when the source Host is not connected', async () => {
  const b = fakeHost(new Uint8Array(0))
  const { service } = await moves({ b })
  await expect(service.plan(request())).rejects.toThrow(LANE_MOVE_ERRORS.offline)
})

it('moves a multi-chunk bundle from one Host to another and returns the new lane', async () => {
  const bytes = new Uint8Array(LANE_TRANSFER_LIMITS.chunkBytes * 2 + 123).map((_, i) => i % 251)
  const a = fakeHost(bytes)
  const b = fakeHost(new Uint8Array(0))
  const { service, temp } = await moves({ a, b })
  expect(await service.move(request())).toEqual({ machine: 'b', laneId: newLaneId })
  expect(a.methods()).toEqual([
    'laneTransfer.inspect',
    'laneTransfer.export',
    'laneTransfer.exportStatus',
    'laneTransfer.read',
    'laneTransfer.read',
    'laneTransfer.read',
    'laneTransfer.release',
  ])
  expect(a.calls.filter((c) => c.method === 'laneTransfer.read').map((c) => c.params)).toEqual([
    { exportId, offset: 0 },
    { exportId, offset: LANE_TRANSFER_LIMITS.chunkBytes },
    { exportId, offset: LANE_TRANSFER_LIMITS.chunkBytes * 2 },
  ])
  expect(b.methods()).toEqual([
    'laneTransfer.check',
    'laneTransfer.begin',
    'laneTransfer.chunk',
    'laneTransfer.chunk',
    'laneTransfer.chunk',
    'laneTransfer.commit',
    'laneTransfer.importStatus',
  ])
  expect(b.calls.find((c) => c.method === 'laneTransfer.begin')?.params).toEqual({
    repositoryId,
    size: bytes.length,
    sha256: a.sha256,
    branchPrefix: 'me/',
    sameMachine: false,
    // Labels lose control characters; an empty one names "a Host".
    notice: { from: 'Studio Box', to: 'a Host' },
    marks: { pinned: true, marker: '🔬' },
  })
  expect(
    b.calls.filter((c) => c.method === 'laneTransfer.chunk').map((c) => c.params.offset),
  ).toEqual([0, LANE_TRANSFER_LIMITS.chunkBytes, LANE_TRANSFER_LIMITS.chunkBytes * 2])
  expect(b.received().equals(Buffer.from(bytes))).toBe(true)
  // Nothing of the bundle is left on This Mac.
  expect(await readdir(temp)).toEqual([])
})

it('refuses a bundle whose bytes do not match the Host’s hash, before sending any', async () => {
  const a = fakeHost(new Uint8Array(20).fill(7))
  const b = fakeHost(new Uint8Array(0))
  a.answers['laneTransfer.exportStatus'] = () => ({
    state: 'done',
    value: { size: 20, sha256: '0'.repeat(64) },
  })
  const { service, temp } = await moves({ a, b })
  expect(await service.move(request())).toEqual({ blockers: ['The lane bundle is damaged.'] })
  expect(a.methods().at(-1)).toBe('laneTransfer.release')
  expect(b.methods()).toEqual(['laneTransfer.check'])
  expect(await readdir(temp)).toEqual([])
})

it('fails a bundle larger than the limit without reading it, and releases the export', async () => {
  const a = fakeHost(new Uint8Array(20))
  const b = fakeHost(new Uint8Array(0))
  a.answers['laneTransfer.exportStatus'] = () => ({
    state: 'done',
    value: { size: LANE_TRANSFER_LIMITS.bundleBytes + 1, sha256: a.sha256 },
  })
  const { service, temp } = await moves({ a, b })
  await expect(service.move(request())).rejects.toThrow(LANE_MOVE_ERRORS.failed)
  expect(a.methods()).not.toContain('laneTransfer.read')
  expect(a.methods().at(-1)).toBe('laneTransfer.release')
  expect(b.methods()).toEqual(['laneTransfer.check'])
  expect(await readdir(temp)).toEqual([])
})

it('returns a target refusal from the move’s own check as blockers, exporting nothing', async () => {
  const a = fakeHost(new Uint8Array(20))
  const b = fakeHost(new Uint8Array(0))
  b.answers['laneTransfer.check'] = () => ({ ...plan, blockers: ['That branch is taken.'] })
  const { service } = await moves({ a, b })
  expect(await service.move(request())).toEqual({ blockers: ['That branch is taken.'] })
  expect(a.methods()).toEqual(['laneTransfer.inspect'])
})

it('fails closed when the source Host reconnects mid-download, sending nothing', async () => {
  const bytes = new Uint8Array(LANE_TRANSFER_LIMITS.chunkBytes + 1)
  const a = fakeHost(bytes)
  const b = fakeHost(new Uint8Array(0))
  const read = a.answers['laneTransfer.read']!
  a.answers['laneTransfer.read'] = (params) => {
    a.reconnect()
    return read(params)
  }
  const { service, temp } = await moves({ a, b })
  await expect(service.move(request())).rejects.toThrow(LANE_MOVE_ERRORS.failed)
  expect(b.methods()).toEqual(['laneTransfer.check'])
  expect(await readdir(temp)).toEqual([])
})

it('reports a target that reconnects after commit as unconfirmed, never retrying', async () => {
  const a = fakeHost(new Uint8Array(20).fill(3))
  const b = fakeHost(new Uint8Array(0))
  b.answers['laneTransfer.commit'] = () => {
    b.reconnect()
    return {}
  }
  const { service } = await moves({ a, b })
  await expect(service.move(request())).rejects.toThrow(LANE_MOVE_ERRORS.unconfirmed)
  expect(b.methods().filter((m) => m === 'laneTransfer.commit')).toHaveLength(1)
  expect(b.methods()).not.toContain('laneTransfer.importStatus')
})

it('runs one move at a time and refuses a second while the first runs', async () => {
  const a = fakeHost(new Uint8Array(20).fill(1))
  const b = fakeHost(new Uint8Array(0))
  let finish!: () => void
  const held = new Promise<void>((resolve) => (finish = resolve))
  const inspect = a.answers['laneTransfer.inspect']!
  a.call.mockImplementationOnce(async (method, params) => {
    await held
    a.calls.push({ method, params })
    return { ok: true, data: inspect(params) }
  })
  const { service } = await moves({ a, b })
  const first = service.move(request())
  expect(await service.move(request())).toEqual({
    blockers: ['Another lane is moving. Wait for it to finish.'],
  })
  finish()
  expect(await first).toEqual({ machine: 'b', laneId: newLaneId })
  // The first move's end frees the slot.
  expect(await service.move(request())).toEqual({ machine: 'b', laneId: newLaneId })
})
