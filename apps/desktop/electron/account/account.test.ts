import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccount, EARLY_MS, type AccountPorts, type AccountState } from './account'
import { AuthRefused, AuthUnavailable, createGoTrue, type AuthSession, type GoTrue } from './gotrue'
import { createVault, type Vault } from './vault'
import { deferred, fakeBrowser, fakeCipher, session, USER } from './__fixtures__/fakes'

let root: string
let logs: string[]
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'phx-account-'))
  logs = []
})
afterEach(() => {
  // Whatever happened, no token or code ever reached the log.
  expect(logs.join('\n')).not.toMatch(/access-|refresh-|valid-code/)
  rmSync(root, { recursive: true, force: true })
})

type Overrides = Partial<Pick<GoTrue, 'exchange' | 'refresh' | 'revoke'>>

function auth(overrides: Overrides = {}) {
  const real = createGoTrue({ url: 'https://p.supabase.co', key: 'k' })
  return {
    authorizeUrl: vi.fn<GoTrue['authorizeUrl']>(real.authorizeUrl),
    exchange: vi.fn<GoTrue['exchange']>(overrides.exchange ?? (async () => session(1))),
    refresh: vi.fn<GoTrue['refresh']>(overrides.refresh ?? (async () => session(1))),
    revoke: vi.fn<GoTrue['revoke']>(overrides.revoke ?? (async () => {})),
  }
}

interface Options extends Partial<Omit<AccountPorts, 'auth'>> {
  auth?: ReturnType<typeof auth>
  browser?: ReturnType<typeof fakeBrowser>
}

function setup(options: Options = {}) {
  const cipher = fakeCipher()
  const vault: Vault = options.vault ?? createVault(join(root, 'account'), cipher.cipher)
  const browser = options.browser ?? fakeBrowser()
  const states: AccountState['status'][] = []
  const ports = {
    auth: options.auth ?? auth(),
    vault,
    openExternal: options.openExternal ?? browser.open,
    onChange: (state: AccountState) => {
      states.push(state.status)
      options.onChange?.(state)
    },
    log: (message: string) => logs.push(message),
    ...(options.now ? { now: options.now } : {}),
    ...(options.callbackMs ? { callbackMs: options.callbackMs } : {}),
  }
  return { account: createAccount(ports), ports, vault, browser, states, cipher }
}

/** A vault holding a remembered sign-in from an earlier run. */
function remembered() {
  const cipher = fakeCipher()
  const vault = createVault(join(root, 'account'), cipher.cipher)
  vault.save(USER, 'refresh-0')
  cipher.state.decrypts = 0
  return { vault, cipher }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(check()).toBe(true)
}

describe('signing in', () => {
  it('goes through the browser with PKCE and remembers the session', async () => {
    const { account, ports, vault, browser, states } = setup()
    const state = await account.signIn()
    expect(state).toEqual({ status: 'signed-in', user: USER, remembered: true })
    expect(states).toEqual(['signing-in', 'signed-in'])

    const challenge = browser.opened[0]!.searchParams.get('code_challenge')
    const [code, verifier] = ports.auth.exchange.mock.calls[0]!
    expect(code).toBe('valid-code-1')
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge)
    expect(vault.readProfile()).toEqual(USER)
    expect(vault.readToken(USER.id)).toBe('refresh-1')
    const page = await browser.pages[0]!
    expect(page.body).toContain('Signed in as @octo')
  })

  it('joins a sign-in already running instead of opening a second tab', async () => {
    const { account, browser } = setup()
    const [a, b] = [account.signIn(), account.signIn()]
    expect(a).toBe(b)
    await a
    expect(browser.opened).toHaveLength(1)
  })

  it("signs out with GitHub's reason when the person says no", async () => {
    const browser = fakeBrowser(() => 'error=access_denied&error_description=The+user+said+no')
    const { account, ports } = setup({ browser })
    expect(await account.signIn()).toEqual({
      status: 'signed-out',
      error: 'GitHub sign-in did not finish: The user said no',
    })
    expect(ports.auth.exchange).not.toHaveBeenCalled()
    expect((await browser.pages[0]!).body).toContain('Sign-in cancelled')
  })

  it('times out when the browser never comes back', async () => {
    const { account } = setup({ browser: fakeBrowser(() => null), callbackMs: 40 })
    expect(await account.signIn()).toEqual({
      status: 'signed-out',
      error: 'Sign-in timed out. Try again.',
    })
  })

  it('reports a browser that will not open, or a refused exchange', async () => {
    const openExternal = vi.fn(async () => {
      throw new Error('no browser')
    })
    expect(await setup({ openExternal }).account.signIn()).toEqual({
      status: 'signed-out',
      error: 'Sign-in failed: no browser',
    })
    const exchange = vi.fn(async () => {
      throw new AuthRefused(400, 'bad_code_verifier', 'code challenge does not match')
    })
    const { account, browser } = setup({ auth: auth({ exchange }) })
    expect(await account.signIn()).toMatchObject({ error: expect.stringMatching(/does not match/) })
    expect((await browser.pages[0]!).body).toContain('Sign-in failed')
  })

  it('cancels at once, and a new sign-in can start straight away', async () => {
    const { account, browser, states } = setup({ browser: fakeBrowser(() => null) })
    const first = account.signIn()
    await until(() => browser.opened.length === 1)
    account.cancel()
    expect(account.state()).toEqual({ status: 'signed-out' })
    expect(await first).toEqual({ status: 'signed-out' })
    void account.signIn()
    await until(() => browser.opened.length === 2)
    expect(browser.opened[1]!.searchParams.get('redirect_to')).not.toBe(
      browser.opened[0]!.searchParams.get('redirect_to'),
    )
    expect(states).toEqual(['signing-in', 'signed-out', 'signing-in'])
    account.cancel()
  })

  it('opens no tab for a sign-in cancelled before its listener was up', async () => {
    const { account, browser } = setup({ browser: fakeBrowser(() => null) })
    void account.signIn()
    account.cancel()
    void account.signIn()
    await until(() => browser.opened.length === 1)
    await new Promise((r) => setTimeout(r, 30))
    expect(browser.opened).toHaveLength(1)
    account.cancel()
  })

  it('starts a fresh sign-in straight after a cancel, without joining the old one', async () => {
    const { account, browser } = setup({ browser: fakeBrowser(() => null) })
    const first = account.signIn()
    await until(() => browser.opened.length === 1)
    account.cancel()
    const second = account.signIn()
    expect(second).not.toBe(first)
    expect(account.state()).toEqual({ status: 'signing-in' })
    await until(() => browser.opened.length === 2)
    account.cancel()
    expect(await second).toEqual({ status: 'signed-out' })
  })

  it('finishes an exchange a cancel overtook, then revokes what it brought', async () => {
    // Like the real client, this exchange dies if it is handed a signal that aborts.
    const late = deferred<AuthSession>()
    const exchange = vi.fn<GoTrue['exchange']>(
      (_code, _verifier, signal) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason))
          void late.promise.then(resolve)
        }),
    )
    const ports = auth({ exchange })
    const { account, vault, browser } = setup({ auth: ports })
    const flow = account.signIn()
    await until(() => exchange.mock.calls.length === 1)
    account.cancel()
    // The tab hears at once, not when Supabase answers.
    expect((await browser.pages[0]!).body).toContain('Sign-in cancelled')
    late.resolve(session(1))
    expect(await flow).toEqual({ status: 'signed-out' })
    await until(() => ports.revoke.mock.calls.length === 1)
    expect(ports.revoke.mock.calls[0]![0]).toBe('access-1')
    expect(vault.readProfile()).toBeNull()
    expect(account.state()).toEqual({ status: 'signed-out' })
  })

  it('says why Supabase refused when it gives only a code', async () => {
    const browser = fakeBrowser(() => 'error=access_denied&error_code=signup_disabled')
    const { account } = setup({ browser })
    expect(await account.signIn()).toEqual({
      status: 'signed-out',
      error: 'GitHub sign-in did not finish: signup_disabled',
    })
  })

  it('holds the session in memory only when the OS has no secure storage', async () => {
    const cipher = fakeCipher({ ok: false, reason: 'no keyring' })
    const vault = createVault(join(root, 'account'), cipher.cipher)
    const { account } = setup({ vault })
    expect(await account.signIn()).toEqual({ status: 'signed-in', user: USER, remembered: false })
    expect(readdirSync(root)).toEqual([])
    expect(await account.accessToken()).toBe('access-1')
  })
})

describe('a remembered session', () => {
  it('loads at startup from the profile alone: no network, no keychain', () => {
    const { vault, cipher } = remembered()
    const { account, ports } = setup({ vault })
    expect(account.load()).toEqual({ status: 'signed-in', user: USER, remembered: true })
    expect(ports.auth.refresh).not.toHaveBeenCalled()
    expect(cipher.state.decrypts).toBe(0)
    const nobody = createVault(join(root, 'nobody'), fakeCipher().cipher)
    expect(setup({ vault: nobody }).account.load()).toEqual({ status: 'signed-out' })
  })

  it('refreshes once for concurrent callers and keeps the rotated token', async () => {
    const { vault, cipher } = remembered()
    const gate = deferred<AuthSession>()
    const ports = auth({ refresh: vi.fn(() => gate.promise) })
    const { account } = setup({ vault, auth: ports })
    account.load()
    const tokens = [account.accessToken(), account.accessToken(), account.accessToken()]
    gate.resolve(session(1))
    expect(await Promise.all(tokens)).toEqual(['access-1', 'access-1', 'access-1'])
    expect(ports.refresh).toHaveBeenCalledTimes(1)
    expect(ports.refresh.mock.calls[0]![0]).toBe('refresh-0')
    expect(vault.readToken(USER.id)).toBe('refresh-1')
    expect(cipher.state.decrypts).toBe(2) // the read for the refresh, and the check above
  })

  it('uses the access token until shortly before it expires', async () => {
    let clock = 1_000_000
    const ports = auth({ exchange: vi.fn(async () => session(1, clock + 3_600_000)) })
    const { account } = setup({ auth: ports, now: () => clock })
    await account.signIn()
    clock += 3_600_000 - EARLY_MS - 1
    expect(await account.accessToken()).toBe('access-1')
    expect(ports.refresh).not.toHaveBeenCalled()
    clock += 2
    ports.refresh.mockResolvedValueOnce(session(2, clock + 3_600_000))
    expect(await account.accessToken()).toBe('access-2')
    expect(ports.refresh.mock.calls[0]![0]).toBe('refresh-1')
  })

  it('ends when Supabase refuses the refresh', async () => {
    const { vault } = remembered()
    const refresh = vi.fn(async () => {
      throw new AuthRefused(400, 'refresh_token_already_used', 'Invalid Refresh Token')
    })
    const { account } = setup({ vault, auth: auth({ refresh }) })
    account.load()
    expect(await account.accessToken()).toBeNull()
    expect(account.state()).toEqual({
      status: 'signed-out',
      error: 'Your Phosphor session ended. Sign in again.',
    })
    expect(vault.readProfile()).toBeNull()
  })

  it('survives Supabase being unreachable', async () => {
    const { vault } = remembered()
    const refresh = vi.fn(async () => {
      throw new AuthUnavailable('Supabase did not answer: fetch failed')
    })
    const { account } = setup({ vault, auth: auth({ refresh }) })
    account.load()
    await expect(account.accessToken()).rejects.toBeInstanceOf(AuthUnavailable)
    expect(account.state()).toMatchObject({ status: 'signed-in', remembered: true })
    expect(vault.readToken(USER.id)).toBe('refresh-0')
  })

  it('ends when the saved token cannot be read', async () => {
    const { vault, cipher } = remembered()
    cipher.state.storage = { ok: false, reason: 'no keyring' }
    const { account, ports } = setup({ vault })
    account.load()
    expect(await account.accessToken()).toBeNull()
    expect(account.state()).toEqual({
      status: 'signed-out',
      error: 'The saved sign-in could not be read (no keyring). Sign in again.',
    })
    expect(ports.auth.refresh).not.toHaveBeenCalled()
  })
})

describe('signing out', () => {
  it('wins over a refresh in flight: the late session is revoked, never kept', async () => {
    const { vault } = remembered()
    const gate = deferred<AuthSession>()
    const ports = auth({ refresh: vi.fn(() => gate.promise) })
    const { account, states } = setup({ vault, auth: ports })
    account.load()
    const token = account.accessToken()
    await until(() => ports.refresh.mock.calls.length === 1)
    expect(await account.signOut()).toEqual({ status: 'signed-out' })
    expect(vault.readProfile()).toBeNull()
    gate.resolve(session(1))
    expect(await token).toBeNull()
    await until(() => ports.revoke.mock.calls.length === 1)
    await new Promise((r) => setTimeout(r, 20))
    // The refresh owned the revocation: sign-out neither refreshed nor revoked again.
    expect(ports.revoke.mock.calls.map(([revoked]) => revoked)).toEqual(['access-1'])
    expect(ports.refresh).toHaveBeenCalledTimes(1)
    expect(account.state()).toEqual({ status: 'signed-out' })
    expect(vault.readProfile()).toBeNull()
    expect(states).toEqual(['signed-in', 'signed-out'])
  })

  it('revokes a refresh that landed just before it, and hands that token to nobody', async () => {
    const { vault } = remembered()
    let loaded = false
    let out: Promise<AccountState> | null = null
    const made = setup({
      vault,
      // Runs inside the refresh, right after it kept the new session and
      // before its promise settles: the narrowest window there is.
      onChange: (state) => {
        if (loaded && state.status === 'signed-in' && !out) out = made.account.signOut()
      },
    })
    const { account } = made
    account.load()
    loaded = true
    expect(await account.accessToken()).toBeNull()
    expect(await out).toEqual({ status: 'signed-out' })
    expect(made.ports.auth.revoke.mock.calls.map(([token]) => token)).toEqual(['access-1'])
    expect(made.ports.auth.refresh).toHaveBeenCalledTimes(1)
    expect(vault.readProfile()).toBeNull()
  })

  it('revokes with the fresh access token it holds', async () => {
    const { account, ports, vault } = setup()
    await account.signIn()
    expect(await account.signOut()).toEqual({ status: 'signed-out' })
    expect(ports.auth.revoke).toHaveBeenCalledWith('access-1', expect.any(AbortSignal))
    expect(ports.auth.refresh).not.toHaveBeenCalled()
    expect(vault.readProfile()).toBeNull()
  })

  it('after a restart, refreshes once to get a token to revoke with', async () => {
    const { vault } = remembered()
    const { account, ports } = setup({ vault })
    account.load()
    await account.signOut()
    expect(ports.auth.refresh.mock.calls[0]![0]).toBe('refresh-0')
    expect(ports.auth.revoke.mock.calls[0]![0]).toBe('access-1')
    expect(vault.readProfile()).toBeNull()
  })

  it('signs out locally even when the server cannot be told', async () => {
    const revoke = vi.fn(async () => {
      throw new AuthUnavailable('Supabase did not answer: fetch failed')
    })
    const { account, vault } = setup({ auth: auth({ revoke }) })
    await account.signIn()
    expect(await account.signOut()).toEqual({ status: 'signed-out' })
    expect(vault.readProfile()).toBeNull()
    expect(logs.join('\n')).toMatch(/server session was not revoked/)
  })

  it('says so when the saved sign-in could not be deleted', async () => {
    const real = createVault(join(root, 'account'), fakeCipher().cipher)
    const vault: Vault = {
      ...real,
      clear: () => {
        real.clear()
        throw new Error('could not delete profile.json (EBUSY)')
      },
    }
    const { account } = setup({ vault })
    await account.signIn()
    expect(await account.signOut()).toEqual({
      status: 'signed-out',
      error:
        'Signed out, but: The saved sign-in could not be deleted (could not delete profile.json (EBUSY)).',
    })
  })

  it('stops a sign-in that is still waiting on the browser', async () => {
    const { account, browser, ports } = setup({ browser: fakeBrowser(() => null) })
    const flow = account.signIn()
    await until(() => browser.opened.length === 1)
    expect(await account.signOut()).toEqual({ status: 'signed-out' })
    expect(await flow).toEqual({ status: 'signed-out' })
    expect(ports.auth.revoke).not.toHaveBeenCalled()
  })
})
