import { readAgentSettings } from '@phosphor/session-runtime/pi/agent-settings'
import { join } from 'node:path'
import { errorText } from '@phosphor/shared/errors'
import { EXIT } from '../checks'
import { createHostLog, hostLogDirectory } from '../machine/log'
import { DRAIN, type DrainResult, type DrainTimings } from '../session/lifecycle'
import { parseSessionRequest } from '../session/request'
import { createHostRuntime, type HostRuntime } from '../session/runtime'
import { createHostClaudeAccounts } from '../providers/accounts'
import { hostStateDirectory } from '../lanes/state-dir'
import { seedArtifactSkill } from '@phosphor/session-runtime/bundled-skills'
import type { Drainable } from '../shutdown'
import { inspectHost, type DoctorContext, type DoctorReport, type HostInspection } from './doctor'
import { laneRequest, runLane, type AcceptLaneState } from './accept-lane'
import { acceptOutcome, unavailableLane } from './accept-report'
import { CLAUDE_PROVIDER } from './accept-steps'
export { CLAUDE_PROVIDER } from './accept-steps'
export { acceptExitCode, renderAccept } from './accept-report'

export type AcceptLane = 'native' | 'claude'

export interface AcceptTimings {
  /** From a start or resume to its session answering, extension status included. */
  startMs: number
  /** One model turn, from sending the prompt to agent_end. */
  turnMs: number
  /** From sending the abort to agent_end. */
  abortMs: number
  /** pi's answer to any other command. */
  answerMs: number
  /** A stop, from its start until pi and its output are gone. */
  stopMs: number
}

export const ACCEPT_TIMINGS: AcceptTimings = {
  startMs: 60_000,
  turnMs: 180_000,
  abortMs: 10_000,
  answerMs: 30_000,
  stopMs: 20_000,
}

export interface AcceptContext extends DoctorContext {
  repository: string
  lane: AcceptLane | 'all'
  /** The native lane's provider and model, when pi's defaults would not do: pi-claude-cli, say. */
  provider?: string
  model?: string
  /** The Claude lane's model. Without it the lane runs on pi's default, which must be Claude. */
  claudeModel?: string
  keepTranscripts: boolean
  /** One line of progress at a time, for stderr. */
  progress: (line: string) => void
  attach?: (target: Drainable) => () => void
  timings?: Partial<AcceptTimings>
  drainTimings?: Partial<DrainTimings>
}

export interface AcceptStep {
  name: string
  ok: boolean
  ms: number
  /** Why it failed. */
  detail?: string
  /** The Host's own cleanup failed, leaving a process group or a file behind: exit 70. */
  cleanup?: true
}

export interface AcceptLaneResult {
  lane: AcceptLane
  verdict: 'pass' | 'fail' | 'unavailable'
  /** Why the lane is unavailable. */
  reason?: string
  provider?: string
  model?: string
  thinkingLevel?: string
  steps: AcceptStep[]
  extensionsLoaded: boolean
  /** pi's process group, still present after a stop. */
  groupsAlive: number
  transcript?: string
  transcriptDeleted: boolean
}

export interface AcceptEvidence {
  schema: 1
  verdict: 'pass' | 'fail'
  machine: string
  host: { version: string; sourceSha: string | null; node: string }
  pi: { version: string | null; cli: string }
  claude: { cli: string; version: string } | { unavailable: string }
  environment: { forwardedNames: string[]; valuesPrinted: false }
  lanes: AcceptLaneResult[]
  drain: DrainResult | null
  log: string | null
}

export type AcceptOutcome =
  | { exitCode: number; evidence: AcceptEvidence }
  /** Nothing ran: the machine failed doctor (its report), or the request cannot run. */
  | { exitCode: number; problem: string; doctor?: DoctorReport }

/**
 * Real acceptance (spec section 18): per lane, start a session in the
 * acceptance repository, check that the bundled extensions loaded, play a
 * turn, abort one, stop, resume and recall, then stop and delete the
 * transcript. Every assertion is on a protocol fact or a file, except the
 * token echo and the recall, which depend on the model. A failure keeps the
 * transcript. The evidence has the secret values of pi's environment hidden.
 */
export async function runAccept(context: AcceptContext): Promise<AcceptOutcome> {
  const inspection = await inspectHost(context)
  const { report, machine, secrets } = inspection
  if (!machine) return { exitCode: report.exitCode, problem: 'doctor failed', doctor: report }
  const lanes: AcceptLane[] = context.lane === 'all' ? ['native', 'claude'] : [context.lane]
  const problem = await preflight(context, inspection, lanes, machine.roots)
  if (problem) return problem
  const timings = { ...ACCEPT_TIMINGS, ...context.timings }
  const drainTimings = { ...DRAIN, ...context.drainTimings }
  const log = createHostLog(hostLogDirectory(context.env, context.home), secrets)
  // Every line leaves the Host now, so each is redacted: the log's own path
  // holds a passed XDG_STATE_HOME or HOME, whose value counts as a secret.
  const progress = (line: string) => context.progress(log.hide(line))
  progress(`log: ${log.path() ?? 'unavailable'}`)
  const runtime = createHostRuntime(
    { ...machine, log },
    {
      timings: drainTimings,
      claudeAccounts: createHostClaudeAccounts({
        directory: hostStateDirectory(context.env, context.home),
        home: context.home,
        env: machine.env,
      }),
    },
  )
  const detach = context.attach?.({ drain: runtime.drain, log }) ?? (() => {})
  log.write('host', 'accept', { config: report.config.path, lane: context.lane })

  let results: AcceptLaneResult[]
  let drain: DrainResult | null = null
  try {
    try {
      results = await runLanes(runtime, machine.resourceRoot, lanes, report.lanes.claude, context, {
        timings,
        settleMs: drainTimings.settleMs,
        progress,
      })
    } finally {
      // A signal drains the runtime itself, and a second drain call would force it.
      if (!runtime.life.isDraining()) drain = await runtime.drain('accept finished')
      detach()
    }
  } catch (error) {
    // The CLI prints this as an internal error, and only here are the secrets
    // known. The error itself is not kept as a cause: it holds them unhidden.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(log.hide(errorText(error)))
  }
  return acceptOutcome({ ...inspection, machine }, context, results, drain, log.path())
}

async function preflight(
  context: AcceptContext,
  inspection: HostInspection,
  lanes: AcceptLane[],
  roots: readonly string[],
): Promise<Extract<AcceptOutcome, { problem: string }> | null> {
  if (roots.length === 0)
    return {
      exitCode: EXIT.usage,
      problem:
        'accept needs a repository. Add one with phosphor setup --repository PATH --replace, or from Desktop.',
    }
  const claudeLane = inspection.report.lanes.claude
  if (context.lane === 'claude' && !claudeLane.available) {
    const problem = `the claude lane is unavailable: ${claudeLane.reason}`
    return { exitCode: EXIT.unavailable, problem }
  }
  if (context.provider === CLAUDE_PROVIDER) {
    return { exitCode: EXIT.usage, problem: `--provider ${CLAUDE_PROVIDER} is the claude lane` }
  }
  if (lanes.includes('claude') && claudeLane.available && !context.claudeModel) {
    const settings = await readAgentSettings(context.repository)
    if (settings.defaultProvider !== CLAUDE_PROVIDER)
      return {
        exitCode: EXIT.usage,
        problem:
          "the claude lane cannot start: pi's default is not Claude, so name the lane's model with --claude-model",
      }
  }
  for (const lane of lanes) {
    const parsed = await parseSessionRequest(laneRequest(lane, context), roots)
    if (!parsed.ok) {
      const problems = parsed.errors.map((error) => `${error.pointer} ${error.message}`)
      return { exitCode: EXIT.usage, problem: `the ${lane} lane cannot start: ${problems}` }
    }
  }
  // pi starts on a named provider only together with a model: alone, it is ignored.
  if (context.provider !== undefined && context.model === undefined) {
    return { exitCode: EXIT.usage, problem: '--provider needs --model: pi ignores it alone' }
  }
  return null
}

async function runLanes(
  runtime: HostRuntime,
  resourceRoot: string,
  lanes: AcceptLane[],
  claudeLane: DoctorReport['lanes']['claude'],
  context: AcceptContext,
  options: Pick<AcceptLaneState, 'timings' | 'settleMs' | 'progress'>,
): Promise<AcceptLaneResult[]> {
  const results: AcceptLaneResult[] = []
  const { progress } = options
  runtime.life.to('validating')
  seedArtifactSkill(
    resourceRoot,
    context.env.PI_CODING_AGENT_DIR ?? join(context.home, '.pi', 'agent'),
  )
  runtime.life.to('ready')
  for (const lane of lanes) {
    if (lane === 'claude' && !claudeLane.available) {
      results.push(unavailableLane(lane, claudeLane.reason ?? 'unavailable'))
      progress(`claude: unavailable: ${claudeLane.reason}`)
      continue
    }
    results.push(await runLane(runtime, lane, context, options))
  }
  return results
}
