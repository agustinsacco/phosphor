import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
import { checkClaudeLane, claudeUsageReader, parseLoggedIn } from './claude'
import type { probe } from './probe'

const provider = (version: string, installed = true) => ({
  name: '@saccolabs/pi-claude-cli',
  version,
  installed,
})
const STATUS = JSON.stringify({ loggedIn: true, email: 'person@example.com', orgName: 'Org' })

let machine: FakeMachine
afterEach(() => machine?.cleanup())

/** A fake `claude` answering --version and `auth status` from the given output. */
function claude(status: string, exit = 0, stderr = '') {
  machine = fakeMachine()
  machine.script(
    'claude',
    `case "$1" in
  --version) echo "2.1.283 (Claude Code)" ;;
  auth) echo 'notice: checking'; echo '${status}'; echo '${stderr}' >&2; exit ${exit} ;;
esac`,
  )
  return { env: { PATH: `${machine.bin}:/usr/bin:/bin`, HOME: machine.home }, secrets: [] }
}

describe('claude auth status', () => {
  it('reads only whether the CLI is logged in', () => {
    expect(parseLoggedIn(`warning\n${STATUS}`)).toBe(true)
    expect(parseLoggedIn('{"loggedIn": false}')).toBe(false)
    expect(parseLoggedIn('Logged in as someone')).toBeNull()
    expect(parseLoggedIn('{"loggedIn": "yes"}')).toBeNull()
    expect(parseLoggedIn('{broken')).toBeNull()
  })
})

describe('the Claude lane', () => {
  it('is available with the provider package and a logged-in claude, without its identity', async () => {
    const env = claude(STATUS)
    const lane = await checkClaudeLane([provider('0.10.0')], env)
    expect(lane).toEqual({
      available: true,
      claude: `${machine.bin}/claude`,
      version: '2.1.283',
    })
    expect(JSON.stringify(lane)).not.toContain('person@example.com')
  })

  it('needs the provider package at the version Desktop requires, before looking at claude', async () => {
    const env = claude(STATUS)
    expect(await checkClaudeLane([], env)).toEqual({
      available: false,
      reason:
        '@saccolabs/pi-claude-cli 0.10.0 or newer is needed (it is not installed): ' +
        'pi install npm:@saccolabs/pi-claude-cli',
    })
    expect(await checkClaudeLane([provider('0.9.1')], env)).toMatchObject({
      reason: expect.stringContaining('(found 0.9.1)'),
    })
  })

  it("needs claude on pi's PATH, logged in", async () => {
    const env = claude('{"loggedIn": false}', 1)
    expect(await checkClaudeLane([provider('0.10.0')], env)).toEqual({
      available: false,
      reason: 'claude is not logged in: phosphor providers login claude',
    })
    const bare = { env: { PATH: '/usr/bin:/bin' }, secrets: [] }
    expect(await checkClaudeLane([provider('0.10.0')], bare)).toEqual({
      available: false,
      reason: 'Claude Code is not installed: run phosphor setup',
    })
  })

  it('says so when the auth status cannot be read, from stderr alone', async () => {
    // One line of JSON with no boolean loggedIn: the email beside it must not come back.
    const unreadable = claude('{"loggedIn": "yes", "email": "person@example.com"}', 2)
    expect(await checkClaudeLane([provider('0.10.0')], unreadable)).toEqual({
      available: false,
      reason: `${machine.bin}/claude auth status was unreadable (exit 2)`,
    })
    machine.cleanup()
    const old = claude('', 1, 'error: unknown command "auth"')
    expect(await checkClaudeLane([provider('0.10.0')], old)).toEqual({
      available: false,
      reason: `${machine.bin}/claude auth status was unreadable (exit 1): error: unknown command "auth"`,
    })
  })
})

describe('the Host plan usage', () => {
  const env = { env: { PATH: '/nowhere' }, secrets: [] }
  const result = [
    'Current session: 12% used',
    'Current week (all models): 40% used',
    "What's contributing to your limits usage?",
    'Long sessions in /home/person/private',
  ].join('\n')
  const reply = (stdout: string, code = 0) =>
    vi.fn<typeof probe>(async () => ({
      code,
      signal: null,
      stdout,
      stderr: '',
      timedOut: false,
      truncated: false,
    }))

  it('runs claude -p /usage once a minute, drops the contributing text, and floors a refresh', async () => {
    const machine = claude(STATUS)
    const run = reply(JSON.stringify({ result }))
    const read = claudeUsageReader(run)
    const first = await read(machine, { nowMs: 1_000_000 })
    expect(first).toEqual({
      ok: true,
      snapshot: {
        fetchedAt: 1_000_000,
        stale: false,
        contributing: null,
        windows: [
          { label: 'Current session', kind: 'five_hour', percentUsed: 12, resetsAt: null },
          { label: 'Current week (all models)', kind: 'weekly', percentUsed: 40, resetsAt: null },
        ],
      },
    })
    expect(JSON.stringify(first)).not.toContain('private')
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual([
      `${machine.env.PATH.split(':')[0]}/claude`,
      ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
    ])
    await read(machine, { nowMs: 1_050_000 })
    await read(machine, { nowMs: 1_005_000, force: true })
    expect(run).toHaveBeenCalledTimes(1)
    await read(machine, { nowMs: 1_011_000, force: true })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('reports a missing CLI, a failed run and unparseable output without caching them', async () => {
    expect(await claudeUsageReader(reply(''))(env)).toEqual({
      ok: false,
      error: 'claude-not-found',
    })
    const machine = claude(STATUS)
    const failed = reply('', 1)
    const read = claudeUsageReader(failed)
    expect(await read(machine)).toEqual({ ok: false, error: 'run-failed' })
    expect(await read(machine)).toEqual({ ok: false, error: 'run-failed' })
    expect(failed).toHaveBeenCalledTimes(2)
    expect(await claudeUsageReader(reply('{"result":"Signed out"}'))(machine)).toEqual({
      ok: false,
      error: 'no-usage',
    })
  })
})
