// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { lastLocalSubscriptionAuth } from '@/stores/localSubscriptionAuth'
import { useSessionsStore } from '@/stores/sessions'
import { startHealthCheck, useMachineHealthStore } from './healthStore'

afterEach(() => {
  vi.unstubAllGlobals()
})

it("leaves its fresh provider read for This Mac's Providers card and Settings → Accounts", async () => {
  const invoke = vi.fn(async (channel: string): Promise<unknown> => {
    if (channel === 'pi:subscriptionAuth') return [{ id: 'a', name: 'A', status: 'ready' }]
    throw new Error(`not read here: ${channel}`)
  })
  vi.stubGlobal('phosphor', { invoke })
  await startHealthCheck()
  expect(invoke).toHaveBeenCalledWith('pi:subscriptionAuth')
  invoke.mockClear()
  expect(await lastLocalSubscriptionAuth()).toEqual([{ id: 'a', name: 'A', status: 'ready' }])
  expect(invoke).not.toHaveBeenCalled()
})

it("characterize: counts This Mac's own live lanes, not the Host lanes open in this window", async () => {
  vi.stubGlobal('phosphor', {
    invoke: vi.fn(async () => {
      throw new Error('not read here')
    }),
  })
  useSessionsStore.setState({
    live: {
      mine: { phosphorId: 'mine', workspacePath: '/work/app' },
      remote: {
        phosphorId: 'remote',
        workspacePath: 'host:h/lane:l',
        target: { kind: 'remote', hostId: 'h' },
        laneId: 'l',
      },
    } as never,
  })
  try {
    await startHealthCheck()
    const lanes = useMachineHealthStore
      .getState()
      .run?.targets[0]?.steps.find((step) => step.id === 'lanes')
    expect(lanes?.detail).toBe('1 live lane · 0 folders')
  } finally {
    useSessionsStore.setState({ live: {} })
  }
})
