import { describe, expect, it } from 'vitest'
import type { AcceptEvidence } from '../commands/accept'
import type { DoctorReport } from '../commands/doctor'
import type { ProvidersReport } from '../commands/providers'
import type { StatusReport } from '../commands/status'
import { fakeTerminal } from './__fixtures__/fake-terminal'
import {
  serviceFact,
  showEnrollment,
  showServiceFacts,
  showStatus,
  type ServiceFacts,
} from './present-control'
import { lineTone, messageLines, screenSetupView, updateProgress } from './present-flow'
import { acceptProgress, nextStep, showAccept, showDoctor, showProviders } from './present-reports'
import { createScreen } from './screen'
import { painter } from './theme'

const HOME = '/home/ada'

function drawn() {
  const t = fakeTerminal(100)
  return { screen: createScreen(t.terminal), text: t.text }
}

const doctor = (overrides: Partial<DoctorReport> = {}): DoctorReport => ({
  ok: false,
  exitCode: 69,
  host: { version: '1.0.0', node: '24.0.0', platform: 'linux' },
  config: { path: `${HOME}/.config/phosphor-host/config.json` },
  checks: [
    { id: 'config', status: 'pass', summary: `${HOME}/.config/phosphor-host/config.json` },
    { id: 'pi', status: 'fail', summary: 'pi was not found on PATH', exit: 69 },
    { id: 'providers', status: 'info', summary: 'no pi provider is signed in' },
  ],
  lanes: {
    native: { available: false, reason: 'pi is not usable' },
    claude: { available: true, detail: `${HOME}/.local/bin/claude 2.1.0, logged in` },
  },
  next: 'install pi: npm install -g @earendil-works/pi-coding-agent',
  ...overrides,
})

describe('reports', () => {
  it("shows doctor's checks and lanes with home as ~, the fix and a failing close", () => {
    const { screen, text } = drawn()
    showDoctor(screen, doctor(), HOME)
    expect(text()).toBe(
      [
        '│',
        '■  This machine',
        '│  ✓ config     ~/.config/phosphor-host/config.json',
        '│  ✗ pi         pi was not found on PATH',
        '│  ● providers  no pi provider is signed in',
        '│',
        '◇  Lanes',
        '│  – native  pi is not usable',
        '│  ✓ claude  ~/.local/bin/claude 2.1.0, logged in',
        '│',
        '▲  Install pi:',
        '│  npm install -g @earendil-works/pi-coding-agent',
        '│',
        '└  Not ready (exit 69).',
        '',
        '',
      ].join('\n'),
    )
  })

  it('lists config errors under the checks', () => {
    const { screen, text } = drawn()
    const errors = [{ pointer: '/pi/executable', message: 'must be absolute' }]
    showDoctor(screen, doctor({ config: { path: '/c.json', errors } }), HOME)
    expect(text()).toContain('│    /pi/executable: must be absolute')
  })

  it('shows the providers, how many are signed in, and the claude lane', () => {
    const report: ProvidersReport = {
      ok: true,
      exitCode: 0,
      hostId: 'h',
      providers: [
        { id: 'anthropic', name: 'Claude Pro/Max', status: 'ready', default: true },
        { id: 'xai', name: 'xAI', status: 'not_ready', reason: 'credentials_not_configured' },
      ],
      claude: { available: false, reason: 'claude is not installed' },
      next: 'run real sessions: phosphor accept --repository DIR',
    }
    const { screen, text } = drawn()
    showProviders(screen, report, HOME)
    const shown = text()
    expect(shown).toContain('◆  Providers · 1 signed in')
    expect(shown).toContain("│  ✓ Claude Pro/Max  signed in · anthropic, pi's default")
    expect(shown).toMatch(/│ {2}– xAI {13}.+ · xai/)
    expect(shown).toContain('│  – claude  claude is not installed')
    expect(shown).toContain('└  Ready.')
  })

  it('shows accept lanes without the steps already shown live', () => {
    const evidence = {
      verdict: 'pass',
      lanes: [
        {
          lane: 'native',
          verdict: 'pass',
          provider: 'anthropic',
          model: 'opus',
          steps: [{ name: 'prompt', ok: true, ms: 12 }],
          extensionsLoaded: true,
          groupsAlive: 0,
          transcriptDeleted: true,
        },
        {
          lane: 'claude',
          verdict: 'unavailable',
          reason: 'claude is not installed',
          steps: [],
          extensionsLoaded: false,
          groupsAlive: 0,
          transcriptDeleted: false,
        },
      ],
      drain: { state: 'stopped', reason: 'done', sessions: 1, aborted: 0, remaining: [] },
      log: `${HOME}/.local/state/phosphor-host/logs/host.log`,
    } as unknown as AcceptEvidence
    const live = drawn()
    showAccept(live.screen, evidence, HOME, false)
    expect(live.text()).not.toContain('prompt')
    expect(live.text()).toContain('◆  native lane · anthropic · opus')
    expect(live.text()).toContain('◇  claude lane: claude is not installed')
    expect(live.text()).toContain('●  Log: ~/.local/state/phosphor-host/logs/host.log')
    expect(live.text()).toContain('└  Accepted: real sessions ran here.')
    const full = drawn()
    showAccept(full.screen, evidence, HOME)
    expect(full.text()).toContain('│  ✓ prompt  12 ms')
  })

  it.each([
    ['native: prompt ok (120 ms)', 'ok'],
    ['claude: stop FAILED: group alive', 'fail'],
    ['claude: unavailable: not installed', 'skip'],
    ['native: starting', 'info'],
  ])('reads accept progress %j as %s', (line, tone) => {
    expect(acceptProgress(line).tone).toBe(tone)
  })

  it('puts the command of a next step on its own line', () => {
    const plain = painter(false)
    expect(nextStep(plain, 'run phosphor setup')).toBe('Run phosphor setup')
    expect(nextStep(plain, 'sign in: phosphor providers login anthropic')).toBe(
      'Sign in:\nphosphor providers login anthropic',
    )
  })
})

describe('control', () => {
  const identity = { label: 'bee2', ownerLogin: 'ada' } as StatusReport['identity']
  const now = Date.parse('2026-10-21T12:00:00Z')

  it('shows a confirmed machine with relative times', () => {
    const { screen, text } = drawn()
    const server = {
      label: 'bee2',
      owner: { login: 'ada' },
      enrolledAt: '2026-10-16T12:00:00Z',
      lastSeenAt: '2026-10-21T11:58:00Z',
    } as StatusReport['server']
    const report: StatusReport = { version: 1, status: 'confirmed', identity, server, error: null }
    expect(showStatus(screen, report, now)).toBe(true)
    expect(text()).toBe(
      [
        '│',
        '◆  Signed in as "bee2" on @ada\'s account',
        '│  ● server     "bee2"',
        '│  ● owner      @ada',
        '│  ● enrolled   5 days ago',
        '│  ● last seen  2 minutes ago',
        '',
      ].join('\n'),
    )
  })

  it('points a machine that is not signed in, or not confirmed, at setup', () => {
    const lost = drawn()
    const none: StatusReport = {
      version: 1,
      status: 'not-enrolled',
      identity: null,
      server: null,
      error: null,
    }
    expect(showStatus(lost.screen, none, now)).toBe(false)
    expect(lost.text()).toContain('▲  This machine is not signed in.')
    expect(lost.text()).toContain('●  Next: phosphor setup')
    const offline = drawn()
    const report = { ...none, status: 'unreachable', identity, error: 'Phosphor is offline.' }
    expect(showStatus(offline.screen, report as StatusReport, now)).toBe(false)
    expect(offline.text()).toContain('│  Phosphor is offline.')
  })

  it('frames the enrollment code with its fingerprint', () => {
    const { screen, text } = drawn()
    showEnrollment(screen, {
      userCode: 'ABCDEFGH',
      fingerprint: 'SHA256:abc',
      expiresInMs: 600_000,
      resuming: true,
    })
    expect(text()).toMatch(/Add this machine \(earlier code\)/)
    expect(text()).toContain('ABCD-EFGH')
    expect(text()).toContain('SHA256:abc')
  })

  it("reads systemd's and launchd's state lines into one service line", () => {
    const systemd: ServiceFacts = {}
    for (const line of ['ActiveState=active', 'SubState=running', 'MainPID=42', 'Linger: off'])
      expect(serviceFact(systemd, line)).toBe(true)
    expect(serviceFact(systemd, 'Signed in as "bee2"')).toBe(false)
    const { screen, text } = drawn()
    showServiceFacts(screen, systemd)
    expect(text()).toContain('▲  Service running · pid 42 · linger off')
    expect(text()).toContain('sudo loginctl enable-linger $USER')
    const launchd: ServiceFacts = {}
    for (const line of ['state = not running', 'last exit code = 78']) serviceFact(launchd, line)
    const stopped = drawn()
    showServiceFacts(stopped.screen, { ...launchd, state: 'waiting' })
    expect(stopped.text()).toContain('■  Service waiting · last exit 78')
  })
})

describe('flows', () => {
  it.each([
    ['Warning: Claude provider update failed. Run: pi update x', 'warn'],
    ['The service could not be stopped.', 'fail'],
    ['Phosphor Host service restarted.', 'info'],
  ])('gives %j the tone %s', (line, tone) => {
    expect(lineTone(line)).toBe(tone)
  })

  it('closes with the last message, or with a failure under the fix', () => {
    const ok = drawn()
    const lines = messageLines(ok.screen)
    lines.print('Phosphor Host service restarted.')
    lines.print('Selected Host 1.2.3.')
    lines.close(0, 'Done.')
    expect(ok.text()).toBe('│\n●  Phosphor Host service restarted.\n│\n└  Selected Host 1.2.3.\n\n')
    const failed = drawn()
    messageLines(failed.screen).close(69, 'Run: phosphor service install')
    expect(failed.text()).toContain('■  Run:\n│  phosphor service install')
    expect(failed.text()).toContain('└  Stopped (exit 69).')
  })

  it("shows an update's steps as lines once each is done", () => {
    const { screen, text } = drawn()
    const progress = updateProgress(screen)
    progress({ step: 'check' })
    progress({ step: 'found', version: '1.3.0', installed: '1.2.0' })
    progress({ step: 'download', version: '1.3.0', bytes: 3 * 1024 * 1024 })
    progress({ step: 'restart', version: '1.3.0' })
    progress({ step: 'health', version: '1.3.0' })
    progress({ step: 'rollback', version: '1.2.0' })
    progress({ step: 'selected', version: '1.2.0', installed: '1.2.0' })
    expect(
      text()
        .split('\n')
        .filter((line) => !/^│?$/.test(line)),
    ).toEqual([
      '◆  Host 1.3.0 is available (installed: 1.2.0)',
      '◆  Downloaded and verified 1.3.0',
      '■  The new version did not come up healthy',
      '◆  Rolled back to 1.2.0',
    ])
  })

  it('says a rollback restarted the service, without a download it never made', () => {
    const { screen, text } = drawn()
    const progress = updateProgress(screen)
    progress({ step: 'restart', version: '1.2.0' })
    progress({ step: 'health', version: '1.2.0' })
    progress({ step: 'selected', version: '1.2.0', installed: '1.3.0' })
    expect(text()).not.toContain('Downloaded')
    expect(text()).toContain('◆  The Host is up and healthy on 1.2.0')
  })

  it("draws setup's checklist and closes by its exit code", () => {
    const run = (code: number, fix: string) => {
      const { screen, text } = drawn()
      const { view } = screenSetupView(screen)
      view.open('bee2')
      view.working('Checking Tailscale')
      view.row('ok', 'Tailscale', 'signed in as bee2')
      view.row('skip', 'Folders', 'none yet')
      view.end(code, fix)
      return text()
    }
    const ready = run(0, 'Ready. Open bee2 in Phosphor.')
    expect(ready).toContain('┌  Phosphor setup · bee2')
    expect(ready).toContain('◆  Tailscale         signed in as bee2')
    expect(ready).toContain('◇  Folders           none yet')
    expect(ready).toContain('└  Ready. Open bee2 in Phosphor.')
    expect(run(130, 'Cancelled.')).toContain('└  Cancelled. Steps already done are kept.')
    const stopped = run(75, 'Run: sudo tailscale set --operator=ada')
    expect(stopped).toContain('■  Run:\n│  sudo tailscale set --operator=ada')
    expect(stopped).toContain('└  Setup stopped (exit 75).')
  })
})
