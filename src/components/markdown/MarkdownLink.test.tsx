// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MarkdownLink } from './MarkdownLink'

// The files store imports `languageForPath` eagerly, and the real module pulls
// in monaco-editor's worker entry points, which vitest cannot resolve.
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'markdown', peekMonaco: () => null }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: () => {} }))
import { sessionPanes, useLayoutStore } from '@/stores/layout'
import { useFilesStore, workspaceFiles } from '@/stores/files'
import { useWorkspacesStore } from '@/stores/workspaces'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSessionsStore } from '@/stores/sessions'
import { useArtifactsStore } from '@/stores/artifacts'

let root: Root | null = null
let container: HTMLDivElement | null = null
let invoke: ReturnType<typeof vi.fn>

function render(ui: React.ReactNode): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(ui)
  })
}

const link = (): HTMLAnchorElement => document.querySelector('a') as HTMLAnchorElement

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

beforeEach(() => {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'fs:readFile') return { content: '# spec', mtimeMs: 1 }
    return undefined
  })
  ;(window as unknown as { phosphor: unknown }).phosphor = { invoke }
  useWorkspacesStore.setState({ homePath: '/repo' })
  useSessionsStore.setState({
    activeSessionId: 's1',
    live: { s1: { phosphorId: 's1', workspacePath: '/repo' } },
  })
  useFilesStore.setState({ byWorkspace: {} })
  useLayoutStore.setState({ bySession: {} })
  useArtifactsStore.setState({ bySession: {}, selected: {}, selectedVersion: {}, unseen: {} })
  useExtensionUiStore.setState({ toasts: [] })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  document.body.innerHTML = ''
})

describe('MarkdownLink', () => {
  it('opens a web URL in the default browser, never in the app', async () => {
    render(<MarkdownLink href="https://github.com/o/r/pull/214">PR</MarkdownLink>)
    await click(link())
    expect(invoke).toHaveBeenCalledWith('app:openExternal', 'https://github.com/o/r/pull/214')
  })

  it('opens a spec the model linked in the Files pane', async () => {
    render(<MarkdownLink href="docs/specs/headroom-compression.md">the spec</MarkdownLink>)
    await click(link())
    expect(invoke).toHaveBeenCalledWith('fs:readFile', '/repo/docs/specs/headroom-compression.md')
    const files = workspaceFiles(useFilesStore.getState(), '/repo')
    expect(files.activePath).toBe('/repo/docs/specs/headroom-compression.md')
    // The point of the link: the Files pane is now on screen, showing it.
    expect(sessionPanes(useLayoutStore.getState(), 's1').pane).toBe('files')
  })

  it('carries no href on a file link, so nothing can navigate the app away', () => {
    render(<MarkdownLink href="docs/x.md">x</MarkdownLink>)
    expect(link().getAttribute('href')).toBeNull()
    expect(link().title).toBe('Open in Files pane')
  })

  it('reveals the line a link names', async () => {
    render(<MarkdownLink href="src/lib/rpc.ts#L42">rpc</MarkdownLink>)
    await click(link())
    const files = workspaceFiles(useFilesStore.getState(), '/repo')
    expect(files.openFiles[0]?.pendingRevealLine).toBe(42)
  })

  it('toasts instead of swapping the pane when the file is gone', async () => {
    invoke.mockRejectedValue(new Error('ENOENT'))
    render(<MarkdownLink href="docs/missing.md">missing</MarkdownLink>)
    await click(link())
    expect(useExtensionUiStore.getState().toasts[0]?.message).toBe('Could not open docs/missing.md')
    expect(sessionPanes(useLayoutStore.getState(), 's1').pane).toBeNull()
  })

  it('opens an artifact link in the Artifacts pane, on that version', async () => {
    useArtifactsStore.getState().ingest('s1', 'artifact_create', {
      id: 'phosphor-beacon',
      title: 'Phosphor Beacon',
      type: 'html',
      content: '<p>x</p>',
      version: 1,
    })
    useLayoutStore.setState({ bySession: {} })
    render(<MarkdownLink href="artifact://phosphor-beacon#v1">Preview the design</MarkdownLink>)
    expect(link().getAttribute('href')).toBeNull()
    expect(link().title).toBe('Open in Artifacts pane at v1')
    await click(link())
    expect(sessionPanes(useLayoutStore.getState(), 's1').pane).toBe('artifacts')
    expect(useArtifactsStore.getState().selected.s1).toBe('phosphor-beacon')
    expect(useArtifactsStore.getState().selectedVersion.s1).toBe(1)
  })

  it('toasts when an artifact link names an id this session never had', async () => {
    render(<MarkdownLink href="artifact://ghost">the design</MarkdownLink>)
    await click(link())
    expect(useExtensionUiStore.getState().toasts[0]?.message).toBe(
      'No artifact "ghost" in this session',
    )
    expect(sessionPanes(useLayoutStore.getState(), 's1').pane).toBeNull()
  })

  it('does nothing for a scheme it refuses to act on', async () => {
    render(<MarkdownLink href="javascript:alert(1)">x</MarkdownLink>)
    await click(link())
    expect(invoke).not.toHaveBeenCalled()
  })
})
