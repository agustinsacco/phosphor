import { expect, it } from 'vitest'
import type { LaneSummary } from '@phosphor/shared/host-protocol'
import type { HostConnectionSnapshot } from './connection'
import { acceptLaneFrame, connectionView, type LaneWatch } from './lane-watch'

it('keeps stopped composer data across list changes until a live reset', () => {
  const epoch = 'a'.repeat(16)
  const summary: LaneSummary = {
    laneId: 'lane',
    repositoryId: 'repo',
    cwd: '/repo',
    title: null,
    branch: null,
    worktree: false,
    model: null,
    activity: 'stopped',
    createdAt: '',
    updatedAt: '',
    attention: 0,
    read: 0,
    control: { fence: 1, controller: null },
  }
  let view: HostConnectionSnapshot = {
    state: 'ready',
    connectionToken: 'token',
    capabilities: [],
    repositories: [],
    lanes: [summary],
  }
  const watch: LaneWatch = { laneId: summary.laneId, listener() {} }
  const stoppedComposer = { tokens: 72_000, contextWindow: 200_000 }
  const frame = {
    type: 'snapshot',
    id: 'watch',
    laneId: summary.laneId,
    reset: false,
    snapshot: {
      cursor: { epoch, seq: 0 },
      summary,
      state: null,
      stoppedComposer,
      messages: [],
      pending: [],
      dialogs: [],
      ui: [],
    },
  } as const
  const update = (next: Partial<HostConnectionSnapshot>) => {
    view = { ...view, ...next }
  }
  acceptLaneFrame(watch, frame, view, update, () => {})
  update({ lanes: [{ ...summary, title: 'changed' }] })
  expect(connectionView(view, [watch], epoch).lanes[0]).toMatchObject({
    title: 'changed',
    stoppedComposer,
  })
  expect(connectionView(view, [], epoch).lanes[0]).not.toHaveProperty('stoppedComposer')
  expect(connectionView(view, [watch], 'b'.repeat(16)).lanes[0]).not.toHaveProperty(
    'stoppedComposer',
  )
  const { stoppedComposer: _saved, ...snapshot } = frame.snapshot
  acceptLaneFrame(
    watch,
    { ...frame, reset: true, snapshot: { ...snapshot, summary: { ...summary, activity: 'idle' } } },
    view,
    update,
    () => {},
  )
  expect(connectionView(view, [watch], epoch).lanes[0]).not.toHaveProperty('stoppedComposer')
})
