// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { ToolBrowser } from './ToolBrowser'
import { parseExposureRules } from './ExposureEditor'

let root: Root
let container: HTMLDivElement
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})
it('searches descriptions and renders server metadata as text, not markup', async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <ToolBrowser
        tools={[
          {
            name: 'get_schedule',
            description: 'Find the on-call responder <script>bad()</script>',
            exposure: 'direct',
          },
          { name: 'list_issues', description: 'Find issues', exposure: 'codemode' },
        ]}
      />,
    ),
  )
  const input = container.querySelector('input')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'responder',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(container.textContent).toContain('get_schedule')
  expect(container.textContent).not.toContain('list_issues')
  expect(container.querySelector('script')).toBeNull()
  expect(container.textContent).toContain('direct')
})
it('preserves rule order and rejects malformed per-tool exposure', () => {
  expect(Object.keys(parseExposureRules('{"get_*":"direct","*":"hidden"}'))).toEqual(['get_*', '*'])
  for (const text of ['[]', 'null', '{"read":"invalid"}', '{"":"direct"}'])
    expect(() => parseExposureRules(text)).toThrow()
})
