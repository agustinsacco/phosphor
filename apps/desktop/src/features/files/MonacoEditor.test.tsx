// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { MonacoEditor } from './MonacoEditor'

const { editor, monaco } = vi.hoisted(() => {
  const model = { getValue: () => 'content' }
  const editor = {
    updateOptions: vi.fn(),
    addCommand: vi.fn(),
    onDidChangeModelContent: vi.fn(),
    setModel: vi.fn(),
    getModel: () => model,
    saveViewState: vi.fn(),
    dispose: vi.fn(),
  }
  return {
    editor,
    monaco: {
      editor: { create: vi.fn(() => editor), getModel: () => model, setTheme: vi.fn() },
      Uri: { file: (path: string) => path },
      KeyMod: { CtrlCmd: 1 },
      KeyCode: { KeyS: 2 },
    },
  }
})
vi.mock('@/lib/monaco', () => ({ getMonaco: async () => monaco, monacoThemeFor: () => 'test' }))
vi.mock('@/stores/settings', () => {
  const state = { fonts: {}, resolvedTheme: 'dark' }
  return {
    useSettingsStore: Object.assign((select: (s: typeof state) => unknown) => select(state), {
      getState: () => state,
    }),
  }
})
vi.mock('@/lib/fonts', () => ({ editorFontOptions: () => ({}) }))

it('updates the existing Monaco editor readOnly option on disconnect and reconnect', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(<MonacoEditor path="remote-model" language="text" value="content" />),
    )
    expect(monaco.editor.create).toHaveBeenCalledTimes(1)
    editor.updateOptions.mockClear()
    await act(async () =>
      root.render(<MonacoEditor path="remote-model" language="text" value="content" readOnly />),
    )
    expect(editor.updateOptions).toHaveBeenLastCalledWith({ readOnly: true })
    await act(async () =>
      root.render(
        <MonacoEditor path="remote-model" language="text" value="content" readOnly={false} />,
      ),
    )
    expect(editor.updateOptions).toHaveBeenLastCalledWith({ readOnly: false })
    expect(monaco.editor.create).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
  }
})
