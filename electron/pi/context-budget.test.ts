import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enforceContextBudget, watchContextBudget, withBudgetCompaction } from './context-budget'
import type { PiRpcClient } from './rpc-client'
import type { RpcCommand } from '@shared/rpc'

vi.mock('../debug-log', () => ({ log: vi.fn() }))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}
function setup(overrides: Record<string, unknown> = {}) {
  const state = {
    model: { provider: 'openai-codex', contextWindow: 1_000_000 },
    autoCompactionEnabled: true,
    isStreaming: false,
    isCompacting: false,
    ...overrides,
  }
  const stats = { contextUsage: { tokens: 250_000 as number | null } }
  const compact = vi.fn(async () => {})
  const request = vi.fn(async (cmd: RpcCommand) => {
    if (cmd.type === 'compact') await compact()
    return { success: true, data: cmd.type === 'get_state' ? state : stats }
  })
  const events = new EventEmitter()
  const client = Object.assign(events, { request }) as unknown as Pick<
    PiRpcClient,
    'request' | 'on'
  >
  const id = Math.random().toString()
  let budget = ''
  watchContextBudget(id, client, () => budget)
  const settled = () => events.emit('event', { type: 'agent_settled' })
  const send = (type: RpcCommand['type'], action: () => Promise<void> = async () => {}) =>
    withBudgetCompaction(id, type, action)
  return {
    state,
    stats,
    compact,
    request,
    events,
    client,
    id,
    settled,
    send,
    setBudget: (value: string) => {
      budget = value
    },
  }
}

afterEach(() => vi.useRealTimers())
describe('context budget', () => {
  it.each([199_000, 200_000, null, NaN])('ignores usage %s', async (tokens) => {
    const s = setup()
    s.stats.contextUsage.tokens = tokens
    await enforceContextBudget(s.id, s.client, '')
    expect(s.compact).not.toHaveBeenCalled()
  })
  it.each([
    { model: { provider: 'pi-claude-cli', contextWindow: 1_000_000 } },
    { model: { provider: 'openai-codex', contextWindow: 200_000 } },
    { autoCompactionEnabled: false },
    { isStreaming: true },
    { isCompacting: true },
  ])('leaves other owners and active sessions alone: %j', async (state) => {
    const s = setup(state)
    await enforceContextBudget(s.id, s.client, '')
    expect(s.compact).not.toHaveBeenCalled()
  })
  it.each(['auto', 'off'])('honors %s', async (raw) => {
    const s = setup()
    await enforceContextBudget(s.id, s.client, raw)
    expect(s.compact).not.toHaveBeenCalled()
  })
  it('checks only at settlement, once, and reads live prefs each time', async () => {
    const s = setup()
    s.setBudget('400k')
    s.events.emit('event', { type: 'agent_end' })
    expect(s.request).not.toHaveBeenCalled()
    s.settled()
    await s.send('prompt')
    expect(s.compact).not.toHaveBeenCalled()
    s.setBudget('100')
    s.settled()
    s.settled()
    await s.send('prompt')
    expect(s.compact).toHaveBeenCalledTimes(1)
  })
  it('holds prompts and model changes for more than five minutes, but not reads', async () => {
    vi.useFakeTimers()
    const s = setup(),
      finish = deferred(),
      sent = vi.fn(async () => {})
    s.compact.mockImplementation(() => finish.promise)
    s.settled()
    await vi.waitFor(() => expect(s.compact).toHaveBeenCalled())
    const prompt = s.send('prompt', sent),
      model = s.send('set_model', sent)
    await s.send('get_state')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sent).not.toHaveBeenCalled()
    finish.resolve()
    await Promise.all([prompt, model])
    expect(sent).toHaveBeenCalledTimes(2)
  })
  it('waits for prompt preflight before checking, so it cannot abort a new turn', async () => {
    const s = setup(),
      accepted = deferred()
    const prompt = s.send('prompt', async () => {
      await accepted.promise
      s.state.isStreaming = true
    })
    s.settled()
    expect(s.request).not.toHaveBeenCalled()
    accepted.resolve()
    await prompt
    await s.send('set_model')
    expect(s.compact).not.toHaveBeenCalled()
  })
  it('lets abort cancel an in-progress check and pending commands', async () => {
    const s = setup(),
      fetched = deferred(),
      sent = vi.fn(async () => {})
    s.request.mockImplementationOnce(async () => {
      await fetched.promise
      return { success: true, data: s.state }
    })
    s.settled()
    await vi.waitFor(() => expect(s.request).toHaveBeenCalled())
    const prompt = expect(s.send('prompt', sent)).rejects.toThrow('cancelled')
    await s.send('abort')
    fetched.resolve()
    await prompt
    expect(sent).not.toHaveBeenCalled()
    expect(s.compact).not.toHaveBeenCalled()
  })
  it('releases the queue after compaction fails or its transport exits', async () => {
    const s = setup()
    s.compact.mockRejectedValueOnce(new Error('pi process is not running'))
    s.settled()
    await s.send('prompt')
    expect(s.compact).toHaveBeenCalledOnce()
    s.events.emit('exit')
    s.settled()
    await s.send('prompt')
    expect(s.compact).toHaveBeenCalledOnce()
  })
  it('does not poison the queue when a user command rejects', async () => {
    const s = setup()
    await expect(
      s.send('set_model', async () => {
        throw new Error('bad model')
      }),
    ).rejects.toThrow()
    s.settled()
    await s.send('prompt')
    expect(s.compact).toHaveBeenCalledOnce()
  })
})
