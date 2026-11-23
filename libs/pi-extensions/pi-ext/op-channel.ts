import { randomUUID } from 'node:crypto'
import type { LaneEffect, OpReplyEnvelope, OpRequestEnvelope } from '@phosphor/shared/ops'

/** Only types come from the app. pi loads this file with its shipped siblings. */
type Options = { signal?: AbortSignal; deadlineMs?: number }
export type OpSender = (
  ctx: unknown,
  request: { op: string; args: Record<string, unknown>; reason?: string; content?: string },
  opts?: Options,
) => Promise<OpReplyEnvelope>
type Payload = Omit<OpRequestEnvelope, 'v' | 'id' | 'deadlineMs'>
export const OP_TITLE = 'phosphor-op/v1'
// Runtime imports must resolve from pi's shipped siblings. Mirror OPS_LIMITS here.
const ARGS_BYTES = 300 * 1024
const CONTENT_BYTES = 256 * 1024
const PREFILL_BYTES = 2 * ARGS_BYTES
/** The mirrored limits; a test keeps them equal to OPS_LIMITS and OP_CHANNEL_LIMITS. */
export const LANE_OP_LIMITS = { ARGS_BYTES, CONTENT_BYTES, PREFILL_BYTES } as const
const MAX_DEADLINE = 600_000
const error = (
  id: string,
  code: Extract<OpReplyEnvelope, { status: 'denied' | 'error' }>['code'],
  text: string,
): OpReplyEnvelope => ({ v: 1, id, status: 'error', code, text })

function validEffect(e: LaneEffect): boolean {
  switch (e?.kind) {
    case 'swarm':
      return typeof e.enabled === 'boolean' && typeof e.reason === 'string'
    case 'contextFiles':
      return typeof e.args === 'string'
    case 'pr':
      return ['pin', 'hide', 'clear'].includes(e.action) && typeof e.url === 'string'
    case 'notify':
      return ['info', 'warning'].includes(e.level) && typeof e.message === 'string'
    default:
      return false
  }
}

function decode(raw: string | undefined, id: string): OpReplyEnvelope {
  if (raw === undefined) return { v: 1, id, status: 'unsupported', code: 'no-owner' }
  const invalid = error(id, 'bad-request', 'Invalid reply from the Phosphor service.')
  let r: OpReplyEnvelope
  try {
    r = JSON.parse(raw) as OpReplyEnvelope
  } catch {
    return invalid
  }
  if (r?.v !== 1 || r.id !== id) return invalid
  switch (r.status) {
    case 'unsupported':
      return r.code === 'no-owner' ? r : invalid
    case 'denied':
    case 'error':
      return typeof r.text === 'string' && typeof r.code === 'string' ? r : invalid
    case 'confirm':
      return typeof r.confirmId === 'string' &&
        typeof r.digest === 'string' &&
        /^[0-9a-f]{64}$/.test(r.digest) &&
        typeof r.title === 'string' &&
        typeof r.message === 'string' &&
        Number.isSafeInteger(r.timeoutMs) &&
        r.timeoutMs > 0 &&
        r.timeoutMs <= MAX_DEADLINE
        ? r
        : invalid
    case 'ok':
      return typeof r.text === 'string' &&
        ['now', 'next-request', 'after-run', 'reload', 'new-lanes'].includes(r.applies) &&
        (r.effects === undefined || (Array.isArray(r.effects) && r.effects.every(validEffect))) &&
        (r.untrusted === undefined || r.untrusted === true) &&
        (r.terminate === undefined || r.terminate === true) &&
        (r.auditId === undefined || typeof r.auditId === 'string') &&
        (r.next === undefined ||
          (typeof r.next === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(r.next)))
        ? r
        : invalid
    default:
      return invalid
  }
}

type Editor = (title: string, prefill: string) => Promise<string | undefined>
export async function sendOpRequest(
  ctx: unknown,
  request: Payload,
  { signal, deadlineMs = 30_000 }: Options = {},
): Promise<OpReplyEnvelope> {
  const id = randomUUID()
  const context = ctx as { hasUI?: boolean; ui?: { editor?: Editor } } | undefined
  const ui = context?.ui
  if (context?.hasUI === false || !ui?.editor)
    return { v: 1, id, status: 'unsupported', code: 'no-owner' }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE)
    return error(id, 'bad-request', 'Invalid deadline.')
  const aborted = () => error(id, 'aborted', 'Operation stopped.')
  if (signal?.aborted) return aborted()
  const prefill = JSON.stringify({ ...request, v: 1, id, deadlineMs } satisfies OpRequestEnvelope)
  if (Buffer.byteLength(prefill) > PREFILL_BYTES)
    return error(id, 'too-large', 'That request is too large to send; split the content.')
  const contentBytes = Buffer.byteLength(request.content ?? '')
  const argsBytes = Buffer.byteLength(JSON.stringify(request.argv ?? request.input) ?? '')
  if (contentBytes > CONTENT_BYTES || argsBytes + contentBytes > ARGS_BYTES)
    return error(
      id,
      'too-large',
      'Content exceeds the 256 KiB or request exceeds the 300 KiB limit.',
    )
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    // The owner must still answer pi's pending editor id. Never process a late reply.
    const stop = new Promise<OpReplyEnvelope>((resolve) => {
      abort = () => resolve(aborted())
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(
        () => resolve(error(id, 'timeout', 'Phosphor did not answer in time.')),
        deadlineMs + 2000,
      )
    })
    const winner = await Promise.race([ui.editor(OP_TITLE, prefill), stop])
    return typeof winner === 'object' && winner !== null ? winner : decode(winner, id)
  } catch {
    return error(id, 'unavailable', 'The Phosphor service could not answer.')
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

export const sendOp: OpSender = (ctx, { op, args, reason, content }, opts) =>
  sendOpRequest(ctx, { op, input: args, reason, content }, opts)
