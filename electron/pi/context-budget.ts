import { sessionContextBudget } from '@shared/context-budget'
import type { PiRpcClient } from './rpc-client'
import type { RpcCommand } from '@shared/rpc'
import { log } from '../debug-log'

interface BudgetGate {
  tail: Promise<void>
  checking: boolean
  stopped: boolean
  revision: number
}
const gates = new Map<string, BudgetGate>()

/** Keep checks and state-changing RPC commands in order, including prompt preflight. */
function enqueue<T>(gate: BudgetGate, action: () => Promise<T>): Promise<T> {
  const result = gate.tail.then(action)
  gate.tail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/** A failed check leaves the session alone; a failed compaction is reported by pi. */
export async function enforceContextBudget(
  sessionId: string,
  client: Pick<PiRpcClient, 'request'>,
  rawBudget: string,
  cancelled: () => boolean = () => false,
): Promise<void> {
  try {
    const state = await client.request({ type: 'get_state' })
    if (!state.success || !state.data) return
    const { model, autoCompactionEnabled, isStreaming, isCompacting } = state.data
    if (model?.provider === 'pi-claude-cli' || isStreaming || isCompacting) return
    const budget = sessionContextBudget({
      raw: rawBudget,
      provider: model?.provider,
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

/** Check after settlement, never mid-turn: RPC compact aborts any running turn. */
export function watchContextBudget(
  sessionId: string,
  client: Pick<PiRpcClient, 'request' | 'on'>,
  readBudget: () => string,
): void {
  const gate: BudgetGate = { tail: Promise.resolve(), checking: false, stopped: false, revision: 0 }
  gates.set(sessionId, gate)
  client.on('event', (event) => {
    if (event.type !== 'agent_settled' || gate.checking || gate.stopped) return
    gate.checking = true
    const revision = gate.revision
    const cancelled = (): boolean => gate.stopped || revision !== gate.revision
    void enqueue(gate, async () => {
      try {
        if (!cancelled()) await enforceContextBudget(sessionId, client, readBudget(), cancelled)
      } catch (error) {
        log('pi', 'budget check failed', { sessionId, error: String(error) })
      } finally {
        gate.checking = false
      }
    })
  })
  client.on('exit', () => {
    gate.stopped = true
    gates.delete(sessionId)
  })
}

/**
 * pi rejects prompts during requested compaction. Wait for its actual response,
 * not a timeout: a valid large-context compaction can take more than five minutes.
 * Reads and interrupts bypass the gate. The client rejects pending RPCs on exit.
 */
export function withBudgetCompaction<T>(
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
