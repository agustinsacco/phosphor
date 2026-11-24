import { app, shell } from 'electron'
import { join } from 'node:path'
import { isWithinFolder } from '@phosphor/shared/paths'
import * as sandboxes from '@phosphor/session-runtime/sandboxes/service'
import { hasArchivedFolder } from './archive/state'
import { registry } from './registry'
import { getPrefs, realPathOrNull, repointStoredPaths, setRecentWorkspaces } from './store'

/**
 * Where sandboxes live. userData, not homedir: E2E redirects userData
 * (PHOSPHOR_TEST_USER_DATA), so stub-driven runs never touch the real one.
 *
 * Resolved, so every sandbox path Phosphor hands out is the one pi will derive
 * its session directory from. A userData directory reached through a symlink
 * otherwise yields a second spelling of each sandbox, and the sidebar shows
 * one folder as two groups listing the same lanes.
 */
export function sandboxBase(): string {
  const base = join(app.getPath('userData'), 'sandboxes')
  return realPathOrNull(base) ?? base
}

const owner: sandboxes.SandboxOwner = {
  hasLiveFolder: (path) =>
    registry.list().some((session) => isWithinFolder(session.workspacePath, path)),
  hasArchivedFolder,
  trashItem: (path) => shell.trashItem(path),
  repointStoredPaths,
  forgetWorkspace: (path) =>
    setRecentWorkspaces(getPrefs().recentWorkspaces.filter((w) => w.path !== path)),
}

export async function renameSandbox(path: string, name: string) {
  return sandboxes.renameSandbox(sandboxBase(), path, name, owner)
}

export async function deleteSandbox(path: string) {
  return sandboxes.deleteSandbox(sandboxBase(), path, owner)
}
