// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { watchWindowMotion } from './windowMotion'

const inactive = (): boolean => document.documentElement.hasAttribute('data-window-inactive')
let stop: () => void
let focused: boolean

beforeEach(() => {
  vi.useFakeTimers()
  focused = true
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  stop = watchWindowMotion()
})
afterEach(() => {
  stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('never pauses at mount, even in a window that has no focus', () => {
  focused = false
  stop()
  stop = watchWindowMotion()
  expect(inactive()).toBe(false)
})

it('pauses when the window loses focus and resumes when it gets it back', () => {
  focused = false
  window.dispatchEvent(new Event('blur'))
  vi.runAllTimers()
  expect(inactive()).toBe(true)
  focused = true
  window.dispatchEvent(new Event('focus'))
  expect(inactive()).toBe(false)
})

it('keeps running when focus only moved into a child frame', () => {
  window.dispatchEvent(new Event('blur'))
  vi.runAllTimers()
  expect(inactive()).toBe(false)
})

it('ignores a blur that focus returns from before it settles', () => {
  focused = false
  window.dispatchEvent(new Event('blur'))
  focused = true
  window.dispatchEvent(new Event('focus'))
  vi.runAllTimers()
  expect(inactive()).toBe(false)
})

it('leaves motion running once it stops watching', () => {
  focused = false
  window.dispatchEvent(new Event('blur'))
  vi.runAllTimers()
  stop()
  expect(inactive()).toBe(false)
  window.dispatchEvent(new Event('blur'))
  vi.runAllTimers()
  expect(inactive()).toBe(false)
})
