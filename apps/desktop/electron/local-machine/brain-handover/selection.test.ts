import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { OwnerCallError } from '@phosphor/host-client/owner'
import { writeBrainTombstone } from '@phosphor/memory-engine/handover'
import { openBrainStore } from '@phosphor/memory-engine/store'
import {
  readLocalBrainSelection,
  selectLocalBrainOwner,
} from '@phosphor/session-runtime/brain/local-owner'
import type { BrainHandoverSupport } from '@phosphor/shared/host-protocol-owner'
import { brainHandoverPaths, isBrainTombstoneFile } from '../../brain/owner-gate'
import { readFirstOwnerIntent } from './first-owner-intent'
import { selectBrainOwnerAtLaunch, type BrainOwnerSelectionPorts } from './selection'
import { fenceEmptyDesktopBrain, matchesEmptyDesktopFence } from './tombstone'

const MACHINE_ID = '10000000-0000-4000-8000-000000000001'
const OTHER_MACHINE_ID = '20000000-0000-4000-8000-000000000001'
const OLD_TOMBSTONE_ID = '00000000-0000-4000-8000-000000000001'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function world(support: Partial<BrainHandoverSupport> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harbor-brain-owner-'))
  dirs.push(root)
  const userData = join(root, 'desktop')
  const stateDir = join(root, 'state')
  mkdirSync(userData, { mode: 0o700 })
  mkdirSync(stateDir, { mode: 0o700 })
  const { legacy } = brainHandoverPaths(userData)
  const status = () => ({
    state: 'none',
    support: {
      ownerSelection: 1,
      handover: true,
      reader: 'qualified',
      target: 'empty',
      ...support,
    },
  })
  const call = vi.fn(async () => status())
  const pin = vi.fn(async () => {})
  let crashAfterFence = false
  const fence = vi.fn((id: string) => {
    fenceEmptyDesktopBrain(userData, DatabaseSync, id)
    if (crashAfterFence) {
      crashAfterFence = false
      throw new Error('Fixture crash after the durable Desktop fence.')
    }
  })
  const ports: BrainOwnerSelectionPorts = {
    userData,
    legacyTranscripts: join(root, 'sessions'),
    stateDir,
    allowHost: true,
    standalone: false,
    channel: { call, machineId: MACHINE_ID } as BrainOwnerSelectionPorts['channel'],
    beforeHostOwnership: pin,
    fenceEmptyLegacy: fence,
    matchesLegacyFence: (id) => matchesEmptyDesktopFence(userData, DatabaseSync, id),
  }
  const owner = (overrides: Partial<BrainOwnerSelectionPorts> = {}) =>
    selectBrainOwnerAtLaunch({ ...ports, ...overrides })
  return {
    owner,
    legacy,
    stateDir,
    userData,
    legacyTranscripts: ports.legacyTranscripts,
    pin,
    fence,
    call,
    status,
    otherChannel: { call, machineId: OTHER_MACHINE_ID } as BrainOwnerSelectionPorts['channel'],
    crashAfterFence: () => (crashAfterFence = true),
    createLegacy: () => {
      mkdirSync(join(userData, 'brain'))
      openBrainStore({ path: legacy, Database: DatabaseSync }).close()
    },
  }
}

it('pins and fences the absent legacy DB before the fresh Host grant, retaining it offline', async () => {
  const w = world()
  let release!: () => void
  w.pin.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const choose = w.owner()
  await vi.waitFor(() => expect(w.pin).toHaveBeenCalledOnce())
  expect(readLocalBrainSelection(w.stateDir)).toBe('unset')
  expect(existsSync(w.legacy)).toBe(false)
  release()
  await expect(choose).resolves.toBe('host')
  expect(readLocalBrainSelection(w.stateDir)).toBe('host')
  expect(existsSync(join(w.stateDir, 'brain'))).toBe(false)
  expect(isBrainTombstoneFile(w.legacy)).toBe(true)
  expect(() => openBrainStore({ path: w.legacy, Database: DatabaseSync })).toThrow()
  await expect(w.owner({ channel: null, allowHost: false, standalone: true })).resolves.toBe('host')
  expect(selectLocalBrainOwner(w.stateDir, 'desktop')).toBe(false)
})

it('restarts after the durable empty Desktop fence but before the fresh Host grant', async () => {
  const w = world()
  w.crashAfterFence()
  await expect(w.owner()).rejects.toThrow('Fixture crash after the durable Desktop fence.')
  expect(readLocalBrainSelection(w.stateDir)).toBe('unset')
  expect(isBrainTombstoneFile(w.legacy)).toBe(true)
  expect(() => openBrainStore({ path: w.legacy, Database: DatabaseSync })).toThrow()

  w.pin.mockClear()
  await expect(w.owner({ channel: null })).resolves.toBe('moving')
  expect(readLocalBrainSelection(w.stateDir)).toBe('unset')
  await expect(w.owner()).resolves.toBe('host')
  expect(w.pin).toHaveBeenCalledOnce()
  expect(w.fence).toHaveBeenCalledOnce()
  expect(readLocalBrainSelection(w.stateDir)).toBe('host')
  expect(isBrainTombstoneFile(w.legacy)).toBe(true)
  expect(selectLocalBrainOwner(w.stateDir, 'desktop')).toBe(false)
})

it('restarts after the intent is durable but before the Desktop fence exists', async () => {
  const w = world()
  w.fence.mockImplementationOnce(() => {
    expect(readFirstOwnerIntent(w.userData)).toMatchObject({ version: 1, machineId: MACHINE_ID })
    throw new Error('Fixture crash before the Desktop fence.')
  })
  await expect(w.owner()).rejects.toThrow('Fixture crash before the Desktop fence.')
  expect(existsSync(w.legacy)).toBe(false)
  expect(readLocalBrainSelection(w.stateDir)).toBe('unset')

  await expect(w.owner({ allowHost: false, standalone: true })).resolves.toBe('moving')
  w.call.mockRejectedValueOnce(new OwnerCallError('unsupported', 'Fixture has only legacy recall.'))
  await expect(w.owner()).resolves.toBe('moving')
  expect(existsSync(w.legacy)).toBe(false)
  expect(readLocalBrainSelection(w.stateDir)).toBe('unset')
  await expect(w.owner()).resolves.toBe('host')
  expect(w.fence.mock.calls[1]).toEqual(w.fence.mock.calls[0])
  expect(isBrainTombstoneFile(w.legacy)).toBe(true)
})

it('will not resume a fenced intent with a denied permit, another Host, or another installed root', async () => {
  const w = world()
  w.crashAfterFence()
  await expect(w.owner()).rejects.toThrow('Fixture crash after the durable Desktop fence.')
  w.pin.mockClear()
  const otherRoot = world().stateDir
  await expect(w.owner({ allowHost: false })).resolves.toBe('moving')
  await expect(w.owner({ channel: w.otherChannel })).resolves.toBe('moving')
  await expect(w.owner({ stateDir: otherRoot })).resolves.toBe('moving')
  expect(w.pin).not.toHaveBeenCalled()
  expect(readLocalBrainSelection(w.stateDir)).toBe('unset')
  expect(readLocalBrainSelection(otherRoot)).toBe('unset')
  expect(isBrainTombstoneFile(w.legacy)).toBe(true)
})

it('rechecks status, target, and Desktop files after re-pinning an interrupted choice', async () => {
  const w = world()
  w.crashAfterFence()
  await expect(w.owner()).rejects.toThrow('Fixture crash after the durable Desktop fence.')
  w.pin.mockRejectedValueOnce(new Error('Fixture re-pin refused.'))
  await expect(w.owner()).rejects.toThrow('Fixture re-pin refused.')
  expect(readLocalBrainSelection(w.stateDir)).toBe('unset')
  w.pin.mockImplementationOnce(async () => {
    w.call.mockResolvedValueOnce({ ...w.status(), state: 'verified' })
  })
  await expect(w.owner()).resolves.toBe('moving')
  expect(readLocalBrainSelection(w.stateDir)).toBe('unset')
  w.pin.mockImplementationOnce(async () => {
    mkdirSync(join(w.stateDir, 'brain'))
    writeFileSync(join(w.stateDir, 'brain', 'fixture'), '')
  })
  await expect(w.owner()).resolves.toBe('moving')
  expect(readLocalBrainSelection(w.stateDir)).toBe('unset')
  rmSync(join(w.stateDir, 'brain'), { recursive: true })
  w.pin.mockImplementationOnce(async () => {
    mkdirSync(w.legacyTranscripts)
    writeFileSync(join(w.legacyTranscripts, 'fixture.jsonl'), '')
  })
  await expect(w.owner()).resolves.toBe('moving')
  expect(readLocalBrainSelection(w.stateDir)).toBe('unset')
  expect(isBrainTombstoneFile(w.legacy)).toBe(true)
})

it('leaves an unproven legacy tombstone or mismatched fence moving', async () => {
  const old = world()
  mkdirSync(join(old.userData, 'brain'))
  writeBrainTombstone(DatabaseSync, old.legacy, OLD_TOMBSTONE_ID)
  await expect(old.owner()).resolves.toBe('moving')
  expect(old.pin).not.toHaveBeenCalled()
  expect(readLocalBrainSelection(old.stateDir)).toBe('unset')

  const w = world()
  w.crashAfterFence()
  await expect(w.owner()).rejects.toThrow('Fixture crash after the durable Desktop fence.')
  writeFileSync(`${w.legacy}-wal`, 'fixture')
  await expect(w.owner()).resolves.toBe('moving')
  expect(readLocalBrainSelection(w.stateDir)).toBe('unset')
  rmSync(`${w.legacy}-wal`)
  rmSync(w.legacy)
  writeBrainTombstone(DatabaseSync, w.legacy, OTHER_MACHINE_ID)
  await expect(w.owner()).resolves.toBe('moving')
  expect(readLocalBrainSelection(w.stateDir)).toBe('unset')
  expect(isBrainTombstoneFile(w.legacy)).toBe(true)
})

it('never overwrites a competing grant at recovery', async () => {
  const w = world()
  w.crashAfterFence()
  await expect(w.owner()).rejects.toThrow('Fixture crash after the durable Desktop fence.')
  w.pin.mockImplementationOnce(async () => {
    expect(selectLocalBrainOwner(w.stateDir, 'desktop')).toBe(true)
  })
  await expect(w.owner()).resolves.toBe('moving')
  await expect(w.owner({ channel: null })).resolves.toBe('moving')
  expect(readLocalBrainSelection(w.stateDir)).toBe('desktop')
  expect(() => openBrainStore({ path: w.legacy, Database: DatabaseSync })).toThrow()
})

it('retains an actual legacy owner when a qualified target cannot take the Brain yet', async () => {
  const w = world()
  w.createLegacy()
  await expect(w.owner()).resolves.toBe('desktop')
  expect(readLocalBrainSelection(w.stateDir)).toBe('desktop')
  expect(w.pin).not.toHaveBeenCalled()
  expect(w.fence).not.toHaveBeenCalled()
  expect(isBrainTombstoneFile(w.legacy)).toBe(false)
  await expect(w.owner({ channel: null })).resolves.toBe('desktop')
  expect(selectLocalBrainOwner(w.stateDir, 'host')).toBe(false)
})

it('leaves a fresh legacy owner on an unqualified or older service', async () => {
  const unqualified = world({ handover: false, reader: 'unqualified' })
  await expect(unqualified.owner()).resolves.toBe('desktop')
  expect(unqualified.fence).not.toHaveBeenCalled()
  const old = world()
  old.call.mockRejectedValue(new OwnerCallError('unsupported', 'Fixture has only legacy recall.'))
  await expect(old.owner()).resolves.toBe('desktop')
  expect(old.fence).not.toHaveBeenCalled()
})

it('does not guess on a lost status, occupied target, or uncoordinated native service', async () => {
  await expect(world().owner({ channel: null })).resolves.toBe('moving')
  await expect(world({ target: 'occupied' }).owner()).resolves.toBe('moving')
  await expect(world({ ownerSelection: undefined }).owner()).resolves.toBe('moving')
})

it('cannot overwrite a competing legacy DB or publish Host ownership when pinning fails', async () => {
  const changed = world()
  changed.pin.mockImplementation(async () => changed.createLegacy())
  await expect(changed.owner()).rejects.toThrow()
  expect(isBrainTombstoneFile(changed.legacy)).toBe(false)
  expect(readLocalBrainSelection(changed.stateDir)).toBe('unset')
  const unpinned = world()
  unpinned.pin.mockRejectedValue(new Error('Fixture pin refused.'))
  await expect(unpinned.owner()).rejects.toThrow('Fixture pin refused')
  expect(unpinned.fence).not.toHaveBeenCalled()
  expect(readLocalBrainSelection(unpinned.stateDir)).toBe('unset')
  writeFileSync(join(unpinned.stateDir, 'brain-owner.json'), 'damaged', { mode: 0o600 })
  await expect(unpinned.owner()).resolves.toBe('moving')
})
