// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { requestReveal, useLaneReveal, useLaneRevealStore } from './laneReveal'

beforeEach(() => useLaneRevealStore.setState({ seq: 0, groupKey: null }))
let root: Root | undefined
function render(node: ReactNode): void {
  root ??= createRoot(document.createElement('div'))
  act(() => root?.render(node))
}
function Hook({ reveal }: { reveal: () => void }): null {
  useLaneReveal('group', reveal)
  return null
}
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
})

it('answers matching requests once and ignores other groups and repeated renders', () => {
  const reveal = vi.fn()
  render(createElement(Hook, { reveal }))
  act(() => requestReveal('other'))
  expect(reveal).not.toHaveBeenCalled()
  act(() => requestReveal('group'))
  expect(reveal).toHaveBeenCalledTimes(1)
  render(createElement(Hook, { reveal: () => reveal() }))
  expect(reveal).toHaveBeenCalledTimes(1)
  act(() => requestReveal('group'))
  expect(reveal).toHaveBeenCalledTimes(2)
})

it('reveals a group mounted after navigation', () => {
  requestReveal('group')
  const reveal = vi.fn()
  render(createElement(Hook, { reveal }))
  expect(reveal).toHaveBeenCalledTimes(1)
})
