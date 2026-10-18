import { SWARM_COMMAND } from '@phosphor/pi-extensions/swarm'
import { useChatStore } from '@/stores/chat'
import { piCall, piCallOk } from './rpc'

/** Check registration first: an unknown slash command would run a model instead. */
export async function requestSwarm(sessionId: string, enabled: boolean): Promise<void> {
  const commands = await piCall(sessionId, { type: 'get_commands' })
  if (!commands)
    throw new Error(
      useChatStore.getState().sessions[sessionId]?.error ?? 'Could not check Swarm support.',
    )
  if (!commands.commands.some((c) => c.name === SWARM_COMMAND && c.source === 'extension'))
    throw new Error('This lane does not support the Swarm control. Restart it to update.')
  if (
    !(await piCallOk(sessionId, {
      type: 'prompt',
      message: `/${SWARM_COMMAND} ${enabled ? 'on' : 'off'}`,
    }))
  )
    throw new Error(
      useChatStore.getState().sessions[sessionId]?.error ?? 'Could not change Swarm authorization.',
    )
}
