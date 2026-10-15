import {
  parseProviderLoginOp,
  PROVIDER_LOGIN_LIMITS,
} from '@phosphor/shared/host-protocol-providers'
import { runProviderLogin, type LoginContext } from '../commands/provider-login'
import { TerminalForbidden, type HostTerminals } from '../terminals/service'

/** The CLI owns provider membership, program, argv, environment and temporary cwd. */
export function createProviderLogins(
  context: Omit<LoginContext, 'provider' | 'progress' | 'run'>,
  terminals: HostTerminals,
  login = runProviderLogin,
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
      const runner = terminals.loginRunner(owner, (terminalId) => {
        started = true
        resolve({ terminalId })
      })
      void login({
        ...context,
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
        .then(
          () => {
            if (!started) reject(new Error('unavailable'))
          },
          () => reject(new Error('unavailable')),
        )
        .finally(() => active.delete(op.provider))
    })
  }
  return { execute }
}
export type ProviderLogins = ReturnType<typeof createProviderLogins>
