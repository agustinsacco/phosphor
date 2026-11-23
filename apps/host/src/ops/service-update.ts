import type { LanePauses } from '../lanes/pause'
import { probe, probeFailure, type ProbeResult } from '../machine/probe'
import { stagedVersionIn, UP_TO_DATE } from '../commands/update'

/** A staging run may download a release; applying hands off and returns. */
const STAGE_TIMEOUT_MS = 15 * 60_000
const APPLY_TIMEOUT_MS = 5 * 60_000

export type StageOutcome =
  | { readonly kind: 'staged'; readonly version: string }
  | { readonly kind: 'current' }
  | { readonly kind: 'failed'; readonly text: string }

/** D4's update pieces, run as this service's own installed updater. */
export interface ServiceUpdateSteps {
  /** `update --stage`: the exact version it reports it staged. */
  stage(): Promise<StageOutcome>
  /** `update --apply <v>`: selects it and restarts the service, handing off first. */
  apply(version: string): Promise<{ readonly ok: true } | { readonly ok: false; text: string }>
}

export interface ServiceUpdatePorts {
  readonly steps: ServiceUpdateSteps
  readonly pauses: Pick<LanePauses, 'begin' | 'cancel'>
}

type Run = (
  file: string,
  args: readonly string[],
  options: { env: Record<string, string>; secrets: string[]; timeoutMs: number },
) => Promise<ProbeResult>

/** The updater's two steps, as subprocesses of the installed release (`hostUpdateProgram`). */
export function updaterSteps(
  program: { node: string; bundle: string; env: Record<string, string> },
  run: Run = probe,
): ServiceUpdateSteps {
  const update = (args: readonly string[], timeoutMs: number) =>
    run(program.node, [program.bundle, 'update', ...args], {
      env: program.env,
      secrets: [],
      timeoutMs,
    })
  return {
    async stage() {
      const result = await update(['--stage'], STAGE_TIMEOUT_MS)
      if (result.code !== 0 || result.timedOut || result.error)
        return { kind: 'failed', text: `Staging the update failed${probeFailure(result)}.` }
      const version = stagedVersionIn(result.stdout)
      if (version) return { kind: 'staged', version }
      if (result.stdout.split('\n').includes(UP_TO_DATE)) return { kind: 'current' }
      return { kind: 'failed', text: 'The updater did not say which release it staged.' }
    },
    async apply(version) {
      const result = await update(['--apply', version], APPLY_TIMEOUT_MS)
      return result.code === 0 && !result.timedOut && !result.error
        ? { ok: true }
        : { ok: false, text: `Applying ${version} failed${probeFailure(result)}.` }
    },
  }
}

/**
 * `service.update`, run as a background job so the asking lane's turn ends
 * and the pause can settle: stage the newest release, pause every lane
 * (waiting for turns, never aborting), then apply exactly the staged version.
 * A pause that does not settle leaves the release staged and nothing applied.
 */
export async function runServiceUpdate(ports: ServiceUpdatePorts) {
  const staged = await ports.steps.stage()
  if (staged.kind === 'failed') throw new Error(staged.text)
  if (staged.kind === 'current')
    return { text: 'The Phosphor service is already up to date.', data: { outcome: 'current' } }
  const { version } = staged
  const paused = await ports.pauses.begin('update')
  if (paused !== 'paused')
    return {
      text: `Lanes did not pause (${paused}), so ${version} is staged but not applied. Try again when lanes are quiet.`,
      data: { outcome: 'not-paused', version, pause: paused },
    }
  const applied = await ports.steps.apply(version)
  if (!applied.ok) {
    ports.pauses.cancel()
    throw new Error(applied.text)
  }
  return {
    text: `Applying Phosphor service ${version}; it restarts now.`,
    data: { outcome: 'applying', version },
  }
}
