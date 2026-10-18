import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
import { runAccept } from './accept'

let machine: FakeMachine
beforeEach(() => {
  machine = fakeMachine({ rpc: true })
  vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  vi.stubEnv('PATH', process.env.PATH)
})
afterEach(() => {
  vi.unstubAllEnvs()
  machine.cleanup()
})

describe('accept status wire characterization', { timeout: 30_000 }, () => {
  it.each([
    ['phosphor-context-breakdown', true],
    ['Phosphor-context-breakdown', false],
    ['phosphor-headroom', false],
    ['phosphor-context-budget', false],
  ])('runAccept requires the exact breakdown status, receiving %s', async (key, loaded) => {
    // Change only the status emitted by this scratch pi; command names stay unchanged.
    const source = readFileSync(machine.cli, 'utf8')
    expect(source).toContain("statusKey: 'phosphor-context-breakdown'")
    writeFileSync(
      machine.cli,
      source.replace("statusKey: 'phosphor-context-breakdown'", `statusKey: '${key}'`),
    )
    const progress: string[] = []
    const outcome = await runAccept({
      configPath: machine.configPath,
      env: machine.hostEnv,
      platform: 'linux',
      uid: process.getuid!(),
      home: machine.home,
      hostname: 'bee1',
      nodeVersion: '22.22.3',
      defaultResourceRoot: '/nonexistent',
      probeTimeoutMs: 5_000,
      repository: machine.repository,
      lane: 'native',
      keepTranscripts: false,
      progress: (line) => void progress.push(line),
      timings: { startMs: 2000 },
      drainTimings: { abortMs: 2000, graceMs: 1000, deadlineMs: 10_000, settleMs: 1000 },
    })
    expect(outcome.exitCode).toBe(loaded ? 0 : 1)
    if (!('evidence' in outcome)) throw new Error(`no evidence: ${outcome.problem}`)
    const [lane] = outcome.evidence.lanes
    expect(lane!.extensionsLoaded).toBe(loaded)
    expect(outcome.evidence.drain).toMatchObject({ state: 'stopped', remaining: [] })
    if (loaded) {
      expect(lane!.steps.map(({ name, ok }) => [name, ok])).toEqual([
        ['start', true],
        ['state', true],
        ['prompt', true],
        ['abort', true],
        ['dispose', true],
        ['resume', true],
        ['close', true],
      ])
    } else {
      expect(lane!.steps).toEqual([
        expect.objectContaining({
          name: 'start',
          ok: false,
          detail: 'no phosphor-context-breakdown status within 2000 ms',
        }),
      ])
      expect(progress).toContain(
        'native: start FAILED: no phosphor-context-breakdown status within 2000 ms',
      )
    }
  })
})
