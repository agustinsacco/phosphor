// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SubmitIconButton } from '@/components/ComposerButtons'
import { closeSoftKeyboard, softKeyboard } from './softKeyboard'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function touchScreen(coarse: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && query.includes('coarse') }))
}

it('is off where the browser cannot answer the media query', () => {
  vi.stubGlobal('matchMedia', undefined)
  expect(softKeyboard()).toBe(false)
})

it('closes the keyboard only on a touch-first device', () => {
  const field = document.createElement('textarea')
  document.body.append(field)
  touchScreen(false)
  field.focus()
  closeSoftKeyboard(field)
  expect(document.activeElement).toBe(field)
  touchScreen(true)
  closeSoftKeyboard(field)
  expect(document.activeElement).not.toBe(field)
})

it('closes the keyboard when the shared send button sends from a phone', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  touchScreen(true)
  const field = document.createElement('textarea')
  const host = document.createElement('div')
  document.body.append(field, host)
  const send = vi.fn()
  const root = createRoot(host)
  act(() => root.render(<SubmitIconButton disabled={false} onClick={send} label="Send" />))
  field.focus()
  act(() => host.querySelector('button')!.click())
  expect(send).toHaveBeenCalledOnce()
  expect(document.activeElement).not.toBe(field)
  act(() => root.unmount())
})
