import { expect, test as base } from '@playwright/test'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { connect, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { directoryRpc } from './fixture-directory'
import { startCliFixtureHost } from './cli-fixture-host'
import { createApp, type AppDeps } from '../../control/src/app'
import { parseConfig } from '../../control/src/config'
import { ControlFailure } from '../../control/src/http'
import { RateLimiter, RATE_PURPOSE_CAPACITIES } from '../../control/src/limits'
import { formatKeyFingerprint, type MachineView } from '@phosphor/shared/control-api'
import { evidence } from '../playwright.config'
import { startBrainFixtureHost, type BrainFixtureHost } from './brain-host'

const project = resolve(import.meta.dirname, '../../..')
const endpoint = 'https://fixture.ts.net'
/** A stopped Host's children can still be releasing state files; rm retries ENOTEMPTY. */
const removeRoot = (root: string) =>
  rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
/**
 * A new root under the real temp path: macOS's tmpdir() is under the /var symlink, and a
 * Host refuses to land a moved lane under a symlinked folder.
 */
const createRoot = async () => mkdtemp(join(await realpath(tmpdir()), 'phosphor-web-'))

/** The production stack runs no Host, so it seeds no lanes. */
const UNSEEDED = {
  askToPurge: async (_id: string, _reason: string): Promise<string> => {
    throw Error('No fixture Host')
  },
  laneId: '',
  secondLaneId: '',
  repository: '',
}

type Clients = Map<string, { owner: string; revoked: boolean }>
type WebSessions = Map<string, { owner: string; clientId: string }>
/** Browser sessions as the control_web_session_* RPCs keep them, keyed by handle hash. */
function webSessionRpc(
  db: { clients: Clients; sessions: WebSessions; owner: string; sid: string },
  name: string,
  args: Record<string, unknown>,
) {
  const hash = String(args.p_handle_hash)
  const session = db.sessions.get(hash)
  if (name === 'control_web_session_create') {
    const clientId = randomUUID()
    db.clients.set(clientId, { owner: String(args.p_user), revoked: false })
    db.sessions.set(hash, { owner: String(args.p_user), clientId })
    return { outcome: 'created', clientId }
  }
  if (!session || db.clients.get(session.clientId)?.revoked !== false)
    return { outcome: 'not-found' }
  if (name === 'control_web_session_end') {
    db.sessions.delete(hash)
    db.clients.get(session.clientId)!.revoked = true
    return { outcome: 'ended' }
  }
  const login = session.owner === db.owner ? 'fixture-owner' : 'fixture-other'
  const { owner: userId, clientId } = session
  return { outcome: 'active', userId, login, clientId, sid: db.sid, renewed: false }
}

/** Disposable real Control handlers + Host CLI. Only Auth/database ports and pi are synthetic. */
export async function browserFixture(production = false, brain = false, agentOps = false) {
  const root = await createRoot()
  const cleanups: (() => Promise<unknown>)[] = [() => removeRoot(root)]
  const close = async () => {
    const errors: unknown[] = []
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch((e) => errors.push(e))
    if (errors.length) throw errors[0]
  }
  try {
    const hostKey = generateKeyPairSync('ed25519')
    const publicKey = hostKey.publicKey.export({ format: 'jwk' }).x!
    const owners = [randomUUID(), randomUUID()]
    const sid = randomUUID(),
      hostId = randomUUID()
    const clients: Clients = new Map()
    const sessions: WebSessions = new Map()
    const codes = new Map<string, { challenge: string; owner: string }>()
    const state = {
      owner: owners[0]!,
      grants: 0,
      connections: 0,
      closedConnections: 0,
      offline: false,
      workerRevision: 0,
      machineReach: undefined as boolean | undefined,
    }
    const machine: MachineView = {
      id: hostId,
      label: brain ? 'Harbor' : 'Synthetic Host',
      hostname: 'fixture',
      platform: 'linux',
      arch: 'x64',
      hostVersion: '0.2.0',
      keyFingerprint: formatKeyFingerprint(
        createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest(),
      ),
      enrolledAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      state: 'running',
      readiness: { pi: 'ok', claude: 'signed-out', tailscale: 'ok' },
      lanes: { running: 0, waiting: 0 },
      endpoint,
    }
    const ledgerKey = brain ? generateKeyPairSync('ed25519') : undefined
    const ledgerPublicKey = ledgerKey?.publicKey.export({ format: 'jwk' }).x
    const ledger = ledgerPublicKey && {
      ...machine,
      id: randomUUID(),
      label: 'Ledger',
      endpoint: 'https://ledger.fixture.ts.net',
      keyFingerprint: formatKeyFingerprint(
        createHash('sha256').update(Buffer.from(ledgerPublicKey, 'base64url')).digest(),
      ),
    }
    let ledgerPort = 0
    let origin = '',
      controlOrigin = '',
      hostPort = 0
    const sockets = new Set<Socket>()
    const hostSockets = new Set<Socket>()
    const gate = hostGate(hostSockets)
    const server = createServer(async (req, res) => {
      try {
        if (state.offline) {
          req.socket.destroy()
          return
        }
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
        if (url.pathname === '/fixture-embed') {
          // Deliberately permissive inert parent: the CHILD app's production
          // anti-framing header, not this parent's CSP, must refuse the frame.
          res
            .writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
            .end(
              `<h1>Synthetic frame probe</h1><iframe title="Framed app" src="${origin}/"></iframe>`,
            )
          return
        }
        // Synthetic OAuth provider only. The start/callback/cookies/CSRF are real Control.
        if (url.pathname === '/auth/v1/authorize') {
          const callback = new URL(url.searchParams.get('redirect_to')!)
          if (callback.origin !== origin || callback.pathname !== '/api/auth/callback')
            throw new Error('Invalid callback')
          const code = randomBytes(16).toString('hex')
          codes.set(code, {
            challenge: url.searchParams.get('code_challenge')!,
            owner: state.owner,
          })
          callback.searchParams.set('code', code)
          res.writeHead(302, { location: callback.href }).end()
          return
        }
        const body: Buffer[] = []
        for await (const chunk of req) {
          body.push(Buffer.from(chunk))
          if (body.reduce((n, b) => n + b.length, 0) > 16384) throw new Error('Oversized request')
        }
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (Array.isArray(value)) value.forEach((v) => headers.append(key, v))
          else if (value !== undefined) headers.set(key, value)
        }
        const response = await app.fetch(
          new Request(url, {
            method: req.method,
            headers,
            ...(body.length ? { body: Buffer.concat(body) } : {}),
          }),
          { incoming: req },
        )
        res.statusCode = response.status
        response.headers.forEach((value, key) => {
          if (key !== 'set-cookie') res.setHeader(key, value)
        })
        if (response.headers.getSetCookie().length)
          res.setHeader('set-cookie', response.headers.getSetCookie())
        if (!production && url.pathname === '/sw.js' && state.workerRevision) {
          await response.body?.cancel()
          res.removeHeader('content-length')
          res.removeHeader('content-encoding')
          res.end(
            (await readFile(resolve(project, 'apps/web/dist/sw.js'), 'utf8')) +
              `\n// Synthetic update ${state.workerRevision}\n`,
          )
        } else res.end(Buffer.from(await response.arrayBuffer()))
      } catch {
        res.writeHead(500).end('Fixture request failed')
      }
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    origin = `http://127.0.0.1:${address.port}`
    controlOrigin = `http://localhost:${address.port}`
    const config = parseConfig({
      CONTROL_PUBLIC_ORIGIN: controlOrigin,
      CONTROL_WEB_ORIGIN: origin,
      WEB_DIR: production ? resolve(project, 'apps/web/dist') : resolve(evidence, 'fixture-build'),
      SITE_DIR: root,
      SUPABASE_URL: origin,
      SUPABASE_PUBLISHABLE_KEY: 'synthetic-public',
      SUPABASE_SECRET_KEY: 'synthetic-secret',
      CONTROL_WEB_SESSION_KEYS: `fixture=${randomBytes(32).toString('base64url')}`,
      CONTROL_GRANT_KEYS: `fixture=${randomBytes(32).toString('base64url')}`,
    })
    // Remembers every claimed nonce, as control_nonce_claim does, so a replay is refused.
    const claimedNonces = new Set<string>()
    const claimNonce = (args: Record<string, unknown>) => {
      const pair = JSON.stringify([args.p_identity, args.p_nonce])
      if (claimedNonces.has(pair)) return { outcome: 'replayed' }
      claimedNonces.add(pair)
      return { outcome: 'claimed' }
    }
    const deps: AppDeps = {
      config,
      clock: Date.now,
      random: randomBytes,
      log: () => {},
      version: 'browser-fixture',
      limits: new RateLimiter(Date.now, RATE_PURPOSE_CAPACITIES),
      fetch: async (input, init) => {
        const url = new URL(String(input))
        if (url.origin !== origin) throw new Error('Nonlocal Auth refused')
        if (url.pathname !== '/auth/v1/token' || url.searchParams.get('grant_type') !== 'pkce')
          throw new Error('Unexpected Auth request')
        const body = JSON.parse(String(init?.body)) as { auth_code: string; code_verifier: string }
        const code = codes.get(body.auth_code)
        codes.delete(body.auth_code)
        if (
          !code ||
          createHash('sha256').update(body.code_verifier).digest('base64url') !== code.challenge
        )
          return new Response(null, { status: 401 })
        const access = `e30.${Buffer.from(JSON.stringify({ sub: code.owner, session_id: sid, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.c2ln`
        const user_name = code.owner === owners[0] ? 'fixture-owner' : 'fixture-other'
        return Response.json({
          access_token: access,
          user: { id: code.owner, user_metadata: { user_name } },
        })
      },
      supabase: {
        // The app origin is cookie-only; no bearer reaches Auth.
        getUser: async () => Promise.reject(new ControlFailure('unauthenticated')),
        async rpc(name, args) {
          if (name === 'control_nonce_claim') return claimNonce(args)
          if (name.startsWith('control_web_session_'))
            return webSessionRpc({ clients, sessions, owner: owners[0]!, sid }, name, args)
          switch (name) {
            case 'control_account':
              return { enabled: true, maxHosts: 100 }
            case 'control_client_revoke': {
              const client = clients.get(String(args.p_client))
              if (!client || client.owner !== args.p_user) return { outcome: 'not-found' }
              client.revoked = true
              return { outcome: 'revoked' }
            }
            case 'control_machines':
              if (ledger && args.p_user_id === owners[0])
                return { machines: [machine, ledger], serverTime: new Date().toISOString() }
              return directoryRpc(name, args, owners[0]!, machine, state)
            case 'control_machine_reach_list':
            case 'control_machine_reach_set':
              return directoryRpc(name, args, owners[0]!, machine, state)
            case 'control_grant_issue': {
              const client = clients.get(String(args.p_client))
              if (
                (args.p_host !== hostId && (!ledger || args.p_host !== ledger.id)) ||
                args.p_user !== owners[0] ||
                !client ||
                client.owner !== args.p_user ||
                client.revoked
              )
                return { outcome: 'not-found' }
              state.grants++
              return {
                outcome: 'issued',
                epoch: 1,
                client: { id: args.p_client, label: 'Synthetic browser' },
                endpoint: ledger && args.p_host === ledger.id ? ledger.endpoint : endpoint,
                publicKey: ledger && args.p_host === ledger.id ? ledgerPublicKey : publicKey,
              }
            }
            case 'control_host_key':
              return args.p_host_id === hostId
                ? { outcome: 'active', publicKey }
                : ledger && args.p_host_id === ledger.id
                  ? { outcome: 'active', publicKey: ledgerPublicKey }
                  : { outcome: 'gone' }
            case 'control_host_self':
              return {
                outcome: 'active',
                hostId,
                label: machine.label,
                owner: { login: 'fixture-owner' },
                enrolledAt: machine.enrolledAt,
                lastSeenAt: machine.lastSeenAt,
              }
            case 'control_host_heartbeat':
              return { outcome: 'accepted' }
            case 'control_host_revocations':
              return {
                ownerId: owners[0],
                epoch: 1,
                revoked: {
                  sessions: [],
                  clients: [...clients].filter(([, c]) => c.revoked).map(([id]) => id),
                },
              }
            default:
              throw new Error(`Unexpected fixture RPC: ${name}`)
          }
        },
      },
    }
    const app = createApp(deps)
    // Transparent local transport mapping, not a TLS proxy or production fallback.
    // Preserve the browser Origin; rewrite only the loopback Host authority/path.
    server.on('upgrade', (req, socket, head) => {
      const port =
        req.url === '/fixture-host' ? hostPort : req.url === '/fixture-ledger' ? ledgerPort : 0
      if (production || gate.held || !port || req.headers.origin !== origin) {
        socket.destroy()
        return
      }
      const upstream = connect(port, '127.0.0.1')
      sockets.add(upstream)
      hostSockets.add(upstream)
      state.connections++
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      socket.on('close', () => {
        state.closedConnections++
        upstream.destroy()
      })
      upstream.on('close', () => {
        sockets.delete(upstream)
        hostSockets.delete(upstream)
        socket.destroy()
      })
      const headers = Object.entries(req.headers)
        .filter(([key]) => key !== 'host')
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n')
      upstream.write(`GET /v1/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headers}\r\n\r\n`)
      upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    if (production) return { origin, state, hostId, close, owners, ...UNSEEDED, ...gate.api }

    if (ledger && ledgerKey) {
      const ports = { controlOrigin, origin, owner: owners[0]!, cleanups }
      const harbor = await startBrainFixtureHost(ports, machine, hostKey.privateKey)
      hostPort = harbor.port
      const second = await startBrainFixtureHost(ports, ledger, ledgerKey.privateKey)
      ledgerPort = second.port
      const brainHosts: [BrainFixtureHost, BrainFixtureHost] = [harbor, second]
      return { origin, state, hostId, close, owners, brainHosts, ...UNSEEDED, ...gate.api }
    }

    const { hostPort: port, ...seeded } = await startCliFixtureHost({
      agentOps,
      root,
      hostId,
      label: machine.label,
      key: hostKey.privateKey,
      origin,
      controlOrigin,
      owner: owners[0]!,
      sid,
      keys: config.grantKeys!,
      cleanups,
    })
    hostPort = port
    return { origin, state, hostId, close, owners, ...seeded, ...gate.api }
  } catch (error) {
    await close()
    throw error
  }
}

/** Drops the Host's live sockets, or keeps it unreachable until released (a phone waking offline). */
function hostGate(sockets: Set<Socket>) {
  const gate = {
    held: false,
    api: {
      interruptHost: () => {
        for (const socket of sockets) socket.destroy()
      },
      holdHost: () => {
        gate.held = true
        gate.api.interruptHost()
        return () => {
          gate.held = false
        }
      },
    },
  }
  return gate
}

export const test = base.extend<{
  stack: Awaited<ReturnType<typeof browserFixture>>
  agentOps: boolean
}>({
  agentOps: [false, { option: true }],
  stack: async ({ agentOps }, use) => {
    const stack = await browserFixture(false, false, agentOps)
    try {
      await use(stack)
    } finally {
      await stack.close()
    }
  },
})
export { expect }
