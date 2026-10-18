import { webConfig } from './web/config'
import { resolve } from 'node:path'
import { parseGrantKeys, parseGrantOrigin } from './grants/keys'

export function parseConfig(env: NodeJS.ProcessEnv) {
  const port = env.PORT ?? '5015'
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new Error('Invalid PORT')
  const url = env.SUPABASE_URL ?? 'https://bzdbiswndlqvviiywsvj.supabase.co'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid SUPABASE_URL')
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/' ||
    !(
      parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
    )
  )
    throw new Error('Invalid SUPABASE_URL')
  const trustProxy = env.CONTROL_TRUST_PROXY ?? 'none'
  if (trustProxy !== 'none' && trustProxy !== 'cloudflare')
    throw new Error('Invalid CONTROL_TRUST_PROXY')
  const edgeSecret = trustProxy === 'cloudflare' ? (env.CONTROL_EDGE_SECRET ?? '') : ''
  if (trustProxy === 'cloudflare' && !/^[A-Za-z0-9_-]{32,512}$/.test(edgeSecret))
    throw new Error('Invalid CONTROL_EDGE_SECRET')
  const publishableKey =
    env.SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_FAfhFtw4XYaHXjJzGG7Ttg_1PJBlgab'
  const secretKey = env.SUPABASE_SECRET_KEY ?? ''
  if (
    !publishableKey ||
    [publishableKey, secretKey].some((key) => key.length > 4096 || /\s/.test(key))
  ) {
    throw new Error('Invalid Supabase key configuration')
  }
  return Object.freeze({
    web: webConfig(env, parseGrantOrigin(env.CONTROL_PUBLIC_ORIGIN)),
    port: Number(port),
    siteDir: resolve(env.SITE_DIR ?? '/app/site'),
    supabaseUrl: parsed.origin,
    publishableKey,
    secretKey,
    configured: Boolean(secretKey),
    trustProxy,
    edgeSecret,
    grantKeys: parseGrantKeys(env.CONTROL_GRANT_KEYS),
    publicOrigin: parseGrantOrigin(env.CONTROL_PUBLIC_ORIGIN),
  })
}
export type Config = ReturnType<typeof parseConfig>
