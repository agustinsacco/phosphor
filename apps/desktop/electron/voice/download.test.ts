import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadFiles, filesPresent, pruneDir } from './download'
import type { VoiceFile } from './manifest'

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

function file(path: string, body: string): { file: VoiceFile; body: Buffer } {
  const data = Buffer.from(body)
  return {
    file: { path, url: `https://models.test/${path}`, sha256: sha256(data), bytes: data.length },
    body: data,
  }
}

/** Serves fixed bodies by URL and records what was asked for. */
function server(bodies: Record<string, Buffer | number>): typeof fetch & { calls: string[] } {
  const calls: string[] = []
  const fake = (async (url: string | URL) => {
    calls.push(String(url))
    const body = bodies[String(url)]
    if (typeof body === 'number') return new Response(null, { status: body })
    return new Response(body ? new Uint8Array(body) : null, { status: body ? 200 : 404 })
  }) as typeof fetch & { calls: string[] }
  fake.calls = calls
  return fake
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phosphor-voice-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('downloadFiles', () => {
  const a = file('tiny/a.ort', 'encoder bytes')
  const b = file('vad.onnx', 'detector')

  it('writes verified files in place and reports progress to the total', async () => {
    const progress: number[] = []
    await downloadFiles(dir, [a.file, b.file], {
      fetch: server({ [a.file.url]: a.body, [b.file.url]: b.body }),
      onProgress: (bytes) => progress.push(bytes),
    })
    expect(await readFile(join(dir, 'tiny/a.ort'), 'utf8')).toBe('encoder bytes')
    expect(await filesPresent(dir, [a.file, b.file])).toBe(true)
    expect(progress.at(-1)).toBe(a.body.length + b.body.length)
  })

  it('discards a file whose hash does not match, leaving nothing behind', async () => {
    const tampered = Buffer.from('encoder bytez')
    await expect(
      downloadFiles(dir, [a.file], { fetch: server({ [a.file.url]: tampered }) }),
    ).rejects.toThrow('failed verification')
    expect(await readdir(join(dir, 'tiny'))).toEqual([])
    expect(await filesPresent(dir, [a.file])).toBe(false)
  })

  it('refuses a body larger than pinned', async () => {
    const big = Buffer.from('encoder bytes and then some')
    await expect(
      downloadFiles(dir, [a.file], { fetch: server({ [a.file.url]: big }) }),
    ).rejects.toThrow('larger than expected')
    expect(await readdir(join(dir, 'tiny'))).toEqual([])
  })

  it('reports an HTTP failure', async () => {
    await expect(
      downloadFiles(dir, [a.file], { fetch: server({ [a.file.url]: 503 }) }),
    ).rejects.toThrow('HTTP 503')
  })

  it('skips files already on disk', async () => {
    await mkdir(join(dir, 'tiny'), { recursive: true })
    await writeFile(join(dir, 'tiny/a.ort'), a.body)
    const fetch = server({ [b.file.url]: b.body })
    await downloadFiles(dir, [a.file, b.file], { fetch })
    expect(fetch.calls).toEqual([b.file.url])
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      downloadFiles(dir, [a.file], {
        fetch: server({ [a.file.url]: a.body }),
        signal: controller.signal,
      }),
    ).rejects.toThrow()
    expect(await filesPresent(dir, [a.file])).toBe(false)
  })
})

describe('pruneDir', () => {
  it('keeps the listed files and removes everything else, empty folders included', async () => {
    await mkdir(join(dir, 'tiny'), { recursive: true })
    await mkdir(join(dir, 'base'), { recursive: true })
    await writeFile(join(dir, 'tiny/a.ort'), 'a')
    await writeFile(join(dir, 'tiny/a.ort.1234.part'), 'partial')
    await writeFile(join(dir, 'base/b.ort'), 'b')
    await writeFile(join(dir, 'vad.onnx'), 'v')
    await pruneDir(dir, ['tiny/a.ort', 'vad.onnx'])
    expect((await readdir(dir)).sort()).toEqual(['tiny', 'vad.onnx'])
    expect(await readdir(join(dir, 'tiny'))).toEqual(['a.ort'])
  })

  it('tolerates a directory that does not exist', async () => {
    await expect(pruneDir(join(dir, 'missing'), [])).resolves.toBeUndefined()
  })
})
