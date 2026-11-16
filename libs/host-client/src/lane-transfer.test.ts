import { expect, it } from 'vitest'
import { LANE_TRANSFER_LIMITS } from '@phosphor/shared/host-protocol-lane-transfer'
import { LANE_MOVE_ERRORS, remoteLaneTransfer, type OpenLaneBundle } from './lane-transfer'
import {
  EXPORT_ID,
  LANE_ID,
  REPOSITORY_ID,
  connectionTo,
  fakeLaneHost,
} from './__fixtures__/lane-transfer-host'

const bytes = new Uint8Array(Buffer.from('verified bundle bytes'))
const upload = (size: number, sha256: string) => ({
  size,
  sha256,
  repositoryId: REPOSITORY_ID,
  branchPrefix: '',
  sameMachine: false,
  notice: { from: 'a', to: 'b' },
  marks: { pinned: false, marker: null },
})

/** A writer that keeps what it is given, and whether it was closed. */
function sink() {
  const parts: Uint8Array[] = []
  const state = { size: -1, closed: false }
  const open: OpenLaneBundle = async (size) => {
    state.size = size
    return {
      write: async (chunk) => void parts.push(chunk.slice()),
      close: async () => void (state.closed = true),
    }
  }
  return { open, state, bytes: () => Buffer.concat(parts) }
}

it('downloads one verified-size bundle into the writer, then releases the Host copy', async () => {
  const host = fakeLaneHost(bytes)
  const out = sink()
  const transfer = remoteLaneTransfer(connectionTo({ host }), 'host')
  expect(await transfer.download(LANE_ID, out.open)).toEqual({
    size: bytes.length,
    sha256: host.sha256,
  })
  expect(out.bytes().equals(Buffer.from(bytes))).toBe(true)
  expect(out.state).toEqual({ size: bytes.length, closed: true })
  expect(host.methods()).toEqual([
    'laneTransfer.export',
    'laneTransfer.exportStatus',
    'laneTransfer.read',
    'laneTransfer.release',
  ])
})

it('sends a bundle in chunk-sized reads at their offsets', async () => {
  const size = LANE_TRANSFER_LIMITS.chunkBytes + 5
  const host = fakeLaneHost(new Uint8Array(0))
  const reads: [number, number][] = []
  const transfer = remoteLaneTransfer(connectionTo({ host }), 'host')
  await transfer.upload(upload(size, host.sha256), async (offset, length) => {
    reads.push([offset, length])
    return new Uint8Array(length).fill(9)
  })
  expect(reads).toEqual([
    [0, LANE_TRANSFER_LIMITS.chunkBytes],
    [LANE_TRANSFER_LIMITS.chunkBytes, 5],
  ])
  expect(host.received().length).toBe(size)
})

it('sends only the call’s own fields to begin', async () => {
  const host = fakeLaneHost(new Uint8Array(0))
  const transfer = remoteLaneTransfer(connectionTo({ host }), 'host')
  const input = { ...upload(1, host.sha256), path: '/private/bundle' }
  await transfer.upload(input, async () => new Uint8Array(1))
  expect(
    Object.keys(host.calls.find((c) => c.method === 'laneTransfer.begin')!.params).sort(),
  ).toEqual(['branchPrefix', 'marks', 'notice', 'repositoryId', 'sameMachine', 'sha256', 'size'])
})

it('treats a lost commit answer as unconfirmed and never resubmits it', async () => {
  const host = fakeLaneHost(new Uint8Array(0))
  host.answers['laneTransfer.commit'] = () => {
    throw new Error('connection lost')
  }
  const transfer = remoteLaneTransfer(connectionTo({ host }), 'host')
  await expect(
    transfer.upload(upload(bytes.length, host.sha256), async (o, l) => bytes.subarray(o, o + l)),
  ).rejects.toThrow(LANE_MOVE_ERRORS.unconfirmed)
  expect(host.methods().filter((m) => m === 'laneTransfer.commit')).toHaveLength(1)
  expect(host.methods()).not.toContain('laneTransfer.importStatus')
})

it('fails closed when the same Host reconnects during an answer', async () => {
  const host = fakeLaneHost(bytes)
  const read = host.answers['laneTransfer.read']!
  host.answers['laneTransfer.read'] = (params) => {
    host.reconnect()
    return read(params)
  }
  const out = sink()
  const transfer = remoteLaneTransfer(connectionTo({ host }), 'host')
  await expect(transfer.download(LANE_ID, out.open)).rejects.toThrow(LANE_MOVE_ERRORS.failed)
  expect(out.state.closed).toBe(true)
})

it('stops a cancelled download at its next read and still releases the export', async () => {
  const host = fakeLaneHost(new Uint8Array(LANE_TRANSFER_LIMITS.chunkBytes * 2))
  const cancel = new AbortController()
  const read = host.answers['laneTransfer.read']!
  host.answers['laneTransfer.read'] = (params) => {
    cancel.abort()
    return read(params)
  }
  const out = sink()
  const transfer = remoteLaneTransfer(connectionTo({ host }), 'host', cancel.signal)
  await expect(transfer.download(LANE_ID, out.open)).rejects.toThrow(LANE_MOVE_ERRORS.cancelled)
  expect(host.methods().filter((m) => m === 'laneTransfer.read')).toHaveLength(1)
  expect(host.calls.at(-1)).toEqual({
    method: 'laneTransfer.release',
    params: { exportId: EXPORT_ID },
  })
  expect(out.state.closed).toBe(true)
})

it('never begins or commits an upload cancelled before it starts or between chunks', async () => {
  const cancel = new AbortController()
  cancel.abort()
  const before = fakeLaneHost(new Uint8Array(0))
  await expect(
    remoteLaneTransfer(connectionTo({ before }), 'before', cancel.signal).upload(
      upload(1, before.sha256),
      async () => new Uint8Array(1),
    ),
  ).rejects.toThrow(LANE_MOVE_ERRORS.cancelled)
  expect(before.calls).toEqual([])

  const midway = new AbortController()
  const host = fakeLaneHost(new Uint8Array(0))
  const transfer = remoteLaneTransfer(connectionTo({ host }), 'host', midway.signal)
  const size = LANE_TRANSFER_LIMITS.chunkBytes * 2
  await expect(
    transfer.upload(upload(size, host.sha256), async (_offset, length) => {
      midway.abort()
      return new Uint8Array(length)
    }),
  ).rejects.toThrow(LANE_MOVE_ERRORS.cancelled)
  expect(host.methods()).toEqual(['laneTransfer.begin', 'laneTransfer.chunk'])
})

it('says why a Host cannot take part before calling it', async () => {
  const host = fakeLaneHost(bytes)
  const snapshot = (edit: object) => {
    host.connection.snapshot = () =>
      ({
        state: 'ready',
        laneTransfer: true,
        capabilities: ['sessions.read'],
        ...edit,
      }) as never
  }
  const transfer = () => remoteLaneTransfer(connectionTo({ host }), 'host')
  await expect(remoteLaneTransfer(connectionTo({}), 'host').inspect(LANE_ID)).rejects.toThrow(
    LANE_MOVE_ERRORS.offline,
  )
  snapshot({ laneTransfer: undefined })
  await expect(transfer().inspect(LANE_ID)).rejects.toThrow(LANE_MOVE_ERRORS.outdated)
  snapshot({})
  await expect(transfer().inspect(LANE_ID)).rejects.toThrow(LANE_MOVE_ERRORS.control)
  expect(host.calls).toEqual([])
})

it('reads an unsupported method as an outdated Host', async () => {
  const host = fakeLaneHost(bytes)
  host.call.mockResolvedValueOnce({
    ok: false,
    error: { code: 'unsupported', message: 'no' },
  } as never)
  await expect(remoteLaneTransfer(connectionTo({ host }), 'host').inspect(LANE_ID)).rejects.toThrow(
    LANE_MOVE_ERRORS.outdated,
  )
})
