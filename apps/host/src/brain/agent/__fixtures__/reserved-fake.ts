import { randomUUID } from 'node:crypto'
import type { SessionPush } from '@phosphor/shared/models'
import type {
  ExtensionUIRequest,
  ExtensionUIResponse,
  Model,
  RpcCommand,
  RpcResponse,
} from '@phosphor/shared/rpc'
import type { ReservedOpen } from '../../../session/reserved-lanes'
import { BRAIN_AGENT_GUARD_COMMAND, type BrainAgentLaunchProfile } from '../profile'

type Deliver = (push: SessionPush) => void
interface FakeProcess {
  id: string
  profile: BrainAgentLaunchProfile['next']
  guard: string | null
  alive: boolean
  streaming: boolean
  model: Partial<Model> | null
  deliver: Deliver
}

/** A synthetic model: no real provider is named or reached. */
export const SYNTHETIC_MODEL: Partial<Model> = {
  provider: 'synthetic-harbor',
  id: 'synthetic-1',
  api: 'synthetic',
}

// pi's answers, shallow as the Host reads them; typed per command only by the real client.
const ok = (command: RpcCommand, data?: unknown) =>
  ({ type: 'response', command: command.type, success: true, data }) as RpcResponse<never>
const event = (process: FakeProcess, value: object) =>
  process.deliver({ kind: 'event', event: value } as SessionPush)

/** Ends `process`'s turn as pi would. */
function settle(process: FakeProcess) {
  if (!process.streaming) return
  process.streaming = false
  event(process, { type: 'agent_end', messages: [], willRetry: false })
  event(process, { type: 'agent_settled' })
}

/** pi's answer to one RPC command on `process`. */
function answer(process: FakeProcess, command: RpcCommand): RpcResponse<never> {
  switch (command.type) {
    case 'get_state':
      return ok(command, {
        sessionId: process.id,
        model: process.model,
        isStreaming: process.streaming,
        isCompacting: false,
        thinkingLevel: 'off',
        steeringMode: 'all',
        followUpMode: 'one-at-a-time',
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      })
    case 'get_messages':
      return ok(command, { messages: [] })
    case 'get_commands':
      return ok(command, {
        commands: process.guard
          ? [
              {
                name: BRAIN_AGENT_GUARD_COMMAND,
                source: 'extension',
                sourceInfo: { path: process.guard, source: 'cli', scope: 'temporary' },
              },
            ]
          : [],
      })
    case 'prompt':
      if (process.streaming)
        return { ...ok(command), success: false, error: 'busy' } as RpcResponse<never>
      process.streaming = true
      queueMicrotask(() => event(process, { type: 'agent_start' }))
      return ok(command)
    case 'abort':
      settle(process)
      return ok(command)
    default:
      return ok(command)
  }
}

/**
 * A synthetic reserved lane: one fake pi process at a time, spawned in the profile the launch
 * profile names, which lists the guard among its commands only when it loaded it.
 */
export function fakeReservedLane(
  profile: BrainAgentLaunchProfile,
  { loadsGuard = true }: { loadsGuard?: boolean } = {},
) {
  const processes: FakeProcess[] = []
  const commands: { id: string; command: RpcCommand }[] = []
  const responses: { id: string; response: ExtensionUIResponse }[] = []
  const live = () => processes.findLast((p) => p.alive)
  const own = (id: string) => {
    const found = processes.find((p) => p.id === id && p.alive)
    if (!found) throw new Error(`Unknown session: ${id}`)
    return found
  }
  const reserved = {
    async open(_request: ReservedOpen, deliver: Deliver) {
      if (live()) throw new Error('a second process on the reserved lane')
      const spawned: FakeProcess = {
        id: randomUUID(),
        profile: profile.next,
        guard: profile.next === 'interactive' && loadsGuard ? profile.guard : null,
        alive: true,
        streaming: false,
        model: SYNTHETIC_MODEL,
        deliver,
      }
      processes.push(spawned)
      return { sessionId: spawned.id, workspacePath: '/unused' }
    },
    client: (id: string) => {
      const found = processes.find((p) => p.id === id)
      return found && ({ alive: found.alive } as never)
    },
    async command(
      id: string,
      command: RpcCommand,
      beforeDispatch?: () => boolean,
    ): Promise<RpcResponse<never>> {
      const process = own(id)
      if (beforeDispatch?.() === false) throw new Error('The turn changed before dispatch.')
      commands.push({ id, command })
      return answer(process, command)
    },
    respond: (id: string, response: ExtensionUIResponse) => {
      own(id)
      responses.push({ id, response })
    },
    async stop(id: string) {
      const process = own(id)
      process.alive = false
      process.deliver({ kind: 'exit', code: 0 } as SessionPush)
    },
  }
  return {
    reserved,
    processes,
    commands,
    responses,
    prompts: () => commands.filter(({ command }) => command.type === 'prompt'),
    aborts: () => commands.filter(({ command }) => command.type === 'abort'),
    /** Ends the live process's turn as pi would. */
    finish: () => settle(live()!),
    /** A pi event in the live process's turn. */
    emit: (value: object) => event(live()!, value),
    /** A question from the live process, as pi asks one. */
    ask: (request: ExtensionUIRequest) => live()!.deliver({ kind: 'extension-ui', request }),
  }
}
