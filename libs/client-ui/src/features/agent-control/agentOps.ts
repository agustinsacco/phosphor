import type { OpsRunRequest, OpsDenyCode } from '@phosphor/shared/host-protocol-ops'
import { parseOpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { parseAgentPolicy, type ConfirmInfo, type AgentOpRow } from '@phosphor/shared/ops'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

export class OpDenied extends Error {
  constructor(
    readonly code: OpsDenyCode,
    message: string,
  ) {
    super(message)
  }
}
export function machineEventKey(machine: string) {
  return machine === 'local' ? 'local' : `host:${machine}`
}
export async function runAgentOp(
  machine: string,
  op: string,
  args: OpsRunRequest['args'] = {},
  page?: string,
) {
  const result = await window.phosphor.invoke(
    'ops:run',
    machine === 'local' ? { kind: 'local' } : { kind: 'remote', hostId: machine },
    { op, args, ...(page ? { page } : {}) },
  )
  if (result?.status === 'denied') throw new OpDenied(result.code, result.text)
  if (result?.status !== 'ok') throw Error('This machine did not confirm the operation.')
  return result
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const unreadable = () => Error('This machine returned data that Phosphor could not read.')
export async function readPolicy(machine: string) {
  const { data } = await runAgentOp(machine, 'policy.show')
  const policy = record(data) && parseAgentPolicy(data.policy)
  if (!policy || !record(data) || typeof data.changedOutside !== 'boolean') throw unreadable()
  return { policy, changedOutside: data.changedOutside }
}
export function parseConfirmInfo(data: unknown): ConfirmInfo {
  if (!record(data) || !record(data.origin)) throw unreadable()
  const frame = parseOpsRunResult({ ...data, status: 'confirm' })
  const { op, state, reason, dialogId, origin } = data
  if (
    frame?.status !== 'confirm' ||
    typeof op !== 'string' ||
    !['agent', 'machine', 'local'].includes(String(origin.kind)) ||
    typeof origin.label !== 'string' ||
    !['pending', 'approved', 'denied', 'expired'].includes(String(state)) ||
    (reason !== undefined && typeof reason !== 'string') ||
    (dialogId !== undefined && typeof dialogId !== 'string')
  )
    throw unreadable()
  return {
    ...frame,
    op,
    state: state as ConfirmInfo['state'],
    origin: { kind: origin.kind as ConfirmInfo['origin']['kind'], label: origin.label },
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(typeof dialogId === 'string' ? { dialogId } : {}),
  }
}
export async function readConfirm(
  machine: string,
  args: { dialogId: string } | { confirmId: string },
) {
  return parseConfirmInfo((await runAgentOp(machine, 'confirm.info', args)).data)
}
export async function pendingConfirms(machine: string) {
  const { data } = await runAgentOp(machine, 'confirm.list')
  if (!Array.isArray(data)) throw unreadable()
  return data
    .map(parseConfirmInfo)
    .filter((i) => i.state === 'pending' && i.origin.kind !== 'agent')
}
function auditRow(v: unknown): v is AgentOpRow {
  return (
    record(v) &&
    ['id', 'op', 'decision', 'principal', 'result', 'argsSummary'].every(
      (k) => typeof v[k] === 'string',
    ) &&
    typeof v.at === 'number' &&
    typeof v.undo === 'boolean' &&
    ['reason', 'target', 'laneRef', 'laneTitle', 'applies', 'undoneBy'].every(
      (k) => v[k] === undefined || typeof v[k] === 'string',
    )
  )
}
export async function readChanges(machine: string, lane?: string, page?: string) {
  const { data, next } = await runAgentOp(machine, 'audit.list', lane ? { lane } : {}, page)
  if (!Array.isArray(data) || !data.every(auditRow)) throw unreadable()
  return { rows: data, next }
}
export function useOpsConnection(machine: string) {
  return useRemoteLanesStore((s) => {
    const host = s.hosts[machine]
    return host?.ops && host.state === 'ready' ? (host.connectionToken ?? 'ready') : null
  })
}
