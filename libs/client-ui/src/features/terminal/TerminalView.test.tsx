// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TerminalView } from './TerminalView'

const terminal = vi.hoisted(() => ({
  cols: 93,
  rows: 31,
  options: {},
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn((_data: string, done?: () => void) => done?.()),
  reset: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn(),
  attachCustomKeyEventHandler: vi.fn(),
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      return terminal
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('./terminalLinks', () => ({ installTerminalLinks: () => ({ dispose: vi.fn() }) }))
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
let root: Root
let container: HTMLDivElement
let output: (data: string) => void
const invoke = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  window.phosphor = {
    ...window.phosphor,
    invoke,
    onPtyData: (_id, listener) => {
      output = listener
      return () => {}
    },
    onPtyExit: () => () => {},
  }
  invoke.mockReset().mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const render = async (readOnly = false) => {
  await act(async () =>
    root.render(<TerminalView ptyId="remote-pty-test" visible readOnly={readOnly} />),
  )
}
it('failed attach discards held output and offers explicit Retry with fresh scrollback then live output', async () => {
  let reject!: (error: Error) => void
  invoke.mockImplementation((channel: string) =>
    channel === 'pty:attach'
      ? new Promise((_resolve, fail) => {
          reject = fail
        })
      : Promise.resolve(),
  )
  await render()
  await act(async () => {
    output('held')
    reject(new Error('Terminal unavailable.'))
  })
  expect(container.textContent).toContain('Terminal unavailable.')
  expect(container.textContent).toContain('Retry')
  await act(async () => output('ignored'.repeat(50000)))
  expect(invoke.mock.calls.filter((c) => c[0] === 'pty:attach')).toHaveLength(1)
  expect(terminal.write).not.toHaveBeenCalled()
  invoke.mockImplementation((channel: string) =>
    Promise.resolve(channel === 'pty:attach' ? { scrollback: 'fresh' } : undefined),
  )
  await act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Retry')!
      .click(),
  )
  expect(container.textContent).not.toContain('Retry')
  expect(terminal.reset).toHaveBeenCalledTimes(1)
  expect(terminal.write.mock.calls.map((c) => c[0])).toEqual(['fresh'])
  await act(async () => output('live'))
  expect(terminal.write.mock.calls.map((c) => c[0])).toEqual(['fresh', 'live'])
})
it.each([false, true])(
  'delayed attach sends fitted size once only for controller (readOnly=%s)',
  async (readOnly) => {
    let resolve!: (value: { scrollback: string }) => void
    invoke.mockImplementation((channel: string) =>
      channel === 'pty:attach'
        ? new Promise((done) => {
            resolve = done
          })
        : Promise.resolve(),
    )
    await render(readOnly)
    expect(invoke.mock.calls.filter((c) => c[0] === 'pty:resize')).toEqual([])
    await act(async () => resolve({ scrollback: 'prompt' }))
    expect(invoke.mock.calls.filter((c) => c[0] === 'pty:resize')).toEqual(
      readOnly ? [] : [['pty:resize', 'remote-pty-test', 93, 31]],
    )
  },
)
