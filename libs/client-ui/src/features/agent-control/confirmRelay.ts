import { ipcErrorText } from '@phosphor/shared/errors'
import { OPS_LIMITS, type ConfirmItem } from '@phosphor/shared/host-protocol-ops'
import type { ConfirmInfo } from '@phosphor/shared/ops'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { readConfirm, runAgentOp } from './agentOps'

interface RelayTarget {
  machine: string
  hostId: string
  confirmId: string
  digest: string
}
export interface ReviewedTarget extends RelayTarget {
  message: string
  error?: string
}
function relayTarget(item: ConfirmItem): RelayTarget | null {
  if (!item.confirmId) return null // The origin itself is answered through the bound dialog or Pending approvals.
  if (!item.hostId || !item.digest) throw Error('This request is missing its target machine.')
  const [key, host] =
    Object.entries(useRemoteLanesStore.getState().hosts).find(
      ([id, h]) => id === item.hostId || h.enrolledHostId === item.hostId,
    ) ?? []
  if (!key || !host?.ops || host.state !== 'ready')
    throw Error(`${machineLabel(item.hostId)}: no connection with agent control.`)
  return {
    machine: host.local ? 'local' : key,
    hostId: item.hostId,
    confirmId: item.confirmId,
    digest: item.digest,
  }
}
async function batches<T, R>(items: readonly T[], run: (item: T) => Promise<R>) {
  const results: R[] = []
  for (let i = 0; i < items.length; i += OPS_LIMITS.batchConcurrency)
    results.push(...(await Promise.all(items.slice(i, i + OPS_LIMITS.batchConcurrency).map(run))))
  return results
}
/** Do not authorize an action described only by the origin. Show the target's
 * own bound message (every exact id and the reason) before enabling Approve. */
export async function reviewTargets(info: ConfirmInfo) {
  const seen = new Set<string>()
  const targets = info.items.flatMap((item) => {
    const target = relayTarget(item)
    if (!target) return []
    const key = `${target.hostId}:${target.confirmId}`
    if (seen.has(key)) return []
    seen.add(key)
    return [target]
  })
  return batches(targets, async (target): Promise<ReviewedTarget> => {
    try {
      const remote = await readConfirm(target.machine, { confirmId: target.confirmId })
      if (
        remote.confirmId !== target.confirmId ||
        remote.digest !== target.digest ||
        remote.state !== 'pending' ||
        remote.expiresAt <= Date.now() ||
        remote.op !== info.op
      )
        throw Error('This pending request no longer matches.')
      return { ...target, message: remote.message }
    } catch (e) {
      return { ...target, message: '', error: ipcErrorText(e) }
    }
  })
}
export async function approveTargets(targets: readonly ReviewedTarget[]) {
  const failures = await batches(targets, async (t) => {
    try {
      if (t.error) throw Error(t.error)
      await runAgentOp(t.machine, 'confirm.approve', { confirmId: t.confirmId })
      return ''
    } catch (e) {
      return `${machineLabel(t.hostId)} (${t.hostId}): ${ipcErrorText(e)}`
    }
  })
  if (failures.some(Boolean)) throw Error(failures.filter(Boolean).join('\n'))
}
