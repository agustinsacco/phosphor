// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalStore } from '@/stores/terminal'
import { TerminalView } from './TerminalView'

const terminal = vi.hoisted(() => ({
  cols: 93,
  rows: 31,
  options: {},
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  modes: { bracketedPasteMode: false },
  parsed: new Set<() => void>(),
  onWriteParsed: vi.fn((listener: () => void) => {
    terminal.parsed.add(listener)
    return { dispose: () => terminal.parsed.delete(listener) }
  }),
  write: vi.fn((data: string, done?: () => void) => {
    if (data.includes('\x1b[?2004h')) terminal.modes.bracketedPasteMode = true
    done?.()
    terminal.parsed.forEach((listener) => listener())
  }),
  paste: vi.fn(),
  input: vi.fn(),
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
  terminal.modes.bracketedPasteMode = false
  terminal.parsed.clear()
  useTerminalStore.setState({ pendingPaste: null })
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

describe('a multiline Run in terminal on a cold shell', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const staged = () => container.querySelector('[aria-label="Staged terminal command"]')
  const start = async () => {
    useTerminalStore.getState().queuePaste('remote-pty-test', 'printf one\nprintf two', false)
    invoke.mockImplementation((channel: string) =>
      Promise.resolve(channel === 'pty:attach' ? { scrollback: 'Last login' } : undefined),
    )
    await render()
  }

  it('pastes once the shell turns bracketed paste on after its first output', async () => {
    await start()
    await act(async () => output('\x1b[?2004h% '))
    await act(async () => vi.advanceTimersByTime(1000))
    expect(terminal.paste).toHaveBeenCalledWith('printf one\nprintf two')
    expect(staged()).toBeNull()
  })

  it('stages it for review when the shell settles without bracketed paste', async () => {
    await start()
    await act(async () => output('$ '))
    await act(async () => vi.advanceTimersByTime(1000))
    expect(terminal.paste).not.toHaveBeenCalled()
    expect(staged()).not.toBeNull()
  })
})
