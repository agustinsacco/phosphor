import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { installedLayout } from '@phosphor/session-runtime/host-install/layout'
import { probeStagedBundle } from '@phosphor/session-runtime/host-install/probe'
import {
  isOwnerLockHolderLive,
  readOwnerLock,
} from '@phosphor/session-runtime/owner-lock/owner-lock'
import type { OwnerLockRecord } from '@phosphor/session-runtime/owner-lock/types'
import type { DaemonRoots } from './roots'

/**
 * What already runs or is installed for this user, read-only (D2 §3.10,
 * "Adopting an existing install"). Nothing here writes, moves or removes.
 */
export type ExistingService =
  | { kind: 'none' }
  /** A release install under `lib`; `features` is empty when its `version --json` gave none. */
  | { kind: 'release'; version: string; features: readonly string[] }
  /** Our plist or unit exists with no release install: a Host run from source. */
  | { kind: 'source'; file: string }
  /** A live daemon holds the owner lock: it runs this machine's lanes. */
  | { kind: 'daemon'; pid: number }
  | { kind: 'unrecognised'; detail: string }

export interface InspectPorts {
  probe?: (folder: string, signal: AbortSignal) => Promise<{ features: string[] }>
  readLock?: (agentDir: string) => Promise<OwnerLockRecord | null>
  lockLive?: (record: OwnerLockRecord) => Promise<boolean>
}

function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return false
    throw error
  }
}

async function releaseInstall(
  roots: DaemonRoots,
  signal: AbortSignal,
  probe: NonNullable<InspectPorts['probe']>,
): Promise<ExistingService | null> {
  const current = join(roots.lib, 'current')
  if (!present(current)) return null
  const layout = installedLayout(
    join(current, 'node/bin/node'),
    join(current, 'lib/phosphor.mjs'),
    roots.home,
  )
  if (!layout)
    return {
      kind: 'unrecognised',
      detail: `${current} is not a Phosphor service release install.`,
    }
  // An older Host may not answer `version --json`: it then lacks the features.
  const features = await probe(join(layout.lib, 'versions', layout.version), signal).then(
    (bundle) => bundle.features,
    () => [],
  )
  return { kind: 'release', version: layout.version, features }
}

export async function inspectExisting(
  roots: DaemonRoots,
  signal: AbortSignal,
  ports: InspectPorts = {},
): Promise<ExistingService> {
  const holder = await (ports.readLock ?? readOwnerLock)(roots.agentDir)
  if (holder?.owner === 'daemon' && (await (ports.lockLive ?? isOwnerLockHolderLive)(holder)))
    return { kind: 'daemon', pid: holder.pid }
  const release = await releaseInstall(roots, signal, ports.probe ?? probeStagedBundle)
  if (release) return release
  if (present(roots.serviceFile)) return { kind: 'source', file: roots.serviceFile }
  return { kind: 'none' }
}
