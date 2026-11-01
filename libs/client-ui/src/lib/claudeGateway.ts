/**
 * Settings → Claude Code read as a gateway: which account is spending, and
 * where a lane may be sent instead.
 *
 * Pure, because the interesting part is the eligibility rule and it decides
 * what a click does to a running session. A move restarts the lane, so
 * offering an account that cannot serve it (signed out) would cost the user a
 * spawn and give them a dead lane back.
 */
import type { MachineAccount } from '@shared/machine-settings'
import type { ClaudeAccountView } from '@shared/models'

export interface MoveTarget {
  id: string
  label: string
  /** Held back from NEW sessions — still selectable, because a hold is advisory. */
  held: boolean
}

/**
 * Where this lane may go, best first.
 *
 * A held account stays in the list rather than being hidden: cooldowns come
 * from a cached `/usage` reading, so "held" is as likely to be stale as it is
 * to be true, and the user watching a stuck lane knows more than the cache
 * does. It sorts last and the UI says so.
 */
export function moveTargets(
  views: ClaudeAccountView[],
  currentAccountId: string | undefined,
  nowMs: number = Date.now(),
): MoveTarget[] {
  return views
    .filter((view) => view.account.id !== currentAccountId && view.auth.loggedIn !== false)
    .map((view) => ({
      id: view.account.id,
      label: view.auth.email ?? view.account.email ?? view.account.label,
      held: view.cooldownUntil !== null && view.cooldownUntil > nowMs,
    }))
    .sort((a, b) => Number(a.held) - Number(b.held))
}

/**
 * The same rule for a Host lane, over the Host's account list. The lane's own
 * account is the one that lists it among its lanes.
 */
export function machineMoveTargets(
  accounts: MachineAccount[],
  laneId: string,
  nowMs: number = Date.now(),
): MoveTarget[] {
  return accounts
    .filter((a) => a.loggedIn !== false && !a.lanes.some((lane) => lane.id === laneId))
    .map((a) => ({
      id: a.id,
      label: a.email ?? a.label,
      held: a.cooldownUntil !== null && a.cooldownUntil > nowMs,
    }))
    .sort((a, b) => Number(a.held) - Number(b.held))
}
