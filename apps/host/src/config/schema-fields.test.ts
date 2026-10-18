import { describe, expect, it } from 'vitest'
import type { ConfigError } from './schema'
import {
  isPinnedPath,
  isRecord,
  onlyKeys,
  pointer,
  validateApi,
  validateControl,
  validateEnvironment,
  validatePath,
  validatePi,
  validateRepositories,
} from './schema-fields'

const error = (pointer: string, message: string): ConfigError => ({ pointer, message })
const pathMessage = 'must be an absolute, normalized path'
const folders = (count: number) => Array.from({ length: count }, (_, i) => `/srv/${i}`)
const collect = (validate: (value: unknown, errors: ConfigError[]) => void, value: unknown) => {
  const errors: ConfigError[] = []
  expect(validate(value, errors)).toBeUndefined()
  return errors
}

describe('config field primitives', () => {
  it('recognizes records without treating null or arrays as records', () => {
    expect(isRecord({})).toBe(true)
    for (const value of [null, undefined, [], 1, false, 'record']) {
      expect(isRecord(value)).toBe(false)
    }
  })

  it('escapes pointer segments and appends unknown keys in insertion order', () => {
    expect(pointer()).toBe('')
    expect(pointer('a~/b', 0, '')).toBe('/a~0~1b/0/')
    const errors = [error('/earlier', 'already present')]
    onlyKeys({ allowed: true, 'first~/': 1, second: 2 }, ['allowed'], ['parent/~'], errors)
    expect(errors).toEqual([
      error('/earlier', 'already present'),
      error('/parent~1~0/first~0~1', 'unknown key'),
      error('/parent~1~0/second', 'unknown key'),
    ])
  })

  it('accepts only absolute normalized paths up to 4096 characters without changing them', () => {
    for (const value of ['/', '/bin/pi', '/' + 'a'.repeat(4095)]) {
      expect(isPinnedPath(value)).toBe(true)
      const errors: ConfigError[] = []
      validatePath(value, '/field', errors)
      expect(errors).toEqual([])
    }
    for (const value of [
      undefined,
      null,
      1,
      '',
      'pi',
      '~/pi',
      '/a/../b',
      '/a/./b',
      '/a//b',
      '/a/',
      '/a\0b',
      '/' + 'a'.repeat(4096),
    ]) {
      expect(isPinnedPath(value)).toBe(false)
      const errors: ConfigError[] = []
      validatePath(value, '/field', errors)
      expect(errors).toEqual([error('/field', pathMessage)])
    }
  })
})

describe('pi field validation', () => {
  it('requires an executable object and validates unknown keys before executable and node', () => {
    for (const value of [undefined, null, [], 'pi']) {
      expect(collect(validatePi, value)).toEqual([
        error('/pi', 'must be an object with "executable"'),
      ])
    }
    expect(collect(validatePi, {})).toEqual([error('/pi/executable', pathMessage)])
    expect(collect(validatePi, { extra: true, executable: 'pi', node: '/bin/../node' })).toEqual([
      error('/pi/extra', 'unknown key'),
      error('/pi/executable', pathMessage),
      error('/pi/node', pathMessage),
    ])
    expect(collect(validatePi, { executable: '/', node: '/usr/bin/node' })).toEqual([])
    expect(collect(validatePi, { executable: '/usr/bin/pi' })).toEqual([])
  })
})

describe('repository field validation', () => {
  it('accepts zero and 64 roots but rejects oversized or non-list values without item errors', () => {
    for (const count of [0, 64]) expect(collect(validateRepositories, folders(count))).toEqual([])
    for (const value of [undefined, null, '/srv/a', Array(65).fill('invalid')]) {
      expect(collect(validateRepositories, value)).toEqual([
        error('/repositories', 'must be a list of up to 64 folders'),
      ])
    }
  })

  it('rejects root and unpinned paths in index order without mutating the list', () => {
    const roots = ['/', '/srv/a/', '/srv/../b', '/srv/good', 'relative']
    const before = [...roots]
    expect(collect(validateRepositories, roots)).toEqual([
      error('/repositories/0', 'must not be /'),
      error('/repositories/1', pathMessage),
      error('/repositories/2', pathMessage),
      error('/repositories/4', pathMessage),
    ])
    expect(roots).toEqual(before)
  })
})

describe('environment field validation', () => {
  it('accepts absent or empty fields and maximum-sized lists but rejects malformed domains', () => {
    for (const value of [
      undefined,
      {},
      { pass: [], path: [] },
      { pass: Array(64).fill('TOKEN'), path: folders(32) },
    ]) {
      expect(collect(validateEnvironment, value)).toEqual([])
    }
    for (const value of [null, [], 'environment', 0]) {
      expect(collect(validateEnvironment, value)).toEqual([
        error('/environment', 'must be an object'),
      ])
    }
    for (const value of [
      { pass: null, path: 'bin' },
      { pass: Array(65).fill('PATH'), path: Array(33).fill('bad') },
    ]) {
      expect(collect(validateEnvironment, value)).toEqual([
        error('/environment/pass', 'must be a list of up to 64 variable names'),
        error('/environment/path', 'must be a list of up to 32 folders'),
      ])
    }
  })

  it('reports unknown keys then pass grammar and policy then path errors', () => {
    const value = {
      extra: true,
      path: ['/a:b', 'relative', '/', '/a/../b'],
      pass: [
        'TOKEN',
        'a'.repeat(128),
        'a'.repeat(129),
        '1TOKEN',
        'BAD-NAME',
        1,
        'path',
        'dyld_HOOK',
        'NODE_OPTIONS',
      ],
    }
    const before = structuredClone(value)
    expect(collect(validateEnvironment, value)).toEqual([
      error('/environment/extra', 'unknown key'),
      error('/environment/pass/2', 'must be a variable name'),
      error('/environment/pass/3', 'must be a variable name'),
      error('/environment/pass/4', 'must be a variable name'),
      error('/environment/pass/5', 'must be a variable name'),
      error('/environment/pass/6', 'PATH is built by the Host: list folders in /environment/path'),
      error('/environment/pass/7', 'dyld_HOOK is never passed to pi'),
      error('/environment/pass/8', 'NODE_OPTIONS is never passed to pi'),
      error('/environment/path/0', 'must not contain ":"'),
      error('/environment/path/1', pathMessage),
      error('/environment/path/3', pathMessage),
    ])
    expect(value).toEqual(before)
  })
})

describe('control field validation', () => {
  it('accepts only absent or bare secure origins and loopback http origins', () => {
    expect(collect(validateControl, undefined)).toEqual([])
    for (const url of [
      'https://example.com',
      'https://example.com:65535',
      'http://localhost',
      'http://127.0.0.1:54350',
      'http://[::1]:54350',
    ]) {
      expect(collect(validateControl, { url })).toEqual([])
    }
    for (const url of [
      undefined,
      null,
      'http://example.com',
      'https://example.com/',
      'https://example.com/path',
      'https://u:p@example.com',
      'https://example.com:65536',
    ]) {
      expect(collect(validateControl, { url })).toEqual([
        error('/control/url', 'must be a bare https origin, or http on loopback'),
      ])
    }
  })

  it('rejects malformed domains and orders unknown keys before URL errors', () => {
    for (const value of [null, [], 'url']) {
      expect(collect(validateControl, value)).toEqual([
        error('/control', 'must be an object with url'),
      ])
    }
    expect(collect(validateControl, { 'a~/': true })).toEqual([
      error('/control/a~0~1', 'unknown key'),
      error('/control/url', 'must be a bare https origin, or http on loopback'),
    ])
  })
})

describe('API field validation', () => {
  it('accepts absent or integer ports 1024 through 65535 and rejects everything outside', () => {
    expect(collect(validateApi, undefined)).toEqual([])
    for (const port of [1024, 47615, 65535]) {
      expect(collect(validateApi, { port })).toEqual([])
    }
    for (const port of [undefined, null, '1024', 1023, 65536, 1024.5, NaN, Infinity]) {
      expect(collect(validateApi, { port })).toEqual([
        error('/api/port', 'must be an integer from 1024 to 65535'),
      ])
    }
  })

  it('rejects malformed domains and orders unknown keys before port errors', () => {
    for (const value of [null, [], 47615]) {
      expect(collect(validateApi, value)).toEqual([error('/api', 'must be an object with port')])
    }
    expect(collect(validateApi, { bind: '0.0.0.0' })).toEqual([
      error('/api/bind', 'unknown key'),
      error('/api/port', 'must be an integer from 1024 to 65535'),
    ])
  })
})

it('appends domain diagnostics to one explicit ordered collector without clearing earlier errors', () => {
  const errors = [error('/version', 'must be 1')]
  validatePi({}, errors)
  validateRepositories(['/'], errors)
  validateEnvironment(null, errors)
  validateControl(null, errors)
  validateApi(null, errors)
  expect(errors).toEqual([
    error('/version', 'must be 1'),
    error('/pi/executable', pathMessage),
    error('/repositories/0', 'must not be /'),
    error('/environment', 'must be an object'),
    error('/control', 'must be an object with url'),
    error('/api', 'must be an object with port'),
  ])
})
