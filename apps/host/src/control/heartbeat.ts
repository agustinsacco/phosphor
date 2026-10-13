import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CONTROL_LIMITS,
  isUuid,
  parseHeartbeatRequest,
  parseHeartbeatResponse,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type Readiness,
} from '@phosphor/shared/control-api'
import { ControlFailure } from './client'
import { checkIdentityDirectory, IdentityFailure, readIdentityFile } from './identity'

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
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0
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
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
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
const UNKNOWN: Readiness = { pi: 'unknown', claude: 'unknown', tailscale: 'unknown' }
export const REMOVED =
  'This machine was removed from your Phosphor account. Run phosphor login to add it again.'

/**
 * `work`, or `fallback` once `signal` aborts. The abort listener is removed as
 * soon as either happens: the loop runs for the life of the service, so a race
 * against one long-lived promise would keep a reaction per beat (review r1).
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal, fallback: T): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {})
    return Promise.resolve(fallback)
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => resolve(fallback)
    signal.addEventListener('abort', abort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

/** One serialized sender. Shutdown cancels the running request before publishing its final seq. */
export function createHeartbeat(ports: HeartbeatPorts) {
  const running = new AbortController()
  let force: () => void = () => {}
  const forced = new Promise<void>((resolve) => {
    force = resolve
  })
  let ending = false
  let drain: Promise<{ state: 'stopped' }> | undefined
  let last = 0
  let readiness = UNKNOWN
  let refreshed = -Infinity
  const started = ports.now()
  let state = ''
  let staleLogged = false
  const log = (next: string) => {
    if (state !== next) {
      state = next
      ports.log(next)
    }
  }
  // Serialize sequence publication even if a cancelled transport takes time to settle.
  let publication = Promise.resolve()
  const body = (state: HeartbeatRequest['state']) => {
    const next = publication.then(async () => {
      last = Math.max(last, await ports.seq.read())
      const seq = Math.max(last + 1, ports.now())
      const parsed = parseHeartbeatRequest({
        seq,
        state,
        hostVersion: ports.hostVersion,
        uptimeSec: Math.max(0, Math.floor((ports.now() - started) / 1000)),
        readiness,
        lanes: { running: 0, waiting: 0 },
        endpoint: ports.endpoint?.() ?? null,
      })
      if (!parsed.ok) throw new IdentityFailure('Invalid heartbeat metadata.')
      await ports.seq.write(seq)
      last = seq
      return parsed.value
    })
    publication = next.then(
      () => {},
      () => {},
    )
    return next
  }
  const stop = async () => {
    if (drain) {
      force()
      return { state: 'stopped' as const }
    }
    ending = true
    running.abort()
    drain = (async () => {
      const deadline = new AbortController()
      try {
        await Promise.race([
          body('stopping')
            .then((value) => ports.client(value, deadline.signal))
            .catch(() => {}),
          ports.wait(5000, deadline.signal).catch(() => {}),
          forced,
        ])
      } finally {
        deadline.abort()
        log('stopped')
      }
      return { state: 'stopped' as const }
    })()
    return drain
  }
  return {
    drain: stop,
    exitCode: () => 0,
    async run(): Promise<number> {
      const abort = () => {
        void stop()
      }
      ports.signal?.addEventListener('abort', abort, { once: true })
      if (ports.signal?.aborted) void stop()
      let backoff = 5000
      try {
        while (!ending) {
          let delay: number
          try {
            if (ports.now() - refreshed >= 300_000) {
              readiness = await untilAborted(ports.readiness(), running.signal, readiness)
              refreshed = ports.now()
            }
            if (ending) break
            const request = await body('running')
            if (ending) break
            const answer = await untilAborted(
              ports.client(request, running.signal),
              running.signal,
              null,
            )
            if (ending || answer === null) break
            const parsed = parseHeartbeatResponse(answer)
            if (!parsed.ok) throw new ControlFailure('internal')
            const jitter = ports.random()
            if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1)
              throw new IdentityFailure('Invalid heartbeat jitter.')
            delay = parsed.value.nextInSec * 1000 + jitter * 3000
            backoff = 5000
            ports.onAccepted?.(parsed.value)
            log('connected')
          } catch (error) {
            if (ending) break
            if (!(error instanceof ControlFailure)) throw error
            if (error.code === 'gone') {
              ports.onRemoved?.()
              log(REMOVED)
              return 77
            }
            if (error.code === 'conflict') {
              if (!staleLogged) {
                ports.log('Heartbeat sequence was stale; retrying.')
                staleLogged = true
              }
              delay = CONTROL_LIMITS.heartbeatMinSec * 1000
            } else if (error.code === 'too-many-requests') {
              delay = CONTROL_LIMITS.heartbeatMinSec * 1000
            } else {
              delay = backoff
              backoff = Math.min(backoff * 2, 300_000)
            }
            log(`retrying in ${delay / 1000}s`)
          }
          await untilAborted(
            ports.wait(delay, running.signal).catch(() => {}),
            running.signal,
            undefined,
          )
        }
        await drain
        return 0
      } finally {
        ports.signal?.removeEventListener('abort', abort)
      }
    },
  }
}
