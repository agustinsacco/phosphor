import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import type { HostCapability } from '@shared/remote-host'
import type { HostConnectionView } from '@shared/ipc'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { openFileInWorkspace, useLayoutStore } from '@/stores/layout'
import { useFilesStore } from '@/stores/files'
import { usePromptStore } from '@/stores/prompt'
import { COMPACT_PLATFORM, PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { RightPane } from '../RightPane'
import { LaneFilesPane } from '../LaneFilesPane'

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
/** Desktop's right pane, or the browser lane's Files at a phone's or a wide window's width. */
export type FilesClient = 'desktop' | 'phone' | 'wide browser'
const BROWSER_PLATFORMS = { phone: COMPACT_PLATFORM, 'wide browser': WIDE_BROWSER_PLATFORM }

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
  useFilesStore.setState({ entries: {}, expanded: {}, directoryMtimes: {}, byWorkspace: {} })
  useRemoteLanesStore.setState({ hosts: {} })
  useSessionsStore.setState({ live: {}, activeSessionId: null })
  useLayoutStore.setState({ bySession: {} })
  usePromptStore.setState({ requests: [] })
  vi.unstubAllGlobals()
}

/** Replace the mock Host's view, as a stream or connection update does. */
export function updateHost(update: (host: HostConnectionView) => HostConnectionView): void {
  const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]
  if (!host) throw new Error('No Host seeded')
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: update(host) } })
}

/**
 * A Host with two text files that checks revisions the way `fs.write` does; `write` runs before
 * each write is applied, so a test can hold or fail it.
 */
export function fakeLaneHost(write?: (path: string) => Promise<void> | undefined) {
  const files: Record<string, { content: string; revision: string }> = {
    'a.ts': { content: 'A text', revision: 'rev-a1' },
    'b.ts': { content: 'B text', revision: 'rev-b1' },
  }
  let next = 1
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const relative = (path: unknown) => String(path).replace(/^host:[^/]+\/lane:[^/]+\//, '')
    switch (channel) {
      case 'fs:listFiles':
        return Object.keys(files)
      case 'git:statusMap':
        return { 'a.ts': ' M' }
      case 'fs:readFile': {
        const file = files[relative(args[0])]
        if (!file) throw new Error('not-found')
        return { ...file, path: args[0], binary: false, size: file.content.length, mtimeMs: 0 }
      }
      case 'fs:writeFile': {
        await write?.(relative(args[0]))
        const file = files[relative(args[0])]
        if (!file || file.revision !== args[2]) throw new Error('changed-on-disk')
        file.content = String(args[1])
        file.revision = `rev-${++next}`
        return { mtimeMs: next, revision: file.revision }
      }
      default:
        throw new Error(`Unexpected channel ${channel}`)
    }
  }
  return { files, invoke }
}

export async function renderLaneFiles({
  invoke,
  capabilities = ['sessions.read', 'sessions.control', 'workspaces.read', 'workspaces.write'],
  controller = true,
  client = 'desktop',
  inactive = false,
}: {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  capabilities?: HostCapability[]
  controller?: boolean
  client?: FilesClient
  /** The browser: the lane is not active yet when its pane mounts, as while it is opening. */
  inactive?: boolean
}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // jsdom has no layout; the explorer and the tabs scroll their active row into view.
  Element.prototype.scrollIntoView ??= () => {}
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
  const shown = { lane: 'a' as LaneName | null, activate: !inactive }
  const show = (lane: LaneName | null) => {
    shown.lane = lane
    const activate = shown.activate
    shown.activate = true
    return showLane(root, client, lane, activate)
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
    ...(client === 'phone' ? phoneActions(container) : paneActions(container)),
  }
}

/** Render `lane`'s Files as `client` shows it; the browser activates it unless told not to. */
async function showLane(
  root: Root,
  client: FilesClient,
  lane: LaneName | null,
  activate: boolean,
): Promise<void> {
  // The browser shows one lane at a time, and the lane it shows is the active one.
  if (client !== 'desktop')
    useSessionsStore.setState({
      activeSessionId: !activate ? 'previous-lane' : lane ? lanes[lane].sessionId : null,
    })
  await act(async () =>
    root.render(
      !lane ? (
        <div>No lane</div>
      ) : client === 'desktop' ? (
        <RightPane workspacePath={lanes[lane].workspacePath} sessionId={lanes[lane].sessionId} />
      ) : (
        <PlatformProvider value={BROWSER_PLATFORMS[client]}>
          <LaneFilesPane
            workspacePath={lanes[lane].workspacePath}
            sessionId={lanes[lane].sessionId}
          />
        </PlatformProvider>
      ),
    ),
  )
}

/** What a user does inside the pane: the tree, the editor and its save. */
function paneActions(container: HTMLElement) {
  const rows = () => [
    ...container.querySelectorAll<HTMLElement>('[data-testid="file-explorer"] [data-path]'),
  ]
  const row = (path: string) => rows().find((r) => r.dataset.path?.endsWith(`/${path}`))
  const tab = (path: string) =>
    [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (t) => t.dataset.tooltip === path,
    )
  const editor = (path: string) =>
    [...container.querySelectorAll<HTMLTextAreaElement>('textarea[data-model]')].find((t) =>
      t.dataset.model?.endsWith(`/${path}`),
    )
  const clickTreeRow = async (path: string): Promise<void> => {
    const target = row(path)
    if (!target) throw new Error(`No tree row for ${path}`)
    await act(async () => target.click())
  }
  /** The file's editor: its tab when it is open, else the tree. */
  const showEditor = async (path: string): Promise<HTMLTextAreaElement | undefined> => {
    const open = tab(path)
    if (!editor(path)) await (open ? act(async () => open.click()) : clickTreeRow(path))
    return editor(path)
  }
  return {
    text: (): string => container.textContent ?? '',
    files: (): string[] => rows().map((r) => r.textContent ?? ''),
    clickTreeRow,
    /** A phone's Back to the tree; beside the tree there is none. */
    back: async (_answer?: 'save' | 'discard'): Promise<void> => {
      throw new Error('The tree is beside the file: there is no Back')
    },
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
    /** The toolbar's New file or New folder, in the selected row's folder, named `name`. */
    create: async (kind: 'file' | 'folder', name: string): Promise<void> => {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="New ${kind}"]`)
      if (!button) throw new Error(`No New ${kind} button`)
      const stop = usePromptStore.subscribe((state) => {
        for (const request of state.requests) usePromptStore.getState().dismiss(request, name)
      })
      try {
        await act(async () => button.click())
        await act(async () => {})
      } finally {
        stop()
      }
    },
    /** The explorer marks this file as modified in git. */
    marked: (path: string): boolean => !!row(path)?.querySelector('[data-tooltip="modified"]'),
  }
}

/**
 * The same actions on a phone, where the tree and the open file are separate screens: the file
 * reads as text until Edit, and Back to the tree closes it, asking first when it has edits.
 */
function phoneActions(container: HTMLElement) {
  const pane = paneActions(container)
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === label,
    )
  const shown = (): string | undefined =>
    container.querySelector<HTMLElement>('[aria-label="Current file path"]')?.dataset.tooltip
  const field = () => container.querySelector<HTMLTextAreaElement>('textarea')
  const row = (path: string) =>
    [...container.querySelectorAll<HTMLElement>('[data-testid="file-explorer"] [data-path]')].find(
      (r) => r.dataset.path?.endsWith(`/${path}`) && !r.closest('[hidden]'),
    )
  /** Back to the tree; `answer` is the reply to "Save changes?" when the file has edits. */
  const back = async (answer?: 'save' | 'discard'): Promise<void> => {
    const target = button('← Files')
    if (!target) return
    const stop = usePromptStore.subscribe((state) => {
      for (const request of state.requests) usePromptStore.getState().dismiss(request, answer)
    })
    try {
      await act(async () => target.click())
      await act(async () => {})
    } finally {
      stop()
    }
  }
  const clickTreeRow = async (path: string): Promise<void> => {
    if (!row(path)) await back()
    const target = row(path)
    if (!target) throw new Error(`No tree row for ${path}`)
    await act(async () => target.click())
  }
  /** The file on screen: the one shown, else the tree's row. */
  const showFile = async (path: string): Promise<boolean> => {
    if (!shown()?.endsWith(`/${path}`)) await clickTreeRow(path)
    return !!shown()?.endsWith(`/${path}`)
  }
  return {
    ...pane,
    back,
    clickTreeRow,
    /** Types into the file's text field, after Edit; false when it offers no Edit (read only). */
    edit: async (path: string, text: string): Promise<boolean> => {
      if (!(await showFile(path))) return false
      const edit = button('Edit')
      if (!field() && edit) await act(async () => edit.click())
      const target = field()
      if (!target || target.readOnly) return false
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      await act(async () => {
        setValue.call(target, text)
        target.dispatchEvent(new Event('input', { bubbles: true }))
      })
      return true
    },
    /** The file's Save, which a phone shows while it has edits to save. */
    save: async (path: string): Promise<void> => {
      if (!(await showFile(path))) throw new Error(`No file screen for ${path}`)
      const save = button('Save')
      if (save) await act(async () => save.click())
    },
    /** What the file screen shows: the text field while editing, else the read view. */
    content: async (path: string): Promise<string | undefined> => {
      if (!(await showFile(path))) return undefined
      return field()?.value ?? container.querySelector('pre[data-code]')?.textContent ?? undefined
    },
  }
}
