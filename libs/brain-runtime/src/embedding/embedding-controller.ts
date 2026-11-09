import { stat } from 'node:fs/promises'
import type { BrainEmbeddingStatus } from '@phosphor/shared/brain'
import { abortable, EmbeddingClient, type EmbeddingProcess } from './embedding-client'
import {
  embeddingModelPaths,
  installEmbeddingModel,
  removeEmbeddingModel,
  unverifiedFiles,
} from './embedding-files'
import type { BrainEmbeddingOptions, BrainEmbeddings } from './embedding-port'
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_MAX_TEXTS,
  EMBEDDING_MODEL,
  EMBEDDING_TOTAL_BYTES,
  embeddingInput,
  type EmbeddingKind,
} from './model-manifest'

export interface EmbeddingControllerPorts extends Pick<
  BrainEmbeddingOptions,
  'directory' | 'onStatus'
> {
  /** False on platforms the native runtime has not been verified on. */
  supported: boolean
  threads: number
  spawn(): EmbeddingProcess
  fetch?: typeof fetch
  log?(message: string): void
}

const LOAD_TIMEOUT_MS = 120_000
const BATCH_TIMEOUT_MS = 60_000
/** The loaded model (~600 MB) is let go after this long without an embed. */
export const EMBEDDING_IDLE_MS = 5 * 60_000
/** Progress is published in ~1 MB steps: per-chunk updates would flood every window. */
const PROGRESS_STEP_BYTES = 1_000_000
/** Invented text: the self-test must never embed user data. */
const SELF_TEST = {
  query: 'Who approves changes to the invoice schema?',
  document: 'The billing team owns the invoice service and reviews every schema change.',
}

type WorkKind = 'activate' | 'download'
const WORK_FAILURE: Record<WorkKind, string> = {
  activate: 'Local embeddings failed',
  download: 'Download failed',
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Shape-check vectors from the worker before anyone stores them. */
export function checkVectors(vectors: unknown, count: number): number[][] {
  const rows = Array.isArray(vectors) ? (vectors as unknown[]) : []
  const ok =
    rows.length === count &&
    rows.every(
      (row) =>
        Array.isArray(row) &&
        row.length === EMBEDDING_MODEL.dimensions &&
        row.every((value) => typeof value === 'number' && Number.isFinite(value)),
    )
  if (!ok) throw new Error('The embedding process returned malformed vectors')
  return rows as number[][]
}

/** Unit length, and a query and a document that the model tells apart. */
export function checkSelfTest([query, doc]: number[][]): void {
  const norm = (v: number[]): number => Math.hypot(...v)
  if (!query || !doc || [query, doc].some((v) => Math.abs(norm(v) - 1) > 1e-3)) {
    throw new Error('Model self-test failed: embeddings are not normalised')
  }
  const cosine = query.reduce((sum, value, i) => sum + value * doc[i]!, 0)
  if (!(cosine < 0.9999)) throw new Error('Model self-test failed: inputs are not distinguished')
}

/** Downloads on enable, verifies and self-tests before use; disabling only unloads. */
class EmbeddingController implements BrainEmbeddings {
  private state: BrainEmbeddingStatus
  private enabled = false
  private disposed = false
  private work: { kind: WorkKind; controller: AbortController; done: Promise<void> } | null = null
  /** Settles once every started setup step and removal has finished; they run in order. */
  private settled: Promise<void> = Promise.resolve()
  private worker: { client: EmbeddingClient; loaded: Promise<void> } | null = null
  private active = 0
  private idle: ReturnType<typeof setTimeout> | null = null
  private readonly paths

  constructor(private readonly ports: EmbeddingControllerPorts) {
    this.paths = embeddingModelPaths(ports.directory)
    this.state = {
      phase: ports.supported ? 'missing' : 'unsupported',
      receivedBytes: 0,
      totalBytes: 0,
      modelId: EMBEDDING_MODEL.id,
      dimensions: EMBEDDING_MODEL.dimensions,
    }
  }

  status(): BrainEmbeddingStatus {
    return { ...this.state }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return
    if (!enabled) {
      this.enabled = false
      this.cancelWork()
      this.unload()
      const present = await stat(this.paths.model).catch(() => null)
      if (this.enabled || this.disposed) return
      this.set({
        phase: !this.ports.supported ? 'unsupported' : present ? 'ready' : 'missing',
        receivedBytes: 0,
        totalBytes: present ? EMBEDDING_TOTAL_BYTES : 0,
      })
      return
    }
    if (!this.ports.supported) return
    if (this.enabled && this.work) return this.work.done
    if (this.enabled && this.state.phase === 'ready') return
    this.enabled = true
    return this.start('activate', (signal) => this.activate(signal))
  }

  async download(): Promise<void> {
    if (!this.ports.supported) {
      throw new Error('Local embeddings are not supported on this computer.')
    }
    if (!this.enabled || this.disposed)
      throw new Error('Turn on Brain before downloading its model.')
    if (this.work?.kind === 'download') return this.work.done
    if (this.state.phase === 'ready') return
    this.cancelWork()
    return this.start('download', (signal) => this.install(signal))
  }

  async remove(): Promise<void> {
    this.cancelWork()
    this.unload()
    const removing = this.settled.then(() => removeEmbeddingModel(this.paths))
    this.settled = removing.catch(() => undefined)
    await removing
    if (!this.work) this.set({ phase: this.restingPhase(), receivedBytes: 0, totalBytes: 0 })
  }

  async embed(texts: string[], kind: EmbeddingKind, signal?: AbortSignal): Promise<number[][]> {
    if (!this.enabled || this.state.phase !== 'ready') {
      throw new Error('Local embeddings are not ready. See Settings → Brain.')
    }
    if (texts.length > EMBEDDING_MAX_TEXTS) {
      throw new Error(`At most ${EMBEDDING_MAX_TEXTS} texts can be embedded at once`)
    }
    signal?.throwIfAborted()
    if (texts.length === 0) return []
    const inputs = texts.map((text) => embeddingInput(text, kind))
    this.active++
    this.clearIdle()
    try {
      const out: number[][] = []
      for (let i = 0; i < inputs.length; i += EMBEDDING_BATCH_SIZE) {
        out.push(...(await this.batch(inputs.slice(i, i + EMBEDDING_BATCH_SIZE), signal)))
      }
      return out
    } finally {
      this.active--
      this.armIdle()
    }
  }

  dispose(): void {
    this.disposed = true
    this.enabled = false
    this.cancelWork()
    this.unload()
  }

  private restingPhase(): BrainEmbeddingStatus['phase'] {
    if (!this.ports.supported) return 'unsupported'
    return 'missing'
  }

  private start(kind: WorkKind, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController()
    const previous = this.settled
    // Publish in-flight now: the caller returns this status before the work begins.
    this.set({
      phase: kind === 'download' ? 'downloading' : 'verifying',
      receivedBytes: 0,
      totalBytes: EMBEDDING_TOTAL_BYTES,
    })
    const done = (async () => {
      try {
        // A cancelled step or a removal still finishing must not race this one on disk.
        await previous
        controller.signal.throwIfAborted()
        await run(controller.signal)
      } catch (error) {
        if (controller.signal.aborted || this.disposed) return
        this.ports.log?.(`embedding ${kind} failed: ${message(error)}`)
        this.unload()
        this.set({ phase: 'error', error: `${WORK_FAILURE[kind]}: ${message(error)}` })
      } finally {
        if (this.work?.controller === controller) this.work = null
      }
    })()
    this.work = { kind, controller, done }
    this.settled = done
    return done
  }

  private cancelWork(): void {
    this.work?.controller.abort()
    this.work = null
  }

  /** Enable: check the files on disk (all hashes), then prove the model runs. */
  private async activate(signal: AbortSignal): Promise<void> {
    this.set({ phase: 'verifying', receivedBytes: 0, totalBytes: EMBEDDING_TOTAL_BYTES })
    if (!(await stat(this.paths.model).catch(() => null))) {
      await this.install(signal)
      return
    }
    const bad = await unverifiedFiles(this.paths.model, EMBEDDING_MODEL.files, signal)
    if (bad.length > 0) {
      throw new Error(
        `model files are incomplete or corrupt (${bad.join(', ')}). Download it again.`,
      )
    }
    await this.selfTest(signal)
  }

  private async install(signal: AbortSignal): Promise<void> {
    this.set({ phase: 'downloading', receivedBytes: 0, totalBytes: EMBEDDING_TOTAL_BYTES })
    let published = 0
    await installEmbeddingModel(this.paths, {
      signal,
      fetch: this.ports.fetch,
      onProgress: (receivedBytes) => {
        if (
          receivedBytes - published < PROGRESS_STEP_BYTES &&
          receivedBytes < EMBEDDING_TOTAL_BYTES
        ) {
          return
        }
        published = receivedBytes
        if (!signal.aborted) this.set({ receivedBytes })
      },
      onVerifying: () => {
        if (!signal.aborted) this.set({ phase: 'verifying' })
      },
    })
    await this.selfTest(signal)
  }

  /** A fresh worker loads the verified files and embeds invented text. */
  private async selfTest(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.set({ phase: 'testing' })
    this.unload()
    const vectors = await this.batch(
      [embeddingInput(SELF_TEST.query, 'query'), embeddingInput(SELF_TEST.document, 'document')],
      signal,
    )
    checkSelfTest(vectors)
    signal.throwIfAborted()
    this.set({
      phase: 'ready',
      receivedBytes: EMBEDDING_TOTAL_BYTES,
      totalBytes: EMBEDDING_TOTAL_BYTES,
    })
    this.armIdle()
  }

  private async batch(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    const worker = this.loadWorker()
    try {
      await abortable(worker.loaded, signal)
    } catch (error) {
      // After setup, a model that no longer loads needs the user: enabling again re-verifies.
      if (!signal?.aborted && this.state.phase === 'ready') {
        this.set({ phase: 'error', error: `Could not load the embedding model: ${message(error)}` })
      }
      throw error
    }
    const reply = await worker.client.request(
      { type: 'embed', texts: inputs },
      BATCH_TIMEOUT_MS,
      signal,
    )
    if (reply.type !== 'vectors') throw new Error('The embedding process sent no vectors')
    return checkVectors(reply.vectors, inputs.length)
  }

  /** The running worker, or a new one that loads the model from local files. */
  private loadWorker(): { client: EmbeddingClient; loaded: Promise<void> } {
    if (this.worker?.client.alive) return this.worker
    const client: EmbeddingClient = new EmbeddingClient(this.ports.spawn(), (reason) => {
      if (this.worker?.client !== client) return
      this.ports.log?.(`embedding worker closed: ${reason}`)
      this.worker = null
    })
    const loaded = client
      .request(
        {
          type: 'load',
          modelRoot: this.paths.root,
          modelName: EMBEDDING_MODEL.directoryName,
          threads: this.ports.threads,
        },
        LOAD_TIMEOUT_MS,
      )
      .then(() => undefined)
    // Awaited by each caller; a failed load also closes this worker.
    loaded.catch(() => client.close('The embedding model failed to load'))
    this.worker = { client, loaded }
    return this.worker
  }

  private unload(): void {
    this.clearIdle()
    const worker = this.worker
    this.worker = null
    worker?.client.close('Local embeddings stopped')
  }

  private armIdle(): void {
    this.clearIdle()
    if (this.active > 0 || !this.worker || this.disposed) return
    this.idle = setTimeout(() => this.unload(), EMBEDDING_IDLE_MS)
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
  }

  private set(next: Partial<BrainEmbeddingStatus>): void {
    this.state = { ...this.state, ...next }
    if (this.state.phase !== 'error') delete this.state.error
    if (!this.disposed) this.ports.onStatus?.(this.status())
  }
}

export function createEmbeddingController(ports: EmbeddingControllerPorts): BrainEmbeddings {
  return new EmbeddingController(ports)
}
