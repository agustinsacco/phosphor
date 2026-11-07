import { meetsMinimum } from '@phosphor/shared/version'
import type { LaneRuntimeFacts } from '@phosphor/shared/lane-transfer-runtime'
import type { LaneSourceFacts } from '@phosphor/shared/host-protocol-lane-transfer'

export interface TransferRuntime {
  piVersion: string | null
  claudeVersion: string | null
  /** Null for a version-only source probe; an authoritative catalogue on the target. */
  models: { id: string; provider: string }[] | null
}
export type RuntimeProbe = (models: boolean, cwd?: string) => Promise<TransferRuntime>

/** Runtime prerequisites, checked without sending a prompt or restoring the lane. */
export function runtimeBlockers(source: LaneSourceFacts, target: TransferRuntime): string[] {
  const facts = source.runtime
  const blockers: string[] = []
  if (!facts?.piVersion || !target.piVersion)
    blockers.push('Pi’s version could not be checked on both machines.')
  else if (!meetsMinimum(target.piVersion, facts.piVersion))
    blockers.push('Update pi on the target: it is older than the source’s pi.')
  if (
    facts?.provider &&
    facts.model &&
    !target.models?.some((m) => m.provider === facts.provider && m.id === facts.model)
  )
    blockers.push('This lane’s provider and model are unavailable on the target.')
  if (
    facts?.provider === 'pi-claude-cli' &&
    (!target.claudeVersion || !meetsMinimum(target.claudeVersion, '0.10.0'))
  )
    blockers.push('Update pi-claude-cli on the target to 0.10.0 or newer.')
  return blockers
}

export function sourceRuntime(
  runtime: TransferRuntime,
  model: { provider: string | null; model: string | null },
): LaneRuntimeFacts {
  return { piVersion: runtime.piVersion, claudeVersion: runtime.claudeVersion, ...model }
}
