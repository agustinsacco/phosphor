import { expect, it } from 'vitest'
import type { BrainExtractionOutcome } from '@shared/brain'
import type { BrainTidyOperation } from '@shared/brain-tidy'
import { mockBrainJob } from '../mockBrainData'
import { agoWords, durationWords } from '../jobProgress'
import {
  jobsAhead,
  keepLaneSelection,
  laneGroups,
  laneLine,
  readCounts,
  readLine,
} from './laneGroups'

const MIN = 60_000

it('groups reads by state, with every finished read once and newest first', () => {
  const done = mockBrainJob({ id: 'done', state: 'done', finishedAt: 5 })
  const jobs = [
    mockBrainJob({ id: 'review', state: 'review' }),
    mockBrainJob({ id: 'running', state: 'running' }),
    mockBrainJob({ id: 'queued', state: 'queued' }),
    mockBrainJob({ id: 'waiting', state: 'waiting' }),
    mockBrainJob({ id: 'failed', state: 'failed' }),
    mockBrainJob({ id: 'empty', state: 'empty', finishedAt: 9 }),
  ]
  const groups = laneGroups(jobs, {
    items: [
      { job: done, memories: 4, replaceable: 4 },
      {
        job: mockBrainJob({ id: 'older', state: 'done', finishedAt: 1 }),
        memories: 2,
        replaceable: 2,
      },
    ],
    more: false,
  })
  expect(groups.map((group) => [group.label, group.rows.map((row) => row.job.id)])).toEqual([
    ['Reading', ['running']],
    ['Queued', ['queued', 'waiting']],
    ['Failed', ['failed']],
    ['Read', ['empty', 'done', 'older']],
  ])
})

it('says what each row is doing in honest time', () => {
  const now = 10 * 60 * MIN
  expect(
    laneLine(mockBrainJob({ state: 'running', startedAt: now - 3 * MIN, progress: null }), now, 0),
  ).toBe('Reading · 3 min')
  expect(laneLine(mockBrainJob({ state: 'queued', queuedAt: now - 125 * MIN }), now, 1)).toBe(
    'Queued 2 h 5 min ago · 1 ahead',
  )
  expect(laneLine(mockBrainJob({ state: 'queued', queuedAt: now + MIN }), now, 0)).toBe(
    'Queued just now',
  )
  expect(laneLine(mockBrainJob({ state: 'failed', error: null }), now, 0)).toBe('The read failed')
  const row = {
    job: mockBrainJob({ state: 'done', finishedAt: now - 2 * MIN }),
    memories: 1,
    replaceable: 1,
  }
  expect(readLine(row, now)).toBe('1 memory · 2 min ago')
  expect(readLine({ ...row, job: { ...row.job, state: 'empty' } }, now)).toBe(
    'Nothing worth keeping',
  )
})

it('never shows a negative duration or minutes and seconds', () => {
  expect(durationWords(-5000)).toBe('less than a minute')
  expect(durationWords((241 * 60 + 11) * 1000)).toBe('4 h 1 min')
  expect(durationWords(3 * 60 * MIN)).toBe('3 h')
  expect(durationWords(50 * 60 * MIN)).toBe('2 days')
  expect(agoWords(30_000)).toBe('just now')
})

it('counts jobs ahead in the reader queue', () => {
  const jobs = [
    mockBrainJob({ id: 'a', state: 'running' }),
    mockBrainJob({ id: 'b', state: 'review' }),
    mockBrainJob({ id: 'c', state: 'queued' }),
    mockBrainJob({ id: 'd', state: 'queued' }),
  ]
  expect(jobsAhead(jobs, 'd')).toBe(2)
  expect(jobsAhead(jobs, 'a')).toBe(0)
})

it('counts what a read kept, confirmed and left out', () => {
  const outcome = (status: BrainExtractionOutcome['status'], removed = false) =>
    ({ candidate: status, summary: status, status, removed }) as BrainExtractionOutcome
  expect(
    readCounts([
      outcome('kept'),
      outcome('enriches'),
      outcome('kept', true),
      outcome('reconfirms'),
      outcome('folded'),
      outcome('held'),
      outcome('dropped'),
    ]),
  ).toEqual({ kept: 2, confirmed: 2, left: 2 })
})

it('keeps a selection that exists or was asked for by id, else the first read', () => {
  const groups = laneGroups([mockBrainJob({ id: 'running', state: 'running' })], null)
  const changes = [{ id: 'op-2' }, { id: 'op-1' }] as BrainTidyOperation[]
  expect(keepLaneSelection({ type: 'job', id: 'running' }, groups, changes)).toEqual({
    type: 'job',
    id: 'running',
  })
  expect(keepLaneSelection({ type: 'change', id: null }, groups, changes)).toEqual({
    type: 'change',
    id: 'op-2',
  })
  expect(keepLaneSelection({ type: 'job', id: 'old-read' }, groups, changes)).toEqual({
    type: 'job',
    id: 'old-read',
  })
  expect(
    keepLaneSelection({ type: 'job', id: 'cancelled' }, groups, changes, new Set(['cancelled'])),
  ).toEqual({ type: 'job', id: 'running' })
  expect(keepLaneSelection(null, [], [])).toBeNull()
})
