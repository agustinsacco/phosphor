import { createReadStream } from 'node:fs'
import { request } from 'node:https'

export const HOST_RELEASE_BASE_URL = 'https://github.com/agustinsacco/Phosphor/releases/download'

/** Bound bytes while receiving; each chunk resets the inactivity deadline. */
export async function downloadRelease(
  url: URL,
  cap: number,
  signal: AbortSignal,
  redirects = 0,
): Promise<Buffer> {
  signal.throwIfAborted()
  let size = 0
  if (url.protocol === 'file:') {
    const bytes = Buffer.alloc(cap)
    const stream = createReadStream(url, { signal })
    const expire = () => stream.destroy(new Error('Release download timed out'))
    let deadline = setTimeout(expire, 30_000)
    try {
      for await (const chunk of stream) {
        clearTimeout(deadline)
        deadline = setTimeout(expire, 30_000)
        if (!Buffer.isBuffer(chunk)) throw new Error('Invalid release download')
        size += chunk.length
        if (size > cap) {
          stream.destroy()
          throw new Error('Release download too large')
        }
        chunk.copy(bytes, size - chunk.length)
      }
      return bytes.subarray(0, size)
    } finally {
      clearTimeout(deadline)
    }
  }
  if (url.protocol !== 'https:' || url.username || url.password || redirects > 3)
    throw new Error('Invalid release URL')
  return new Promise((resolve, reject) => {
    const req = request(url, { signal }, (response) => {
      clearTimeout(connectDeadline)
      if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy()
        if (!response.headers.location || redirects >= 3)
          return reject(new Error('Invalid release redirect'))
        let next: URL
        try {
          next = new URL(response.headers.location, url)
        } catch {
          return reject(new Error('Invalid release redirect'))
        }
        if (next.protocol !== 'https:') return reject(new Error('Invalid release redirect'))
        downloadRelease(next, cap, signal, redirects + 1).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) {
        response.destroy()
        reject(new Error('Release download failed'))
        return
      }
      const bytes = Buffer.alloc(cap)
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > cap) {
          response.destroy()
          reject(new Error('Release download too large'))
        } else chunk.copy(bytes, size - chunk.length)
      })
      response.on('end', () => resolve(bytes.subarray(0, size)))
      response.on('error', reject)
    })
    const connectDeadline = setTimeout(
      () => req.destroy(new Error('Release download timed out')),
      30_000,
    )
    req.setTimeout(30_000, () => req.destroy(new Error('Release download timed out')))
    req.on('error', (error) => {
      clearTimeout(connectDeadline)
      reject(error)
    })
    req.end()
  })
}
export function releaseUrl(env: NodeJS.ProcessEnv, tag: string, file: string): URL {
  const base = env.PHOSPHOR_HOST_RELEASE_URL ?? `${HOST_RELEASE_BASE_URL}/${tag}`
  const url = new URL(`${base.replace(/\/$/, '')}/${file}`)
  if (
    !['https:', 'file:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid release URL')
  return url
}
