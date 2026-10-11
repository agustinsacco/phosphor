import { desktopElectronLaunchOptions } from '../../../tools/scripts/desktop-electron-launch.mjs'
import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { scratchDir } from './fixtures/scratch'
import { configureTestTeardown } from './fixtures/shutdown'

/**
 * Desktop's optional GitHub sign-in end to end, through the real main
 * process: a fake Supabase Auth served here, the system browser stubbed at
 * shell.openExternal, and this test walking the browser's last hop back to
 * Phosphor's loopback. 20-C adds the same flow against a real local GoTrue.
 */

const CODE = 'e2e-code-1234'
const SECRETS = ['e2e-access-1', 'e2e-refresh-1', 'gh-provider-secret', 'user-e2e-1']

interface Call {
  path: string
  body: Record<string, unknown> | null
  headers: IncomingHttpHeaders
}

async function fakeSupabase() {
  const calls: Call[] = []
  const state = { challenge: '' }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake')
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
      calls.push({ path: url.pathname + url.search, body, headers: req.headers })
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
        const verifier = String(body?.code_verifier ?? '')
        const proof = createHash('sha256').update(verifier).digest('base64url')
        if (body?.auth_code !== CODE || proof !== state.challenge) {
          return json(400, { code: 400, error_code: 'bad_code_verifier', msg: 'no match' })
        }
        return json(200, {
          access_token: SECRETS[0],
          refresh_token: SECRETS[1],
          expires_in: 3600,
          token_type: 'bearer',
          provider_token: SECRETS[2],
          user: {
            id: SECRETS[3],
            email: 'octo@example.com',
            user_metadata: { user_name: 'octo', full_name: 'Octo Cat' },
          },
        })
      }
      if (url.pathname === '/auth/v1/logout') {
        res.writeHead(204)
        return res.end()
      }
      json(404, { msg: 'not here' })
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, calls, state, close: () => new Promise((done) => server.close(done)) }
}

async function launch(supabaseUrl: string) {
  const scratch = await scratchDir('phosphor-account-')
  const workspace = join(scratch, 'workspace')
  const userData = join(scratch, 'prefs')
  await mkdir(workspace)
  await mkdir(userData)
  await writeFile(join(userData, 'config.json'), JSON.stringify({ lastWorkspacePath: workspace }))
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_ENV_ELECTRON_VITE
  delete env.ELECTRON_CLI_ARGS
  const app = await electron.launch({
    ...desktopElectronLaunchOptions([resolve(import.meta.dirname, '..')]),
    env: {
      ...env,
      NODE_ENV: 'production',
      PHOSPHOR_PI_STUB: resolve(import.meta.dirname, 'fixtures/pi-stub.cjs'),
      PHOSPHOR_TEST_USER_DATA: userData,
      PI_CODING_AGENT_DIR: join(scratch, 'agent'),
      PHOSPHOR_SUPABASE_URL: supabaseUrl,
      PHOSPHOR_SUPABASE_KEY: 'e2e-publishable-key',
      PHOSPHOR_ACCOUNT_NO_KEYCHAIN: '1',
    },
  })
  configureTestTeardown(app)
  // The real boundary, without launching anyone's browser.
  await app.evaluate(({ shell }) => {
    const state = globalThis as unknown as { openedUrls: string[] }
    state.openedUrls = []
    shell.openExternal = async (url) => {
      state.openedUrls.push(url)
    }
  })
  const page = await app.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  const opened = (): Promise<string[]> =>
    app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls)
  return {
    page,
    opened,
    userData,
    close: async () => {
      await app.close()
      await rm(scratch, { recursive: true, force: true })
    },
  }
}

/** The browser's last hop: GitHub and Supabase are done, back to Phosphor. */
async function returnFromBrowser(authorize: string, query: string): Promise<string> {
  const back = new URL(authorize).searchParams.get('redirect_to')
  const page = await fetch(`${back}?${query}`)
  return page.text()
}

async function tab(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click()
}

test('signs in with GitHub through Supabase and out again, never handing the renderer a token', async () => {
  const auth = await fakeSupabase()
  const h = await launch(auth.url)
  const { page } = h
  const section = page.locator('section', {
    has: page.getByRole('heading', { name: 'Phosphor account', exact: true }),
  })
  const signInButton = section.getByRole('button', { name: 'Sign in with GitHub' })
  const preview = page
    .locator('[data-setting-row]', { hasText: 'Phosphor account (preview)' })
    .getByRole('switch')
  const logouts = () => auth.calls.filter((call) => call.path === '/auth/v1/logout?scope=local')
  const setPreview = async (on: boolean) => {
    await tab(page, 'Advanced')
    await preview.click()
    await expect(preview).toHaveAttribute('aria-checked', String(on))
    await tab(page, 'Accounts')
  }
  /** Click sign in; the authorize URL the browser would have opened. */
  const startSignIn = async (nth: number): Promise<string> => {
    await signInButton.click()
    await expect(section.getByText('Waiting for you to finish in your browser.')).toBeVisible()
    await expect.poll(async () => (await h.opened()).length).toBe(nth)
    const authorize = (await h.opened())[nth - 1]!
    auth.state.challenge = new URL(authorize).searchParams.get('code_challenge')!
    return authorize
  }
  try {
    // Off by default: main refuses a sign-in, and a flag must be a boolean.
    await expect(page.evaluate(() => window.phosphor.invoke('account:signIn'))).rejects.toThrow(
      /turn it on in Settings/,
    )
    await expect(
      page.evaluate(() => window.phosphor.invoke('account:setPreview', 'yes' as never)),
    ).rejects.toThrow(/Invalid preview flag/)
    expect(await h.opened()).toEqual([])
    await page.getByRole('button', { name: 'Settings' }).click()
    await tab(page, 'Accounts')
    await expect(page.getByRole('heading', { name: 'Accounts', exact: true })).toBeVisible()
    await expect(section).toBeHidden()
    await setPreview(true)

    const first = await startSignIn(1)
    const authorize = new URL(first)
    expect(authorize.origin + authorize.pathname).toBe(`${auth.url}/auth/v1/authorize`)
    expect(authorize.searchParams.get('provider')).toBe('github')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('s256')
    expect(authorize.searchParams.get('redirect_to')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback\/[\w-]{22}$/,
    )
    expect(await returnFromBrowser(first, `code=${CODE}`)).toContain('Signed in as @octo')
    await expect(section.getByText('@octo')).toBeVisible()
    await expect(section.getByText('octo@example.com')).toBeVisible()
    // E2E keeps the keychain out, so the session lives in memory and says so.
    await expect(
      section.getByText('Until Phosphor quits: the keychain is off for this test run.'),
    ).toBeVisible()
    expect(existsSync(join(h.userData, 'account', 'session.bin'))).toBe(false)
    const exchange = auth.calls.find((call) => call.path === '/auth/v1/token?grant_type=pkce')
    expect(exchange?.headers.apikey).toBe('e2e-publishable-key')

    const seen = JSON.stringify(await page.evaluate(() => window.phosphor.invoke('account:get')))
    for (const secret of SECRETS) expect(seen).not.toContain(secret)

    await section.getByRole('button', { name: 'Sign out' }).click()
    await expect(signInButton).toBeVisible()
    expect(logouts().map((call) => call.headers.authorization)).toEqual([`Bearer ${SECRETS[0]}`])

    // Cancelled in Phosphor: back to signed out, the callback gone with it.
    const cancelled = await startSignIn(2)
    await section.getByRole('button', { name: 'Cancel' }).click()
    await expect(signInButton).toBeVisible()
    await expect(returnFromBrowser(cancelled, `code=${CODE}`)).rejects.toThrow()

    // A refusal in the browser comes back as Supabase's reason, not a session.
    const denied = await startSignIn(3)
    expect(await returnFromBrowser(denied, 'error=access_denied&error_description=Nope')).toContain(
      'Sign-in cancelled',
    )
    await expect(section.getByText('GitHub sign-in did not finish: Nope')).toBeVisible()

    // Turning the preview off signs a live session out first.
    expect(await returnFromBrowser(await startSignIn(4), `code=${CODE}`)).toContain('@octo')
    await expect(section.getByText('@octo')).toBeVisible()
    await setPreview(false)
    await expect(section).toBeHidden()
    expect(logouts()).toHaveLength(2)
    await setPreview(true)
    await expect(signInButton).toBeVisible()
  } finally {
    await h.close()
    await auth.close()
  }
})
