import { base64ToBytes, bytesToBase64 } from '@phosphor/shared/base64'
import {
  LANE_TRANSFER_LIMITS as LIMIT,
  parseLaneTargetPlan,
  type LaneMoveMarks,
  type LaneMoveNotice,
  type LaneSourceFacts,
  type LaneTargetPlan,
} from '@phosphor/shared/host-protocol-lane-transfer'
import {
  parseLaneChunk,
  parseLaneExported,
  parseLaneImported,
  parseLaneInspection,
  parseLaneJobStatus,
  parseTransferStarted,
  type LaneInspection,
} from '@phosphor/shared/host-protocol-lane-transfer-calls'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { createHostConnection } from './connection'

export type LaneTransferConnection = (
  hostId: string,
) => Pick<ReturnType<typeof createHostConnection>, 'snapshot' | 'incarnation' | 'call'> | undefined

export const LANE_MOVE_ERRORS = {
  offline: 'This machine is not connected.',
  outdated: 'Update this machine’s Host to move lanes.',
  read: 'This machine does not let this device read its lanes.',
  control: 'This machine does not let this device create lanes.',
  unconfirmed:
    'The machine did not confirm the move. Check its lanes before trying again; nothing was retried.',
  failed: 'The machine could not finish the move.',
  cancelled: 'The move was cancelled before anything was added.',
} as const

const POLL_MS = 400
const JOB_DEADLINE_MS = 15 * 60 * 1000

/** Takes a downloading bundle's bytes in order. `close` runs once, however the download ends. */
export interface LaneBundleWriter {
  write(bytes: Uint8Array): Promise<void>
  close(): Promise<void>
}
/** Opened once the Host has built the bundle and said its size, which is within the limit. */
export type OpenLaneBundle = (size: number) => Promise<LaneBundleWriter>
/** Up to `length` bytes of the bundle being sent, from `offset`; empty past its end. */
export type ReadLaneBundle = (offset: number, length: number) => Promise<Uint8Array>

type Channel = ReturnType<typeof hostChannel>

/**
 * Calls to one Host that fail closed when its connection or grants change mid-move.
 * An aborted `signal` stops the next step, never a call already sent.
 */
function hostChannel(connection: LaneTransferConnection, hostId: string, signal?: AbortSignal) {
  const c = connection(hostId)
  const generation = c?.incarnation().generation
  const ready = (capability: HostCapability) =>
    !!c &&
    connection(hostId) === c &&
    c.incarnation().generation === generation &&
    c.snapshot().state === 'ready' &&
    c.snapshot().capabilities.includes(capability)
  function available(capability: HostCapability): void {
    if (!c || c.snapshot().state !== 'ready') throw new Error(LANE_MOVE_ERRORS.offline)
    if (c.snapshot().laneTransfer !== true) throw new Error(LANE_MOVE_ERRORS.outdated)
    if (!ready(capability))
      throw new Error(
        capability === 'sessions.read' ? LANE_MOVE_ERRORS.read : LANE_MOVE_ERRORS.control,
      )
  }
  /** Throws `message` once the move is cancelled. */
  function live(message: string): void {
    if (signal?.aborted) throw new Error(message)
  }
  async function call(capability: HostCapability, method: string, params: unknown, doubt: string) {
    available(capability)
    if (!c) throw new Error(LANE_MOVE_ERRORS.offline)
    const result = await c.call(method, params).catch(() => null)
    if (!result || !ready(capability)) throw new Error(doubt)
    if (!result.ok)
      throw new Error(result.error.code === 'unsupported' ? LANE_MOVE_ERRORS.outdated : doubt)
    return result.data
  }
  /**
   * Poll a job until it is done or refused; past the deadline its outcome is in doubt.
   * A cancel between polls ends with `cancelled`.
   */
  async function settle<T>(
    method: string,
    params: unknown,
    value: (v: unknown) => T | null,
    doubt: string,
    cancelled: string,
  ) {
    const deadline = Date.now() + JOB_DEADLINE_MS
    while (Date.now() < deadline) {
      live(cancelled)
      const raw = await call('sessions.control', method, params, doubt)
      const status = parseLaneJobStatus(raw, value)
      if (!status) throw new Error(doubt)
      if (!('state' in status)) return status
      if (status.state === 'done') return status
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    throw new Error(doubt)
  }
  return { available, live, call, settle }
}

async function readExport(
  host: Channel,
  exportId: string,
  open: OpenLaneBundle,
): Promise<{ size: number; sha256: string } | { blockers: string[] }> {
  const { failed: fail, cancelled } = LANE_MOVE_ERRORS
  const params = { exportId }
  const status = await host.settle(
    'laneTransfer.exportStatus',
    params,
    parseLaneExported,
    fail,
    cancelled,
  )
  if (!('state' in status)) return status
  const { size, sha256 } = status.value
  if (size > LIMIT.bundleBytes) throw new Error(fail)
  const writer = await open(size)
  try {
    for (let offset = 0; offset < size;) {
      host.live(cancelled)
      const data = parseLaneChunk(
        await host.call('sessions.control', 'laneTransfer.read', { exportId, offset }, fail),
      )
      if (!data) throw new Error(fail)
      const bytes = base64ToBytes(data)
      if (offset + bytes.length > size) throw new Error(fail)
      await writer.write(bytes)
      offset += bytes.length
    }
  } finally {
    await writer.close()
  }
  return { size, sha256 }
}

/** Copy a lane's bundle from its Host into `open`'s writer; the Host's copy is then released. */
async function download(
  host: Channel,
  laneId: string,
  open: OpenLaneBundle,
): Promise<{ size: number; sha256: string } | { blockers: string[] }> {
  const fail = LANE_MOVE_ERRORS.failed
  host.live(LANE_MOVE_ERRORS.cancelled)
  const started = await host.call('sessions.control', 'laneTransfer.export', { laneId }, fail)
  const refused = parseLaneInspection(started)
  if (refused && 'blockers' in refused) return refused
  const exportId = parseTransferStarted(started, 'exportId')
  if (!exportId) throw new Error(fail)
  try {
    return await readExport(host, exportId, open)
  } finally {
    // Also after a cancel: the Host keeps an unreleased export for an hour.
    await host
      .call('sessions.control', 'laneTransfer.release', { exportId }, fail)
      .catch(() => undefined)
  }
}

export interface LaneUpload {
  size: number
  sha256: string
  repositoryId: string
  branchPrefix: string
  sameMachine: boolean
  notice: LaneMoveNotice
  marks: LaneMoveMarks
}

/** Send the bundle `read` returns and add it as a lane of `repositoryId`. */
async function upload(
  host: Channel,
  begin: LaneUpload,
  read: ReadLaneBundle,
): Promise<{ laneId: string } | { blockers: string[] }> {
  const { failed: fail, cancelled } = LANE_MOVE_ERRORS
  host.live(cancelled)
  // Exactly the call's fields, whatever else the caller's object carries.
  const { size, sha256, repositoryId, branchPrefix, sameMachine, notice, marks } = begin
  const params = { repositoryId, size, sha256, branchPrefix, sameMachine, notice, marks }
  const importId = parseTransferStarted(
    await host.call('sessions.control', 'laneTransfer.begin', params, fail),
    'importId',
  )
  if (!importId) throw new Error(fail)
  for (let offset = 0; offset < begin.size;) {
    host.live(cancelled)
    const bytes = await read(offset, Math.min(LIMIT.chunkBytes, begin.size - offset))
    if (!bytes.length) throw new Error(fail)
    const data = bytesToBase64(bytes)
    await host.call('sessions.control', 'laneTransfer.chunk', { importId, offset, data }, fail)
    offset += bytes.length
  }
  host.live(cancelled)
  // From here the Host may be writing: any doubt is "unconfirmed", never a retry.
  const doubt = LANE_MOVE_ERRORS.unconfirmed
  await host.call('sessions.control', 'laneTransfer.commit', { importId }, doubt)
  const status = await host.settle(
    'laneTransfer.importStatus',
    { importId },
    parseLaneImported,
    doubt,
    doubt,
  )
  return 'state' in status ? status.value : status
}

/**
 * One Host's half of a lane move, shared by Desktop and the browser. A replaced
 * connection, a lost capability or an answer that does not parse fails closed,
 * and a write whose outcome is in doubt is reported as unconfirmed, never
 * retried. The caller owns where the bytes live: `download` writes them to
 * `open`'s writer and `upload` reads them back through `read`.
 */
export function remoteLaneTransfer(
  connection: LaneTransferConnection,
  hostId: string,
  signal?: AbortSignal,
) {
  const host = hostChannel(connection, hostId, signal)
  const fail = LANE_MOVE_ERRORS.failed
  return {
    available: host.available,
    async inspect(laneId: string): Promise<LaneInspection> {
      const data = await host.call('sessions.control', 'laneTransfer.inspect', { laneId }, fail)
      const parsed = parseLaneInspection(data)
      if (!parsed) throw new Error(fail)
      return parsed
    },
    async check(
      repositoryId: string,
      source: LaneSourceFacts,
      branchPrefix: string,
      sameMachine: boolean,
    ): Promise<LaneTargetPlan> {
      const params = { repositoryId, source, branchPrefix, sameMachine }
      const plan = parseLaneTargetPlan(
        await host.call('sessions.control', 'laneTransfer.check', params, fail),
      )
      if (!plan) throw new Error(fail)
      return plan
    },
    download: (laneId: string, open: OpenLaneBundle) => download(host, laneId, open),
    upload: (input: LaneUpload, read: ReadLaneBundle) => upload(host, input, read),
  }
}
