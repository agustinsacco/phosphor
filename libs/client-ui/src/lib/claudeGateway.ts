/**
 * Settings → Claude Code read as a gateway: which account is spending, and
 * where a lane may be sent instead.
 *
 * Pure, because the interesting part is the eligibility rule and it decides
 * what a click does to a running session. A move restarts the lane, so
 * offering an account that cannot serve it (signed out) would cost the user a
 * spawn and give them a dead lane back.
 */
import { activeHold } from '@shared/claude-session-account'
import type { MachineAccount } from '@shared/machine-settings'
import type { ClaudeAccountView } from '@shared/models'

export interface MoveTarget {
  id: string
  label: string
  /** Held back from NEW sessions — still selectable, because a hold is advisory. */
  held: boolean
}

/** An account as the move rule sees it, from either machine. */
export interface MoveCandidate {
  id: string
  label: string
  /** `null`: the sign-in could not be checked, which is not "signed out". */
  signedIn: boolean | null
  cooldownUntil: number | null
}

/**
 * Where this lane may go, best first. The one rule for every machine and every
 * surface that moves a lane: Settings and the composer's switcher, on This Mac
 * and on a Host.
 *
 * A held account stays in the list rather than being hidden: cooldowns come
 * from a cached `/usage` reading, so "held" is as likely to be stale as it is
 * to be true, and the user watching a stuck lane knows more than the cache
 * does. It sorts last and the UI says so.
 */
export function moveTargets(
  accounts: readonly MoveCandidate[],
  currentAccountId: string | undefined,
  nowMs: number = Date.now(),
): MoveTarget[] {
  return accounts
    .filter((account) => account.id !== currentAccountId && account.signedIn !== false)
    .map((account) => ({
      id: account.id,
      label: account.label,
      held: activeHold(account.cooldownUntil, nowMs) !== null,
    }))
    .sort((a, b) => Number(a.held) - Number(b.held))
}

/** This Mac's account, as the move rule sees it. */
export const viewCandidate = (view: ClaudeAccountView): MoveCandidate => ({
  id: view.account.id,
  label: view.auth.email ?? view.account.email ?? view.account.label,
  signedIn: view.auth.loggedIn ?? null,
  cooldownUntil: view.cooldownUntil,
})

/** A Host's account, as the move rule sees it. */
export const machineCandidate = (account: MachineAccount): MoveCandidate => ({
  id: account.id,
  label: account.email ?? account.label,
  signedIn: account.loggedIn,
  cooldownUntil: account.cooldownUntil,
})

/** The Host account a lane bills: the one that lists it among its lanes. */
export const laneAccountId = (accounts: readonly MachineAccount[], laneId: string) =>
  accounts.find((account) => account.lanes.some((lane) => lane.id === laneId))?.id
