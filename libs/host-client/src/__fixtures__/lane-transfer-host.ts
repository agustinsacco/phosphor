import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import { LANE_TRANSFER_LIMITS } from '@phosphor/shared/host-protocol-lane-transfer'
import type { LaneTransferConnection } from '../lane-transfer'

export const EXPORT_ID = 'e'.repeat(32)
export const IMPORT_ID = 'f'.repeat(32)
export const LANE_ID = '11111111-2222-4333-8444-555555555555'
export const NEW_LANE_ID = '66666666-7777-4888-9999-000000000000'
export const REPOSITORY_ID = 'a'.repeat(16)
export const FACTS = {
  sessionId: '01a0272a-7be5-46ed-b420-36b363924622',
  title: 'Research',
  workspace: 'app',
  cwd: '/work/app',
  git: null,
  bytes: 20,
  transcriptBytes: 20,
}
export const PLAN = { mode: 'folder', branch: null, workspace: 'notes', blockers: [] }

type Params = Record<string, unknown>
export type FakeLaneHost = ReturnType<typeof fakeLaneHost>

/**
 * A ready Host holding one exportable lane of `bundle`, and taking imports: it
 * keeps every chunk it is sent. `answers` and `call` can be replaced per test.
 */
export function fakeLaneHost(bundle: Uint8Array) {
  let generation = 1
  const calls: { method: string; params: Params }[] = []
  const chunks: Buffer[] = []
  const sha256 = createHash('sha256').update(bundle).digest('hex')
  const answers: Record<string, (params: Params) => unknown> = {
    'laneTransfer.inspect': () => ({ facts: FACTS }),
    'laneTransfer.check': () => PLAN,
    'laneTransfer.export': () => ({ exportId: EXPORT_ID }),
    'laneTransfer.exportStatus': () => ({
      state: 'done',
      value: { size: bundle.length, sha256 },
    }),
    'laneTransfer.read': ({ offset }) => ({
      data: Buffer.from(
        bundle.subarray(offset as number, (offset as number) + LANE_TRANSFER_LIMITS.chunkBytes),
      ).toString('base64'),
    }),
    'laneTransfer.release': () => ({}),
    'laneTransfer.begin': () => ({ importId: IMPORT_ID }),
    'laneTransfer.chunk': ({ data }) => {
      chunks.push(Buffer.from(data as string, 'base64'))
      return {}
    },
    'laneTransfer.commit': () => ({}),
    'laneTransfer.importStatus': () => ({ state: 'done', value: { laneId: NEW_LANE_ID } }),
  }
  const call = vi.fn(async (method: string, params: Params) => {
    calls.push({ method, params })
    return { ok: true, data: await answers[method]!(params) }
  })
  const connection = {
    snapshot: () => ({
      state: 'ready',
      laneTransfer: true,
      capabilities: ['sessions.read', 'sessions.control', 'workspaces.write'],
    }),
    incarnation: () => ({ generation }),
    call,
  } as unknown as NonNullable<ReturnType<LaneTransferConnection>>
  return {
    connection,
    calls,
    call,
    answers,
    sha256,
    received: () => Buffer.concat(chunks),
    methods: () => calls.map((c) => c.method),
    reconnect: () => {
      generation++
    },
  }
}

/** The connection port over a set of fake Hosts by id; an absent id is not connected. */
export const connectionTo =
  (hosts: Record<string, FakeLaneHost>): LaneTransferConnection =>
  (hostId) =>
    hosts[hostId]?.connection
