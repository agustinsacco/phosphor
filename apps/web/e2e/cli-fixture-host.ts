import { expect } from '@playwright/test'
import {
  execFileSync,
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from 'node:child_process'
import type { KeyObject } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import type { Config } from '../../control/src/config'
import { askToPurge, seedPeer } from './seed-peer'

const project = resolve(import.meta.dirname, '../../..')

type Options = {
  agentOps: boolean
  root: string
  hostId: string
  label: string
  key: KeyObject
  origin: string
  controlOrigin: string
  owner: string
  sid: string
  keys: NonNullable<Config['grantKeys']>
  cleanups: (() => Promise<unknown>)[]
}

export async function startCliFixtureHost({
  root,
  hostId,
  label,
  key,
  origin,
  controlOrigin,
  owner,
  sid,
  keys,
  cleanups,
  agentOps,
}: Options) {
  const hostPort = await reservePort()
  const repo = await launchCli(
    { root, hostId, label, key, origin, controlOrigin, owner, sid, keys, cleanups, agentOps },
    hostPort,
  )
  const ports = { hostPort, keys, controlOrigin, owner, sid, hostId, cleanups }
  const seeded = await seedLanes(ports, repo)
  return { hostPort, ...seeded }
}

async function reservePort() {
  const reserve = createServer()
  await new Promise<void>((done) => reserve.listen(0, '127.0.0.1', done))
  const reserved = reserve.address()
  if (!reserved || typeof reserved === 'string') throw new Error('Missing Host port')
  const hostPort = reserved.port
  await new Promise<void>((done) => reserve.close(() => done()))
  return hostPort
}

async function launchCli(
  { root, hostId, label, key, origin, controlOrigin, cleanups, agentOps }: Options,
  hostPort: number,
) {
  const repo = join(root, 'repository'),
    second = join(root, 'other'),
    agent = join(root, 'agent'),
    conf = join(root, 'config')
  for (const dir of [
    repo,
    second,
    agent,
    join(root, 'agent-added-folder'),
    join(conf, 'identity'),
    join(root, 'bin'),
  ])
    await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(repo, 'remote.txt'), 'HOST_A_ONLY synthetic file\n')
  await writeFile(join(second, 'remote.txt'), 'HOST_B_ONLY synthetic file\n')
  execFileSync('git', ['init', '-q', second])
  await writeFile(join(root, 'bin/tailscale'), '#!/bin/sh\necho \'{"BackendState":"Stopped"}\'\n', {
    mode: 0o700,
  })
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
      label,
      ownerLogin: 'fixture-owner',
      controlUrl: controlOrigin,
      savedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  )
  await writeFile(
    join(conf, `identity/host-key.${hostId}.pem`),
    key.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  )
  const configPath = join(conf, 'config.json')
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      pi: {
        node: process.execPath,
        executable: resolve(
          project,
          agentOps
            ? 'apps/desktop/e2e/fixtures/host-ops-pi.cjs'
            : 'apps/host/src/__fixtures__/fake-pi.cjs',
        ),
      },
      repositories: [repo, second],
      control: { url: controlOrigin },
      api: { port: hostPort, webOrigin: origin },
    }),
    { mode: 0o600 }, // not the umask's: the Host refuses a group-writable config
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
  await untilReady(child, hostPort)
  return repo
}

/** Waits for the Host API to answer, failing fast when the Host process exits. */
async function untilReady(child: ChildProcessByStdio<null, Readable, Readable>, hostPort: number) {
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
}

async function seedLanes(ports: Parameters<typeof seedPeer>[0], repo: string) {
  const { send, frames, command } = await seedPeer(ports)
  send({ type: 'subscribe', id: 'seed', topic: 'lanes' })
  await expect.poll(() => frames.some((f) => f.type === 'lanes')).toBe(true)
  const directory = frames.find((f) => f.type === 'lanes')
  if (directory?.type !== 'lanes') throw new Error('Missing Host directory')
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
  // `repository` is the first lane's folder on the Host, which a spec may read and change.
  return {
    askToPurge: (id: string, reason: string) => askToPurge(ports, id, reason),
    laneId: lanes[0]!,
    secondLaneId: lanes[1]!,
    repository: repo,
  }
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
