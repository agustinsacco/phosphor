import { describe, expect, it } from 'vitest'
import { HOSTED_SUPABASE, supabaseTarget } from './config'

const local = { PHOSPHOR_SUPABASE_URL: 'http://127.0.0.1:54351/', PHOSPHOR_SUPABASE_KEY: 'k' }

describe('supabaseTarget', () => {
  it('always signs a packaged build in to the hosted project', () => {
    expect(supabaseTarget(true, local)).toBe(HOSTED_SUPABASE)
    expect(HOSTED_SUPABASE.url).toBe('https://bzdbiswndlqvviiywsvj.supabase.co')
  })

  it('uses the hosted project in development unless told otherwise', () => {
    expect(supabaseTarget(false, {})).toBe(HOSTED_SUPABASE)
  })

  it('lets an unpackaged build point at a local stack, as an origin', () => {
    expect(supabaseTarget(false, local)).toEqual({ url: 'http://127.0.0.1:54351', key: 'k' })
    const remote = { PHOSPHOR_SUPABASE_URL: 'https://x.supabase.co', PHOSPHOR_SUPABASE_KEY: 'k' }
    expect(supabaseTarget(false, remote).url).toBe('https://x.supabase.co')
  })

  it('refuses an override it cannot trust instead of falling back', () => {
    const bad =
      (url: string, key = 'k') =>
      () =>
        supabaseTarget(false, { PHOSPHOR_SUPABASE_URL: url, PHOSPHOR_SUPABASE_KEY: key })
    expect(bad('http://127.0.0.1:54351', '')).toThrow(/needs PHOSPHOR_SUPABASE_KEY/)
    expect(bad('http://example.com')).toThrow(/https, or http on a loopback/)
    expect(bad('not a url')).toThrow(/not a URL/)
    expect(bad('https://x.supabase.co/auth')).toThrow(/an origin/)
    expect(bad('https://u:p@x.supabase.co')).toThrow(/an origin/)
  })
})
