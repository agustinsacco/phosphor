import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createBrainClient, type BrainClient } from '@phosphor/brain-client/client'
import { createLaneBrain } from '@phosphor/brain-client/lane'
import { createNodeBrainTransport } from '@phosphor/brain-client/node-transport'
import { isOwnerPrivate } from '@phosphor/session-runtime/fs-safety'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import type { AppServiceRegistration, LocalStatus } from '@phosphor/shared/host-protocol-owner'
import type { HostReleaseFeature } from '@phosphor/shared/host-release'
import { readSidecar, writeSidecar } from '../config/sidecar'
import type { OwnerHandlers } from '../owner/adapter'

type Lane = { piSessionId: () => string | undefined; cwd: string }
const sidecar = HOST_SIDECARS.appServices

/** Authenticate the socket before *each* connection: the path may have been replaced since registration. */
function privateClient(
  reg: AppServiceRegistration,
  uid: number | undefined,
  signal: AbortSignal,
): BrainClient {
  const client = createBrainClient(createNodeBrainTransport(reg))
  function check() {
    signal.throwIfAborted()
    const folder = lstatSync(dirname(reg.endpoint)),
      socket = lstatSync(reg.endpoint)
    if (
      !folder.isDirectory() ||
      !isOwnerPrivate(folder, uid) ||
      !socket.isSocket() ||
      socket.uid !== uid
    )
      throw new Error('Brain unavailable.')
  }
  return {
    search(query) {
      check()
      return client.search(query, signal)
    },
    flag(input) {
      check()
      return client.flag(input, signal)
    },
  }
}

function registration(reg: AppServiceRegistration, uid: number | undefined) {
  const lifetime = new AbortController()
  const client = privateClient(reg, uid, lifetime.signal)
  const ports = new WeakMap<Lane, ReturnType<typeof createLaneBrain>>()
  return {
    lifetime,
    port(lane: Lane, title: string) {
      const sessionId = lane.piSessionId()
      if (!reg.recall || !sessionId) return undefined
      let port = ports.get(lane)
      if (!port) {
        port = createLaneBrain(client, { sessionId, cwd: lane.cwd, title })
        ports.set(lane, port)
      }
      return port
    },
  }
}

/** Only an attested owner's connection can install this capability. Only recall preference survives it. */
export function createAppServices(directory: string, uid: number | undefined) {
  const lanes = new Map<string, Lane>()
  let active: ReturnType<typeof registration> | undefined
  const known = () =>
    readSidecar(
      directory,
      sidecar,
      (raw) =>
        raw.version === 1 && typeof raw.recall === 'boolean' ? { recall: raw.recall } : null,
      { uid },
    )
  const handlers = {
    'app.service.register': async (reg, call) => {
      call.signal.throwIfAborted()
      const next = registration(reg, uid)
      writeSidecar(
        directory,
        sidecar,
        { version: 1, recall: reg.recall },
        { uid, known: ['version', 'recall', 'endpoint', 'token'] },
      )
      active?.lifetime.abort()
      active = next
      call.signal.addEventListener(
        'abort',
        () => {
          next.lifetime.abort()
          active = undefined
        },
        { once: true, signal: next.lifetime.signal },
      )
      return { registered: true }
    },
  } satisfies OwnerHandlers
  return {
    handlers,
    status(): NonNullable<LocalStatus['appServices']> {
      return { brain: active ? 'registered' : known().state === 'ok' ? 'known' : 'none' }
    },
    resources(root: string) {
      const read = known()
      if (read.state === 'ok' && read.value.recall)
        return {
          extensions: [join(root, 'brain-ext/brain.mjs')],
          skills: [join(root, 'skills/brain')],
        }
      return undefined
    },
    attachLane(handle: string, cwd: string, piSessionId: Lane['piSessionId']) {
      const lane = { piSessionId, cwd }
      lanes.set(handle, lane)
      return () => {
        if (lanes.get(handle) === lane) lanes.delete(handle)
      }
    },
    forLane(handle: string, title: string) {
      const lane = lanes.get(handle)
      return lane && active?.port(lane, title)
    },
  }
}
export type AppServices = ReturnType<typeof createAppServices>
/** What this service adds to `phosphor version --json`. */
export const FEATURE: HostReleaseFeature | null = 'app-services'
