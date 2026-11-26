import { mockMachineUpdate } from './machineUpdate'
import { mockSandboxOp } from './sandboxOps'
import type { HostsSnapshot, IpcInvokeMap, OpsChangedEvent } from '@phosphor/shared/ipc'
import { parseOpsRunRequest, type OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import {
  AGENT_POLICY_DEFAULT,
  parseAgentPolicy,
  type AgentOpRow,
  type AgentPolicy,
  type ConfirmInfo,
} from '@phosphor/shared/ops'

export const OPS_MOCK: ReadonlySet<string> = new Set<keyof IpcInvokeMap>(['ops:run'])
const ok = (data?: unknown): OpsRunResult => ({ status: 'ok', text: 'Done', applies: 'now', data })
const unsupported: OpsRunResult = {
  status: 'denied',
  code: 'unsupported',
  text: 'This machine does not offer agent control.',
}
interface Machine {
  policy: AgentPolicy
  row: AgentOpRow
  confirm: ConfirmInfo
}
const machines = new Map<string, Machine>()
const listeners = new Set<(event: OpsChangedEvent) => void>()
export function onMockOpsChanged(cb: (event: OpsChangedEvent) => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
function changed(machine: string, kind: OpsChangedEvent['kind']) {
  for (const listener of listeners) listener({ machine, kind })
}
/** Opt in to the new Host handshake. The default directory still exercises rolling release. */
export function mockOpsSnapshot(snapshot: HostsSnapshot) {
  if (localStorage.getItem('mock:ops') === '1')
    for (const host of Object.values(snapshot)) {
      host.ops = true
      host.sandboxes = true
    }
  return snapshot
}
function fixture(machine: string): Machine {
  const existing = machines.get(machine)
  if (existing) return existing
  const reason = 'Keep the current task easy to find.'
  const fresh: Machine = {
    policy: AGENT_POLICY_DEFAULT,
    row: {
      id: 'change-1',
      at: Date.now() - 60000,
      principal: 'agent:demo',
      laneTitle: 'Demo lane',
      op: 'lane.pin',
      tier: 'lane',
      scope: 'self',
      argsSummary: '{}',
      reason,
      decision: 'allowed',
      result: 'Pinned the lane.',
      undo: true,
    },
    confirm: {
      confirmId: '00000000-0000-4000-8000-000000000001',
      digest: 'aa'.repeat(32),
      state: 'pending',
      op: 'archive.purge',
      origin: { kind: 'local', label: 'Command line' },
      title: 'Phosphor: Purge one archive',
      message:
        'Purge archive demo-archive on this machine.\nThe agent’s stated reason: The review is complete.',
      items: [
        { hostId: null, op: 'archive.purge', ids: ['demo-archive'], labels: ['Demo archive'] },
      ],
      expiresAt: Date.now() + 600000,
    },
  }
  machines.set(machine, fresh)
  return fresh
}
export async function mockOpsInvoke(args: unknown[]): Promise<OpsRunResult> {
  const [target, request] = args as [IpcInvokeMap['ops:run']['args'][0], unknown]
  const req = parseOpsRunRequest(request)
  if (!req || !target) return { status: 'denied', code: 'bad-request', text: 'Invalid operation.' }
  if (target.kind === 'remote' && localStorage.getItem('mock:ops') !== '1') return unsupported
  const key = target.kind === 'local' ? 'local' : `host:${target.hostId}`
  const update = mockMachineUpdate(key, req)
  if (update) return update
  const sandbox = target.kind === 'remote' ? mockSandboxOp(key, req) : undefined
  if (sandbox) return sandbox
  const m = fixture(key)
  switch (req.op) {
    case 'policy.show':
      return ok({ policy: m.policy, changedOutside: false })
    case 'policy.set': {
      const policy = parseAgentPolicy(req.args.policy)
      if (!policy) return { status: 'denied', code: 'bad-request', text: 'Invalid policy.' }
      m.policy = policy
      changed(key, 'policy')
      return ok()
    }
    case 'audit.list':
      return ok(!req.args.lane || req.args.lane === m.row.laneRef ? [m.row] : [])
    case 'audit.undo':
      if (req.args.auditId !== m.row.id || !m.row.undo)
        return { status: 'denied', code: 'bad-request', text: 'This change cannot be undone.' }
      m.row = { ...m.row, undo: false, undoneBy: 'You' }
      changed(key, 'audit')
      return ok()
    case 'confirm.list':
      return ok(
        m.confirm.state === 'pending' && m.confirm.expiresAt > Date.now() ? [m.confirm] : [],
      )
    case 'confirm.info':
    case 'confirm.approve':
    case 'confirm.deny': {
      if (req.args.confirmId !== m.confirm.confirmId || m.confirm.expiresAt <= Date.now())
        return { status: 'denied', code: 'confirm-expired', text: 'No pending confirmation.' }
      if (req.op !== 'confirm.info') {
        if (m.confirm.state !== 'pending')
          return { status: 'denied', code: 'confirm-denied', text: 'Already answered.' }
        m.confirm = { ...m.confirm, state: req.op === 'confirm.approve' ? 'approved' : 'denied' }
        changed(key, 'confirm')
      }
      return ok(m.confirm)
    }
    default:
      return unsupported
  }
}
