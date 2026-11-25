import { contextBudgetTokens, sessionContextBudget } from '@shared/context-budget'
import type { PiRpcClient } from './rpc-client'
import type { RpcCommand, RpcSessionState } from '@shared/rpc'
import type { RuntimeLog } from '../file-log'

interface BudgetGate {
  tail: Promise<void>
  checking: boolean
  stopped: boolean
  revision: number
}

interface BudgetRuntimeState {
  gates: Map<string, BudgetGate>
  log: RuntimeLog
}
/** Keep checks and state-changing RPC commands in order, including prompt preflight. */
function enqueue<T>(gate: BudgetGate, action: () => Promise<T>): Promise<T> {
  const result = gate.tail.then(action)
  gate.tail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

type BudgetClient = Pick<PiRpcClient, 'request'>
// A new pi process never inherits a staged budget from a previous client.
const staged = new WeakMap<BudgetClient, string>()

export function forgetStagedBudget(client: BudgetClient): void {
  staged.delete(client)
}

async function readBudgetState(client: BudgetClient): Promise<RpcSessionState> {
  const state = await client.request({ type: 'get_state' })
  if (!state.success || !state.data) throw new Error('Cannot read pi context budget state.')
  return state.data
}

/** Explicit updates always stage; prompt preflight supplies its already verified state. */
export async function syncContextBudget(
  client: BudgetClient,
  rawBudget: string,
  promptState?: RpcSessionState,
): Promise<void> {
  const state = promptState ?? (await readBudgetState(client))
  const { model, autoCompactionEnabled } = state
  const budget = autoCompactionEnabled ? contextBudgetTokens(rawBudget) : null
  const key = (window: number | undefined) =>
    JSON.stringify([
      state.sessionId,
      model?.provider,
      model?.id,
      window,
      autoCompactionEnabled,
      budget,
    ])
  const observed = model?.contextWindow
  const capped = observed !== undefined && budget !== null ? Math.min(observed, budget) : observed
  // Remember the capped window, not the over-budget one: an extension can replace
  // a model with its uncapped catalogue entry without a model_select event.
  if (promptState && staged.get(client) === key(observed)) return
  forgetStagedBudget(client)
  const result = await client.request({
    type: 'prompt',
    message: `/phosphor-context-budget ${budget ?? 'off'}`,
  })
  if (!result.success) throw new Error(result.error ?? 'Cannot apply pi context budget.')
  staged.set(client, key(capped))
}

/** A failed check leaves the session alone; a failed compaction is reported by pi. */
async function enforceContextBudget(
  { log }: BudgetRuntimeState,
  sessionId: string,
  client: Pick<PiRpcClient, 'request'>,
  rawBudget: string,
  cancelled: () => boolean = () => false,
): Promise<void> {
  try {
    const state = await client.request({ type: 'get_state' })
    if (!state.success || !state.data) return
    const { model, autoCompactionEnabled, isStreaming, isCompacting } = state.data
    if (isStreaming || isCompacting) return
    const budget = sessionContextBudget({
      raw: rawBudget,
      contextWindow: model?.contextWindow,
      autoCompactionEnabled,
    })
    if (budget === null || cancelled()) return
    const stats = await client.request({ type: 'get_session_stats' })
    const tokens = stats.success ? stats.data?.contextUsage?.tokens : null
    if (tokens == null || !Number.isFinite(tokens) || tokens <= budget || cancelled()) return
    log('pi', 'context over budget; compacting', { sessionId, tokens, budget })
    const result = await client.request({ type: 'compact' })
    if (!result.success) log('pi', 'budget compaction failed', { sessionId, error: result.error })
  } catch (error) {
    log('pi', 'budget check failed', { sessionId, error: String(error) })
  }
}

/**
 * Check after settlement, never mid-turn: RPC compact aborts any running turn.
 * `paused` skips a settlement outright (a routine owns the session); it is read
 * when the turn settles, so a session it lets go is checked from its next turn.
 */
function watchContextBudget(
  runtime: BudgetRuntimeState,
  sessionId: string,
  client: Pick<PiRpcClient, 'request' | 'on'>,
  readBudget: () => string,
  paused: () => boolean = () => false,
): void {
  const gate: BudgetGate = {
    tail: Promise.resolve(),
    checking: false,
    stopped: false,
    revision: 0,
  }
  runtime.gates.set(sessionId, gate)
  client.on('event', (event) => {
    if (event.type !== 'agent_settled' || gate.checking || gate.stopped || paused()) return
    gate.checking = true
    const revision = gate.revision
    const cancelled = (): boolean => gate.stopped || revision !== gate.revision
    void enqueue(gate, async () => {
      try {
        if (!cancelled())
          await enforceContextBudget(runtime, sessionId, client, readBudget(), cancelled)
      } catch (error) {
        runtime.log('pi', 'budget check failed', { sessionId, error: String(error) })
      } finally {
        gate.checking = false
      }
    })
  })
  client.on('exit', () => {
    gate.stopped = true
    runtime.gates.delete(sessionId)
  })
}

/**
 * pi rejects prompts during requested compaction. Wait for its actual response,
 * not a timeout: a valid large-context compaction can take more than five minutes.
 * Reads and interrupts bypass the gate. The client rejects pending RPCs on exit.
 */
function withBudgetCompaction<T>(
  { gates }: BudgetRuntimeState,
  sessionId: string,
  command: RpcCommand['type'],
  action: () => Promise<T>,
): Promise<T> {
  const gate = gates.get(sessionId)
  if (!gate || command.startsWith('get_') || command === 'export_html') return action()
  if (command.startsWith('abort') || command === 'clear_queue') {
    gate.revision++
    return action()
  }
  const revision = gate.revision
  return enqueue(gate, () => {
    if (gate.stopped || revision !== gate.revision) {
      throw new Error('Queued command cancelled before compaction finished.')
    }
    return action()
  })
}

/** Each process owner supplies its logger and owns an independent set of command gates. */
export function createContextBudgetRuntime(log: RuntimeLog) {
  const runtime: BudgetRuntimeState = { gates: new Map(), log }
  return {
    enforceContextBudget: enforceContextBudget.bind(null, runtime),
    watchContextBudget: watchContextBudget.bind(null, runtime),
    withBudgetCompaction: <T>(
      sessionId: string,
      command: RpcCommand['type'],
      action: () => Promise<T>,
    ) => withBudgetCompaction(runtime, sessionId, command, action),
  }
}
