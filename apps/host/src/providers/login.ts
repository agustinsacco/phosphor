import {
  parseProviderLoginOp,
  PROVIDER_LOGIN_LIMITS,
} from '@phosphor/shared/host-protocol-providers'
import { runProviderLogin, type LoginContext } from '../commands/provider-login'
import { TerminalForbidden, type HostTerminals } from '../terminals/service'
import type { HostClaudeAccounts } from './accounts'
import { prepareLoginAccount } from './login-account'

/** The CLI owns provider membership, program, argv, environment and temporary cwd. */
export function createProviderLogins(
  context: Omit<LoginContext, 'provider' | 'progress' | 'run'>,
  terminals: HostTerminals,
  login = runProviderLogin,
  accounts?: Pick<
    HostClaudeAccounts,
    'loadAccounts' | 'beginAddAccount' | 'finishAddAccount' | 'withAuthorization'
  >,
) {
  const active = new Set<string>()
  async function execute(raw: unknown, owner: string, authorized: () => boolean) {
    const op = parseProviderLoginOp(raw)
    if (!op) throw new Error('bad-request')
    if (!authorized()) throw new TerminalForbidden('forbidden')
    if (active.has(op.provider) || active.size >= PROVIDER_LOGIN_LIMITS.perHost)
      throw new Error('too-many-requests')
    active.add(op.provider)
    return new Promise<{ terminalId: string }>((resolve, reject) => {
      let started = false
      let terminalId: string | undefined
      let verified = false
      let deadline: ReturnType<typeof setTimeout> | undefined
      const configuration = !!(op.configure || op.accountId || op.addAccount)
      const runner = terminals.loginRunner(
        owner,
        (id) => {
          terminalId = id
          started = true
          if (configuration) {
            deadline = setTimeout(() => {
              try {
                terminals.machineOp(owner, { type: 'terminal.kill', terminalId: id })
              } catch {
                /* Already finished or cancelled. */
              }
            }, 15 * 60_000)
            deadline.unref()
          }
          resolve({ terminalId: id })
        },
        configuration,
        configuration,
        authorized,
      )
      const perform = async () => {
        if (!authorized()) throw new TerminalForbidden('forbidden')
        const { accountId, credentialEnv } = await prepareLoginAccount(op, accounts)
        const outcome = await login({
          ...context,
          credentialEnv,
          env: { ...context.env, TERM: 'xterm-256color' },
          attach: undefined,
          provider: op.provider,
          progress: () => {},
          run: (file, args, settings) => {
            // Inspection awaits probes. Recheck the live grant before spawning anything.
            if (!authorized()) throw new TerminalForbidden('forbidden')
            return runner(file, args, settings)
          },
        })
        verified =
          outcome.exitCode === 0 && (!accountId || !!(await accounts?.finishAddAccount(accountId)))
      }
      void (accounts ? accounts.withAuthorization(authorized, perform) : perform())
        .then(
          () => {
            if (!started) reject(new Error('unavailable'))
          },
          () => reject(new Error('unavailable')),
        )
        .finally(() => {
          active.delete(op.provider)
          if (deadline) clearTimeout(deadline)
          if (terminalId) terminals.completeLogin(owner, terminalId, verified ? 0 : 1)
        })
    })
  }
  return { execute, active: () => active.size > 0 }
}
export type ProviderLogins = ReturnType<typeof createProviderLogins>
