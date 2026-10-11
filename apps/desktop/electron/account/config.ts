import type { SupabaseTarget } from './gotrue'

/**
 * The Supabase project Phosphor's optional sign-in talks to.
 *
 * The URL and the publishable key are public by design: row-level security,
 * not the key, protects the data.
 */
export const HOSTED_SUPABASE: SupabaseTarget = {
  url: 'https://bzdbiswndlqvviiywsvj.supabase.co',
  key: 'sb_publishable_FAfhFtw4XYaHXjJzGG7Ttg_1PJBlgab',
}

/**
 * E2E keeps the keychain out of a sign-in, since a prompt would stall a hidden
 * window. Unpackaged only, like every env hook, and it can only make storage
 * stricter: the session then lives in memory, as with no keyring at all.
 */
export function keychainOff(packaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return !packaged && env.PHOSPHOR_ACCOUNT_NO_KEYCHAIN === '1'
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * A packaged build always signs in to the hosted project. An unpackaged build
 * may point at a local stack (e2e, the auth integration test) through
 * PHOSPHOR_SUPABASE_URL and PHOSPHOR_SUPABASE_KEY, gated like every other env
 * hook: ungated, an environment variable could send a shipped app's sign-in
 * somewhere else. A bad override throws rather than falling back.
 */
export function supabaseTarget(packaged: boolean, env: NodeJS.ProcessEnv): SupabaseTarget {
  const raw = env.PHOSPHOR_SUPABASE_URL
  if (packaged || !raw) return HOSTED_SUPABASE
  const key = env.PHOSPHOR_SUPABASE_KEY
  if (!key) throw new Error('PHOSPHOR_SUPABASE_URL needs PHOSPHOR_SUPABASE_KEY')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`PHOSPHOR_SUPABASE_URL is not a URL: ${raw}`)
  }
  const local = url.protocol === 'http:' && LOOPBACK.has(url.hostname)
  if (url.protocol !== 'https:' && !local) {
    throw new Error('PHOSPHOR_SUPABASE_URL must be https, or http on a loopback address')
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('PHOSPHOR_SUPABASE_URL must be an origin, with no path, query or credentials')
  }
  return { url: url.origin, key }
}
