import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isUuid } from '@phosphor/shared/control-api'
import { isInside } from '@phosphor/session-runtime/fs-safety'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import type { HostStore } from '../lanes/store'
import type { BrainInventoryLane, BrainSurfaceInventory } from './surface-service'

const HEADER_BYTES = 8192
const SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/

/** The id pi saved in the transcript's header line, read by bounded bytes; never through a link. */
function savedSessionId(file: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!fstatSync(fd).isFile()) return undefined
    const bytes = Buffer.alloc(HEADER_BYTES + 1)
    const read = readSync(fd, bytes, 0, bytes.length, 0)
    const end = bytes.subarray(0, read).indexOf(10)
    const line = bytes.subarray(0, end < 0 ? read : end)
    if (line.length > HEADER_BYTES) return undefined
    const header: unknown = JSON.parse(line.toString('utf8'))
    if (!header || typeof header !== 'object' || !('type' in header) || !('id' in header))
      return undefined
    return header.type === 'session' && typeof header.id === 'string' && SESSION_ID.test(header.id)
      ? header.id
      : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const real = (path: string): string | undefined => {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

export interface HostBrainInventoryPorts {
  store: Pick<HostStore, 'getLane' | 'sessionLane'>
  sessionsRoot: string
  /** Reserved lanes' folders (Brain Agent's): neither they nor their transcripts are lanes here. */
  reserved(): readonly string[]
}

/**
 * Brain's view of the Host's ordinary lanes: a Host lane ID to the pi session ID and transcript
 * pi saved, and back. Both sides come from the Host's own lane store and the transcript header,
 * never from the caller, and a reserved lane resolves to nothing.
 */
export function createHostBrainInventory(ports: HostBrainInventoryPorts): BrainSurfaceInventory {
  function reserved(cwd: string, file: string): boolean {
    return ports.reserved().some((folder) => {
      const root = real(folder) ?? folder
      const transcripts = real(sessionDirForCwd(folder, ports.sessionsRoot))
      return (
        isInside(root, real(cwd) ?? cwd) ||
        isInside(root, file) ||
        (transcripts !== undefined && isInside(transcripts, file))
      )
    })
  }
  function resolve(laneId: string): BrainInventoryLane | undefined {
    if (!isUuid(laneId)) return undefined
    const lane = ports.store.getLane(laneId)
    if (!lane || lane.removedAt || !lane.sessionFile) return undefined
    const file = lane.sessionFile
    if (reserved(lane.cwd, real(file) ?? file)) return undefined
    // Opened without following a link: a transcript swapped for one is no lane's.
    const sessionId = savedSessionId(file)
    return sessionId ? { laneId, sessionId, sessionPath: file, title: lane.title ?? '' } : undefined
  }
  return {
    lane: (laneId, caller) => (caller.admit() ? resolve(laneId) : undefined),
    source(source, caller) {
      if (!caller.admit()) return undefined
      let stored
      try {
        stored = ports.store.sessionLane(source.sessionPath)
      } catch {
        return undefined
      }
      const lane = stored && resolve(stored.laneId)
      return lane?.sessionId === source.sessionId && lane.sessionPath === source.sessionPath
        ? lane
        : undefined
    },
  }
}
