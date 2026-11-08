import type { EmbeddingProcess } from '../embedding-client'
import type { FromEmbeddingWorker, ToEmbeddingWorker } from '../embedding-protocol'
import type { TransformersModule } from '../embedding-runtime'
import { createEmbeddingWorkerHandler } from '../embedding-worker-handler'
import { SMALL_CONTENT } from './embedding-small-files'

export { SMALL_CONTENT, SMALL_FILES, SMALL_TOTAL } from './embedding-small-files'

/** Serves `SMALL_CONTENT`, or `override[path]` while it is set, and records every URL. */
export function fakeFetch(initial: Record<string, Buffer> = {}) {
  const urls: string[] = []
  const override: Record<string, Buffer | undefined> = { ...initial }
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    const path = url.replace('https://models.test/', '')
    const body = override[path] ?? SMALL_CONTENT[path]
    return body ? new Response(new Uint8Array(body)) : new Response('missing', { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, urls, override }
}

/** A deterministic, un-normalised vector per text. */
function vectorFor(text: string, width: number): number[] {
  let seed = 0
  for (const char of text) seed = (seed * 31 + char.charCodeAt(0)) % 9973
  return Array.from({ length: width }, (_, i) => ((seed + i * 7) % 13) + 1)
}

export interface FakeTransformersOptions {
  /** Every text gets the same vector, which the self-test must reject. */
  identical?: boolean
  width?: number
  loadError?: string
}

export function fakeTransformers(options: FakeTransformersOptions = {}) {
  const width = options.width ?? 768
  const tokenized: string[][] = []
  const loads: { kind: 'tokenizer' | 'model'; id: string; options: unknown }[] = []
  const tf: TransformersModule = {
    env: {
      allowRemoteModels: true,
      allowLocalModels: false,
      localModelPath: '/models/',
      useFSCache: true,
      useBrowserCache: true,
      useCustomCache: true,
      useWasmCache: true,
      fetch: () => Promise.resolve(new Response('remote')),
    },
    AutoTokenizer: {
      from_pretrained: (id, loadOptions) => {
        loads.push({ kind: 'tokenizer', id, options: loadOptions })
        return Promise.resolve((texts: string[]) => {
          tokenized.push(texts)
          return { texts }
        })
      },
    },
    AutoModel: {
      from_pretrained: (id, loadOptions) => {
        loads.push({ kind: 'model', id, options: loadOptions })
        if (options.loadError) return Promise.reject(new Error(options.loadError))
        const model = (inputs: unknown) => {
          const { texts } = inputs as { texts: string[] }
          const rows = texts.map((text) => vectorFor(options.identical ? 'same' : text, width))
          return Promise.resolve({
            sentence_embedding: { dims: [texts.length, width], data: rows.flat() },
          })
        }
        return Promise.resolve(Object.assign(model, { dispose: () => Promise.resolve([]) }))
      },
    },
  }
  return { tf, tokenized, loads }
}

/** The real worker message loop over a fake model, as a utility process. */
export class FakeEmbeddingProcess implements EmbeddingProcess {
  readonly posted: ToEmbeddingWorker[] = []
  killed = false
  private listener: (message: FromEmbeddingWorker) => void = () => undefined
  private exitListener: () => void = () => undefined
  private readonly handle

  constructor(tf: TransformersModule) {
    this.handle = createEmbeddingWorkerHandler({
      post: (message) => {
        if (!this.killed) this.listener(message)
      },
      importTransformers: () => Promise.resolve(tf),
    })
  }

  post(message: ToEmbeddingWorker): void {
    this.posted.push(message)
    if (!this.killed) this.handle(message)
  }

  onMessage(listener: (message: FromEmbeddingWorker) => void): void {
    this.listener = listener
  }

  onExit(listener: () => void): void {
    this.exitListener = listener
  }

  kill(): void {
    if (this.killed) return
    this.killed = true
    this.exitListener()
  }
}
