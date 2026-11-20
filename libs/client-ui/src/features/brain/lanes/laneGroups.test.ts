import { expect, it } from 'vitest'
import type { BrainExtractionOutcome } from '@shared/brain'
import type { BrainTidyOperation } from '@shared/brain-tidy'
import { mockBrainJob } from '../mockBrainData'
import { agoWords, durationWords } from '../jobProgress'
import {
  coverageLine,
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
    ['Waiting for Defrag', ['review']],
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
  expect(readLine(row, now)).toBe('1 memory from this read · 2 min ago')
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

it('never counts a noted outcome as kept, confirmed or left out', () => {
  const noted: BrainExtractionOutcome = {
    candidate: 'w2:cap',
    summary: 'Part 2 returned 25 claims, the most one part may keep',
    status: 'noted',
  }
  expect(readCounts([noted])).toEqual({ kept: 0, confirmed: 0, left: 0 })
  expect(
    readCounts([noted, { candidate: 'w2:c1', summary: 'Harbor bills monthly.', status: 'kept' }]),
  ).toEqual({ kept: 1, confirmed: 0, left: 0 })
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

it('groups a refreshing review apart and a rejected read with the finished ones', () => {
  const jobs = [
    mockBrainJob({ id: 'review', state: 'review' }),
    mockBrainJob({ id: 'refreshing', state: 'refreshing' }),
    mockBrainJob({ id: 'running', state: 'running' }),
    mockBrainJob({ id: 'rejected', state: 'rejected', finishedAt: 9 }),
  ]
  const done = mockBrainJob({ id: 'done', state: 'done', finishedAt: 5 })
  const groups = laneGroups(jobs, {
    items: [{ job: done, memories: 4, replaceable: 4 }],
    more: false,
  })
  expect(groups.map((group) => [group.label, group.rows.map((row) => row.job.id)])).toEqual([
    ['Waiting for Defrag', ['review', 'refreshing']],
    ['Reading', ['running']],
    ['Read', ['rejected', 'done']],
  ])
  const rejected = groups.at(-1)!.rows[0]!
  expect(readLine(rejected, 10)).toBe('Rejected')
  expect(laneLine(rejected.job, 10, 0)).toBe('Rejected')
})

it('times the current attempt, never the first start of a resumed or refreshed read', () => {
  const now = 10 * 60 * MIN
  const resumed = mockBrainJob({
    state: 'running',
    startedAt: now - 5 * 60 * MIN,
    runStartedAt: now - 3 * MIN,
    progress: null,
  })
  expect(laneLine(resumed, now, 0)).toBe('Reading · 3 min')
  const refreshing = mockBrainJob({
    state: 'refreshing',
    startedAt: now - 5 * 60 * MIN,
    runStartedAt: now - 2 * MIN,
  })
  expect(laneLine(refreshing, now, 0)).toBe('Refreshing for 2 min')
  expect(laneLine({ ...refreshing, runStartedAt: null }, now, 0)).toBe('Waits to refresh')
  expect(laneLine({ ...resumed, runStartedAt: now + MIN }, now, 0)).toBe(
    'Reading · less than a minute',
  )
})

it('counts a review waiting to refresh as ahead of every queued read', () => {
  const jobs = [
    mockBrainJob({ id: 'a', state: 'queued' }),
    mockBrainJob({ id: 'b', state: 'refreshing', runStartedAt: null }),
  ]
  expect(jobsAhead(jobs, 'a')).toBe(1)
})

it('says what a read covered', () => {
  const previous = mockBrainJob({ id: 'previous', state: 'done', leafId: 'leaf-7', finishedAt: 7 })
  const history = { items: [{ job: previous, memories: 1, replaceable: 1 }], more: false }
  expect(coverageLine(mockBrainJob({ fromLeafId: null }), history)).toBe('Whole lane')
  expect(coverageLine(mockBrainJob({ id: 'next', fromLeafId: 'leaf-7' }), history)).toBe(
    `New messages after ${new Date(7).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`,
  )
  expect(coverageLine(mockBrainJob({ fromLeafId: 'leaf-gone' }), history)).toBe(
    'New messages since the previous read',
  )
  expect(coverageLine(mockBrainJob({ fromLeafId: 'leaf-7' }), null)).toBe(
    'New messages since the previous read',
  )
})
