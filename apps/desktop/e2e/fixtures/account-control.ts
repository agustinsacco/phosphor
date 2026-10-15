import { desktopElectronLaunchOptions } from '../../../../tools/scripts/desktop-electron-launch.mjs'
import { expect, _electron as electron } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { join, resolve } from 'node:path'
import { MACHINE, LOOKUP } from '../../src/features/machines/__fixtures__/control'
import type { MachineView } from '../../../../libs/shared/src/control-api'
import { scratchDir } from './scratch'
import { configureTestTeardown } from './shutdown'

/** Disposable loopback-only Auth and directory. No keychain or hosted service. */
export async function accountControlFixture(
  initial: MachineView[] = [],
  options: {
    userId?: string
    env?: NodeJS.ProcessEnv
    route?: (req: IncomingMessage, res: ServerResponse, body: unknown) => boolean
  } = {},
) {
  const secrets = [
    randomBytes(32).toString('base64url'),
    randomBytes(32).toString('base64url'),
    randomBytes(32).toString('base64url'),
    options.userId ?? 'user-e2e-1',
  ]
  const calls: { path: string; body: unknown; headers: IncomingHttpHeaders }[] = []
  const state = {
    challenge: '',
    logoutDelayMs: 0,
    answered: [] as boolean[],
    machines: initial,
    approvedMachine: MACHINE,
  }
  const code = randomBytes(16).toString('hex')
  const server = createServer((req, res) => {
    let gone = false
    res.on('close', () => (gone ||= !res.writableFinished))
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString()
      if (raw.length > 16 * 1024) req.destroy()
    })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      let body: unknown
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      if (options.route?.(req, res, body)) return
      if (calls.length < 1000)
        calls.push({ path: url.pathname + url.search, body, headers: req.headers })
      const json = (status: number, value: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (
        url.pathname === '/auth/v1/token' &&
        typeof body === 'object' &&
        body !== null &&
        'code_verifier' in body &&
        'auth_code' in body
      ) {
        const proof = createHash('sha256').update(String(body.code_verifier)).digest('base64url')
        if (body.auth_code !== code || proof !== state.challenge)
          return json(400, { error_code: 'bad_code_verifier' })
        return json(200, {
          access_token: secrets[0],
          refresh_token: secrets[1],
          expires_in: 3600,
          provider_token: secrets[2],
          user: {
            id: secrets[3],
            email: 'octo@example.com',
            user_metadata: { user_name: 'octo', full_name: 'Octo Cat' },
          },
        })
      }
      if (url.pathname === '/auth/v1/logout') {
        setTimeout(() => {
          state.answered.push(!gone && !req.socket.destroyed)
          res.writeHead(204)
          res.end()
        }, state.logoutDelayMs)
        return
      }
      if (req.headers.authorization !== `Bearer ${secrets[0]}`)
        return json(401, { error: { code: 'unauthenticated', message: 'Sign in.' } })
      if (url.pathname === '/api/v1/me')
        return json(200, { account: { login: 'octo' }, enabled: true, maxHosts: 20 })
      if (url.pathname === '/api/v1/machines')
        return json(200, { machines: state.machines, serverTime: new Date().toISOString() })
      if (url.pathname === '/api/v1/enrollments/lookup') {
        if (
          typeof body !== 'object' ||
          body === null ||
          !('userCode' in body) ||
          body.userCode !== 'BCDFGHJK'
        )
          return json(404, { error: { code: 'not-found', message: 'Not found.' } })
        return json(200, { ...LOOKUP, expiresAt: new Date(Date.now() + 600000).toISOString() })
      }
      if (
        url.pathname === '/api/v1/enrollments/approve' &&
        typeof body === 'object' &&
        body !== null &&
        'label' in body &&
        typeof body.label === 'string'
      ) {
        const machine = { ...state.approvedMachine, label: body.label }
        state.machines = [machine]
        return json(200, { machine })
      }
      const machine = state.machines.find(
        (entry) => url.pathname === `/api/v1/machines/${entry.id}`,
      )
      if (
        machine &&
        req.method === 'PATCH' &&
        typeof body === 'object' &&
        body !== null &&
        'label' in body &&
        typeof body.label === 'string'
      ) {
        const updated = { ...machine, label: body.label }
        state.machines = state.machines.map((entry) => (entry.id === updated.id ? updated : entry))
        return json(200, { machine: updated })
      }
      if (machine && req.method === 'DELETE') {
        state.machines = state.machines.filter((entry) => entry.id !== machine.id)
        res.writeHead(204)
        res.end()
        return
      }
      json(404, { error: { code: 'not-found', message: 'Not found.' } })
    })
  })
  // Each resource registers its own cleanup as it is made, so a failed setup leaks nothing.
  const cleanups: (() => Promise<unknown>)[] = []
  const release = async (): Promise<void> => {
    const errors: unknown[] = []
    for (const step of cleanups.splice(0).reverse()) await step().catch((e) => errors.push(e))
    if (errors.length > 0) throw errors[0]
  }
  const guard = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step()
    } catch (error) {
      await release().catch(() => {})
      throw error
    }
  }
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  const url = `http://127.0.0.1:${address.port}`
  const scratch = await guard(() => scratchDir('phosphor-account-control-'))
  cleanups.push(() => rm(scratch, { recursive: true, force: true }))
  const workspace = join(scratch, 'workspace')
  const userData = join(scratch, 'prefs')
  const { app, page } = await guard(() => launch())
  async function launch() {
    await mkdir(workspace)
    await mkdir(userData)
    await writeFile(
      join(userData, 'config.json'),
      JSON.stringify({
        lastWorkspacePath: workspace,
        accountPreview: false,
        machinesPreview: false,
      }),
    )
    const env = { ...process.env }
    delete env.ELECTRON_RENDERER_URL
    delete env.NODE_ENV_ELECTRON_VITE
    delete env.ELECTRON_CLI_ARGS
    const app = await electron.launch({
      ...desktopElectronLaunchOptions([resolve(import.meta.dirname, '../..')]),
      env: {
        ...env,
        NODE_ENV: 'production',
        PHOSPHOR_PI_STUB: resolve(import.meta.dirname, 'pi-stub.cjs'),
        PHOSPHOR_TEST_USER_DATA: userData,
        PI_CODING_AGENT_DIR: join(scratch, 'agent'),
        PHOSPHOR_SUPABASE_URL: url,
        PHOSPHOR_SUPABASE_KEY: 'e2e-publishable-key',
        PHOSPHOR_CONTROL_URL: url,
        PHOSPHOR_ACCOUNT_NO_KEYCHAIN: '1',
        ...options.env,
      },
    })
    configureTestTeardown(app)
    cleanups.push(() => app.close())
    await app.evaluate(({ shell }) => {
      const openedUrls: string[] = []
      Object.assign(globalThis, { openedUrls })
      shell.openExternal = async (url) => {
        openedUrls.push(url)
      }
    })
    const page = await app.firstWindow()
    await expect(page.getByTestId('app-shell')).toBeVisible()
    return { app, page }
  }
  const opened = (): Promise<string[]> =>
    app.evaluate(() =>
      'openedUrls' in globalThis && Array.isArray(globalThis.openedUrls)
        ? globalThis.openedUrls.filter((value): value is string => typeof value === 'string')
        : [],
    )
  const startSignIn = async (): Promise<string> => {
    const count = (await opened()).length
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
    await expect(page.getByTestId('account-footer')).toContainText('Finish in your browser')
    await expect.poll(async () => (await opened()).length).toBe(count + 1)
    const authorize = (await opened())[count]
    if (!authorize) throw new Error('Missing authorize URL')
    state.challenge = new URL(authorize).searchParams.get('code_challenge') ?? ''
    return authorize
  }
  const returnFromBrowser = async (authorize: string, query = `code=${code}`): Promise<string> => {
    const back = new URL(authorize).searchParams.get('redirect_to')
    if (!back) throw new Error('Missing callback URL')
    return (await fetch(`${back}?${query}`)).text()
  }
  const signIn = async (): Promise<void> => {
    await returnFromBrowser(await startSignIn())
    await expect(page.getByRole('button', { name: 'Your account' })).toBeVisible()
  }
  let closed = false
  return {
    page,
    calls,
    secrets,
    state,
    userData,
    url,
    opened,
    startSignIn,
    returnFromBrowser,
    signIn,
    close: async () => {
      if (closed) return
      closed = true
      await release()
    },
  }
}
