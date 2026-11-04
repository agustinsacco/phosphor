// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RepositoryFilePreview } from './RepositoryFilePreview'

vi.mock('./MonacoEditor', () => ({
  MonacoEditor: ({ language }: { language: string }) => <textarea data-language={language} />,
}))
vi.mock('@/components/markdown/CodeBlock', () => ({
  CodeBlock: ({ code, language }: { code: string; language: string }) => (
    <pre data-language={language}>{code}</pre>
  ),
}))

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  vi.unstubAllGlobals()
})

it.each([
  ['the browser', false],
  ['Desktop', true],
] as const)(
  "colours a machine's repository file in %s by its path's language",
  async (_, nativeEditor) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div')
    root = createRoot(container)
    await act(async () =>
      root!.render(
        <RepositoryFilePreview
          nativeEditor={nativeEditor}
          path="src/app.ts"
          resourcePath="host:bee/repository:r/src/app.ts"
          preview="const a = 1"
          reading={false}
          binary={false}
        />,
      ),
    )
    expect(container.querySelector('[data-language]')?.getAttribute('data-language')).toBe(
      'typescript',
    )
  },
)
