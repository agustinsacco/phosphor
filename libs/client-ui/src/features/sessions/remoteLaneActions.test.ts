import { describe, expect, it, vi } from 'vitest'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import type { HostCapability } from '@shared/remote-host'
import { featureNotOffered } from '@/stores/hostRefusals'
import { machineCaps } from '@/stores/machineCaps'
import { REMOTE_NOT_READY } from '@/stores/remoteLanes'
import { laneActions, type LaneActionHandlers } from './laneActions'
import {
  hostLaneContext,
  LANE_MARKS_NEED_UPDATE,
  ONLY_WHILE_RUNNING,
  TAKE_CONTROL_FIRST,
  type RemoteLaneActionState,
} from './remoteLaneActions'

const LANE = mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!
const BASE_CAPS: HostCapability[] = ['sessions.read', 'sessions.control', 'workspaces.write']
const caps = (capabilities: HostCapability[], laneMarks?: boolean) =>
  machineCaps({ state: 'ready', capabilities, laneMarks })

function handlers(): LaneActionHandlers {
  return {
    open: vi.fn(),
    openPullRequest: vi.fn(),
    rename: vi.fn(),
    takeControl: vi.fn(),
    releaseControl: vi.fn(),
    stop: vi.fn(),
    resume: vi.fn(),
    markRead: vi.fn(),
    pin: vi.fn(),
    marker: vi.fn(),
    makeRoutine: vi.fn(),
    exportHtml: vi.fn(),
    copyDebugInfo: vi.fn(),
    copySpend: vi.fn(),
    delete: vi.fn(),
  }
}
function state(edit: Partial<RemoteLaneActionState> = {}, self = true): RemoteLaneActionState {
  return {
    lane: {
      ...LANE,
      control: {
        fence: 1,
        controller: self ? { label: 'You', connected: true, self: true } : null,
      },
    },
    caps: caps(BASE_CAPS, true),
    ready: true,
    busy: false,
    stopBlocked: null,
    pr: null,
    markers: 'auto',
    ...edit,
  }
}
const hostMenu = (s: RemoteLaneActionState, h: LaneActionHandlers) =>
  laneActions(hostLaneContext(s), h)
const item = (items: ReturnType<typeof laneActions>, label: string) =>
  items.find((entry) => entry.label === label)

describe('hostLaneContext', () => {
  it("lists every action in This Mac's order, with Open and a pull request only when supplied", () => {
    const all = hostMenu(state({ pr: { number: 7 } }), handlers())
    expect(all.map((entry) => entry.label)).toEqual([
      'Open',
      'Rename…',
      'Make routine…',
      'Pin',
      'Lane marker…',
      'Open pull request #7',
      'Release control',
      'Stop',
      'Mark read',
      'Export HTML…',
      'Copy debug info',
      'Copy spend',
      'Delete',
    ])
    const own = hostMenu(state(), { ...handlers(), open: undefined })
    expect(own.map((entry) => entry.label)).not.toContain('Open')
  })

  it('routes each item to its handler', () => {
    const calls = handlers()
    for (const entry of hostMenu(state(), calls)) entry.onClick()
    expect(calls.stop).toHaveBeenCalledOnce()
    expect(calls.pin).toHaveBeenCalledOnce()
    expect(calls.delete).toHaveBeenCalledOnce()
    expect(calls.resume).not.toHaveBeenCalled()
  })

  it('tells a reader to take control first and keeps reader actions open', () => {
    const items = hostMenu(state({}, false), handlers())
    for (const label of ['Rename…', 'Stop', 'Delete']) {
      expect(item(items, label)?.disabled, label).toBe(true)
      expect(item(items, label)?.hint, label).toBe(TAKE_CONTROL_FIRST)
    }
    expect(item(items, 'Take control')?.disabled).toBe(false)
    expect(item(items, 'Mark read')?.disabled).toBe(false)
    expect(item(items, 'Pin')?.disabled).toBe(false)
  })

  it('explains Stop until a first message, and offers Resume on a stopped lane', () => {
    const blocked = 'Send a first message before stopping this lane.'
    const running = hostMenu(state({ stopBlocked: blocked }), handlers())
    expect(item(running, 'Stop')).toMatchObject({ disabled: true, hint: blocked })
    const stopped = hostMenu(
      state({ stopBlocked: blocked, lane: { ...state().lane, activity: 'stopped' } }),
      handlers(),
    )
    expect(item(stopped, 'Resume')).toMatchObject({ disabled: false, hint: undefined })
    expect(item(stopped, 'Rename…')?.hint).toBe(ONLY_WHILE_RUNNING)
  })

  it('names one obstacle for Pin and Lane marker: not ready, an old Host, then no control', () => {
    const marks = (edit: Partial<RemoteLaneActionState>) => {
      const items = hostMenu(state(edit), handlers())
      return [item(items, 'Pin')?.hint, item(items, 'Lane marker…')?.hint]
    }
    expect(marks({ ready: false })).toEqual([REMOTE_NOT_READY, REMOTE_NOT_READY])
    expect(marks({ caps: caps(['sessions.control']) })).toEqual([
      LANE_MARKS_NEED_UPDATE,
      LANE_MARKS_NEED_UPDATE,
    ])
    expect(marks({ caps: caps(['sessions.read'], true) })).toEqual([
      featureNotOffered('sessions.control'),
      featureNotOffered('sessions.control'),
    ])
    const pinned = hostMenu(state({ lane: { ...LANE, pinned: true } }), handlers())
    expect(item(pinned, 'Unpin')).toBeDefined()
  })

  it('holds Delete without workspaces.write even for the controller', () => {
    const items = hostMenu(
      state({ caps: caps(['sessions.read', 'sessions.control'], true) }),
      handlers(),
    )
    expect(item(items, 'Delete')).toMatchObject({
      disabled: true,
      hint: featureNotOffered('workspaces.write'),
    })
  })
})

it("gates Make routine… on the Host's routines capability, saying the Host does not offer them", () => {
  const without = hostMenu(state(), handlers())
  // The capability is missing on an older Host or under a grant without it: never "yet".
  expect(item(without, 'Make routine…')).toMatchObject({
    disabled: true,
    hint: 'This Host does not offer routines to this device.',
  })
  const routines = caps([...BASE_CAPS, 'routines'], true)
  const withRoutines = hostMenu(state({ caps: routines }), handlers())
  expect(item(withRoutines, 'Make routine…')).toMatchObject({ disabled: false, hint: undefined })
  expect(
    item(hostMenu(state({ caps: routines, ready: false }), handlers()), 'Make routine…')?.hint,
  ).toBe(REMOTE_NOT_READY)
})

it('hides Mark read on a read lane, as This Mac does', () => {
  const read = hostMenu(state({ lane: { ...state().lane, read: LANE.attention } }), handlers())
  expect(item(read, 'Mark read')).toBeUndefined()
})

it('names the missing grant on Take control, as every refused action does', () => {
  const items = hostMenu(state({ caps: caps(['sessions.read'], true) }, false), handlers())
  expect(item(items, 'Take control')).toMatchObject({
    disabled: true,
    hint: featureNotOffered('sessions.control'),
  })
})

it("shows the pull request's state as its hint, as This Mac does", () => {
  const items = hostMenu(state({ pr: { number: 7, state: 'MERGED' } }), handlers())
  expect(item(items, 'Open pull request #7')?.hint).toBe('merged')
})
