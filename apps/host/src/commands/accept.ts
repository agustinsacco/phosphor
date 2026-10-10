import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { errorText } from '@phosphor/shared/errors'
import type { SessionPush } from '@phosphor/shared/models'
import { ALL_THINKING_LEVELS } from '@phosphor/shared/thinking'
import type {
  AgentMessage,
  RpcCommand,
  RpcCommandType,
  RpcResponseDataMap,
} from '@phosphor/shared/rpc'
import { EXIT } from '../checks'
import { createHostLog, hostLogDirectory } from '../machine/log'
import { DRAIN, isGone, type DrainResult, type DrainTimings } from '../session/lifecycle'
import { parseSessionRequest, type HostSessionRequest } from '../session/request'
import { createHostRuntime, type HostRuntime } from '../session/runtime'
import type { Drainable } from '../shutdown'
import { HOST_SOURCE_SHA, HOST_VERSION } from '../version'
import { inspectHost, redactStrings, type DoctorContext, type DoctorReport } from './doctor'

export type AcceptLane = 'native' | 'claude'
export const CLAUDE_PROVIDER = 'pi-claude-cli'

export interface AcceptTimings {
  /** From a start or resume to its session answering, extension status included. */
  startMs: number
  /** One model turn, from sending the prompt to agent_end. */
  turnMs: number
  /** From sending the abort to agent_end. */
  abortMs: number
  /** pi's answer to any other command. */
  answerMs: number
}

export const ACCEPT_TIMINGS: AcceptTimings = {
  startMs: 60_000,
  turnMs: 180_000,
  abortMs: 10_000,
  answerMs: 30_000,
}

export interface AcceptContext extends DoctorContext {
  repository: string
  lane: AcceptLane | 'all'
  /** The native lane's provider and model, when pi's defaults would not do: pi-claude-cli, say. */
  provider?: string
  model?: string
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

const COUNT = 'Count from 1 to 2000, one number per line, with no other text.'
const RECALL =
  'Recall the PHX- token you replied with earlier in this session. ' +
  'Reply with exactly that token and nothing else.'

/** A step failed: its lane stops there, and the failure is in its steps. */
class StepFailed extends Error {}

/** The Host's own cleanup left a process group or a file behind. */
class CleanupFailed extends Error {}

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
  const claudeLane = report.lanes.claude
  if (context.lane === 'claude' && !claudeLane.available) {
    const problem = `the claude lane is unavailable: ${claudeLane.reason}`
    return { exitCode: EXIT.unavailable, problem }
  }
  if (context.provider === CLAUDE_PROVIDER) {
    return { exitCode: EXIT.usage, problem: `--provider ${CLAUDE_PROVIDER} is the claude lane` }
  }
  const lanes: AcceptLane[] = context.lane === 'all' ? ['native', 'claude'] : [context.lane]
  for (const lane of lanes) {
    const parsed = await parseSessionRequest(laneRequest(lane, context), machine.roots)
    if (!parsed.ok) {
      const problems = parsed.errors.map((error) => `${error.pointer} ${error.message}`)
      return { exitCode: EXIT.usage, problem: `the ${lane} lane cannot start: ${problems}` }
    }
  }
  const timings = { ...ACCEPT_TIMINGS, ...context.timings }
  const drainTimings = { ...DRAIN, ...context.drainTimings }
  const log = createHostLog(hostLogDirectory(context.env, context.home), secrets)
  // Every line leaves the Host now, so each is redacted: the log's own path
  // holds a passed XDG_STATE_HOME or HOME, whose value counts as a secret.
  const progress = (line: string) => context.progress(log.hide(line))
  progress(`log: ${log.path() ?? 'unavailable'}`)
  const runtime = createHostRuntime({ ...machine, log }, { timings: drainTimings })
  const detach = context.attach?.({ drain: runtime.drain, log }) ?? (() => {})
  log.write('host', 'accept', { config: report.config.path, lane: context.lane })

  const results: AcceptLaneResult[] = []
  let drain: DrainResult | null = null
  try {
    try {
      runtime.life.to('validating')
      runtime.life.to('ready')
      for (const lane of lanes) {
        if (lane === 'claude' && !claudeLane.available) {
          results.push(unavailableLane(lane, claudeLane.reason ?? 'unavailable'))
          progress(`claude: unavailable: ${claudeLane.reason}`)
          continue
        }
        const settleMs = drainTimings.settleMs
        results.push(await runLane(runtime, lane, context, { timings, settleMs, progress }))
      }
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

  const passed = results.some((lane) => lane.verdict === 'pass')
  const failed = results.some((lane) => lane.verdict === 'fail')
  const stopped = drain?.state === 'stopped'
  const claude = inspection.claude
  const evidence: AcceptEvidence = {
    schema: 1,
    verdict: passed && !failed && stopped ? 'pass' : 'fail',
    machine: `${report.config.hostId} · ${context.platform}-${process.arch}`,
    host: { version: HOST_VERSION, sourceSha: HOST_SOURCE_SHA, node: context.nodeVersion },
    pi: { version: inspection.piVersion, cli: machine.pi.prefixArgs[0] ?? machine.pi.binaryPath },
    claude: claude?.available
      ? { cli: claude.claude, version: claude.version }
      : { unavailable: claudeLane.reason ?? 'unavailable' },
    environment: { forwardedNames: report.environment?.names ?? [], valuesPrinted: false },
    lanes: results,
    drain,
    log: log.path(),
  }
  return { exitCode: acceptExitCode(evidence), evidence: redactStrings(evidence, secrets) }
}

/**
 * 70 when the drain failed, a signal's drain ran instead (the signal then
 * sets the code), or a lane's cleanup failed; otherwise 0 for a pass and 1
 * for a failure.
 */
export function acceptExitCode(
  evidence: Pick<AcceptEvidence, 'verdict' | 'drain' | 'lanes'>,
): number {
  if (evidence.drain?.state !== 'stopped') return EXIT.internal
  if (evidence.lanes.some((lane) => lane.steps.some((step) => step.cleanup))) return EXIT.internal
  return evidence.verdict === 'pass' ? EXIT.ok : 1
}

/** What a lane asks the runtime for: Claude through its provider, native on the defaults or as named. */
function laneRequest(lane: AcceptLane, context: AcceptContext): HostSessionRequest {
  if (lane === 'claude') return { repository: context.repository, provider: CLAUDE_PROVIDER }
  return {
    repository: context.repository,
    ...(context.provider !== undefined && { provider: context.provider }),
    ...(context.model !== undefined && { model: context.model }),
  }
}

const unavailableLane = (lane: AcceptLane, reason: string): AcceptLaneResult => ({
  lane,
  verdict: 'unavailable',
  reason,
  steps: [],
  extensionsLoaded: false,
  groupsAlive: 0,
  transcriptDeleted: false,
})

async function runLane(
  runtime: HostRuntime,
  lane: AcceptLane,
  context: AcceptContext,
  options: { timings: AcceptTimings; settleMs: number; progress: (line: string) => void },
): Promise<AcceptLaneResult> {
  const { timings, settleMs, progress } = options
  const result: AcceptLaneResult = {
    lane,
    verdict: 'fail',
    steps: [],
    extensionsLoaded: false,
    groupsAlive: 0,
    transcriptDeleted: false,
  }
  const watch = watcher()
  const request = laneRequest(lane, context)
  // Declared through `as`, so closures that set it keep it from narrowing to null.
  let session = null as { sessionId: string; pid?: number } | null

  async function step(name: string, run: () => Promise<void>): Promise<void> {
    const started = Date.now()
    try {
      await run()
    } catch (error) {
      const detail = errorText(error)
      const cleanup = error instanceof CleanupFailed
      result.steps.push({
        name,
        ok: false,
        ms: Date.now() - started,
        detail,
        ...(cleanup && { cleanup }),
      })
      progress(`${lane}: ${name} FAILED: ${detail}`)
      throw new StepFailed(detail)
    }
    result.steps.push({ name, ok: true, ms: Date.now() - started })
    progress(`${lane}: ${name} ok (${Date.now() - started} ms)`)
  }
  /** Send a command; pi must answer by `by`, which defaults to answerMs from now. */
  const call = <K extends RpcCommandType>(
    command: Extract<RpcCommand, { type: K }>,
    by: Deadline = deadline(timings.answerMs),
  ) => send<K>(runtime, live().sessionId, command, by)
  const live = () => {
    if (!session) throw new Error('no session is running')
    return session
  }
  /** Prompt, and wait for the turn to end. A turn that failed says why. */
  async function turn(message: string): Promise<string> {
    const ends = watch.count('agent_end')
    const by = deadline(timings.turnMs)
    await call({ type: 'prompt', message }, by)
    const end = await watch.until(() => watch.events('agent_end')[ends], by, 'agent_end')
    const last = end.messages.findLast((m: AgentMessage) => m.role === 'assistant')
    if (last && 'stopReason' in last && last.stopReason === 'error') {
      throw new Error(
        `the turn failed: ${('errorMessage' in last && last.errorMessage) || 'error'}`,
      )
    }
    return (await call({ type: 'get_last_assistant_text' })).text ?? ''
  }
  async function start(sessionPath?: string): Promise<void> {
    const mark = watch.mark()
    const by = deadline(timings.startMs)
    session = await within(
      runtime.start({ ...request, ...(sessionPath && { sessionPath }) }, watch.deliver),
      by,
      'answer to the start',
    )
    await watch.until(
      () => watch.since(mark).find(isBreakdownStatus),
      by,
      'phosphor-context-breakdown status',
    )
  }
  /**
   * Stop the session: its process group must be gone once it has had time to
   * go. A group left behind is a cleanup failure; a stop that failed with
   * nothing left, as when pi had already exited, fails the step only.
   */
  async function stop(): Promise<void> {
    const { sessionId, pid } = live()
    session = null
    const failed = await runtime.stop(sessionId).then(
      () => null,
      (error: unknown) => errorText(error),
    )
    if (pid === undefined) throw new CleanupFailed('pi had no process id to check')
    const until = Date.now() + settleMs
    while (!isGone(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 20))
    result.groupsAlive = isGone(pid) ? 0 : 1
    if (result.groupsAlive > 0) {
      throw new CleanupFailed(`process group ${pid} is still there${failed ? `: ${failed}` : ''}`)
    }
    if (failed) throw new Error(`the stop failed: ${failed}`)
  }

  const token = `PHX-${randomBytes(4).toString('hex')}`
  try {
    await step('start', async () => {
      await start()
      const { commands } = await call({ type: 'get_commands' })
      if (!commands.some((command) => command.name === 'phosphor-context-budget')) {
        throw new Error('get_commands does not list phosphor-context-budget')
      }
      result.extensionsLoaded = true
    })
    await step('state', async () => {
      const state = await call({ type: 'get_state' })
      result.provider = state.model?.provider
      result.model = state.model?.id
      result.thinkingLevel = state.thinkingLevel
      result.transcript = state.sessionFile
      const provider = lane === 'claude' ? CLAUDE_PROVIDER : context.provider
      const native = lane === 'native' && result.provider && result.provider !== CLAUDE_PROVIDER
      if (provider ? result.provider !== provider : !native) {
        const asked = provider ? `, not ${provider}` : ''
        throw new Error(`the ${lane} lane runs on provider ${result.provider ?? 'none'}${asked}`)
      }
      const model = lane === 'native' && context.model && modelId(context.model, provider)
      if (model && result.model !== model) {
        throw new Error(`the ${lane} lane runs model ${result.model ?? 'none'}, not ${model}`)
      }
      if (!state.sessionFile) throw new Error('pi names no session file')
    })
    await step('prompt', async () => {
      const reply = await turn(`Reply with exactly this token and nothing else: ${token}`)
      if (!reply.includes(token)) throw new Error('the reply does not hold the token')
    })
    await step('abort', async () => {
      const ends = watch.count('agent_end')
      const mark = watch.mark()
      const counting = deadline(timings.turnMs)
      await call({ type: 'prompt', message: COUNT }, counting)
      await watch.until(() => watch.since(mark).find(isTextDelta), counting, 'text delta')
      // The abort's own answer counts toward its deadline.
      const aborting = deadline(timings.abortMs)
      await call({ type: 'abort' }, aborting)
      await watch.until(() => watch.events('agent_end')[ends], aborting, 'agent_end')
      if ((await call({ type: 'get_state' })).isStreaming) throw new Error('pi is still streaming')
    })
    await step('dispose', stop)
    await step('resume', async () => {
      await start(result.transcript)
      const { messages } = await call({ type: 'get_messages' })
      const replies = messages.filter((m) => m.role === 'assistant')
      if (!replies.some((m) => JSON.stringify(m.content).includes(token))) {
        throw new Error('get_messages lacks the token reply')
      }
      if (!replies.some((m) => 'stopReason' in m && m.stopReason === 'aborted')) {
        throw new Error('get_messages lacks the aborted turn')
      }
      if (!(await turn(RECALL)).includes(token)) throw new Error('the recall lacks the token')
    })
    await step('close', async () => {
      await stop()
      const file = result.transcript!
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, at) => {
          if (!line.trim()) return
          try {
            JSON.parse(line)
          } catch {
            throw new Error(`the transcript is not JSONL at line ${at + 1}`)
          }
        })
      if (context.keepTranscripts) return
      await runtime
        .remove({ repository: context.repository, sessionPath: file })
        .catch((error: unknown) => {
          throw new CleanupFailed(`the deletion failed: ${errorText(error)}`)
        })
      result.transcriptDeleted = !existsSync(file)
      if (!result.transcriptDeleted) throw new CleanupFailed('the transcript is still there')
    })
    result.verdict = 'pass'
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error
  } finally {
    // A failed step can leave its session running. Its transcript is kept.
    if (session && !runtime.life.isDraining()) {
      await runtime.stop(session.sessionId).catch(() => {})
    }
  }
  return result
}

async function send<K extends RpcCommandType>(
  runtime: HostRuntime,
  sessionId: string,
  command: Extract<RpcCommand, { type: K }>,
  by: Deadline,
): Promise<RpcResponseDataMap[K]> {
  const response = await within(
    runtime.command(sessionId, command),
    by,
    `answer to ${command.type}`,
  )
  if (!response.success) throw new Error(`${command.type} failed: ${response.error}`)
  return response.data as RpcResponseDataMap[K]
}

/**
 * The model id a --model names. pi also takes `provider/id`, and a
 * `:level` thinking suffix; anything else must be pi's id exactly.
 */
function modelId(model: string, provider: string | undefined): string {
  const bare =
    provider && model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model
  const colon = bare.lastIndexOf(':')
  const suffix = bare.slice(colon + 1) as (typeof ALL_THINKING_LEVELS)[number]
  return colon > 0 && ALL_THINKING_LEVELS.includes(suffix) ? bare.slice(0, colon) : bare
}

/** A moment a wait must end by, and the span it was given, for its message. */
interface Deadline {
  at: number
  ms: number
}
const deadline = (ms: number): Deadline => ({ at: Date.now() + ms, ms })
const left = (by: Deadline) => Math.max(0, by.at - Date.now())

const isBreakdownStatus = (push: SessionPush) =>
  push.kind === 'extension-ui' &&
  push.request.method === 'setStatus' &&
  push.request.statusKey === 'phosphor-context-breakdown'

const isTextDelta = (push: SessionPush) =>
  push.kind === 'event' &&
  push.event.type === 'message_update' &&
  push.event.assistantMessageEvent.type === 'text_delta'

/** A session's pushes, and waits on them that fail when pi exits. */
function watcher() {
  const pushes: SessionPush[] = []
  const waiting = new Set<() => void>()
  const events = <T extends string>(type: T) =>
    pushes.flatMap((push) =>
      push.kind === 'event' && push.event.type === type
        ? [push.event as Extract<typeof push.event, { type: T }>]
        : [],
    )
  return {
    deliver(push: SessionPush): void {
      pushes.push(push)
      for (const check of waiting) check()
    },
    events,
    count: (type: string) => events(type).length,
    mark: () => pushes.length,
    since: (mark: number) => pushes.slice(mark),
    /** The first truthy value of `find`, checked on every push until `by`. */
    until<T>(find: () => T | undefined, by: Deadline, what: string): Promise<T> {
      const exits = pushes.filter((push) => push.kind === 'exit').length
      return new Promise<T>((resolve, reject) => {
        const done = (settle: () => void) => {
          clearTimeout(timer)
          waiting.delete(check)
          settle()
        }
        const check = () => {
          const found = find()
          if (found) return done(() => resolve(found))
          const exit = pushes.filter((push) => push.kind === 'exit')[exits]
          if (exit?.kind === 'exit') {
            const how = exit.signal ?? `code ${exit.code}`
            done(() => reject(new Error(`pi exited (${how}) while waiting for ${what}`)))
          }
        }
        const timer = setTimeout(
          () => done(() => reject(new Error(`no ${what} within ${by.ms} ms`))),
          left(by),
        )
        waiting.add(check)
        check()
      })
    },
  }
}

/** The promise's value, unless `by` comes first. */
async function within<T>(promise: Promise<T>, by: Deadline, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no ${what} within ${by.ms} ms`)), left(by))
  })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

const MARK = { pass: 'pass', fail: 'FAIL', unavailable: 'n/a ' } as const

export function renderAccept(evidence: AcceptEvidence): string {
  const lines = [`phosphor accept · ${evidence.machine} · ${evidence.host.version}`]
  for (const lane of evidence.lanes) {
    const runsOn = [lane.provider, lane.model, lane.thinkingLevel].filter(Boolean).join(' · ')
    lines.push(`${MARK[lane.verdict]}  ${lane.lane.padEnd(7)} ${lane.reason ?? runsOn}`)
    for (const step of lane.steps) {
      const how = step.ok ? `${step.ms} ms` : step.detail
      lines.push(`  ${step.ok ? 'ok  ' : 'FAIL'}  ${step.name.padEnd(8)} ${how}`)
    }
    if (lane.transcript && !lane.transcriptDeleted) lines.push(`  kept    ${lane.transcript}`)
  }
  const drain = evidence.drain
  lines.push(
    `drain ${drain ? `${drain.state}, ${drain.remaining.length} groups left` : 'by signal'}`,
  )
  if (evidence.log) lines.push(`log ${evidence.log}`)
  lines.push(evidence.verdict)
  return `${lines.join('\n')}\n`
}
