import { createHash, randomBytes } from 'node:crypto'
import { CONTROL_ROUTES, parseMeResponse, type MeResponse, type Parsed } from '@shared/control-api'
import type { ControlResult } from '@shared/ipc'
import {
  controlFailure,
  createControlTransport,
  type ControlRequest,
  type ControlTransportPorts,
} from './transport'

interface ControlStatePorts extends ControlTransportPorts {
  accessToken: () => Promise<string | null>
  generation: () => number
  clearObservations: () => void
}

interface ClientState {
  observedGeneration: number
  // Account identity retains only a digest, never a token. Refreshes re-ask /me.
  me: { generation: number; tokenId: string; promise: Promise<ControlResult<MeResponse>> } | null
}

export const newControlTrace = () => randomBytes(8).toString('hex')

function syncGeneration(
  state: ClientState,
  ports: ControlStatePorts,
  generation = ports.generation(),
) {
  if (state.observedGeneration !== generation) {
    ports.clearObservations()
    state.observedGeneration = generation
  }
}

async function call<T extends object>(
  state: ClientState,
  ports: ControlStatePorts,
  request: ControlRequest,
  path: string,
  method: string,
  parse: (value: unknown) => Parsed<T>,
  body?: unknown,
  trace = newControlTrace(),
): Promise<ControlResult<T>> {
  try {
    const generation = ports.generation()
    syncGeneration(state, ports, generation)
    if (state.me?.generation !== generation) state.me = null
    const token = await ports.accessToken()
    if (!token || ports.generation() !== generation) {
      ports.clearObservations()
      state.me = null
      return controlFailure('signed-out')
    }
    const tokenId = createHash('sha256').update(token).digest('hex')
    if (state.me?.tokenId !== tokenId) state.me = null
    if (!state.me) {
      const cached = {
        generation,
        tokenId,
        promise: request(token, CONTROL_ROUTES.me, 'GET', parseMeResponse, undefined, trace),
      }
      state.me = cached
      void cached.promise.then((result) => {
        if (!result.ok && state.me === cached) state.me = null
      })
    }
    const account = await state.me.promise
    if (ports.generation() !== generation) return controlFailure('signed-out')
    if (!account.ok) return account
    if (!account.enabled) return controlFailure('forbidden')
    const result = await request(token, path, method, parse, body, trace)
    return ports.generation() === generation ? result : controlFailure('signed-out')
  } catch {
    return controlFailure('offline')
  }
}

/** Account admission and single-flight /me ownership, independent of endpoint parsers. */
export function createControlState(ports: ControlStatePorts) {
  const state: ClientState = { observedGeneration: ports.generation(), me: null }
  const request = createControlTransport(ports, () => {
    ports.clearObservations()
    state.me = null
  })
  return {
    syncGeneration: () => syncGeneration(state, ports),
    call<T extends object>(
      path: string,
      method: string,
      parse: (value: unknown) => Parsed<T>,
      body?: unknown,
      trace = newControlTrace(),
    ) {
      return call(state, ports, request, path, method, parse, body, trace)
    },
  }
}

export type ControlCall = ReturnType<typeof createControlState>['call']
