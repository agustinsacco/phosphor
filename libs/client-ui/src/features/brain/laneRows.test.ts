import { expect, it } from 'vitest'
import { groupBrainLanes, selectBrainLane } from './laneRows'
import { mockBrainJob } from './mockBrainData'

it('groups review, ordered reading, failed and finished reads without duplicate empty rows', () => {
  const jobs = (['waiting', 'failed', 'queued', 'running', 'review', 'empty'] as const).map(
    (state) => mockBrainJob({ id: state, state }),
  )
  const history = {
    items: [
      {
        job: mockBrainJob({ id: 'done', state: 'done', finishedAt: 1 }),
        memories: 3,
        replaceable: 2,
      },
    ],
    more: true,
  }
  const groups = groupBrainLanes(jobs, history)
  expect(groups.map((group) => [group.label, group.rows.map(({ job }) => job.id)])).toEqual([
    ['To review', ['review']],
    ['Reading', ['running', 'queued', 'waiting']],
    ['Failed', ['failed']],
    ['Read', ['empty', 'done']],
  ])
  expect(selectBrainLane(null, groups)).toBe('review')
  expect(selectBrainLane('waiting', groups)).toBe('waiting')
  expect(selectBrainLane('missing', groups)).toBe('review')
  expect(selectBrainLane(null, groups.slice(1))).toBe('running')
  expect(selectBrainLane(null, groups.slice(2))).toBe('empty')
  expect(selectBrainLane(null, [])).toBeNull()
})
it('follows the same job from running through review into read history', () => {
  for (const state of ['running', 'review'] as const)
    expect(
      selectBrainLane(
        'harbor-job',
        groupBrainLanes([mockBrainJob({ state }), mockBrainJob({ id: 'other' })], null),
      ),
    ).toBe('harbor-job')
  expect(
    selectBrainLane(
      'harbor-job',
      groupBrainLanes([mockBrainJob({ id: 'other' })], {
        items: [{ job: mockBrainJob({ state: 'done' }), memories: 2, replaceable: 2 }],
        more: false,
      }),
    ),
  ).toBe('harbor-job')
})
