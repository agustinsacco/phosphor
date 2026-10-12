import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { configureLinuxKeyring, passwordStore, probeKeyring } from './keyring'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/test', XDG_CURRENT_DESKTOP: 'Hyprland' }
const names = (owned: string[] = [], activatable: string[] = []) => ({ owned, activatable })

describe('passwordStore', () => {
  it.each([
    'GNOME',
    'Unity',
    'X-Cinnamon',
    'Deepin',
    'Pantheon',
    'XFCE',
    'UKUI',
    'COSMIC',
    'KDE',
    'sway:GNOME',
  ])('%s already selects a keyring', (desktop) => {
    const probe = vi.fn()
    expect(
      passwordStore('linux', false, { ...env, XDG_CURRENT_DESKTOP: desktop }, probe),
    ).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })
  it.each(['Hyprland', 'sway', 'i3', 'LXQt', ''])('detects secrets on %s', (desktop) => {
    expect(
      passwordStore('linux', false, { ...env, XDG_CURRENT_DESKTOP: desktop }, () =>
        names(['org.freedesktop.secrets']),
      ),
    ).toBe('gnome-libsecret')
  })
  it('prefers Secret Service, including activatable, then owned KWallet 6 and 5', () => {
    const select = (owned: string[], activatable: string[] = []) =>
      passwordStore('linux', false, env, () => names(owned, activatable))
    expect(select(['org.kde.kwalletd6'], ['org.freedesktop.secrets'])).toBe('gnome-libsecret')
    expect(select(['org.kde.kwalletd6', 'org.kde.kwalletd5'])).toBe('kwallet6')
    expect(select(['org.kde.kwalletd5'])).toBe('kwallet5')
    expect(select([], ['org.kde.kwalletd6'])).toBeNull()
    expect(select([])).toBeNull()
    expect(passwordStore('linux', false, env, () => null)).toBeNull()
    expect(
      passwordStore('linux', false, env, () => {
        throw new Error('bus error')
      }),
    ).toBeNull()
  })
  it('never probes with an explicit flag, off Linux, or without a session bus', () => {
    const probe = vi.fn()
    for (const platform of ['darwin', 'win32'] as const)
      expect(passwordStore(platform, false, env, probe)).toBeNull()
    expect(passwordStore('linux', true, env, probe)).toBeNull()
    expect(passwordStore('linux', false, {}, probe)).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })
  it('applies the switch and logs once, only on detection', () => {
    const commandLine = { hasSwitch: vi.fn(() => false), appendSwitch: vi.fn() }
    const log = vi.fn()
    configureLinuxKeyring(commandLine, log, 'linux', env, () => names(['org.kde.kwalletd6']))
    expect(commandLine.hasSwitch).toHaveBeenCalledWith('password-store')
    expect(commandLine.appendSwitch).toHaveBeenCalledExactlyOnceWith('password-store', 'kwallet6')
    expect(log).toHaveBeenCalledExactlyOnceWith('selected password store: kwallet6')
  })
})

describe('probeKeyring', () => {
  const result = (stdout = '', status: number | null = 0, error?: Error) => ({
    pid: 1,
    output: [],
    stdout,
    stderr: '',
    status,
    signal: null,
    error,
  })
  it('uses no shell, ignores stdin, bounds output, and shares one deadline', () => {
    const run = vi.mocked(spawnSync).mockReset()
    run
      .mockReturnValueOnce(result('string "org.kde.kwalletd6"'))
      .mockReturnValueOnce(result('string "org.freedesktop.secrets"'))
    const clock = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(600)
    expect(probeKeyring(spawnSync, clock)).toEqual(
      names(['org.kde.kwalletd6'], ['org.freedesktop.secrets']),
    )
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[0]?.[1]).toContain('org.freedesktop.DBus.ListNames')
    expect(run.mock.calls[1]?.[1]).toContain('org.freedesktop.DBus.ListActivatableNames')
    expect(run.mock.calls[0]?.[2]).toEqual({
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
      maxBuffer: 65536,
      shell: false,
    })
    expect(run.mock.calls[1]?.[2]).toMatchObject({ timeout: 400, shell: false })
  })
  it('fails closed on missing tools, timeouts, errors, and an exhausted deadline', () => {
    const run = vi.mocked(spawnSync)
    for (const answer of [
      result('', null, new Error('ENOENT')),
      result('', null, new Error('ETIMEDOUT')),
      result('', 1),
    ]) {
      run.mockReset().mockReturnValue(answer)
      expect(probeKeyring()).toBeNull()
      expect(run).toHaveBeenCalledOnce()
    }
    run.mockReset().mockReturnValue(result())
    const clock = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(1000)
    expect(probeKeyring(spawnSync, clock)).toBeNull()
    expect(run).toHaveBeenCalledOnce()
    run.mockReset().mockReturnValueOnce(result()).mockReturnValueOnce(result('', 1))
    expect(probeKeyring()).toBeNull()
  })
})
