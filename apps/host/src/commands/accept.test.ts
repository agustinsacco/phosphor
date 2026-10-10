import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeMachine, SECRET, type FakeMachine } from '../__fixtures__/machine'
import type { DrainResult } from '../session/lifecycle'
import {
  acceptExitCode,
  renderAccept,
  runAccept,
  type AcceptContext,
  type AcceptEvidence,
  type AcceptStep,
  type AcceptOutcome,
} from './accept'

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

describe('accept', { timeout: 30_000 }, () => {
  it('passes the native lane on the fake pi, deletes its transcript, and prints no secret', async () => {
    const { outcome, progress } = await accept()
    const evidence = evidenceOf(outcome)
    expect(outcome.exitCode).toBe(0)
    expect(evidence).toMatchObject({
      schema: 1,
      verdict: 'pass',
      machine: `test-host · linux-${process.arch}`,
      host: { version: '0.0.0-dev.source', node: '22.22.3' },
      pi: { version: '0.87.1', cli: machine.cli },
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

  it('keeps the transcript when asked, a JSONL file holding both turns and the recall', async () => {
    const { outcome } = await accept({ keepTranscripts: true })
    const [lane] = evidenceOf(outcome).lanes
    expect(lane).toMatchObject({ verdict: 'pass', transcriptDeleted: false })
    const lines = readFileSync(lane!.transcript!, 'utf8').trim().split('\n')
    const replies = lines
      .map((line) => JSON.parse(line))
      .flatMap((entry) => (entry.message?.role === 'assistant' ? [entry.message] : []))
    expect(replies.map((reply) => reply.stopReason)).toEqual(['stop', 'aborted', 'stop'])
    expect(replies[2].content[0].text).toBe(replies[0].content[0].text)
    expect(replies[0].content[0].text).toMatch(/^PHX-[0-9a-f]{8}$/)
  })

  it('fails a recall the model cannot make, exits 1 and keeps the transcript', async () => {
    machine.writeConfig({ ...machine.config, environment: { pass: ['FAKE_PI_FORGET'] } })
    const { outcome, progress } = await accept({
      env: { ...machine.hostEnv, FAKE_PI_FORGET: '1' },
    })
    const evidence = evidenceOf(outcome)
    expect(outcome.exitCode).toBe(1)
    expect(evidence.verdict).toBe('fail')
    const [lane] = evidence.lanes
    expect(lane!.steps.map((step) => [step.name, step.ok])).toEqual([
      ...STEPS.slice(0, 5).map((name) => [name, true]),
      ['resume', false],
    ])
    expect(lane!.steps.at(-1)!.detail).toBe('the recall lacks the token')
    expect(progress).toContain('native: resume FAILED: the recall lacks the token')
    // The session the failed step left running is stopped; its file stays for review.
    expect(evidence.drain).toMatchObject({ state: 'stopped', sessions: 0 })
    expect(existsSync(lane!.transcript!)).toBe(true)
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

  it.each([
    [
      { provider: 'openai-codex' },
      { PI_FAKE_PROVIDER: 'another-native' },
      'runs on provider another-native, not openai-codex',
    ],
    [
      { provider: 'openai-codex', model: 'gpt-test' },
      { PI_FAKE_MODEL: 'gpt-other' },
      'runs model gpt-other, not gpt-test',
    ],
    [
      { provider: 'openai-codex', model: 'openai-codex/gpt-test:high' },
      { PI_FAKE_MODEL: 'gpt-other' },
      'runs model gpt-other, not gpt-test',
    ],
  ])(
    'fails the state step when pi runs another provider or model than %j',
    async (asked, env, why) => {
      const { outcome } = await accept({ ...asked, env: { ...machine.hostEnv, ...env } })
      expect(outcome.exitCode).toBe(1)
      expect(evidenceOf(outcome).lanes[0]!.steps.at(-1)).toMatchObject({
        name: 'state',
        ok: false,
        detail: `the native lane ${why}`,
      })
    },
  )

  it('takes a model named as provider/id with a thinking level as that id', async () => {
    const { outcome } = await accept({
      provider: 'openai-codex',
      model: 'openai-codex/gpt-test:high',
      env: { ...machine.hostEnv, PI_FAKE_MODEL: 'gpt-test' },
    })
    expect(outcome.exitCode).toBe(0)
    expect(evidenceOf(outcome).lanes[0]).toMatchObject({
      provider: 'openai-codex',
      model: 'gpt-test',
    })
  })

  it.skipIf(process.getuid?.() === 0)(
    'exits 70 when the transcript cannot be deleted, keeping it, though the drain stopped',
    async () => {
      const folder = sessionDirForCwd(machine.repository)
      try {
        const { outcome } = await accept({
          progress: (line) => {
            // Between the recall and the deletion: no file can be removed from the folder.
            if (line.startsWith('native: resume ok')) chmodSync(folder, 0o500)
          },
        })
        const evidence = evidenceOf(outcome)
        expect(outcome.exitCode).toBe(70)
        expect(evidence.verdict).toBe('fail')
        const [lane] = evidence.lanes
        expect(lane!.steps.at(-1)).toMatchObject({
          name: 'close',
          ok: false,
          cleanup: true,
          detail: expect.stringMatching(/^the deletion failed: .*EACCES/),
        })
        expect(lane!.transcriptDeleted).toBe(false)
        expect(existsSync(lane!.transcript!)).toBe(true)
        expect(evidence.drain).toMatchObject({ state: 'stopped', remaining: [] })
      } finally {
        chmodSync(folder, 0o700)
      }
    },
  )

  it('hides a passed XDG_STATE_HOME, which the log path holds, on stderr and in the evidence', async () => {
    const state = join(machine.home, 'state-of-the-host')
    mkdirSync(state)
    machine.writeConfig({ ...machine.config, environment: { pass: ['XDG_STATE_HOME'] } })
    const { outcome, progress } = await accept({
      env: { ...machine.hostEnv, XDG_STATE_HOME: state },
    })
    const evidence = evidenceOf(outcome)
    expect(outcome.exitCode).toBe(0)
    expect(progress[0]).toMatch(/^log: \[redacted\]\/phosphor-host\/logs\/\S+$/)
    expect(evidence.log).toMatch(/^\[redacted\]\//)
    expect(JSON.stringify(evidence) + progress.join('\n')).not.toContain(state)
    expect(readdirSync(join(state, 'phosphor-host/logs')).length).toBeGreaterThan(0)
  })

  it('hides secrets in an error it did not expect, after draining', async () => {
    const failure = accept({
      progress: (line) => {
        if (line.startsWith('native: start ok')) throw new Error(`broken by ${SECRET}`)
      },
    })
    await expect(failure).rejects.toThrow('broken by [redacted]')
    await failure.catch((error: Error) => expect(error.message).not.toContain(SECRET))
    expect(transcripts().length).toBe(0)
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

  it('runs the Claude lane on pi-claude-cli, after the native lane', async () => {
    machine.installClaude()
    const { outcome } = await accept({ lane: 'all' })
    const evidence = evidenceOf(outcome)
    expect(outcome.exitCode).toBe(0)
    expect(evidence.claude).toEqual({ cli: `${machine.bin}/claude`, version: '2.1.283' })
    expect(evidence.lanes.map((lane) => [lane.lane, lane.verdict, lane.provider])).toEqual([
      ['native', 'pass', 'fake'],
      ['claude', 'pass', 'pi-claude-cli'],
    ])
    expect(JSON.stringify(evidence)).not.toContain('person@example.com')
  })

  it('records an unavailable Claude lane with its reason when running all lanes', async () => {
    const { outcome, progress } = await accept({ lane: 'all' })
    const evidence = evidenceOf(outcome)
    expect(outcome.exitCode).toBe(0)
    expect(evidence.lanes.map((lane) => lane.verdict)).toEqual(['pass', 'unavailable'])
    expect(evidence.lanes[1]!.reason).toContain('(it is not installed)')
    expect(progress.some((line) => line.startsWith('claude: unavailable: '))).toBe(true)
  })

  it('refuses the Claude lane alone when it is unavailable, starting nothing', async () => {
    const { outcome } = await accept({ lane: 'claude' })
    expect(outcome.exitCode).toBe(69)
    expect(outcome).toMatchObject({
      problem: expect.stringContaining('the claude lane is unavailable'),
    })
    expect(transcripts()).toEqual([])
  })

  it("runs the native lane on the provider and model named, when pi's defaults are Claude", async () => {
    const { outcome } = await accept({ provider: 'openai-codex', model: 'gpt-test' })
    expect(evidenceOf(outcome).lanes[0]).toMatchObject({
      verdict: 'pass',
      provider: 'openai-codex',
      model: 'gpt-test',
    })
  })

  it.each([
    [{ provider: 'pi-claude-cli' }, '--provider pi-claude-cli is the claude lane'],
    [{ provider: '-x' }, 'the native lane cannot start: /provider '],
    [{ repository: '/' }, 'the native lane cannot start: /repository '],
  ])(
    'refuses a request that cannot run, %j, as a usage error, starting nothing',
    async (o, why) => {
      const { outcome } = await accept(o)
      expect(outcome).toMatchObject({ exitCode: 64, problem: expect.stringContaining(why) })
      expect(outcome).not.toHaveProperty('doctor')
      expect(transcripts()).toEqual([])
    },
  )

  it('returns the doctor report when the machine cannot run sessions', async () => {
    machine.writeConfig({ ...machine.config, repositories: ['relative'] })
    const { outcome } = await accept()
    expect(outcome).toMatchObject({ exitCode: 78, problem: 'doctor failed', doctor: { ok: false } })
  })

  it('renders a readable summary, naming a kept transcript', async () => {
    machine.writeConfig({ ...machine.config, environment: { pass: ['FAKE_PI_FORGET'] } })
    const { outcome } = await accept({ env: { ...machine.hostEnv, FAKE_PI_FORGET: '1' } })
    const evidence = evidenceOf(outcome)
    const text = renderAccept(evidence)
    expect(text).toMatch(/^phosphor accept · test-host · linux-\S+ · 0\.0\.0-dev\.source\n/)
    expect(text).toContain('\nFAIL  native  fake · fake-model · off\n  ok    start    ')
    expect(text).toContain('\n  FAIL  resume   the recall lacks the token\n')
    expect(text).toContain(`\n  kept    ${evidence.lanes[0]!.transcript}\n`)
    expect(text).toContain('\ndrain stopped, 0 groups left\n')
    expect(text.endsWith('\nfail\n')).toBe(true)
  })

  it('exits 70 when the drain failed or never ran, or a cleanup failed, whatever the lanes did', () => {
    const drain = (state: DrainResult['state']) => ({ state }) as DrainResult
    const lanes = (...steps: AcceptStep[]) => [{ steps }] as AcceptEvidence['lanes']
    const ok = lanes({ name: 'close', ok: true, ms: 1 })
    const failed = lanes({ name: 'close', ok: false, ms: 1, detail: 'no' })
    const cleanup = lanes({ name: 'close', ok: false, ms: 1, detail: 'no', cleanup: true })
    expect(acceptExitCode({ verdict: 'pass', drain: drain('stopped'), lanes: ok })).toBe(0)
    expect(acceptExitCode({ verdict: 'fail', drain: drain('stopped'), lanes: failed })).toBe(1)
    expect(acceptExitCode({ verdict: 'fail', drain: drain('stopped'), lanes: cleanup })).toBe(70)
    expect(acceptExitCode({ verdict: 'pass', drain: drain('failed'), lanes: ok })).toBe(70)
    expect(acceptExitCode({ verdict: 'fail', drain: drain('failed'), lanes: failed })).toBe(70)
    expect(acceptExitCode({ verdict: 'pass', drain: null, lanes: ok })).toBe(70)
  })

  it('attaches its runtime for signals while it runs, and detaches it after its drain', async () => {
    const calls: string[] = []
    const { outcome } = await accept({
      attach: (target) => {
        calls.push(`attach ${typeof target.drain}`)
        return () => void calls.push('detach')
      },
    })
    expect(calls).toEqual(['attach function', 'detach'])
    expect(evidenceOf(outcome).drain?.state).toBe('stopped')
  })
})
