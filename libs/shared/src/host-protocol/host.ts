/** parseHostFrame: one Host frame, accepted as a projection or refused as host-frame. */
import { isIsoTime, type Parsed } from '../control-api'
import { parseTerminalFrame } from '../host-protocol-terminals'
import { HOST_CLOSE, HOST_LIMITS, type HostCloseCode } from './constants'
import type { HostFrame } from './frames'
import {
  parseAttentionFrame,
  parseLanesDeltaFrame,
  parseLanesFrame,
  parseRoutinesChangedFrame,
} from './host-lanes'
import { capabilities, parseReadyFrame } from './host-ready'
import { parseReceipt, parseResultFrame } from './host-receipts'
import { parseEventFrame, parseSnapshotFrame } from './host-snapshot'
import { frameId, integer, member, readJson, text } from './primitives'

function hostClose(code: number): HostCloseCode {
  for (const c of Object.values(HOST_CLOSE)) if (c === code) return c
  return HOST_CLOSE.badFrame
}

function parseErrorFrame(v: Record<string, unknown>): Extract<HostFrame, { type: 'error' }> | null {
  return typeof v.code === 'number' &&
    Object.values(HOST_CLOSE).some((x) => x === v.code) &&
    text(v.message, HOST_LIMITS.messageChars)
    ? { type: 'error', code: hostClose(v.code), message: v.message }
    : null
}

function hostFrame(v: Record<string, unknown>): HostFrame | null {
  if (typeof v.type === 'string' && v.type.startsWith('terminal.')) return parseTerminalFrame(v)
  switch (v.type) {
    case 'ready':
      return parseReadyFrame(v)
    case 'auth-renewed':
      return isIsoTime(v.grantExpiresAt) &&
        (v.capabilities === undefined || capabilities(v.capabilities))
        ? {
            type: v.type,
            grantExpiresAt: v.grantExpiresAt,
            ...(v.capabilities ? { capabilities: v.capabilities } : {}),
          }
        : null
    case 'lanes':
      return parseLanesFrame(v)
    case 'routines-changed':
      return parseRoutinesChangedFrame(v)
    case 'lanes-delta':
      return parseLanesDeltaFrame(v)
    case 'attention':
      return parseAttentionFrame(v)
    case 'snapshot':
      return parseSnapshotFrame(v)
    case 'event':
      return parseEventFrame(v)
    case 'subscribe-failed':
      return frameId(v.id) &&
        member(v.code, ['unknown-lane', 'too-many', 'forbidden', 'bad-request', 'too-large'])
        ? { type: v.type, id: v.id, code: v.code }
        : null
    case 'receipt': {
      const r = parseReceipt(v.receipt)
      return r ? { type: v.type, receipt: r } : null
    }
    case 'result':
      return parseResultFrame(v)
    case 'error':
      return parseErrorFrame(v)
    case 'pong':
      return integer(v.at) ? { type: v.type, at: v.at } : null
    default:
      return null
  }
}

/** Every refusal after a successful read is the same `host-frame` reason. */
export function parseHostFrame(s: string): Parsed<HostFrame> {
  const p = readJson(s, HOST_LIMITS.outboundFrameBytes)
  if (!p.ok) return p
  const frame = hostFrame(p.value)
  return frame ? { ok: true, value: frame } : { ok: false, reason: 'host-frame' }
}
