import { CLAUDE_TITLE_FALLBACK } from '@phosphor/session-runtime/pi/title-policy'
import type { TitleCandidate, TitleModel } from '@phosphor/session-runtime/pi/title-policy'
import {
  createTitleMemory,
  planTitleRun,
  runTitleAttempts,
  titleRunEnv,
  type TitleFailure,
} from '@phosphor/session-runtime/pi/title-run'
import { claudeAccountEnv } from '@phosphor/session-runtime/claude/routing'
import { piAgentDir } from '@phosphor/session-runtime/pi/pi-paths'
import { hostAutoNameLanes } from '../config/live-policy'
import type { HostConfigV1 } from '../config/schema'
import type { HostClaudeAccounts } from '../providers/accounts'
import type { HostMachine, HostRuntime } from '../session/runtime'

export type NamingOutcome =
  | 'applied'
  | 'skipped-disabled'
  | 'skipped-not-eligible'
  | 'skipped-no-model'
  | 'print-failed'
  | 'print-timeout'
  | 'stale'
  | 'set-failed'

/** What lane.naming may log about a failed run: fixed tokens and a count, never output. */
export interface NamingFailure {
  /** `setup` when the run could not start: the plan or the account lookup threw. */
  reason: TitleFailure | 'setup'
  attempts: number
}

export interface LaneNamingJob {
  sessionId: string
  cwd: string
  message: string
  /** The lane's own model, from its `get_state`. */
  model: TitleModel
  models: TitleCandidate[]
  /** Titles of the repository's other lanes, for the prompt and the dedupe. */
  existingNames: string[]
  current(): boolean
  apply(title: string): Promise<'applied' | 'stale' | 'set-failed' | void>
  outcome?(outcome: NamingOutcome, failure?: NamingFailure): void
}

export interface LaneNamingPorts {
  /** Read per lane, at its first prompt: Settings saves it to the Host config. */
  enabled?: () => boolean
  /** The env of the Claude account the lane's session was routed to. */
  accountEnv?: (sessionId: string) => Promise<Record<string, string>>
}

/**
 * The Host's naming ports: the live auto-name switch, and the env of the
 * Claude account the lane was routed to, so a lane bound to a second account
 * is named on that account and not on the CLI's default keychain entry.
 */
export function hostLaneNaming(
  config: { path: string; config: HostConfigV1 },
  runtime: Pick<HostRuntime, 'accountForSession'>,
  accounts: Pick<HostClaudeAccounts, 'loadAccounts'> | undefined,
): LaneNamingPorts {
  return {
    enabled: hostAutoNameLanes(config.path, config.config),
    accountEnv: async (sessionId) => {
      const id = runtime.accountForSession(sessionId)
      if (!id) return {}
      const account = (await accounts?.loadAccounts())?.accounts.find((entry) => entry.id === id)
      // Never fall back to the default account: that bills, and fails on, the wrong one.
      if (!account) throw new Error('the routed Claude account is gone')
      return claudeAccountEnv(account)
    },
  }
}

/** The Host keeps a title small: a 4 KiB reply cap, no stderr, 30 s per attempt. */
const HOST_PRINT = {
  timeoutMs: 30_000,
  stderr: 'ignore',
  maxOutputBytes: 4096,
  overflow: 'fail',
} as const

/**
 * FIFO work is bounded independently of the lane count: one run at a time,
 * at most 64 waiting. Failed naming stays silent apart from its outcome.
 */
export function createLaneNamer(
  machine: Pick<HostMachine, 'pi' | 'env'>,
  ports: LaneNamingPorts = {},
) {
  const controller = new AbortController()
  const memory = createTitleMemory()
  // The runtime's own rule, so the fast boot finds the provider the lane runs on.
  const agentDir = piAgentDir(machine.env)
  let tail = Promise.resolve()
  let pending = 0
  const live = () => !controller.signal.aborted
  async function run(job: LaneNamingJob) {
    if (!live() || !job.current()) return job.outcome?.('stale')
    const fallback = job.model.provider === 'pi-claude-cli' ? CLAUDE_TITLE_FALLBACK : job.model
    const plan = await planTitleRun(memory, {
      cwd: job.cwd,
      provider: job.model.provider,
      model: job.model.id,
      catalogue: async () => job.models,
      fallback,
      agentDir,
    })
    const account = (await ports.accountEnv?.(job.sessionId)) ?? {}
    if (!live() || !job.current()) return job.outcome?.('stale')
    const result = await runTitleAttempts({
      pi: machine.pi,
      cwd: job.cwd,
      env: titleRunEnv(machine.env, account),
      message: job.message,
      existingNames: job.existingNames,
      plan,
      memory,
      defaultProvider: job.model.provider,
      print: { ...HOST_PRINT, signal: controller.signal },
    })
    if (!job.current() || !live()) return job.outcome?.('stale')
    if (!result.title) {
      const reason = result.failures.at(-1)?.reason ?? 'empty'
      const outcome = reason === 'timeout' ? 'print-timeout' : 'print-failed'
      return job.outcome?.(outcome, { reason, attempts: result.failures.length })
    }
    try {
      // Apply first: an optional call skips evaluating its arguments.
      const applied = await job.apply(result.title)
      job.outcome?.(applied ?? 'applied')
    } catch {
      job.outcome?.('set-failed')
    }
  }
  const name = (job: LaneNamingJob) => {
    if (!live() || pending >= 64) {
      job.outcome?.('stale')
      return
    }
    pending++
    tail = tail
      .then(() => run(job))
      .catch(() => job.outcome?.('print-failed', { reason: 'setup', attempts: 0 }))
      .finally(() => {
        pending--
      })
  }
  return Object.assign(name, {
    enabled: ports.enabled ?? (() => true),
    cancel() {
      controller.abort()
    },
  })
}

export function titleCandidates(data: unknown): TitleCandidate[] {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('models' in data) ||
    !Array.isArray(data.models) ||
    data.models.length > 20000
  )
    return []
  return data.models.flatMap((m: unknown) => {
    if (
      typeof m !== 'object' ||
      m === null ||
      !('provider' in m) ||
      !('id' in m) ||
      typeof m.provider !== 'string' ||
      typeof m.id !== 'string'
    )
      return []
    const cost = 'cost' in m ? m.cost : null
    return [
      {
        provider: m.provider,
        id: m.id,
        ...(typeof cost === 'object' &&
        cost !== null &&
        'input' in cost &&
        'output' in cost &&
        typeof cost.input === 'number' &&
        typeof cost.output === 'number'
          ? { cost: { input: cost.input, output: cost.output } }
          : {}),
      },
    ]
  })
}
