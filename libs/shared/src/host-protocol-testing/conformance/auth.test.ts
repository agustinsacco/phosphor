import { describe, expect, it } from 'vitest'
import { parseHostFrame, type HostFrame } from '../../host-protocol'
import { createConformanceHarness, runScenario } from './__fixtures__/harness'
import { authScenarios } from './auth'
import { describeConformance } from './context'
import type { ConformanceOptions } from './types'

const ALL = ['sessions.read', 'sessions.control'] as const

describeConformance('auth scenarios', createConformanceHarness, ALL, Object.values(authScenarios))

it('registers the auth family in order and passes it against a healthy Host', ({ task }) => {
  const suite = task.file.tasks.find((entry) => entry.name === 'auth scenarios')
  if (suite?.type !== 'suite') throw new Error('Missing auth suite')
  expect(suite.tasks.map((entry) => [entry.name, entry.result?.state])).toEqual(
    [
      'requires auth as the first frame and enforces its deadline',
      'refuses a wrong signature',
      'refuses a wrong host',
      'refuses a wrong epoch',
      'refuses a wrong owner',
      'proves the enrolled Host, renews, rejects identity changes, and expires',
      'refuses a correctly signed hello naming a different enrolled Host',
      'closes open sockets and rejects revoked session grants',
      'closes open sockets and rejects revoked client grants',
      'gates read operations and removes subscriptions when renewal drops read authority',
    ].map((name) => [name, 'pass']),
  )
})

/** A Host whose ready frame carries a proof over some other challenge. */
function wrongChallengeProof(limits: Partial<ConformanceOptions>) {
  const h = createConformanceHarness(limits)
  const forge = (frame: HostFrame) =>
    frame.type === 'ready'
      ? {
          ...frame,
          proof: h.signHelloProof(frame.hello.hostId, frame.hello.runtimeEpoch, 'b'.repeat(64)),
        }
      : frame
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
              cb(parsed.ok ? JSON.stringify(forge(parsed.value)) : text)
            }),
        },
      }
    },
  }
}

describe('injected invalid proofs', () => {
  it('fail the Host proof scenario when the hello proof answers another challenge', async (t) => {
    await expect(
      runScenario(wrongChallengeProof, (kit) => authScenarios.enrolledHostProof.run(kit, t)),
    ).rejects.toThrow('expected false to be true')
  })

  it('fail the Host proof scenario when the verifier ignores the challenge', async (t) => {
    const ignoresChallenge = (limits: Partial<ConformanceOptions>) => {
      const h = createConformanceHarness(limits)
      return { ...h, verifyProof: () => true }
    }
    await expect(
      runScenario(ignoresChallenge, (kit) => authScenarios.enrolledHostProof.run(kit, t)),
    ).rejects.toThrow('expected true to be false')
  })

  it('fail the foreign hello scenario when the verifier ignores the Host id', async (t) => {
    const ignoresHost = (limits: Partial<ConformanceOptions>) => {
      const h = createConformanceHarness(limits)
      return {
        ...h,
        verifyProof: (ready: Extract<HostFrame, { type: 'ready' }>, challenge: string) =>
          ready.proof === h.signHelloProof(ready.hello.hostId, ready.hello.runtimeEpoch, challenge),
      }
    }
    await expect(
      runScenario(ignoresHost, (kit) => authScenarios.foreignHostHello.run(kit, t)),
    ).rejects.toThrow('expected true to be false')
  })
})
