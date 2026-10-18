/**
 * Health, error bodies and the client-side up/down judgement of a machine.
 */

import {
  CONTROL_ERROR_STATUS,
  CONTROL_LIMITS,
  type ControlErrorBody,
  type ControlErrorCode,
} from './constants'
import { fail, isRecord, ok, type Parsed } from './fields'
import type { HealthResponse, MachineView } from './types'

export function parseHealthResponse(value: unknown): Parsed<HealthResponse> {
  if (!isRecord(value) || value.ok !== true) return fail('ok')
  if (typeof value.version !== 'string' || value.version.length > 100) return fail('version')
  if (typeof value.configured !== 'boolean') return fail('configured')
  return ok({ ok: true, version: value.version, configured: value.configured })
}

/** Own keys only: 'constructor' or 'toString' are not error codes. */
export const isControlErrorCode = (value: unknown): value is ControlErrorCode =>
  typeof value === 'string' && Object.hasOwn(CONTROL_ERROR_STATUS, value)

/** A server error body, or null if the bytes were not one. Messages are capped for display. */
export function parseControlError(value: unknown): ControlErrorBody | null {
  if (!isRecord(value) || !isRecord(value.error)) return null
  const { code, message } = value.error
  if (!isControlErrorCode(code) || typeof message !== 'string') return null
  return { error: { code, message: message.slice(0, 300) } }
}

export type MachineStatus = 'up' | 'down' | 'never-seen'

/**
 * Up or down, judged on the client: the server only records beats, so a
 * machine that stops beating is noticed by the absence of updates.
 * `clockOffsetMs` = serverTime - local time when the list was fetched.
 */
export function machineStatus(
  machine: Pick<MachineView, 'lastSeenAt' | 'state'>,
  nowMs: number,
  clockOffsetMs = 0,
): MachineStatus {
  if (machine.lastSeenAt === null) return 'never-seen'
  if (machine.state !== 'running') return 'down'
  const age = nowMs + clockOffsetMs - Date.parse(machine.lastSeenAt)
  return age <= CONTROL_LIMITS.downAfterSec * 1000 ? 'up' : 'down'
}
