import { describe, expect, it, type TestContext } from 'vitest'
import { parseHostFrame } from '../../host-protocol'
import { createConformanceHarness, runScenario } from './__fixtures__/harness'
import { describeConformance } from './context'
import { streamScenarios } from './streams'
import type { ConformanceOptions } from './types'

const ALL = ['sessions.read', 'sessions.control'] as const

describeConformance(
  'stream scenarios',
  createConformanceHarness,
  ALL,
  Object.values(streamScenarios),
)

it('registers the stream family in order and passes it against a healthy Host', ({ task }) => {
  const suite = task.file.tasks.find((entry) => entry.name === 'stream scenarios')
  if (suite?.type !== 'suite') throw new Error('Missing stream suite')
  expect(suite.tasks.map((entry) => [entry.name, entry.result?.state])).toEqual(
    [
      'lists lanes, publishes deltas, replays attention only within the current epoch',
      'snapshots, emits ordered events, replays exactly missed events, and resets across a gap or epoch',
      'hydrates only latest status, widget and title state for a new viewer, and clears keys',
      'bounds replay by bytes and attention by count, resetting when replay is unavailable',
      'replaces an oversize event with a reset, and ends only an oversize lanes subscription',
      'stops buffered replay after an oversized event (oversize reset: false)',
      'stops buffered replay after an oversized event (oversize reset: true)',
    ].map((name) => [name, 'pass']),
  )
})

/** Replays the first missed event to the `resume` subscription `times` times (0 drops it). */
function firstReplayed(limits: Partial<ConformanceOptions>, times: number) {
  const h = createConformanceHarness(limits)
  let seen = false
  return {
    ...h,
    connect() {
      const connection = h.connect()
      const { socket } = connection
      return {
        ...connection,
        socket: {
          ...socket,
          onMessage: (cb: (text: string) => void) =>
            socket.onMessage((text) => {
              const parsed = parseHostFrame(text)
              const replayed =
                parsed.ok && parsed.value.type === 'event' && parsed.value.id === 'resume'
              if (!replayed || seen) return cb(text)
              seen = true
              for (let i = 0; i < times; i++) cb(text)
            }),
        },
      }
    },
  }
}

/** The replay assertion's actual and expected events, from a scenario that must fail on it. */
async function replayMismatch(times: number, t: TestContext) {
  const failure = await runScenario(
    (limits) => firstReplayed(limits, times),
    (kit) => streamScenarios.orderedReplay.run(kit, t),
  ).catch((error: unknown) => error)
  if (
    !(failure instanceof Error) ||
    !/^expected \[.*\] to deeply equal \[/s.test(failure.message) ||
    !('actual' in failure && Array.isArray(failure.actual)) ||
    !('expected' in failure && Array.isArray(failure.expected))
  )
    throw new Error('Ordered replay did not fail on its replay comparison')
  return { actual: failure.actual, expected: failure.expected }
}

describe('stream oracles', () => {
  it('fail ordered replay when the Host skips a missed event', async (t) => {
    const { actual, expected } = await replayMismatch(0, t)
    expect(actual).toEqual(expected.slice(1))
  })

  it('fail ordered replay when the Host replays an event twice', async (t) => {
    const { actual, expected } = await replayMismatch(2, t)
    expect(actual).toEqual([expected[0], ...expected])
  })
})
