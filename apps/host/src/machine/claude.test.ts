import { afterEach, describe, expect, it } from 'vitest'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
import { checkClaudeLane, parseLoggedIn } from './claude'

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
      reason: "claude is not on pi's PATH: add its folder to /environment/path",
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
