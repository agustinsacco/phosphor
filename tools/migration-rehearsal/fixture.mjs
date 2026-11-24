import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'
import { createPublicKey, generateKeyPairSync, randomInt, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { clearTimeout, setTimeout } from 'node:timers'
import { dirname, join, resolve } from 'node:path'

const project = resolve(import.meta.dirname, '../..')
export const desktop = join(project, 'apps/desktop')
export const electron = join(
  desktop,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
)
const sandbox = '/usr/bin/sandbox-exec'
export const features = ['local-mode', 'owner-socket']
const json = (path, data) =>
  writeFile(path, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600 })

// Source and repo paths need not be simple. Pass Seatbelt parameters, never interpolate them as code.
export function fence(root, roots, sources) {
  const home = userInfo().homedir
  const params = { ROOT: root, SOCKET: roots.socket, PROJECT: project }
  const protectedDirs = [
    sources.userData,
    sources.agent,
    ...[
      '.claude',
      '.codex',
      '.pi/agent',
      '.ssh',
      '.config/phosphor-host',
      '.local/state/phosphor-host',
      'Library/Keychains',
      'Library/Application Support/Phosphor',
      'Library/Application Support/pidex',
      'Desktop',
      'Documents',
      'Downloads',
      'Library/Mobile Documents',
    ].map((p) => join(home, p)),
    '/Volumes',
  ]
  let profile = `(version 1) (allow default)
    (deny file-write*) (allow file-write* (subpath (param "ROOT")) (literal "/dev/null"))
    (deny network*) (allow network-bind network-inbound network-outbound (literal (param "SOCKET")))
    (deny signal) (allow signal (target same-sandbox))
    (deny appleevent-send)
    (deny mach-lookup (global-name "com.apple.SecurityServer") (global-name-prefix "com.apple.securityd"))`
  for (const [i, path] of protectedDirs.entries()) {
    params[`P${i}`] = path
    profile += `\n(deny file-read-data (require-all (subpath (param "P${i}")) (require-not (subpath (param "PROJECT")))))`
  }
  return [...Object.entries(params).map(([k, v]) => `-D${k}=${v}`), '-p', profile]
}

export function fixtureEnv({ root, roots }) {
  return {
    HOME: roots.home,
    CFFIXED_USER_HOME: roots.home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    TMPDIR: root,
    XDG_CONFIG_HOME: dirname(roots.config),
    XDG_STATE_HOME: dirname(roots.state),
    XDG_RUNTIME_DIR: roots.runtime,
    XDG_CACHE_HOME: join(roots.home, '.cache'),
    PI_CODING_AGENT_DIR: roots.agent,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    PHOSPHOR_ACCOUNT_NO_KEYCHAIN: '1',
    PHOSPHOR_MIGRATE: '1',
    PHOSPHOR_TEST_USER_DATA: roots.userData,
    PHOSPHOR_E2E_SERVICE_FEATURES: features.join(','),
    PHOSPHOR_LOCAL_DAEMON_SOCKET: roots.socket,
    PHOSPHOR_LOCAL_DAEMON_CONFIG: roots.config,
    PHOSPHOR_E2E_OWNER_KEY: roots.ownerKey,
    PHOSPHOR_PI_STUB: join(desktop, 'e2e/fixtures/pi-stub.cjs'),
  }
}

/** Match E1: unenrolled, standby, no shell capture, fake pi, scratch-only ephemeral pairing. */
export async function seedDaemon(roots) {
  for (const folder of [roots.config, roots.state, roots.home, roots.runtime])
    await mkdir(folder, { recursive: true, mode: 0o700 })
  const machineId = randomUUID(),
    now = new Date().toISOString()
  const key = () => generateKeyPairSync('ed25519').privateKey
  const machine = key(),
    owner = key()
  const pkcs8 = (k) => k.export({ type: 'pkcs8', format: 'pem' })
  const raw = (k) => createPublicKey(k).export({ format: 'jwk' }).x
  await json(join(roots.config, 'config.json'), {
    version: 1,
    pi: {
      node: process.execPath,
      executable: join(project, 'apps/host/src/__fixtures__/fake-pi.cjs'),
    },
    repositories: [],
    control: { url: `http://127.0.0.1:${randomInt(49152, 65536)}` },
    api: { port: randomInt(49152, 65536) },
  })
  await json(join(roots.config, 'local-identity.json'), {
    version: 1,
    machineId,
    createdAt: now,
    publicKey: raw(machine),
  })
  await json(join(roots.config, 'owner-clients.json'), {
    version: 1,
    clients: [{ id: randomUUID(), label: 'Phosphor Desktop', publicKey: raw(owner), addedAt: now }],
  })
  await json(join(roots.config, 'local-mode.json'), {
    version: 1,
    enabledAt: now,
    shellEnvironment: false,
  })
  await json(join(roots.state, 'headroom.json'), { version: 1, enabled: false })
  await json(join(roots.state, 'owner-standby.json'), { version: 1 })
  await writeFile(join(roots.config, 'local-key.pem'), pkcs8(machine), { flag: 'wx', mode: 0o600 })
  await writeFile(roots.ownerKey, pkcs8(owner), { flag: 'wx', mode: 0o600 })
  return machineId
}

/** The real Host must advertise the features too. Also serves as a sandbox profile-load check. */
export function supportsMigration(profile, host, env) {
  const text = execFileSync(sandbox, [...profile, process.execPath, host, 'version', '--json'], {
    cwd: env.HOME,
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 65536,
  })
  const list = JSON.parse(text).features
  return Array.isArray(list) && features.every((f) => list.includes(f))
}

/**
 * `output` is a scratch file descriptor for the child's stdout and stderr, private to the run.
 * @param {number | 'ignore'} [output]
 */
export function startChild(profile, program, args, env, output = 'ignore') {
  const child = spawn(sandbox, [...profile, program, ...args], {
    cwd: env.HOME,
    env,
    stdio: ['ignore', output, output],
    detached: true,
  })
  let stopped = false
  const exited = new Promise((resolve) => {
    child.on('error', () => {
      stopped = true
      resolve(null)
    })
    child.on('exit', (code, signal) => {
      stopped = true
      resolve(code ?? signal)
    })
  })
  const signal = (name) => {
    if (!stopped && child.pid) {
      try {
        process.kill(-child.pid, name)
      } catch (err) {
        if (err.code !== 'ESRCH') throw err
      }
    }
  }
  return {
    running: () => !stopped,
    pid: child.pid,
    exited,
    stop: () => signal('SIGKILL'),
    /** As a person quits: SIGTERM, then SIGKILL after 15 s. */
    async quit() {
      signal('SIGTERM')
      const timer = setTimeout(() => signal('SIGKILL'), 15000)
      await exited
      clearTimeout(timer)
    },
  }
}

/** The LaunchAgent's `KeepAlive {SuccessfulExit: false}`: start again after a non-zero exit. */
export function supervise(launch) {
  let current = launch(),
    stopping = false
  const exits = []
  const watch = (child) =>
    child.exited.then((code) => {
      exits.push(code)
      if (stopping || code === 0) return
      current = launch()
      return watch(current)
    })
  // A failed restart is evidence too: the run sees the service down and reports it.
  watch(current).catch(() => exits.push('restart-failed'))
  return {
    get pid() {
      return current.pid
    },
    running: () => current.running(),
    exits,
    stop: () => {
      stopping = true
      current.stop()
    },
  }
}

/** One `phosphor` CLI command against the scratch service, inside the same fence. */
export function cli(profile, host, env, args) {
  try {
    const out = execFileSync(sandbox, [...profile, process.execPath, host, ...args], {
      cwd: env.HOME,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { code: 0, out }
  } catch (err) {
    return { code: err.status ?? 1, out: err.stdout ?? '' }
  }
}
