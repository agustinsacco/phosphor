import { existsSync } from 'node:fs'
import type { SessionRegistry } from '@phosphor/session-runtime/pi/session-registry'
import type { HostClaudeAccounts } from '../providers/accounts'
import type { HostLog } from '../machine/log'

/** Bind only identities selected for this Host's own admitted processes. */
export function createRuntimeAccounts(
  registry: SessionRegistry,
  accounts: HostClaudeAccounts | undefined,
  log: HostLog,
) {
  const ids = new Map<string, string>()
  const files = new Map<string, string>()
  function bind(sessionId: string, path?: string) {
    const accountId = ids.get(sessionId)
    if (!accounts || !accountId || !path || !existsSync(path) || files.get(sessionId) === path)
      return
    files.set(sessionId, path)
    // Runtime bookkeeping outlives the configuration operation that admitted
    // a process. Revoking its client must not lose the process's billing identity.
    void accounts.withAuthorization(() => true, () => accounts.bindSession(path, accountId)).catch(() => {
      if (files.get(sessionId) === path) files.delete(sessionId)
      log.write('host', 'account.binding-failed', { sessionId })
    })
  }
  function forget(id: string) {
    ids.delete(id)
    files.delete(id)
  }
  registry.on('created', (session) => {
    session.client.on('session-file', (path) => bind(session.sessionId, path))
    // get_state can name a file before pi creates it on the first prompt.
    session.client.on('event', () => bind(session.sessionId, session.client.sessionFile))
  })
  registry.on('disposed', ({ sessionId }) => forget(sessionId))
  return {
    remember(id: string, accountId: string) {
      ids.set(id, accountId)
      bind(id, registry.get(id)?.client.sessionFile)
    },
    forget,
    hold: async (id: string, until: number) => { await accounts?.holdAccount(id, until) },
    accountForSession: (id: string) => ids.get(id),
  }
}
