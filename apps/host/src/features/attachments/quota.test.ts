import type * as NodeFs from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ATTACHMENT_LIMITS as LIMIT } from '@phosphor/shared/host-protocol-attachments'
import { createAttachmentState, type AttachmentState } from './state'
import { directory } from './storage'
import { charge } from './quota'

const io = vi.hoisted(() => ({ fail: '', events: [] as string[] }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>()
  return {
    ...fs,
    writeSync: (...args: Parameters<typeof fs.writeSync>) => {
      io.events.push('write')
      if (io.fail === 'write') throw new Error('injected')
      return fs.writeSync(...args)
    },
    fsyncSync: (...args: Parameters<typeof fs.fsyncSync>) => {
      io.events.push('fsync')
      if (io.fail === 'fsync') throw new Error('injected')
      return fs.fsyncSync(...args)
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      io.events.push('rename')
      if (io.fail === 'rename') throw new Error('injected')
      return fs.renameSync(...args)
    },
  }
})
let state: AttachmentState
let now: number
const laneId = randomUUID()
const ledger = () => join(state.root, laneId, '.quota')
const buckets = () =>
  JSON.parse(readFileSync(ledger(), 'utf8')) as { minute: number; bytes: number }[]
beforeEach(() => {
  now = 120000
  state = createAttachmentState({
    directory: realpathSync(mkdtempSync(join(tmpdir(), 'attachment-quota-'))),
    laneExists: () => true,
    now: () => now,
  })
  directory(state.root)
  io.fail = ''
  io.events = []
})
afterEach(() => rmSync(state.ports.directory, { recursive: true, force: true }))

it('publishes a private sixty-one bucket ledger only after writing and syncing its replacement', () => {
  expect(charge(state, laneId, 0)).toBe(true)
  expect(io.events).toEqual(['write', 'fsync', 'rename'])
  expect(buckets()).toHaveLength(61)
  expect(buckets().reduce((sum, b) => sum + b.bytes, 0)).toBe(65536)
  expect(readdirSync(join(state.root, laneId))).toEqual(['.quota'])
})
it('retains the partial minute plus sixty full minutes across restart and clock reversal', () => {
  expect(charge(state, laneId, LIMIT.hourlyBytes)).toBe(true)
  state = createAttachmentState({ ...state.ports })
  now -= 60000
  expect(charge(state, laneId, 0)).toBe(false)
  now = 120000 + 60 * 60000 + 59999
  expect(charge(state, laneId, 0)).toBe(false)
  now++
  expect(charge(state, laneId, 0)).toBe(true)
  expect(buckets().filter((b) => b.bytes > 0)).toEqual([{ minute: 63, bytes: 65536 }])
})
it.each([
  'json',
  'length',
  'duplicate',
  'extra',
  'fraction',
  'negative',
  'overflow',
  'minute',
  'null',
])('fails closed and replaces a ledger with invalid %s', (invalid) => {
  charge(state, laneId, 0)
  const value: unknown[] = buckets()
  if (invalid === 'length') value.pop()
  if (invalid === 'duplicate') value[1] = value[0]
  if (invalid === 'extra') value[0] = { minute: 2, bytes: 0, extra: true }
  if (invalid === 'fraction') value[0] = { minute: 2, bytes: 0.5 }
  if (invalid === 'negative') value[0] = { minute: 2, bytes: -1 }
  if (invalid === 'overflow') value[0] = { minute: 2, bytes: LIMIT.hourlyBytes + 1 }
  if (invalid === 'minute') value[0] = { minute: '2', bytes: 0 }
  if (invalid === 'null') value[0] = null
  writeFileSync(ledger(), invalid === 'json' ? 'invalid' : JSON.stringify(value))
  expect(charge(state, laneId, 0)).toBe(false)
  expect(buckets().filter((b) => b.bytes > 0)).toEqual([{ minute: 2, bytes: LIMIT.hourlyBytes }])
})
it.each(['missing', 'permissions', 'oversize'])(
  'fully charges an existing directory with a %s ledger',
  (invalid) => {
    charge(state, laneId, 0)
    if (invalid === 'missing') rmSync(ledger())
    if (invalid === 'permissions') chmodSync(ledger(), 0o644)
    if (invalid === 'oversize') writeFileSync(ledger(), ' '.repeat(8193))
    expect(charge(state, laneId, 0)).toBe(false)
  },
)
it.each(['write', 'fsync', 'rename'])(
  'preserves the prior ledger and removes unpublished replacements after %s failure',
  (operation) => {
    charge(state, laneId, 0)
    const prior = readFileSync(ledger(), 'utf8')
    io.fail = operation
    expect(() => charge(state, laneId, 123456)).toThrow('injected')
    expect(readFileSync(ledger(), 'utf8')).toBe(prior)
    expect(readdirSync(join(state.root, laneId))).toEqual(['.quota'])
  },
)
