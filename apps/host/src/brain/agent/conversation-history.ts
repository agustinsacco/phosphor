import { lstat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import type { AgentMessage } from '@phosphor/shared/rpc'
import { piMessages, piState } from '../../lanes/pi-results'
import { createTranscriptCache } from '../../lanes/transcript/cache'
import { readTranscript } from '../../lanes/transcript/read'
import type { BrainAgentConversationPorts } from './conversation'

const wrongFile = () => new Error('Brain Agent did not open its own transcript.')
const statIfPresent = (path: string) =>
  lstat(path).catch((error: unknown) => {
    if (errnoIs(error, 'ENOENT')) return null
    throw error
  })

/** Check the lane directory and leaf, but allow pi's lazy first write. */
async function transcriptExists(file: string): Promise<boolean> {
  const parent = await statIfPresent(dirname(file))
  if (!parent) return false
  if (!parent.isDirectory()) throw wrongFile()
  const stat = await statIfPresent(file)
  if (!stat) return false
  if (!stat.isFile() || stat.nlink !== 1) throw wrongFile()
  return true
}

/** What Brain Agent's lane holds: its bound transcript, pi's busy state and its messages. */
export function createConversationHistory(
  ports: Pick<
    BrainAgentConversationPorts,
    'reserved' | 'binding' | 'folder' | 'sessionsRoot' | 'log'
  >,
) {
  const { reserved, binding } = ports
  const cache = createTranscriptCache()

  const directory = resolve(sessionDirForCwd(ports.folder, ports.sessionsRoot))
  function ownFile(file: unknown): string {
    if (
      typeof file !== 'string' ||
      file !== resolve(file) ||
      dirname(file) !== directory ||
      !file.endsWith('.jsonl')
    )
      throw wrongFile()
    return file
  }
  /** pi may report a new file before writing it; a resume must report the exact saved file. */
  async function acceptFile(reported: unknown, resuming: string | null): Promise<string> {
    const file = ownFile(reported)
    if (resuming && file !== resuming) throw wrongFile()
    if (!(await transcriptExists(file)) && resuming) throw wrongFile()
    return file
  }

  /** With no saved file yet (pi's lazy persistence), the lane still needs a first transcript. */
  async function resume(): Promise<string | null> {
    const { sessionFile } = await binding.read()
    return sessionFile && (await transcriptExists(ownFile(sessionFile))) ? sessionFile : null
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
    if (!sessionFile || !(await transcriptExists(ownFile(sessionFile)))) return []
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

  return { acceptFile, resume, busy, messages }
}
