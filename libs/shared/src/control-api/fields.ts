/**
 * Parse results and the pure field rules every control-plane parser shares:
 * labels, hostnames, versions, endpoints, times, ids, counts and the nested
 * readiness, lane and account shapes. Parsers keep known fields only.
 *
 * ok, fail, isRecord, isIso, isCount, oneOf, readiness, lanes, account and
 * optional serve the parser modules only; `../control-api` does not export them.
 */

import { CONTROL_LIMITS } from './constants'
import type { AccountHandle, LaneCounts, Readiness } from './types'

export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }

export const ok = <T>(value: T): Parsed<T> => ({ ok: true, value })
export const fail = <T>(reason: string): Parsed<T> => ({ ok: false, reason })

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && uuid.test(value)

// eslint-disable-next-line no-control-regex
const control = /[\u0000-\u001f\u007f-\u009f]/
/** Bidi controls reorder what is shown, and line separators split it. */
const invisible = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/

/** Trimmed, 1-80 characters, no control characters. */
export function normalizeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value.trim()
  if (
    label.length < 1 ||
    label.length > CONTROL_LIMITS.labelChars ||
    control.test(label) ||
    invisible.test(label)
  )
    return null
  return label
}

const hostnamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$/
export const isHostname = (value: unknown): value is string =>
  typeof value === 'string' && hostnamePattern.test(value)

const versionPattern = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,64})?$/
export const isVersion = (value: unknown): value is string =>
  typeof value === 'string' && versionPattern.test(value)

const endpointPattern = /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,252})(?::([1-9][0-9]{0,4}))?$/
/** A bare HTTPS origin such as https://bee1.tail9f6158.ts.net: no path, no credentials. */
export function isEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = endpointPattern.exec(value)
  return match !== null && (match[1] === undefined || Number(match[1]) <= 65_535)
}

const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/**
 * A UTC time exactly as toISOString() writes it, the one form every side
 * sends. Date.parse alone is not enough: it takes '1', and it reads a time
 * without a zone as local time, which would skew every up/down judgement.
 */
export function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string' || !isoPattern.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}
export const isIso = isIsoTime

export const isCount = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max

export const oneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (options as readonly string[]).includes(value)

const READINESS = {
  pi: ['ok', 'missing', 'outdated', 'unknown'],
  claude: ['ok', 'missing', 'signed-out', 'unknown'],
  tailscale: ['ok', 'missing', 'stopped', 'no-https', 'unknown'],
} as const

export function readiness(value: unknown): Readiness | null {
  if (!isRecord(value)) return null
  if (!oneOf(READINESS.pi, value.pi)) return null
  if (!oneOf(READINESS.claude, value.claude)) return null
  if (!oneOf(READINESS.tailscale, value.tailscale)) return null
  return { pi: value.pi, claude: value.claude, tailscale: value.tailscale }
}

export function lanes(value: unknown): LaneCounts | null {
  if (!isRecord(value)) return null
  if (!isCount(value.running, CONTROL_LIMITS.maxLanes)) return null
  if (!isCount(value.waiting, CONTROL_LIMITS.maxLanes)) return null
  return { running: value.running, waiting: value.waiting }
}

export function account(value: unknown): AccountHandle | null {
  if (!isRecord(value)) return null
  if (value.login === null) return { login: null }
  if (typeof value.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(value.login)) return null
  return { login: value.login }
}

export const optional = <T>(value: unknown, check: (v: unknown) => v is T): T | null | undefined =>
  value === null ? null : check(value) ? value : undefined
