import { describe, expect, it } from 'vitest'
import { parseClientFrame, parseHostFrame, type HostFrame } from '../../host-protocol'
import { createConformanceHarness, runScenario } from './__fixtures__/harness'
import { describeConformance } from './context'
import { controlScenarios } from './control'
import type { ConformanceOptions } from './types'

const ALL = ['sessions.read', 'sessions.control'] as const

describeConformance(
  'control scenarios',
  createConformanceHarness,
  ALL,
  Object.values(controlScenarios),
)

it('registers the control family in order and passes it against a healthy Host', ({ task }) => {
  const suite = task.file.tasks.find((entry) => entry.name === 'control scenarios')
  if (suite?.type !== 'suite') throw new Error('Missing control suite')
  expect(suite.tasks.map((entry) => [entry.name, entry.result?.state])).toEqual(
    [
      'refuses control without the capability and runs the M2 calls',
      'serializes takeover for all viewers, fences the old controller, releases and acquires before pi events',
      'rejects a viewer dialog answer and resolves the controller answer in the stream',
      'stops and resumes lanes, marks attention read, and exposes failure',
      'keeps controller ownership across disconnect and reconnect without changing its fence',
    ].map((name) => [name, 'pass']),
  )
})

/** Per viewer: whether it has sent a prompt, and frames held back from it. */
interface Interception {
  prompted: boolean
  held: string[]
}
/** Lets `rewrite` replace, hold or release each Host frame text a viewer receives. */
function intercepting(
  limits: Partial<ConformanceOptions>,
  rewrite: (
    frame: HostFrame,
    text: string,
    deliver: (text: string) => void,
    viewer: Interception,
  ) => void,
) {
  const h = createConformanceHarness(limits)
  return {
    ...h,
    connect() {
      const connection = h.connect()
      const { socket } = connection
      const viewer: Interception = { prompted: false, held: [] }
      return {
        ...connection,
        socket: {
          ...socket,
          send(text: string) {
            const parsed = parseClientFrame(text)
            if (parsed.ok && parsed.frame.type === 'command' && parsed.frame.op.type === 'prompt')
              viewer.prompted = true
            socket.send(text)
          },
          onMessage: (cb: (text: string) => void) =>
            socket.onMessage((text) => {
              const parsed = parseHostFrame(text)
              if (parsed.ok) rewrite(parsed.value, text, cb, viewer)
              else cb(text)
            }),
        },
      }
    },
  }
}

describe('control oracles', () => {
  it('fail takeover when the Host accepts a stale fence', async (t) => {
    const acceptsStaleFence = (limits: Partial<ConformanceOptions>) =>
      intercepting(limits, (frame, text, deliver) => {
        const receipt = frame.type === 'receipt' ? frame.receipt : null
        if (receipt?.status !== 'rejected' || receipt.code !== 'stale-fence') return deliver(text)
        deliver(
          JSON.stringify({
            type: 'receipt',
            receipt: { requestId: receipt.requestId, status: 'done' },
          }),
        )
      })
    const failure = await runScenario(acceptsStaleFence, (kit) =>
      controlScenarios.takeover.run(kit, t),
    ).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      actual: { status: 'done' },
      expected: { status: 'rejected', code: 'stale-fence' },
    })
  })

  it('fail takeover when pi events reach a viewer before the control acquisition', async (t) => {
    const piFirst = (limits: Partial<ConformanceOptions>) =>
      intercepting(limits, (frame, text, deliver, viewer) => {
        const event = frame.type === 'event' ? frame.event : null
        if (viewer.prompted && event?.kind === 'control') return void viewer.held.push(text)
        deliver(text)
        if (event?.kind === 'pi' && event.push.kind === 'event')
          viewer.held.splice(0).forEach(deliver)
      })
    await expect(
      runScenario(piFirst, (kit) => controlScenarios.takeover.run(kit, t)),
    ).rejects.toThrow(/^expected \d+ to be greater than \d+$/)
  })
})
