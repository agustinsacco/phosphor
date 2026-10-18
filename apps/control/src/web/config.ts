import { resolve } from 'node:path'

export function webConfig(env: NodeJS.ProcessEnv, siteOrigin: string) {
  const values = [env.CONTROL_WEB_ORIGIN, env.WEB_DIR, env.CONTROL_WEB_SESSION_KEYS]
  if (values.every((v) => v === undefined)) return null
  try {
    if (values.some((v) => !v)) throw new Error()
    const url = new URL(values[0]!)
    const development = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
    if (
      url.origin !== values[0] ||
      url.hostname === new URL(siteOrigin).hostname ||
      (url.protocol !== 'https:' && !development)
    )
      throw new Error()
    const entries = values[2]!.split(',')
    if (entries.length > 8 || values[2]!.length > 4096) throw new Error()
    const keys = new Map<string, Buffer>()
    for (const entry of entries) {
      const [id, value, extra] = entry.split('=')
      if (!id || !/^[\w-]{1,64}$/.test(id) || !value || extra !== undefined || keys.has(id))
        throw new Error()
      const key = Buffer.from(value, 'base64url')
      if (key.length !== 32 || key.toString('base64url') !== value) throw new Error()
      keys.set(id, key)
    }
    return { origin: url.origin, host: url.host, dir: resolve(values[1]!), keys, development }
  } catch {
    throw new Error('Invalid browser authentication configuration')
  }
}
export type WebConfig = NonNullable<ReturnType<typeof webConfig>>
