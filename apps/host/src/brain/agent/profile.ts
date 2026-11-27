/**
 * Which launch the reserved Brain Agent process gets. A person's message runs only in the
 * interactive profile, and only from a launch the Host has qualified: the process loads
 * `brain-agent-guard.mjs`, which blocks non-curator tool calls that reach its hook. The
 * conversation checks that pi reports the guard and the expected state before every prompt;
 * neither check establishes closure. Defrag runs in the broad profile, with every tool the
 * Host's Brain Agent has always had. One process at a time: switching profiles restarts the lane
 * on the same transcript.
 */
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BRAIN_AGENT_GUARD_COMMAND } from '@phosphor/shared/brain-agent'
import type { RpcSessionState, RpcSlashCommand } from '@phosphor/shared/rpc'

export { BRAIN_AGENT_GUARD_COMMAND }

export type BrainAgentProfileKind = 'interactive' | 'defrag'

/**
 * An interactive launch proven to run every effect of a person's turn through the guard: pi loads
 * only the extensions the Host names, and every tool, provider-native ones included, reaches the
 * guard's `tool_call`. A provider name or a document is not that proof. No production launch
 * qualifies yet, so the Host refuses every person's message before pi starts; tests pass a
 * synthetic one to exercise the guarded path.
 */
export interface QualifiedInteractiveLaunch {
  /** Whether pi's `get_state` for the exact live process shows this launch. */
  matches(state: RpcSessionState): boolean
}

export interface BrainAgentLaunchProfile {
  /** Real path of the bundle's guard extension; null when this bundle has none. */
  readonly guard: string | null
  /** The qualified interactive launch; null (production today) refuses every person's message. */
  readonly qualified: QualifiedInteractiveLaunch | null
  /** What the next spawn of the reserved lane loads; set only by the conversation, as it opens. */
  next: BrainAgentProfileKind
}

export function createBrainAgentLaunchProfile(
  guard: string | null,
  qualified: QualifiedInteractiveLaunch | null = null,
): BrainAgentLaunchProfile {
  return { guard, qualified, next: 'interactive' }
}

/** Whether a person's message can run at all: a guard to load and a qualified launch. */
export const messagingQualified = (profile: BrainAgentLaunchProfile): boolean =>
  profile.guard !== null && profile.qualified !== null

/** The bundle's guard, by real path, or null when the bundle does not ship one. */
export function hostBrainAgentGuard(resourceRoot: string): string | null {
  const path = join(resourceRoot, 'brain-ext', 'brain-agent-guard.mjs')
  return existsSync(path) ? realpathSync.native(path) : null
}

function real(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/** Whether pi's `get_commands` data shows the guard, loaded from exactly `guard`. */
export function guardLoaded(data: unknown, guard: string): boolean {
  const commands =
    typeof data === 'object' && data !== null && 'commands' in data ? data.commands : null
  if (!Array.isArray(commands)) return false
  return (commands as Partial<RpcSlashCommand>[]).some(
    (command) =>
      command?.name === BRAIN_AGENT_GUARD_COMMAND &&
      command.source === 'extension' &&
      typeof command.sourceInfo?.path === 'string' &&
      real(command.sourceInfo.path) === guard,
  )
}
