import { describe, expect, it } from 'vitest'
import { isControlUrl } from './url'

describe('isControlUrl accepts only a bare canonical origin', () => {
  it.each([
    'https://example.com',
    'https://control.example.com',
    'https://xn--bcher-kva.example',
    'https://10.0.0.1',
    'https://example.com:1',
    'https://example.com:8443',
    'https://example.com:65535',
    'http://localhost',
    'http://localhost:54350',
    'http://127.0.0.1',
    'http://127.0.0.1:54350',
    'http://[::1]',
    'http://[::1]:65535',
  ])('accepts %s', (url) => {
    expect(isControlUrl(url)).toBe(true)
  })

  it.each([undefined, null, 0, 1, true, {}, [], ['https://example.com']])(
    'refuses the non-string %j',
    (value) => {
      expect(isControlUrl(value)).toBe(false)
    },
  )

  it('refuses a URL object even when its origin would be accepted', () => {
    expect(isControlUrl(new URL('https://example.com'))).toBe(false)
  })

  it('accepts 2048 characters and refuses 2049 before parsing', () => {
    const exact = `https://${'a'.repeat(2048 - 'https://'.length)}`
    expect(exact).toHaveLength(2048)
    expect(isControlUrl(exact)).toBe(true)
    expect(isControlUrl(`${exact}a`)).toBe(false)
  })

  it.each(['', 'example.com', 'not a url', 'https://', 'https://a\u0000b.com', 'https://[::1'])(
    'refuses the unparseable %j',
    (url) => {
      expect(isControlUrl(url)).toBe(false)
    },
  )
})

describe('isControlUrl refuses anything beyond the origin', () => {
  it.each([
    'https://user@example.com',
    'https://:secret@example.com',
    'https://user:secret@example.com',
    'http://user:secret@localhost',
    'http://user@127.0.0.1:54350',
  ])('refuses credentials in %s', (url) => {
    expect(isControlUrl(url)).toBe(false)
  })

  it.each([
    'https://example.com/',
    'https://example.com/api',
    'https://example.com/api/v1/grant-keys',
    'http://localhost:54350/',
    'https://example.com?',
    'https://example.com?secret=x',
    'https://example.com/?secret=x',
    'https://example.com#',
    'https://example.com#x',
    'http://127.0.0.1#x',
  ])('refuses a path, query or fragment in %s', (url) => {
    expect(isControlUrl(url)).toBe(false)
  })
})

describe('isControlUrl refuses a non-canonical spelling of an origin', () => {
  it.each([
    ['HTTPS://example.com', 'scheme case'],
    ['https://EXAMPLE.com', 'host case'],
    ['http://LOCALHOST', 'loopback host case'],
    ['https://example.com:443', 'explicit default https port'],
    ['http://localhost:80', 'explicit default http port'],
    ['https://example.com:08443', 'leading zero port'],
    ['https://bücher.example', 'unicode host'],
    ['https://%65xample.com', 'percent-encoded host'],
    ['https://127.1', 'short IPv4'],
    ['http://0x7f.0.0.1', 'hex IPv4 loopback'],
    ['http://2130706433', 'integer IPv4 loopback'],
    ['http://[0:0:0:0:0:0:0:1]', 'long IPv6 loopback'],
    [' https://example.com', 'leading space'],
    ['https://example.com ', 'trailing space'],
    ['https://example.com\t', 'trailing tab'],
    ['https://example.com\n', 'trailing newline'],
    ['https:example.com', 'missing slashes'],
    ['https:/example.com', 'one slash'],
    ['https:\\\\example.com', 'backslashes'],
    ['blob:https://example.com', 'blob wrapper'],
  ])('refuses %j (%s)', (url) => {
    expect(isControlUrl(url)).toBe(false)
  })
})

describe('isControlUrl ports', () => {
  it.each(['https://example.com:0', 'http://localhost:0', 'http://[::1]:0'])(
    'refuses port 0 in %s even though the URL parses as an origin',
    (url) => {
      expect(new URL(url).origin).toBe(url)
      expect(isControlUrl(url)).toBe(false)
    },
  )

  it.each(['https://example.com:65536', 'https://example.com:99999', 'https://example.com:-1'])(
    'refuses the out-of-range port in %s',
    (url) => {
      expect(isControlUrl(url)).toBe(false)
    },
  )
})

describe('isControlUrl schemes', () => {
  it.each([
    'http://example.com',
    'http://control.example.com:8080',
    'http://10.0.0.1',
    'http://127.0.0.2',
    'http://0.0.0.0',
    'http://[::]',
    'http://[::ffff:7f00:1]',
    'http://localhost.',
    'http://sub.localhost',
    'http://localhost.example.com',
  ])('refuses plain http off loopback: %s', (url) => {
    expect(isControlUrl(url)).toBe(false)
  })

  it.each([
    'ws://localhost',
    'wss://example.com',
    'ftp://example.com',
    'file:///etc/passwd',
    'data:text/plain,x',
    'javascript:alert(1)',
  ])('refuses the non-http scheme in %s', (url) => {
    expect(isControlUrl(url)).toBe(false)
  })
})
