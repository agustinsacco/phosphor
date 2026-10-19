import type { ProviderLoginOp } from '@phosphor/shared/host-protocol-providers'
import type { HostClaudeAccounts } from './accounts'

/** Reauthentication always gets a fresh credential slot, never a live process's slot. */
export async function prepareLoginAccount(
  op: ProviderLoginOp,
  accounts?: Pick<HostClaudeAccounts, 'loadAccounts' | 'beginAddAccount'>,
): Promise<{ accountId?: string; credentialEnv?: Record<string, string> }> {
  if (op.provider === 'claude' && accounts) {
    const prefs = await accounts.loadAccounts()
    if (op.addAccount) {
      if (prefs.accounts.length >= 16) throw new Error('too-many-accounts')
      const target = await accounts.beginAddAccount()
      return { accountId: target.id, credentialEnv: target.env }
    }
    if (op.accountId) {
      if (!prefs.accounts.some((account) => account.id === op.accountId))
        throw new Error('unknown-account')
      const target = await accounts.beginAddAccount()
      return { accountId: target.id, credentialEnv: target.env }
    }
  } else if (op.accountId || op.addAccount) throw new Error('unsupported')
  return {}
}
