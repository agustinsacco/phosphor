import type { FileHandle } from 'node:fs/promises'
import type { ReadStream } from 'node:fs'
import { createGzip } from 'node:zlib'

type ByteRange = { start: number; end: number }

/** Ignore multipart/malformed ranges; a single valid range can seek a local video. */
function videoRange(request: Request, size: number): ByteRange | 'unsatisfiable' | undefined {
  if (request.method !== 'GET' || request.headers.has('if-range')) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range')?.trim() ?? '')
  if (!match || (!match[1] && !match[2])) return undefined
  const first = match[1] ? Number(match[1]) : undefined
  const last = match[2] ? Number(match[2]) : undefined
  if ([first, last].some((value) => value !== undefined && !Number.isSafeInteger(value)))
    return undefined
  if (first !== undefined && last !== undefined && first > last) return undefined
  if (size === 0 || (first !== undefined && first >= size) || (first === undefined && last === 0))
    return 'unsatisfiable'
  return {
    start: first ?? Math.max(0, size - last!),
    end: first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1),
  }
}

function streamedBody(source: ReadStream, gzip: boolean): ReadableStream<Uint8Array> {
  const stream = gzip ? source.pipe(createGzip()) : source
  if (gzip) {
    source.on('error', (error) => stream.destroy(error))
    stream.on('close', () => source.destroy())
  }
  const iterator = stream[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await iterator.next()
        if (chunk.done) controller.close()
        else if (chunk.value instanceof Uint8Array) controller.enqueue(chunk.value)
        else throw new Error('Invalid static stream')
      } catch (error) {
        source.destroy()
        stream.destroy()
        controller.error(error)
      }
    },
    cancel() {
      source.destroy()
      stream.destroy()
    },
  })
}

/** Owns the opened handle once confinement and file type checks have succeeded. */
export async function staticResponse(
  handle: FileHandle,
  request: Request,
  headers: Headers,
  status: number,
  size: number,
): Promise<Response> {
  const type = headers.get('content-type') ?? ''
  const video = status === 200 && /^video\/(mp4|webm)$/.test(type)
  if (video) {
    headers.set('Accept-Ranges', 'bytes')
    // Marketing media has stable names, so replacing a reel must revalidate it.
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-cache')
  }
  const range = video ? videoRange(request, size) : undefined
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`)
    headers.set('Content-Length', '0')
    await handle.close()
    return new Response(null, { status: 416, headers })
  }
  const text = /^(text\/|application\/(javascript|json)|image\/svg\+xml)/.test(type)
  const gzip =
    size > 1024 &&
    text &&
    /(?:^|,)\s*gzip\s*(?:,|$|;\s*q=(?:1(?:\.0*)?|0\.[0-9]*[1-9][0-9]*)(?:\s*,|\s*$))/.test(
      request.headers.get('accept-encoding') ?? '',
    )
  if (text) headers.set('Vary', 'Accept-Encoding')
  if (gzip) headers.set('Content-Encoding', 'gzip')
  else headers.set('Content-Length', String(range ? range.end - range.start + 1 : size))
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
  if (request.method === 'HEAD') {
    await handle.close()
    return new Response(null, { status, headers })
  }
  const source = handle.createReadStream(range)
  return new Response(streamedBody(source, gzip), { status: range ? 206 : status, headers })
}
