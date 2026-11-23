import type { CreateSessionOptions } from '@shared/models'
import type { RuntimeLog } from '../file-log'
import type { PiSpawnOptions } from './rpc-client'
import type { SessionExecution } from './session-policy'
import type { LiveSession } from './session-registry'

/** What one contributor adds to a lane's spawn. Extensions and skills are absolute paths. */
export interface SpawnInputs {
  readonly env?: Readonly<Record<string, string>>
  readonly extensions?: readonly string[]
  readonly skills?: readonly string[]
}

/** The lane being started, after the owner resolved its folder and policy. */
export interface SpawnPolicyFacts {
  readonly options: CreateSessionOptions
  readonly accountId?: string
}

export interface SpawnAttachContext {
  readonly execution: SessionExecution
  readonly options: CreateSessionOptions
  readonly log: RuntimeLog
}

/**
 * The one place a feature adds spawn-time inputs (env, `-e` extensions,
 * `--skill` skills) or binds to a started session. Each owner lists its
 * contributions in its `contributions/index.ts`; none applies to a stub launch.
 */
export interface SpawnContribution {
  /** Names the contributor in logs. */
  readonly name: string
  spawn(
    execution: SessionExecution,
    policy: SpawnPolicyFacts,
  ): Promise<SpawnInputs | undefined> | SpawnInputs | undefined
  /** Runs once the session exists, before pi's startup checks. */
  attach?(session: LiveSession, context: SpawnAttachContext): void
}

/**
 * Applies contributions in order. Optional inputs must never prevent an
 * ordinary lane from starting, so a failing contributor is logged and skipped.
 */
export async function applySpawnContributions(
  contributions: readonly SpawnContribution[],
  spawnOptions: Omit<PiSpawnOptions, 'cwd'>,
  execution: SessionExecution,
  policy: SpawnPolicyFacts,
  log: RuntimeLog,
): Promise<void> {
  for (const contribution of contributions) {
    let inputs: SpawnInputs | undefined
    try {
      inputs = await contribution.spawn(execution, policy)
    } catch (error) {
      log('pi', 'spawn contribution unavailable', {
        contribution: contribution.name,
        error: String(error),
      })
      continue
    }
    if (!inputs) continue
    if (inputs.env) spawnOptions.env = { ...spawnOptions.env, ...inputs.env }
    if (inputs.extensions?.length)
      spawnOptions.extensions = [...(spawnOptions.extensions ?? []), ...inputs.extensions]
    if (inputs.skills?.length)
      spawnOptions.skills = [...(spawnOptions.skills ?? []), ...inputs.skills]
  }
}

/** A contributor's `attach` failing is logged; the lane keeps starting. */
export function attachSpawnContributions(
  contributions: readonly SpawnContribution[],
  session: LiveSession,
  context: SpawnAttachContext,
): void {
  for (const contribution of contributions) {
    try {
      contribution.attach?.(session, context)
    } catch (error) {
      context.log('pi', 'spawn contribution attach failed', {
        contribution: contribution.name,
        error: String(error),
      })
    }
  }
}
