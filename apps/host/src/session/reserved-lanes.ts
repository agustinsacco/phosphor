/**
 * Lanes the Host keeps off every ordinary route: today only Brain Agent's. A reserved lane is a
 * real session in the shared registry, path locks and drain, but only the runtime handed back by
 * `reserveLane` starts, reads, commands, answers or stops it. Everything else treats its id as
 * unknown and its folder and transcripts as outside the configured repositories, so choosing the
 * same folder, resuming a copied transcript or asking by id never reaches it.
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { LiveSessionInfo } from '@phosphor/shared/models'
import type { ExtensionUIResponse, RpcCommand } from '@phosphor/shared/rpc'
import { isInside } from '@phosphor/session-runtime/fs-safety'
import { piSessionsRoot, sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import type { ReservedLane } from '@phosphor/session-runtime/pi/reserved-lane'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import { commandRefusal } from './command-policy'
import { stopSession } from './lifecycle'
import type { Delivery, RuntimeState } from './runtime-state'
import type { RuntimeService } from './runtime-wiring'

/** What an ordinary route says for a folder it may not use: the same as for one outside. */
export const OUTSIDE_REPOSITORIES = 'must be an existing folder inside a configured repository'

/** The real path, or the real parent joined with the last name while the path is missing. */
function real(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return join(realpathSync.native(dirname(path)), basename(path))
    } catch {
      return resolve(path)
    }
  }
}

const transcripts = (state: RuntimeState, lane: ReservedLane): string =>
  sessionDirForCwd(lane.folder, piSessionsRoot(state.machine.env))

/** Whether `path` is a reserved lane's folder, inside one, or inside its transcript folder. */
export function isReservedPath(state: RuntimeState, path: string): boolean {
  const target = real(path)
  return state.reserved.some(
    (lane) => isInside(lane.folder, target) || isInside(real(transcripts(state, lane)), target),
  )
}

/** A live session an ordinary route may reach: never a reserved one, whose id it does not know. */
export function ordinarySession(state: RuntimeState, id: string): LiveSession | undefined {
  const session = state.registry.get(id)
  return session?.reserved ? undefined : session
}

/** Throws as for an unknown id when `id` names a reserved session. */
export function assertOrdinary(state: RuntimeState, id: string): void {
  if (state.registry.get(id)?.reserved) throw new Error(`Unknown session: ${id}`)
}

/** What the start may resume: a reserved lane's own transcript, by real path, or nothing. */
function ownTranscript(state: RuntimeState, lane: ReservedLane, path: string): string {
  const file = real(path)
  if (dirname(file) !== real(transcripts(state, lane)) || !file.endsWith('.jsonl'))
    throw new Error('That file is not this lane’s transcript.')
  return file
}

export interface ReservedOpen {
  /** The transcript to resume; absent starts a new one named `name`. */
  sessionPath?: string
  name?: string
}

/**
 * Registers `lane` and returns the only handle that reaches its sessions. Its folder must exist;
 * one reservation per folder.
 */
export function reserveLane(state: RuntimeState, service: RuntimeService, lane: ReservedLane) {
  if (state.reserved.some((other) => other.folder === lane.folder))
    throw new Error('That folder is already reserved.')
  if (real(lane.folder) !== lane.folder) throw new Error('A reserved folder must be a real path.')
  state.reserved.push(lane)
  const own = (id: string): LiveSession => {
    const session = state.registry.get(id)
    if (!session || session.reserved !== lane) throw new Error(`Unknown session: ${id}`)
    return session
  }
  return {
    lane,
    /** Starts or resumes the lane; the live process when it already runs that transcript. */
    async open(request: ReservedOpen, deliver: Delivery): Promise<LiveSessionInfo> {
      state.life.assertReady()
      const sessionPath = request.sessionPath && ownTranscript(state, lane, request.sessionPath)
      const delivery: Delivery = (push) =>
        deliver(
          push.kind === 'stderr' ? { ...push, text: state.machine.log.hide(push.text) } : push,
        )
      const info = await service.create(
        {
          workspacePath: lane.folder,
          ...(sessionPath ? { sessionPath } : {}),
          ...(request.name && !sessionPath ? { name: request.name } : {}),
        },
        delivery,
        { reserved: lane, keepLastWorkspace: true },
      )
      own(info.sessionId)
      return info
    },
    /** The live client of this lane's session, or undefined for any other id. */
    client(id: string) {
      const session = state.registry.get(id)
      return session?.reserved === lane ? session.client : undefined
    },
    /** A pi RPC command, optionally rechecking the owner's exact turn at dispatch. */
    async command(id: string, command: RpcCommand, beforeDispatch?: () => boolean) {
      own(id)
      const refusal = commandRefusal(command)
      if (refusal) throw new Error(refusal)
      return service.command(id, command, beforeDispatch)
    },
    respond(id: string, response: ExtensionUIResponse): void {
      state.life.assertReady()
      if (!own(id).client.alive) throw new Error('the session is not running')
      service.respond(id, response)
    },
    /** Lets the turn end and be saved, then stops pi. */
    async stop(id: string): Promise<void> {
      await stopSession(own(id), state.registry, state.timings)
    },
  }
}

export type ReservedLaneRuntime = ReturnType<typeof reserveLane>
