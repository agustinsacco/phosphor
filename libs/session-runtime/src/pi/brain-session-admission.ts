import { resolve } from 'node:path'
import { isWithinFolder } from '@phosphor/shared/paths'
import type { BrainExecutionProfile } from './brain-execution-profile'
import {
  BRAIN_OWNER_CUSTOM_TYPE,
  brainOwnerFromEntry,
  type BrainSessionOwner,
} from './brain-session-owner'
import { readLinesFrom } from './session-fold'
import { sessionPathKey } from './session-path-lock'
import type { LiveSession, SessionRegistry } from './session-registry'

export async function readBrainSessionOwner(path: string): Promise<BrainSessionOwner | undefined> {
  let owner: BrainSessionOwner | undefined
  await readLinesFrom(path, 0, (line) => {
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (entry?.type !== 'custom' || entry.customType !== BRAIN_OWNER_CUSTOM_TYPE) return
    const found = brainOwnerFromEntry(entry)
    if (!found || (owner && owner.jobId !== found.jobId))
      throw new Error('Brain transcript has invalid or conflicting ownership metadata.')
    owner = found
  })
  return owner
}

/** Run inside the same owner-local path lock as resume/deletion. */
export async function assertBrainTranscriptAdmission(
  path: string,
  profile?: BrainExecutionProfile,
): Promise<void> {
  const owner = await readBrainSessionOwner(path)
  if (!profile && owner)
    throw new Error('Brain processor transcripts cannot be resumed or forked manually.')
  if (
    profile &&
    (!owner ||
      owner.jobId !== profile.owner.jobId ||
      !isWithinFolder(sessionPathKey(path), sessionPathKey(profile.sessionDir)))
  )
    throw new Error(
      'Brain resume requires its own persisted job transcript in the owned directory.',
    )
}

export function assertBrainLiveAdmission(live: LiveSession, profile?: BrainExecutionProfile): void {
  if (live.owner || profile) {
    if (!live.owner || !profile || live.owner.jobId !== profile.owner.jobId)
      throw new Error('Brain processor sessions cannot be attached to a manual or different owner.')
  }
}

/** Session ids cannot discover the isolated Brain directory; explicit/relative paths are checked. */
export async function assertNotBrainSource(
  path: string,
  cwd: string,
  registry: Pick<SessionRegistry, 'list' | 'get'>,
): Promise<void> {
  const key = sessionPathKey(resolve(cwd, path))
  for (const live of registry.list()) {
    if (live.diskPath && sessionPathKey(live.diskPath) === key) {
      const session = registry.get(live.sessionId)
      if (session) assertNoBrainControl(session)
    }
  }
  try {
    await assertBrainTranscriptAdmission(key)
  } catch (error) {
    // A bare pi session id is not necessarily a file. Let pi resolve ordinary ids as before.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Closed read-only set: future RPC commands are not admitted by naming convention. */
const BRAIN_OBSERVATIONS = new Set([
  'get_state',
  'get_messages',
  'get_session_stats',
  'get_available_models',
  'get_available_thinking_levels',
  'get_commands',
  'get_entries',
  'get_tree',
  'get_fork_messages',
  'get_last_assistant_text',
])

export function isBrainObservation(commandType: string): boolean {
  return BRAIN_OBSERVATIONS.has(commandType)
}

export function assertNoBrainControl(live: LiveSession): void {
  if (live.owner)
    throw new Error('Brain processor controls belong exclusively to its trusted controller.')
}
