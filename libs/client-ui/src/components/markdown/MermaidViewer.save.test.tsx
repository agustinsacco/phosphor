// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MermaidViewer } from './MermaidViewer'
import { COMPACT_PLATFORM, DESKTOP_PLATFORM, PlatformProvider } from '@/platform/Platform'

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

async function clickSave(platform = DESKTOP_PLATFORM, label = 'Save SVG'): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(
      <PlatformProvider value={platform}>
        <MermaidViewer
          svg='<svg viewBox="0 0 10 10"><g/></svg>'
          code="graph TD"
          onClose={() => {}}
        />
      </PlatformProvider>,
    ),
  )
  const save = [...document.querySelectorAll('button')].find((b) => b.textContent === label)
  expect(save).toBeDefined()
  await act(async () => save?.click())
  act(() => root.unmount())
  container.remove()
}

it('Desktop: Save SVG asks where, writes the serialized diagram there and reveals it', async () => {
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
  expect(invoke).toHaveBeenLastCalledWith('app:revealPath', '/out/diagram.svg')
})

it('Desktop: a cancelled Save SVG writes nothing', async () => {
  invoke.mockResolvedValue(null)
  await clickSave()
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['app:saveDialog'])
})

it('a browser shows Download SVG and downloads the diagram, with no native channel', async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  URL.createObjectURL = vi.fn(() => 'blob:x')
  await clickSave(COMPACT_PLATFORM, 'Download SVG')
  expect(invoke).not.toHaveBeenCalled()
  expect(click).toHaveBeenCalledOnce()
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('diagram.svg')
  click.mockRestore()
})
