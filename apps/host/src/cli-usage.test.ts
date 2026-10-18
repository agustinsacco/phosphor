import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refuseUsage, USAGE, type UsageTarget } from './cli-usage'
import { serviceExitPath } from './machine/launchd'
import { hostLogDirectory } from './machine/log'

const NOW = Date.UTC(2026, 4, 6, 7, 8, 9)
let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'phosphor-cli-usage-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function target(overrides: Partial<UsageTarget> = {}) {
  const stderr: string[] = []
  const now = vi.fn(() => NOW)
  const value: UsageTarget = {
    stderr: (text) => stderr.push(text),
    supervised: false,
    env: {},
    home,
    now,
    ...overrides,
  }
  return { value, stderr, now }
}

describe('USAGE', () => {
  it('lists every public command and keeps the installer path command hidden', () => {
    const commands = USAGE.split('\n')
      .map((line) => /^ {2}([a-z]+)\b/.exec(line)?.[1])
      .filter((name) => name !== undefined)
    expect(commands).toEqual([
      'setup',
      'doctor',
      'providers',
      'providers',
      'accept',
      'login',
      'status',
      'logout',
      'run',
      'service',
      'tailscale',
      'update',
      'update',
      'uninstall',
      'version',
    ])
    expect(USAGE).not.toContain('internal-install-path')
    expect(USAGE.startsWith('usage: phosphor <command>\n')).toBe(true)
    expect(USAGE.endsWith('78 config invalid, 128+n ended by signal n\n')).toBe(true)
  })
})

describe('refuseUsage', () => {
  it('prints the problem and usage and exits 64 when not supervised', async () => {
    const { value, stderr, now } = target()
    expect(await refuseUsage('no command given', value)).toBe(64)
    expect(stderr).toEqual([`phosphor: no command given\n\n${USAGE}`])
    expect(now).not.toHaveBeenCalled()
    expect(existsSync(hostLogDirectory({}, home))).toBe(false)
  })

  it('records a supervised usage error as a permanent stop and exits 0', async () => {
    const { value, stderr } = target({ supervised: true })
    expect(await refuseUsage('unexpected argument "x"', value)).toBe(0)
    expect(stderr).toEqual([`phosphor: unexpected argument "x"\n\n${USAGE}`])
    expect(JSON.parse(readFileSync(serviceExitPath({}, home), 'utf8'))).toEqual({
      code: 64,
      at: new Date(NOW).toISOString(),
    })
    expect(readFileSync(join(hostLogDirectory({}, home), 'phosphor.log'), 'utf8')).toContain(
      '[service] stopped {"code":64}',
    )
  })

  it('honours XDG_STATE_HOME for the supervised record', async () => {
    const state = join(home, 'state')
    const env = { XDG_STATE_HOME: state }
    const { value } = target({ supervised: true, env })
    expect(await refuseUsage('no command given', value)).toBe(0)
    expect(serviceExitPath(env, home).startsWith(state)).toBe(true)
    expect(existsSync(serviceExitPath(env, home))).toBe(true)
  })

  it('exits 75 with a short note when the record cannot be written', async () => {
    const file = join(home, 'file')
    writeFileSync(file, '')
    const { value, stderr } = target({ supervised: true, home: file })
    expect(await refuseUsage('no command given', value)).toBe(75)
    expect(stderr).toEqual([
      `phosphor: no command given\n\n${USAGE}`,
      'The service command could not finish.\n',
    ])
  })

  it('exits 75 when the clock throws', async () => {
    const { value, stderr } = target({
      supervised: true,
      now: () => {
        throw new Error('clock')
      },
    })
    expect(await refuseUsage('no command given', value)).toBe(75)
    expect(stderr.at(-1)).toBe('The service command could not finish.\n')
  })
})
