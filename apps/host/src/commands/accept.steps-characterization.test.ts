import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeMachine, SECRET, type FakeMachine } from '../__fixtures__/machine'
import type { DrainResult } from '../session/lifecycle'
import {
  acceptExitCode,
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

describe('accept steps characterization', { timeout: 30_000 }, () => {
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
      { provider: 'openai-codex', model: 'gpt-test' },
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

  it.each([
    ['named too', { provider: 'openai-codex' }],
    ["pi's own", {}],
  ])(
    'takes a model named as provider/id with a thinking level as that id, the provider %s',
    async (_, named) => {
      const { outcome } = await accept({
        ...named,
        model: 'openai-codex/gpt-test:high',
        // Without --provider, pi's own default must be that provider.
        env: { ...machine.hostEnv, PI_FAKE_PROVIDER: 'openai-codex', PI_FAKE_MODEL: 'gpt-test' },
      })
      expect(outcome.exitCode).toBe(0)
      expect(evidenceOf(outcome).lanes[0]).toMatchObject({
        provider: 'openai-codex',
        model: 'gpt-test',
      })
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

  it('runs the Claude lane on pi-claude-cli and the model named, after the native lane', async () => {
    machine.installClaude()
    const { outcome } = await accept({ lane: 'all', claudeModel: 'claude-test' })
    const evidence = evidenceOf(outcome)
    expect(outcome.exitCode).toBe(0)
    expect(evidence.claude).toEqual({ cli: `${machine.bin}/claude`, version: '2.1.283' })
    expect(
      evidence.lanes.map((lane) => [lane.lane, lane.verdict, lane.provider, lane.model]),
    ).toEqual([
      ['native', 'pass', 'fake', 'fake-model'],
      ['claude', 'pass', 'pi-claude-cli', 'claude-test'],
    ])
    expect(JSON.stringify(evidence)).not.toContain('person@example.com')
  })

  it('refuses a Claude lane without a model before spawning when the default is not Claude', async () => {
    machine.installClaude()
    const { outcome, progress } = await accept({ lane: 'claude' })
    expect(outcome).toEqual({
      exitCode: 64,
      problem:
        "the claude lane cannot start: pi's default is not Claude, so name the lane's model with --claude-model",
    })
    expect(progress).toEqual([])
    expect(transcripts()).toEqual([])
  })

  it('uses the Claude default without passing a provider-only argument to pi', async () => {
    machine.installClaude()
    const path = join(machine.agentDir, 'settings.json')
    const settings = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...settings, defaultProvider: 'pi-claude-cli' }))
    const onClaude = await accept({
      lane: 'claude',
      env: { ...machine.hostEnv, PI_FAKE_PROVIDER: 'pi-claude-cli' },
    })
    expect(onClaude.outcome.exitCode).toBe(0)
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

  it('does not force a second drain after a signal has begun draining', async () => {
    let signal!: (reason: string) => Promise<Pick<DrainResult, 'state'>>
    let drained: ReturnType<typeof signal> | undefined
    let detached = false
    const { outcome } = await accept({
      attach: (target) => {
        signal = target.drain
        return () => {
          detached = true
        }
      },
      progress: (line) => {
        if (line.startsWith('native: start ok')) drained = signal('signal')
      },
    })
    expect(drained).toBeDefined()
    expect(await drained).toMatchObject({ state: 'stopped', forced: null })
    expect(evidenceOf(outcome).drain).toBeNull()
    expect(outcome.exitCode).toBe(70)
    expect(detached).toBe(true)
  })
})
