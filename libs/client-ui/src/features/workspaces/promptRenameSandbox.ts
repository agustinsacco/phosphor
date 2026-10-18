import { isWithinFolder } from '@shared/paths'
import { basename } from '@/lib/path'
import { promptText } from '@/stores/prompt'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'

/** The live chats a rename of `path` has to close: the sandbox's, and its lanes'. */
function liveSessionsIn(path: string): { phosphorId: string }[] {
  return Object.values(useSessionsStore.getState().live).filter((session) =>
    isWithinFolder(session.workspacePath, path),
  )
}

/**
 * Ask for a sandbox's new name and apply it. Resolves the new path, or null
 * when the user cancelled or main refused (the store toasts the refusal).
 *
 * Shared by the sidebar's group menu and Settings so both state the same
 * rules. The rules are stated UP FRONT rather than only enforced on submit:
 * main validates the name (electron/sandbox.ts is the guard, since the string
 * comes from the renderer), but being told "no" after typing is worse than
 * knowing first, and the folder-on-disk part explains why there are rules at
 * all.
 *
 * Running chats are CLOSED rather than allowed to refuse the rename. Nothing
 * reclaims an idle session's pi process, so a chat stays live until it is
 * explicitly closed — which meant every sandbox you had actually used could
 * not be renamed for the rest of the launch, from the one menu you would go
 * looking for the rename in. Closing them is what makes the rename possible at
 * all, so it is stated in the prompt and done only once the user has
 * submitted.
 *
 * It happens HERE rather than in main because only the renderer can take a
 * session down in order: `disposeSession` also drops the chat, terminal,
 * artifact and layout slices that would otherwise outlive the process. Main
 * still refuses while anything is live — it is the guard, not the courtesy.
 */
export async function promptRenameSandbox(path: string): Promise<string | null> {
  const current = basename(path)
  const live = liveSessionsIn(path)
  const name = await promptText({
    title: `Rename ${current}`,
    message: [
      'Renames the folder on disk and moves its chats with it.',
      live.length > 0 &&
        `Closes ${live.length} running chat${live.length === 1 ? '' : 's'} first — pi cannot keep working in a folder that has moved.`,
      'No / \\ : * ? " < > | characters.',
    ]
      .filter(Boolean)
      .join(' '),
    initialValue: current,
    submitLabel: 'Rename',
  })
  if (name === undefined || !name.trim() || name.trim() === current) return null

  // Re-read rather than reusing `live`: the dialog was open for as long as the
  // user took to type, and a session started or closed in that time.
  for (const session of liveSessionsIn(path)) {
    await useSessionsStore.getState().disposeSession(session.phosphorId)
  }
  return useWorkspacesStore.getState().renameSandbox(path, name)
}
