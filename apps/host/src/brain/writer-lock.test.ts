import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OwnerLockPorts } from '@phosphor/session-runtime/owner-lock/types'
import { targetOccupied } from '../brain-handover/layout'
import {
  acquireHostBrainWriterLock,
  HOST_BRAIN_WRITER_LOCK,
  hostBrainWriter,
  hostBrainWriterHeld,
  HostBrainWriterBusy,
  parseHostBrainWriterRecord,
} from './writer-lock'

let state: string
beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), 'host-brain-writer-lock-'))
})
afterEach(async () => {
  await rm(state, { recursive: true, force: true })
})

function ports(pid: number, live: Set<number>, start = (p: number) => `start-${p}`) {
  return {
    pid,
    isAlive: (p: number) => live.has(p),
    processStart: async (p: number) => (live.has(p) ? start(p) : null),
  } satisfies OwnerLockPorts
}

it('refuses a second live writer and keeps the lock beside, not inside, the Brain folder', async () => {
  const live = new Set([10, 20])
  const first = await acquireHostBrainWriterLock(state, { ports: ports(10, live) })
  await expect(acquireHostBrainWriterLock(state, { ports: ports(20, live) })).rejects.toThrow(
    new HostBrainWriterBusy('held').message,
  )
  expect(existsSync(join(state, HOST_BRAIN_WRITER_LOCK))).toBe(true)
  expect(targetOccupied(state)).toBe(false)
  expect(await hostBrainWriterHeld(state, { ports: ports(20, live) })).toBe(true)
  await first.release()
  expect(existsSync(join(state, HOST_BRAIN_WRITER_LOCK))).toBe(false)
  await (await acquireHostBrainWriterLock(state, { ports: ports(20, live) })).release()
})

it('reclaims the lock of a killed writer, and of a reused pid with another start time', async () => {
  const live = new Set([10, 20])
  await acquireHostBrainWriterLock(state, { ports: ports(10, live) })
  live.delete(10)
  expect(await hostBrainWriterHeld(state, { ports: ports(20, live) })).toBe(false)
  await acquireHostBrainWriterLock(state, { ports: ports(20, live) })
  const record = parseHostBrainWriterRecord(
    await readFile(join(state, HOST_BRAIN_WRITER_LOCK), 'utf8'),
  )
  expect(record).toMatchObject({ pid: 20, processStart: 'start-20' })
  // pid 20 now belongs to an unrelated process that started later.
  const reused = ports(30, new Set([20, 30]), (p) => (p === 20 ? 'later' : `start-${p}`))
  await (await acquireHostBrainWriterLock(state, { ports: reused })).release()
})

it('reclaims an invalid lock file and never parses a record without its fields', async () => {
  await writeFile(join(state, HOST_BRAIN_WRITER_LOCK), '{"pid":1}\n', { mode: 0o600 })
  expect(parseHostBrainWriterRecord('{"pid":1}')).toBeNull()
  expect(await hostBrainWriterHeld(state)).toBe(false)
  await (await acquireHostBrainWriterLock(state)).release()
})

it('reports busy after a refusal and clears it once a re-read finds no live holder', async () => {
  const live = new Set([10, 20])
  const holder = await acquireHostBrainWriterLock(state, { ports: ports(10, live) })
  const writer = hostBrainWriter(state, { ports: ports(20, live) })
  expect(writer.busy()).toBe(false)
  await expect(writer.take()).rejects.toBeInstanceOf(HostBrainWriterBusy)
  expect(writer.held()).toBe(false)
  expect(writer.busy()).toBe(true)
  await holder.release()
  await vi.waitFor(() => expect(writer.busy()).toBe(false))
  await writer.take()
  expect(writer.held()).toBe(true)
  await writer.release()
  expect(existsSync(join(state, HOST_BRAIN_WRITER_LOCK))).toBe(false)
})
