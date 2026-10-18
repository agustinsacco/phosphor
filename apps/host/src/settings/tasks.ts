import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMachineTask } from '@phosphor/shared/machine-settings'
import { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { readMcpConfigs } from '@phosphor/session-runtime/pi/mcp-config'
import { which } from '../machine/executables'
import type { HostTerminals } from '../terminals/service'
import { TerminalForbidden } from '../terminals/service'
import type { createMachineSettings } from './service'

/** Receipt-backed, fixed-purpose programs in private PTYs. No caller argv, shell or env. */
export function createMachineTasks(options: {
  terminals: Pick<HostTerminals, 'loginRunner' | 'machineOp'>
  settings: Pick<
    ReturnType<typeof createMachineSettings>,
    'workspace' | 'agentDir' | 'invalidateConnectors'
  >
  home: string
  env: Record<string, string>
  pi: { binaryPath: string; prefixArgs: string[] }
}) {
  let active = false
  async function execute(raw: unknown, owner: string, authorized: () => boolean) {
    const op = parseMachineTask(raw)
    if (!op) throw new Error('bad-request')
    if (!authorized()) throw new TerminalForbidden('forbidden')
    if (active) throw new Error('busy')
    active = true
    return new Promise<{ terminalId: string }>((resolve, reject) => {
      let started = false
      let deadline: ReturnType<typeof setTimeout> | undefined
      const run = options.terminals.loginRunner(
        owner,
        (id) => {
          started = true
          deadline = setTimeout(() => {
            try {
              options.terminals.machineOp(owner, { type: 'terminal.kill', terminalId: id })
            } catch {
              /* Already closed or revoked. */
            }
          }, 15 * 60_000)
          deadline.unref()
          resolve({ terminalId: id })
        },
        true,
        false,
        authorized,
      )
      void (async () => {
        const cwd = options.settings.workspace(op.repositoryId) ?? options.home
        let file = options.pi.binaryPath
        let args = [...options.pi.prefixArgs]
        let temporary: string | undefined
        try {
          if (op.task === 'claude.installCli') {
            const curl = await which('curl', options.env.PATH ?? '')
            const bash = await which('bash', options.env.PATH ?? '')
            if (!curl || !bash) throw new Error('unavailable')
            temporary = await mkdtemp(join(tmpdir(), 'phosphor-claude-install-'))
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
            if (!configs.servers.some((server) => server.name === op.name))
              throw new Error('bad-request')
            args.push('mcp', op.task === 'mcp.login' ? 'login' : 'logout', op.name!)
            if (op.task === 'mcp.login') args.push('--timeout', '300')
          } else args.push('--no-session', '--no-extensions')
          if (!authorized()) throw new TerminalForbidden('forbidden')
          await run(file, args, { cwd, env: { ...options.env, TERM: 'xterm-256color' } })
        } finally {
          if (temporary) await rm(temporary, { recursive: true, force: true })
        }
      })()
        .then(
          () => {
            if (!started) reject(new Error('unavailable'))
          },
          () => reject(new Error('unavailable')),
        )
        .finally(() => {
          if (deadline) clearTimeout(deadline)
          active = false
          options.settings.invalidateConnectors()
        })
    })
  }
  return { execute, active: () => active }
}
export type MachineTasks = ReturnType<typeof createMachineTasks>
