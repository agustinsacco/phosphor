import { describe, expect, it } from 'vitest'
import {
  AMBIENT_NAMES,
  buildPiEnvironment,
  isDeniedName,
  passRefusal,
  platformPath,
  redact,
} from './environment'

const LINUX_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin'
const DARWIN_PATH = `/opt/homebrew/bin:${LINUX_PATH}`
const HOOK = '/tmp/hook-0123456789'

describe('loader and shell hooks', () => {
  it.each([
    'NODE_OPTIONS',
    'BASH_ENV',
    'ENV',
    'PROMPT_COMMAND',
    'SHELLOPTS',
    'BASHOPTS',
    'IFS',
    'PS4',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'LD_',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'DYLD_FRAMEWORK_PATH',
    'node_options',
    'bash_env',
    'ld_preload',
    'Dyld_Insert_Libraries',
  ])('never passes %s, even when the config names it', (name) => {
    const built = buildPiEnvironment({
      hostEnv: { HOME: '/home/me', [name]: HOOK },
      pass: [name],
      platform: 'linux',
    })
    expect(built.names).toEqual(['HOME', 'PATH'])
    expect(built.env).not.toHaveProperty(name)
    expect(built.secrets).toEqual([])
    expect(built.unset).toEqual([])
    expect(isDeniedName(name)).toBe(true)
    expect(passRefusal(name)).toBe(`${name} is never passed to pi`)
  })

  it.each([
    'LDFLAGS',
    'OLD_PWD',
    'MY_LD_PRELOAD',
    'XDYLD_X',
    'NODE_OPTIONS_X',
    'ENVIRONMENT',
    'PS1',
  ])(
    'only exact hook names and the LD_/DYLD_ prefixes are denied: %s passes when named',
    (name) => {
      expect(isDeniedName(name)).toBe(false)
      expect(passRefusal(name)).toBeNull()
      const built = buildPiEnvironment({
        hostEnv: { [name]: 'v' },
        pass: [name],
        platform: 'linux',
      })
      expect(built.env[name]).toBe('v')
    },
  )
})

describe('PATH is rebuilt, never inherited', () => {
  it.each(['PATH', 'path', 'Path'])('refuses %s as a pass name with the folder hint', (name) => {
    expect(passRefusal(name)).toBe('PATH is built by the Host: list folders in /environment/path')
  })

  it('drops an inherited PATH even when the config names it', () => {
    const built = buildPiEnvironment({
      hostEnv: { PATH: `.:/tmp/evil:${LINUX_PATH}` },
      pass: ['PATH'],
      platform: 'linux',
    })
    expect(built.env).toEqual({ PATH: LINUX_PATH })
    expect(built.unset).toEqual([])
  })

  it.each([
    ['linux', LINUX_PATH],
    ['darwin', DARWIN_PATH],
    ['freebsd', LINUX_PATH],
  ] as const)('is only the %s defaults without HOME, node or folders', (platform, path) => {
    expect(buildPiEnvironment({ hostEnv: {}, nodePath: null, platform }).env.PATH).toBe(path)
    expect(platformPath(platform).join(':')).toBe(path)
  })

  it('keeps the first position of a repeated folder', () => {
    const { env } = buildPiEnvironment({
      hostEnv: { HOME: '/home/me' },
      nodePath: '/usr/bin/node',
      path: ['/usr/local/bin', '/opt/tools', '/opt/tools', '/home/me/.local/bin'],
      platform: 'linux',
    })
    expect(env.PATH).toBe(
      '/usr/bin:/usr/local/bin:/opt/tools:/home/me/.local/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin',
    )
  })

  it.each([null, undefined, ''])('adds no node folder for nodePath %j', (nodePath) => {
    const { env } = buildPiEnvironment({ hostEnv: {}, nodePath, platform: 'linux' })
    expect(env.PATH).toBe(LINUX_PATH)
  })
})

describe('ambient authority is opt-in', () => {
  it('is exactly the agent, display, bus and Kerberos names', () => {
    expect([...AMBIENT_NAMES].sort()).toEqual([
      'DBUS_SESSION_BUS_ADDRESS',
      'DISPLAY',
      'GPG_AGENT_INFO',
      'KRB5CCNAME',
      'SSH_AGENT_PID',
      'SSH_AUTH_SOCK',
      'WAYLAND_DISPLAY',
    ])
  })

  it.each([...AMBIENT_NAMES])('passes %s only when the config names it', (name) => {
    const hostEnv = { [name]: '/run/user/1000/thing' }
    const unnamed = buildPiEnvironment({ hostEnv, platform: 'linux' })
    expect(unnamed.names).toEqual(['PATH'])
    expect(unnamed.ambient).toEqual([])
    const named = buildPiEnvironment({ hostEnv, pass: [name], platform: 'linux' })
    expect(named.env[name]).toBe('/run/user/1000/thing')
    expect(named.ambient).toEqual([name])
    expect(named.secrets).toEqual(['/run/user/1000/thing'])
    const absent = buildPiEnvironment({ hostEnv: {}, pass: [name], platform: 'linux' })
    expect(absent.ambient).toEqual([])
    expect(absent.unset).toEqual([name])
  })

  it.each([
    'TERM',
    'EDITOR',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
    'KUBECONFIG',
    'GITHUB_TOKEN',
    'NPM_TOKEN',
  ])('does not inherit %s unless named', (name) => {
    const built = buildPiEnvironment({ hostEnv: { [name]: 'value-0123456789' }, platform: 'linux' })
    expect(built.names).toEqual(['PATH'])
    expect(built.secrets).toEqual([])
  })
})

describe('secrets', () => {
  it('ignores values shorter than eight characters, whatever the name', () => {
    const built = buildPiEnvironment({
      hostEnv: { ANTHROPIC_API_KEY: '1234567', GH_TOKEN: '7654321', OPENAI_API_KEY: '12345678' },
      pass: ['GH_TOKEN'],
      platform: 'linux',
    })
    expect(built.names).toEqual(['ANTHROPIC_API_KEY', 'GH_TOKEN', 'OPENAI_API_KEY', 'PATH'])
    expect(built.secrets).toEqual(['12345678'])
  })

  it('treats pi settings as secrets only by a credential name or by being named', () => {
    const built = buildPiEnvironment({
      hostEnv: {
        PI_CODING_AGENT_DIR: '/home/me/.pi/agent',
        PI_CACHE_RETENTION: 'long-retention',
        PI_SERVICE_TOKEN: 'pi-token-0123',
      },
      pass: ['PI_CACHE_RETENTION'],
      platform: 'linux',
    })
    expect([...built.secrets].sort()).toEqual(['long-retention', 'pi-token-0123'])
    const unnamed = buildPiEnvironment({ hostEnv: built.env, platform: 'linux' })
    expect(unnamed.names).toContain('PI_CACHE_RETENTION')
    expect(unnamed.secrets).toEqual(['pi-token-0123'])
  })

  it('lists a shared value once, longest values first', () => {
    const built = buildPiEnvironment({
      hostEnv: {
        ANTHROPIC_API_KEY: 'same-value-1',
        OPENAI_API_KEY: 'same-value-1',
        AWS_KEY: 'a-much-longer-value',
      },
      platform: 'linux',
    })
    expect(built.secrets).toEqual(['a-much-longer-value', 'same-value-1'])
  })
})

describe('redaction of overlapping and cut-short secrets', () => {
  it('merges adjacent and nested occurrences into one marker', () => {
    expect(redact('xAAAAAAAABBBBBBBBy', ['AAAAAAAA', 'BBBBBBBB'])).toBe('x[redacted]y')
    expect(redact('a sk-abcdefgh b', ['abcdefgh', 'sk-abcdefgh', 'cdef'])).toBe('a [redacted] b')
  })

  it('matches values literally, not as patterns', () => {
    const secret = 'p$&ss.w*rd(1)'
    expect(redact(`a ${secret} b p$ss`, [secret])).toBe('a [redacted] b p$ss')
    expect(redact('pass.word', ['p.ss.word'])).toBe('pass.word')
  })

  it('is exact: another case of the value is not hidden', () => {
    expect(redact('SK-ANT-ABCDEFGH', ['sk-ant-abcdefgh'])).toBe('SK-ANT-ABCDEFGH')
  })

  it('hides the start of the second of two overlapping secrets at a cut', () => {
    expect(redact('x abcdefghij', ['abcdefgh', 'ghijklmn'], true)).toBe('x [redacted]')
    expect(redact('x abcdefghij', ['abcdefgh', 'ghijklmn'])).toBe('x [redacted]ij')
  })

  it('hides cut text that is only the start of a secret', () => {
    expect(redact('sk-ant', ['sk-ant-0123456789'], true)).toBe('[redacted]')
    expect(redact('log s', ['sk-ant-0123456789'], true)).toBe('log [redacted]')
    expect(redact('log x', ['sk-ant-0123456789'], true)).toBe('log x')
  })

  it('hides only whole occurrences before the cut', () => {
    const secret = 'sk-ant-0123456789'
    expect(redact(`sk-ant ${secret} tail`, [secret], true)).toBe('sk-ant [redacted] tail')
  })

  it('leaves empty text and empty secrets alone', () => {
    expect(redact('', ['sk-ant-0123456789'], true)).toBe('')
    expect(redact('text', [], true)).toBe('text')
    expect(redact('text', [''], true)).toBe('text')
  })
})
