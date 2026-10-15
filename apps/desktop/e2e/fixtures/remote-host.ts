import { expect, test } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createProxy, connect, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { Receiver, WebSocket } from 'ws'
import { watch } from 'node:fs'
import { Transform } from 'node:stream'
import { encodeGrant } from '../../../../libs/shared/src/host-grant'
import type { RoutineInput } from '../../../../libs/shared/src/routines-types'
import { HOST_CAPABILITIES } from '../../../../libs/shared/src/remote-host'
import {
  parseHostFrame,
  parseClientFrame,
  type ClientFrame,
  type HostFrame,
  type LaneOp,
} from '../../../../libs/shared/src/host-protocol'
import { MACHINE } from '../../src/features/machines/__fixtures__/control'
import { accountControlFixture } from './account-control'
import { scratchDir } from './scratch'

let hostBuilt = false

/** Real dev Host CLI, disposable owner identity, SQLite store and pi process. */
/**
 * Per-test budget for remote specs. Locally it is a hard 25 s so slow tests are caught;
 * hosted CI runners are several times slower, so there the suite's own timeout applies.
 */
export const REMOTE_TEST_TIMEOUT = process.env.CI ? 120_000 : 25_000

export async function remoteHostFixture(options: { allowRepositoryChanges?: boolean } = {}) {
  const project = resolve(import.meta.dirname, '../../../..')
  if (!hostBuilt)
    execFileSync(process.execPath, [join(project, 'apps/host/scripts/build.mjs')], {
      cwd: project,
      stdio: 'pipe',
    })
  hostBuilt = true
  const root = await scratchDir('phosphor-remote-')
  let h: Awaited<ReturnType<typeof accountControlFixture>> | undefined
  let child: ReturnType<typeof spawn> | undefined
  let peer: WebSocket | undefined
  const sockets = new Set<Socket>()
  const upstreams = new Set<Socket>()
  const observedCommands: Extract<ClientFrame, { type: 'command' }>[] = []
  const transportCleanup = new Set<() => void>()
  let holdReplies = false
  let dropClientBytes = false
  let hostOutput = ''
  let interrupted = false
  let hostPort = 0
  const proxy = createProxy((socket) => {
    if (interrupted) {
      socket.destroy()
      return
    }
    const upstream = connect(hostPort, '127.0.0.1')
    upstreams.add(upstream)
    upstream.on('close', () => upstreams.delete(upstream))
    if (holdReplies) upstream.pause()
    for (const stream of [socket, upstream]) {
      sockets.add(stream)
      stream.on('error', () => {
        socket.destroy()
        upstream.destroy()
      })
      stream.on('close', () => {
        sockets.delete(stream)
        socket.destroy()
        upstream.destroy()
      })
    }
    // A reverse proxy's upstream authority is the real loopback listener.
    let header = Buffer.alloc(0)
    const first = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk])
      const end = header.indexOf('\r\n\r\n')
      if (end === -1) {
        if (header.length > 16384) socket.destroy()
        return
      }
      socket.off('data', first)
      upstream.write(
        header
          .subarray(0, end)
          .toString()
          .replace(/Host: [^\r]+/i, `Host: 127.0.0.1:${hostPort}`) + '\r\n\r\n',
      )
      const body = header.subarray(end + 4)
      if (/upgrade: websocket/i.test(header.subarray(0, end).toString())) {
        // Receiver unmasks in place; copies keep the forwarded wire bytes untouched.
        const receiver = new Receiver({ isServer: true })
        receiver.on('error', () => socket.destroy())
        receiver.on('message', (data: Buffer) => {
          const parsed = parseClientFrame(data.toString())
          if (parsed.ok && parsed.frame.type === 'command') {
            if (observedCommands.length >= 1024) throw new Error('Too many observed commands')
            observedCommands.push(parsed.frame)
          }
        })
        socket.on('data', (data: Buffer) => receiver.write(Buffer.from(data)))
        socket.on('close', () => receiver.destroy())
        receiver.write(Buffer.from(body))
      }
      if (!dropClientBytes) upstream.write(body)
      const traffic = new Transform({
        transform(chunk, _encoding, done) {
          done(null, dropClientBytes ? undefined : chunk)
        },
      })
      socket.on('close', () => traffic.destroy())
      socket.pipe(traffic).pipe(upstream)
    }
    socket.on('data', first)
    upstream.pipe(socket)
    if (holdReplies) upstream.pause()
  })
  const severConnection = () => {
    interrupted = true
    for (const socket of sockets) socket.destroy()
    const bound = setTimeout(
      () => {
        interrupted = false
      },
      process.env.CI ? 30_000 : 10_000,
    )
    return () => {
      clearTimeout(bound)
      interrupted = false
    }
  }
  const stopHost = async () => {
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
  }
  // Independent steps: a failed Electron close never skips the Host kill or the directory.
  const close = async () => {
    const errors: unknown[] = []
    const step = (run: () => Promise<unknown>) => run().catch((e) => errors.push(e))
    await step(async () => {
      if (!h) return
      const info = test.info()
      await info.attach('host.log', { body: hostOutput, contentType: 'text/plain' })
      const desktopLog = await readFile(join(h.userData, 'logs', 'phosphor.log'), 'utf8').catch(
        () => '',
      )
      await info.attach('desktop-before-host-stop.log', {
        body: desktopLog.slice(-131072),
        contentType: 'text/plain',
      })
    })
    for (const cleanup of transportCleanup) cleanup()
    await step(async () => peer?.terminate())
    await step(stopHost)
    await step(async () => h?.close())
    for (const socket of sockets) socket.destroy()
    if (proxy.listening) await step(() => new Promise<void>((done) => proxy.close(() => done())))
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
    hostPort = address.port
    await new Promise<void>((done) => reserve.close(() => done()))
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done))
    const proxyAddress = proxy.address()
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Missing proxy port')
    const port = proxyAddress.port
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
      env: { PHOSPHOR_E2E_HOST_ENDPOINT: endpoint, PHOSPHOR_E2E_SESSION_NAME: 'LOCAL_ONLY lane' },
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
    const nonGit = join(root, 'notes')
    const addable = join(root, 'addable')
    await mkdir(nonGit)
    await mkdir(addable)
    await symlink(h.workspace, join(root, 'escape'))
    await mkdir(join(repo, 'nested'))
    await writeFile(join(nonGit, 'remote.txt'), 'HOST_B_ONLY non-git\n')
    await writeFile(join(addable, 'addable.txt'), 'HOST_ADDABLE_ONLY\n')
    await writeFile(join(repo, 'remote.txt'), 'REMOTE_FILE_FROM_REAL_HOST HOST_A_ONLY\n')
    await writeFile(join(repo, 'nested', 'guide.md'), 'HOST_A_ONLY guide\nsecond line\n')
    await writeFile(join(repo, 'deleted.txt'), 'HOST_A_ONLY deleted\n')
    await writeFile(join(repo, 'staged.txt'), 'HOST_A_ONLY before staging\n')
    await writeFile(join(repo, 'artifact.html'), '<h1>HOST_A_ONLY artifact input</h1>')
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args])
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'seed')
    await writeFile(join(repo, 'staged.txt'), 'HOST_A_ONLY staged change\n')
    git('add', 'staged.txt')
    await writeFile(join(repo, 'remote.txt'), 'REMOTE_FILE_FROM_REAL_HOST HOST_A_ONLY modified\n')
    await rm(join(repo, 'deleted.txt'))
    await writeFile(join(repo, 'untracked.txt'), 'HOST_A_ONLY untracked\n')
    await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 1, 2, 0]))
    await writeFile(join(repo, 'oversize.txt'), 'x'.repeat(3 * 1024 * 1024))
    await writeFile(join(h.workspace, 'remote.txt'), 'LOCAL_ONLY decoy\n')
    await mkdir(join(h.workspace, '.pi', 'skills', 'local-only'), { recursive: true })
    await writeFile(
      join(h.workspace, '.pi', 'skills', 'local-only', 'SKILL.md'),
      '---\nname: local-only\ndescription: LOCAL_ONLY fixture\n---\nLOCAL_ONLY skill\n',
    )
    await mkdir(join(agent, 'skills', 'host-only'), { recursive: true })
    await writeFile(
      join(agent, 'skills', 'host-only', 'SKILL.md'),
      '---\nname: host-only\ndescription: HOST_A_ONLY fixture\n---\nHOST_A_ONLY skill\n',
    )
    await writeFile(
      join(agent, 'settings.json'),
      JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model' }),
    )
    await writeFile(
      join(agent, 'auth.json'),
      JSON.stringify({
        fake: { type: 'api_key', key: 'fake-test-key' },
        anthropic: { type: 'api_key', key: 'fake-test-key' },
      }),
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
        repositories: [repo, nonGit],
        // The parity config introduces this policy; baseline rejects it if explicitly requested.
        ...(options.allowRepositoryChanges !== undefined && {
          allowRepositoryChanges: options.allowRepositoryChanges,
        }),
        control: { url: h.url },
        api: { port: hostPort },
      }),
      { mode: 0o600 },
    )
    const startHost = async () => {
      if (child && child.exitCode === null && child.signalCode === null)
        throw new Error('Host already running')
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
      child.on('exit', (code, signal) => {
        hostOutput += `\nHost exit code=${code} signal=${signal}\n`
      })
      child.stdout?.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8192)
        hostOutput = (hostOutput + chunk.toString()).slice(-131072)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8192)
        hostOutput = (hostOutput + chunk.toString()).slice(-131072)
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
    }
    const frames: HostFrame[] = []
    const connectPeer = async () => {
      peer = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`)
      peer.on('message', (data) => {
        const parsed = parseHostFrame(data.toString())
        if (!parsed.ok) throw new Error('Invalid Host frame')
        if (frames.length >= 4096) throw new Error('Too many Host frames')
        frames.push(parsed.value)
      })
      await once(peer, 'open')
      send({
        type: 'auth',
        grant: mint(randomUUID(), 'Second client'),
        challenge: 'b'.repeat(64),
        trace: 'fedcba9876543210',
      })
      await expect.poll(() => frames.some((f) => f.type === 'ready')).toBe(true)
    }
    const send = (frame: ClientFrame) => {
      if (!peer || peer.readyState !== WebSocket.OPEN) throw new Error('Peer not connected')
      peer.send(JSON.stringify(frame))
    }
    await startHost()
    await connectPeer()
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
    async function repositoryId(index = 0) {
      send({ type: 'subscribe', id: 'directory', topic: 'lanes' })
      await expect.poll(() => frames.some((f) => f.type === 'lanes')).toBe(true)
      const directory = frames.find((f) => f.type === 'lanes')
      if (directory?.type !== 'lanes') throw new Error('Missing directory')
      const repository = directory.repositories.find(
        (repo) => repo.name === (index === 0 ? 'repository' : 'notes'),
      )
      if (!repository) throw new Error('Missing repository')
      return repository.id
    }
    const fences = new Map<string, number>()
    const command = async (op: LaneOp, lane?: string) => {
      const requestId = randomUUID()
      const fence = lane ? fences.get(lane) : undefined
      send({
        type: 'command',
        requestId,
        ...(lane && { laneId: lane }),
        ...(fence !== undefined && { fence }),
        op,
      })
      await expect
        .poll(() =>
          frames.some(
            (f) =>
              f.type === 'receipt' &&
              f.receipt.requestId === requestId &&
              ['done', 'rejected', 'failed', 'unknown'].includes(f.receipt.status),
          ),
        )
        .toBe(true)
      const frame = frames.findLast(
        (f) => f.type === 'receipt' && f.receipt.requestId === requestId,
      )
      if (frame?.type !== 'receipt' || frame.receipt.status !== 'done')
        throw new Error(`Second client command failed: ${JSON.stringify(frame)}`)
      if (lane && frame.receipt.fence !== undefined) fences.set(lane, frame.receipt.fence)
      return frame.receipt
    }
    const createLane = async (
      index = 1,
      branch?: string,
      name = index ? 'HOST_B_ONLY lane' : `HOST_A_ONLY ${branch ?? 'lane'}`,
    ) => {
      const receipt = await command({
        type: 'lane.create',
        repositoryId: await repositoryId(index),
        ...(name && { name }),
        worktree: branch ? { branch } : null,
      })
      if (!receipt.laneId) throw new Error('Missing lane')
      return receipt.laneId
    }
    const laneSummary = (lane: string) => {
      for (const frame of frames.toReversed()) {
        if (frame.type === 'lanes-delta' && frame.remove.includes(lane)) return undefined
        const lanes =
          frame.type === 'lanes' ? frame.lanes : frame.type === 'lanes-delta' ? frame.upsert : []
        const summary = lanes.find((entry) => entry.laneId === lane)
        if (summary) return summary
      }
      return undefined
    }
    const routine: Omit<RoutineInput, 'workspacePath'> = {
      name: 'HOST_A_ONLY routine',
      instructions: 'PHX-routine',
      isolated: false,
      intent: 'report',
      provider: 'fake',
      model: 'fake-model',
      timezone: 'UTC',
      schedule: { kind: 'manual' },
      period: 'none',
      catchUpHours: 0,
      maxRuntimeMinutes: 1,
      enabled: false,
      trusted: false,
    }
    await command({
      type: 'routine.save',
      expectedRevision: null,
      routine: { ...routine, repositoryId: await repositoryId() },
    })
    await h.page.evaluate((input) => window.phosphor.invoke('routines:save', input), {
      ...routine,
      workspacePath: h.workspace,
      name: 'LOCAL_ONLY routine',
      provider: 'stub',
      model: 'stub-model',
    })
    const restartHost = async () => {
      peer?.terminate()
      await stopHost()
      frames.length = 0
      await startHost()
      await connectPeer()
      await repositoryId()
    }
    const desktop = h
    desktop.page.setDefaultTimeout(process.env.CI ? 30_000 : 10_000)
    return {
      ...desktop,
      get app() {
        return desktop.app
      },
      get page() {
        return desktop.page
      },
      root,
      repo,
      nonGit,
      addable,
      laneId,
      send,
      frames,
      laneSummary,
      close,
      startHost,
      stopHost,
      restartHost,
      command,
      severConnection,
      dropClientTraffic: () => {
        dropClientBytes = true
        const restore = () => {
          dropClientBytes = false
          clearTimeout(bound)
          transportCleanup.delete(restore)
        }
        const bound = setTimeout(restore, process.env.CI ? 30_000 : 10_000)
        transportCleanup.add(restore)
        return restore
      },
      writeRequests: () => observedCommands.filter((frame) => frame.op.type === 'files.write'),
      // Pause real Host replies before submission, then cut only once its disk write lands.
      loseWriteReceipt: (path: string, content: string) => {
        holdReplies = true
        for (const upstream of upstreams) upstream.pause()
        const firstCommand = observedCommands.length
        let active = true
        let restoreConnection: (() => void) | undefined
        let resolveLanded: () => void
        let rejectLanded: (error: Error) => void
        const landed = new Promise<void>((resolve, reject) => {
          resolveLanded = resolve
          rejectLanded = reject
        })
        const watcher = watch(repo, async () => {
          if (
            (await readFile(join(repo, path), 'utf8').catch(() => '')) !== content ||
            restoreConnection ||
            !active
          )
            return
          watcher.close()
          restoreConnection = severConnection()
          resolveLanded()
        })
        const bound = setTimeout(() => {
          restore()
          rejectLanded(new Error('Host write did not land within 8 seconds'))
        }, 8000)
        const restore = () => {
          active = false
          clearTimeout(bound)
          watcher.close()
          holdReplies = false
          for (const upstream of upstreams) upstream.resume()
          restoreConnection?.()
          transportCleanup.delete(restore)
        }
        transportCleanup.add(restore)
        return {
          landed,
          restore,
          writes: () =>
            observedCommands
              .slice(firstCommand)
              .filter((frame) => frame.op.type === 'files.write' && frame.op.path === path),
        }
      },
      slowName: {
        prompt: `PHX-delayedname name-until:${join(root, 'release-name')}`,
        release: () => writeFile(join(root, 'release-name'), ''),
        finished: () =>
          readFile(join(root, 'release-name.finished'), 'utf8').then(
            () => true,
            () => false,
          ),
      },
      slowTurn: {
        prompt: `slow-until ${join(root, 'release-slow-turn')}`,
        release: () => writeFile(join(root, 'release-slow-turn'), ''),
      },
      readHostFile: (path: string) => readFile(join(repo, path), 'utf8'),
      createLane,
      createEmptyLane: async () => {
        await mkdir(join(root, 'empty'))
        await command({ type: 'host.repositories.add', path: 'empty' })
        const directory = () =>
          frames.findLast(
            (f) => f.type === 'lanes' && f.repositories.some((r) => r.name === 'empty'),
          )
        await expect.poll(() => directory()).toBeTruthy()
        const snapshot = directory()
        if (snapshot?.type !== 'lanes') throw new Error('Missing empty repository')
        const repository = snapshot.repositories.find((r) => r.name === 'empty')!
        const receipt = await command({
          type: 'lane.create',
          repositoryId: repository.id,
          name: 'HOST_EMPTY lane',
          worktree: null,
        })
        if (!receipt.laneId) throw new Error('Missing empty lane')
        return receipt.laneId
      },
      createWorktreePair: async () => {
        const pair = [await createLane(0, 'fixture-a'), await createLane(0, 'fixture-b')]
        for (const [index, lane] of pair.entries()) {
          await expect.poll(() => laneSummary(lane)?.cwd).toBeTruthy()
          const cwd = laneSummary(lane)?.cwd
          if (!cwd) throw new Error('Missing worktree directory')
          await writeFile(
            join(cwd, 'remote.txt'),
            index === 0 ? 'HOST_A_ONLY WORKTREE_A' : 'HOST_B_ONLY WORKTREE_B',
          )
        }
        return pair
      },
      takeover: (lane = laneId) => command({ type: 'control.take' }, lane),
      release: (lane = laneId) => command({ type: 'control.release' }, lane),
      conflictWrite: (path: string, value: string) => writeFile(join(repo, path), value),
      backgroundTurn: async (message: string, lane = laneId) => {
        const before = laneSummary(lane)?.attention ?? 0
        await command({ type: 'control.take' }, lane)
        await command({ type: 'prompt', message }, lane)
        await expect.poll(() => laneSummary(lane)?.attention ?? 0).toBeGreaterThan(before)
      },
      localSentinel: () => readFile(join(desktop.workspace, 'remote.txt'), 'utf8'),
    }
  } catch (error) {
    await close()
    throw error
  }
}
