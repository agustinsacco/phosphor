import { describe, expect, it } from 'vitest'
import type { ClaudeAccountView } from '@shared/models'
import type { MachineAccount } from '@shared/machine-settings'
import {
  laneAccountId,
  machineCandidate,
  moveTargets as moveTargetsOf,
  viewCandidate,
} from './claudeGateway'

const moveTargets = (views: ClaudeAccountView[], current: string | undefined, now: number) =>
  moveTargetsOf(views.map(viewCandidate), current, now)

const NOW = 1_700_000_000_000

function view(
  id: string,
  overrides: Partial<ClaudeAccountView> & { email?: string } = {},
): ClaudeAccountView {
  const { email, ...rest } = overrides
  return {
    account: {
      id,
      label: id,
      ...(email ? { email } : {}),
      credentialDir: null,
      addedAt: 0,
    },
    auth: { ok: true, loggedIn: true },
    usage: null,
    cooldownUntil: null,
    ...rest,
  }
}

describe('moveTargets', () => {
  it('offers every other signed-in account, free ones first', () => {
    const targets = moveTargets(
      [
        view('a'),
        view('b', { cooldownUntil: NOW + 60_000 }),
        view('c', { email: 'c@example.com' }),
      ],
      'a',
      NOW,
    )
    expect(targets.map((t) => t.id)).toEqual(['c', 'b'])
    expect(targets[0]).toEqual({ id: 'c', label: 'c@example.com', held: false })
    expect(targets[1]?.held).toBe(true)
  })

  it('drops an account the CLI reports signed out, but keeps one it could not check', () => {
    const targets = moveTargets(
      [
        view('a'),
        view('b', { auth: { ok: true, loggedIn: false } }),
        view('c', { auth: { ok: false, error: 'status check failed' } }),
      ],
      'a',
      NOW,
    )
    expect(targets.map((t) => t.id)).toEqual(['c'])
  })

  it('treats an expired cooldown as free', () => {
    const [target] = moveTargets([view('a'), view('b', { cooldownUntil: NOW - 1 })], 'a', NOW)
    expect(target?.held).toBe(false)
  })

  it('returns every account when the lane has none yet', () => {
    expect(moveTargets([view('a'), view('b')], undefined, NOW).map((t) => t.id)).toEqual(['a', 'b'])
  })
})

describe('machineCandidate', () => {
  const account = (id: string, overrides: Partial<MachineAccount> = {}): MachineAccount => ({
    id,
    label: id,
    loggedIn: true,
    cooldownUntil: null,
    usage: null,
    lanes: [],
    ...overrides,
  })

  it('offers a Host account whose sign-in could not be checked, as This Mac does', () => {
    const accounts = [
      account('a', { lanes: [{ id: 'lane', title: 'Lane', active: true }] }),
      account('b', { loggedIn: null, email: 'b@example.com' }),
      account('c', { loggedIn: false }),
    ]
    const targets = moveTargetsOf(
      accounts.map(machineCandidate),
      laneAccountId(accounts, 'lane'),
      NOW,
    )
    expect(targets).toEqual([{ id: 'b', label: 'b@example.com', held: false }])
  })
})
