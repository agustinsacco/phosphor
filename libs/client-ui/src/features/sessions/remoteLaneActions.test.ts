import { describe, expect, it, vi } from 'vitest'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import type { HostCapability } from '@shared/remote-host'
import { featureNotOffered } from '@/stores/hostRefusals'
import { machineCaps } from '@/stores/machineCaps'
import { REMOTE_NOT_READY } from '@/stores/remoteLanes'
import {
  LANE_MARKS_NEED_UPDATE,
  ONLY_WHILE_RUNNING,
  TAKE_CONTROL_FIRST,
  remoteLaneActions,
  type RemoteLaneActionHandlers,
  type RemoteLaneActionState,
} from './remoteLaneActions'

const LANE = mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!
const BASE_CAPS: HostCapability[] = ['sessions.read', 'sessions.control', 'workspaces.write']
const caps = (capabilities: HostCapability[], laneMarks?: boolean) =>
  machineCaps({ state: 'ready', capabilities, laneMarks })

function handlers(): RemoteLaneActionHandlers {
  return {
    open: vi.fn(),
    openPullRequest: vi.fn(),
    rename: vi.fn(),
    takeControl: vi.fn(),
    releaseControl: vi.fn(),
    stop: vi.fn(),
    resume: vi.fn(),
    markRead: vi.fn(),
    togglePin: vi.fn(),
    pickMarker: vi.fn(),
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
const item = (items: ReturnType<typeof remoteLaneActions>, label: string) =>
  items.find((entry) => entry.label === label)

describe('remoteLaneActions', () => {
  it('lists every action in one order, with Open and a pull request only when supplied', () => {
    const all = remoteLaneActions(state({ pr: { number: 7 } }), handlers())
    expect(all.map((entry) => entry.label)).toEqual([
      'Open pull request #7',
      'Open',
      'Rename',
      'Release control',
      'Stop',
      'Mark read',
      'Make routine…',
      'Pin',
      'Lane marker',
      'Export HTML…',
      'Copy debug info',
      'Copy spend',
      'Delete',
    ])
    const own = remoteLaneActions(state(), { ...handlers(), open: undefined })
    expect(own.map((entry) => entry.label)).not.toContain('Open')
  })

  it('routes each item to its handler', () => {
    const calls = handlers()
    for (const entry of remoteLaneActions(state(), calls)) entry.onClick()
    expect(calls.stop).toHaveBeenCalledOnce()
    expect(calls.togglePin).toHaveBeenCalledOnce()
    expect(calls.delete).toHaveBeenCalledOnce()
    expect(calls.resume).not.toHaveBeenCalled()
  })

  it('tells a reader to take control first and keeps reader actions open', () => {
    const items = remoteLaneActions(state({}, false), handlers())
    for (const label of ['Rename', 'Stop', 'Delete']) {
      expect(item(items, label)?.disabled, label).toBe(true)
      expect(item(items, label)?.hint, label).toBe(TAKE_CONTROL_FIRST)
    }
    expect(item(items, 'Take control')?.disabled).toBe(false)
    expect(item(items, 'Mark read')?.disabled).toBe(false)
    expect(item(items, 'Pin')?.disabled).toBe(false)
  })

  it('explains Stop until a first message, and offers Resume on a stopped lane', () => {
    const blocked = 'Send a first message before stopping this lane.'
    const running = remoteLaneActions(state({ stopBlocked: blocked }), handlers())
    expect(item(running, 'Stop')).toMatchObject({ disabled: true, hint: blocked })
    const stopped = remoteLaneActions(
      state({ stopBlocked: blocked, lane: { ...state().lane, activity: 'stopped' } }),
      handlers(),
    )
    expect(item(stopped, 'Resume')).toMatchObject({ disabled: false, hint: undefined })
    expect(item(stopped, 'Rename')?.hint).toBe(ONLY_WHILE_RUNNING)
  })

  it('names one obstacle for Pin and Lane marker: not ready, an old Host, then no control', () => {
    const marks = (edit: Partial<RemoteLaneActionState>) => {
      const items = remoteLaneActions(state(edit), handlers())
      return [item(items, 'Pin')?.hint, item(items, 'Lane marker')?.hint]
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
    const pinned = remoteLaneActions(state({ lane: { ...LANE, pinned: true } }), handlers())
    expect(item(pinned, 'Unpin')).toBeDefined()
  })

  it('holds Delete without workspaces.write even for the controller', () => {
    const items = remoteLaneActions(
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
  const without = remoteLaneActions(state(), handlers())
  // The capability is missing on an older Host or under a grant without it: never "yet".
  expect(item(without, 'Make routine…')).toMatchObject({
    disabled: true,
    hint: 'This Host does not offer routines to this device.',
  })
  const routines = caps([...BASE_CAPS, 'routines'], true)
  const withRoutines = remoteLaneActions(state({ caps: routines }), handlers())
  expect(item(withRoutines, 'Make routine…')).toMatchObject({ disabled: false, hint: undefined })
  expect(
    item(remoteLaneActions(state({ caps: routines, ready: false }), handlers()), 'Make routine…')
      ?.hint,
  ).toBe(REMOTE_NOT_READY)
})
