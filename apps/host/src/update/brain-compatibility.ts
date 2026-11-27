import { lstatSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { hostStateDirectory } from '@phosphor/shared/host-local'
import { isOwnerPrivate } from '@phosphor/session-runtime/fs-safety'
import {
  BRAIN_COMPATIBILITY_MESSAGE,
  BRAIN_COMPATIBILITY_PIN,
  requiresBrainCompatibility,
  statIfPresent,
} from '@phosphor/session-runtime/host-install/brain-compatibility'
import { UpdateFailure } from '@phosphor/session-runtime/host-install/fetch'
import { checkedFolder, readBounded } from '@phosphor/session-runtime/host-install/files'
import { commandLayout, type InstalledLayout } from '@phosphor/session-runtime/host-install/layout'
import { acquireInstallLock } from '@phosphor/session-runtime/host-install/lock'
import { packagedNodeVersion, resolvePackagedBrainRuntime } from '../brain/packaged-runtime'
import { syncDirectory, writeRecord } from '../brain-handover/layout'

const PIN_RECORD = '1\n'

interface BrainInstall {
  home: string
  uid: number | undefined
  node?: string
  bundle?: string
  resourceRoot?: string
}

/** Ownership is only granted to the currently selected, lockable and qualified release. */
export function pinBrainCompatibility({
  home,
  uid,
  node,
  bundle,
  resourceRoot,
}: BrainInstall): void {
  const layout = commandLayout(home, node, bundle)
  if (!layout || !checkedFolder(layout.lib, layout.lib, home, uid))
    throw new Error('Host Brain needs an installed, qualified release.')
  const release = acquireInstallLock(layout.lib)
  try {
    const resources = join(layout.lib, 'versions', layout.version, 'lib')
    if (
      commandLayout(home, node, bundle)?.version !== layout.version ||
      (resourceRoot !== undefined && realpathSync(resourceRoot) !== resources) ||
      !resolvePackagedBrainRuntime(resources)
    )
      throw new Error('The selected Host bundle is not qualified for Brain.')
    retainBrainCompatibility(layout.lib, uid)
  } finally {
    release()
  }
}

/** Writes a requirement, not an ownership claim. Caller holds the install lock. */
export function retainBrainCompatibility(lib: string, uid: number | undefined): void {
  const pin = join(lib, BRAIN_COMPATIBILITY_PIN)
  const info = statIfPresent(pin)
  if (!info) writeRecord(pin, 1)
  else {
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      !isOwnerPrivate(info, uid) ||
      readBounded(pin, 2) !== PIN_RECORD
    )
      throw new Error('The Brain compatibility pin is unsafe.')
    // A previous write can have reached rename but been interrupted before directory fsync.
    syncDirectory(lib)
  }
}

interface ReplacementContext {
  home: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  arch?: string
}

/** Called while holding the install lock, before publishing/selecting a replacement. */
export function requireCompatibleBrainBundle(
  context: ReplacementContext,
  layout: InstalledLayout,
  candidate: string,
): void {
  const { home, env, platform, arch } = context
  if (!requiresBrainCompatibility(layout.lib, home, hostStateDirectory(env, home))) return
  const resourceRoot = join(candidate, 'lib')
  // First check the static qualification contract, then verify the actual bundled Node version.
  // Only signed/extracted or already-validated installed version folders reach this function.
  if (qualifiedCandidate(candidate, resourceRoot, platform, arch ?? process.arch)) return
  throw new UpdateFailure(BRAIN_COMPATIBILITY_MESSAGE, 69)
}

function qualifiedCandidate(
  candidate: string,
  resourceRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): boolean {
  try {
    // The precheck prevents even launching a binary from an ordinary or incomplete bundle.
    if (
      arch !== 'arm64' ||
      !resolvePackagedBrainRuntime(resourceRoot, { platform, arch, version: packagedNodeVersion })
    )
      return false
    const node = join(candidate, 'node/bin/node')
    if (realpathSync(node) !== node || !lstatSync(node).isFile()) return false
    const version = execFileSync(node, ['--version'], {
      encoding: 'utf8',
      cwd: candidate,
      env: { PATH: '/usr/bin:/bin' },
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: 256,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return version === packagedNodeVersion
  } catch {
    return false
  }
}
