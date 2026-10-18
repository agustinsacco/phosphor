import { DEFAULT_CONTROL_URL } from '@shared/control-api'
import { createControlState } from './client-state'
import { createControlOperations } from './operations'
import type { TraceLog } from './observations'

export { controlFailure } from './transport'

export function controlUrl(packaged: boolean, env: NodeJS.ProcessEnv): string {
  const raw = packaged ? DEFAULT_CONTROL_URL : (env.PHOSPHOR_CONTROL_URL ?? DEFAULT_CONTROL_URL)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid control server address.')
  }
  const local =
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !local) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid control server address.')
  return url.origin
}

/** Main-only account-admitted control operations. Tokens remain request-local. */
export function createControlClient(ports: {
  baseUrl: () => string
  accessToken: () => Promise<string | null>
  generation: () => number
  fetch?: typeof fetch
  version?: () => string
  log?: TraceLog
  now?: () => number
}) {
  const log = ports.log ?? (() => {})
  const now = ports.now ?? Date.now
  const state = createControlState({
    ...ports,
    log,
    now,
    clearObservations: () => operations.clearObservations(),
  })
  const operations = createControlOperations({ ...state, log, now })
  return operations
}
