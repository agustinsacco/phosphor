import { lstatSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { OwnerCallError } from '@phosphor/host-client/owner'
import {
  emptyBrainDirectory,
  readLocalBrainSelection,
  selectLocalBrainOwner,
  syncBrainPath,
} from '@phosphor/session-runtime/brain/local-owner'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import type { OwnerCalls } from '@phosphor/shared/host-protocol-owner'
import {
  brainHandoverPaths,
  desktopBrainOwner,
  isBrainTombstoneFile,
  readBrainHandoverRecord,
  type DesktopBrainOwner,
} from '../../brain/owner-gate'
import {
  readFirstOwnerIntent,
  writeFirstOwnerIntent,
  type FirstOwnerIntent,
} from './first-owner-intent'
import type { BrainHandoverChannel } from './runner'

type InstalledHostChannel = BrainHandoverChannel & { readonly machineId: string }
type HostStatus = OwnerCalls['owner.brainHandover.status']['result']

export interface BrainOwnerSelectionPorts {
  userData: string
  legacyTranscripts: string
  /** Installed state location of the same service that can supply `channel`. */
  stateDir?: string
  channel: InstalledHostChannel | null
  /** Fresh Host Brain and new moves are possible only in daemon mode with a permit. */
  allowHost: boolean
  /** Without an installed service candidate, this launch is Desktop-only. */
  standalone: boolean
  /** Pins this installation before an irreversible ownership change. */
  beforeHostOwnership(): Promise<void>
  fenceEmptyLegacy(fenceId: string): void
  matchesLegacyFence(fenceId: string): boolean
}

function regularOrAbsent(path: string, directory = false): boolean {
  try {
    const info = lstatSync(path)
    if (directory ? info.isDirectory() : info.isFile()) return true
    throw new Error('Unexpected type at the Desktop Brain location.')
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return false
    throw error
  }
}

function hostStatus(channel: InstalledHostChannel): Promise<HostStatus | undefined> {
  return channel.call('owner.brainHandover.status', {}).catch((error: unknown) => {
    if (error instanceof OwnerCallError && error.code === 'unsupported') return undefined
    throw error
  })
}

function freshHostQualified(status: HostStatus | undefined): boolean {
  const support = status?.support
  return (
    status?.state === 'none' &&
    support?.ownerSelection === 1 &&
    support.target === 'empty' &&
    support.handover &&
    support.reader === 'qualified'
  )
}

async function publishFreshHostOwner(
  p: BrainOwnerSelectionPorts,
  channel: InstalledHostChannel,
  installedStateDir: string,
  pending: FirstOwnerIntent | null,
): Promise<DesktopBrainOwner> {
  const stateDir = realpathSync.native(installedStateDir)
  if (pending && (pending.machineId !== channel.machineId || pending.stateDir !== stateDir))
    return 'moving'
  await p.beforeHostOwnership()
  if (!freshHostQualified(await hostStatus(channel))) return 'moving'

  const ready = () =>
    realpathSync.native(installedStateDir) === stateDir &&
    readLocalBrainSelection(installedStateDir) === 'unset' &&
    emptyBrainDirectory(join(stateDir, 'brain')) &&
    emptyBrainDirectory(p.legacyTranscripts) &&
    readBrainHandoverRecord(p.userData) === null
  if (!ready()) return 'moving'

  const { legacy, root } = brainHandoverPaths(p.userData)
  const directory = dirname(legacy)
  const empty = emptyBrainDirectory(directory)
  if (!pending && !empty) throw new Error('Desktop Brain is not empty.')
  const intent = pending ?? writeFirstOwnerIntent(p.userData, channel.machineId, stateDir)
  const intentMatches = () => {
    const proof = readFirstOwnerIntent(p.userData)
    return (
      proof &&
      proof !== 'blocked' &&
      proof.fenceId === intent.fenceId &&
      proof.stateDir === stateDir &&
      proof.machineId === channel.machineId
    )
  }
  if (!intentMatches()) return 'moving'
  // A restart may see the intent's link before its directory fsync finished.
  syncBrainPath(root)
  syncBrainPath(p.userData)
  if (empty) p.fenceEmptyLegacy(intent.fenceId)
  if (!ready() || !intentMatches() || !p.matchesLegacyFence(intent.fenceId)) return 'moving'

  // The fence may also be visible after a crash before its directory fsync finished.
  syncBrainPath(legacy)
  syncBrainPath(directory)
  return selectLocalBrainOwner(stateDir, 'host') ? 'host' : 'moving'
}

/** The caller must keep Desktop closed until this has resolved and any move has settled. */
export async function selectBrainOwnerAtLaunch(
  p: BrainOwnerSelectionPorts,
): Promise<DesktopBrainOwner> {
  const owner = desktopBrainOwner(p.userData)
  const selection = p.stateDir ? readLocalBrainSelection(p.stateDir) : 'unset'
  const { legacy } = brainHandoverPaths(p.userData)
  if (owner === 'host') return owner
  if (selection === 'host') return isBrainTombstoneFile(legacy) ? 'host' : 'moving'
  const intent = readFirstOwnerIntent(p.userData)
  if (intent === 'blocked' || selection === 'blocked') return 'moving'
  if (intent) {
    // Do not enter the legacy-selection path, even if the crash preceded the fence.
    if (
      !p.allowHost ||
      !p.channel ||
      !p.stateDir ||
      selection !== 'unset' ||
      readBrainHandoverRecord(p.userData) !== null
    )
      return 'moving'
    return publishFreshHostOwner(p, p.channel, p.stateDir, intent)
  }
  if (owner !== 'desktop') return 'moving'

  regularOrAbsent(dirname(legacy), true)
  const present = regularOrAbsent(legacy)
  if (!present && ['-wal', '-shm', '-journal'].some((suffix) => regularOrAbsent(legacy + suffix)))
    return 'moving'
  if (!p.channel) {
    if (selection === 'desktop') return 'desktop'
    // In-app before installation: no existing service Brain to compete with. A later local
    // service starts with no native owner, and a later Desktop launch runs this selection again.
    return p.standalone && (!p.stateDir || !regularOrAbsent(p.stateDir, true))
      ? 'desktop'
      : 'moving'
  }
  const status = await hostStatus(p.channel)
  // A first-owner intent may have appeared while we waited. Don't fall back to Desktop.
  if (readFirstOwnerIntent(p.userData) !== null || desktopBrainOwner(p.userData) !== 'desktop')
    return 'moving'
  if (!status) {
    // Older service, legacy app bridge only. Record the proof for an offline restart.
    if (!p.stateDir) return 'desktop'
    return emptyBrainDirectory(join(p.stateDir, 'brain')) &&
      selectLocalBrainOwner(p.stateDir, 'desktop')
      ? 'desktop'
      : 'moving'
  }
  const { support, state } = status
  if (support.target !== 'empty' || state !== 'none') return 'moving'
  if (support.ownerSelection !== 1) return 'moving' // no native writer fence proved
  if (!p.stateDir) return support.handover ? 'moving' : 'desktop'
  if (
    p.allowHost &&
    selection === 'unset' &&
    !present &&
    emptyBrainDirectory(dirname(legacy)) &&
    emptyBrainDirectory(p.legacyTranscripts) &&
    freshHostQualified(status)
  ) {
    return publishFreshHostOwner(p, p.channel, p.stateDir, null)
  }
  if (!emptyBrainDirectory(join(p.stateDir, 'brain'))) return 'moving'
  return selectLocalBrainOwner(p.stateDir, 'desktop') ? 'desktop' : 'moving'
}
