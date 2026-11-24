import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import { isWorktreeFolder, projectPathFor } from '@/lib/path'
import { representativeGroupPath } from './groupSessions'

export function localRevealGroup(workspacePath: string): string {
  const { gitByCwd, live } = useSessionsStore.getState()
  const knownPaths = new Set(
    useWorkspacesStore
      .getState()
      .recents.filter((workspace) => !isWorktreeFolder(workspace.path))
      .map((workspace) => workspace.path),
  )
  knownPaths.add(workspacePath)
  for (const entry of Object.values(live))
    if (entry.target?.kind !== 'remote') knownPaths.add(entry.workspacePath)
  const projectKey = projectPathFor(workspacePath, gitByCwd[workspacePath])
  const groupPaths = [...knownPaths].filter(
    (path) => projectPathFor(path, gitByCwd[path]) === projectKey,
  )
  return representativeGroupPath(projectKey, groupPaths)
}
