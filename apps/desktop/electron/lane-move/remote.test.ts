import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { remoteLaneTransfer, LANE_MOVE_ERRORS } from './remote'

const id = 'a'.repeat(32)
const laneId = '11111111-2222-4333-8444-555555555555'
const bytes = Buffer.from('verified bundle bytes')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})

async function pathFor() {
  const root = await mkdtemp(join(tmpdir(), 'lane-remote-'))
  roots.push(root)
  return join(root, 'bundle')
}

function host() {
  let generation = 1
  const methods: string[] = []
  const answers: Record<string, unknown> = {
    'laneTransfer.export': { exportId: id },
    'laneTransfer.exportStatus': { state: 'done', value: { size: bytes.length, sha256 } },
    'laneTransfer.read': { data: bytes.toString('base64') },
    'laneTransfer.release': {},
    'laneTransfer.begin': { importId: id },
    'laneTransfer.chunk': {},
    'laneTransfer.commit': {},
    'laneTransfer.importStatus': { state: 'done', value: { laneId } },
  }
  const call = vi.fn(async (method: string) => {
    methods.push(method)
    return { ok: true, data: answers[method] }
  })
  const connection = {
    snapshot: () => ({ state: 'ready', laneTransfer: true, capabilities: ['sessions.control'] }),
    incarnation: () => ({ generation }),
    call,
  } as unknown as NonNullable<ReturnType<Parameters<typeof remoteLaneTransfer>[0]>>
  return {
    transfer: remoteLaneTransfer(() => connection, 'host'),
    methods,
    call,
    answers,
    reconnect: () => {
      generation++
    },
  }
}

it('downloads one verified-size bundle, then releases the Host copy', async () => {
  const h = host()
  const path = await pathFor()
  expect(await h.transfer.download(laneId, path)).toEqual({ size: bytes.length, sha256 })
  expect(await readFile(path)).toEqual(bytes)
  expect(h.methods).toEqual([
    'laneTransfer.export',
    'laneTransfer.exportStatus',
    'laneTransfer.read',
    'laneTransfer.release',
  ])
})

it('treats a lost commit answer as unconfirmed and never resubmits it', async () => {
  const h = host()
  const path = await pathFor()
  await writeFile(path, bytes)
  const original = h.call.getMockImplementation()!
  h.call.mockImplementation(async (method) => {
    if (method === 'laneTransfer.commit') throw new Error('connection lost')
    return original(method)
  })
  await expect(
    h.transfer.upload({
      path,
      size: bytes.length,
      sha256,
      repositoryId: 'a'.repeat(16),
      branchPrefix: '',
      sameMachine: false,
      notice: { from: 'a', to: 'b' },
      marks: { pinned: false, marker: null },
    }),
  ).rejects.toThrow(LANE_MOVE_ERRORS.unconfirmed)
  expect(h.call.mock.calls.filter(([m]) => m === 'laneTransfer.commit')).toHaveLength(1)
  expect(h.methods).not.toContain('laneTransfer.importStatus')
})

it('fails closed when the same Host reconnects during an answer', async () => {
  const h = host()
  const original = h.call.getMockImplementation()!
  h.call.mockImplementation(async (method) => {
    const result = await original(method)
    h.reconnect()
    return result
  })
  await expect(h.transfer.download(laneId, await pathFor())).rejects.toThrow(
    LANE_MOVE_ERRORS.failed,
  )
})
