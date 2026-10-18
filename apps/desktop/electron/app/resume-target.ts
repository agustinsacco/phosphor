import type { AppPrefs } from '@shared/models'

/** Resolve the saved launch location without changing the preference order. */
export async function resolveResumeTarget(
  {
    lastSessionPath,
    lastWorkspacePath,
    recentWorkspaces,
  }: Pick<AppPrefs, 'lastSessionPath' | 'lastWorkspacePath' | 'recentWorkspaces'>,
  pathExists: (path: string) => Promise<boolean>,
) {
  // Prefer the exact session, but only if BOTH it and its workspace still
  // exist — a session file whose folder was deleted can't be resumed.
  if (lastSessionPath && lastWorkspacePath) {
    const [sessionOk, workspaceOk] = await Promise.all([
      pathExists(lastSessionPath),
      pathExists(lastWorkspacePath),
    ])
    if (sessionOk && workspaceOk) {
      return {
        kind: 'session' as const,
        sessionPath: lastSessionPath,
        workspacePath: lastWorkspacePath,
      }
    }
  }

  if (lastWorkspacePath && (await pathExists(lastWorkspacePath))) {
    return { kind: 'workspace' as const, workspacePath: lastWorkspacePath }
  }

  // Fall back to the newest recent that still exists — the picker should
  // only ever appear on a true first run, not because lastWorkspacePath
  // went stale or was never written.
  for (const ws of [...recentWorkspaces].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)) {
    if (await pathExists(ws.path)) {
      return { kind: 'workspace' as const, workspacePath: ws.path }
    }
  }

  return { kind: 'none' as const }
}
