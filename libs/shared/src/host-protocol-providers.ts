import { terminalKeys, terminalRecord } from './host-protocol-terminals'
import { isMachineAccountId } from './machine-settings'

export const PROVIDER_LOGIN_LIMITS = { perHost: 2, disconnectMs: 10 * 60 * 1000 } as const
export interface ProviderLoginOp {
  type: 'provider.login'
  provider: string
  /** Existing identity to reauthenticate in a fresh Host-owned credential slot. */
  accountId?: string
  /** Allocate a fresh isolated credential before starting Claude's login. */
  addAccount?: true
  /** Machine Settings intent, including native providers; requires machine.configure. */
  configure?: true
}
export function parseProviderLoginOp(value: unknown): ProviderLoginOp | null {
  if (
    !terminalRecord(value) ||
    !terminalKeys(value, ['type', 'provider', 'accountId', 'addAccount', 'configure']) ||
    value.type !== 'provider.login' ||
    typeof value.provider !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.provider)
  )
    return null
  if (
    (value.accountId !== undefined || value.addAccount !== undefined) &&
    value.provider !== 'claude'
  )
    return null
  if (value.accountId !== undefined && !isMachineAccountId(value.accountId)) return null
  if (value.addAccount !== undefined && value.addAccount !== true) return null
  if (value.addAccount && value.accountId) return null
  if (value.configure !== undefined && value.configure !== true) return null
  return {
    type: 'provider.login',
    provider: value.provider,
    ...(value.accountId ? { accountId: value.accountId as string } : {}),
    ...(value.addAccount ? { addAccount: true } : {}),
    ...(value.configure ? { configure: true } : {}),
  }
}
