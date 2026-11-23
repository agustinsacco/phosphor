import { expect, test } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { connect, createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { HOST_SIDECARS, parseLocalRunFile } from '../../../../libs/shared/src/host-local'
import { assertScratchRoots } from './assert-scratch'
import { createHostFixtureBuilder } from './remote-host-build'

/**
 * This Mac's Phosphor service for an e2e test: the real dev Host CLI
 * (`phosphor run`) in local mode, in the foreground, as a child of the test.
 * Never `service install`, `setup --local` or launchd: every file `setup
 * --local` would write is written here directly, so nothing probes 47615.
 * Unenrolled, so it opens no TCP listener; Headroom is off. Every root lives
 * in one short `/tmp` mkdtemp, so the owner socket fits its byte limit, and
 * `assertScratchRoots` checks them all before the daemon starts.
 */

const project = resolve(import.meta.dirname, '../../../..')
/** Longest owner socket path a fixture accepts: under the daemon's own 103-byte limit. */
export const FIXTURE_SOCKET_MAX_BYTES = 100
/** Desktop's owner key label (`daemon/owner-key.ts`), so the pairing reads as it would in production. */
const OWNER_LABEL = 'Phosphor Desktop'
const READY_TIMEOUT_MS = process.env.CI ? 60_000 : 20_000

// One Host build per Playwright worker, as in remote-host.ts.
const hostDist = realpathSync.native(mkdtempSync('/tmp/phosphor-e2e-daemon-host-'))
process.once('exit', () => rmSync(hostDist, { recursive: true, force: true }))
const buildHost = createHostFixtureBuilder({
  build: () => {
    execFileSync(
      process.execPath,
      [join(project, 'apps/host/scripts/build.mjs'), '--out', hostDist],
      { cwd: project, stdio: 'pipe' },
    )
  },
  native: () => Promise.reject(new Error('The local daemon fixture runs without native modules.')),
})

/** A loopback port nothing listens on once this returns. */
async function closedPort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  await new Promise<void>((done) => server.close(() => done()))
  if (!address || typeof address === 'string') throw new Error('No loopback port')
  return address.port
}

/** True when a TCP connect to 127.0.0.1:`port` is refused. */
function refused(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      done(false)
    })
    socket.once('error', () => done(true))
  })
}

/** The `GET /v1/hello` the daemon answers on its owner socket. */
export function socketHello(socket: string): Promise<{ status: number; body: unknown }> {
  return new Promise((done, fail) => {
    const req = request(
      { socketPath: socket, path: `/v1/hello?challenge=${'e'.repeat(64)}` },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown = text
          try {
            body = JSON.parse(text)
          } catch {
            // Kept as text for the failure message.
          }
          done({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.once('error', fail)
    req.end()
  })
}

const json = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 })

export interface LocalDaemonOptions {
  /** Writes `owner-standby.json`: the daemon serves owner calls only, as before a migration commit. */
  standby?: boolean
  repositories?: string[]
}

export type LocalDaemon = Awaited<ReturnType<typeof localDaemonFixture>>

/** Writes the world, starts the daemon and resolves once its owner socket answers. */
export async function localDaemonFixture(options: LocalDaemonOptions = {}) {
  await buildHost()
  const root = realpathSync.native(mkdtempSync('/tmp/pd-'))
  const home = join(root, 'home')
  const configHome = join(root, 'config')
  const configDir = join(configHome, 'phosphor-host')
  const stateHome = join(root, 'state')
  const stateDir = join(stateHome, 'phosphor-host')
  const runtimeDir = join(root, 'run')
  const agentDir = join(root, 'agent')
  const userData = join(root, 'user-data')
  const ownerKeyPath = join(root, 'owner-key.pem')
  const configPath = join(configDir, 'config.json')
  const roots: Record<string, string> = {
    home,
    launchAgents: join(home, 'Library', 'LaunchAgents'),
    systemdUnits: join(configHome, 'systemd', 'user'),
    config: configDir,
    state: stateDir,
    runtime: runtimeDir,
    agent: agentDir,
    userData,
    ownerKey: ownerKeyPath,
  }
  assertScratchRoots(roots, [root])
  let child: ChildProcess | undefined
  let output = ''
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    const kill = setTimeout(() => child?.kill('SIGKILL'), 5000)
    try {
      await exited
    } finally {
      clearTimeout(kill)
    }
  }
  const close = async () => {
    const info = test.info()
    await info.attach('local-daemon.log', { body: output, contentType: 'text/plain' })
    const runtimeLog = await readFile(join(stateDir, 'logs/phosphor.log'), 'utf8').catch(() => '')
    await info.attach('local-daemon-runtime.log', {
      body: runtimeLog.slice(-131072),
      contentType: 'text/plain',
    })
    try {
      await stop()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  try {
    for (const folder of [
      home,
      configHome,
      configDir,
      stateHome,
      stateDir,
      runtimeDir,
      agentDir,
      userData,
    ])
      await mkdir(folder, { recursive: true, mode: 0o700 })
    const machine = generateKeyPairSync('ed25519')
    const owner = generateKeyPairSync('ed25519')
    const machineId = randomUUID()
    const ownerId = randomUUID()
    const raw = (key: typeof owner.publicKey) => key.export({ format: 'jwk' }).x
    const now = new Date().toISOString()
    const apiPort = await closedPort()
    await json(configPath, {
      version: 1,
      pi: {
        node: process.execPath,
        executable: join(project, 'apps/host/src/__fixtures__/fake-pi.cjs'),
      },
      repositories: options.repositories ?? [],
      // Nothing listens on either port: an unenrolled daemon reaches neither.
      control: { url: `http://127.0.0.1:${await closedPort()}` },
      api: { port: apiPort },
    })
    await writeFile(
      join(configDir, HOST_SIDECARS.localKey),
      machine.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    )
    await json(join(configDir, HOST_SIDECARS.localIdentity), {
      version: 1,
      machineId,
      createdAt: now,
      publicKey: raw(machine.publicKey),
    })
    await json(join(configDir, HOST_SIDECARS.ownerClients), {
      version: 1,
      clients: [{ id: ownerId, label: OWNER_LABEL, publicKey: raw(owner.publicKey), addedAt: now }],
    })
    // The marker last, as setup --local publishes it. No login-shell capture in a test.
    await json(join(configDir, HOST_SIDECARS.localMode), {
      version: 1,
      enabledAt: now,
      shellEnvironment: false,
    })
    await json(join(stateDir, HOST_SIDECARS.headroom), { version: 1, enabled: false })
    if (options.standby) await json(join(stateDir, HOST_SIDECARS.standby), { version: 1 })
    await writeFile(ownerKeyPath, owner.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    })
    child = spawn(
      process.execPath,
      [join(hostDist, 'phosphor.mjs'), 'run', '--config', configPath],
      {
        env: {
          HOME: home,
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          TMPDIR: root,
          XDG_CONFIG_HOME: configHome,
          XDG_STATE_HOME: stateHome,
          XDG_RUNTIME_DIR: runtimeDir,
          PI_CODING_AGENT_DIR: agentDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const daemon = child
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-131072)
    }
    daemon.stdout?.on('data', collect)
    daemon.stderr?.on('data', collect)
    daemon.on('exit', (code, signal) => {
      output += `\nDaemon exit code=${code} signal=${signal}\n`
    })
    let socket = ''
    await expect
      .poll(
        async () => {
          if (daemon.exitCode !== null) throw new Error(`The daemon exited: ${output}`)
          const text = await readFile(join(stateDir, HOST_SIDECARS.localRun), 'utf8').catch(
            () => '',
          )
          const run = text ? parseLocalRunFile(JSON.parse(text)) : null
          if (run?.machineId !== machineId) return false
          socket = run.socket
          return (await socketHello(socket).catch(() => ({ status: 0 }))).status === 200
        },
        { timeout: READY_TIMEOUT_MS },
      )
      .toBe(true)
    assertScratchRoots({ socket }, [root])
    if (Buffer.byteLength(socket) > FIXTURE_SOCKET_MAX_BYTES)
      throw new Error(`The owner socket path is ${Buffer.byteLength(socket)} bytes: ${socket}`)
    if (!(await refused(apiPort))) throw new Error('The daemon opened its TCP API.')
    return {
      root,
      roots: { ...roots, socket } as Readonly<Record<string, string>>,
      machineId,
      socket,
      apiPort,
      pid: daemon.pid,
      /** The env an unpackaged Desktop needs to run in daemon mode against this daemon. */
      desktopEnv: {
        PHOSPHOR_LOCAL_DAEMON_SOCKET: socket,
        PHOSPHOR_LOCAL_DAEMON_CONFIG: configDir,
        PHOSPHOR_E2E_OWNER_KEY: ownerKeyPath,
        PHOSPHOR_TEST_USER_DATA: userData,
        PI_CODING_AGENT_DIR: agentDir,
      },
      apiRefused: () => refused(apiPort),
      output: () => output,
      stop,
      close,
    }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
