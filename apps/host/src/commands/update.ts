import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { loadHostConfig } from '../config/load'
import { buildPiEnvironment } from '../machine/environment'
import { CLAUDE_PROVIDER_PACKAGE } from '../machine/claude'
import { setupTerminal, type SetupTerminal } from './setup-terminal'
import {
  lstatSync,
  mkdtempSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import {
  HOST_RELEASE_KEYS,
  HOST_RELEASE_MANIFEST_MAX_BYTES,
  HOST_RELEASE_VERSION_PATTERN,
  type HostReleaseKey,
} from '@phosphor/shared/host-release'
import { HOST_PROTOCOL_VERSION } from '@phosphor/shared/remote-host'
import { commandLayout, INSTALL_COMMAND, type InstalledLayout } from '../update/layout'
import { verifyReleaseArtifact, verifyReleaseManifest } from '../update/verify'
import { downloadRelease, releaseUrl } from '../update/download'
import { acquireInstallLock, hasCode } from '../update/lock'
import { atomicRecord, readBounded } from '../update/files'
import { decompressRelease, extractRelease } from '../update/archive'
import { readRunHealth } from '../update/health'
import { installLifetime, signalTurn } from '../update/lifetime'
import { HOST_AGENT } from '../machine/launchd'
import { HOST_UNIT, serviceRunner } from '../machine/systemd'
import { hostStateDirectory } from '../lanes/state-dir'
import { runService, type ServiceContext } from './service'

export interface UpdateContext extends ServiceContext {
  json?: boolean
  packages?: typeof listPackages
  setupTerminal?: SetupTerminal
  update?: {
    node?: string
    bundle?: string
    keys?: readonly HostReleaseKey[]
    expandedCap?: number
    /** This process's /proc/self/cgroup, for the Host-terminal handoff. */
    cgroup?: () => string
  }
}
export interface UpdateOptions {
  version?: string
  check?: boolean
  rollback?: boolean
}
export class UpdateFailure extends Error {
  constructor(
    message: string,
    readonly exitCode = 75,
  ) {
    super(message)
  }
}
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return 0
}
export function installedVersion(layout: InstalledLayout, version: unknown): version is string {
  if (typeof version !== 'string' || !HOST_RELEASE_VERSION_PATTERN.test(version)) return false
  try {
    const folder = join(layout.lib, 'versions', version)
    if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) return false
    return (
      readBounded(join(folder, 'VERSION'), 32).replace(/\n+$/, '') === version &&
      ['bin/phosphor', 'node/bin/node', 'lib/phosphor.mjs'].every(
        (name) =>
          lstatSync(join(folder, name)).isFile() &&
          realpathSync(join(folder, name)) === join(folder, name),
      )
    )
  } catch {
    return false
  }
}
function select(layout: InstalledLayout, current: string, previous: string): void {
  const link = join(layout.lib, `.current-${process.pid}`)
  const before = readlinkSync(layout.current)
  try {
    symlinkSync(`versions/${current}`, link)
    renameSync(link, layout.current)
    try {
      atomicRecord(join(layout.lib, 'install.json'), { current, previous }, 0o644)
    } catch (error) {
      symlinkSync(before, link)
      renameSync(link, layout.current)
      throw error
    }
  } finally {
    rmSync(link, { force: true })
  }
}
export async function serviceState(
  context: ServiceContext,
): Promise<{ installed: boolean; running: boolean }> {
  const runner =
    context.service?.runner ?? serviceRunner(context.env, context.print, context.signal)
  if (context.platform === 'darwin') {
    const status = await runner('launchctl', ['print', `gui/${context.uid}/${HOST_AGENT}`])
    const loaded = status.code === 0
    const running =
      loaded &&
      status.stdout.length <= 65536 &&
      /^[\t ]*(?:state = running|pid = [1-9][0-9]{0,9})[\t ]*\r?$/m.test(status.stdout)
    return {
      installed:
        loaded || exists(join(context.home, 'Library/LaunchAgents', `${HOST_AGENT}.plist`)),
      running,
    }
  }
  if (context.platform !== 'linux') return { installed: false, running: false }
  const running = await runner('systemctl', ['--user', 'is-active', '--quiet', HOST_UNIT])
    .then((result) => result.code === 0)
    .catch(() => false)
  return {
    installed:
      running ||
      exists(
        join(
          context.env.XDG_CONFIG_HOME ?? join(context.home, '.config'),
          'systemd/user',
          HOST_UNIT,
        ),
      ),
    running,
  }
}
function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}
async function restartHealthy(
  context: UpdateContext,
  version: string,
  signal: AbortSignal,
): Promise<boolean> {
  const now = context.now ?? Date.now
  const after = now()
  const restarted = (await runService({ ...context, signal }, 'restart')) === 0
  // A signal that also ended systemctl says nothing about health; rollback would race the restart.
  signal.throwIfAborted()
  if (!restarted) return false
  const wait = context.wait ?? ((ms, signal) => setTimeout(ms, undefined, { signal }))
  for (let i = 0; i <= 90; i++) {
    signal.throwIfAborted()
    const record = readRunHealth(hostStateDirectory(context.env, context.home))
    if (
      record?.version === version &&
      record.startedAt >= after &&
      record.acceptedAt >= after &&
      record.acceptedAt <= now()
    )
      return true
    if (i < 90) await wait(1000, signal)
  }
  return false
}
function prune(layout: InstalledLayout, current: string, previous: string): void {
  const names = readdirSync(join(layout.lib, 'versions'))
  if (names.length > 4096) throw new UpdateFailure('Too many installed versions.')
  const older = names
    .filter((v) => v !== current && v !== previous && installedVersion(layout, v))
    .sort((a, b) => compareVersions(b, a))
  for (const version of older.slice(1))
    rmSync(join(layout.lib, 'versions', version), { recursive: true })
}
/** Bounds the provider update so a stalled pi or npm never holds the Host update open. */
export const CLAUDE_PROVIDER_UPDATE_TIMEOUT_MS = 120_000

/** Provider updates are best effort and never roll back a verified Host release. */
export async function updateClaudeProvider(
  context: UpdateContext,
  lifetime?: AbortSignal,
): Promise<void> {
  const bounded = AbortSignal.timeout(CLAUDE_PROVIDER_UPDATE_TIMEOUT_MS)
  const signal = lifetime ? AbortSignal.any([lifetime, bounded]) : bounded
  try {
    signal.throwIfAborted()
    const packages = await (context.packages ?? listPackages)()
    signal.throwIfAborted()
    if (!packages.some((pkg) => pkg.name === CLAUDE_PROVIDER_PACKAGE && pkg.installed)) return
    const loaded = await loadHostConfig(context.configPath, context.uid)
    if (!loaded.ok) throw new Error('config')
    const config = loaded.config
    const environment = buildPiEnvironment({
      hostEnv: context.env,
      platform: context.platform,
      ...config.environment,
      nodePath: config.pi.node,
    })
    const terminal =
      context.setupTerminal ?? setupTerminal(environment.env, signal, context.json ? 2 : 1)
    const args = [
      ...(config.pi.node ? [config.pi.executable] : []),
      'update',
      `npm:${CLAUDE_PROVIDER_PACKAGE}`,
    ]
    if ((await terminal.run(config.pi.node ?? config.pi.executable, args)) !== 0)
      throw new Error('update')
  } catch {
    // Cancellation (SIGTERM, Ctrl-C) ends the update; only the provider's own failure is a warning.
    lifetime?.throwIfAborted()
    context.print(
      'Warning: Claude provider update failed. Run: pi update npm:@saccolabs/pi-claude-cli',
    )
  }
}

export async function runUpdate(
  context: UpdateContext,
  options: UpdateOptions = {},
): Promise<number> {
  return installLifetime(context.attach, async (signal) => {
    let stage: string | undefined, release: (() => void) | undefined
    let published: string | undefined,
      selected = false
    try {
      if (
        (options.version !== undefined && !HOST_RELEASE_VERSION_PATTERN.test(options.version)) ||
        (options.rollback && (options.version !== undefined || options.check))
      )
        throw new UpdateFailure('Invalid update options.', 64)
      const layout = commandLayout(context.home, context.update?.node, context.update?.bundle)
      if (!layout)
        throw new UpdateFailure(
          `this Host was installed from source; install a release with: ${INSTALL_COMMAND}`,
          69,
        )
      release = acquireInstallLock(layout.lib)
      signal.throwIfAborted()
      if (
        commandLayout(context.home, context.update?.node, context.update?.bundle)?.version !==
        layout.version
      )
        throw new UpdateFailure('Install changed; retry update.')
      let version: string
      let notice: string | undefined
      if (options.rollback) {
        const record: unknown = JSON.parse(readBounded(join(layout.lib, 'install.json'), 1024))
        if (
          !record ||
          typeof record !== 'object' ||
          !('current' in record) ||
          record.current !== layout.version ||
          !('previous' in record) ||
          !installedVersion(layout, record.previous) ||
          record.previous === layout.version
        )
          throw new UpdateFailure('No valid previous version is installed.', 69)
        version = record.previous
      } else {
        const keys = context.update?.keys ?? HOST_RELEASE_KEYS
        if (!keys.length) throw new UpdateFailure('No Host release keys are pinned.', 69)
        const tag = options.version ? `host-v${options.version}` : 'host-latest'
        const name = options.version
          ? `phosphor-host-${options.version}.manifest.json`
          : 'phosphor-host.manifest.json'
        const manifest = await downloadRelease(
          releaseUrl(context.env, tag, name),
          HOST_RELEASE_MANIFEST_MAX_BYTES,
          signal,
        )
        const signature = await downloadRelease(
          releaseUrl(context.env, tag, `${name}.sig`),
          8192,
          signal,
        )
        const signed = verifyReleaseManifest(manifest, signature.toString('utf8'), keys)
        version = signed.version
        if (options.version && version !== options.version)
          throw new UpdateFailure('Release version does not match the request.', 64)
        if (compareVersions(version, layout.version) < 0)
          throw new UpdateFailure('refusing to downgrade', 64)
        const artifact = signed.artifacts.find(
          (a) => a.target === `${context.platform}-${context.arch ?? process.arch}`,
        )
        if (!artifact || !signed.protocols.some((p) => p >= HOST_PROTOCOL_VERSION))
          throw new UpdateFailure('Release does not support this Host.', 69)
        // A newer protocol is how a Host catches up with updated apps; say so when it drops ours.
        if (!signed.protocols.includes(HOST_PROTOCOL_VERSION))
          notice =
            'This release speaks a newer Host protocol: apps that have not updated cannot connect.'
        if (options.check) {
          release()
          release = undefined
          await signalTurn()
          signal.throwIfAborted()
          context.print(`Installed: ${layout.version}; available: ${version}`)
          if (notice) context.print(notice)
          return 0
        }
        if (version === layout.version) {
          release()
          release = undefined
          await signalTurn()
          signal.throwIfAborted()
          await updateClaudeProvider(context, signal)
          context.print('already up to date')
          return 0
        }
        if (exists(join(layout.lib, 'versions', version)))
          throw new UpdateFailure(
            'Version folder already exists; use update --rollback or remove it first.',
            69,
          )
        stage = mkdtempSync(join(layout.lib, '.staging-'))
        let bytes = await downloadRelease(
          releaseUrl(context.env, `host-v${version}`, artifact.file),
          artifact.bytes,
          signal,
        )
        verifyReleaseArtifact(bytes, artifact)
        const tar = decompressRelease(bytes, context.update?.expandedCap)
        // Drop the compressed buffer here. Peak is compressed plus decompressed,
        // each capped at 256 MiB (512 MiB total, plus small verification buffers).
        bytes = Buffer.alloc(0)
        extractRelease(tar, stage, context.update?.expandedCap)
        if (
          readBounded(join(stage, 'VERSION'), 32).replace(/\n+$/, '') !== version ||
          !['bin/phosphor', 'node/bin/node', 'lib/phosphor.mjs'].every((n) =>
            lstatSync(join(stage ?? '', n)).isFile(),
          )
        )
          throw new UpdateFailure('Invalid release bundle.')
      }
      const service = await serviceState(context)
      signal.throwIfAborted()
      // All publication calls are synchronous. Signals abort only at the next boundary.
      if (stage) {
        const destination = join(layout.lib, 'versions', version)
        renameSync(stage, destination)
        published = destination
        stage = undefined
      }
      select(layout, version, layout.version)
      selected = true
      signal.throwIfAborted()
      if (service.installed && (service.running || options.rollback)) {
        if (!(await restartHealthy(context, version, signal))) {
          select(layout, layout.version, version)
          await runService({ ...context, signal }, 'restart')
          throw new UpdateFailure(
            `update to ${version} failed its health check; rolled back to ${layout.version}`,
          )
        }
      }
      prune(layout, version, layout.version)
      release()
      release = undefined
      await signalTurn()
      signal.throwIfAborted()
      if (!service.installed || (!service.running && !options.rollback))
        context.print(`restart phosphor run to use ${version}`)
      if (!options.rollback) await updateClaudeProvider(context, signal)
      context.print(`Selected Host ${version}.`)
      if (notice) context.print(notice)
      return 0
    } catch (error) {
      if (signal.aborted) return typeof signal.reason === 'number' ? signal.reason : 70
      context.print(
        error instanceof UpdateFailure ||
          (error instanceof Error && error.message.startsWith('Install lock:'))
          ? error.message
          : 'Host update failed; no unverified release was selected.',
      )
      return error instanceof UpdateFailure ? error.exitCode : 75
    } finally {
      if (stage) rmSync(stage, { recursive: true, force: true })
      if (published && !selected && realpathSync(join(published, '../../current')) !== published)
        rmSync(published, { recursive: true, force: true })
      release?.()
    }
  })
}
