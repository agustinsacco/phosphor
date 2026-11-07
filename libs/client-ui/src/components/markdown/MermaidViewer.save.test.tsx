// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MermaidViewer } from './MermaidViewer'

const invoke = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  )
  vi.stubGlobal('phosphor', { invoke })
  invoke.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

async function clickSave(): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(
      <MermaidViewer
        svg='<svg viewBox="0 0 10 10"><g/></svg>'
        code="graph TD"
        onClose={() => {}}
      />,
    ),
  )
  const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save SVG')
  await act(async () => save?.click())
  act(() => root.unmount())
  container.remove()
}

it('Desktop: Save SVG asks where, then writes the serialized diagram there', async () => {
  invoke.mockImplementation(async (channel: string) =>
    channel === 'app:saveDialog' ? '/out/diagram.svg' : undefined,
  )
  await clickSave()
  expect(invoke.mock.calls[0]).toEqual([
    'app:saveDialog',
    expect.objectContaining({ title: 'Save diagram', defaultPath: 'diagram.svg' }),
  ])
  expect(invoke).toHaveBeenCalledWith(
    'fs:writeFile',
    '/out/diagram.svg',
    expect.stringContaining('<svg'),
  )
})

it('Desktop: a cancelled Save SVG writes nothing', async () => {
  invoke.mockResolvedValue(null)
  await clickSave()
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['app:saveDialog'])
})
