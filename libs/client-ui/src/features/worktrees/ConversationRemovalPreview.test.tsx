// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { ConversationRemovalPreview } from './ConversationRemovalPreview'

let container: HTMLDivElement
let root: Root
let restore: () => void
let dispose: () => void
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore?.()
  dispose?.()
})

it('requires preview confirmation and recovers from a failed first load', async () => {
  let fail = true
  const fake = createFakePhosphor({
    'sessions:list': () => {
      if (fail) return Promise.reject(new Error('temporary failure'))
      return Promise.resolve([])
    },
  })
  restore = installFakePhosphor(fake)
  dispose = fake.dispose
  const onConfirm = vi.fn()
  await act(async () =>
    root.render(<ConversationRemovalPreview path="/repo/lane" onConfirm={onConfirm} />),
  )
  expect(container.textContent).toContain('temporary failure')
  expect(onConfirm).toHaveBeenLastCalledWith(false)
  fail = false
  await act(async () => container.querySelector('button')!.click())
  expect(container.textContent).toContain('Remove checkout for 0 conversations')
  await act(async () => container.querySelector('input')!.click())
  expect(onConfirm).toHaveBeenLastCalledWith(true)
})
