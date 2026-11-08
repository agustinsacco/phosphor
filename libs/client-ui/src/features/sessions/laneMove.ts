import type { HostsSnapshot } from '@shared/ipc'
import type { LaneMovePlan, LaneMoveSource, LaneMoveTarget } from '@shared/lane-move'
import type { SandboxInfo, WorkspaceInfo } from '@shared/models'

export interface MoveWorkspace {
  key: string
  label: string
  target: LaneMoveTarget
}

export interface MoveMachine {
  machine: string
  label: string
  /** Why this machine cannot take the lane, when it cannot. */
  disabled?: string
  workspaces: MoveWorkspace[]
}

export const MOVE_HINTS = {
  offline: 'Not connected.',
  outdated: 'Update this Host to move lanes to it.',
  control: 'This Host does not let this device create lanes.',
  read: 'This Host does not let this device move its lanes.',
  noWorkspaces: 'No workspaces here yet.',
} as const

/** Why a Host cannot send this lane, or undefined when it can. */
export function sourceHint(hosts: HostsSnapshot, source: LaneMoveSource): string | undefined {
  if (source.machine === 'local') return undefined
  const host = hosts[source.machine]
  if (host?.state !== 'ready') return MOVE_HINTS.offline
  if (host.laneTransfer !== true) return MOVE_HINTS.outdated
  return host.capabilities.includes('sessions.control') ? undefined : MOVE_HINTS.read
}

/**
 * Every machine a lane could move to, This Mac first, each with the
 * workspaces it offers. A Host that cannot take one says why instead of
 * disappearing, so a missing option is never a mystery.
 */
export function moveMachines(input: {
  hosts: HostsSnapshot
  labelOf(hostId: string): string
  recents: WorkspaceInfo[]
  sandboxes: SandboxInfo[]
}): MoveMachine[] {
  const local: MoveWorkspace[] = [...input.recents, ...input.sandboxes]
    .filter((w, i, all) => all.findIndex((o) => o.path === w.path) === i)
    .map((w) => ({
      key: `local:${w.path}`,
      label: w.name,
      target: { machine: 'local', workspace: w.path },
    }))
  const machines: MoveMachine[] = [
    {
      machine: 'local',
      label: 'This Mac',
      workspaces: local,
      ...(local.length ? {} : { disabled: MOVE_HINTS.noWorkspaces }),
    },
  ]
  for (const [hostId, host] of Object.entries(input.hosts)) {
    if (!host) continue
    const disabled =
      host.state !== 'ready'
        ? MOVE_HINTS.offline
        : host.laneTransfer !== true
          ? MOVE_HINTS.outdated
          : !host.capabilities.includes('sessions.control') ||
              !host.capabilities.includes('workspaces.write')
            ? MOVE_HINTS.control
            : host.repositories.length === 0
              ? MOVE_HINTS.noWorkspaces
              : undefined
    machines.push({
      machine: hostId,
      label: input.labelOf(hostId),
      ...(disabled ? { disabled } : {}),
      workspaces: host.repositories.map((r) => ({
        key: `${hostId}:${r.id}`,
        label: r.name,
        target: { machine: hostId, repositoryId: r.id },
      })),
    })
  }
  return machines
}

/** One sentence on how the lane lands, from the plan the target checked. */
export function planSummary(plan: LaneMovePlan): string {
  if (plan.mode === 'same-workspace')
    return `Same repository: ${plan.branch} is checked out in a new worktree at the same commit.`
  if (plan.mode === 'new-branch')
    return `Another repository: the conversation moves to a new branch, ${plan.branch}. The code stays behind.`
  return 'The conversation moves into this folder. The old folder’s files stay behind.'
}

export function formatMoveBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
