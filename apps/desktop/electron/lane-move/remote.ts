import { open } from 'node:fs/promises'
import {
  LANE_TRANSFER_LIMITS as LIMIT,
  parseLaneTargetPlan,
  type LaneMoveMarks,
  type LaneMoveNotice,
  type LaneSourceFacts,
  type LaneTargetPlan,
} from '@shared/host-protocol-lane-transfer'
import {
  parseLaneChunk,
  parseLaneExported,
  parseLaneImported,
  parseLaneInspection,
  parseLaneJobStatus,
  parseTransferStarted,
  type LaneInspection,
} from '@shared/host-protocol-lane-transfer-calls'
import type { HostCapability } from '@shared/remote-host'
import type { createHostConnection } from '@phosphor/host-client/connection'

type Connection = (
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
} as const

const POLL_MS = 400
const JOB_DEADLINE_MS = 15 * 60 * 1000

/**
 * One Host's half of a lane move. A replaced connection, a lost capability or
 * an answer that does not parse fails closed, and a write whose outcome is in
 * doubt is reported as unconfirmed, never retried.
 */
export function remoteLaneTransfer(connection: Connection, hostId: string) {
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
  async function call(capability: HostCapability, method: string, params: unknown, doubt: string) {
    available(capability)
    if (!c) throw new Error(LANE_MOVE_ERRORS.offline)
    const result = await c.call(method, params).catch(() => null)
    if (!result || !ready(capability)) throw new Error(doubt)
    if (!result.ok)
      throw new Error(result.error.code === 'unsupported' ? LANE_MOVE_ERRORS.outdated : doubt)
    return result.data
  }
  async function settle<T>(
    capability: HostCapability,
    method: string,
    params: unknown,
    value: (v: unknown) => T | null,
    doubt: string,
  ) {
    const deadline = Date.now() + JOB_DEADLINE_MS
    while (Date.now() < deadline) {
      const status = parseLaneJobStatus(await call(capability, method, params, doubt), value)
      if (!status) throw new Error(doubt)
      if (!('state' in status)) return status
      if (status.state === 'done') return status
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    throw new Error(doubt)
  }
  return {
    available,
    async inspect(laneId: string): Promise<LaneInspection> {
      const data = await call(
        'sessions.read',
        'laneTransfer.inspect',
        { laneId },
        LANE_MOVE_ERRORS.failed,
      )
      const parsed = parseLaneInspection(data)
      if (!parsed) throw new Error(LANE_MOVE_ERRORS.failed)
      return parsed
    },
    async check(
      repositoryId: string,
      source: LaneSourceFacts,
      branchPrefix: string,
      sameMachine: boolean,
    ): Promise<LaneTargetPlan> {
      const data = await call(
        'sessions.control',
        'laneTransfer.check',
        { repositoryId, source, branchPrefix, sameMachine },
        LANE_MOVE_ERRORS.failed,
      )
      const plan = parseLaneTargetPlan(data)
      if (!plan) throw new Error(LANE_MOVE_ERRORS.failed)
      return plan
    },
    /** Copy the lane's bundle into `path` on this Mac. */
    async download(
      laneId: string,
      path: string,
    ): Promise<{ size: number; sha256: string } | { blockers: string[] }> {
      const fail = LANE_MOVE_ERRORS.failed
      const started = await call('sessions.read', 'laneTransfer.export', { laneId }, fail)
      const refused = parseLaneInspection(started)
      if (refused && 'blockers' in refused) return refused
      const exportId = parseTransferStarted(started, 'exportId')
      if (!exportId) throw new Error(fail)
      try {
        const status = await settle(
          'sessions.read',
          'laneTransfer.exportStatus',
          { exportId },
          parseLaneExported,
          fail,
        )
        if (!('state' in status)) return status
        const { size, sha256 } = status.value
        if (size > LIMIT.bundleBytes) throw new Error(fail)
        const file = await open(path, 'wx', 0o600)
        try {
          for (let offset = 0; offset < size;) {
            const data = parseLaneChunk(
              await call('sessions.read', 'laneTransfer.read', { exportId, offset }, fail),
            )
            if (!data) throw new Error(fail)
            const bytes = Buffer.from(data, 'base64')
            if (offset + bytes.length > size) throw new Error(fail)
            await file.write(bytes, 0, bytes.length, offset)
            offset += bytes.length
          }
        } finally {
          await file.close()
        }
        return { size, sha256 }
      } finally {
        await call('sessions.read', 'laneTransfer.release', { exportId }, fail).catch(
          () => undefined,
        )
      }
    },
    /** Send the bundle at `path` and add it as a lane of `repositoryId`. */
    async upload(input: {
      path: string
      size: number
      sha256: string
      repositoryId: string
      branchPrefix: string
      sameMachine: boolean
      notice: LaneMoveNotice
      marks: LaneMoveMarks
    }): Promise<{ laneId: string } | { blockers: string[] }> {
      const { path, ...begin } = input
      const fail = LANE_MOVE_ERRORS.failed
      const importId = parseTransferStarted(
        await call('sessions.control', 'laneTransfer.begin', begin, fail),
        'importId',
      )
      if (!importId) throw new Error(fail)
      const file = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(LIMIT.chunkBytes)
        for (let offset = 0; offset < input.size;) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
          if (!bytesRead) throw new Error(fail)
          const data = buffer.subarray(0, bytesRead).toString('base64')
          await call('sessions.control', 'laneTransfer.chunk', { importId, offset, data }, fail)
          offset += bytesRead
        }
      } finally {
        await file.close()
      }
      // From here the Host may be writing: any doubt is "unconfirmed", never a retry.
      const doubt = LANE_MOVE_ERRORS.unconfirmed
      await call('sessions.control', 'laneTransfer.commit', { importId }, doubt)
      const status = await settle(
        'sessions.control',
        'laneTransfer.importStatus',
        { importId },
        parseLaneImported,
        doubt,
      )
      return 'state' in status ? status.value : status
    },
  }
}
