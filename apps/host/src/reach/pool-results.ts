import type { HostConnectionSnapshot } from '@phosphor/host-client/connection'
import { OPS_UNCONFIRMED, OPS_UNREADABLE } from '@phosphor/host-client/ops'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { ReachResult } from '@phosphor/session-runtime/ops/reach'
import { CONTROL_STAGE_TEXT } from './control'
import { ReachGrantRefused } from './grants'
import type { ReachTarget } from './pool'

export type Failure = Extract<ReachResult, { ok: false }>
export type Attempt = { readonly result: ReachResult } | { readonly lost: true }

export const refused = (code: Failure['code'], message: string): Failure => ({
  ok: false,
  code,
  message,
})

/** The target's own answer: confirmations and in-band denials keep the result as data. */
export function reachAnswer(result: OpsRunResult): ReachResult {
  if (result.status === 'ok') return { ok: true, data: result }
  if (result.status === 'confirm')
    return { ok: false, code: 'needs-confirm', message: result.title, data: result }
  return { ok: false, code: 'denied', message: result.text, data: result }
}

export function grantRefusal(target: ReachTarget, error: unknown): Failure {
  const reason = error instanceof ReachGrantRefused ? error.reason : 'control-unreachable'
  switch (reason) {
    case 'signed-out':
      return refused(
        'forbidden',
        'This machine is not enrolled, so it cannot reach other machines.',
      )
    case 'reach-off':
      return refused(
        'forbidden',
        `Machine reach is off for ${target.label} or for this machine. Turn it on under Machines.`,
      )
    case 'unavailable':
      return refused(
        'offline',
        `${target.label} is offline, has no tailnet address, or runs a Phosphor too old for this.`,
      )
    case 'unknown':
      return refused('bad-request', `${target.label} is not one of your machines.`)
    case 'rate-limited':
      return refused('denied', CONTROL_STAGE_TEXT[reason])
    case 'control-timeout':
      return refused('timeout', CONTROL_STAGE_TEXT[reason])
    default:
      return refused('offline', CONTROL_STAGE_TEXT[reason])
  }
}

export function stateRefusal(target: ReachTarget, view: HostConnectionSnapshot): Failure {
  if (view.lastError === 'forbidden')
    return refused(
      'forbidden',
      `${target.label} refused this machine. Check that machine reach is on there; Phosphor waits a minute before trying again.`,
    )
  if (view.state === 'unsupported')
    return refused('unsupported', `Update that Host: ${target.label}.`)
  if (view.state === 'wrong-machine')
    return refused('forbidden', `${target.label} did not prove it is your enrolled machine.`)
  return refused('offline', `${target.label} is unreachable on your tailnet.`)
}

/** A failure once the request may have left: a write is never retried, a lost read once. */
export function sendFailure(target: ReachTarget, error: unknown, write: boolean): Attempt {
  const message = error instanceof Error ? error.message : String(error)
  const result = (code: Failure['code'], text: string): Attempt => ({ result: refused(code, text) })
  if (message === 'Invalid agent op request.')
    return result('bad-request', 'That operation request is not valid.')
  if (write)
    return message === OPS_UNCONFIRMED || message === OPS_UNREADABLE
      ? result(
          'unconfirmed',
          `${target.label} did not confirm the change. Check it before you try again.`,
        )
      : result('offline', `${target.label} could not take the request.`)
  if (message === 'Connection closed.' || message === 'Connection unavailable.')
    return { lost: true }
  if (message === 'Query timed out.')
    return result('timeout', `${target.label} did not answer in time.`)
  if (message === OPS_UNREADABLE) return result('unsupported', `${target.label}: ${OPS_UNREADABLE}`)
  return result('offline', `${target.label} could not take the request.`)
}

export function unsupportedOp(target: ReachTarget, op: string, version?: string): Failure {
  const hostVersion = version ?? target.hostVersion
  const host = hostVersion
    ? `${target.label} runs Host ${hostVersion}`
    : `${target.label} runs a Host`
  return refused('unsupported', `${host}, which does not serve ${op}. Update that Host.`)
}
