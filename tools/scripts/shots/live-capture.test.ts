import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLiveCapture } from './live-capture.mjs'
import { redactLivePage } from './live-redaction.mjs'

const io = vi.hoisted(() => ({ write: vi.fn(), resize: vi.fn() }))
vi.mock('node:fs/promises', () => ({ writeFile: io.write, default: { writeFile: io.write } }))
vi.mock('node:fs', () => {
  const methods = { statSync: () => ({ size: 1024 }) }
  return { ...methods, default: methods }
})
vi.mock('node:child_process', () => ({
  execFileSync: io.resize,
  default: { execFileSync: io.resize },
}))

function fixture({
  visible = false,
  maxWidth = 1440,
  wanted = (_name: string): boolean => true,
} = {}) {
  const events: string[] = []
  let height = 900
  const window = {
    isDestroyed: () => false,
    isVisible: () => visible,
    show: () => {
      events.push('show')
    },
    moveTop: () => {
      events.push('top')
    },
    focus: () => {
      events.push('focus')
    },
    getBounds: () => ({ width: 1440, height }),
    setBounds: (bounds: { height: number }) => {
      height = bounds.height
      events.push(`height:${height}`)
    },
    capturePage: async () => {
      events.push('capture')
      return { toDataURL: () => 'data:image/png;base64,cGl4ZWxz' }
    },
  }
  const app = {
    evaluate: async (callback: (ports: object, arg?: number) => unknown, arg?: number) =>
      callback(
        { BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => true }, window] } },
        arg,
      ),
  }
  const page = {
    waitForTimeout: async (ms: number) => {
      events.push(`wait:${ms}`)
    },
    evaluate: vi.fn(async () => {
      events.push('redact')
    }),
  }
  io.write.mockImplementation(async () => {
    events.push('write')
  })
  io.resize.mockImplementation(() => {
    events.push('resize')
  })
  const redactions = [['private', 'public']]
  const capture = createLiveCapture({
    app,
    page,
    outDir: '/fake/shots',
    maxWidth,
    wanted,
    redactions,
  })
  return { ...capture, events, page, redactions }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

it('nudges, settles, redacts, captures and writes before downscaling in requested order', async () => {
  const capture = fixture()
  await capture.shot('home')
  expect(capture.events).toEqual([
    'show',
    'top',
    'focus',
    'height:899',
    'wait:200',
    'show',
    'top',
    'focus',
    'height:900',
    'wait:400',
    'redact',
    'capture',
    'write',
    'resize',
  ])
  expect(capture.page.evaluate).toHaveBeenCalledWith(redactLivePage, capture.redactions)
  expect(io.write).toHaveBeenCalledWith('/fake/shots/home.png', Buffer.from('pixels'))
  expect(io.resize).toHaveBeenCalledWith(
    'sips',
    ['-Z', '1440', '/fake/shots/home.png', '--out', '/fake/shots/home.png'],
    { stdio: 'ignore' },
  )
  await capture.shot('models')
  expect(capture.shots).toEqual(['home', 'models'])
  expect(console.log).toHaveBeenCalledWith('  ✓ home.png (1 KB)')
})

it('filters without nudging, redacting or touching IO, and leaves visible windows visible', async () => {
  const capture = fixture({ visible: true, wanted: (name) => name === 'home' })
  await capture.shot('models')
  expect(capture.events).toEqual([])
  expect(capture.shots).toEqual([])
  expect(io.write).not.toHaveBeenCalled()
  await capture.shot('home')
  expect(capture.events).not.toContain('show')
  expect(capture.shots).toEqual(['home'])
})

it('keeps the native-scale image when sips is unavailable', async () => {
  const capture = fixture()
  io.resize.mockImplementation(() => {
    throw new Error('sips unavailable')
  })
  await expect(capture.shot('home')).resolves.toBeUndefined()
  expect(io.write).toHaveBeenCalledOnce()
  expect(capture.shots).toEqual(['home'])
})

it.each([0, -1])('skips downscaling when MAX_WIDTH is %s', async (maxWidth) => {
  const capture = fixture({ maxWidth })
  await capture.shot('home')
  expect(io.resize).not.toHaveBeenCalled()
  expect(capture.shots).toEqual(['home'])
})

it('never captures or writes if redaction fails', async () => {
  const capture = fixture()
  capture.page.evaluate.mockRejectedValue(new Error('redaction failed'))
  await expect(capture.shot('home')).rejects.toThrow('redaction failed')
  expect(capture.events).not.toContain('capture')
  expect(io.write).not.toHaveBeenCalled()
  expect(capture.shots).toEqual([])
})

it('does not count an image whose write fails', async () => {
  const capture = fixture()
  io.write.mockRejectedValue(new Error('write failed'))
  await expect(capture.shot('home')).rejects.toThrow('write failed')
  expect(io.resize).not.toHaveBeenCalled()
  expect(capture.shots).toEqual([])
})
