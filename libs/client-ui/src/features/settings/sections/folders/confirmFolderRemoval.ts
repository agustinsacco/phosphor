import { promptChoice } from '@/stores/prompt'
import type { FolderCaps, FolderItem } from './source'

/**
 * Asks before a folder leaves a machine's list. Neither way touches files:
 * This Mac forgets the folder, a Host unregisters it.
 */
export async function confirmFolderRemoval(
  kind: NonNullable<FolderCaps['remove']>,
  folder: FolderItem,
  machineLabel: string,
): Promise<boolean> {
  const choice = await promptChoice(
    kind === 'forget'
      ? {
          title: `Remove ${folder.name} from ${machineLabel}?`,
          message:
            'Phosphor forgets the folder and closes its idle chats. Nothing on disk changes, and its chats come back if you add it again.',
          choices: [{ value: 'remove', label: 'Remove folder', primary: true }],
        }
      : {
          title: `Unregister ${folder.name} on ${machineLabel}?`,
          message:
            'Files are never deleted. Existing lane history remains. A folder with active lanes may refuse removal.',
          choices: [{ value: 'remove', label: 'Unregister folder', primary: true }],
        },
  )
  return choice === 'remove'
}
