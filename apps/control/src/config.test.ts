import { expect, it } from 'vitest'
import { parseConfig } from './config'
import { randomBytes } from 'node:crypto'
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
it('requires a bounded edge secret only in Cloudflare mode without echoing it', () => {
  for (const length of [32, 512]) {
    const secret = randomBytes(length).toString('base64url').slice(0, length)
    expect(
      parseConfig({ CONTROL_TRUST_PROXY: 'cloudflare', CONTROL_EDGE_SECRET: secret }).edgeSecret,
    ).toBe(secret)
    expect(
      parseConfig({ CONTROL_TRUST_PROXY: 'none', CONTROL_EDGE_SECRET: secret }).edgeSecret,
    ).toBe('')
  }
  for (const secret of [
    undefined,
    '',
    randomBytes(24).toString('base64url').slice(0, 31),
    randomBytes(400).toString('base64url').slice(0, 513),
    ' '.repeat(32),
    '+'.repeat(32),
    randomBytes(24).toString('base64url') + '\n',
    randomBytes(24).toString('base64url') + 'é',
  ]) {
    expect(() =>
      parseConfig({ CONTROL_TRUST_PROXY: 'cloudflare', CONTROL_EDGE_SECRET: secret }),
    ).toThrow('Invalid CONTROL_EDGE_SECRET')
    expect(
      parseConfig({ CONTROL_TRUST_PROXY: 'none', CONTROL_EDGE_SECRET: secret }).edgeSecret,
    ).toBe('')
  }
})
