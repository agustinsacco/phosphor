/** Command receipts and call results, with every code each may carry. */
import { isUuid } from '../control-api'
import { HOST_LIMITS } from './constants'
import type { HostFrame } from './frames'
import { parseLaneControl } from './host-lanes'
import type { CallErrorCode, Receipt, RejectCode } from './operations'
import { frameId, integer, member, record, text, utf8Length } from './primitives'

type Frame<T extends HostFrame['type']> = Extract<HostFrame, { type: T }>

const rejects: readonly RejectCode[] = [
  'bad-request',
  'unsupported',
  'forbidden',
  'unknown-lane',
  'lane-stopped',
  'not-controller',
  'stale-fence',
  'conflict',
  'busy',
  'last-repository',
  'branch-exists',
  'too-many-requests',
]
const errors: readonly CallErrorCode[] = [
  'bad-request',
  'unsupported',
  'forbidden',
  'unknown-lane',
  'lane-stopped',
  'too-large',
  'internal',
]

/** A done receipt's data is refused, not truncated, past its UTF-8 byte limit. */
export function parseReceipt(v: unknown): Receipt | null {
  if (!record(v) || !isUuid(v.requestId)) return null
  const requestId = v.requestId
  switch (v.status) {
    case 'pending':
    case 'unknown':
      return { requestId, status: v.status }
    case 'done':
      if (
        (v.fence !== undefined && !integer(v.fence, 1)) ||
        (v.laneId !== undefined && !isUuid(v.laneId))
      )
        return null
      try {
        if (
          v.data !== undefined &&
          utf8Length(JSON.stringify(v.data)) > HOST_LIMITS.receiptDataBytes
        )
          return null
      } catch {
        // Valid JSON can nest deeper than the serializer's stack allows.
        return null
      }
      return {
        requestId,
        status: v.status,
        ...(v.data !== undefined ? { data: v.data } : {}),
        ...(v.fence !== undefined ? { fence: v.fence } : {}),
        ...(v.laneId !== undefined ? { laneId: v.laneId } : {}),
      }
    case 'failed':
      return record(v.error) &&
        member(v.error.code, ['pi-error', 'timeout', 'internal']) &&
        text(v.error.message, HOST_LIMITS.messageChars)
        ? { requestId, status: v.status, error: { code: v.error.code, message: v.error.message } }
        : null
    case 'rejected': {
      const c = v.control === undefined ? undefined : parseLaneControl(v.control)
      return member(v.code, rejects) && c !== null
        ? { requestId, status: v.status, code: v.code, ...(c ? { control: c } : {}) }
        : null
    }
    default:
      return null
  }
}

/** A successful result's data is free-form and never inspected. */
export function parseResultFrame(v: Record<string, unknown>): Frame<'result'> | null {
  if (!frameId(v.id)) return null
  if (v.ok === true && 'data' in v) return { type: 'result', id: v.id, ok: true, data: v.data }
  return v.ok === false &&
    record(v.error) &&
    member(v.error.code, errors) &&
    text(v.error.message, HOST_LIMITS.messageChars)
    ? {
        type: 'result',
        id: v.id,
        ok: false,
        error: { code: v.error.code, message: v.error.message },
      }
    : null
}
