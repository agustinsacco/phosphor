import { basename } from '@/lib/path'
import { promptText } from '@/stores/prompt'
import { useWorkspacesStore } from '@/stores/workspaces'

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
 */
export async function promptRenameSandbox(path: string): Promise<string | null> {
  const current = basename(path)
  const name = await promptText({
    title: `Rename ${current}`,
    message:
      'Renames the folder on disk and moves its chats with it. No / \\ : * ? " < > | characters.',
    initialValue: current,
    submitLabel: 'Rename',
  })
  if (name === undefined || !name.trim() || name.trim() === current) return null
  return useWorkspacesStore.getState().renameSandbox(path, name)
}
