import { describe, expect, it } from 'vitest'
import { DAEMON_RELEASE_KEY_ENV, DAEMON_ROOT_ENV, daemonRoots, type DaemonRoots } from './roots'

const HOME = '/Users/someone'
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKeyOnly'
const hook = (root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  [DAEMON_ROOT_ENV]: root,
  PHOSPHOR_HOST_RELEASE_URL: 'file:///scratch/assets',
  [DAEMON_RELEASE_KEY_ENV]: KEY,
  ...extra,
})
const input = (
  env: NodeJS.ProcessEnv,
  isPackaged = false,
  platform: NodeJS.Platform = 'darwin',
) => ({
  isPackaged,
  env,
  home: HOME,
  platform,
  arch: 'arm64',
})
/** Every path the install may touch. */
const paths = (roots: DaemonRoots) => [
  roots.home,
  roots.lib,
  roots.agentDir,
  roots.serviceFile,
  ...Object.values(roots.xdg),
]

describe('daemonRoots', () => {
  it('keeps every unpackaged run off without the dev hook, even under an e2e userData', () => {
    for (const env of [{}, { PHOSPHOR_TEST_USER_DATA: '/scratch/user-data' }])
      expect(daemonRoots(input(env))).toEqual({ on: false, reason: expect.any(String) as string })
  })
  it.each([
    ['the real home', HOME],
    ['an ancestor of it', '/Users'],
    ['the root folder', '/'],
    ['inside ~/.local', `${HOME}/.local/scratch`],
    ['inside ~/Library', `${HOME}/Library/LaunchAgents`],
    ['inside ~/.config', `${HOME}/.config/systemd`],
    ['inside ~/.pi', `${HOME}/.pi/agent`],
    ['a relative folder', 'scratch'],
    ['an unnormalized folder', '/scratch/../Users/someone'],
  ])('refuses a dev root that is %s', (_name, root) => {
    expect(daemonRoots(input(hook(root))).on).toBe(false)
  })
  it('needs a file: release folder and a test key with the dev hook', () => {
    expect(
      daemonRoots(input(hook('/scratch', { PHOSPHOR_HOST_RELEASE_URL: 'https://x.test' }))).on,
    ).toBe(false)
    expect(daemonRoots(input(hook('/scratch', { [DAEMON_RELEASE_KEY_ENV]: '' }))).on).toBe(false)
  })
  it('derives every path from the dev root, never from the real home or pi env', () => {
    const result = daemonRoots(
      input(
        hook('/scratch/m1', {
          PI_CODING_AGENT_DIR: `${HOME}/.pi/agent`,
          XDG_STATE_HOME: `${HOME}/.local/state`,
        }),
      ),
    )
    if (!result.on) throw new Error(result.reason)
    for (const path of paths(result.roots)) expect(path.startsWith('/scratch/m1/')).toBe(true)
    expect(result.roots.release).toEqual({
      env: { PHOSPHOR_HOST_RELEASE_URL: 'file:///scratch/assets' },
      keys: [{ id: 'dev', publicKey: KEY }],
    })
    expect(result.roots.serviceFile).toBe(
      '/scratch/m1/home/Library/LaunchAgents/com.saccolabs.phosphor-host.plist',
    )
  })
  it('in a packaged app ignores the dev hook and release overrides and uses pinned keys', () => {
    const result = daemonRoots(input(hook('/scratch/m1'), true, 'linux'))
    if (!result.on) throw new Error(result.reason)
    expect(result.roots.home).toBe(HOME)
    expect(result.roots.lib).toBe(`${HOME}/.local/lib/phosphor-host`)
    expect(result.roots.agentDir).toBe(`${HOME}/.pi/agent`)
    expect(result.roots.serviceFile).toBe(`${HOME}/.config/systemd/user/phosphor-host.service`)
    expect(result.roots.release).toEqual({ env: {} })
    expect(result.roots.target).toBe('linux-arm64')
  })
  it('keeps Windows on the in-app runtime', () => {
    expect(daemonRoots(input({}, true, 'win32')).on).toBe(false)
  })
})
