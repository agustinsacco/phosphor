import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  logout: vi.fn<(id: string) => Promise<void>>(),
  invalidate: vi.fn(),
}))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./handle', () => ({
  handle: (name: string, cb: (...args: unknown[]) => unknown) => state.handlers.set(name, cb),
}))
vi.mock('../pi/auth-status', () => ({
  checkSubscriptionAuth: vi.fn(),
  logoutProvider: state.logout,
}))
vi.mock('../pi/codex-usage', () => ({ fetchCodexUsage: vi.fn() }))
vi.mock('../pi/login-flow', () => ({ cancelLogin: vi.fn() }))
vi.mock('../pi/auth-actions', () => ({
  createLoginTerminal: vi.fn(),
  startLoginWithBrowser: vi.fn(),
}))
vi.mock('../pi/health', () => ({ invalidatePiHealth: () => state.invalidate('health') }))
vi.mock('../pi/catalogue', () => ({
  invalidateCatalogueModels: () => state.invalidate('models'),
  invalidatePiCommands: () => state.invalidate('commands'),
}))

beforeEach(async () => {
  vi.clearAllMocks()
  const { registerPiAuthHandlers } = await import('./pi-auth-handlers')
  registerPiAuthHandlers()
})

const logout = (id: string) => state.handlers.get('pi:logout')!(null, id)

it('signs out, then drops the caches that list what the user can pick', async () => {
  state.logout.mockResolvedValue(undefined)
  await expect(logout('openai-codex')).resolves.toBeUndefined()
  expect(state.logout).toHaveBeenCalledExactlyOnceWith('openai-codex')
  expect(state.invalidate.mock.calls).toEqual([['models'], ['health'], ['commands']])
})

it('drops the caches even when pi still answers ready', async () => {
  state.logout.mockRejectedValue(new Error('still signed in'))
  await expect(logout('openrouter')).rejects.toThrow('still signed in')
  expect(state.invalidate).toHaveBeenCalledTimes(3)
})
