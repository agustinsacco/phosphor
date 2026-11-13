import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  shown: [] as Array<{ options: { title: string; body: string }; emitter: EventEmitter }>,
  supported: true,
  stub: undefined as string | undefined,
}))
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    Notification: class extends Emitter {
      static isSupported = () => mocks.supported
      constructor(options: { title: string; body: string }) {
        super()
        mocks.shown.push({ options, emitter: this })
      }
      show(): void {}
    },
  }
})
vi.mock('../pi/stub', () => ({ piStubPath: () => mocks.stub }))

import { showNativeNotice } from './native-notice'

function fakeWindow(focused = false) {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => focused),
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  })
}
type Win = Parameters<typeof showNativeNotice>[0]

beforeEach(() => {
  mocks.shown.length = 0
  mocks.supported = true
  mocks.stub = undefined
})

it('shows only while the window is in the background, and a click brings it forward', async () => {
  expect(
    await showNativeNotice(fakeWindow(true) as unknown as Win, { title: 't', body: 'b' }),
  ).toBe(false)
  expect(mocks.shown).toHaveLength(0)

  const win = fakeWindow()
  const clicked = showNativeNotice(win as unknown as Win, {
    title: '#57   Rocky review failed',
    body: 'Refactor auth · phosphor',
  })
  expect(mocks.shown[0]!.options).toEqual({
    title: '#57 Rocky review failed',
    body: 'Refactor auth · phosphor',
  })
  mocks.shown[0]!.emitter.emit('click')
  expect(await clicked).toBe(true)
  expect(win.restore).toHaveBeenCalled()
  expect(win.focus).toHaveBeenCalled()
})

it('settles false when it closes unclicked or the window goes first', async () => {
  const closed = showNativeNotice(fakeWindow() as unknown as Win, { title: 't', body: '' })
  mocks.shown[0]!.emitter.emit('close')
  expect(await closed).toBe(false)

  const win = fakeWindow()
  const gone = showNativeNotice(win as unknown as Win, { title: 't', body: '' })
  win.emit('closed')
  expect(await gone).toBe(false)
  expect(win.listenerCount('closed')).toBe(0)
})

it('never shows under the e2e stub, without OS support, or without a title', async () => {
  mocks.stub = '/stub'
  expect(await showNativeNotice(fakeWindow() as unknown as Win, { title: 't', body: '' })).toBe(
    false,
  )
  mocks.stub = undefined
  mocks.supported = false
  expect(await showNativeNotice(fakeWindow() as unknown as Win, { title: 't', body: '' })).toBe(
    false,
  )
  mocks.supported = true
  expect(await showNativeNotice(fakeWindow() as unknown as Win, { title: ' ', body: '' })).toBe(
    false,
  )
  expect(await showNativeNotice(null, { title: 't', body: '' })).toBe(false)
  expect(mocks.shown).toHaveLength(0)
})
