import { describe, expect, it } from 'vitest'
import { parseClientFrame, parseHostFrame } from '../../host-protocol'
import { createConformanceHarness, runScenario } from './__fixtures__/harness'
import { describeConformance } from './context'
import { receiptScenarios } from './receipts'
import type { ConformanceOptions } from './types'

const ALL = ['sessions.read', 'sessions.control'] as const

describeConformance(
  'receipt scenarios',
  createConformanceHarness,
  ALL,
  Object.values(receiptScenarios),
)

it('registers the receipt family in order and passes it against a healthy Host', ({ task }) => {
  const suite = task.file.tasks.find((entry) => entry.name === 'receipt scenarios')
  if (suite?.type !== 'suite') throw new Error('Missing receipt suite')
  expect(suite.tasks.map((entry) => [entry.name, entry.result?.state])).toEqual(
    [
      'deduplicates running commands, sends pending then one terminal receipt, and rejects conflicting reuse',
      'resends on a new socket mid-command without executing twice',
      'answers once when pi completes at 29999 ms around the uncertainty deadline',
      'answers once when pi completes at 30001 ms around the uncertainty deadline',
      'returns unknown for unrecorded, pruned, another client, and interrupted requests; returns stored results',
      'reports an interrupted running command as unknown without resurrecting a failed lane',
      'delivers a terminal receipt to each waiting socket of the same client only once',
      'caps finished and started receipts separately, prunes by age and does not leak pruned results',
      'keeps started receipts past the TTL and does not extend terminal retention on reads',
    ].map((name) => [name, 'pass']),
  )
})

/** Watches prompt commands on the wire; `late` holds their terminal receipts one fake ms. */
function promptTap(limits: Partial<ConformanceOptions>, late: boolean) {
  const h = createConformanceHarness(limits)
  const prompts: string[] = []
  const harness = {
    ...h,
    connect() {
      const connection = h.connect()
      const { socket } = connection
      return {
        ...connection,
        socket: {
          ...socket,
          send(text: string) {
            const parsed = parseClientFrame(text)
            if (parsed.ok && parsed.frame.type === 'command' && parsed.frame.op.type === 'prompt')
              prompts.push(parsed.frame.requestId)
            socket.send(text)
          },
          onMessage: (cb: (text: string) => void) =>
            socket.onMessage((text) => {
              const parsed = parseHostFrame(text)
              const receipt =
                parsed.ok && parsed.value.type === 'receipt' ? parsed.value.receipt : null
              if (late && receipt?.status === 'done' && prompts.includes(receipt.requestId))
                setTimeout(() => cb(text), 1)
              else cb(text)
            }),
        },
      }
    },
  }
  return { harness, prompts }
}

describe('receipt oracles', () => {
  it('fail deduplication when the Host executes each resent command', async (t) => {
    const executesResends = (limits: Partial<ConformanceOptions>) => {
      const { harness, prompts } = promptTap(limits, false)
      return { ...harness, driver: { ...harness.driver, executions: () => prompts.length } }
    }
    await expect(
      runScenario(executesResends, (kit) => receiptScenarios.deduplication.run(kit, t)),
    ).rejects.toThrow('expected 2 to be 1')
  })

  it('fail deduplication when the terminal receipt arrives after the command delay', async (t) => {
    const lateTerminal = (limits: Partial<ConformanceOptions>) => promptTap(limits, true).harness
    await expect(
      runScenario(lateTerminal, (kit) => receiptScenarios.deduplication.run(kit, t)),
    ).rejects.toThrow(`expected [ 'pending' ] to deeply equal [ 'pending', 'done' ]`)
  })
})
