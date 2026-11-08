import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { vi } from 'vitest'
import type { HostCapability } from '@shared/remote-host'
import type { HostConnectionView } from '@shared/ipc'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { openFileInWorkspace, useLayoutStore } from '@/stores/layout'
import { useFilesStore } from '@/stores/files'
import { RightPane } from '../RightPane'
import { useRemoteFileDrafts } from '../remoteFileDrafts'
import { useRemoteFileSelection } from '../remoteFileSelectionStore'

/**
 * Host-lane Files at the pane boundary: the lane's right pane, driven by what a user does.
 * Tests pin outcomes through these helpers; only this file knows which pane renders them.
 */
const fixtureLane = mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!
export const laneCwd = fixtureLane.cwd
export const lanes = {
  a: mockRemoteInfo,
  b: {
    ...mockRemoteInfo,
    sessionId: `${mockRemoteInfo.sessionId}-b`,
    laneId: 'lane-b',
    workspacePath: `host:${MOCK_HOST_ID}/lane:lane-b`,
  },
}
export type LaneName = keyof typeof lanes

export function seedLaneFiles({
  capabilities,
  controller,
}: {
  capabilities: HostCapability[]
  controller: boolean
}): void {
  useSessionsStore.setState({
    live: Object.fromEntries(
      Object.values(lanes).map((info) => [info.sessionId, { ...info, phosphorId: info.sessionId }]),
    ),
  })
  const host = mockRemoteHosts[MOCK_HOST_ID]!
  useRemoteLanesStore.setState({
    hosts: {
      [MOCK_HOST_ID]: {
        ...host,
        state: 'ready',
        capabilities,
        lanes: Object.values(lanes).map((info) => ({
          ...fixtureLane,
          laneId: info.laneId!,
          control: {
            ...fixtureLane.control,
            controller: controller
              ? { self: true, label: 'Desktop', connected: true }
              : fixtureLane.control.controller,
          },
        })),
      },
    },
  })
  useLayoutStore.setState({
    bySession: Object.fromEntries(
      Object.values(lanes).map((info) => [
        info.sessionId,
        { pane: 'files', expanded: false, side: 'right', size: 45 },
      ]),
    ),
  })
}

export function resetLaneFiles(): void {
  useRemoteFileDrafts.setState({ bySession: {} })
  useRemoteFileSelection.setState({ bySession: {}, blocked: {} })
  useFilesStore.setState({ entries: {}, expanded: {}, directoryMtimes: {}, byWorkspace: {} })
  useRemoteLanesStore.setState({ hosts: {} })
  useSessionsStore.setState({ live: {} })
  useLayoutStore.setState({ bySession: {} })
  vi.unstubAllGlobals()
}

/** Replace the mock Host's view, as a stream or connection update does. */
export function updateHost(update: (host: HostConnectionView) => HostConnectionView): void {
  const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]
  if (!host) throw new Error('No Host seeded')
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: update(host) } })
}

export async function renderLaneFiles({
  invoke,
  capabilities = ['sessions.read', 'sessions.control', 'workspaces.read', 'workspaces.write'],
  controller = true,
}: {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  capabilities?: HostCapability[]
  controller?: boolean
}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  seedLaneFiles({ capabilities, controller })
  const calls: unknown[][] = []
  vi.stubGlobal('phosphor', {
    invoke: (channel: string, ...args: unknown[]) => {
      calls.push([channel, ...args])
      return invoke(channel, ...args)
    },
    onSessionPush: () => () => {},
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const shown = { lane: 'a' as LaneName | null }
  const show = async (lane: LaneName | null): Promise<void> => {
    shown.lane = lane
    await act(async () =>
      root.render(
        lane ? (
          <RightPane workspacePath={lanes[lane].workspacePath} sessionId={lanes[lane].sessionId} />
        ) : (
          <div>No lane</div>
        ),
      ),
    )
  }
  await show('a')
  return {
    container,
    calls,
    show,
    remount: async (): Promise<void> => {
      const lane = shown.lane
      await show(null)
      await show(lane)
    },
    /** A chat file link in this lane's transcript; resolves whether or not the pane opened it. */
    openFromChat: async (path: string): Promise<void> => {
      const lane = lanes[shown.lane ?? 'a']
      await act(async () => {
        await openFileInWorkspace(lane.workspacePath, path, undefined, lane.sessionId).catch(
          () => undefined,
        )
      })
    },
    savesSent: (): unknown[][] => calls.filter(([channel]) => channel === 'fs:writeFile'),
    count: (channel: string): number => calls.filter(([c]) => c === channel).length,
    unmount: (): void => {
      act(() => root.unmount())
      container.remove()
    },
    ...paneActions(container),
  }
}

/** What a user does inside the pane: the tree, the editor and its save. */
function paneActions(container: HTMLElement) {
  const rows = () => [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
  const row = (path: string) => rows().find((r) => r.textContent?.includes(path))
  const editor = (path: string) =>
    [...container.querySelectorAll<HTMLTextAreaElement>('textarea[data-model]')].find((t) =>
      t.dataset.model?.endsWith(`/${path}`),
    )
  const clickTreeRow = async (path: string): Promise<void> => {
    const target = row(path)
    if (!target) throw new Error(`No tree row for ${path}`)
    await act(async () => target.click())
  }
  /** The file's editor, opening it from the tree when it is not showing. */
  const showEditor = async (path: string): Promise<HTMLTextAreaElement | undefined> => {
    if (!editor(path)) await clickTreeRow(path)
    return editor(path)
  }
  return {
    text: (): string => container.textContent ?? '',
    files: (): string[] => rows().map((r) => r.textContent ?? ''),
    clickTreeRow,
    /** Types into the file's editor; false when the editor refuses input (read only). */
    edit: async (path: string, text: string): Promise<boolean> => {
      const target = await showEditor(path)
      if (!target || target.readOnly) return false
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      await act(async () => {
        setValue.call(target, text)
        target.dispatchEvent(new Event('input', { bubbles: true }))
      })
      return true
    },
    /** The editor's save (⌘S) for this file. */
    save: async (path: string): Promise<void> => {
      await showEditor(path)
      const button = [...container.querySelectorAll<HTMLButtonElement>('button[data-save]')].find(
        (b) => b.dataset.save?.endsWith(`/${path}`),
      )
      if (!button) throw new Error(`No editor for ${path}`)
      await act(async () => button.click())
    },
    content: async (path: string): Promise<string | undefined> => (await showEditor(path))?.value,
    /** The explorer marks this file as modified in git. */
    marked: (path: string): boolean =>
      /\bM\b/.test(row(path)?.textContent?.replace(path, '') ?? ''),
  }
}
