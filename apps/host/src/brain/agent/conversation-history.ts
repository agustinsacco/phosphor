import { access } from 'node:fs/promises'
import type { AgentMessage } from '@phosphor/shared/rpc'
import { piMessages, piState } from '../../lanes/pi-results'
import { createTranscriptCache } from '../../lanes/transcript/cache'
import { readTranscript } from '../../lanes/transcript/read'
import type { BrainAgentConversationPorts } from './conversation'

/** What Brain Agent's lane holds: its bound transcript, pi's busy state and its messages. */
export function createConversationHistory(
  ports: Pick<BrainAgentConversationPorts, 'reserved' | 'binding' | 'sessionsRoot' | 'log'>,
) {
  const { reserved, binding } = ports
  const cache = createTranscriptCache()

  /** The bound transcript while it exists; a missing one starts the lane afresh. */
  async function resume(): Promise<string | null> {
    const { sessionFile } = await binding.read()
    if (!sessionFile) return null
    return access(sessionFile).then(
      () => sessionFile,
      () => null,
    )
  }

  async function busy(id: string): Promise<boolean> {
    const reported = await reserved.command(id, { type: 'get_state' })
    const known = reported.success ? piState(reported.data) : null
    if (!known) throw new Error('Brain Agent’s lane did not answer.')
    return known.isStreaming || known.isCompacting
  }

  async function messages(id: string | null): Promise<AgentMessage[]> {
    if (id) {
      const reported = await reserved.command(id, { type: 'get_messages' })
      const data: unknown = reported.success ? reported.data : undefined
      const found =
        typeof data === 'object' && data !== null && 'messages' in data
          ? piMessages(data.messages)
          : null
      if (!found) throw new Error('Brain Agent’s lane did not answer.')
      return found
    }
    const { ref, sessionFile } = await binding.read()
    if (!sessionFile) return []
    const read = readTranscript({
      sessionFile,
      sessionsRoot: ports.sessionsRoot,
      laneId: ref,
      cache,
      onFailure: (reason) => ports.log('Brain Agent transcript unreadable', { reason }),
    })
    if (read.kind === 'messages') return read.messages
    if (read.kind === 'missing') return []
    throw new Error('Brain Agent’s transcript cannot be read.')
  }

  return { resume, busy, messages }
}
