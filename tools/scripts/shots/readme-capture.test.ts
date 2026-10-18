import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { captureShot, nudge, settle } from './readme-capture.mjs'

vi.mock('node:fs/promises', () => ({ writeFile: vi.fn() }))
vi.mock('node:fs', () => ({ statSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

function captureState() {
  const events: unknown[][] = []
  const win = {
    isDestroyed: () => false,
    isVisible: vi.fn(() => false),
    show: vi.fn(() => events.push(['show'])),
    moveTop: () => events.push(['moveTop']),
    focus: () => events.push(['focus']),
    getBounds: () => ({ x: 10, y: 20, width: 1200, height: 800 }),
    setBounds: (bounds: object) => events.push(['bounds', bounds]),
    capturePage: async () => {
      events.push(['capture'])
      return { toDataURL: () => 'data:image/png;base64,aGVsbG8=' }
    },
  }
  const electron = { BrowserWindow: { getAllWindows: vi.fn(() => [win]) } }
  const app = {
    evaluate: vi.fn(async (fn: (e: typeof electron, dy?: number) => unknown, dy?: number) =>
      fn(electron, dy),
    ),
  }
  const page = {
    waitForTimeout: vi.fn(async (ms: number) => {
      events.push(['wait', ms])
    }),
  }
  return {
    app,
    page,
    outDir: '/shots',
    maxWidth: 1440,
    only: [] as string[],
    shots: [] as string[],
    events,
    win,
    electron,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(statSync).mockReturnValue({ size: 2048 } as ReturnType<typeof statSync>)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('readme capture', () => {
  it('nudges the first live window, waits, writes the decoded image, then downscales', async () => {
    const state = captureState()
    vi.mocked(writeFile).mockImplementation(async (...args) => {
      state.events.push(['write', ...args])
    })
    vi.mocked(execFileSync).mockImplementation((...args) => {
      state.events.push(['exec', ...args])
      return Buffer.alloc(0)
    })
    await captureShot(state, 'chat')
    expect(state.events).toEqual([
      ['show'],
      ['moveTop'],
      ['focus'],
      ['bounds', { x: 10, y: 20, width: 1200, height: 799 }],
      ['wait', 200],
      ['show'],
      ['moveTop'],
      ['focus'],
      ['bounds', { x: 10, y: 20, width: 1200, height: 801 }],
      ['wait', 400],
      ['capture'],
      ['write', '/shots/chat.png', Buffer.from('hello')],
      [
        'exec',
        'sips',
        ['-Z', '1440', '/shots/chat.png', '--out', '/shots/chat.png'],
        { stdio: 'ignore' },
      ],
    ])
    expect(state.shots).toEqual(['chat'])
    expect(console.log).toHaveBeenCalledWith('  ✓ chat.png (2 KB)')
  })

  it('does nothing for an excluded name', async () => {
    const state = captureState()
    state.only = ['settings']
    await captureShot(state, 'chat')
    expect(state.app.evaluate).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
    expect(state.shots).toEqual([])
  })

  it('captures a selected name and tolerates unavailable sips', async () => {
    const state = captureState()
    state.only = ['chat']
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not installed')
    })
    await captureShot(state, 'chat')
    expect(writeFile).toHaveBeenCalledOnce()
    expect(state.shots).toEqual(['chat'])
  })

  it.each([0, -1, Number.NaN])('does not downscale for maxWidth=%s', async (maxWidth) => {
    const state = { ...captureState(), maxWidth }
    await captureShot(state, 'chat')
    expect(execFileSync).not.toHaveBeenCalled()
    expect(state.shots).toEqual(['chat'])
  })

  it('does not count or downscale a failed image write', async () => {
    const state = captureState()
    vi.mocked(writeFile).mockRejectedValue(new Error('disk failed'))
    await expect(captureShot(state, 'chat')).rejects.toThrow('disk failed')
    expect(state.shots).toEqual([])
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('ignores destroyed windows and does not show an already visible window', async () => {
    const state = captureState()
    state.win.isVisible.mockReturnValue(true)
    state.electron.BrowserWindow.getAllWindows.mockReturnValue([
      {
        ...state.win,
        isDestroyed: () => true,
        setBounds: () => {
          throw new Error('destroyed')
        },
      },
      state.win,
    ])
    await nudge(state.app, -1)
    expect(state.win.show).not.toHaveBeenCalled()
    expect(state.events.at(-1)).toEqual(['bounds', { x: 10, y: 20, width: 1200, height: 799 }])
    state.electron.BrowserWindow.getAllWindows.mockReturnValue([])
    await nudge(state.app, 1)
    expect(state.events).toHaveLength(3)
  })

  it('settles with the original default or explicit duration', async () => {
    const { page } = captureState()
    await settle(page)
    await settle(page, 3500)
    expect(page.waitForTimeout.mock.calls).toEqual([[2400], [3500]])
  })
})
