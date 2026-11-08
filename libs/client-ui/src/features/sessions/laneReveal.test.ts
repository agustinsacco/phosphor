// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { remotePrKey } from '@shared/host-protocol-github'
import { remoteLaneGroupKey, requestReveal, useLaneReveal, useLaneRevealStore } from './laneReveal'

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

it('keys a Host folder group as its pull request key', () => {
  const hostId = '00000000-0000-4000-8000-000000000001'
  expect(remoteLaneGroupKey(hostId, '0123456789abcdef')).toBe(
    remotePrKey(hostId, '0123456789abcdef'),
  )
})
