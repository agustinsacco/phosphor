import type { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import type { LaneSummary } from '@phosphor/shared/host-protocol'
import type { RpcCommand } from '@phosphor/shared/rpc'
import { daemonLaneBinding, type DaemonBindingPorts, type DeferredTarget } from './binding'

/** One lane whose `set_model` replaces its pi process, as a provider switch does. */
function harness(actions?: DaemonBindingPorts['actions']) {
  let session = 's1'
  const sent: { sessionId: string; type: string }[] = []
  const ports: DaemonBindingPorts = {
    selfIds: () => ['host-1'],
    db: {} as DatabaseSync,
    lanes: {
      list: () => [{ laneId: 'L1' } as LaneSummary],
      summary: () => null,
      sessionFor: (laneId) => (laneId === 'L1' ? session : null),
    },
    command: async (sessionId, rpc: RpcCommand) => {
      sent.push({ sessionId, type: rpc.type })
      if (rpc.type === 'set_model') session = 's2'
      return { success: true }
    },
    ...(actions ? { actions } : {}),
  }
  return { binding: daemonLaneBinding(ports), sent }
}

it('applies the rest of a settled run’s work to the process a model change started', async () => {
  const reloads: DeferredTarget[] = []
  const h = harness({
    reload: async (_item, target) => {
      reloads.push(target)
      return { ok: true }
    },
  })
  const outcome = await h.binding.deferred.apply('s1', [
    { kind: 'model', provider: 'anthropic', modelId: 'opus' },
    { kind: 'thinking', level: 'high' },
    { kind: 'reload', what: 'rules' },
  ])
  expect(outcome).toEqual({ ok: true })
  expect(h.sent).toEqual([
    { sessionId: 's1', type: 'set_model' },
    { sessionId: 's2', type: 'set_thinking_level' },
  ])
  expect(reloads).toEqual([{ laneId: 'L1', sessionId: 's2', settledSessionId: 's1' }])
})

it('says which owner action it cannot apply, and stops at the first refusal', async () => {
  const h = harness()
  expect(await h.binding.deferred.apply('s1', [{ kind: 'stop' }])).toEqual({
    ok: false,
    message: 'This machine cannot apply stop yet.',
  })
  const refused = harness({ reload: async () => ({ ok: false, message: 'no' }) })
  expect(
    await refused.binding.deferred.apply('s1', [
      { kind: 'reload', what: 'x' },
      { kind: 'thinking', level: 'low' },
    ]),
  ).toEqual({ ok: false, message: 'no' })
  expect(refused.sent).toEqual([])
})

it('applies to the settled session itself when it is not one of this machine’s lanes', async () => {
  const h = harness()
  await h.binding.deferred.apply('elsewhere', [{ kind: 'autoRetry', enabled: true }])
  expect(h.sent).toEqual([{ sessionId: 'elsewhere', type: 'set_auto_retry' }])
})
