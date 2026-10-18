import { basename } from 'node:path'
import type { LiveSessionInfo } from '@phosphor/shared/models'
import type { ExtensionUIResponse, RpcCommand } from '@phosphor/shared/rpc'
import type { SessionExecution } from '@phosphor/session-runtime/pi/session-policy'
import { commandRefusal, mayRunExtensionCommand } from './command-policy'
import { stopSession } from './lifecycle'
import { parseSessionRequest } from './request'
import { RequestError, type Delivery, type RuntimeState } from './runtime-state'
import type { RuntimeDeletion, RuntimeService } from './runtime-wiring'

const ignore: Delivery = () => {}
const MOVING =
  'a session is running a command that may move it to another file: try again once it ends'
const LOST = 'may have moved to another file, and pi could not say which: stop that session first'

/** Resume and deletion trust file identities; a moving or lost pi makes them stale. */
function assertFilesKnown(state: RuntimeState): void {
  if (state.moving > 0) throw new Error(MOVING)
  for (const id of state.lost) {
    // A disposed session writes nothing, and its id is never used again.
    if (!state.registry.get(id)) state.lost.delete(id)
    else throw new Error(`session ${id} ${LOST}`)
  }
}

/** Errors and answers without a file leave this session lost until success or disposal. */
async function relearnFile(state: RuntimeState, id: string): Promise<void> {
  const client = state.registry.get(id)?.client
  if (!client) return
  try {
    const response = await client.request({ type: 'get_state' })
    if (response.success && typeof response.data?.sessionFile === 'string') {
      state.lost.delete(id)
      return
    }
  } catch {
    // pi has exited, or its input is closed: it says nothing either.
  }
  state.lost.add(id)
}

async function parse(state: RuntimeState, request: unknown, deleting = false) {
  state.life.assertReady()
  const parsed = await parseSessionRequest(request, state.roots, { deleting })
  if (!parsed.ok) throw new RequestError(parsed.errors)
  return parsed.options
}

async function start(
  state: RuntimeState,
  service: RuntimeService,
  request: unknown,
  deliver: Delivery,
): Promise<LiveSessionInfo> {
  const options = await parse(state, request)
  // A new session's file is new. Resuming one trusts the Host's records.
  if (options.sessionPath !== undefined) assertFilesKnown(state)
  // pi's stderr may hold a secret, so each line leaves the Host redacted.
  const delivery: Delivery = (push) =>
    deliver(push.kind === 'stderr' ? { ...push, text: state.machine.log.hide(push.text) } : push)
  const session = await service.create(options, delivery)
  if (!state.started.has(delivery)) throw new Error('the session is already running')
  return session
}

async function command(
  state: RuntimeState,
  service: RuntimeService,
  id: string,
  command: RpcCommand,
) {
  const refusal = commandRefusal(command)
  if (refusal) throw new Error(refusal)
  if (!mayRunExtensionCommand(command)) return service.command(id, command)
  // Extension prompts may change files. Keep admission blocked until the final identity read.
  state.moving++
  try {
    return await service.command(id, command)
  } finally {
    await relearnFile(state, id)
    state.moving--
  }
}

export function createRuntimeOperations(
  state: RuntimeState,
  service: RuntimeService,
  deleteLane: RuntimeDeletion,
) {
  const { roots, machineContext, life, registry, options, timings } = state
  return {
    withAuthorization: <T>(allowed: () => boolean, run: () => Promise<T>) =>
      state.authorization.run(allowed, run),
    accountForSession: state.accounts.accountForSession,
    replaceRoots(next: readonly string[]) {
      roots.splice(0, roots.length, ...next)
      machineContext.repositories = next.map((repository) => basename(repository))
    },
    /** Internal runner only: still uses the shared service and path-lock domain. */
    async startRoutine(request: unknown, deliver: Delivery, execution: SessionExecution) {
      return service.create(await parse(state, request), deliver, {
        ...execution,
        unattended: true,
      })
    },
    routineClient(id: string) {
      if (!options.routines?.owns(id)) throw new Error('not a routine session')
      const session = registry.get(id)
      if (!session) throw new Error('routine session unavailable')
      return session.client
    },
    async stopRoutine(id: string) {
      if (!options.routines?.owns(id)) throw new Error('not a routine session')
      const session = registry.get(id)
      if (session) await stopSession(session, registry, timings)
    },
    list: (): LiveSessionInfo[] => registry.list(),
    /** Start or resume; an already running session is refused. */
    start: (request: unknown, deliver: Delivery = ignore) =>
      start(state, service, request, deliver),
    /** A pi RPC command, unless commandRefusal refuses it. */
    command: (id: string, request: RpcCommand) => command(state, service, id, request),
    /** Send a controller's answer without treating it as an RPC command. */
    extensionUiResponse(id: string, response: ExtensionUIResponse): void {
      life.assertReady()
      const session = registry.get(id)
      if (!session || !session.client.alive) throw new Error('the session is not running')
      service.respond(id, response)
    },
    /** Let the turn end and be saved, then stop pi and its process group. */
    async stop(id: string): Promise<void> {
      if (options.routines?.owns(id)) throw new Error('routine owns this session')
      const session = registry.get(id)
      if (!session) throw new Error(`Unknown session: ${id}`)
      await stopSession(session, registry, timings)
    },
    /** Delete a stopped session's file. A running session is refused. */
    async remove(request: unknown): Promise<void> {
      const { sessionPath } = await parse(state, request, true)
      assertFilesKnown(state)
      await deleteLane(sessionPath)
    },
  }
}
