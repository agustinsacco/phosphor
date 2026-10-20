// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import type { McpResolvedServer } from '@shared/mcp'
import type { McpCheckResult, McpCheckSnapshot } from '@shared/mcp-inspection'
import { useConnectorChecks } from './useConnectorChecks'

const servers: McpResolvedServer[] = ['fast', 'slow'].map((name) => ({
  name,
  scope: 'global',
  defined: {},
  config: { url: `https://${name}.test/mcp` },
}))
const snapshot: McpCheckSnapshot = {
  checkedAt: 1,
  discoveredAt: 1,
  report: {
    name: 'fast',
    state: 'connected',
    tools: [{ name: 'search', description: 'Find incidents', exposure: 'codemode' }],
  },
  tools: [{ name: 'search', description: 'Find incidents', exposure: 'codemode' }],
}
let root: Root
let container: HTMLDivElement
let restore: () => void
let state: ReturnType<typeof useConnectorChecks>
const cleanups: (() => void)[] = []
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})
afterEach(() => {
  act(() => root?.unmount())
  restore?.()
  cleanups.splice(0).forEach((fn) => fn())
  container?.remove()
})
function Harness({ workspace = '/a', ready = true }: { workspace?: string; ready?: boolean }) {
  state = useConnectorChecks(workspace, servers, ready)
  return <pre>{JSON.stringify(state.checks)}</pre>
}
async function render(
  check: (name: string, workspace?: string) => Promise<McpCheckResult>,
  cache = {},
) {
  const cancel = vi.fn()
  const fake = createFakePhosphor({
    'mcp:readChecks': () => cache,
    'mcp:checkServer': check,
    'mcp:cancelCheck': cancel,
  })
  restore = installFakePhosphor(fake)
  cleanups.push(fake.dispose)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<Harness />))
  return cancel
}
it('shows a completed connector while another remains pending, keeping remembered tools', async () => {
  await render(async (name) => (name === 'fast' ? { ok: true, snapshot } : new Promise(() => {})), {
    slow: { ...snapshot, report: { ...snapshot.report, name: 'slow' } },
  })
  expect(state.checks.fast?.snapshot?.tools[0]?.description).toBe('Find incidents')
  expect(state.checks.fast?.checking).not.toBe(true)
  expect(state.checks.slow?.checking).toBe(true)
  expect(state.checks.slow?.snapshot?.tools).toEqual(snapshot.tools)
})
it('recovers from the first failed check without losing cached descriptions', async () => {
  let failed = true
  await render(async () => (failed ? { ok: false, message: 'offline' } : { ok: true, snapshot }), {
    fast: snapshot,
  })
  expect(state.checks.fast?.error).toBe('offline')
  expect(state.checks.fast?.snapshot?.tools).toEqual(snapshot.tools)
  failed = false
  await act(async () => state.test('fast'))
  expect(state.checks.fast?.error).toBeUndefined()
  expect(state.checks.fast?.snapshot).toEqual(snapshot)
})
it('cancels work and ignores late results from the previous workspace', async () => {
  let resolveOld: ((value: McpCheckResult) => void) | undefined
  const cancel = await render(async (name, workspace) =>
    workspace === '/a' && name === 'fast'
      ? new Promise((resolve) => {
          resolveOld = resolve
        })
      : { ok: false, message: `Current ${workspace}` },
  )
  await act(async () => root.render(<Harness workspace="/b" />))
  expect(cancel).toHaveBeenCalled()
  await act(async () => resolveOld?.({ ok: true, snapshot }))
  expect(state.checks.fast?.error).toBe('Current /b')
  expect(state.checks.fast?.snapshot).toBeUndefined()
})
it('does not start probes until config and packages are ready', async () => {
  const check = vi.fn(async (): Promise<McpCheckResult> => ({ ok: true, snapshot }))
  await render(check)
  check.mockClear()
  await act(async () => root.render(<Harness ready={false} />))
  expect(check).not.toHaveBeenCalled()
})
