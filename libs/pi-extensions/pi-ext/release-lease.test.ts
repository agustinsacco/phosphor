import { afterEach, describe, expect, it } from 'vitest'
import { releaseOrigin, type ReleaseOrigin } from '../test/__fixtures__/release-origin'
import {
  claimLease,
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  readState,
  recordState,
  releaseLease,
  RELEASE_REF,
  runner,
  writeState,
  type Claimant,
  type Run,
} from './release-lease'

const bee: Claimant = { holder: 'bee2/one', host: 'bee2', pid: process.pid }
const stark: Claimant = { holder: 'stark/two', host: 'stark', pid: process.pid }
/** Above any pid Linux or macOS hands out, so no process has it. */
const GONE = 2 ** 22 + 1
const T = Date.parse('2026-11-02T12:00:00Z')
const events = (ledger: string[]) =>
  ledger.map((line) => (JSON.parse(line) as { text: string }).text)

let origin: ReleaseOrigin | undefined
afterEach(() => origin?.cleanup())

async function fresh() {
  origin = await releaseOrigin()
  return origin.git
}

/** git, except that `meanwhile` runs just before the first push: another writer gets there first. */
function racing(git: Run, meanwhile: () => Promise<unknown>): Run {
  let pending: (() => Promise<unknown>) | undefined = meanwhile
  return async (args, input) => {
    if (args[0] === 'push' && pending) {
      const work = pending
      pending = undefined
      await work()
    }
    return git(args, input)
  }
}

/** git, except that every push is refused with this message. */
const refusing =
  (git: Run, message: string): Run =>
  (args, input) =>
    args[0] === 'push' ? Promise.reject(new Error(message)) : git(args, input)

const leaseFile = (extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ version: 1, ...bee, epoch: 4, expires: new Date(T + LEASE_TTL_MS).toISOString(), ...extra })}\n`

describe('release lease on origin', () => {
  it('lets exactly one holder take a free lease, and reads it back from origin', async () => {
    const git = await fresh()
    const first = await claimLease(git, 'refs/test/a', bee, T)
    expect(first.role).toBe('active')
    expect(first.state.lease).toMatchObject({ ...bee, epoch: 1 })
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

  it('gives the lease back to its session after a restart, never to a second live process', async () => {
    const git = await fresh()
    await claimLease(git, 'refs/test/a', { ...bee, pid: GONE }, T)
    const back = await claimLease(git, 'refs/test/a', bee, T + 1000)
    expect(back.role).toBe('active')
    expect(back.state.lease).toMatchObject({ ...bee, epoch: 2 })
    expect(events(back.state.ledger).at(-1)).toBe(
      'bee2 took the lease back after a restart (epoch 2)',
    )
    // The same session run by a second process, which is alive: it waits.
    const twin = { ...bee, pid: process.ppid }
    expect((await claimLease(git, 'refs/test/b', twin, T + 2000)).role).toBe('standby')
    expect(await recordState(git, 'refs/test/b', twin, 2, T + 2000, { memory: 'x' })).toBe(
      'not-holder',
    )
    expect((await readState(git, 'refs/test/c')).lease).toMatchObject({ ...bee, epoch: 2 })
  })

  it('reports who won after losing a race for the lease', async () => {
    const git = await fresh()
    await claimLease(git, 'refs/test/a', bee, T)
    const raced = racing(git, () => claimLease(git, 'refs/test/s', stark, T + 1000, true))
    const lost = await claimLease(
      raced,
      'refs/test/b',
      { ...bee, holder: 'bee2/three' },
      T + 1000,
      true,
    )
    expect(lost.role).toBe('standby')
    expect(lost.state.lease).toMatchObject({ holder: stark.holder, epoch: 2 })
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

  it('counts a ref update the server refused mid-race as lost, and anything else as a problem', async () => {
    const git = await fresh()
    const { state } = await claimLease(git, 'refs/test/a', bee, T)
    const next = { ...state, lease: state.lease! }
    const locked = refusing(
      git,
      "git push failed: ! [remote rejected] 1a2b -> refs/phosphor/release (cannot lock ref 'refs/phosphor/release': is at 3c4d but expected 5e6f)",
    )
    expect(await writeState(locked, state.sha, next)).toBeNull()
    const failed = refusing(
      git,
      'git push failed: ! [remote rejected] 1a2b -> refs/phosphor/release (failed to update ref)',
    )
    expect(await writeState(failed, state.sha, next)).toBeNull()
    const denied = refusing(git, 'git push failed: remote: Permission to a/b.git denied to bee.')
    await expect(writeState(denied, state.sha, next)).rejects.toThrow(/Permission/)
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
      await recordState(git, 'refs/test/a', bee, 1, T + 60_000, {
        memory: '# Notes\nflaky: e2e/foo',
        event: 'merged #12 at abcdef1',
      }),
    ).toBe('ok')
    expect(await recordState(git, 'refs/test/b', stark, 1, T, { memory: 'x' })).toBe('not-holder')
    const state = await readState(git, 'refs/test/c')
    expect(state.memory).toBe('# Notes\nflaky: e2e/foo')
    expect(events(state.ledger).at(-1)).toBe('merged #12 at abcdef1')
    expect(state.lease?.expires).toBe(new Date(T + 60_000 + LEASE_TTL_MS).toISOString())
  })

  it('records only under the epoch, process and term this lane holds', async () => {
    const git = await fresh()
    await claimLease(git, 'refs/test/a', bee, T)
    expect(await recordState(git, 'refs/test/a', bee, 2, T + 1, {})).toBe('not-holder')
    expect(await recordState(git, 'refs/test/a', { ...bee, pid: GONE }, 1, T + 1, {})).toBe(
      'not-holder',
    )
    expect(await recordState(git, 'refs/test/a', bee, 1, T + LEASE_TTL_MS, {})).toBe('not-holder')
    expect(await recordState(git, 'refs/test/a', bee, 1, T + 1, {})).toBe('ok')
  })

  it('retries a record once after losing a race to another write', async () => {
    const git = await fresh()
    await claimLease(git, 'refs/test/a', bee, T)
    const raced = racing(git, () =>
      recordState(git, 'refs/test/s', bee, 1, T + 1, { event: 'renewed meanwhile' }),
    )
    expect(await recordState(raced, 'refs/test/b', bee, 1, T + 2, { event: 'after' })).toBe('ok')
    expect(events((await readState(git, 'refs/test/c')).ledger).slice(-2)).toEqual([
      'renewed meanwhile',
      'after',
    ])
  })

  it('hands the lease over at once on release, keeping the memory', async () => {
    const git = await fresh()
    await claimLease(git, 'refs/test/a', bee, T)
    await recordState(git, 'refs/test/a', bee, 1, T, { memory: 'keep me' })
    await releaseLease(git, 'refs/test/a', stark, T) // Not the holder: no change.
    expect((await claimLease(git, 'refs/test/b', stark, T + 1)).role).toBe('standby')
    await releaseLease(git, 'refs/test/a', bee, T + 2)
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

  it('reads a ref with a file missing, a damaged lease or odd ledger lines', async () => {
    const git = await fresh()
    await origin!.release({ 'lease.json': leaseFile(), 'ledger.jsonl': 'not json\n' })
    expect(await readState(git, 'refs/test/a')).toMatchObject({
      lease: { holder: bee.holder, epoch: 4 },
      memory: '',
      ledger: ['not json'],
    })
    expect(await recordState(git, 'refs/test/a', bee, 4, T + 1, { event: 'still here' })).toBe('ok')
    expect((await readState(git, 'refs/test/a')).ledger[0]).toBe('not json')
    await origin!.release({ 'lease.json': '{"version":1,"holder":', 'memory.md': 'notes' })
    const damaged = await claimLease(git, 'refs/test/b', stark, T + 2)
    expect(damaged.role).toBe('active')
    expect(damaged.state.memory).toBe('notes')
  })

  it('fails the read, and takes nothing, when a file it lists cannot be read', async () => {
    const git = await fresh()
    await claimLease(git, 'refs/test/a', bee, T)
    const flaky: Run = (args, input) =>
      args[0] === 'cat-file'
        ? Promise.reject(new Error('git cat-file failed: Resource temporarily unavailable'))
        : git(args, input)
    await expect(claimLease(flaky, 'refs/test/b', stark, T + 1000)).rejects.toThrow(
      /temporarily unavailable/,
    )
    expect((await readState(git, 'refs/test/c')).lease).toMatchObject({ ...bee, epoch: 1 })
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

  it('says in plain words when a command is missing or gives no answer', async () => {
    await expect(runner('phosphor-no-such-tool', process.cwd())(['x'])).rejects.toThrow(
      'phosphor-no-such-tool is not installed, or not on PATH.',
    )
    const slow = runner(process.execPath, process.cwd(), 200)
    await expect(slow(['-e', 'setTimeout(() => {}, 10_000)'])).rejects.toThrow(
      /failed: no answer within 0\.2 seconds$/,
    )
  })
})
