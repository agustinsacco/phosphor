import type {
  ClaudeAccount,
  ClaudeAccountPrefs,
  ClaudeRoutingMode,
  ClaudeSessionAccount,
} from '@shared/models'
import type { AccountState } from './account-state'
import { isCoolingDown, selectAccount } from './routing'

/** The account a one-shot `pi -p` run (session naming, provider test) uses. */
async function primaryAccount(
  state: AccountState,
  claudeOverride?: string,
): Promise<ClaudeAccount | null> {
  const prefs = await state.loadAccounts(claudeOverride)
  const pinned = prefs.pinnedId ? prefs.accounts.find((a) => a.id === prefs.pinnedId) : undefined
  return pinned ?? prefs.accounts[0] ?? null
}

/** Remember which account a session ran on, so resuming it bills the same one. */
async function bindSession(
  state: AccountState,
  sessionPath: string,
  accountId: string,
): Promise<void> {
  const prefs = await state.loadAccounts()
  if (!prefs.accounts.some((a) => a.id === accountId)) return
  state.save({ ...prefs, bindings: { ...prefs.bindings, [sessionPath]: accountId } })
}

/** Set the routing rule, and for `specific` which account it points at. */
async function setRouting(
  state: AccountState,
  mode: ClaudeRoutingMode,
  pinnedId: string | undefined,
  claudeOverride?: string,
): Promise<void> {
  const prefs = await state.loadAccounts(claudeOverride)
  state.save({ ...prefs, mode, ...(pinnedId ? { pinnedId } : {}) })
}

/**
 * Hold an account back from new sessions until `untilMs`.
 *
 * Fed by the provider's own rate-limit reports (`electron/ipc/pi-session-handlers.ts`),
 * which arrive free, per turn, and know about a state `/usage` polling does
 * not surface as a window: an account past its plan allowance and spending
 * pay-as-you-go credits. Requests still succeed there, so without this the
 * router keeps handing out the one account that costs money.
 *
 * A no-op when it would shorten an existing hold — the reports repeat, and a
 * later one must not walk a cooldown backwards.
 */
async function holdAccount(state: AccountState, accountId: string, untilMs: number): Promise<void> {
  const prefs = state.read()
  if (!prefs.accounts.some((a) => a.id === accountId)) return
  if ((prefs.cooldowns[accountId] ?? 0) >= untilMs) return
  state.save({ ...prefs, cooldowns: { ...prefs.cooldowns, [accountId]: untilMs } })
}

/** The account a lane would move to: the first one not itself on hold. */
function alternativeTo(
  prefs: ClaudeAccountPrefs,
  accountId: string,
  nowMs: number,
): { id: string; label: string } | null {
  const other = prefs.accounts.find((a) => a.id !== accountId && !isCoolingDown(prefs, a.id, nowMs))
  return other ? { id: other.id, label: other.email ?? other.label } : null
}

/**
 * Which account is billing this session, for the UI that has to say so.
 *
 * Two sources, in order: the live pick parked at spawn, then the persisted
 * binding under the session's own file path (a resumed session, or one whose
 * pi subprocess has since been released).
 */
async function sessionAccount(
  state: AccountState,
  options: {
    accountId?: string | undefined
    sessionPath?: string | undefined
    claudeOverride?: string | undefined
  },
): Promise<ClaudeSessionAccount | null> {
  const prefs = await state.loadAccounts(options.claudeOverride)
  const id =
    options.accountId ?? (options.sessionPath ? prefs.bindings[options.sessionPath] : undefined)
  if (!id) return null
  const account = prefs.accounts.find((a) => a.id === id)
  if (!account) return null
  const now = Date.now()
  const cooldown = prefs.cooldowns[account.id]
  return {
    id: account.id,
    label: account.label,
    ...(account.email ? { email: account.email } : {}),
    ...(account.plan ? { plan: account.plan } : {}),
    total: prefs.accounts.length,
    mode: prefs.mode,
    cooldownUntil: cooldown !== undefined && cooldown > now ? cooldown : null,
    /** Another account is available and not itself on hold. */
    alternative: alternativeTo(prefs, account.id, now),
  }
}

export function createAccountRouting(
  state: AccountState,
  refreshCooldowns: (claudeOverride?: string) => Promise<void>,
) {
  /**
   * Choose the account for a session that is about to spawn, and persist the
   * round-robin cursor so the next session gets a different one.
   */
  async function accountForSpawn(
    options: { sessionPath?: string; claudeOverride?: string },
    nowMs: number = Date.now(),
  ): Promise<ClaudeAccount | null> {
    const prefs = await state.loadAccounts(options.claudeOverride)
    const { account, cursor } = selectAccount(prefs, {
      nowMs,
      ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}),
    })
    if (cursor !== prefs.cursor) state.save({ ...prefs, cursor })
    // Cooldowns come from cached `/usage` readings, so a machine that has never
    // fetched one routes everything to account #1. Warm the cache in the
    // background — the next session start is the one that benefits.
    if (account && prefs.mode !== 'specific') {
      void refreshCooldowns(options.claudeOverride).catch(() => undefined)
    }
    return account
  }

  return {
    primaryAccount: primaryAccount.bind(null, state),
    accountForSpawn,
    bindSession: bindSession.bind(null, state),
    setRouting: setRouting.bind(null, state),
    holdAccount: holdAccount.bind(null, state),
    sessionAccount: sessionAccount.bind(null, state),
  }
}
