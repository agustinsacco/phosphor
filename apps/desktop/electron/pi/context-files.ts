import {
  contextFileCommand,
  type ContextFileKind,
  type ContextFilePrefs,
} from '@shared/context-files'
import type { RpcCommand, RpcResponse } from '@shared/rpc'

export interface ContextFileDeps {
  /** Validates the kind, stores the preference new lanes start with, returns it. */
  save: (kind: ContextFileKind, included: boolean) => ContextFilePrefs
  isStub: () => boolean
  ownedByRoutine: (sessionId: string) => boolean
  session: (
    sessionId: string,
  ) => { client: { request: (command: RpcCommand) => Promise<RpcResponse> } } | undefined
}

/**
 * `app:setContextFile`: the preference for new lanes, and with a `sessionId`
 * that running lane too (`shared/context-files.ts`).
 *
 * A routine-owned lane is refused outright, preference included, the same as
 * every other manual command on it: a routine runs with the project's rules.
 */
export async function setLaneContextFile(
  deps: ContextFileDeps,
  kind: ContextFileKind,
  included: boolean,
  sessionId?: string,
): Promise<void> {
  if (sessionId && deps.ownedByRoutine(sessionId)) {
    throw new Error(
      'This lane is owned by a running routine. Cancel it from Routines before continuing manually.',
    )
  }
  const prefs = deps.save(kind, included)
  // The stub runs no extensions; it would answer the command as a prompt.
  if (!sessionId || deps.isStub()) return
  // A lane still starting reads the saved preference when it spawns.
  const session = deps.session(sessionId)
  if (!session) return
  // An extension command: pi runs it at once, mid-turn included, with no model.
  const result = await session.client.request({
    type: 'prompt',
    message: contextFileCommand(kind, prefs[kind]),
  })
  if (!result.success) throw new Error(result.error ?? 'Could not update this lane.')
}
