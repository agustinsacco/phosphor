import { useChatStore } from '@/stores/chat'
import { useLaneControl } from '@/features/machines/useLaneControl'

export type SubagentCommand =
  'subagents-inspect-rpc' | 'subagents-stop' | 'subagents-steer' | 'phosphor-save-subagent-snapshot'

/** Do not let a missing extension command fall through to a model prompt. */
export async function requireSubagentCommand(
  sessionId: string,
  name: SubagentCommand,
): Promise<void> {
  const response = await window.phosphor.piCommand(sessionId, { type: 'get_commands' })
  if (
    !response.success ||
    !response.data?.commands.some((c) => c.name === name && c.source === 'extension')
  ) {
    throw new Error(`This session does not support /${name}.`)
  }
}

/**
 * What the pane's actions may send: the commands this session's pi advertises, and
 * why this window may not send them now. Saving, steering and stopping change a Host
 * lane, so only its controller sends them, as with the composer; This Mac's sessions
 * are never blocked.
 */
export function useSubagentCommands(sessionId: string): {
  supported: (name: SubagentCommand) => boolean
  blocked: string | undefined
} {
  const commands = useChatStore((s) => s.sessions[sessionId]?.commands)
  const control = useLaneControl(sessionId)
  return {
    supported: (name) => !!commands?.some((c) => c.name === name && c.source === 'extension'),
    blocked: control?.hint,
  }
}
