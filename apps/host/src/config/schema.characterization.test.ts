import { describe, expect, it } from 'vitest'
import { isPinnedPath, pointer, validateHostConfig } from './schema'

const minimal = { version: 1, pi: { executable: '/usr/bin/pi' }, repositories: ['/srv/a'] }
const errorsOf = (value: unknown) => {
  const result = validateHostConfig(value)
  return result.ok ? [] : result.errors
}
const error = (pointer: string, message: string) => ({ pointer, message })
const pathMessage = 'must be an absolute, normalized path'
const folders = (count: number) => Array.from({ length: count }, (_, i) => `/srv/${i}`)

describe('Host config validation characterization', () => {
  it('accumulates exact diagnostics in domain order and escapes unknown keys at every depth', () => {
    const input = {
      api: { 'a~/': true, port: 1023 },
      control: { 'c~/': true, url: 'http://example.com' },
      accounts: {},
      environment: {
        'e~/': true,
        pass: ['PATH', 'node_options', 'LD_PRELOAD', 'BAD-NAME', 3],
        path: ['/a:b', '/a/../b'],
      },
      contextBudget: '77k',
      allowRepositoryChanges: null,
      autoNameLanes: 1,
      repositories: ['/', 'relative'],
      resourceRoot: '~/resources',
      pi: { 'p~/': true, executable: 'pi', node: '/bin/../node' },
      hostId: '-bad',
      version: 2,
      'r~/': true,
      extra: true,
    }
    expect(errorsOf(input)).toEqual([
      error('/r~0~1', 'unknown key'),
      error('/extra', 'unknown key'),
      error('/version', 'must be 1'),
      error(
        '/hostId',
        'must be 1 to 128 letters, digits, ".", "_", ":" or "-", starting alphanumeric',
      ),
      error('/pi/p~0~1', 'unknown key'),
      error('/pi/executable', pathMessage),
      error('/pi/node', pathMessage),
      error('/resourceRoot', pathMessage),
      error('/repositories/0', 'must not be /'),
      error('/repositories/1', pathMessage),
      error('/autoNameLanes', 'must be a boolean'),
      error('/allowRepositoryChanges', 'must be a boolean'),
      error(
        '/contextBudget',
        'must be "" (the 200k default), "auto", "off" or a size such as "400k"',
      ),
      error('/environment/e~0~1', 'unknown key'),
      error('/environment/pass/0', 'PATH is built by the Host: list folders in /environment/path'),
      error('/environment/pass/1', 'node_options is never passed to pi'),
      error('/environment/pass/2', 'LD_PRELOAD is never passed to pi'),
      error('/environment/pass/3', 'must be a variable name'),
      error('/environment/pass/4', 'must be a variable name'),
      error('/environment/path/0', 'must not contain ":"'),
      error('/environment/path/1', pathMessage),
      error('/control/c~0~1', 'unknown key'),
      error('/control/url', 'must be a bare https origin, or http on loopback'),
      error('/api/a~0~1', 'unknown key'),
      error('/api/port', 'must be an integer from 1024 to 65535'),
      error('/accounts', 'must be null: accounts are not available on a Host yet'),
    ])
  })

  it('rejects non-object roots and preserves missing and malformed domain diagnostics', () => {
    for (const input of [undefined, null, [], 'config', 1, true]) {
      expect(errorsOf(input)).toEqual([error('', 'must be an object')])
    }
    expect(errorsOf({})).toEqual([
      error('/version', 'must be 1'),
      error('/pi', 'must be an object with "executable"'),
      error('/repositories', 'must be a list of up to 64 folders'),
    ])
    for (const value of [null, [], 'bad', 1]) {
      expect(
        errorsOf({ ...minimal, pi: value, environment: value, control: value, api: value }),
      ).toEqual([
        error('/pi', 'must be an object with "executable"'),
        error('/environment', 'must be an object'),
        error('/control', 'must be an object with url'),
        error('/api', 'must be an object with port'),
      ])
    }
    expect(errorsOf({ ...minimal, pi: {}, control: {}, api: {} })).toEqual([
      error('/pi/executable', pathMessage),
      error('/control/url', 'must be a bare https origin, or http on loopback'),
      error('/api/port', 'must be an integer from 1024 to 65535'),
    ])
  })

  it('returns the original valid object without filling optional defaults or normalizing values', () => {
    const inputs = [
      minimal,
      { ...minimal, repositories: [] },
      {
        ...minimal,
        hostId: 'host:1',
        pi: { executable: '/', node: '/usr/bin/node' },
        resourceRoot: '/',
        autoNameLanes: false,
        allowRepositoryChanges: true,
        contextBudget: '  ',
        environment: { pass: ['GH_TOKEN', 'GH_TOKEN'], path: ['/', '/opt/bin'] },
        accounts: null,
        control: { url: 'http://[::1]:54350' },
        api: { port: 65535 },
      },
      { ...minimal, environment: {} },
    ]
    for (const input of inputs) {
      const before = structuredClone(input)
      const result = validateHostConfig(input)
      expect(result).toEqual({ ok: true, config: before })
      if (!result.ok) throw new Error('expected valid config')
      expect(result.config).toBe(input)
      expect(input).toEqual(before)
    }
    expect(Object.keys(minimal)).toEqual(['version', 'pi', 'repositories'])
  })

  it('permits zero through 64 repositories and stops at the oversized list diagnostic', () => {
    for (const count of [0, 64]) {
      expect(errorsOf({ ...minimal, repositories: folders(count) })).toEqual([])
    }
    for (const repositories of [folders(65), Array(65).fill('/'), null, '/srv/a']) {
      expect(errorsOf({ ...minimal, repositories })).toEqual([
        error('/repositories', 'must be a list of up to 64 folders'),
      ])
    }
  })

  it('preserves public pointer escaping and strict pinned paths across all path fields', () => {
    expect(pointer('a~/b', 0)).toBe('/a~0~1b/0')
    expect(isPinnedPath('/')).toBe(true)
    expect(isPinnedPath('/' + 'a'.repeat(4095))).toBe(true)
    const invalid = [
      'pi',
      '~/pi',
      '/srv//pi',
      '/srv/../pi',
      '/srv/./pi',
      '/srv/pi/',
      '/a\0b',
      '/' + 'a'.repeat(4096),
      null,
    ]
    for (const path of invalid) {
      expect(isPinnedPath(path)).toBe(false)
      expect(
        errorsOf({
          ...minimal,
          pi: { executable: path, node: path },
          resourceRoot: path,
          repositories: [path],
          environment: { path: [path] },
        }),
      ).toEqual([
        error('/pi/executable', pathMessage),
        error('/pi/node', pathMessage),
        error('/resourceRoot', pathMessage),
        error('/repositories/0', pathMessage),
        error('/environment/path/0', pathMessage),
      ])
    }
  })

  it('bounds environment lists without inspecting oversized entries and keeps deny messages', () => {
    expect(
      errorsOf({ ...minimal, environment: { pass: Array(64).fill('TOKEN'), path: folders(32) } }),
    ).toEqual([])
    expect(
      errorsOf({
        ...minimal,
        environment: { pass: Array(65).fill('PATH'), path: Array(33).fill('relative') },
      }),
    ).toEqual([
      error('/environment/pass', 'must be a list of up to 64 variable names'),
      error('/environment/path', 'must be a list of up to 32 folders'),
    ])
    const denied = [
      'path',
      'DYLD_INSERT_LIBRARIES',
      'BASH_ENV',
      'ENV',
      'PROMPT_COMMAND',
      'SHELLOPTS',
      'BASHOPTS',
      'IFS',
      'PS4',
    ]
    expect(errorsOf({ ...minimal, environment: { pass: denied } })).toEqual(
      denied.map((name, index) =>
        error(
          `/environment/pass/${index}`,
          index === 0
            ? 'PATH is built by the Host: list folders in /environment/path'
            : `${name} is never passed to pi`,
        ),
      ),
    )
  })

  it('keeps API integer bounds and accepts accounts only when absent or null', () => {
    for (const port of [1024, 65535]) {
      expect(errorsOf({ ...minimal, api: { port }, accounts: null })).toEqual([])
    }
    for (const port of [1023, 65536, 1024.5, NaN, Infinity, '1024', null]) {
      expect(errorsOf({ ...minimal, api: { port } })).toEqual([
        error('/api/port', 'must be an integer from 1024 to 65535'),
      ])
    }
    for (const accounts of [{}, [], false, 0, 'account']) {
      expect(errorsOf({ ...minimal, accounts })).toEqual([
        error('/accounts', 'must be null: accounts are not available on a Host yet'),
      ])
    }
  })
})
