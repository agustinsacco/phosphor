import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  exec: vi.fn<(file: string, args: string[]) => { stdout: string }>(),
  health: vi.fn(),
}))
vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    done: (error: Error | null, result?: { stdout: string }) => void,
  ) => {
    try {
      done(null, state.exec(file, args))
    } catch (error) {
      done(error as Error)
    }
  },
}))
vi.mock('./health', () => ({ checkPiHealth: state.health }))
vi.mock('@phosphor/session-runtime/pi/shell-env', () => ({
  piProcessEnv: async () => ({ PATH: '/shell/bin' }),
}))

const { logoutProvider } = await import('./auth-status')

const check = (status: string) => ({ stdout: `{"status":"${status}"}\n` })

beforeEach(() => {
  state.exec.mockReset()
  state.health.mockResolvedValue({ ok: true, binaryPath: '/opt/pi' })
})

describe('logoutProvider', () => {
  it('runs pi auth logout for the provider, then confirms it is signed out', async () => {
    state.exec.mockImplementation((_file, args) =>
      args.includes('logout') ? { stdout: 'Removed.' } : check('not_ready'),
    )
    await expect(logoutProvider('openai-codex')).resolves.toBeUndefined()
    expect(state.exec.mock.calls.map(([file, args]) => [file, args.slice(0, 3)])).toEqual([
      ['/opt/pi', ['auth', 'logout', 'openai-codex']],
      ['/opt/pi', ['auth', 'check', '--provider']],
    ])
  })

  it('says where the key lives when pi still answers ready', async () => {
    state.exec.mockImplementation((_file, args) =>
      args.includes('logout') ? { stdout: 'No stored credentials.' } : check('ready'),
    )
    await expect(logoutProvider('openrouter')).rejects.toThrow(
      'pi still finds a key for OpenRouter in an environment variable or models.json',
    )
  })

  it('refuses a provider outside the catalogue without running pi', async () => {
    await expect(logoutProvider('--all')).rejects.toThrow('Unknown provider.')
    expect(state.exec).not.toHaveBeenCalled()
  })

  it('passes a failed logout through', async () => {
    state.exec.mockImplementation(() => {
      throw new Error('pi exited 1')
    })
    await expect(logoutProvider('xai')).rejects.toThrow('pi exited 1')
    expect(state.exec).toHaveBeenCalledOnce()
  })
})
