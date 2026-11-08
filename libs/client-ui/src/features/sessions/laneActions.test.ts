import { describe, expect, it, vi } from 'vitest'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { laneActions, type LaneActionContext, type LaneActionHandlers } from './laneActions'

const ALL: (keyof LaneActionHandlers)[] = [
  'open',
  'rename',
  'tree',
  'completion',
  'restoreWorktree',
  'makeRoutine',
  'pin',
  'marker',
  'openPullRequest',
  'takeControl',
  'releaseControl',
  'stop',
  'resume',
  'markRead',
  'fork',
  'clone',
  'exportHtml',
  'copyDebugInfo',
  'copySpend',
  'delete',
]
const handlers = (): LaneActionHandlers =>
  Object.fromEntries(ALL.map((id) => [id, vi.fn()])) as LaneActionHandlers
function ctx(edit: Partial<LaneActionContext> = {}): LaneActionContext {
  return {
    pinned: false,
    markers: 'auto',
    pr: null,
    unseen: false,
    running: false,
    busy: false,
    refusals: {},
    ...edit,
  }
}
const rows = (items: ContextMenuItem[]) =>
  items.map((i) => `${i.separatorAbove ? '┄' : ''}${i.label}${i.hint ? ` (${i.hint})` : ''}`)

describe('laneActions', () => {
  it("offers every action in This Mac's order, the Host's control before Stop", () => {
    const order = [{ label: 'Move up', onClick: vi.fn() }]
    const full = ctx({
      pinned: true,
      pr: { number: 7, state: 'OPEN' },
      unseen: true,
      running: true,
      completed: false,
      worktreeRemoved: true,
      spend: { hint: '$1.50' },
      control: { self: false },
      hints: { stop: '~200 MB', delete: 'to trash' },
    })
    expect(rows(laneActions(full, handlers(), order))).toEqual([
      'Open',
      'Move up',
      'Rename…',
      'Session tree…',
      'Finish conversation…',
      'Restore worktree…',
      'Make routine…',
      'Unpin',
      'Lane marker…',
      'Open pull request #7 (open)',
      'Take control',
      'Stop (~200 MB)',
      'Mark read',
      '┄Fork (new branch)',
      'Clone',
      'Export HTML…',
      'Copy debug info',
      'Copy spend ($1.50)',
      '┄Delete (to trash)',
    ])
  })

  it('hides an item whose data or handler is absent, and opens each section on its first item', () => {
    const { fork, clone, tree, ...rest } = handlers()
    void [fork, clone, tree]
    expect(rows(laneActions(ctx({ markers: 'off', control: { self: true } }), rest))).toEqual([
      'Open',
      'Rename…',
      'Make routine…',
      'Pin',
      'Release control',
      'Resume',
      '┄Export HTML…',
      'Copy debug info',
      '┄Delete',
    ])
  })

  it('disables a refused action with the refusal as its hint, and every action while busy', () => {
    const refused = laneActions(
      ctx({ refusals: { delete: 'another delete is running' }, hints: { delete: 'to trash' } }),
      handlers(),
    )
    expect(refused.find((i) => i.label === 'Delete')).toMatchObject({
      disabled: true,
      hint: 'another delete is running',
      danger: true,
    })
    expect(refused.find((i) => i.label === 'Open')?.disabled).toBe(false)
    const busy = laneActions(ctx({ busy: true }), handlers())
    expect(busy.every((i) => i.disabled)).toBe(true)
  })

  it('labels a completed lane Reopen conversation and routes it to the completion handler', () => {
    const calls = handlers()
    const reopen = laneActions(ctx({ completed: true }), calls).find(
      (i) => i.label === 'Reopen conversation',
    )!
    reopen.onClick()
    expect(calls.completion).toHaveBeenCalledOnce()
  })
})
