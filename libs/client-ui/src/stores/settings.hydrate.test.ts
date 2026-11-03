// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFS } from '@shared/models'
import { useSettingsStore } from './settings'
import { useWorktreesStore } from './worktrees'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  })
})

const invoke = vi.fn(async () => ({
  ...DEFAULT_APP_PREFS,
  worktrees: { auto: true, branchPrefix: 'ada/' },
}))
beforeEach(() => {
  vi.stubGlobal('phosphor', { invoke })
  useWorktreesStore.setState({ preferWorktree: true, branchPrefix: 'phosphor/' })
})
afterEach(() => vi.unstubAllGlobals())

/* The browser's one prefs read is this hydrate; its branch prefix names its Host lanes' branches. */
it('takes the saved branch prefix from the one prefs read (regression W2)', async () => {
  await useSettingsStore.getState().hydrate()
  expect(useWorktreesStore.getState().branchPrefix).toBe('ada/')
})
