import { expect, it } from 'vitest'
import { parseConfig } from './config'
import { clientIp } from './http'
it('uses frozen defaults, allows loopback only for http and never echoes invalid configuration', () => {
  expect(parseConfig({}).port).toBe(5015)
  expect(parseConfig({}).configured).toBe(false)
  expect(Object.isFrozen(parseConfig({}))).toBe(true)
  for (const url of [
    'https://example.com',
    'http://localhost:54351',
    'http://127.0.0.1:54351',
    'http://[::1]:54351',
  ])
    expect(parseConfig({ SUPABASE_URL: url }).supabaseUrl).toBe(url)
  for (const url of [
    'http://example.com',
    'https://name:private@example.com',
    'file:///secret',
    'https://example.com/path',
    'https://example.com/?secret',
    'https://example.com/#secret',
    'garbage',
  ])
    expect(() => parseConfig({ SUPABASE_URL: url })).toThrow('Invalid SUPABASE_URL')
  for (const port of ['-1', '65536', '1.1', 'garbage'])
    expect(() => parseConfig({ PORT: port })).toThrow('Invalid PORT')
  expect(parseConfig({ PORT: '0' }).port).toBe(0)
  expect(parseConfig({ PORT: '65535' }).port).toBe(65535)
  expect(() => parseConfig({ CONTROL_TRUST_PROXY: 'any' })).toThrow('Invalid CONTROL_TRUST_PROXY')
  expect(() => parseConfig({ SUPABASE_SECRET_KEY: 'private\nvalue' })).toThrow(
    'Invalid Supabase key configuration',
  )
})
it('uses Cloudflare IP only when configured and valid', () => {
  const request = new Request('http://localhost', { headers: { 'cf-connecting-ip': '192.0.2.1' } })
  expect(clientIp(request, '127.0.0.1', parseConfig({}))).toBe('127.0.0.1')
  expect(clientIp(request, '127.0.0.1', parseConfig({ CONTROL_TRUST_PROXY: 'cloudflare' }))).toBe(
    '192.0.2.1',
  )
  request.headers.set('cf-connecting-ip', 'invalid')
  expect(clientIp(request, '127.0.0.1', parseConfig({ CONTROL_TRUST_PROXY: 'cloudflare' }))).toBe(
    '127.0.0.1',
  )
})
