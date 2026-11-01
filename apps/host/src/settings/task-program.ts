import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { parseMachineTask } from '@phosphor/shared/machine-settings'
import { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { readMcpConfigs } from '@phosphor/session-runtime/pi/mcp-config'
import { which } from '../machine/executables'
import type { HostTerminals } from '../terminals/service'
import { TerminalForbidden } from '../terminals/service'
import type { createMachineSettings } from './service'

export interface MachineTaskOptions {
  terminals: Pick<HostTerminals, 'loginRunner' | 'machineOp'>
  settings: Pick<
    ReturnType<typeof createMachineSettings>,
    'workspace' | 'agentDir' | 'invalidateConnectors'
  >
  home: string
  env: Record<string, string>
  pi: { binaryPath: string; prefixArgs: string[] }
  /** This Host's own release updater, or null where a button must not run it (`hostUpdateProgram`). */
  hostUpdater?: () => { node: string; bundle: string; env: Record<string, string> } | null
}

async function downloadClaudeInstaller(
  options: MachineTaskOptions,
  temporary: string,
  curl: string,
) {
  const script = join(temporary, 'install.sh')
  const download = await runPrintMode(
    curl,
    [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--max-filesize',
      '5242880',
      '--connect-timeout',
      '10',
      '--max-time',
      '30',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      'https://claude.ai/install.sh',
      '--output',
      script,
    ],
    { cwd: temporary, env: options.env, timeoutMs: 30_000 },
  )
  if (download.error) throw new Error('unavailable')
  return script
}

export async function runMachineTask(
  options: MachineTaskOptions,
  op: NonNullable<ReturnType<typeof parseMachineTask>>,
  run: ReturnType<HostTerminals['loginRunner']>,
  authorized: () => boolean,
) {
  const cwd = options.settings.workspace(op.repositoryId) ?? options.home
  let file = options.pi.binaryPath
  let args = [...options.pi.prefixArgs]
  let env = options.env
  let temporary: string | undefined
  try {
    if (op.task === 'host.update') {
      const updater = options.hostUpdater?.()
      if (!updater) throw new Error('unavailable')
      file = updater.node
      args = [updater.bundle, 'update']
      env = { ...options.env, ...updater.env }
    } else if (op.task === 'claude.installCli') {
      const curl = await which('curl', options.env.PATH ?? '')
      const bash = await which('bash', options.env.PATH ?? '')
      if (!curl || !bash) throw new Error('unavailable')
      temporary = await mkdtemp(join(tmpdir(), 'phosphor-claude-install-'))
      const script = await downloadClaudeInstaller(options, temporary, curl)
      file = bash
      args = [script]
    } else if (op.task === 'claude.installProvider')
      args.push('install', 'npm:@saccolabs/pi-claude-cli')
    else if (op.task.startsWith('package.')) {
      if (
        op.task !== 'package.install' &&
        !(await listPackages(cwd, options.settings.agentDir)).some(
          (pkg) => pkg.spec === op.name && pkg.scope !== 'project',
        )
      )
        throw new Error('bad-request')
      args.push(op.task.slice('package.'.length), op.name!)
    } else if (op.task.startsWith('mcp.')) {
      options.settings.invalidateConnectors()
      const configs = await readMcpConfigs(cwd, {
        home: options.home,
        piAgent: options.settings.agentDir,
        xdgConfig: join(options.home, '.config'),
      })
      if (!configs.servers.some((server) => server.name === op.name)) throw new Error('bad-request')
      args.push('mcp', op.task === 'mcp.login' ? 'login' : 'logout', op.name!)
      if (op.task === 'mcp.login') args.push('--timeout', '300')
    } else args.push('--no-session', '--no-extensions')
    if (!authorized()) throw new TerminalForbidden('forbidden')
    await run(file, args, { cwd, env: { ...env, TERM: 'xterm-256color' } })
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true })
  }
}
