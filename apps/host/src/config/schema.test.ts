import { describe, expect, it } from 'vitest'
import { HOST_ID_PATTERN, pointer, resolveHostId, validateHostConfig } from './schema'

const example = {
  version: 1,
  hostId: 'bee1',
  pi: {
    node: '/home/me/.local/share/fnm/node-versions/v24.14.1/installation/bin/node',
    executable: '/home/me/.local/share/fnm/node-versions/v24.14.1/installation/bin/pi',
  },
  repositories: ['/home/me/src/phosphor', '/home/me/phosphor-acceptance'],
  contextBudget: '',
  environment: { pass: ['GH_TOKEN'], path: ['/home/me/.cargo/bin'] },
  accounts: null,
}
const minimal = { version: 1, pi: { executable: '/usr/local/bin/pi' }, repositories: ['/srv/a'] }

const errorsOf = (value: unknown) => {
  const result = validateHostConfig(value)
  return result.ok ? [] : result.errors
}

describe('Host config v1', () => {
  it('accepts the documented example and a minimal config', () => {
    expect(validateHostConfig(example)).toEqual({ ok: true, config: example })
    expect(validateHostConfig(minimal)).toEqual({ ok: true, config: minimal })
  })

  it('reports every problem at once, each at its JSON pointer', () => {
    const errors = errorsOf({
      version: 2,
      hostId: '-bee1',
      pi: { executable: 'pi', nodePath: '/usr/bin/node' },
      repositories: ['/', '~/src', '/srv/a/../b', '/srv/a/', '/srv//a'],
      contextBudget: '77k',
      environment: {
        pass: ['PATH', 'LD_PRELOAD', 'node_options', 'GH-TOKEN', 7],
        path: ['/opt/a:b', 'bin'],
        inherit: true,
      },
      accounts: {},
      'run/now': true,
    })
    expect(errors.map((error) => error.pointer).sort()).toEqual(
      [
        '/accounts',
        '/contextBudget',
        '/environment/inherit',
        '/environment/pass/0',
        '/environment/pass/1',
        '/environment/pass/2',
        '/environment/pass/3',
        '/environment/pass/4',
        '/environment/path/0',
        '/environment/path/1',
        '/hostId',
        '/pi/executable',
        '/pi/nodePath',
        '/repositories/0',
        '/repositories/1',
        '/repositories/2',
        '/repositories/3',
        '/repositories/4',
        '/run~1now',
        '/version',
      ].sort(),
    )
    const message = (at: string) => errors.find((error) => error.pointer === at)?.message
    expect(message('/environment/pass/0')).toContain('/environment/path')
    expect(message('/environment/pass/2')).toBe('node_options is never passed to pi')
    expect(message('/repositories/0')).toBe('must not be /')
  })

  it('bounds every list and requires a repository', () => {
    const many = (count: number, make: (i: number) => string) =>
      Array.from({ length: count }, (_, i) => make(i))
    expect(errorsOf({ ...minimal, repositories: [] })).toEqual([
      { pointer: '/repositories', message: 'must list at least one folder' },
    ])
    expect(errorsOf({ ...minimal, repositories: many(65, (i) => `/srv/${i}`) })[0]?.pointer).toBe(
      '/repositories',
    )
    const environment = { pass: many(65, (i) => `NAME_${i}`), path: many(33, (i) => `/opt/${i}`) }
    expect(errorsOf({ ...minimal, environment }).map((error) => error.pointer)).toEqual([
      '/environment/pass',
      '/environment/path',
    ])
    expect(errorsOf({ ...minimal, repositories: many(64, (i) => `/srv/${i}`) })).toEqual([])
  })

  it('takes the context budget in Desktop grammar, refusing what Desktop would silently replace', () => {
    for (const contextBudget of ['', '  ', 'auto', 'OFF', '400k', '1M', '250000']) {
      expect(errorsOf({ ...minimal, contextBudget })).toEqual([])
    }
    for (const contextBudget of ['77k', '2M', 'big', 400]) {
      expect(errorsOf({ ...minimal, contextBudget })[0]?.pointer).toBe('/contextBudget')
    }
  })

  it('refuses a config that is not an object', () => {
    for (const value of [null, [], 'config', 1]) {
      expect(errorsOf(value)).toEqual([{ pointer: '', message: 'must be an object' }])
    }
  })
})

describe('JSON pointers and host ids', () => {
  it('escapes ~ and / in pointer segments (RFC 6901)', () => {
    expect(pointer('a/b', 'c~d', 0)).toBe('/a~1b/c~0d/0')
  })

  it('defaults the host id to the short hostname, made presentable', () => {
    expect(resolveHostId({ hostId: 'bee1' }, 'other.local')).toBe('bee1')
    expect(resolveHostId({}, 'bee1.tail9f6158.ts.net')).toBe('bee1')
    expect(resolveHostId({}, 'My Mac (2)')).toBe('My-Mac--2-')
    expect(resolveHostId({}, '--x')).toBe('x')
    for (const hostname of ['', '…', `${'a'.repeat(200)}`, 'é.local']) {
      expect(resolveHostId({}, hostname)).toMatch(HOST_ID_PATTERN)
    }
  })
})

describe('control.url', () => {
  it.each([
    'https://example.com',
    'https://example.com:65535',
    'http://localhost',
    'http://127.0.0.1:54350',
    'http://[::1]:54350',
  ])('accepts %s', (url) => {
    expect(errorsOf({ ...minimal, control: { url } })).toEqual([])
  })
  it.each([
    'http://example.com',
    'https://me:secret@example.com',
    'https://example.com/path',
    'https://example.com/',
    'https://example.com?secret=x',
    'https://example.com#x',
    'https://example.com:0',
    'https://example.com:65536',
    'x'.repeat(2049),
    '',
    null,
  ])('rejects %s without repeating values', (url) => {
    expect(errorsOf({ ...minimal, control: { url } })).toEqual([
      { pointer: '/control/url', message: 'must be a bare https origin, or http on loopback' },
    ])
  })
  it('rejects missing, non-object and unknown fields', () => {
    expect(errorsOf({ ...minimal, control: {} })[0]?.pointer).toBe('/control/url')
    expect(errorsOf({ ...minimal, control: null })[0]?.pointer).toBe('/control')
    expect(
      errorsOf({ ...minimal, control: { url: 'https://example.com', secret: 'hidden' } })[0]
        ?.pointer,
    ).toBe('/control/secret')
  })
})
