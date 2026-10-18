import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isUuid,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type Readiness,
} from '@phosphor/shared/control-api'
import { errnoIs } from '../fs-safety'
import { runHeartbeat } from './heartbeat-loop'
import { drainHeartbeat } from './heartbeat-publication'
import { checkIdentityDirectory, IdentityFailure, readIdentityFile } from './identity'

export { untilAborted } from './heartbeat-loop'
export { PUBLICATION_WAIT_MS, REMOVED } from './heartbeat-publication'

export interface SequenceStore {
  read(): Promise<number>
  write(seq: number): Promise<void>
}
export function createSequenceStore(
  directory: string,
  uid: number | undefined,
  hostId: string,
): SequenceStore {
  if (!isUuid(hostId)) throw new IdentityFailure('Invalid heartbeat host identity.')
  return {
    async read() {
      await checkIdentityDirectory(directory, uid)
      let text: string
      try {
        text = await readIdentityFile(directory, uid, 'heartbeat.json')
      } catch (error) {
        if (error instanceof Error && errnoIs(error, 'ENOENT')) return 0
        throw new IdentityFailure('Could not read heartbeat sequence storage.')
      }
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new IdentityFailure('Invalid heartbeat sequence storage.')
      }
      if (
        value === null ||
        typeof value !== 'object' ||
        !('version' in value) ||
        value.version !== 1 ||
        !('hostId' in value) ||
        !isUuid(value.hostId) ||
        !('seq' in value) ||
        typeof value.seq !== 'number' ||
        !Number.isSafeInteger(value.seq) ||
        value.seq < 1
      )
        throw new IdentityFailure('Invalid heartbeat sequence storage.')
      return value.hostId === hostId ? value.seq : 0
    },
    async write(seq) {
      if (!Number.isSafeInteger(seq) || seq < 1)
        throw new IdentityFailure('Invalid heartbeat sequence.')
      await checkIdentityDirectory(directory, uid)
      const temp = join(directory, `.heartbeat-${randomUUID()}.tmp`)
      try {
        const file = await open(temp, 'wx', 0o600)
        try {
          await file.writeFile(JSON.stringify({ version: 1, hostId, seq }) + '\n')
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temp, join(directory, 'heartbeat.json'))
      } finally {
        await unlink(temp).catch((error: unknown) => {
          if (!(error instanceof Error && errnoIs(error, 'ENOENT')))
            throw new IdentityFailure('Could not save heartbeat sequence storage.')
        })
      }
    },
  }
}

export interface HeartbeatPorts {
  now(): number
  wait(ms: number, signal: AbortSignal): Promise<void>
  random(): number
  client(body: HeartbeatRequest, signal: AbortSignal): Promise<HeartbeatResponse>
  readiness(): Promise<Readiness>
  seq: SequenceStore
  hostVersion: string
  signal?: AbortSignal
  log(line: string): void
  endpoint?(): string | null
  onAccepted?(reply: HeartbeatResponse): void
  onRemoved?(): void
}
/** State shared by the serialized publisher, drain and foreground loop. */
export interface HeartbeatState {
  ports: HeartbeatPorts
  running: AbortController
  forced: Promise<void>
  force(): void
  ending: boolean
  drain: Promise<{ state: 'stopped' }> | undefined
  publication: Promise<void>
  last: number
  readiness: Readiness
  refreshed: number
  started: number
  logState: string
  staleLogged: boolean
  backoff: number
}

/** One serialized sender. Shutdown cancels the running request before publishing its final seq. */
export function createHeartbeat(ports: HeartbeatPorts) {
  let force: () => void = () => {}
  const forced = new Promise<void>((resolve) => {
    force = resolve
  })
  const state: HeartbeatState = {
    ports,
    running: new AbortController(),
    forced,
    force,
    ending: false,
    drain: undefined,
    publication: Promise.resolve(),
    last: 0,
    readiness: { pi: 'unknown', claude: 'unknown', tailscale: 'unknown' },
    refreshed: -Infinity,
    started: ports.now(),
    logState: '',
    staleLogged: false,
    backoff: 5000,
  }
  return {
    drain: () => drainHeartbeat(state),
    exitCode: () => 0,
    run: () => runHeartbeat(state),
  }
}
