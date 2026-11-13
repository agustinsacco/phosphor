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
  'showPullRequests',
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
    prs: [],
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
      prs: [{ key: 'k7', label: '#7 · In review' }],
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
      'Pull requests',
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

it('offers queue or cancel knowledge only when a local source supplies context and a handler', () => {
  const knowledge = vi.fn()
  expect(laneActions(ctx(), { knowledge })).toEqual([])
  expect(laneActions(ctx({ knowledge: 'queue' }), {})).toEqual([])
  const queue = laneActions(ctx({ knowledge: 'queue', running: true }), { knowledge })
  expect(rows(queue)).toEqual(['Queue for knowledge extraction'])
  expect(queue[0]?.disabled).toBe(false)
  queue[0]!.onClick()
  expect(knowledge).toHaveBeenCalledOnce()
  expect(rows(laneActions(ctx({ knowledge: 'cancel' }), { knowledge }))).toEqual([
    'Cancel knowledge extraction',
  ])
  expect(laneActions(ctx({ knowledge: 'queue', busy: true }), { knowledge })[0]?.disabled).toBe(
    true,
  )
})

describe('the Pull requests submenu', () => {
  const prs = [
    { key: 'k57', label: '#57 · Failing' },
    { key: 'k58', label: '#58 · In review' },
  ]
  const submenu = (h: LaneActionHandlers) =>
    laneActions(ctx({ prs }), h).find((i) => i.label === 'Pull requests')

  it('lists each PR, then the inspector, and opens each on GitHub by its key', () => {
    const calls = handlers()
    const menu = submenu(calls)!
    expect(rows(menu.submenu!)).toEqual([
      '#57 · Failing',
      '#58 · In review',
      '┄Show pull requests…',
    ])
    menu.submenu![1]!.onClick()
    expect(calls.openPullRequest).toHaveBeenCalledWith('k58')
    menu.submenu![2]!.onClick()
    expect(calls.showPullRequests).toHaveBeenCalledOnce()
  })

  it('opens the inspector from the item itself where a surface cannot nest', () => {
    const calls = handlers()
    submenu(calls)!.onClick()
    expect(calls.showPullRequests).toHaveBeenCalledOnce()
  })

  it('falls back to the lead PR without an inspector, and hides without PRs', () => {
    const calls = { ...handlers(), showPullRequests: undefined }
    const menu = submenu(calls)!
    expect(rows(menu.submenu!)).toEqual(['#57 · Failing', '#58 · In review'])
    menu.onClick()
    expect(calls.openPullRequest).toHaveBeenCalledWith('k57')
    expect(laneActions(ctx(), handlers()).some((i) => i.label === 'Pull requests')).toBe(false)
  })
})
