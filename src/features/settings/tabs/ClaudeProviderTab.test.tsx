// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PiPackageEntry } from '@shared/models'
import { ClaudeProviderTab } from './ClaudeProviderTab'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

/** The provider entry `packages:list` answers with; null for none. */
let provider: PiPackageEntry | null = null

const entry = (patch: Partial<PiPackageEntry>): PiPackageEntry => ({
  spec: 'npm:@saccolabs/pi-claude-cli',
  scope: 'global',
  kind: 'npm',
  filtered: false,
  name: '@saccolabs/pi-claude-cli',
  installed: true,
  resources: { extensions: [], skills: [], prompts: [], themes: [] },
  ...patch,
})

const invoke = vi.fn(async (channel: string) => {
  switch (channel) {
    case 'packages:list':
      return provider ? [provider] : []
    case 'packages:claudeStatus':
      return {
        binary: { found: true, path: '/usr/local/bin/claude', version: '2.1.270' },
        auth: { ok: true, loggedIn: true },
      }
    case 'claude:accounts':
      return { prefs: { mode: 'ordered', accounts: [], cooldowns: {} }, views: [] }
    case 'packages:checkUpdates':
    case 'claude:accountSessions':
      return {}
    default:
      return null
  }
})

beforeEach(() => {
  invoke.mockClear()
  provider = null
  ;(globalThis as unknown as { window: { phosphor: unknown } }).window.phosphor = {
    invoke,
    onClaudeLoginState: () => () => {},
    onPackagesJobOutput: () => () => {},
    onPackagesJobExit: () => () => {},
  }
})

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  document.body.innerHTML = ''
})

async function render(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<ClaudeProviderTab />))
  await vi.waitFor(() => expect(document.body.textContent).toContain('/usr/local/bin/claude'))
}

const warning = (): Element | null =>
  document.querySelector('[data-testid="claude-provider-too-old"]')

describe('ClaudeProviderTab', () => {
  it('flags an installed provider older than sessions accept', async () => {
    provider = entry({ version: '0.8.3' })
    await render()
    expect(warning()?.textContent).toBe(
      'Claude sessions need @saccolabs/pi-claude-cli 0.9.0 or newer; this is 0.8.3. ' +
        'Update it, then reopen your Claude sessions.',
    )
  })

  it.each(['0.9.0', '0.10.2'])('reads %s as healthy', async (version) => {
    provider = entry({ version })
    await render()
    expect(warning()).toBeNull()
  })

  it('flags an installed copy whose version it cannot read', async () => {
    provider = entry({ version: undefined })
    await render()
    expect(warning()?.textContent).toContain('this is an unknown version.')
  })

  it('leaves a declared, not yet installed package to its own row', async () => {
    provider = entry({ installed: false })
    await render()
    expect(warning()).toBeNull()
    expect(document.body.textContent).toContain('declared — installs on next session start')
  })
})
