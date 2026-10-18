// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFilesStore, workspaceFiles } from '@/stores/files'
import { useEditorTabShortcuts } from './editorTabActions'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./MonacoEditor', () => ({ releaseFileModel: () => {} }))
const invoke = vi.fn()
let root: Root
let host: HTMLDivElement
function Harness() {
  useEditorTabShortcuts('/repo')
  return (
    <>
      <div data-testid="right-pane">
        <textarea aria-label="Editor" />
      </div>
      <textarea aria-label="Chat" />
    </>
  )
}

beforeEach(async () => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.assign(window, { phosphor: { invoke } })
  invoke.mockReset().mockResolvedValue({ content: 'disk', size: 4, mtimeMs: 1 })
  useFilesStore.setState({ byWorkspace: {} })
  for (const path of ['/repo/a.ts', '/repo/b.ts']) {
    await useFilesStore.getState().openFile('/repo', path)
    useFilesStore.getState().updateBuffer('/repo', path, 'unsaved')
  }
  invoke.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<Harness />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function press(
  init: KeyboardEventInit,
  options: { handled?: boolean; altGraph?: boolean; target?: string } = {},
) {
  const event = new KeyboardEvent('keydown', {
    key: 's',
    code: 'KeyS',
    bubbles: true,
    cancelable: true,
    ...init,
  })
  if (options.handled) event.preventDefault()
  if (options.altGraph)
    vi.spyOn(event, 'getModifierState').mockImplementation((key) => key === 'AltGraph')
  await act(async () =>
    host.querySelector(`[aria-label="${options.target ?? 'Editor'}"]`)!.dispatchEvent(event),
  )
  return event
}

it.each([{ metaKey: true }, { ctrlKey: true }])(
  'dispatches Save All with %j plus Alt+S',
  async (mod) => {
    const event = await press({ ...mod, altKey: true })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    expect(event.defaultPrevented).toBe(true)
    expect(workspaceFiles(useFilesStore.getState(), '/repo').openFiles.every((f) => !f.dirty)).toBe(
      true,
    )
  },
)

it.each([
  { init: { metaKey: true, altKey: true, isComposing: true } },
  { init: { ctrlKey: true, altKey: true, keyCode: 229 } },
  { init: { ctrlKey: true, altKey: true }, altGraph: true },
  { init: { ctrlKey: true, altKey: true, key: 'ß' } },
  { init: { metaKey: true, altKey: true }, handled: true },
  { init: { metaKey: true, altKey: true }, target: 'Chat' },
])('does not hijack protected input %j', async ({ init, ...options }) => {
  await press(init, options)
  expect(invoke).not.toHaveBeenCalled()
})

it('does not save through a visible modal', async () => {
  const modal = document.createElement('div')
  modal.setAttribute('role', 'dialog')
  host.append(modal)
  vi.spyOn(modal, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
  await press({ metaKey: true, altKey: true })
  expect(invoke).not.toHaveBeenCalled()
})
