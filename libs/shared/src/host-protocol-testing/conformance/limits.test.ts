import { describe, expect, it } from 'vitest'
import { createConformanceHarness, runScenario } from './__fixtures__/harness'
import { describeConformance } from './context'
import { limitScenarios } from './limits'
import type { ConformanceConnection, ConformanceOptions } from './types'

const ALL = ['sessions.read', 'sessions.control'] as const

describeConformance('limit scenarios', createConformanceHarness, ALL, Object.values(limitScenarios))

it('registers the limit family in order and passes it against a healthy Host', ({ task }) => {
  const suite = task.file.tasks.find((entry) => entry.name === 'limit scenarios')
  if (suite?.type !== 'suite') throw new Error('Missing limit suite')
  expect(suite.tasks.map((entry) => [entry.name, entry.result?.state])).toEqual(
    [
      'closes malformed JSON and oversize input, but rejects unknown operations without closing',
      'bounds in-flight calls at the configured pending cap',
      'bounds subscriptions and pending commands at the configured cap',
      'recovers a slow viewer with one snapshot, without slowing the other viewer',
      'caps connections per client without affecting existing sockets',
      'fails only an oversize subscription or call, leaving another lane streaming',
    ].map((name) => [name, 'pass']),
  )
})

describe('limit oracles', () => {
  it('fail the subscription cap scenario when the Host ignores the configured cap', async (t) => {
    const uncapped = ({
      subscriptionsPerConnection: _ignored,
      ...limits
    }: Partial<ConformanceOptions>) => createConformanceHarness(limits)
    await expect(
      runScenario(uncapped, (kit) => limitScenarios.subscriptionAndCommandCaps.run(kit, t)),
    ).rejects.toThrow('expected [ …(4) ] to have a length of 3 but got 4')
  })

  it('fail the slow viewer scenario when one paused viewer stalls the other', async (t) => {
    const sharedQueue = (limits: Partial<ConformanceOptions>) => {
      const h = createConformanceHarness(limits)
      const viewers: ConformanceConnection[] = []
      return {
        ...h,
        connect() {
          const connection = h.connect()
          viewers.push(connection)
          return {
            ...connection,
            pause: () => viewers.forEach((viewer) => viewer.pause()),
            resume: () => viewers.forEach((viewer) => viewer.resume()),
          }
        },
      }
    }
    await expect(
      runScenario(sharedQueue, (kit) => limitScenarios.slowViewer.run(kit, t)),
    ).rejects.toThrow('expected 0 to be greater than 10')
  })
})
