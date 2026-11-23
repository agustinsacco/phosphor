import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * The packaged app inherits launchd's PATH, which has no Homebrew in it. When
 * `gh` ran on that PATH the probe failed with ENOENT, cached "unavailable" for
 * the process lifetime, and the sidebar's PR chip never rendered on any lane.
 * These pin every `gh` invocation to the login-shell environment.
 */
const calls: Array<{ file: string; args: string[]; env: Record<string, string> | undefined }> = []

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    opts: { env?: Record<string, string> },
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push({ file, args, env: opts?.env })
    cb(null, { stdout: '[]', stderr: '' })
  },
}))

vi.mock('@phosphor/session-runtime/pi/shell-env', () => ({
  piProcessEnv: (extra?: Record<string, string>) =>
    Promise.resolve({ PATH: '/opt/homebrew/bin:/usr/bin', ...extra }),
}))

beforeEach(() => {
  calls.length = 0
  vi.resetModules()
})

describe('gh runs on the login shell PATH', () => {
  it('probes with the upgraded PATH', async () => {
    const { ghAvailable } = await import('./gh-cli')
    expect(await ghAvailable()).toBe(true)
    expect(calls[0]?.args).toEqual(['--version'])
    expect(calls[0]?.env?.PATH).toContain('/opt/homebrew/bin')
  })

  it('lists PRs with the upgraded PATH and no prompts', async () => {
    const { ghPrsForRepo } = await import('./gh-cli')
    await ghPrsForRepo('/repo')
    const list = calls.find((c) => c.args[0] === 'pr')
    expect(list?.env?.PATH).toContain('/opt/homebrew/bin')
    expect(list?.env?.GH_PROMPT_DISABLED).toBe('1')
    expect(list?.env?.GH_NO_UPDATE_NOTIFIER).toBe('1')
  })
})
