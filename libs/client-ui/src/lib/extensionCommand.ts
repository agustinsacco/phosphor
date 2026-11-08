import { useChatStore } from '@/stores/chat'
import { piCall, piCallOk } from './rpc'

/**
 * Send one of Phosphor's extension commands, such as `/phosphor-swarm on`.
 * Check registration first: an unknown slash command would run a model instead.
 */
export async function runExtensionCommand(
  sessionId: string,
  command: string,
  argument: string,
  words: { control: string; failed: string },
): Promise<void> {
  const failure = (fallback: string) =>
    new Error(useChatStore.getState().sessions[sessionId]?.error ?? fallback)
  const commands = await piCall(sessionId, { type: 'get_commands' })
  if (!commands) throw failure(`Could not check ${words.control} support.`)
  if (!commands.commands.some((c) => c.name === command && c.source === 'extension'))
    throw new Error(
      `This lane does not support the ${words.control} control. Restart it to update.`,
    )
  if (!(await piCallOk(sessionId, { type: 'prompt', message: `/${command} ${argument}` })))
    throw failure(words.failed)
}
