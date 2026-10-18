import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeMachine, SECRET, type FakeMachine } from '../__fixtures__/machine'
import * as hostRuntime from '../session/runtime'
import { runAccept, type AcceptContext, type AcceptEvidence, type AcceptOutcome } from './accept'

let machine: FakeMachine
beforeEach(() => {
  machine = fakeMachine({ rpc: true })
  vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  // The runtime gives this process pi's PATH; the stub puts the old one back.
  vi.stubEnv('PATH', process.env.PATH)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  machine.cleanup()
})

async function accept(overrides: Partial<AcceptContext> = {}) {
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
    drainTimings: { abortMs: 2000, graceMs: 1000, deadlineMs: 10_000, settleMs: 1000 },
    ...overrides,
  })
  return { outcome, progress }
}

function evidenceOf(outcome: AcceptOutcome): AcceptEvidence {
  if (!('evidence' in outcome)) throw new Error(`no evidence: ${outcome.problem}`)
  return outcome.evidence
}

const STEPS = ['start', 'state', 'prompt', 'abort', 'dispose', 'resume', 'close']
const transcripts = () => {
  const folder = sessionDirForCwd(machine.repository)
  return existsSync(folder) ? readdirSync(folder) : []
}

describe('accept waits characterization', { timeout: 30_000 }, () => {
  it('ignores an answer arriving after its deadline without reopening the finished lane', async () => {
    const create = hostRuntime.createHostRuntime
    let release!: () => void
    const late = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(hostRuntime, 'createHostRuntime').mockImplementation((...args) => {
      const runtime = create(...args)
      const command = runtime.command
      runtime.command = async (...params) => {
        const response = await command(...params)
        if (params[1].type === 'get_commands') await late
        return response
      }
      return runtime
    })
    const { outcome, progress } = await accept({ timings: { answerMs: 50 } })
    expect(outcome.exitCode).toBe(1)
    const evidence = evidenceOf(outcome)
    expect(evidence.lanes[0]!.steps).toMatchObject([
      { name: 'start', ok: false, detail: 'no answer to get_commands within 50 ms' },
    ])
    expect(evidence.drain?.state).toBe('stopped')
    const before = [...progress]
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(progress).toEqual(before)
    expect(evidence.lanes[0]!.steps).toHaveLength(1)
  })
  it.each([
    [
      'PI_FAKE_PROVIDER',
      'pi-claude-cli',
      'state',
      'the native lane runs on provider pi-claude-cli',
    ],
    ['FAKE_PI_TURN', 'wrong', 'prompt', 'the reply does not hold the token'],
    ['FAKE_PI_TURN', 'exit', 'prompt', 'pi exited (code 3) while waiting for agent_end'],
    ['FAKE_PI_HIDE', 'status', 'start', 'no phosphor-context-breakdown status within 2000 ms'],
    ['FAKE_PI_HIDE', 'budget', 'start', 'get_commands does not list phosphor-context-budget'],
    ['PI_FAKE_SILENT', 'get_commands', 'start', 'no answer to get_commands within 1000 ms'],
    // The abort's own answer counts toward its deadline.
    ['PI_FAKE_SILENT', 'abort', 'abort', 'no answer to abort within 1000 ms'],
  ])('fails on %s=%s in its %s step, exits 1 and still drains', async (name, value, at, why) => {
    // pi receives its own PI_ variables unasked, and a passed value would count as a secret.
    if (!name.startsWith('PI_')) {
      machine.writeConfig({ ...machine.config, environment: { pass: [name] } })
    }
    const { outcome } = await accept({
      env: { ...machine.hostEnv, [name]: value },
      timings: { startMs: 2000, turnMs: 1500, abortMs: 1000, answerMs: 1000 },
    })
    const evidence = evidenceOf(outcome)
    expect(outcome.exitCode).toBe(1)
    const [lane] = evidence.lanes
    expect(lane!.steps.map((step) => [step.name, step.ok])).toEqual([
      ...STEPS.slice(0, STEPS.indexOf(at)).map((step) => [step, true]),
      [at, false],
    ])
    expect(lane!.steps.at(-1)!.detail).toBe(why)
    expect(lane!.extensionsLoaded).toBe(at !== 'start')
    expect(evidence.drain).toMatchObject({ state: 'stopped', remaining: [] })
  })

  it("exits 70 when a stop does not end, as when a process that left pi's group holds its output", async () => {
    const escaped = join(machine.dir, 'escaped.pid')
    machine.writeConfig({ ...machine.config, environment: { pass: ['FAKE_PI_ESCAPE'] } })
    try {
      const { outcome, progress } = await accept({
        env: { ...machine.hostEnv, FAKE_PI_ESCAPE: escaped },
        timings: { stopMs: 1000 },
      })
      const evidence = evidenceOf(outcome)
      expect(outcome.exitCode).toBe(70)
      const [lane] = evidence.lanes
      expect(lane!.steps.map((step) => [step.name, step.ok])).toEqual([
        ...STEPS.slice(0, 4).map((name) => [name, true]),
        ['dispose', false],
      ])
      expect(lane!.steps.at(-1)).toMatchObject({
        cleanup: true,
        detail: expect.stringMatching(
          /^no end to the stop within 1000 ms, though process group \d+ is gone$/,
        ),
      })
      expect(progress.some((line) => line.startsWith('native: dispose FAILED: no end'))).toBe(true)
      // The drain still ends: pi itself is gone.
      expect(evidence.drain).toMatchObject({ state: 'stopped', remaining: [] })
    } finally {
      process.kill(Number(readFileSync(escaped, 'utf8')), 'SIGKILL')
    }
  })

  it('exits 70 when the stop after a failed step does not end, recording that stop', async () => {
    const escaped = join(machine.dir, 'escaped.pid')
    const pass = ['FAKE_PI_ESCAPE', 'FAKE_PI_TURN']
    machine.writeConfig({ ...machine.config, environment: { pass } })
    try {
      const { outcome } = await accept({
        env: { ...machine.hostEnv, FAKE_PI_ESCAPE: escaped, FAKE_PI_TURN: 'wrong' },
        timings: { stopMs: 1000 },
      })
      expect(outcome.exitCode).toBe(70)
      const [lane] = evidenceOf(outcome).lanes
      expect(lane!.steps.map((step) => [step.name, step.ok, step.cleanup ?? false])).toEqual([
        ['start', true, false],
        ['state', true, false],
        ['prompt', false, false],
        ['stop', false, true],
      ])
      expect(lane!.steps.at(-1)!.detail).toBe('no end to the stop within 1000 ms')
    } finally {
      process.kill(Number(readFileSync(escaped, 'utf8')), 'SIGKILL')
    }
  })

  it('hides a secret that a failed turn holds, in the evidence and on stderr', async () => {
    machine.writeConfig({ ...machine.config, environment: { pass: ['FAKE_PI_TURN'] } })
    const { outcome, progress } = await accept({
      env: { ...machine.hostEnv, FAKE_PI_TURN: 'fail' },
    })
    const evidence = evidenceOf(outcome)
    const failed = 'the turn failed: 401: invalid x-api-key [redacted]'
    expect(evidence.lanes[0]!.steps.at(-1)).toMatchObject({
      name: 'prompt',
      ok: false,
      detail: failed,
    })
    expect(progress).toContain(`native: prompt FAILED: ${failed}`)
    expect(JSON.stringify(evidence) + progress.join('\n')).not.toContain(SECRET)
  })

  it('passes the native lane on the fake pi, deletes its transcript, and prints no secret', async () => {
    const { outcome, progress } = await accept()
    const evidence = evidenceOf(outcome)
    expect(outcome.exitCode).toBe(0)
    expect(
      readFileSync(join(machine.agentDir, 'skills/visual-artifacts/SKILL.md'), 'utf8'),
    ).toContain('Choose the medium')
    expect(evidence).toMatchObject({
      schema: 1,
      verdict: 'pass',
      machine: `test-host · linux-${process.arch}`,
      host: { version: '0.0.0-dev.source', node: '22.22.3' },
      pi: { version: '1.2.0', cli: machine.cli },
      environment: { valuesPrinted: false },
      drain: { state: 'stopped', remaining: [] },
    })
    expect(evidence.environment.forwardedNames).toContain('PATH')
    expect(evidence.environment.forwardedNames).toContain('ANTHROPIC_API_KEY')
    const [lane] = evidence.lanes
    expect(lane).toMatchObject({
      lane: 'native',
      verdict: 'pass',
      provider: 'fake',
      model: 'fake-model',
      thinkingLevel: 'off',
      extensionsLoaded: true,
      groupsAlive: 0,
      transcriptDeleted: true,
    })
    expect(lane!.steps.map((step) => [step.name, step.ok])).toEqual(
      STEPS.map((name) => [name, true]),
    )
    expect(transcripts()).toEqual([])
    expect(progress[0]).toMatch(/^log: .*phosphor-host\/logs\//)
    expect(progress).toContain(`native: close ok (${lane!.steps.at(-1)!.ms} ms)`)
    const log = readFileSync(evidence.log!, 'utf8')
    expect(log).toContain('[host] accept')
    expect(log).toContain('[host] drained')
    expect(JSON.stringify(evidence) + progress.join('\n') + log).not.toContain(SECRET)
  })
})
