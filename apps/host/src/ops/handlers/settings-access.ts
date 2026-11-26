import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import type { MachineSettings, MachineSettingsSection } from '@phosphor/shared/machine-settings'
import type { createAccountMoves } from '../../settings/account-moves'
import type { createMachineSettings } from '../../settings/service'
import type { createHeadlessTasks } from '../../settings/headless-tasks'
import type { DaemonHeadroom } from '../../session/headroom'
import { resourceCall } from './resources-call'
import type { DaemonHandlerDeps } from './index'

export interface SettingsOps {
  settings: ReturnType<typeof createMachineSettings>
  moveClaudeAccount: ReturnType<typeof createAccountMoves>
  task: ReturnType<typeof createHeadlessTasks>
  refreshDirectives: (project?: string) => Promise<number>
  headroom?: DaemonHeadroom['handlers']
}
export function settingsOps(deps: DaemonHandlerDeps) {
  if (!deps.settingsOps) throw new OpRefusal('unavailable', 'Machine settings are unavailable.')
  return deps.settingsOps
}
/** Client paths identify a registered folder; they never become filesystem paths. */
export function projectId(deps: DaemonHandlerDeps, project: unknown, ctx: OpHandlerContext) {
  if (project === undefined || project === false) return undefined
  const path = project === true ? ctx.lane?.cwd : project
  const repos = deps.store.listRepositories()
  const repo = repos.find((r) => r.id === path || r.path === path)
  if (repo) return repo.id
  if (project === true && ctx.lane) {
    const lane = deps.store.listLanes().find((l) => l.cwd === path && l.removedAt === null)
    if (lane && repos.some((r) => r.id === lane.repositoryId)) return lane.repositoryId
  }
  throw new OpRefusal('bad-request', 'Select a registered Host folder.')
}
export function scopedProject(scope: unknown, project: unknown) {
  if (scope === 'project') return project ?? true
  if (project !== undefined)
    throw new OpRefusal('bad-request', 'A machine-scoped change cannot select a project.')
  return undefined
}
export async function settingsCall(
  deps: DaemonHandlerDeps,
  method: 'read' | 'patch',
  params: unknown,
  signal?: AbortSignal,
) {
  return (await resourceCall(deps, `machine.settings.${method}`, params, signal)) as MachineSettings
}
export function readSection(
  deps: DaemonHandlerDeps,
  section: MachineSettingsSection,
  repositoryId?: string,
  signal?: AbortSignal,
) {
  return settingsCall(deps, 'read', { section, ...(repositoryId ? { repositoryId } : {}) }, signal)
}
export function patchSection(
  deps: DaemonHandlerDeps,
  before: MachineSettings,
  change: unknown,
  ctx: OpHandlerContext,
) {
  return settingsCall(
    deps,
    'patch',
    {
      section: before.section,
      repositoryId: before.repositoryId,
      revision: before.revision,
      change,
    },
    ctx.signal,
  )
}
