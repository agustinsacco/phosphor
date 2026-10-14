import { expect } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import { encodeGrant } from '../../../../libs/shared/src/host-grant'
import { HOST_CAPABILITIES } from '../../../../libs/shared/src/remote-host'
import {
  parseHostFrame,
  type ClientFrame,
  type HostFrame,
} from '../../../../libs/shared/src/host-protocol'
import { MACHINE } from '../../src/features/machines/__fixtures__/control'
import { accountControlFixture } from './account-control'
import { scratchDir } from './scratch'

/** Real dev Host CLI, disposable owner identity, SQLite store and pi process. */
export async function remoteHostFixture() {
  const project = resolve(import.meta.dirname, '../../../..')
  execFileSync(process.execPath, [join(project, 'apps/host/scripts/build.mjs')], {
    cwd: project,
    stdio: 'pipe',
  })
  const root = await scratchDir('phosphor-remote-')
  let h: Awaited<ReturnType<typeof accountControlFixture>> | undefined
  let child: ReturnType<typeof spawn> | undefined
  let peer: WebSocket | undefined
  // Independent steps: a failed Electron close never skips the Host kill or the directory.
  const close = async () => {
    const errors: unknown[] = []
    const step = (run: () => Promise<unknown>) => run().catch((e) => errors.push(e))
    await step(async () => peer?.terminate())
    await step(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGTERM')
        const kill = setTimeout(() => child?.kill('SIGKILL'), 5000)
        try {
          await exited
        } finally {
          clearTimeout(kill)
        }
      }
    })
    await step(async () => h?.close())
    await step(() => rm(root, { recursive: true, force: true }))
    if (errors.length > 0) throw errors[0]
  }
  try {
    const hostKey = generateKeyPairSync('ed25519')
    const controlKey = generateKeyPairSync('ed25519')
    const owner = randomUUID(),
      sid = randomUUID(),
      hostId = randomUUID()
    const reserve = createServer()
    reserve.listen(0, '127.0.0.1')
    await once(reserve, 'listening')
    const address = reserve.address()
    if (!address || typeof address === 'string') throw new Error('Missing port')
    const port = address.port
    await new Promise<void>((done) => reserve.close(() => done()))
    const endpoint = `https://127.0.0.1:${port}`
    const publicKey = hostKey.publicKey.export({ format: 'jwk' }).x
    const mint = (clientId: string, label: string) => {
      const iat = Math.floor(Date.now() / 1000)
      return encodeGrant(
        {
          v: 1,
          iss: h?.url ?? '',
          kid: 'e2e',
          sub: owner,
          sid,
          hostId,
          epoch: 1,
          client: { id: clientId, label },
          caps: [...HOST_CAPABILITIES],
          iat,
          exp: iat + 300,
          jti: randomBytes(8).toString('hex'),
        },
        (bytes) => sign(null, bytes, controlKey.privateKey),
      )
    }
    const machine = {
      ...MACHINE,
      id: hostId,
      endpoint,
      lastSeenAt: new Date().toISOString(),
      state: 'running' as const,
    }
    h = await accountControlFixture([machine], {
      userId: owner,
      env: { PHOSPHOR_E2E_HOST_ENDPOINT: endpoint },
      route(req, res, body) {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        const json = (value: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
          return true
        }
        if (path === '/api/v1/hosts/self')
          return json({
            hostId,
            label: 'bee1',
            owner: { login: 'octo' },
            enrolledAt: machine.enrolledAt,
            lastSeenAt: machine.lastSeenAt,
          })
        if (path === '/api/v1/hosts/self/heartbeat')
          return json({ accepted: true, nextInSec: 30, ownerId: owner, epoch: 1 })
        if (path === '/api/v1/grant-keys')
          return json({
            keys: [{ kid: 'e2e', publicKey: controlKey.publicKey.export({ format: 'jwk' }).x }],
          })
        if (path === '/api/v1/clients')
          return json({ client: { id: randomUUID(), label: 'Desktop' } })
        if (
          path === '/api/v1/grants' &&
          body &&
          typeof body === 'object' &&
          'clientId' in body &&
          typeof body.clientId === 'string'
        )
          return json({
            grant: mint(body.clientId, 'Desktop'),
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            host: { id: hostId, endpoint, publicKey },
          })
        return false
      },
    })
    const repo = join(root, 'repository'),
      agent = join(root, 'agent'),
      conf = join(root, 'conf')
    await mkdir(repo)
    await mkdir(agent)
    await mkdir(join(conf, 'identity'), { recursive: true, mode: 0o700 })
    await mkdir(join(root, 'bin'))
    // Ordinary executable/config inputs, not hooks in the Host bundle.
    await writeFile(
      join(root, 'bin', 'tailscale'),
      '#!/bin/sh\necho \'{"BackendState":"Stopped"}\'\n',
      { mode: 0o700 },
    )
    execFileSync('git', ['init', '-q', repo])
    await writeFile(join(repo, 'remote.txt'), 'REMOTE_FILE_FROM_REAL_HOST\n')
    await writeFile(
      join(agent, 'settings.json'),
      JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model' }),
    )
    await writeFile(
      join(agent, 'auth.json'),
      JSON.stringify({ fake: { type: 'api_key', key: 'fake-test-key' } }),
    )
    await writeFile(
      join(conf, 'identity', 'host.json'),
      JSON.stringify({
        version: 1,
        hostId,
        label: 'bee1',
        ownerLogin: 'octo',
        controlUrl: h.url,
        savedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    )
    await writeFile(
      join(conf, 'identity', `host-key.${hostId}.pem`),
      hostKey.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    )
    const config = join(conf, 'config.json')
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        pi: {
          node: process.execPath,
          executable: join(project, 'apps/host/src/__fixtures__/fake-pi.cjs'),
        },
        repositories: [repo],
        control: { url: h.url },
        api: { port },
      }),
      { mode: 0o600 },
    )
    child = spawn(
      process.execPath,
      [join(project, 'apps/host/dist/phosphor.mjs'), 'run', '--config', config],
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
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8192)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8192)
    })
    await expect
      .poll(async () => {
        if (child?.exitCode !== null) throw new Error(`Host exited: ${output}`)
        return fetch(`http://127.0.0.1:${port}/v1/hello?challenge=${'a'.repeat(64)}`, {
          headers: { 'x-phosphor-trace': '0123456789abcdef' },
        })
          .then((r) => r.status)
          .catch(() => 0)
      })
      .toBe(200)
    peer = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`)
    const frames: HostFrame[] = []
    peer.on('message', (data) => {
      const parsed = parseHostFrame(data.toString())
      if (!parsed.ok) throw new Error('Invalid Host frame')
      if (frames.length >= 4096) throw new Error('Too many Host frames')
      frames.push(parsed.value)
    })
    await once(peer, 'open')
    const send = (frame: ClientFrame) => peer?.send(JSON.stringify(frame))
    send({
      type: 'auth',
      grant: mint(randomUUID(), 'Second client'),
      challenge: 'b'.repeat(64),
      trace: 'fedcba9876543210',
    })
    await expect.poll(() => frames.some((f) => f.type === 'ready')).toBe(true)
    const requestId = randomUUID()
    send({
      type: 'command',
      requestId,
      op: {
        type: 'lane.create',
        repositoryId: await repositoryId(),
        name: 'Remote test lane',
        worktree: null,
      },
    })
    await expect
      .poll(() =>
        frames.some(
          (f) =>
            f.type === 'receipt' &&
            f.receipt.requestId === requestId &&
            f.receipt.status === 'done',
        ),
      )
      .toBe(true)
    const receipt = frames.find(
      (f) =>
        f.type === 'receipt' && f.receipt.requestId === requestId && f.receipt.status === 'done',
    )
    if (receipt?.type !== 'receipt' || receipt.receipt.status !== 'done' || !receipt.receipt.laneId)
      throw new Error('Missing created lane')
    const laneId = receipt.receipt.laneId
    async function repositoryId() {
      send({ type: 'subscribe', id: 'directory', topic: 'lanes' })
      await expect.poll(() => frames.some((f) => f.type === 'lanes')).toBe(true)
      const directory = frames.find((f) => f.type === 'lanes')
      if (directory?.type !== 'lanes' || !directory.repositories[0])
        throw new Error('Missing repository')
      return directory.repositories[0].id
    }
    return { ...h, root, laneId, send, frames, close }
  } catch (error) {
    await close()
    throw error
  }
}
