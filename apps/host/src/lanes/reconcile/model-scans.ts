/**
 * `lane-model-scans.json` in the Host state folder: the lanes the start-up
 * model repair read in full without finding a model, each with its session
 * file's `size:mtimeMs` then. It only saves work: a missing or untrusted file
 * reads as nothing remembered, and the next start reads those lanes again.
 */
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { isUuid } from '@phosphor/shared/control-api'
import { readSidecar, writeSidecar } from '../../config/sidecar'

/** Room for an entry per lane the Host can hold. */
const MAX_BYTES = HOST_LIMITS.lanesPerHost * 128
const STAMP = /^\d{1,16}:\d{1,16}(\.\d{1,9})?$/

export function readModelScans(directory: string, uid: number | undefined): Map<string, string> {
  const read = readSidecar(
    directory,
    HOST_SIDECARS.laneModelScans,
    (raw) => (raw.version === 1 && typeof raw.lanes === 'object' && raw.lanes ? raw.lanes : null),
    { uid, maxBytes: MAX_BYTES },
  )
  if (read.state !== 'ok') return new Map()
  const entries = Object.entries(read.value).filter(
    (entry): entry is [string, string] =>
      isUuid(entry[0]) && typeof entry[1] === 'string' && STAMP.test(entry[1]),
  )
  return new Map(entries.slice(0, HOST_LIMITS.lanesPerHost))
}

export function writeModelScans(
  directory: string,
  uid: number | undefined,
  scanned: ReadonlyMap<string, string>,
): void {
  writeSidecar(
    directory,
    HOST_SIDECARS.laneModelScans,
    { version: 1, lanes: Object.fromEntries(scanned) },
    { uid, maxBytes: MAX_BYTES, known: ['version', 'lanes'] },
  )
}
