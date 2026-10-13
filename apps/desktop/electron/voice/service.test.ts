import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VOICE_PREFS, type VoicePrefs, type VoiceStatus } from '@shared/voice'
import type { FromVoiceWorker, ToVoiceWorker } from './protocol'

const disk = vi.hoisted(() => ({
  present: false,
  downloads: [] as Array<{ files: Array<{ path: string }>; signal?: AbortSignal }>,
  finish: [] as Array<(error?: Error) => void>,
  pruned: [] as string[][],
}))

vi.mock('./download', () => ({
  filesPresent: async () => disk.present,
  pruneDir: async (_dir: string, keep: string[]) => void disk.pruned.push(keep),
  downloadFiles: (
    _dir: string,
    files: Array<{ path: string }>,
    options: { signal?: AbortSignal },
  ) =>
    new Promise<void>((resolve, reject) => {
      disk.downloads.push({ files, signal: options.signal })
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      disk.finish.push((error) => (error ? reject(error) : resolve()))
    }),
}))

const { createVoiceService, VOICE_IDLE_MS } = await import('./service')

class FakeWorker {
  posted: ToVoiceWorker[] = []
  killed = false
  private listener: (message: FromVoiceWorker) => void = () => undefined
  private exit: () => void = () => undefined
  post(message: ToVoiceWorker): void {
    this.posted.push(message)
  }
  onMessage(listener: (message: FromVoiceWorker) => void): void {
    this.listener = listener
  }
  onExit(listener: () => void): void {
    this.exit = listener
  }
  kill(): void {
    this.killed = true
    this.exit()
  }
  reply(message: FromVoiceWorker): void {
    this.listener(message)
  }
  types(): string[] {
    return this.posted.map((m) => m.type)
  }
}

function setup(prefs: VoicePrefs = DEFAULT_VOICE_PREFS, microphone = true) {
  const workers: FakeWorker[] = []
  const published: VoiceStatus[] = []
  let saved = prefs
  const service = createVoiceService({
    dir: '/voice',
    loadPrefs: () => saved,
    savePrefs: (next) => (saved = next),
    publish: (status) => published.push(status),
    spawnWorker: () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    },
    allowMicrophone: async () => microphone,
  })
  return { service, workers, published, saved: () => saved }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))
const ENABLED: VoicePrefs = { enabled: true, model: 'moonshine-tiny-en' }

beforeEach(() => {
  disk.present = false
  disk.downloads = []
  disk.finish = []
  disk.pruned = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe('voice prefs and the model download', () => {
  it('downloads on enable, then reports ready and keeps only that model', async () => {
    const { service, saved } = setup()
    const pending = service.setPrefs(ENABLED)
    await flush()
    expect(service.status().phase).toBe('downloading')
    expect(saved()).toEqual(ENABLED)
    disk.finish[0]!()
    expect((await pending).phase).toBe('ready')
    expect(disk.pruned.at(-1)).toContain('moonshine-tiny-en/encoder_model.ort')
  })

  it('reports a failed download, and a retry starts again', async () => {
    const { service } = setup()
    const pending = service.setPrefs(ENABLED)
    await flush()
    disk.finish[0]!(new Error('HTTP 503'))
    const failed = await pending
    expect(failed).toMatchObject({ phase: 'error', error: 'Download failed: HTTP 503' })
    void service.setPrefs(ENABLED)
    await flush()
    expect(disk.downloads).toHaveLength(2)
  })

  it('a second enable while downloading does not restart it', async () => {
    const { service } = setup()
    void service.setPrefs(ENABLED)
    await flush()
    void service.setPrefs(ENABLED)
    await flush()
    expect(disk.downloads).toHaveLength(1)
  })

  it('disabling aborts the download and deletes every file', async () => {
    const { service } = setup()
    void service.setPrefs(ENABLED)
    await flush()
    const off = await service.setPrefs({ ...ENABLED, enabled: false })
    expect(disk.downloads[0]!.signal?.aborted).toBe(true)
    expect(off.phase).toBe('off')
    expect(disk.pruned.at(-1)).toEqual([])
  })

  it('switching model abandons the old download for the new one', async () => {
    const { service } = setup()
    void service.setPrefs(ENABLED)
    await flush()
    const pending = service.setPrefs({ enabled: true, model: 'moonshine-base-en' })
    await flush()
    expect(disk.downloads[0]!.signal?.aborted).toBe(true)
    disk.finish[1]!()
    expect((await pending).phase).toBe('ready')
    expect(service.status().prefs.model).toBe('moonshine-base-en')
  })

  it('on launch, finds the model on disk without downloading', async () => {
    disk.present = true
    const { service } = setup(ENABLED)
    expect((await service.init()).phase).toBe('ready')
    expect(disk.downloads).toHaveLength(0)
  })
})

describe('dictation', () => {
  async function ready(microphone = true) {
    disk.present = true
    const env = setup(ENABLED, microphone)
    await env.service.init()
    return env
  }

  it('refuses to start before the model is ready', async () => {
    const { service } = setup()
    await expect(service.start(1)).rejects.toThrow('not ready')
  })

  it('refuses to start when the microphone is denied', async () => {
    const { service, workers } = await ready(false)
    await expect(service.start(1)).rejects.toThrow('microphone')
    expect(workers).toHaveLength(0)
  })

  it('loads the model, streams audio, and returns the text', async () => {
    const { service, workers } = await ready()
    await service.start(1)
    const worker = workers[0]!
    service.audio(1, new Float32Array(1600))
    service.audio(2, new Float32Array(1600)) // another window: ignored
    service.audio(1, new Float32Array(16_000 * 6)) // not a chunk: ignored
    const stopped = service.stop(1)
    expect(worker.types()).toEqual(['load', 'begin', 'audio', 'end'])
    worker.reply({ type: 'loaded' })
    worker.reply({ type: 'text', id: 1, text: 'Hello.' })
    await expect(stopped).resolves.toEqual({ text: 'Hello.' })
  })

  it('reuses the loaded model, and lets it go when idle', async () => {
    vi.useFakeTimers()
    const { service, workers } = await ready()
    await service.start(1)
    workers[0]!.reply({ type: 'loaded' })
    const first = service.stop(1)
    workers[0]!.reply({ type: 'text', id: 1, text: '' })
    await first
    await service.start(1)
    expect(workers).toHaveLength(1)
    const second = service.stop(1)
    workers[0]!.reply({ type: 'text', id: 2, text: 'Again.' })
    await second
    vi.advanceTimersByTime(VOICE_IDLE_MS)
    expect(workers[0]!.killed).toBe(true)
  })

  it('a model that fails to load fails the dictation and is dropped', async () => {
    const { service, workers } = await ready()
    await service.start(1)
    const stopped = service.stop(1)
    workers[0]!.reply({ type: 'error', message: 'bad model' })
    await expect(stopped).rejects.toThrow('Could not load the voice model: bad model')
    expect(workers[0]!.killed).toBe(true)
  })

  it('a crash mid-dictation rejects the stop', async () => {
    const { service, workers } = await ready()
    await service.start(1)
    workers[0]!.reply({ type: 'loaded' })
    const stopped = service.stop(1)
    workers[0]!.kill()
    await expect(stopped).rejects.toThrow('exited')
  })

  it('a stop from another window gets nothing and ends nothing', async () => {
    const { service, workers } = await ready()
    await service.start(1)
    await expect(service.stop(2)).resolves.toEqual({ text: '' })
    expect(workers[0]!.types()).toEqual(['load', 'begin'])
  })

  it('disabling voice stops the model', async () => {
    const { service, workers } = await ready()
    await service.start(1)
    await service.setPrefs({ ...ENABLED, enabled: false })
    expect(workers[0]!.killed).toBe(true)
  })
})
