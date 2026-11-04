import { parseRemotePrKey } from '@shared/host-protocol-github'
import { useSessionsStore } from './sessions'
import { useRemoteLanesStore } from './remoteLanes'

/** Read existing lane projections at refresh time; no extra watchers or session ownership. */
export function pullRequestInterests(repoPath: string): {
  branches: string[]
  activeBranch?: string
} {
  const sessions = useSessionsStore.getState()
  const active = sessions.activeSessionId ? sessions.live[sessions.activeSessionId] : undefined
  const scope = parseRemotePrKey(repoPath)
  const branches = new Set<string>()
  let activeBranch: string | undefined
  if (scope) {
    const lanes = useRemoteLanesStore.getState().hosts[scope.hostId]?.lanes ?? []
    for (const lane of lanes) {
      if (lane.repositoryId !== scope.repositoryId || !lane.branch) continue
      branches.add(lane.branch)
      if (
        active?.target?.kind === 'remote' &&
        active.target.hostId === scope.hostId &&
        active.laneId === lane.laneId
      )
        activeBranch = lane.branch
    }
  } else {
    for (const [cwd, git] of Object.entries(sessions.gitByCwd)) {
      if (!git.isRepo || (git.mainRepoPath ?? cwd) !== repoPath || !git.branch) continue
      branches.add(git.branch)
      if (active?.target?.kind !== 'remote' && active?.workspacePath === cwd)
        activeBranch = git.branch
    }
  }
  return { branches: [...branches].filter((branch) => branch.length <= 4096), activeBranch }
}
