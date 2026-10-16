import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { EXIT } from '../checks'
import type { ControlContext } from '../control/command'
import { loadHostConfig } from '../config/load'
import { buildPiEnvironment } from '../machine/environment'
import { which } from '../machine/executables'
import { inspectClaude, CLAUDE_PROVIDER_PACKAGE } from '../machine/claude'
import { inspectTailscale, successfulProbe, tailscaleOptions } from '../machine/tailscale'
import { probe } from '../machine/probe'
import type { ServiceContext } from './service'
import { runService } from './service'
import { serviceState } from './update'
import { runLogin } from './login'
import { runTailscale } from './tailscale'
import { runSetup, type SetupContext, type SetupReport } from './setup'
import { setupTerminal, SetupCancelled, type SetupTerminal } from './setup-terminal'

export type GuidedSetupContext = SetupContext &
  ServiceContext &
  ControlContext & {
    setupTerminal?: SetupTerminal
    json?: boolean
    packages?: typeof listPackages
  }

/** Each completed step survives interruption. Non-terminal CLI setup remains config-only. */
export async function runGuidedSetup(context: GuidedSetupContext): Promise<SetupReport> {
  let report: SetupReport = { exitCode: 0, config: context.configPath, checks: [], notes: [] }
  const terminal =
    context.setupTerminal ?? setupTerminal(context.env, context.signal, context.json ? 2 : 1)
  const row = (mark: string, name: string, text: string) =>
    context.print(`  ${mark} ${name.padEnd(16)} ${text}`)
  const stop = (code: number, fix: string) => {
    report.exitCode = code
    report.notes = [fix]
    report.next = undefined
    context.print(fix)
    return report
  }
  const askRun = async (question: string, file: string, args: string[]) =>
    (await terminal.confirm(question, [file, ...args].join(' '))) &&
    (await terminal.run(file, args)) === 0
  context.print(`Phosphor setup for ${context.hostname}`)
  try {
    const loaded = await loadHostConfig(context.configPath, context.uid)
    const config = loaded.ok
      ? loaded.config
      : { version: 1 as const, pi: { executable: '/unused' }, repositories: [] }
    const inspect = () => inspectTailscale(config, context.env, context.platform, context.tailscale)
    let tailscale = await inspect()
    if (tailscale.readiness === 'missing')
      return stop(69, 'Install Tailscale: https://tailscale.com/download')
    if (tailscale.readiness === 'stopped')
      return stop(69, 'Sign in to Tailscale: sudo tailscale up')
    if (tailscale.readiness === 'no-https')
      return stop(69, 'Enable Tailscale HTTPS: https://login.tailscale.com/admin/dns')
    if (!tailscale.name) return stop(69, 'Check Tailscale: tailscale status')
    row('✓', 'Tailscale', `signed in as ${tailscale.name}`)
    const user = context.service?.user ?? userInfo().username
    const prefs = () =>
      (context.tailscale?.probe ?? probe)(
        tailscale.executable ?? 'tailscale',
        ['debug', 'prefs'],
        tailscaleOptions(config, context.env, context.platform),
      )
    const operatorReady = async () => {
      const result = await prefs()
      if (!successfulProbe(result)) return false
      try {
        const value: unknown = JSON.parse(result.stdout)
        return (
          typeof value === 'object' &&
          value !== null &&
          'OperatorUser' in value &&
          value.OperatorUser === user
        )
      } catch {
        return false
      }
    }
    if (!(await operatorReady())) {
      row(
        '!',
        'Tailscale access',
        'Phosphor needs one Tailscale setting (operator) to publish its address.',
      )
      const args = [tailscale.executable ?? 'tailscale', 'set', `--operator=${user}`]
      if (
        !(await askRun(
          `Run "sudo tailscale set --operator=${user}" now?`,
          '/usr/bin/sudo',
          args,
        )) ||
        !(await operatorReady())
      )
        return stop(75, `Run: sudo tailscale set --operator=${user}`)
    }
    row('✓', 'Tailscale access', 'operator allowed')
    const discovery = buildPiEnvironment({ hostEnv: context.env, platform: context.platform })
    const searchPath = `${context.env.PATH ?? ''}:${discovery.env.PATH ?? ''}`
    const pinnedPi = context.pi ?? (loaded.ok ? loaded.config.pi.executable : undefined)
    const piExists = pinnedPi
      ? (await stat(pinnedPi).catch(() => null))?.isFile()
      : await which('pi', searchPath)
    if (!piExists) {
      row('!', 'pi', 'not installed')
      const npm = await which('npm', searchPath)
      if (!npm)
        return stop(
          69,
          'Install Node.js 22.19+: https://nodejs.org\nThen: npm install -g @earendil-works/pi-coding-agent',
        )
      if (
        !(await askRun('Install pi with npm now?', npm, [
          'install',
          '-g',
          '@earendil-works/pi-coding-agent',
        ]))
      )
        return stop(69, 'Run: npm install -g @earendil-works/pi-coding-agent')
    }
    report = await runSetup({ ...context, tailscaleHints: false })
    if (report.exitCode !== EXIT.ok)
      return stop(
        report.exitCode,
        report.checks.find((check) => check.status === 'fail')?.summary ??
          report.notes.at(-1) ??
          'Run phosphor doctor for the pi installation fix.',
      )
    report.next = undefined
    report.notes = []
    row('✓', 'pi', report.pi?.version ?? 'installed')
    const login = await runLogin(context)
    if (login.exitCode !== EXIT.ok) return stop(login.exitCode, login.message)
    row('✓', 'Account', login.message)
    const state = await serviceState(context)
    if (state.running && report.changed)
      return stop(0, 'Config changed. Run phosphor service restart to apply; running lanes stop.')
    if (!state.installed || !state.running) {
      const code = await runService({ ...context, print: () => {} }, 'install')
      if (code !== EXIT.ok) return stop(code, 'Run: phosphor service install')
    }
    row('✓', 'Service', 'running')
    const enabled = await runTailscale(context, 'enable', context.tailscale)
    if (enabled.exitCode !== EXIT.ok) return stop(enabled.exitCode, enabled.message)
    tailscale = await inspect()
    if (!tailscale.endpoint) return stop(75, 'Run: phosphor tailscale enable')
    row('✓', 'Address', tailscale.endpoint)
    const refreshed = await loadHostConfig(context.configPath, context.uid)
    if (!refreshed.ok) return stop(78, 'Run: phosphor doctor')
    const environment = buildPiEnvironment({
      hostEnv: context.env,
      platform: context.platform,
      ...refreshed.config.environment,
      nodePath: refreshed.config.pi.node,
    })
    const packages = context.packages ?? listPackages
    const status = () => packages().then((found) => inspectClaude(found, environment))
    let claude = await status()
    if (claude.provider !== 'ok' || claude.cli !== 'ok' || claude.auth !== 'ok')
      row('?', 'Claude', 'setup needed')
    if (claude.provider === 'ok' && claude.cli === 'ok' && claude.auth === 'ok')
      row('✓', 'Claude', 'ready')
    else if (await terminal.confirm('Set up Claude on this machine?', 'phosphor setup')) {
      if (claude.cli === 'missing') {
        if (
          await terminal.confirm(
            "Install Claude Code with Anthropic's installer (curl -fsSL https://claude.ai/install.sh | bash)?",
            'curl -fsSL https://claude.ai/install.sh | bash',
          )
        ) {
          const dir = await mkdtemp(join(tmpdir(), 'phosphor-claude-'))
          try {
            const script = join(dir, 'install.sh')
            if (
              (await terminal.run('curl', [
                '-fsSL',
                'https://claude.ai/install.sh',
                '-o',
                script,
              ])) !== 0 ||
              (await terminal.run('/bin/bash', [script])) !== 0
            )
              return stop(69, 'Claude Code installation failed. Run phosphor setup to retry.')
          } finally {
            await rm(dir, { recursive: true, force: true })
          }
        }
      }
      if (claude.provider !== 'ok') {
        const pi = refreshed.config.pi
        const args = [
          ...(pi.node ? [pi.executable] : []),
          'install',
          `npm:${CLAUDE_PROVIDER_PACKAGE}`,
        ]
        if (!(await askRun('Install the Claude provider for pi?', pi.node ?? pi.executable, args)))
          row('-', 'Claude provider', `Run: pi install npm:${CLAUDE_PROVIDER_PACKAGE}`)
      }
      claude = await status()
      const binary = await which('claude', environment.env.PATH ?? '')
      if (binary && claude.auth !== 'ok') await askRun('Sign in to Claude Code now?', binary, [])
      claude = await status()
      row(
        claude.provider === 'ok' && claude.cli === 'ok' && claude.auth === 'ok' ? '✓' : '-',
        'Claude',
        claude.provider === 'ok' && claude.cli === 'ok' && claude.auth === 'ok'
          ? 'ready'
          : 'not ready. Run phosphor setup to finish.',
      )
    } else row('-', 'Claude', 'skipped. Run phosphor setup to finish.')
    row(
      '-',
      'Folders',
      report.repositories?.length
        ? `${report.repositories.length} configured`
        : 'none yet. Add one from Desktop, or: phosphor setup --repository PATH',
    )
    return stop(0, `Ready. Open ${context.hostname} in Phosphor.`)
  } catch (error) {
    if (context.signal?.aborted || error instanceof SetupCancelled) return stop(130, 'Cancelled.')
    throw error
  }
}
