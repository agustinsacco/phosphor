import { expect, it } from 'vitest'
import { LANE_TRANSFER_LIMITS } from '@phosphor/shared/host-protocol-lane-transfer'
import {
  LANE_BUNDLE_DAMAGED,
  LANE_MOVE_BUSY,
  createHostLaneMoves,
  isHostLaneMove,
  moveBranchPrefix,
  moveLabel,
  type HostLaneMoveRequest,
} from './lane-move'
import { LANE_MOVE_ERRORS } from './lane-transfer'
import {
  FACTS,
  LANE_ID,
  NEW_LANE_ID,
  PLAN,
  REPOSITORY_ID,
  connectionTo,
  fakeLaneHost,
  type FakeLaneHost,
} from './__fixtures__/lane-transfer-host'

const CHUNK = LANE_TRANSFER_LIMITS.chunkBytes

function moves(hosts: Record<string, FakeLaneHost>, prefix: string | Promise<string> = 'me') {
  const labels: Record<string, string> = { a: 'Studio', b: 'Garage\u2028Box' }
  return createHostLaneMoves({
    connection: connectionTo(hosts),
    label: (hostId) => labels[hostId] ?? 'Host',
    branchPrefix: () => prefix,
  })
}
const request = (target = 'b'): HostLaneMoveRequest => ({
  source: { machine: 'a', laneId: LANE_ID },
  target: { machine: target, repositoryId: REPOSITORY_ID },
  marks: { pinned: false, marker: '🧪' },
})
const pattern = (size: number) => new Uint8Array(size).map((_, i) => (i * 7) % 256)

it('names machines and branch prefixes as a move notice and begin call carry them', () => {
  expect(moveLabel('  Studio\nMac  ')).toBe('Studio Mac')
  expect(moveLabel('\u0007')).toBe('a Host')
  expect(moveLabel('x'.repeat(90))).toHaveLength(80)
  expect(moveBranchPrefix('me')).toBe('me/')
  expect(moveBranchPrefix(' ')).toBe('')
})

it('tells a move between Hosts from one with This Mac on either end', () => {
  expect(isHostLaneMove(request())).toBe(true)
  expect(
    isHostLaneMove({ ...request(), source: { machine: 'local', sessionPath: '/s.jsonl' } }),
  ).toBe(false)
  expect(isHostLaneMove({ ...request(), target: { machine: 'local', workspace: '/w' } })).toBe(
    false,
  )
})

it('plans with the source Host’s facts and the target’s check, awaiting the prefix', async () => {
  const a = fakeLaneHost(new Uint8Array(0))
  const b = fakeLaneHost(new Uint8Array(0))
  expect(await moves({ a, b }, Promise.resolve('team')).plan(request())).toEqual({
    ...PLAN,
    bytes: FACTS.bytes,
  })
  expect(b.calls[0]?.params).toEqual({
    repositoryId: REPOSITORY_ID,
    source: FACTS,
    branchPrefix: 'team/',
    sameMachine: false,
  })
})

it('relays a multi-chunk bundle intact from one Host to another', async () => {
  const bundle = pattern(CHUNK * 2 + 17)
  const a = fakeLaneHost(bundle)
  const b = fakeLaneHost(new Uint8Array(0))
  expect(await moves({ a, b }).move(request())).toEqual({ machine: 'b', laneId: NEW_LANE_ID })
  expect(b.received().equals(Buffer.from(bundle))).toBe(true)
  expect(b.calls.find((c) => c.method === 'laneTransfer.begin')?.params).toEqual({
    repositoryId: REPOSITORY_ID,
    size: bundle.length,
    sha256: a.sha256,
    branchPrefix: 'me/',
    sameMachine: false,
    notice: { from: 'Studio', to: 'Garage Box' },
    marks: { pinned: false, marker: '🧪' },
  })
  expect(a.methods().at(-1)).toBe('laneTransfer.release')
  expect(b.methods().at(-1)).toBe('laneTransfer.importStatus')
})

it('moves into another folder of the same Host as the same machine', async () => {
  const a = fakeLaneHost(pattern(40))
  expect(await moves({ a }).move(request('a'))).toEqual({ machine: 'a', laneId: NEW_LANE_ID })
  const begin = a.calls.find((c) => c.method === 'laneTransfer.begin')!
  expect(begin.params).toMatchObject({
    sameMachine: true,
    notice: { from: 'Studio', to: 'Studio' },
  })
  expect(a.received().equals(Buffer.from(pattern(40)))).toBe(true)
})

it('refuses bytes that do not match the source Host’s hash, sending none', async () => {
  const a = fakeLaneHost(pattern(30))
  const b = fakeLaneHost(new Uint8Array(0))
  a.answers['laneTransfer.exportStatus'] = () => ({
    state: 'done',
    value: { size: 30, sha256: 'b'.repeat(64) },
  })
  expect(await moves({ a, b }).move(request())).toEqual({ blockers: [LANE_BUNDLE_DAMAGED] })
  expect(b.methods()).toEqual(['laneTransfer.check'])
  expect(a.methods().at(-1)).toBe('laneTransfer.release')
})

it('refuses a bundle over the transfer limit before reading or holding any of it', async () => {
  const a = fakeLaneHost(pattern(10))
  const b = fakeLaneHost(new Uint8Array(0))
  a.answers['laneTransfer.exportStatus'] = () => ({
    state: 'done',
    value: { size: LANE_TRANSFER_LIMITS.bundleBytes + 1, sha256: a.sha256 },
  })
  await expect(moves({ a, b }).move(request())).rejects.toThrow(LANE_MOVE_ERRORS.failed)
  expect(a.methods()).not.toContain('laneTransfer.read')
  expect(a.methods().at(-1)).toBe('laneTransfer.release')
  expect(b.methods()).toEqual(['laneTransfer.check'])
})

it('returns blockers from either Host without moving anything', async () => {
  const a = fakeLaneHost(pattern(10))
  const b = fakeLaneHost(new Uint8Array(0))
  b.answers['laneTransfer.check'] = () => ({ ...PLAN, blockers: ['That branch is taken.'] })
  expect(await moves({ a, b }).move(request())).toEqual({ blockers: ['That branch is taken.'] })
  a.answers['laneTransfer.export'] = () => ({ blockers: ['Stop this lane first.'] })
  b.answers['laneTransfer.check'] = () => PLAN
  expect(await moves({ a, b }).move(request())).toEqual({ blockers: ['Stop this lane first.'] })
  expect(b.methods()).not.toContain('laneTransfer.begin')
})

it('fails closed when the source disconnects mid-download, sending nothing', async () => {
  const a = fakeLaneHost(pattern(CHUNK + 1))
  const b = fakeLaneHost(new Uint8Array(0))
  const read = a.answers['laneTransfer.read']!
  a.answers['laneTransfer.read'] = (params) => {
    a.reconnect()
    return read(params)
  }
  await expect(moves({ a, b }).move(request())).rejects.toThrow(LANE_MOVE_ERRORS.failed)
  expect(b.methods()).toEqual(['laneTransfer.check'])
})

it('stops when the target disconnects mid-upload, never committing', async () => {
  const a = fakeLaneHost(pattern(CHUNK + 1))
  const b = fakeLaneHost(new Uint8Array(0))
  b.answers['laneTransfer.chunk'] = () => {
    b.reconnect()
    return {}
  }
  await expect(moves({ a, b }).move(request())).rejects.toThrow(LANE_MOVE_ERRORS.failed)
  expect(b.methods()).toEqual(['laneTransfer.check', 'laneTransfer.begin', 'laneTransfer.chunk'])
})

it('aborting a move mid-download releases the export and sends nothing', async () => {
  const a = fakeLaneHost(pattern(CHUNK * 3))
  const b = fakeLaneHost(new Uint8Array(0))
  const service = moves({ a, b })
  const read = a.answers['laneTransfer.read']!
  a.answers['laneTransfer.read'] = (params) => {
    service.abort()
    return read(params)
  }
  await expect(service.move(request())).rejects.toThrow(LANE_MOVE_ERRORS.cancelled)
  expect(a.methods().filter((m) => m === 'laneTransfer.read')).toHaveLength(1)
  expect(a.methods().at(-1)).toBe('laneTransfer.release')
  expect(b.methods()).toEqual(['laneTransfer.check'])
  // The aborted move ends, so the next one runs.
  a.answers['laneTransfer.read'] = read
  expect(await service.move(request())).toEqual({ machine: 'b', laneId: NEW_LANE_ID })
})

it('aborting a move mid-upload never commits it', async () => {
  const a = fakeLaneHost(pattern(CHUNK * 2))
  const b = fakeLaneHost(new Uint8Array(0))
  const service = moves({ a, b })
  b.answers['laneTransfer.chunk'] = () => {
    service.abort()
    return {}
  }
  await expect(service.move(request())).rejects.toThrow(LANE_MOVE_ERRORS.cancelled)
  expect(b.methods()).not.toContain('laneTransfer.commit')
})

it('runs one move at a time, and abort is a no-op with none running', async () => {
  const a = fakeLaneHost(pattern(10))
  const b = fakeLaneHost(new Uint8Array(0))
  const service = moves({ a, b })
  service.abort()
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const inspect = a.answers['laneTransfer.inspect']!
  a.answers['laneTransfer.inspect'] = (params) => held.then(() => inspect(params))
  const first = service.move(request())
  expect(await service.move(request())).toEqual({ blockers: [LANE_MOVE_BUSY] })
  release()
  expect(await first).toEqual({ machine: 'b', laneId: NEW_LANE_ID })
})
