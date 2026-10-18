import { describe, expect, it } from 'vitest'
import type { AcceptContext, AcceptEvidence, AcceptLaneResult } from './accept'
import type { HostInspection } from './doctor'
import type { DrainResult } from '../session/lifecycle'
import { acceptExitCode, acceptOutcome, renderAccept, unavailableLane } from './accept-report'

const context: AcceptContext = {
  configPath: '/config',
  env: {},
  platform: 'linux',
  uid: 1000,
  home: '/home',
  hostname: 'host',
  nodeVersion: '22.22.3',
  defaultResourceRoot: '/resources',
  repository: '/repo',
  lane: 'native',
  keepTranscripts: false,
  progress: () => {},
}
const inspection: HostInspection & { machine: NonNullable<HostInspection['machine']> } = {
  report: {
    ok: true,
    exitCode: 0,
    host: { version: 'test', node: '22', platform: 'linux' },
    config: { path: '/config', hostId: 'host' },
    checks: [],
    lanes: { native: { available: true }, claude: { available: false, reason: 'not installed' } },
    environment: { names: ['PATH', 'SECRET'], path: ['/bin'] },
  },
  machine: {
    roots: ['/repo'],
    resourceRoot: '/resources',
    env: { SECRET: 'secret-value' },
    contextBudget: '',
    pi: { binaryPath: '/node', prefixArgs: ['/pi'] },
  },
  secrets: ['secret-value'],
  piVersion: '1.2.0',
  claude: null,
  pi: null,
}
const drain: DrainResult = {
  state: 'stopped',
  reason: 'accept finished',
  sessions: 0,
  aborted: 0,
  unfinished: 0,
  forced: null,
  remaining: [],
  errors: [],
}
const lane = (verdict: AcceptLaneResult['verdict'] = 'pass'): AcceptLaneResult => ({
  lane: 'native',
  verdict,
  provider: 'native',
  model: 'model',
  thinkingLevel: 'high',
  steps: [{ name: 'close', ok: verdict === 'pass', ms: 5 }],
  extensionsLoaded: true,
  groupsAlive: 0,
  transcriptDeleted: true,
})
function evidenceOf(outcome: ReturnType<typeof acceptOutcome>): AcceptEvidence {
  if (!('evidence' in outcome)) throw new Error(outcome.problem)
  return outcome.evidence
}

describe('accept report', () => {
  it('builds evidence from inspection, uses the actual pi CLI and redacts nested strings', () => {
    const result = lane('fail')
    result.steps[0]!.detail = 'error with secret-value'
    result.transcript = '/secret-value/session.jsonl'
    const outcome = acceptOutcome(inspection, context, [result], drain, '/secret-value/log')
    expect(outcome.exitCode).toBe(1)
    const evidence = evidenceOf(outcome)
    expect(evidence).toMatchObject({
      schema: 1,
      verdict: 'fail',
      machine: `host · linux-${process.arch}`,
      host: { node: '22.22.3' },
      pi: { version: '1.2.0', cli: '/pi' },
      claude: { unavailable: 'not installed' },
      environment: { forwardedNames: ['PATH', 'SECRET'], valuesPrinted: false },
      lanes: [
        { steps: [{ detail: 'error with [redacted]' }], transcript: '/[redacted]/session.jsonl' },
      ],
      log: '/[redacted]/log',
    })
    expect(JSON.stringify(evidence)).not.toContain('secret-value')
    expect(result.steps[0]!.detail).toContain('secret-value')
    expect(renderAccept(evidence)).not.toContain('secret-value')
  })

  it.each([
    ['pass', ['pass', 'unavailable'], 'stopped', 0],
    ['fail', ['unavailable'], 'stopped', 1],
    ['fail', ['pass', 'fail'], 'stopped', 1],
    ['fail', ['pass'], 'failed', 70],
    ['fail', ['pass'], null, 70],
  ] as const)('computes %s from lanes %j and drain %s', (verdict, verdicts, state, code) => {
    const results = verdicts.map((verdict) => lane(verdict))
    const outcome = acceptOutcome(
      inspection,
      context,
      results,
      state ? { ...drain, state } : null,
      null,
    )
    expect(evidenceOf(outcome).verdict).toBe(verdict)
    expect(outcome.exitCode).toBe(code)
  })

  it('prioritizes cleanup failure even when the evidence verdict is pass', () => {
    const result = lane()
    result.steps[0]!.cleanup = true
    expect(acceptExitCode({ verdict: 'pass', lanes: [result], drain })).toBe(70)
  })

  it('retains the exact readable summary, kept transcript, unavailable reason and signal drain', () => {
    const result = lane('fail')
    result.steps = [
      { name: 'start', ok: true, ms: 5 },
      { name: 'prompt', ok: false, ms: 7, detail: 'bad reply' },
    ]
    result.transcript = '/kept.jsonl'
    result.transcriptDeleted = false
    const evidence = evidenceOf(
      acceptOutcome(
        inspection,
        context,
        [result, unavailableLane('claude', 'not installed')],
        null,
        '/log',
      ),
    )
    expect(renderAccept(evidence)).toBe(
      [
        `phosphor accept · host · linux-${process.arch} · ${evidence.host.version}`,
        'FAIL  native  native · model · high',
        '  ok    start    5 ms',
        '  FAIL  prompt   bad reply',
        '  kept    /kept.jsonl',
        'n/a   claude  not installed',
        'drain by signal',
        'log /log',
        'fail',
        '',
      ].join('\n'),
    )
  })

  it('renders a deleted transcript without a kept line and reports stopped group counts', () => {
    const result = lane()
    result.transcript = '/deleted.jsonl'
    const evidence = evidenceOf(acceptOutcome(inspection, context, [result], drain, null))
    const text = renderAccept(evidence)
    expect(text).toContain('drain stopped, 0 groups left\npass\n')
    expect(text).not.toContain('kept')
    expect(text).not.toContain('log ')
  })

  it('falls back to pi binaryPath when the CLI has no prefix arguments', () => {
    const direct = {
      ...inspection,
      machine: { ...inspection.machine, pi: { binaryPath: '/direct-pi', prefixArgs: [] } },
    }
    expect(evidenceOf(acceptOutcome(direct, context, [lane()], drain, null)).pi.cli).toBe(
      '/direct-pi',
    )
  })
})
