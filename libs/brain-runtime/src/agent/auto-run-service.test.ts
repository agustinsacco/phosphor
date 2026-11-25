import { expect, it, vi } from 'vitest'
import { FakeAgentStore } from '../__fixtures__/fake-agent-store'
import { pipelineSetup } from '../__fixtures__/pipeline'
import { createBrainService } from '../service'
import type { BrainAgentHost } from '../types'

it.each(['empty', 'done'])('arms the service only for a nonempty read: %s', async (state) => {
  const store = new FakeAgentStore()
  store.prefs.agentAuto = true
  store.counts.entities = 1
  const s = await pipelineSetup(store)
  if (state === 'empty')
    s.runner.mockResolvedValue({
      text: JSON.stringify({ entities: [], claims: [], parents: [] }),
      usage: { tokens: 0, cost: 0 },
    })
  const turn = vi
    .fn<BrainAgentHost['turn']>()
    .mockResolvedValue({ outcome: 'finished', sessionPath: null, rulesChanged: false, error: null })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const service = await createBrainService({
    ...s.options,
    agent: { folder: '/Ledger', tell: vi.fn(), turn },
  })
  try {
    await vi.waitFor(() => expect(store.job(s.job.id)?.state).toBe(state))
    await vi.advanceTimersByTimeAsync(60_000)
    if (state === 'empty') expect(store.latestRun()).toBeNull()
    else {
      await vi.waitFor(() =>
        expect(store.latestRun()).toMatchObject({ automatic: true, state: 'done' }),
      )
      expect(turn).toHaveBeenCalledOnce()
      const next = store.enqueue({ ...s.job, sessionId: 'ledger' }, 'queued')
      await service.api.setPrefs(store.prefs)
      await vi.waitFor(() => expect(store.job(next.id)?.state).toBe('done'))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(store.runs).toHaveLength(1)
    }
  } finally {
    vi.useRealTimers()
    await service.dispose()
    await s.cleanup()
  }
})
