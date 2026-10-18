import type { IncomingMessage } from 'node:http'
import { DEFAULT_CONTROL_URL } from '@phosphor/shared/control-api'
import { isControlUrl } from '../control/url'

export const DEFAULT_WEB_ORIGIN = 'https://phosphor-app.saccolabs.com'

/** Require the serialized bare origin, rather than accepting URL aliases. */
export function isWebOrigin(value: unknown): value is string {
  return isControlUrl(value) && !value.includes('*')
}

export function resolveWebOrigin(controlOrigin: string, configured?: string | null): string | null {
  if (configured === null) return null
  if (configured !== undefined) {
    if (!isWebOrigin(configured)) throw new Error('Invalid browser origin')
    return configured
  }
  return controlOrigin === DEFAULT_CONTROL_URL ? DEFAULT_WEB_ORIGIN : null
}

/** Duplicate fields are refused even if a parser joins them or keeps only one. */
export function admitsBrowserOrigin(request: IncomingMessage, allowed: string | null): boolean {
  let count = 0
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === 'origin') count++
  }
  if (count === 0 && request.headers.origin === undefined) return true
  return count === 1 && allowed !== null && request.headers.origin === allowed
}
