/**
 * Release mode: this lane becomes its repository's release manager. Dormant
 * in every other lane. GitHub is the queue, a ref on origin is the lease, and
 * a pass starts only when the queue's facts change, so waiting costs nothing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  claimLease,
  LEASE_RENEW_MS,
  releaseLease,
  runner,
  type Claimant,
  type ReleaseState,
  type Run,
} from './release-lease'
import {
  originPolicy,
  parsePolicy,
  POLICY_PATH,
  queueChanges,
  readQueue,
  type Policy,
} from './release-github'
import { releaseBashRefusal } from './release-guard'
import { applyReleaseContext, PASS_MESSAGE, passMessage, releasePrompt } from './release-prompt'
import { RELEASE_COMMAND, RELEASE_STATUS_KEY, type ReleaseStatus } from './release-status'
import { RELEASE_TOOLS, registerReleaseTools } from './release-tools'

export const WATCH_MS = 60_000
export const SWEEP_MS = 30 * 60_000

export interface ReleaseContext {
  cwd: string
  isIdle(): boolean
  hasPendingMessages(): boolean
  sessionManager: { getSessionId(): string; getBranch(): unknown[] }
  ui: { setStatus(key: string, text: string | undefined): void }
}

export interface ReleaseApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
  registerTool(definition: Record<string, unknown>): void
  registerCommand(
    name: string,
    command: { description: string; handler(args: string, ctx: unknown): Promise<void> },
  ): void
  appendEntry?(type: string, data: unknown): void
  sendMessage?(
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
  ): void
  getActiveTools?(): string[]
  setActiveTools?(names: string[]): void
}

type Spawn = (command: string, cwd: string) => Run

interface Lane {
  pi: ReleaseApi
  now: () => number
  spawn: Spawn
  ctx?: ReleaseContext
  cwd?: string
  git: Run
  gh: Run
  available: boolean
  enabled: boolean
  role: ReleaseStatus['role']
  state?: ReleaseState
  /** The run in progress, or the last one, is release work nobody needs an alert for. */
  quiet: boolean
  /** A person's prompt arrived; the run it starts is theirs. */
  userInput: boolean
  problem?: string
  policy: Policy
  lines: string[]
  passes: number
  lastPass: number
  lastClaim: number
  timer?: ReturnType<typeof setInterval>
  ticking: boolean
  writes: Promise<unknown>
}

/** Only this branch AND this session can switch release mode on; forks start off. */
export function savedRelease(branch: unknown[], sessionId: string): boolean {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as
      | { type?: string; customType?: string; data?: { sessionId?: string; enabled?: unknown } }
      | undefined
    if (entry?.type === 'custom' && entry.customType === RELEASE_COMMAND)
      return entry.data?.sessionId === sessionId && entry.data.enabled === true
  }
  return false
}

const unbound: Run = () => Promise.reject(new Error('Release mode has no session yet.'))
const sessionOf = (lane: Lane) => lane.ctx?.sessionManager.getSessionId() ?? ''
const claimant = (lane: Lane): Claimant => ({
  holder: `${hostname()}/${sessionOf(lane)}`,
  host: hostname(),
  pid: process.pid,
})
const localRef = (lane: Lane) =>
  `refs/phosphor-release/${sessionOf(lane).replace(/[^\w.-]/g, '_') || 'session'}`
const plain = (error: unknown) => (error instanceof Error ? error.message : String(error))
const idle = (lane: Lane) => !!lane.ctx?.isIdle() && !lane.ctx.hasPendingMessages()
/** False once release mode is off or the session shut down: stop acting on GitHub. */
const running = (lane: Lane) => lane.enabled && !!lane.timer

function bind(lane: Lane, ctx: ReleaseContext): void {
  lane.ctx = ctx
  if (lane.cwd !== ctx.cwd) {
    lane.cwd = ctx.cwd
    lane.git = lane.spawn('git', ctx.cwd)
    lane.gh = lane.spawn('gh', ctx.cwd)
  }
  const file = join(ctx.cwd, POLICY_PATH)
  lane.available = existsSync(file)
  if (lane.available && !lane.passes) lane.policy = parsePolicy(readFileSync(file, 'utf8'))
}

function publish(lane: Lane): void {
  const lease = lane.state?.lease
  const status: ReleaseStatus = {
    version: 1,
    available: lane.available,
    enabled: lane.enabled,
    role: lane.role,
    quiet: lane.quiet,
    ...(lane.enabled && lease ? { holder: lease.host, epoch: lease.epoch } : {}),
    ...(lane.enabled && lane.problem ? { problem: lane.problem } : {}),
  }
  try {
    const shown = lane.available || lane.enabled
    lane.ctx?.ui.setStatus(RELEASE_STATUS_KEY, shown ? JSON.stringify(status) : undefined)
  } catch {
    // A context from a replaced session; the next lifecycle event brings a fresh one.
  }
}

/** The release tools are declared to the model only while this lane holds the lease. */
function setRole(lane: Lane, role: ReleaseStatus['role'], state?: ReleaseState): void {
  lane.role = role
  if (state) lane.state = state
  const active = lane.pi.getActiveTools?.()
  if (active && lane.pi.setActiveTools) {
    const others = active.filter((name) => !RELEASE_TOOLS.includes(name))
    const next = role === 'active' ? [...others, ...RELEASE_TOOLS] : others
    if (next.length !== active.length) lane.pi.setActiveTools(next)
  }
  publish(lane)
}

/** Writes to the release ref run one at a time, so this lane never races itself. */
function exclusive<T>(lane: Lane, work: () => Promise<T>): Promise<T> {
  const next = lane.writes.then(work, work)
  lane.writes = next.catch(() => undefined)
  return next
}

async function claim(lane: Lane, takeover = false): Promise<void> {
  const result = await exclusive(lane, () =>
    claimLease(lane.git, localRef(lane), claimant(lane), lane.now(), takeover),
  )
  lane.lastClaim = lane.now()
  if (lane.enabled) setRole(lane, result.role, result.state)
}

async function maybePass(lane: Lane): Promise<void> {
  if (!idle(lane)) return
  const queue = await readQueue(lane.gh, lane.git, lane.policy.base)
  const changes = queueChanges(lane.lines, queue.lines)
  const now = lane.now()
  const sweep = queue.actionable && now - lane.lastPass >= SWEEP_MS
  if (!running(lane) || (lane.passes > 0 && !changes.length && !sweep)) return
  await claim(lane) // The freshest memory, and proof this lane still holds the lease.
  if (!running(lane) || lane.role !== 'active' || !lane.state?.lease) return
  lane.policy = await originPolicy(lane.git, lane.policy.base)
  if (!running(lane) || !idle(lane)) return
  const reason = lane.passes === 0 ? 'first' : changes.length ? 'changed' : 'sweep'
  lane.lines = queue.lines
  lane.passes++
  lane.lastPass = now
  const content = passMessage({
    pass: lane.passes,
    epoch: lane.state.lease.epoch,
    base: lane.policy.base,
    reason,
    changes,
    queue: queue.lines,
    memory: lane.state.memory,
    ledger: lane.state.ledger,
  })
  // followUp: should a person's prompt slip in first, the pass waits behind it.
  lane.pi.sendMessage?.(
    { customType: PASS_MESSAGE, content, display: true },
    { triggerTurn: true, deliverAs: 'followUp' },
  )
}

async function tick(lane: Lane): Promise<void> {
  if (lane.ticking || !running(lane) || !lane.ctx) return
  lane.ticking = true
  try {
    if (lane.now() - lane.lastClaim >= LEASE_RENEW_MS) await claim(lane)
    if (lane.role === 'active') await maybePass(lane)
    if (lane.problem) {
      lane.problem = undefined
      publish(lane)
    }
  } catch (error) {
    lane.problem = plain(error)
    // A lease this lane could not renew stops being safe to act on once it lapses.
    const expires = Date.parse(lane.state?.lease?.expires ?? '')
    if (lane.role === 'active' && !(expires > lane.now())) setRole(lane, 'standby')
    else publish(lane)
  } finally {
    lane.ticking = false
  }
}

function start(lane: Lane): void {
  if (!lane.timer) {
    lane.timer = setInterval(() => void tick(lane), WATCH_MS)
    lane.timer.unref?.()
  }
  void tick(lane)
}

function stop(lane: Lane): void {
  clearInterval(lane.timer)
  lane.timer = undefined
}

async function switchOff(lane: Lane): Promise<void> {
  lane.pi.appendEntry?.(RELEASE_COMMAND, { enabled: false, sessionId: sessionOf(lane) })
  const held = lane.role === 'active'
  lane.enabled = false
  lane.quiet = false
  stop(lane)
  setRole(lane, 'off')
  // Hand over now, rather than make a standby wait for the lease to lapse.
  if (held)
    await exclusive(lane, () =>
      releaseLease(lane.git, localRef(lane), claimant(lane), lane.now()),
    ).catch(() => undefined)
}

async function command(lane: Lane, args: string, ctx: ReleaseContext): Promise<void> {
  const word = args.trim()
  if (word !== 'on' && word !== 'off' && word !== 'takeover')
    throw new Error('Expected release on, off or takeover.')
  bind(lane, ctx)
  if (word === 'off') return switchOff(lane)
  if (!lane.available)
    throw new Error(
      `Release mode needs ${POLICY_PATH} in this lane's checkout. Run /skill:release-setup, merge its pull request, then switch release mode on in a lane started from the updated base.`,
    )
  if (!lane.pi.appendEntry) throw new Error('This pi version cannot persist release mode.')
  if (!lane.enabled) {
    lane.pi.appendEntry(RELEASE_COMMAND, { enabled: true, sessionId: sessionOf(lane) })
    lane.enabled = true
    lane.lastClaim = 0
    setRole(lane, 'standby')
  }
  if (word === 'takeover') await claim(lane, true)
  start(lane)
  if (word === 'takeover' && lane.role !== 'active')
    throw new Error('Another lane took the release lease first. Try the takeover again.')
}

function restore(lane: Lane, ctx: ReleaseContext): void {
  bind(lane, ctx)
  lane.enabled = savedRelease(ctx.sessionManager.getBranch(), sessionOf(lane))
  lane.quiet = false
  if (!lane.enabled) {
    stop(lane)
    setRole(lane, 'off')
    return
  }
  // Active again only once origin says so.
  lane.lastClaim = 0
  setRole(lane, 'standby')
  start(lane)
}

function registerTools(lane: Lane): void {
  registerReleaseTools(lane.pi, {
    git: (args, input) => lane.git(args, input),
    gh: (args, input) => lane.gh(args, input),
    local: () => localRef(lane),
    claimant: () => claimant(lane),
    epoch: () => (lane.role === 'active' ? lane.state?.lease?.epoch : undefined),
    policy: () => lane.policy,
    exclusive: (work) => exclusive(lane, work),
    flag: () => {
      lane.quiet = false
      publish(lane)
    },
    lost: () => {
      setRole(lane, 'standby')
      lane.lastClaim = 0
    },
    now: lane.now,
  })
}

/**
 * Decide, as each run starts, whether its end deserves an alert: a person's
 * prompt does; a pass, an answer or a sub-agent's report in release mode does
 * not, unless the manager flags it or someone speaks to the lane meanwhile.
 */
function watchRuns(lane: Lane): void {
  lane.pi.on('input', (event) => {
    const input = event as { source?: string; streamingBehavior?: string }
    if (input.source === 'extension') return
    // Mid-run, the message joins the current run; otherwise it starts the next one.
    if (!input.streamingBehavior) lane.userInput = true
    if (!lane.quiet) return
    lane.quiet = false
    publish(lane)
  })
  lane.pi.on('before_agent_start', () => {
    const quiet = lane.enabled && !lane.userInput
    lane.userInput = false
    if (quiet === lane.quiet) return
    lane.quiet = quiet
    publish(lane)
  })
}

export default function releaseManager(
  pi: ReleaseApi,
  now: () => number = Date.now,
  spawn: Spawn = runner,
): void {
  const lane: Lane = {
    pi,
    now,
    spawn,
    git: unbound,
    gh: unbound,
    available: false,
    enabled: false,
    role: 'off',
    quiet: false,
    userInput: false,
    policy: parsePolicy(''),
    lines: [],
    passes: 0,
    lastPass: 0,
    lastClaim: 0,
    ticking: false,
    writes: Promise.resolve(),
  }
  registerTools(lane)
  pi.registerCommand(RELEASE_COMMAND, {
    description: 'Host control: switch release mode on, off, or take over the release lease',
    handler: (args, ctx) => command(lane, args, ctx as ReleaseContext),
  })
  pi.on('session_start', (_event, ctx) => restore(lane, ctx as ReleaseContext))
  pi.on('session_tree', (_event, ctx) => restore(lane, ctx as ReleaseContext))
  pi.on('session_shutdown', () => {
    stop(lane)
    lane.ctx = undefined
  })
  watchRuns(lane)
  pi.on('tool_call', (event) => {
    const call = event as { toolName?: string; input?: { command?: unknown } }
    if (!lane.enabled || call.toolName !== 'bash' || typeof call.input?.command !== 'string') return
    const reason = releaseBashRefusal(call.input.command, lane.policy.base)
    return reason ? { block: true, reason } : undefined
  })
  pi.on('context_with_system', (event) => {
    const messages = (event as { messages: unknown[] }).messages
    const text = lane.enabled
      ? releasePrompt(lane.role === 'active' ? 'active' : 'standby', lane.state?.lease?.epoch)
      : undefined
    applyReleaseContext(messages, text)
    return { messages }
  })
}
