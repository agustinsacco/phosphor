import { grantPrincipal, type GrantPrincipal } from '../../host-grant'
import type { ClientFrame } from '../../host-protocol'
import {
  OPS_RUN,
  parseOpsRunRequest,
  type OpsRunRequest,
  type OpsRunResult,
} from '../../host-protocol-ops'
import { send } from './delivery'
import { rejected } from './receipts'
import type { Connection, FakeHostState } from './state'

/** What a scenario plugs in to serve `ops.run`; `write` is the command form. */
export type FakeOpsHandler = (
  request: OpsRunRequest,
  principal: GrantPrincipal,
  write: boolean,
) => OpsRunResult | Promise<OpsRunResult>

type OpsCall = Extract<ClientFrame, { type: 'call' }>
type OpsCommand = Extract<ClientFrame, { type: 'command' }>

export function isOpsFrame(f: OpsCall | OpsCommand): boolean {
  return (
    (f.type === 'call' && f.method === OPS_RUN) || (f.type === 'command' && f.op.type === OPS_RUN)
  )
}

/**
 * `ops.run`, ahead of capability checks: the plugged handler decides per
 * principal. Without one, either form answers `unsupported`, as an older Host does.
 */
export function ops(state: FakeHostState, c: Connection, f: OpsCall | OpsCommand) {
  const handler = state.ops
  const grant = c.grant
  if (!grant) return
  if (f.type === 'command') {
    if (f.op.type !== OPS_RUN) return
    if (!handler) return rejected(state, c, f.requestId, 'unsupported')
    const { type: _type, ...request } = f.op
    const { requestId } = f
    return answer(
      () => handler(request, grantPrincipal(grant), true),
      (data) => send(state, c, { type: 'receipt', receipt: { requestId, status: 'done', data } }),
      () => send(state, c, { type: 'receipt', receipt: { requestId, status: 'unknown' } }),
    )
  }
  const error = (code: 'unsupported' | 'bad-request' | 'internal') =>
    send(state, c, { type: 'result', id: f.id, ok: false, error: { code, message: code } })
  if (!handler) return error('unsupported')
  const request = parseOpsRunRequest(f.params)
  if (!request) return error('bad-request')
  answer(
    () => handler(request, grantPrincipal(grant), false),
    (data) => send(state, c, { type: 'result', id: f.id, ok: true, data }),
    () => error('internal'),
  )
}

/** A throwing handler reads as a Host that cannot say what happened. */
function answer(
  run: () => OpsRunResult | Promise<OpsRunResult>,
  reply: (result: OpsRunResult) => void,
  failed: () => void,
) {
  void Promise.resolve().then(run).then(reply, failed)
}
