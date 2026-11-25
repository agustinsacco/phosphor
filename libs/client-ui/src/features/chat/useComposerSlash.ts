import { buildCommandEntries, type NativeCommand } from './composer/CommandMenu'
import { useSlashMenu } from './composer/useSlashMenu'
import { exportSession, renameSession } from '@/features/sessions/sessionActions'
import { usePlatform } from '@/platform/Platform'
import { piCallOk } from '@/lib/rpc'
import { useMemo } from 'react'
import { refreshSessionCommands } from '@/stores/sessions'
import type { RpcSlashCommand } from '@shared/rpc'

export function useComposerSlash(
  sessionId: string,
  piCommands: RpcSlashCommand[],
  setText: (text: string) => void,
  focus: () => void,
) {
  const { nativeFiles } = usePlatform()
  const nativeCommands = useMemo<NativeCommand[]>(
    () => [
      {
        name: 'compact',
        description: 'Compact conversation context now',
        run: () => void runCompact(sessionId),
      },
      {
        name: 'export',
        description: 'Export this session as HTML',
        run: () => void exportSession(sessionId, nativeFiles),
      },
      {
        name: 'name',
        description: 'Rename this session',
        run: () => void renameSession(sessionId),
      },
    ],
    [sessionId, nativeFiles],
  )

  const commandEntries = useMemo(
    () => buildCommandEntries(piCommands, nativeCommands),
    [piCommands, nativeCommands],
  )
  return useSlashMenu({
    entries: commandEntries,
    setText,
    // The session's list was fetched at bootstrap; `/mcp reconnect` since then
    // may have registered prompt commands it does not have. Throttled inside.
    onOpen: () => void refreshSessionCommands(sessionId),
    focus,
  })
}
async function runCompact(sessionId: string): Promise<void> {
  await piCallOk(sessionId, { type: 'compact' })
}
