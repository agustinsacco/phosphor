import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { LaneCapacityReached as PublicCapacityError } from '../store'
import { LaneCapacityReached } from './types'
import {
  controlFromRow,
  laneFromRow,
  repositoryFromRow,
  summaryQuery,
  str,
  nullable,
  num,
  iso,
  timestamp,
  type Row,
} from './rows'
import { loadSqlite } from '../sqlite'

const clientId = randomUUID()
const row = (): Row => ({
  lane_id: randomUUID(),
  repository_id: '0123456789abcdef',
  cwd: '/repo',
  session_file: '/repo/session.jsonl',
  title: '',
  branch: 'main',
  worktree: 1n,
  provider: 'provider',
  model: 'model',
  created_at: 10n,
  updated_at: 20n,
  attention: 2n,
  read: 1n,
  fence: 3n,
  controller_client_id: clientId,
  controller_label: 'Controller',
  removed_at: null,
})

it('keeps the public capacity error constructor identity', () => {
  expect(PublicCapacityError).toBe(LaneCapacityReached)
  expect(new LaneCapacityReached()).toBeInstanceOf(PublicCapacityError)
  expect(new LaneCapacityReached().message).toBe('Host lane capacity reached.')
})
it('validates scalar types, safe integer limits and canonical timestamps', () => {
  expect(str({ value: 'text' }, 'value')).toBe('text')
  expect(nullable({ value: null }, 'value')).toBeNull()
  expect(nullable({ value: 'text' }, 'value')).toBe('text')
  for (const value of [0, 9007199254740991n]) expect(num({ value }, 'value')).toBe(Number(value))
  for (const value of [null, '1', -1, 1.5, 9007199254740992n])
    expect(() => num({ value }, 'value')).toThrow()
  expect(() => str({ value: null }, 'value')).toThrow()
  expect(() => nullable({}, 'value')).toThrow()
  expect(timestamp(iso(123))).toBe(123)
  for (const value of ['invalid', '1970-01-01', '1969-12-31T23:59:59.999Z'])
    expect(() => timestamp(value)).toThrow()
})
it('projects complete lane rows and consults live connectivity each time', () => {
  const input = row()
  const isConnected = vi.fn(() => true)
  const logCorruptLane = vi.fn()
  expect(laneFromRow(input, { isConnected, logCorruptLane })).toEqual({
    laneId: input.lane_id,
    repositoryId: input.repository_id,
    cwd: '/repo',
    sessionFile: '/repo/session.jsonl',
    title: '',
    branch: 'main',
    worktree: true,
    model: { provider: 'provider', id: 'model' },
    activity: 'stopped',
    createdAt: iso(10),
    updatedAt: iso(20),
    attention: 2,
    read: 1,
    control: { fence: 3, controller: { clientId, label: 'Controller', connected: true } },
    removedAt: null,
  })
  isConnected.mockReturnValue(false)
  expect(laneFromRow(input, { isConnected, logCorruptLane })?.control.controller?.connected).toBe(
    false,
  )
  expect(isConnected.mock.calls).toEqual([[clientId], [clientId]])
  expect(controlFromRow({ ...input, controller_client_id: null }, isConnected)).toEqual({
    fence: 3,
    controller: null,
  })
  expect(logCorruptLane).not.toHaveBeenCalled()
})
it.each([
  ['lane_id', 'bad'],
  ['repository_id', 'BAD'],
  ['cwd', 'relative'],
  ['session_file', 'relative'],
  ['title', 'private\ntext'],
  ['worktree', 2],
  ['model', null],
  ['updated_at', 9],
  ['attention', 9007199254740992n],
  ['read', 3],
  ['fence', 0],
  ['controller_label', null],
  ['removed_at', -1],
] as const)('skips invalid lane field %s without exposing row details', (field, value) => {
  const logCorruptLane = vi.fn((_count: number) => {
    throw new Error('lost logger')
  })
  expect(
    laneFromRow({ ...row(), [field]: value }, { isConnected: () => false, logCorruptLane }),
  ).toBeNull()
  expect(logCorruptLane.mock.calls).toEqual([[1]])
})
it('validates repository flags, paths and integer timestamps', () => {
  const input = { id: '0123456789abcdef', name: 'repo', path: '/repo', active: 1n, added_at: 0n }
  const log = vi.fn()
  expect(repositoryFromRow(input, log)).toEqual({ id: input.id, name: 'repo', path: '/repo' })
  for (const patch of [
    { active: 2 },
    { added_at: 9007199254740992n },
    { path: 'relative' },
    { name: '' },
  ])
    expect(repositoryFromRow({ ...input, ...patch }, log)).toBeNull()
  expect(log.mock.calls).toEqual([[1], [1], [1], [1]])
})
it('reads SQLite integers losslessly before row validation', async () => {
  const { DatabaseSync } = await loadSqlite()
  const db = new DatabaseSync(':memory:')
  try {
    expect(summaryQuery(db, 'SELECT 9223372036854775807 AS value').get()?.value).toBe(
      9223372036854775807n,
    )
  } finally {
    db.close()
  }
})
