// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it } from 'vitest'
import type { McpResolvedServer } from '@shared/mcp'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useToolVisibility } from './ExposureEditor'

let root: Root
let container: HTMLDivElement
let restore: () => void
let state: ReturnType<typeof useToolVisibility>
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  restore?.()
})

it('waits for refresh and retains acknowledged rules if refreshed props lag or fail', async () => {
  const writes: unknown[] = []
  restore = installFakePhosphor(
    createFakePhosphor({
      'mcp:setExposure': (_scope, _workspace, _name, _exposure, rules) => {
        writes.push(rules)
      },
    }),
  )
  const server: McpResolvedServer = {
    name: 'api',
    scope: 'global',
    defined: {},
    config: { command: 'fake', toolExposure: { 'get_*': 'direct' } },
  }
  let refreshed!: () => void
  const onSaved = () =>
    new Promise<void>((resolve) => {
      refreshed = resolve
    })
  function Probe() {
    state = useToolVisibility(server, undefined, onSaved)
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<Probe />))
  let first!: Promise<void>
  await act(async () => {
    first = state.update('tool_a', 'hidden')
  })
  expect(state.saving).toBe(true)
  await act(async () => {
    refreshed()
    await first
  })
  expect(state.saving).toBe(false)
  // No props update: the first write is nevertheless authoritative for the next edit.
  let second!: Promise<void>
  await act(async () => {
    second = state.update('tool_b', 'direct')
  })
  expect(writes).toEqual([
    { 'get_*': 'direct', tool_a: 'hidden' },
    { 'get_*': 'direct', tool_a: 'hidden', tool_b: 'direct' },
  ])
  await act(async () => {
    refreshed()
    await second
  })
})
