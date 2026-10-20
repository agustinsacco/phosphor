import { expect, test as base } from '@playwright/test'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { connect, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import { createApp, type AppDeps } from '../../control/src/app'
import { parseConfig } from '../../control/src/config'
import { ControlFailure } from '../../control/src/http'
import { NonceCache, RateLimiter, RATE_PURPOSE_CAPACITIES } from '../../control/src/limits'
import { formatKeyFingerprint, type MachineView } from '@phosphor/shared/control-api'
import { HOST_CAPABILITIES } from '@phosphor/shared/remote-host'
import {
  parseHostFrame,
  type ClientFrame,
  type HostFrame,
  type LaneOp,
} from '@phosphor/shared/host-protocol'
import { evidence } from '../playwright.config'

const project = resolve(import.meta.dirname, '../../..')
const endpoint = 'https://fixture.ts.net'

/** Disposable real Control handlers + Host CLI. Only Auth/database ports and pi are synthetic. */
export async function browserFixture(production = false) {
  const root = await mkdtemp(join(tmpdir(), 'phosphor-web-'))
  const cleanups: (() => Promise<unknown>)[] = [() => rm(root, { recursive: true, force: true })]
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
    const clients = new Map<string, { owner: string; revoked: boolean }>()
    const tokens = new Map<string, string>()
    const codes = new Map<string, { challenge: string; owner: string }>()
    const state = {
      owner: owners[0]!,
      grants: 0,
      connections: 0,
      closedConnections: 0,
      offline: false,
      workerRevision: 0,
    }
    const machine: MachineView = {
      id: hostId,
      label: 'Synthetic Host',
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
    const deps: AppDeps = {
      config,
      clock: Date.now,
      random: randomBytes,
      log: () => {},
      version: 'browser-fixture',
      limits: new RateLimiter(Date.now, RATE_PURPOSE_CAPACITIES),
      nonces: { key: new NonceCache(Date.now), host: new NonceCache(Date.now) },
      fetch: async (input, init) => {
        const url = new URL(String(input))
        if (url.origin !== origin) throw new Error('Nonlocal Auth refused')
        if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 })
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
        tokens.set(access, code.owner)
        return Response.json({
          access_token: access,
          refresh_token: randomBytes(32).toString('base64url'),
          expires_in: 3600,
          user: { id: code.owner },
        })
      },
      supabase: {
        async getUser(token) {
          const id = tokens.get(token)
          if (!id) throw new ControlFailure('unauthenticated')
          return {
            id,
            user_metadata: { user_name: id === owners[0] ? 'fixture-owner' : 'fixture-other' },
          }
        },
        async rpc(name, args) {
          switch (name) {
            case 'control_account':
              return { enabled: true, maxHosts: 20 }
            case 'control_client_register': {
              const id = randomUUID()
              clients.set(id, { owner: String(args.p_user), revoked: false })
              return { outcome: 'registered', client: { id, label: 'Synthetic browser' } }
            }
            case 'control_web_client_status': {
              const client = clients.get(String(args.p_client))
              return {
                outcome:
                  client && client.owner === args.p_user && !client.revoked
                    ? 'active'
                    : 'not-found',
              }
            }
            case 'control_client_revoke': {
              const client = clients.get(String(args.p_client))
              if (!client || client.owner !== args.p_user) return { outcome: 'not-found' }
              client.revoked = true
              return { outcome: 'revoked' }
            }
            case 'control_machines':
              return {
                machines:
                  args.p_user_id === owners[0]
                    ? [{ ...machine, lastSeenAt: new Date().toISOString() }]
                    : [],
                serverTime: new Date().toISOString(),
              }
            case 'control_grant_issue': {
              const client = clients.get(String(args.p_client))
              if (
                args.p_host !== hostId ||
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
                endpoint,
                publicKey,
              }
            }
            case 'control_host_key':
              return args.p_host_id === hostId
                ? { outcome: 'active', publicKey }
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
      if (production || gate.held || req.url !== '/fixture-host' || req.headers.origin !== origin) {
        socket.destroy()
        return
      }
      const upstream = connect(hostPort, '127.0.0.1')
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
      upstream.write(`GET /v1/stream HTTP/1.1\r\nHost: 127.0.0.1:${hostPort}\r\n${headers}\r\n\r\n`)
      upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    if (production)
      return { origin, state, hostId, close, owners, laneId: '', secondLaneId: '', ...gate.api }

    const reserve = createServer()
    await new Promise<void>((done) => reserve.listen(0, '127.0.0.1', done))
    const reserved = reserve.address()
    if (!reserved || typeof reserved === 'string') throw new Error('Missing Host port')
    hostPort = reserved.port
    await new Promise<void>((done) => reserve.close(() => done()))
    const repo = join(root, 'repository'),
      second = join(root, 'other'),
      agent = join(root, 'agent'),
      conf = join(root, 'config')
    for (const dir of [repo, second, agent, join(conf, 'identity'), join(root, 'bin')])
      await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(join(repo, 'remote.txt'), 'HOST_A_ONLY synthetic file\n')
    await writeFile(join(second, 'remote.txt'), 'HOST_B_ONLY synthetic file\n')
    await writeFile(
      join(root, 'bin/tailscale'),
      '#!/bin/sh\necho \'{"BackendState":"Stopped"}\'\n',
      { mode: 0o700 },
    )
    await writeFile(
      join(agent, 'settings.json'),
      JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model' }),
    )
    await writeFile(
      join(agent, 'auth.json'),
      JSON.stringify({ fake: { type: 'api_key', key: 'synthetic-not-a-credential' } }),
      { mode: 0o600 },
    )
    await writeFile(
      join(conf, 'identity/host.json'),
      JSON.stringify({
        version: 1,
        hostId,
        label: machine.label,
        ownerLogin: 'fixture-owner',
        controlUrl: controlOrigin,
        savedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    )
    await writeFile(
      join(conf, `identity/host-key.${hostId}.pem`),
      hostKey.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    )
    const configPath = join(conf, 'config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        pi: {
          node: process.execPath,
          executable: resolve(project, 'apps/host/src/__fixtures__/fake-pi.cjs'),
        },
        repositories: [repo, second],
        control: { url: controlOrigin },
        api: { port: hostPort, webOrigin: origin },
      }),
    )
    const child = spawn(
      process.execPath,
      [resolve(project, 'apps/host/dist/phosphor.mjs'), 'run', '--config', configPath],
      {
        env: {
          HOME: root,
          PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
          XDG_STATE_HOME: join(root, 'state'),
          PI_CODING_AGENT_DIR: agent,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    cleanups.push(() => stop(child))
    // Drain output, retaining only a bounded synthetic diagnostic on startup failure.
    let output = ''
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096)
      })
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null) throw new Error(`Fixture Host exited: ${output}`)
          return fetch(`http://127.0.0.1:${hostPort}/v1/hello?challenge=${'a'.repeat(64)}`)
            .then((r) => r.status)
            .catch(() => 0)
        },
        { timeout: 20_000 },
      )
      .toBe(200)
    const peer = new WebSocket(`ws://127.0.0.1:${hostPort}/v1/stream`)
    cleanups.push(async () => {
      peer.terminate()
    })
    const frames: HostFrame[] = []
    peer.on('message', (raw) => {
      const frame = parseHostFrame(raw.toString())
      if (frame.ok) frames.push(frame.value)
    })
    await once(peer, 'open')
    const send = (frame: ClientFrame) => peer.send(JSON.stringify(frame))
    const iat = Math.floor(Date.now() / 1000)
    send({
      type: 'auth',
      challenge: 'b'.repeat(64),
      trace: '0123456789abcdef',
      grant: config.grantKeys!.sign({
        v: 1,
        iss: controlOrigin,
        kid: config.grantKeys!.kid,
        sub: owners[0]!,
        sid,
        hostId,
        epoch: 1,
        client: { id: randomUUID(), label: 'Synthetic seeder' },
        caps: HOST_CAPABILITIES,
        iat,
        exp: iat + 300,
        jti: randomBytes(8).toString('hex'),
      }),
    })
    await expect.poll(() => frames.some((f) => f.type === 'ready')).toBe(true)
    send({ type: 'subscribe', id: 'seed', topic: 'lanes' })
    await expect.poll(() => frames.some((f) => f.type === 'lanes')).toBe(true)
    const directory = frames.find((f) => f.type === 'lanes')
    if (directory?.type !== 'lanes') throw new Error('Missing Host directory')
    const command = async (op: LaneOp, laneId?: string, fence?: number) => {
      const requestId = randomUUID()
      send({
        type: 'command',
        requestId,
        op,
        ...(laneId ? { laneId } : {}),
        ...(fence === undefined ? {} : { fence }),
      })
      await expect
        .poll(() =>
          frames.some(
            (f) =>
              f.type === 'receipt' &&
              f.receipt.requestId === requestId &&
              f.receipt.status !== 'pending',
          ),
        )
        .toBe(true)
      const result = frames.findLast(
        (f) => f.type === 'receipt' && f.receipt.requestId === requestId,
      )
      if (result?.type !== 'receipt' || result.receipt.status !== 'done')
        throw new Error('Host seed command failed')
      return result.receipt
    }
    const lanes: string[] = []
    for (const [index, name] of ['repository', 'other'].entries()) {
      const repositoryId = directory.repositories.find((r) => r.name === name)!.id
      const result = await command({
        type: 'lane.create',
        repositoryId,
        name: index ? 'Second synthetic lane' : 'Synthetic acceptance lane',
        worktree: null,
      })
      const laneId = result.laneId!
      lanes.push(laneId)
      const control = await command({ type: 'control.take' }, laneId)
      await command({ type: 'prompt', message: 'PHX-synthetic artifact' }, laneId, control.fence)
      await expect
        .poll(() =>
          frames.some(
            (f) =>
              f.type === 'lanes-delta' &&
              f.upsert.some((l) => l.laneId === laneId && l.attention > 0),
          ),
        )
        .toBe(true)
      await command({ type: 'control.release' }, laneId, control.fence)
    }
    return {
      origin,
      state,
      hostId,
      close,
      owners,
      laneId: lanes[0]!,
      secondLaneId: lanes[1]!,
      ...gate.api,
    }
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

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  try {
    child.kill('SIGTERM')
    await exited
  } finally {
    clearTimeout(timer)
  }
}

export const test = base.extend<{ stack: Awaited<ReturnType<typeof browserFixture>> }>({
  // Playwright requires a destructured first argument even with no fixture dependencies.
  // eslint-disable-next-line no-empty-pattern
  stack: async ({}, use) => {
    const stack = await browserFixture()
    try {
      await use(stack)
    } finally {
      await stack.close()
    }
  },
})
export { expect }
