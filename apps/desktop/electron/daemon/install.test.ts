import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MACHINE_ID, fakeSetup, scratchMachine } from './__fixtures__/machine'
import { attemptDaemonInstall, createDaemonInstall, type DaemonInstallStatus } from './install'

const machines: ReturnType<typeof scratchMachine>[] = []
afterEach(() => {
  for (const m of machines.splice(0)) m.cleanup()
})
function machine() {
  const m = scratchMachine()
  machines.push(m)
  return m
}
const signal = () => new AbortController().signal
const setupArgs = (home: string) =>
  readFileSync(join(home, 'setup-args'), 'utf8').trim().split('\n')
const nothingInstalled = (lib: string) => !existsSync(join(lib, 'current'))

describe('attemptDaemonInstall', () => {
  it('keeps every path under the scratch root', () => {
    const m = machine()
    const real = homedir()
    for (const path of [m.roots.home, m.roots.lib, m.roots.agentDir, m.roots.serviceFile])
      expect(path.startsWith(`${m.root}/`) && !path.startsWith(`${real}/.`)).toBe(true)
  })
  it('stays in-app and changes nothing while the v2 manifest is missing', async () => {
    const m = machine()
    m.mirror.publish({ v2: 'absent' })
    const status = await attemptDaemonInstall(m.ports, signal())
    expect(status).toMatchObject({ state: 'waiting', reason: 'no-v2' })
    expect(existsSync(m.roots.lib)).toBe(false)
  })
  it('does nothing when the v2 manifest lacks the local-service features', async () => {
    const m = machine()
    m.mirror.publish({ features: ['local-mode'] })
    expect(await attemptDaemonInstall(m.ports, signal())).toMatchObject({
      state: 'waiting',
      reason: 'no-features',
    })
    expect(existsSync(m.roots.lib)).toBe(false)
  })
  it('publishes nothing when the staged bundle lacks owner-socket', async () => {
    const m = machine()
    m.mirror.publish({ bundleFeatures: ['local-mode'] })
    expect(await attemptDaemonInstall(m.ports, signal())).toMatchObject({ state: 'failed' })
    expect(nothingInstalled(m.roots.lib)).toBe(true)
    expect(readdirSync(join(m.roots.lib, 'versions'))).toEqual([])
    expect(readdirSync(m.roots.lib).filter((name) => name.startsWith('.staging-'))).toEqual([])
  })
  it('installs a verified release, pairs it in standby with the owner key and adds the launcher', async () => {
    const m = machine()
    m.mirror.publish({ files: { 'bin/phosphor': fakeSetup() } })
    const steps: DaemonInstallStatus[] = []
    const status = await attemptDaemonInstall(m.ports, signal(), (s) => steps.push(s))
    const program = join(m.roots.lib, 'current/bin/phosphor')
    expect(status).toEqual({
      state: 'installed',
      version: '1.2.3',
      program,
      machineId: MACHINE_ID,
      launcher: 'created',
    })
    expect(steps.map((s) => s.state)).toEqual(['checking', 'installing', 'installing'])
    expect(readlinkSync(join(m.roots.lib, 'current'))).toBe('versions/1.2.3')
    expect(readlinkSync(join(m.roots.home, '.local/bin/phosphor'))).toBe(program)
    const key = await m.ports.ownerKey()
    if (!key.ok) throw new Error(key.reason)
    expect(setupArgs(m.roots.home)).toEqual([
      'setup',
      '--local',
      '--json',
      '--standby',
      '--pi',
      '/opt/pi/bin/pi',
      '--owner-id',
      key.key.id,
      '--owner-key',
      key.key.publicKey,
      '--owner-label',
      'Phosphor Desktop',
    ])
    const env = readFileSync(join(m.roots.home, 'setup-env'), 'utf8')
    expect(env).toContain(`HOME=${m.roots.home}\n`)
    expect(env).toContain('PATH=/opt/pi/bin:/usr/bin:/bin\n')
    expect(env).toContain(`XDG_STATE_HOME=${m.roots.home}/.local/state\n`)
    expect(env).not.toContain('ELECTRON')
  })
  it('adopts a release install that was set up, with the features, by running setup only', async () => {
    const m = machine()
    m.installed('1.2.0', ['local-mode', 'owner-socket'])
    m.setUp()
    m.mirror.publish()
    for (const name of readdirSync(m.mirror.assets).filter((n) => n.endsWith('.tar.gz')))
      rmSync(join(m.mirror.assets, name))
    expect(await attemptDaemonInstall(m.ports, signal())).toMatchObject({
      state: 'installed',
      version: '1.2.0',
    })
    expect(setupArgs(m.roots.home)).toContain('--standby')
  })
  it('asks for an update when the installed release that was set up lacks the features', async () => {
    const m = machine()
    m.installed('1.0.0', [])
    m.setUp()
    m.mirror.publish()
    expect(await attemptDaemonInstall(m.ports, signal())).toMatchObject({
      state: 'blocked',
      reason: 'needs-update',
      installed: '1.0.0',
    })
    expect(existsSync(join(m.roots.home, 'setup-args'))).toBe(false)
  })
  it('installs a newer release over one that was never set up, then sets that one up', async () => {
    // A first setup that failed leaves the release and no service: retrying it would fail again.
    const m = machine()
    m.installed('1.2.0', ['local-mode', 'owner-socket'])
    writeFileSync(join(m.roots.lib, 'versions/1.2.0/bin/phosphor'), fakeSetup(69, ['old']))
    m.mirror.publish({ files: { 'bin/phosphor': fakeSetup() } })
    expect(await attemptDaemonInstall(m.ports, signal())).toMatchObject({
      state: 'installed',
      version: '1.2.3',
    })
    expect(readlinkSync(join(m.roots.lib, 'current'))).toBe('versions/1.2.3')
    expect(readdirSync(join(m.roots.lib, 'versions')).sort()).toEqual(['1.2.0', '1.2.3'])
    expect(readdirSync(m.roots.lib).filter((name) => name.startsWith('.'))).toEqual([])
  })
  it('finishes a newer release an earlier attempt unpacked but never made current', async () => {
    const m = machine()
    m.installed('1.2.0', ['local-mode', 'owner-socket'])
    m.mirror.publish({ files: { 'bin/phosphor': fakeSetup() } })
    await attemptDaemonInstall(m.ports, signal())
    // Stopped after unpacking 1.2.3 and before switching `current`; its download is gone too.
    rmSync(join(m.roots.lib, 'current'))
    symlinkSync('versions/1.2.0', join(m.roots.lib, 'current'))
    for (const name of readdirSync(m.mirror.assets).filter((n) => n.endsWith('.tar.gz')))
      rmSync(join(m.mirror.assets, name))
    expect(await attemptDaemonInstall(m.ports, signal())).toMatchObject({
      state: 'installed',
      version: '1.2.3',
    })
    expect(readlinkSync(join(m.roots.lib, 'current'))).toBe('versions/1.2.3')
  })
  it('never adopts a source Host, and leaves its service file alone', async () => {
    const m = machine()
    m.mirror.publish()
    mkdirSync(dirname(m.roots.serviceFile), { recursive: true })
    writeFileSync(m.roots.serviceFile, 'ours')
    const status = await attemptDaemonInstall(m.ports, signal())
    expect(status).toMatchObject({ state: 'blocked', reason: 'source-install' })
    expect(status.state === 'blocked' && status.detail).toContain('Install a release with curl')
    expect(readFileSync(m.roots.serviceFile, 'utf8')).toBe('ours')
    expect(existsSync(m.roots.lib)).toBe(false)
  })
  it('never starts beside another daemon that owns the lanes', async () => {
    const m = machine()
    m.mirror.publish()
    const holder = {
      version: 1 as const,
      owner: 'daemon' as const,
      pid: 4242,
      processStart: null,
      token: 't',
      startedAt: 'now',
      program: 'phosphor',
    }
    const ports = {
      ...m.ports,
      inspect: { readLock: () => Promise.resolve(holder), lockLive: () => Promise.resolve(true) },
    }
    expect(await attemptDaemonInstall(ports, signal())).toMatchObject({
      state: 'blocked',
      reason: 'daemon-owns-lanes',
      pid: 4242,
      detail: "Another Phosphor daemon owns this Mac's lanes (pid 4242).",
    })
    expect(existsSync(m.roots.lib)).toBe(false)
  })
  it('installs nothing without protected storage for the owner key', async () => {
    const m = machine()
    m.mirror.publish()
    const ports = {
      ...m.ports,
      ownerKey: () => Promise.resolve({ ok: false as const, reason: 'no keychain' }),
    }
    expect(await attemptDaemonInstall(ports, signal())).toMatchObject({
      state: 'blocked',
      reason: 'owner-key',
    })
    expect(existsSync(m.roots.lib)).toBe(false)
  })
  it('reports a failed setup with its notes', async () => {
    const m = machine()
    m.mirror.publish({ files: { 'bin/phosphor': fakeSetup(69, ['pi is missing.']) } })
    expect(await attemptDaemonInstall(m.ports, signal())).toEqual({
      state: 'failed',
      detail: 'pi is missing.',
    })
  })
})

describe('createDaemonInstall', () => {
  it('is off, and never checks, when the roots are off', () => {
    const install = createDaemonInstall(
      { on: false, reason: 'dev' },
      {
        ownerKey: () => Promise.reject(new Error('unused')),
        findPi: () => Promise.reject(new Error('unused')),
        shellPath: () => Promise.reject(new Error('unused')),
      },
    )
    install.start()
    expect(install.status()).toEqual({ state: 'off', detail: 'dev' })
  })
  it('publishes each attempt and retries while the release is missing', async () => {
    const m = machine()
    m.mirror.publish({ v2: 'absent' })
    const timers: (() => void)[] = []
    const seen: string[] = []
    const install = createDaemonInstall(
      { on: true, roots: m.roots },
      { ...m.ports, watch: { setTimer: (run) => (timers.push(run), () => {}) } },
    )
    install.subscribe((s) => seen.push(s.state))
    expect(install.status()).toEqual({ state: 'idle' })
    install.start()
    await expect.poll(() => install.status().state).toBe('waiting')
    expect(timers).toHaveLength(1)
    m.mirror.publish({ files: { 'bin/phosphor': fakeSetup() } })
    timers[0]!()
    await expect.poll(() => install.status().state).toBe('installed')
    expect(seen).toEqual([
      'checking',
      'waiting',
      'checking',
      'installing',
      'installing',
      'installed',
    ])
    install.stop()
  })
})
