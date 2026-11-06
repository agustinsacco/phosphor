import type { ClaudeRoutingMode, ClaudeSessionAccount } from './models'

/** What a machine knows of one of its Claude accounts. */
interface AccountRow {
  id: string
  label: string
  email?: string
  plan?: string
}

/** A cooldown holds while its end is still ahead; a missing or past one holds nothing. */
export function holdActive(until: number | null | undefined, nowMs: number): until is number {
  return until !== null && until !== undefined && until > nowMs
}

/**
 * The account a session spends, as every surface describes it: This Mac's
 * session runtime (`claude:sessionAccount`) and a Host lane's switcher, from the
 * Host's providers. `holdUntil` is an account's cooldown, if it has one; a hold
 * already past is none. The alternative is the first other account not on hold.
 */
export function claudeSessionAccount(
  accounts: readonly AccountRow[],
  accountId: string,
  mode: ClaudeRoutingMode,
  holdUntil: (accountId: string) => number | null | undefined,
  nowMs: number,
): ClaudeSessionAccount | null {
  const account = accounts.find((a) => a.id === accountId)
  if (!account) return null
  const hold = (id: string): number | null => {
    const until = holdUntil(id)
    return holdActive(until, nowMs) ? until : null
  }
  const other = accounts.find((a) => a.id !== account.id && hold(a.id) === null)
  return {
    id: account.id,
    label: account.label,
    ...(account.email ? { email: account.email } : {}),
    ...(account.plan ? { plan: account.plan } : {}),
    total: accounts.length,
    mode,
    cooldownUntil: hold(account.id),
    alternative: other ? { id: other.id, label: other.email ?? other.label } : null,
  }
}
