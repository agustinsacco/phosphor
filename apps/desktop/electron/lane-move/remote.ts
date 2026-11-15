import { open } from 'node:fs/promises'
import { LANE_TRANSFER_LIMITS as LIMIT } from '@shared/host-protocol-lane-transfer'
import {
  remoteLaneTransfer as hostLaneTransfer,
  type LaneTransferConnection,
  type LaneUpload,
} from '@phosphor/host-client/lane-transfer'

/** The fixed sentences a transfer throws, for callers that already import this module. */
export { LANE_MOVE_ERRORS } from '@phosphor/host-client/lane-transfer'

/** Copy a lane's bundle from its Host into a new private file at `path` on this Mac. */
async function downloadTo(
  host: ReturnType<typeof hostLaneTransfer>,
  laneId: string,
  path: string,
): Promise<{ size: number; sha256: string } | { blockers: string[] }> {
  return host.download(laneId, async () => {
    const file = await open(path, 'wx', 0o600)
    return {
      write: (bytes) => file.writeFile(bytes),
      close: () => file.close(),
    }
  })
}

/** Send the bundle at `path` and add it as a lane of `input.repositoryId`. */
async function uploadFrom(
  host: ReturnType<typeof hostLaneTransfer>,
  { path, ...input }: LaneUpload & { path: string },
): Promise<{ laneId: string } | { blockers: string[] }> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(LIMIT.chunkBytes)
    return await host.upload(input, async (offset, length) => {
      const { bytesRead } = await file.read(buffer, 0, length, offset)
      return buffer.subarray(0, bytesRead)
    })
  } finally {
    await file.close()
  }
}

/**
 * One Host's half of a lane move that starts or ends on This Mac, through a
 * private file there. The calls, checks and fixed errors are the shared
 * `@phosphor/host-client/lane-transfer`; Host-to-Host moves never come here.
 */
export function remoteLaneTransfer(connection: LaneTransferConnection, hostId: string) {
  const host = hostLaneTransfer(connection, hostId)
  return {
    available: host.available,
    inspect: host.inspect,
    check: host.check,
    download: (laneId: string, path: string) => downloadTo(host, laneId, path),
    upload: (input: LaneUpload & { path: string }) => uploadFrom(host, input),
  }
}
