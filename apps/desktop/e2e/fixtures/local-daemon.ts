import { expect, test } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'
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
  repositories?:
    | string[]
    | ((
        layout: Pick<DaemonLayout, 'root' | 'home' | 'agentDir' | 'userData' | 'stateDir'>,
      ) => Promise<string[]>)
}

export type LocalDaemon = Awaited<ReturnType<typeof localDaemonFixture>>

/** Every folder and file the fixture hands the daemon or Desktop, all under `root`. */
function daemonLayout(root: string) {
  const home = join(root, 'home')
  const configHome = join(root, 'config')
  const stateHome = join(root, 'state')
  const configDir = join(configHome, 'phosphor-host')
  const folders = {
    home,
    configHome,
    configDir,
    stateHome,
    stateDir: join(stateHome, 'phosphor-host'),
    runtimeDir: join(root, 'run'),
    agentDir: join(root, 'agent'),
    userData: join(root, 'user-data'),
  }
  return {
    root,
    ...folders,
    folders: Object.values(folders),
    configPath: join(configDir, 'config.json'),
    ownerKeyPath: join(root, 'owner-key.pem'),
    /** What assert-scratch checks: the folders plus where a service install would write. */
    roots: {
      ...folders,
      launchAgents: join(home, 'Library', 'LaunchAgents'),
      systemdUnits: join(configHome, 'systemd', 'user'),
      ownerKey: join(root, 'owner-key.pem'),
    } as Record<string, string>,
  }
}

type DaemonLayout = ReturnType<typeof daemonLayout>

const pkcs8 = (key: KeyObject) => key.export({ type: 'pkcs8', format: 'pem' })
const raw = (key: KeyObject) => createPublicKey(key).export({ format: 'jwk' }).x

/** What `setup --local` would leave, written directly: config, identity, pairing, marker. */
async function writeDaemonWorld(layout: DaemonLayout, options: LocalDaemonOptions) {
  const { configDir, stateDir } = layout
  for (const folder of layout.folders) await mkdir(folder, { recursive: true, mode: 0o700 })
  const machine = generateKeyPairSync('ed25519').privateKey
  const owner = generateKeyPairSync('ed25519').privateKey
  const machineId = randomUUID()
  const now = new Date().toISOString()
  const apiPort = await closedPort()
  await json(layout.configPath, {
    version: 1,
    pi: {
      node: process.execPath,
      executable: join(project, 'apps/host/src/__fixtures__/fake-pi.cjs'),
    },
    repositories:
      typeof options.repositories === 'function'
        ? await options.repositories(layout)
        : (options.repositories ?? []),
    // Nothing listens on either port: an unenrolled daemon reaches neither.
    control: { url: `http://127.0.0.1:${await closedPort()}` },
    api: { port: apiPort },
  })
  await writeFile(join(configDir, HOST_SIDECARS.localKey), pkcs8(machine), { mode: 0o600 })
  await json(join(configDir, HOST_SIDECARS.localIdentity), {
    version: 1,
    machineId,
    createdAt: now,
    publicKey: raw(machine),
  })
  await json(join(configDir, HOST_SIDECARS.ownerClients), {
    version: 1,
    clients: [{ id: randomUUID(), label: OWNER_LABEL, publicKey: raw(owner), addedAt: now }],
  })
  // The marker last, as setup --local publishes it. No login-shell capture in a test.
  await json(join(configDir, HOST_SIDECARS.localMode), {
    version: 1,
    enabledAt: now,
    shellEnvironment: false,
  })
  await json(join(stateDir, HOST_SIDECARS.headroom), { version: 1, enabled: false })
  if (options.standby) await json(join(stateDir, HOST_SIDECARS.standby), { version: 1 })
  await writeFile(layout.ownerKeyPath, pkcs8(owner), { mode: 0o600 })
  return { machineId, apiPort }
}

/** `phosphor run` in the foreground with every HOME-derived folder in scratch. */
function spawnDaemon(layout: DaemonLayout) {
  let output = ''
  const child = spawn(
    process.execPath,
    [join(hostDist, 'phosphor.mjs'), 'run', '--config', layout.configPath],
    {
      env: {
        HOME: layout.home,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TMPDIR: layout.root,
        XDG_CONFIG_HOME: layout.configHome,
        XDG_STATE_HOME: layout.stateHome,
        XDG_RUNTIME_DIR: layout.runtimeDir,
        PI_CODING_AGENT_DIR: layout.agentDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-131072)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  child.on('exit', (code, signal) => {
    output += `\nDaemon exit code=${code} signal=${signal}\n`
  })
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000)
    try {
      await exited
    } finally {
      clearTimeout(kill)
    }
  }
  return { child, output: () => output, stop }
}

/** The socket `local.json` names, once its hello answers; checked against scratch and the byte limit. */
async function ownerSocket(
  layout: DaemonLayout,
  machineId: string,
  daemon: ReturnType<typeof spawnDaemon>,
) {
  let socket = ''
  await expect
    .poll(
      async () => {
        if (daemon.child.exitCode !== null) throw new Error(`The daemon exited: ${daemon.output()}`)
        const text = await readFile(join(layout.stateDir, HOST_SIDECARS.localRun), 'utf8').catch(
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
  assertScratchRoots({ socket }, [layout.root])
  if (Buffer.byteLength(socket) > FIXTURE_SOCKET_MAX_BYTES)
    throw new Error(`The owner socket path is ${Buffer.byteLength(socket)} bytes: ${socket}`)
  return socket
}

/** Writes the world, starts the daemon and resolves once its owner socket answers. */
export async function localDaemonFixture(options: LocalDaemonOptions = {}) {
  await buildHost()
  const layout = daemonLayout(realpathSync.native(mkdtempSync('/tmp/pd-')))
  assertScratchRoots(layout.roots, [layout.root])
  let daemon: ReturnType<typeof spawnDaemon> | undefined
  const close = async () => {
    const info = test.info()
    await info.attach('local-daemon.log', {
      body: daemon?.output() ?? '',
      contentType: 'text/plain',
    })
    const log = await readFile(join(layout.stateDir, 'logs/phosphor.log'), 'utf8').catch(() => '')
    await info.attach('local-daemon-runtime.log', {
      body: log.slice(-131072),
      contentType: 'text/plain',
    })
    try {
      await daemon?.stop()
    } finally {
      await rm(layout.root, { recursive: true, force: true })
    }
  }
  try {
    const { machineId, apiPort } = await writeDaemonWorld(layout, options)
    daemon = spawnDaemon(layout)
    const socket = await ownerSocket(layout, machineId, daemon)
    if (!(await refused(apiPort))) throw new Error('The daemon opened its TCP API.')
    return {
      root: layout.root,
      roots: { ...layout.roots, socket } as Readonly<Record<string, string>>,
      machineId,
      socket,
      apiPort,
      /** The env an unpackaged Desktop needs to run in daemon mode against this daemon. */
      desktopEnv: {
        PHOSPHOR_LOCAL_DAEMON_SOCKET: socket,
        PHOSPHOR_LOCAL_DAEMON_CONFIG: layout.configDir,
        PHOSPHOR_E2E_OWNER_KEY: layout.ownerKeyPath,
        PHOSPHOR_TEST_USER_DATA: layout.userData,
        PI_CODING_AGENT_DIR: layout.agentDir,
      },
      apiRefused: () => refused(apiPort),
      output: () => daemon?.output() ?? '',
      stop: () => daemon!.stop(),
      async restart() {
        await daemon!.stop()
        daemon = spawnDaemon(layout)
        await ownerSocket(layout, machineId, daemon)
        if (!(await refused(apiPort))) throw new Error('The restarted daemon opened its TCP API.')
      },
      close,
    }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
