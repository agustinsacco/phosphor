import { describe, expect, it } from 'vitest'
import type { ClaudeAccount, ClaudeAccountPrefs } from '@shared/models'
import {
  claudeAccountEnv,
  cooldownFromUsage,
  isCoolingDown,
  pruneCooldowns,
  reconcileAuthIdentity,
  selectAccount,
} from './routing'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

function account(id: string): ClaudeAccount {
  return { id, label: id, credentialDir: `/creds/${id}`, addedAt: 0 }
}

function prefs(over: Partial<ClaudeAccountPrefs> = {}): ClaudeAccountPrefs {
  return {
    accounts: [account('a'), account('b'), account('c')],
    mode: 'specific',
    cursor: 0,
    cooldowns: {},
    bindings: {},
    ...over,
  }
}

describe('selectAccount', () => {
  it('routes nowhere when no account is configured', () => {
    const result = selectAccount(prefs({ accounts: [] }), { nowMs: NOW })
    expect(result.account).toBeNull()
  })

  it('specific mode uses the pinned account', () => {
    const result = selectAccount(prefs({ mode: 'specific', pinnedId: 'c' }), { nowMs: NOW })
    expect(result.account?.id).toBe('c')
  })

  it('specific mode falls back to the first when the pin is stale', () => {
    const result = selectAccount(prefs({ mode: 'specific', pinnedId: 'gone' }), { nowMs: NOW })
    expect(result.account?.id).toBe('a')
  })

  it('ordered mode takes the top account', () => {
    expect(selectAccount(prefs({ mode: 'ordered' }), { nowMs: NOW }).account?.id).toBe('a')
  })

  it('ordered mode skips accounts on cooldown', () => {
    const result = selectAccount(
      prefs({ mode: 'ordered', cooldowns: { a: NOW + HOUR, b: NOW + HOUR } }),
      { nowMs: NOW },
    )
    expect(result.account?.id).toBe('c')
  })

  it('ordered mode ignores a cooldown that has already expired', () => {
    const result = selectAccount(prefs({ mode: 'ordered', cooldowns: { a: NOW - 1 } }), {
      nowMs: NOW,
    })
    expect(result.account?.id).toBe('a')
  })

  it('ordered mode still starts a session when everything is exhausted', () => {
    // Cooldowns come from a CACHED usage reading, so "all out" is as likely to
    // be stale data as truth. Refusing to spawn on that is the worse failure.
    const result = selectAccount(
      prefs({ mode: 'ordered', cooldowns: { a: NOW + HOUR, b: NOW + HOUR, c: NOW + HOUR } }),
      { nowMs: NOW },
    )
    expect(result.account?.id).toBe('a')
  })

  it('round robin hands out each account in turn and advances the cursor', () => {
    let cursor = 0
    const picks: string[] = []
    for (let i = 0; i < 4; i++) {
      const result = selectAccount(prefs({ mode: 'round-robin', cursor }), { nowMs: NOW })
      picks.push(result.account!.id)
      cursor = result.cursor
    }
    expect(picks).toEqual(['a', 'b', 'c', 'a'])
  })

  it('round robin skips a cooling account without stalling on it', () => {
    const first = selectAccount(
      prefs({ mode: 'round-robin', cursor: 0, cooldowns: { a: NOW + HOUR } }),
      { nowMs: NOW },
    )
    expect(first.account?.id).toBe('b')
    const second = selectAccount(
      prefs({ mode: 'round-robin', cursor: first.cursor, cooldowns: { a: NOW + HOUR } }),
      { nowMs: NOW },
    )
    expect(second.account?.id).toBe('c')
  })

  it('round robin tolerates a cursor left over from a longer list', () => {
    const result = selectAccount(prefs({ mode: 'round-robin', cursor: 9 }), { nowMs: NOW })
    expect(result.account?.id).toBe('a')
  })

  it('a bound session keeps its account, whatever the mode says', () => {
    const result = selectAccount(
      prefs({ mode: 'round-robin', cursor: 0, bindings: { '/s/one.jsonl': 'c' } }),
      { nowMs: NOW, sessionPath: '/s/one.jsonl' },
    )
    expect(result.account?.id).toBe('c')
    // The cursor must not move: a resume is not a new session's turn.
    expect(result.cursor).toBe(0)
  })

  it('a binding to a removed account falls back to the routing rule', () => {
    const result = selectAccount(prefs({ mode: 'ordered', bindings: { '/s/one.jsonl': 'gone' } }), {
      nowMs: NOW,
      sessionPath: '/s/one.jsonl',
    })
    expect(result.account?.id).toBe('a')
  })
})

describe('isCoolingDown', () => {
  it('is false for an unknown account', () => {
    expect(isCoolingDown({ cooldowns: {} }, 'a', NOW)).toBe(false)
  })

  it('is false the instant the window resets', () => {
    expect(isCoolingDown({ cooldowns: { a: NOW } }, 'a', NOW)).toBe(false)
  })
})

describe('cooldownFromUsage', () => {
  it('is null below 100%', () => {
    expect(
      cooldownFromUsage([{ kind: 'five_hour', percentUsed: 99, resetsAt: NOW + HOUR }], NOW),
    ).toBeNull()
  })

  it('returns the 5-hour reset once the window is full', () => {
    expect(
      cooldownFromUsage([{ kind: 'five_hour', percentUsed: 100, resetsAt: NOW + HOUR }], NOW),
    ).toBe(NOW + HOUR)
  })

  it('holds one window when the reset stamp did not parse', () => {
    expect(cooldownFromUsage([{ kind: 'five_hour', percentUsed: 100, resetsAt: null }], NOW)).toBe(
      NOW + 5 * HOUR,
    )
  })

  it('ignores a full weekly window', () => {
    // A weekly reset is days out; skipping an account that long on one cached
    // reading is not a call pidex makes silently.
    expect(
      cooldownFromUsage([{ kind: 'weekly', percentUsed: 100, resetsAt: NOW + 48 * HOUR }], NOW),
    ).toBeNull()
  })

  it('is null when the parsed reset is already in the past', () => {
    expect(
      cooldownFromUsage([{ kind: 'five_hour', percentUsed: 100, resetsAt: NOW - 1 }], NOW),
    ).toBeNull()
  })
})

describe('pruneCooldowns', () => {
  it('drops expired entries and accounts that no longer exist', () => {
    const kept = pruneCooldowns(
      { a: NOW + HOUR, b: NOW - HOUR, gone: NOW + HOUR },
      new Set(['a', 'b']),
      NOW,
    )
    expect(kept).toEqual({ a: NOW + HOUR })
  })
})

describe('claudeAccountEnv', () => {
  it('sets nothing for the default account', () => {
    // An UNSET variable is what selects the CLI's own keychain entry — the one
    // the user's terminal shares. Passing `~/.claude` explicitly would not be
    // equivalent: the CLI flips the hash suffix on as soon as the var exists.
    expect(claudeAccountEnv({ ...account('default'), credentialDir: null })).toEqual({})
    expect(claudeAccountEnv(null)).toEqual({})
  })

  it('scopes the keychain entry to the account directory', () => {
    expect(claudeAccountEnv(account('work'))).toEqual({
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/creds/work',
    })
  })

  it('pins the org so a shared ~/.claude.json cannot mismatch the token', () => {
    expect(claudeAccountEnv({ ...account('work'), orgId: 'org-1' })).toEqual({
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/creds/work',
      CLAUDE_CODE_ORGANIZATION_UUID: 'org-1',
    })
  })
})

describe('reconcileAuthIdentity', () => {
  const other = { id: 'work', label: 'me@hotmail.com', email: 'me@hotmail.com' }

  it('keeps a live identity that belongs to this account', () => {
    const auth = { ok: true, loggedIn: true, email: 'ME@hotmail.com', plan: 'max' }
    expect(reconcileAuthIdentity({ ...account('work'), ...other }, auth)).toEqual(auth)
  })

  it('drops the shared ~/.claude.json identity leaking onto another row', () => {
    // `auth status` prints whichever account signed in LAST, for every row.
    expect(
      reconcileAuthIdentity(
        { ...account('work'), ...other },
        {
          ok: true,
          loggedIn: true,
          method: 'claude.ai',
          email: 'me@work.com',
          plan: 'team',
          organization: 'Acme',
          orgId: 'org-9',
        },
      ),
    ).toEqual({ ok: true, loggedIn: true, method: 'claude.ai' })
  })

  it('passes through when either side has no email to compare', () => {
    const auth = { ok: true, loggedIn: true, email: 'me@work.com' }
    expect(reconcileAuthIdentity(account('work'), auth)).toEqual(auth)
    expect(reconcileAuthIdentity({ ...account('work'), ...other }, { ok: false })).toEqual({
      ok: false,
    })
  })
})
