// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalInstructions } from '@shared/global-instructions'
import { promptChoice } from '@/stores/prompt'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { InstructionsEditor } from './InstructionsEditor'
import type { InstructionsSource } from './instructionsSource'

vi.mock('@/features/files/MonacoEditor', () => ({
  MonacoEditor: ({
    path,
    value,
    onChange,
  }: {
    path: string
    value: string
    onChange: (v: string) => void
  }) => <textarea data-path={path} value={value} onChange={(e) => onChange(e.target.value)} />,
}))
vi.mock('@/components/markdown/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => <div data-markdown>{text}</div>,
}))
vi.mock('@/stores/prompt', () => ({ promptChoice: vi.fn() }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rev = (n: number) => n.toString(16).padStart(64, '0')
const file = (content: string, n = 1): GlobalInstructions => ({
  path: '/home/dev/.pi/agent/AGENTS.md',
  content,
  revision: rev(n),
  exists: true,
})

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.mocked(promptChoice).mockReset()
  useExtensionUiStore.setState({ toasts: [] } as never)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function source(overrides: Partial<InstructionsSource> = {}): InstructionsSource {
  return {
    key: 'local',
    machine: 'This computer',
    read: vi.fn(async () => file('# Rules\n')),
    save: vi.fn(async (content: string) => file(content, 2)),
    ...overrides,
  }
}
const dialog = () => document.body.querySelector('[role="dialog"]')!
const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent === label)!
const editor = () => document.body.querySelector('textarea')!
async function type(text: string): Promise<void> {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    set.call(editor(), text)
    editor().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function open(src: InstructionsSource, onClose = vi.fn()) {
  await act(async () => root.render(<InstructionsEditor source={src} onClose={onClose} />))
  return onClose
}

describe('InstructionsEditor', () => {
  it('names the machine and the file pi loads, and saves against the revision it read', async () => {
    const src = source()
    await open(src)
    expect(dialog().textContent).toContain('Global instructions on This computer')
    expect(dialog().textContent).toContain('/home/dev/.pi/agent/AGENTS.md')
    expect(editor().value).toBe('# Rules\n')
    expect(button('Save').disabled).toBe(true)
    await type('# Rules\n\n- Be brief.\n')
    expect(button('Save').disabled).toBe(false)
    await act(async () => button('Save').click())
    expect(src.save).toHaveBeenCalledWith('# Rules\n\n- Be brief.\n', rev(1))
    expect(button('Save').disabled).toBe(true)
    expect(JSON.stringify(useExtensionUiStore.getState())).toContain('Saved on This computer')
  })

  it('saves with Cmd/Ctrl+S', async () => {
    const src = source()
    await open(src)
    await type('changed')
    await act(async () =>
      editor().dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }),
      ),
    )
    expect(src.save).toHaveBeenCalledWith('changed', rev(1))
  })

  it('keeps the draft on a refused save and reloads only when asked', async () => {
    const read = vi.fn().mockResolvedValueOnce(file('old')).mockResolvedValueOnce(file('theirs', 3))
    const src = source({
      read,
      save: vi.fn(async () => {
        throw new Error('The instructions file changed on disk.')
      }),
    })
    await open(src)
    await type('mine')
    await act(async () => button('Save').click())
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('changed on disk')
    expect(editor().value).toBe('mine')
    vi.mocked(promptChoice).mockResolvedValueOnce('keep')
    await act(async () => button('Reload').click())
    expect(read).toHaveBeenCalledTimes(1)
    vi.mocked(promptChoice).mockResolvedValueOnce('leave')
    await act(async () => button('Reload').click())
    expect(editor().value).toBe('theirs')
    expect(dialog().querySelector('[role="alert"]')).toBeNull()
  })

  it('asks before closing over unsaved edits', async () => {
    const onClose = await open(source())
    await act(async () => button('Close').click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(promptChoice).not.toHaveBeenCalled()
    await type('unsaved')
    vi.mocked(promptChoice).mockResolvedValueOnce('keep')
    await act(async () => button('Cancel').click())
    expect(onClose).toHaveBeenCalledOnce()
    vi.mocked(promptChoice).mockResolvedValueOnce('leave')
    await act(async () => button('Cancel').click())
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('shows a failed first read and recovers on reload', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('Host unreachable'))
      .mockResolvedValueOnce(file('back'))
    await open(source({ read }))
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('Host unreachable')
    expect(document.body.querySelector('textarea')).toBeNull()
    await act(async () => button('Reload').click())
    expect(editor().value).toBe('back')
  })

  it('previews the draft as markdown', async () => {
    await open(source())
    await type('# Draft')
    await act(async () => button('preview').click())
    expect(dialog().querySelector('[data-markdown]')!.textContent).toBe('# Draft')
  })
})
