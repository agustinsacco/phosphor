import type { SessionPush } from '@phosphor/shared/models'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { HostRuntime } from '../session/runtime'
import { piState } from './pi-results'
import type { LaneSessions } from './create'
import type { createLiveLanes } from './live'
import type { HostStore, StoredLane } from './store'

const STARTUP_PUSHES = 256
const STARTUP_BYTES = 1024 * 1024
type Binding = {
  laneId?: string
  pushes: SessionPush[]
  bytes: number
  overflow: boolean
  attachment?: ReturnType<ReturnType<typeof createLiveLanes>['attach']>
}

export function createRuntimeLanes(options: {
  runtime: Pick<HostRuntime, 'start' | 'stop' | 'command' | 'extensionUiResponse'>
  store: Pick<HostStore, 'getLane'>
  live: ReturnType<typeof createLiveLanes>
  log: RuntimeLog
}) {
  const { runtime, live } = options
  const bindings = new Map<string, Binding>()
  async function start(request: unknown) {
    const binding: Binding = { pushes: [], bytes: 0, overflow: false }
    const session = await runtime.start(request, (push) => {
      if (push.kind === 'stderr') return
      if (binding.laneId !== undefined) return live.push(binding.laneId, push)
      if (binding.overflow) return
      const bytes = Buffer.byteLength(JSON.stringify(push))
      if (binding.pushes.length >= STARTUP_PUSHES || binding.bytes + bytes > STARTUP_BYTES) {
        binding.overflow = true
        binding.pushes = []
        binding.bytes = 0
      } else {
        binding.pushes.push(push)
        binding.bytes += bytes
      }
    })
    bindings.set(session.sessionId, binding)
    try {
      const state = await runtime.command(session.sessionId, { type: 'get_state' })
      const data = state.success ? piState(state.data) : null
      if (!data) throw new Error('the lane could not start')
      return {
        sessionId: session.sessionId,
        sessionFile: typeof data.sessionFile === 'string' ? data.sessionFile : null,
      }
    } catch (error) {
      await stop(session.sessionId)
      throw error
    }
  }
  async function attach(laneId: string, sessionId: string) {
    const binding = bindings.get(sessionId)
    if (!binding || !options.store.getLane(laneId)) throw new Error('unknown lane start')
    // An unexpected exit keeps its failed projection until an explicit resume.
    for (const [id, previous] of bindings)
      if (id !== sessionId && previous.laneId === laneId) bindings.delete(id)
    live.detach(laneId)
    binding.attachment = live.attach(laneId, sessionId)
    binding.laneId = laneId
    if (binding.overflow) {
      try {
        options.log('host', 'lane.startup_overflow', { laneId })
      } catch {
        // Logging cannot fail an attachment.
      }
    }
    for (const push of binding.pushes) live.push(laneId, push)
    binding.pushes = []
    binding.bytes = 0
    await binding.attachment.ready
  }
  async function stop(sessionId: string) {
    const binding = bindings.get(sessionId)
    // Failed creations must discard their startup pushes even if stopping fails.
    bindings.delete(sessionId)
    binding?.pushes.splice(0)
    const laneId = binding?.laneId
    try {
      await runtime.stop(sessionId)
    } finally {
      if (binding) binding.laneId = undefined
      if (laneId !== undefined) live.detach(laneId)
    }
  }
  const sessions: LaneSessions = { start, attach, stop }
  return {
    sessions,
    async resumeLane(lane: StoredLane) {
      if (lane.sessionFile === null) throw new Error('the lane could not start')
      // The runtime parser requires the recorded file to still exist.
      const session = await start({ repository: lane.cwd, sessionPath: lane.sessionFile })
      try {
        await attach(lane.laneId, session.sessionId)
      } catch (error) {
        await stop(session.sessionId)
        throw error
      }
    },
    async stopLane(laneId: string) {
      const sessionId = live.sessionFor(laneId)
      if (sessionId !== null) await stop(sessionId)
    },
    async command(...args: Parameters<HostRuntime['command']>) {
      const response = await runtime.command(...args)
      if (
        response.success &&
        ['set_model', 'set_thinking_level', 'set_session_name'].includes(args[1].type)
      )
        bindings.get(args[0])?.attachment?.stateChanged()
      return response
    },
    extensionUiResponse: runtime.extensionUiResponse,
  }
}
