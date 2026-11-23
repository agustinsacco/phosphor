/**
 * The title and message of an asked op, rendered by the owner, so the dialog a
 * surface shows is the exact text the confirmation is bound to. Every target is
 * listed by exact id per machine, with the client controlling a lane when it is
 * someone else; the agent's reason sits under a fixed line; the last line is
 * `Request <first 8 of confirmId>`. Agent-written text is flattened to one line
 * so it cannot fake a list entry or the request line.
 */
import { OPS_LIMITS, type ConfirmItem } from '@phosphor/shared/host-protocol-ops'
import { CONFIRM_TITLE_PREFIX, type AuditDecision, type ConfirmInfo } from '@phosphor/shared/ops'
import type { OpsDenyCode } from '@phosphor/shared/host-protocol-ops'

/** One machine's share of an asked op, with what only the message needs. */
export interface ConfirmTarget extends ConfirmItem {
  /** The machine's name in the message; absent means this machine. */
  readonly machineLabel?: string
  /** Per id, in `ids` order: the connected client controlling that lane when it is not the asker. */
  readonly controlledBy?: readonly (string | null)[]
}

export const CONFIRM_REASON_HEADING = 'The agent’s stated reason (written by the agent):'
export const CONFIRM_TEXT_LIMITS = { titleUnits: 200, labelUnits: 200 } as const

type Rendered =
  | { readonly ok: true; title: string; message: string; items: ConfirmItem[] }
  | { readonly ok: false; readonly code: 'bad-request' | 'too-large'; readonly text: string }

interface RenderInput {
  readonly origin: ConfirmInfo['origin']
  readonly summary: string
  readonly reason?: string
  readonly targets: readonly ConfirmTarget[]
}

const UNSAFE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g

/** One line: control, bidi and line-separator characters become spaces. */
export function oneLine(text: string): string {
  return text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()
}

/** At most `units` UTF-16 units, never splitting a surrogate pair. */
function cut(text: string, units: number): string {
  let out = ''
  for (const ch of text) {
    if (out.length + ch.length > units) break
    out += ch
  }
  return out
}

function originLine(origin: ConfirmInfo['origin'], summary: string): string {
  const label = oneLine(origin.label)
  if (origin.kind === 'agent') return `The agent in lane “${label}” asks to: ${summary}`
  if (origin.kind === 'machine') return `An agent on ${label} asks to: ${summary}`
  return `${label} asks to: ${summary}`
}

function targetLines(target: ConfirmTarget, labels: boolean): string[] {
  const lines = [`On ${target.machineLabel ? oneLine(target.machineLabel) : 'this machine'}:`]
  target.ids.forEach((id, i) => {
    const label = target.labels[i]
    const named = labels && label !== id ? `${label} (${id})` : id
    const controller = target.controlledBy?.[i]
    lines.push(`• ${named}${controller ? ` — controlled by ${oneLine(controller)}` : ''}`)
  })
  if (target.ids.length === 0) lines.push(`• ${target.op}`)
  return lines
}

function badTarget(t: ConfirmTarget): boolean {
  return (
    t.ids.length > OPS_LIMITS.idsPerOp ||
    t.labels.length !== t.ids.length ||
    (t.controlledBy !== undefined && t.controlledBy.length !== t.ids.length)
  )
}

export function renderConfirm(input: RenderInput, confirmId: string): Rendered {
  const { targets } = input
  if (targets.length < 1 || targets.length > OPS_LIMITS.hostsPerBatch || targets.some(badTarget))
    return { ok: false, code: 'bad-request', text: 'The confirmation’s targets are not valid.' }
  const summary = oneLine(input.summary)
  const title = cut(`${CONFIRM_TITLE_PREFIX}${summary}`, CONFIRM_TEXT_LIMITS.titleUnits)
  const shown: ConfirmTarget[] = targets.map((t) => ({
    ...t,
    labels: t.labels.map(
      (l, i) => cut(oneLine(l), CONFIRM_TEXT_LIMITS.labelUnits) || (t.ids[i] ?? l),
    ),
  }))
  const items: ConfirmItem[] = shown.map((t) => ({
    hostId: t.hostId,
    op: t.op,
    ids: [...t.ids],
    labels: [...t.labels],
    ...(t.confirmId !== undefined && t.digest !== undefined
      ? { confirmId: t.confirmId, digest: t.digest }
      : {}),
  }))
  const reason = input.reason === undefined ? '' : oneLine(input.reason)
  const render = (labels: boolean) =>
    [
      originLine(input.origin, summary),
      '',
      ...shown.flatMap((target) => [...targetLines(target, labels), '']),
      CONFIRM_REASON_HEADING,
      reason || '(no reason given)',
      '',
      `Request ${confirmId.slice(0, 8)}`,
    ].join('\n')
  for (const labels of [true, false]) {
    const message = render(labels)
    if (Buffer.byteLength(message, 'utf8') <= OPS_LIMITS.resultBytes)
      return { ok: true, title, message, items }
  }
  return {
    ok: false,
    code: 'too-large',
    text: 'Too many targets for one confirmation. Ask for fewer at a time.',
  }
}

/** What redeeming a confirmation that did not approve answers, and how the audit records it. */
export const REDEMPTION: Readonly<
  Record<
    'denied' | 'expired' | 'mismatch',
    { code: OpsDenyCode; decision: AuditDecision; text: string }
  >
> = {
  denied: { code: 'confirm-denied', decision: 'denied-user', text: 'The user denied this.' },
  expired: {
    code: 'confirm-expired',
    decision: 'timeout',
    text: 'This confirmation expired. Ask again.',
  },
  mismatch: {
    code: 'confirm-mismatch',
    decision: 'denied-policy',
    text: 'This confirmation does not match the request. Ask again.',
  },
}
