import { afterEach, describe, expect, it } from 'vitest'
import { releaseOrigin, type ReleaseOrigin } from '../test/__fixtures__/release-origin'
import {
  claimLease,
  holdsLease,
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  readState,
  recordState,
  releaseLease,
  RELEASE_REF,
  runner,
  writeState,
} from './release-lease'

const bee = { holder: 'bee2/one', host: 'bee2' }
const stark = { holder: 'stark/two', host: 'stark' }
const T = Date.parse('2026-11-02T12:00:00Z')
const events = (ledger: string[]) =>
  ledger.map((line) => (JSON.parse(line) as { text: string }).text)

let origin: ReleaseOrigin | undefined
afterEach(() => origin?.cleanup())

async function fresh() {
  origin = await releaseOrigin()
  return origin.git
}

describe('release lease on origin', () => {
  it('lets exactly one holder take a free lease, and reads it back from origin', async () => {
    const git = await fresh()
    const first = await claimLease(git, 'refs/test/a', bee, T)
    expect(first.role).toBe('active')
    expect(first.state.lease).toMatchObject({ holder: bee.holder, host: 'bee2', epoch: 1 })
    expect(events(first.state.ledger)).toEqual(['bee2 took the lease (epoch 1)'])

    const second = await claimLease(git, 'refs/test/b', stark, T + 1000)
    expect(second.role).toBe('standby')
    expect(second.state.lease?.holder).toBe(bee.holder)
    expect((await readState(git, 'refs/test/c')).lease?.expires).toBe(
      new Date(T + LEASE_TTL_MS).toISOString(),
    )
  })

  it('renews only once the lease is older than the renewal interval', async () => {
    const git = await fresh()
    const { state } = await claimLease(git, 'refs/test/a', bee, T)
    const early = await claimLease(git, 'refs/test/a', bee, T + LEASE_RENEW_MS - 1)
    expect(early.state.sha).toBe(state.sha)
    const late = await claimLease(git, 'refs/test/a', bee, T + LEASE_RENEW_MS + 1)
    expect(late.role).toBe('active')
    expect(late.state.lease?.epoch).toBe(1)
    expect((await readState(git, 'refs/test/a')).sha).not.toBe(state.sha)
  })

  it('bumps the epoch on a takeover and when a lapsed lease changes hands', async () => {
    const git = await fresh()
    await claimLease(git, 'refs/test/a', bee, T)
    const seized = await claimLease(git, 'refs/test/b', stark, T + 1000, true)
    expect(seized.role).toBe('active')
    expect(seized.state.lease?.epoch).toBe(2)
    expect(events(seized.state.ledger).at(-1)).toBe('stark took the lease over from bee2 (epoch 2)')
    expect((await claimLease(git, 'refs/test/a', bee, T + 2000)).role).toBe('standby')
    const lapsed = await claimLease(git, 'refs/test/a', bee, T + 1000 + LEASE_TTL_MS)
    expect(lapsed.state.lease?.epoch).toBe(3)
    expect(events(lapsed.state.ledger).at(-1)).toBe('bee2 took the lease (epoch 3)')
  })

  it('refuses a write over a commit the writer no longer holds', async () => {
    const git = await fresh()
    const { state } = await claimLease(git, 'refs/test/a', bee, T)
    await claimLease(git, 'refs/test/b', stark, T, true)
    const lease = { ...state.lease!, expires: new Date(T + LEASE_TTL_MS * 2).toISOString() }
    expect(await writeState(git, state.sha, { ...state, lease })).toBeNull()
    expect(await writeState(git, null, { ...state, lease })).toBeNull()
    expect((await readState(git, 'refs/test/a')).lease?.holder).toBe(stark.holder)
  })

  it('reports a refused push that is not a lost race', async () => {
    const git = await fresh()
    const { state } = await claimLease(git, 'refs/test/a', bee, T)
    await git(['remote', 'set-url', '--push', 'origin', '/nonexistent/origin.git'])
    await expect(writeState(git, state.sha, { ...state, lease: state.lease! })).rejects.toThrow(
      /git push failed/,
    )
  })

  it('records memory and events only for the holder, and renews on the way', async () => {
    const git = await fresh()
    await claimLease(git, 'refs/test/a', bee, T)
    expect(
      await recordState(git, 'refs/test/a', bee.holder, T + 60_000, {
        memory: '# Notes\nflaky: e2e/foo',
        event: 'merged #12 at abcdef1',
      }),
    ).toBe('ok')
    expect(await recordState(git, 'refs/test/b', stark.holder, T, { memory: 'x' })).toBe(
      'not-holder',
    )
    const state = await readState(git, 'refs/test/c')
    expect(state.memory).toBe('# Notes\nflaky: e2e/foo')
    expect(events(state.ledger).at(-1)).toBe('merged #12 at abcdef1')
    expect(state.lease?.expires).toBe(new Date(T + 60_000 + LEASE_TTL_MS).toISOString())
  })

  it('checks holder, epoch and expiry on origin before acting', async () => {
    const git = await fresh()
    await claimLease(git, 'refs/test/a', bee, T)
    expect(await holdsLease(git, 'refs/test/a', bee.holder, 1, T + 1)).toBe(true)
    expect(await holdsLease(git, 'refs/test/a', bee.holder, 2, T + 1)).toBe(false)
    expect(await holdsLease(git, 'refs/test/a', stark.holder, 1, T + 1)).toBe(false)
    expect(await holdsLease(git, 'refs/test/a', bee.holder, 1, T + LEASE_TTL_MS)).toBe(false)
  })

  it('hands the lease over at once on release, keeping the memory', async () => {
    const git = await fresh()
    await claimLease(git, 'refs/test/a', bee, T)
    await recordState(git, 'refs/test/a', bee.holder, T, { memory: 'keep me' })
    await releaseLease(git, 'refs/test/a', stark.holder, T) // Not the holder: no change.
    expect((await claimLease(git, 'refs/test/b', stark, T + 1)).role).toBe('standby')
    await releaseLease(git, 'refs/test/a', bee.holder, T + 2)
    const next = await claimLease(git, 'refs/test/b', stark, T + 3)
    expect(next.role).toBe('active')
    expect(next.state.memory).toBe('keep me')
    expect(events(next.state.ledger)).toContain('bee2 released the lease')
  })

  it('writes an orphan commit with three files and no history', async () => {
    const git = await fresh()
    await claimLease(git, 'refs/test/a', bee, T)
    await claimLease(git, 'refs/test/a', bee, T + LEASE_RENEW_MS + 1)
    await git(['fetch', '--quiet', 'origin', `+${RELEASE_REF}:refs/test/z`])
    expect((await git(['rev-list', '--count', 'refs/test/z'])).trim()).toBe('1')
    expect((await git(['ls-tree', '--name-only', 'refs/test/z'])).trim().split('\n')).toEqual([
      'lease.json',
      'ledger.jsonl',
      'memory.md',
    ])
  })
})

describe('runner', () => {
  it('feeds stdin and names the command that failed', async () => {
    const cat = runner('cat', process.cwd())
    expect(await cat([], 'piped')).toBe('piped')
    await expect(runner('git', process.cwd())(['no-such-command'])).rejects.toThrow(
      /^git no-such-command failed: /,
    )
  })
})
