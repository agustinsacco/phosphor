import { describe, expect, it } from 'vitest'
import { localSocketPaths } from '../owner/socket'
import { hostLogDirectory } from '../machine/log'
import { defaultConfigPath } from './load'

/**
 * The Host's config and state folders as `phosphor run`, `setup --local` and
 * Desktop must agree on them. Pinned through seams that keep their home when
 * the folder rules move, so this file never changes with the move.
 */
const HOME = '/Users/someone'

describe('Host config and state folders (characterization)', () => {
  it.each([
    [{}, '/Users/someone/.config/phosphor-host/config.json'],
    [{ XDG_CONFIG_HOME: '/xdg/config' }, '/xdg/config/phosphor-host/config.json'],
    [{ XDG_CONFIG_HOME: '/xdg/config/' }, '/xdg/config/phosphor-host/config.json'],
    [{ XDG_CONFIG_HOME: '/xdg//a/../config' }, '/xdg/config/phosphor-host/config.json'],
    [{ XDG_CONFIG_HOME: 'relative' }, '/Users/someone/.config/phosphor-host/config.json'],
    [{ XDG_CONFIG_HOME: '' }, '/Users/someone/.config/phosphor-host/config.json'],
  ])('config path for %j', (env, expected) => {
    expect(defaultConfigPath(env, HOME)).toBe(expected)
  })

  it.each([
    [{}, '/Users/someone/.local/state/phosphor-host/logs'],
    [{ XDG_STATE_HOME: '/xdg/state' }, '/xdg/state/phosphor-host/logs'],
    [{ XDG_STATE_HOME: '/xdg/state/' }, '/xdg/state/phosphor-host/logs'],
    [{ XDG_STATE_HOME: '/xdg/./x/../state' }, '/xdg/state/phosphor-host/logs'],
    [{ XDG_STATE_HOME: 'relative' }, '/Users/someone/.local/state/phosphor-host/logs'],
    [{ XDG_STATE_HOME: '' }, '/Users/someone/.local/state/phosphor-host/logs'],
  ])('state folder for %j', (env, expected) => {
    expect(hostLogDirectory(env, HOME)).toBe(expected)
  })

  it('places the socket under the same state folder on macOS and Linux', () => {
    const context = { env: { XDG_STATE_HOME: '/xdg/state' }, home: HOME, uid: 501 }
    expect(localSocketPaths(context, 'darwin')).toEqual([
      '/xdg/state/phosphor-host/run/phosphor.sock',
      '/tmp/phosphor-501/45e7146bb29d26fe.sock',
    ])
    expect(
      localSocketPaths(
        { ...context, env: { ...context.env, XDG_RUNTIME_DIR: '/run/user/501' } },
        'linux',
      ),
    ).toEqual([
      '/run/user/501/phosphor-host/phosphor.sock',
      '/xdg/state/phosphor-host/run/phosphor.sock',
      '/tmp/phosphor-501/45e7146bb29d26fe.sock',
    ])
    expect(localSocketPaths({ env: {}, home: HOME, uid: 501 }, 'linux')[0]).toBe(
      '/Users/someone/.local/state/phosphor-host/run/phosphor.sock',
    )
  })
})
