import { useMemo, type RefObject } from 'react'
import { buildCommandEntries } from '@/features/chat/composer/CommandMenu'
import { useSlashMenu, type SlashMenu } from '@/features/chat/composer/useSlashMenu'
import {
  NO_COMMANDS,
  usePiCommandsStore,
  type CommandSource,
  type PiCommandsStatus,
} from '@/stores/piCommands'

export interface StartCommands {
  slash: SlashMenu
  commandStatus: PiCommandsStatus | 'idle'
  commandError?: string
}

/**
 * The `/` menu of a composer that has no lane yet, over one machine's command
 * source: This Mac's folder or a Host's repository. The list loads on the
 * first `/`, not on mount, because every source answers by spawning a pi.
 */
export function useStartCommands(
  source: CommandSource,
  setText: (text: string) => void,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
): StartCommands {
  const { key } = source
  const piCommands = usePiCommandsStore((s) => s.byWorkspace[key] ?? NO_COMMANDS)
  const commandStatus = usePiCommandsStore((s) => s.status[key] ?? ('idle' as const))
  const commandError = usePiCommandsStore((s) => s.error[key])
  const entries = useMemo(() => buildCommandEntries(piCommands, []), [piCommands])
  const slash = useSlashMenu({
    entries,
    setText,
    onOpen: () => void usePiCommandsStore.getState().load(source),
    focus: () => textareaRef.current?.focus(),
  })
  return { slash, commandStatus, commandError }
}
