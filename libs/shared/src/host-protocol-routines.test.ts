import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { newRoutine } from './routines'
import { parseClientFrame, parseHostFrame } from './host-protocol'
import {
  parseRoutineOp,
  parseRoutineParams,
  parseRoutineList,
  parseRoutineHistory,
  routineRequiresControl,
  ROUTINE_LIMITS,
} from './host-protocol-routines'

const id = randomUUID()
const { workspacePath: _path, ...base } = newRoutine('/private')
const routine = {
  ...base,
  name: 'Report',
  instructions: 'Report',
  provider: 'fake',
  model: 'fake-model',
  repositoryId: '0123456789abcdef',
}
const save = { type: 'routine.save', routine, expectedRevision: null }
describe('Host routine wire contract', () => {
  it('accepts only repository identities, exact keys and machine scope', () => {
    expect(parseRoutineOp(save)).toEqual(save)
    expect(parseRoutineOp({ ...save, path: '/private' })).toBeNull()
    expect(
      parseRoutineOp({ ...save, routine: { ...routine, workspacePath: '/private' } }),
    ).toBeNull()
    expect(
      parseRoutineOp({ ...save, routine: { ...routine, repositoryId: '/private' } }),
    ).toBeNull()
    expect(parseRoutineOp({ ...save, routineId: id })).toBeNull()
    expect(parseRoutineOp({ ...save, routineId: id, expectedRevision: 1 })).not.toBeNull()
    expect(parseRoutineOp({ ...save, expectedRevision: 1 })).toBeNull()
    const frame = { type: 'command', requestId: randomUUID(), op: save }
    expect(parseClientFrame(JSON.stringify(frame)).ok).toBe(true)
    expect(parseClientFrame(JSON.stringify({ ...frame, laneId: id })).ok).toBe(false)
    expect(parseClientFrame(JSON.stringify({ ...frame, fence: 1 })).ok).toBe(false)
  })
  it('bounds text, schedule, runtime and catch-up without accepting coercions', () => {
    for (const [key, limit] of [
      ['name', 100],
      ['instructions', 32000],
      ['provider', 200],
      ['model', 300],
      ['timezone', 100],
    ] as const) {
      expect(
        parseRoutineOp({ ...save, routine: { ...routine, [key]: 'a'.repeat(limit) } }),
      ).not.toBeNull()
      expect(
        parseRoutineOp({ ...save, routine: { ...routine, [key]: 'a'.repeat(limit + 1) } }),
      ).toBeNull()
    }
    for (const [key, min, max] of [
      ['catchUpHours', 0, 168],
      ['maxRuntimeMinutes', 1, 240],
    ] as const) {
      for (const n of [min, max])
        expect(parseRoutineOp({ ...save, routine: { ...routine, [key]: n } })).not.toBeNull()
      for (const n of [min - 1, max + 1, '1', 1.5])
        expect(parseRoutineOp({ ...save, routine: { ...routine, [key]: n } })).toBeNull()
    }
    for (const schedule of [
      { kind: 'manual', extra: true },
      { kind: 'cron', expression: '* * * * * *' },
      { kind: 'once', at: -1 },
    ])
      expect(parseRoutineOp({ ...save, routine: { ...routine, schedule } })).toBeNull()
    expect(
      parseRoutineOp({ ...save, routine: { ...routine, enabled: true, trusted: false } }),
    ).toBeNull()
  })
  it('strictly parses every mutation and its authorization class', () => {
    for (const type of [
      'routine.run',
      'routine.skipNext',
      'routine.archive',
      'routine.delete',
    ] as const) {
      const op = { type, routineId: id }
      expect(parseRoutineOp(op)).toEqual(op)
      expect(parseRoutineOp({ ...op, extra: true })).toBeNull()
      expect(parseRoutineOp({ ...op, routineId: 'bad' })).toBeNull()
      expect(routineRequiresControl(op)).toBe(type === 'routine.run' || type === 'routine.delete')
    }
    // A save that trusts or enables unattended work needs sessions.control; one that stays
    // paused and untrusted does not.
    for (const [enabled, trusted, control] of [
      [false, false, false],
      [false, true, true],
      [true, true, true],
    ] as const) {
      const op = parseRoutineOp({ ...save, routine: { ...routine, enabled, trusted } })
      expect(op).not.toBeNull()
      expect(routineRequiresControl(op!)).toBe(control)
    }
    expect(parseRoutineOp({ type: 'routine.cancel', runId: id })).not.toBeNull()
    expect(parseRoutineOp({ type: 'routine.cancel', runId: 'bad' })).toBeNull()
    expect(parseRoutineOp({ type: 'routine.pauseAll', extra: true })).toBeNull()
    expect(parseRoutineOp({ type: 'routine.pauseAll' })).not.toBeNull()
    expect(parseRoutineOp({ type: 'routine.unknown' })).toBeNull()
  })
  it('bounds queries and untrusted results and rejects path-bearing shapes', () => {
    expect(parseRoutineParams('routines.list', {})).not.toBeNull()
    expect(parseRoutineParams('routines.list', { path: '/private' })).toBeNull()
    expect(
      parseRoutineParams('routines.history', { routineId: id, offset: ROUTINE_LIMITS.offset }),
    ).not.toBeNull()
    expect(
      parseRoutineParams('routines.history', { routineId: id, offset: ROUTINE_LIMITS.offset + 1 }),
    ).toBeNull()
    const result = {
      ...routine,
      id,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      nextAt: null,
      archived: false,
    }
    expect(parseRoutineList(Array(100).fill(result))).toHaveLength(100)
    expect(parseRoutineList(Array(101).fill(result))).toBeNull()
    expect(parseRoutineList([{ ...result, workspacePath: '/private' }])).toBeNull()
    const run = { id, routineId: id, status: 'finished', scheduledAt: 1, startedAt: 1, endedAt: 2 }
    expect(parseRoutineHistory(Array(50).fill(run))).toHaveLength(50)
    expect(parseRoutineHistory(Array(51).fill(run))).toBeNull()
    expect(parseRoutineHistory([{ ...run, sessionPath: '/private' }])).toBeNull()
    expect(
      parseHostFrame(
        JSON.stringify({
          type: 'routines-changed',
          id: 'sub',
          cursor: { epoch: '0123456789abcdef', seq: 1 },
        }),
      ).ok,
    ).toBe(true)
  })
})
