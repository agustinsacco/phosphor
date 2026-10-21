// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import type { McpCheckResult } from '@shared/mcp-inspection'
import { ConnectorsTab } from './ConnectorsTab'

vi.mock('../SettingsMachineScope', () => ({ useSettingsWorkspace: () => '/workspace' }))
vi.mock('@/features/files/MonacoEditor', () => ({ MonacoEditor: () => null }))

let root: Root | undefined
let container: HTMLDivElement
let restore: (() => void) | undefined

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  restore?.()
})

async function renderPendingCheck(result?: McpCheckResult) {
  const config = { url: 'https://linear.example/mcp' }
  const fake = createFakePhosphor({
    'mcp:readConfigs': () => ({
      servers: [{ name: 'linear', scope: 'global', config, defined: config }],
      files: [],
      errors: [],
      projectTrust: null,
      legacy: false,
    }),
    'packages:list': () => [],
    'mcp:readChecks': () => ({}),
    'mcp:cancelCheck': () => {},
    'mcp:checkServer': () => (result ? Promise.resolve(result) : new Promise(() => {})),
  })
  restore = installFakePhosphor(fake)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<ConnectorsTab />))
  return container.querySelector<HTMLElement>('[data-testid="connector-linear"]')!
}

it('does not offer OAuth sign-in before authentication status is known', async () => {
  const row = await renderPendingCheck()
  expect(row.textContent).not.toContain('Sign in')
})

it('keeps OAuth authorization available when inspection needs a newer pi', async () => {
  const row = await renderPendingCheck({ ok: false, unsupported: true, message: 'Upgrade pi.' })
  expect(row.textContent).toContain('Authorize…')
})

it('keeps an explicit tools section visible before discovery finishes', async () => {
  const row = await renderPendingCheck()
  expect(row.textContent).toContain('Tools')
})

it('offers an independent test on each connector', async () => {
  const row = await renderPendingCheck()
  expect(
    [...row.querySelectorAll('button')].some((button) =>
      /Test|Testing|Retry/.test(button.textContent ?? ''),
    ),
  ).toBe(true)
})
