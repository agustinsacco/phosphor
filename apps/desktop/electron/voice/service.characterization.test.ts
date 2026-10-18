import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoicePrefs } from '@shared/voice'
import type { FromVoiceWorker, ToVoiceWorker } from './protocol'

const disk = vi.hoisted(() => ({
  present: true,
  signals: [] as AbortSignal[],
  finish: [] as Array<() => void>,
  pruned: [] as string[][],
}))
vi.mock('./download', () => ({
  filesPresent: async () => disk.present,
  pruneDir: async (_dir: string, keep: string[]) => void disk.pruned.push(keep),
  downloadFiles: (_dir: string, _files: unknown, options: { signal: AbortSignal }) =>
    new Promise<void>((resolve, reject) => {
      disk.signals.push(options.signal)
      disk.finish.push(resolve)
      options.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
}))

const { createVoiceService, VOICE_IDLE_MS } = await import('./service')
const ENABLED: VoicePrefs = { enabled: true, model: 'moonshine-tiny-en' }

class Worker {
  posted: ToVoiceWorker[] = []
  killed = false
  message: (message: FromVoiceWorker) => void = () => undefined
  exit: () => void = () => undefined
  post(message: ToVoiceWorker): void {
    this.posted.push(message)
  }
  onMessage(listener: typeof this.message): void {
    this.message = listener
  }
  onExit(listener: () => void): void {
    this.exit = listener
  }
  kill(): void {
    this.killed = true
    this.exit()
  }
}

function setup(microphone = true) {
  const workers: Worker[] = []
  const service = createVoiceService({
    dir: '/voice',
    loadPrefs: () => ENABLED,
    savePrefs: vi.fn(),
    publish: vi.fn(),
    spawnWorker: () => {
      const worker = new Worker()
      workers.push(worker)
      return worker
    },
    allowMicrophone: async () => microphone,
  })
  return { service, workers }
}

beforeEach(() => {
  disk.present = true
  disk.signals = []
  disk.finish = []
  disk.pruned = []
})
afterEach(() => vi.useRealTimers())

describe('voice service public lifetime contract', () => {
  it('switching and disabling supersede downloads without restoring ready', async () => {
    disk.present = false
    const { service } = setup()
    const first = service.init()
    await vi.waitFor(() => expect(disk.signals).toHaveLength(1))
    const second = service.setPrefs({ ...ENABLED, model: 'moonshine-base-en' })
    await vi.waitFor(() => expect(disk.signals).toHaveLength(2))
    expect(disk.signals[0]!.aborted).toBe(true)
    const off = await service.setPrefs({ ...ENABLED, enabled: false })
    expect(disk.signals[1]!.aborted).toBe(true)
    await Promise.all([first, second])
    expect(service.status()).toEqual(off)
    expect(off).toMatchObject({ phase: 'off', receivedBytes: 0, totalBytes: 0 })
    expect(disk.pruned).toEqual([[]])
    service.dispose()
  })

  it('transfers audio ownership and ignores other windows and oversized chunks', async () => {
    const { service, workers } = setup()
    await service.init()
    await service.start(1)
    await service.start(2)
    service.audio(1, new Float32Array(16))
    service.audio(2, new Float32Array(80_001))
    service.audio(2, new Float32Array(16))
    service.cancel(1)
    await expect(service.stop(1)).resolves.toEqual({ text: '' })
    expect(workers[0]!.posted.map((m) => m.type)).toEqual([
      'load',
      'begin',
      'cancel',
      'begin',
      'audio',
    ])
    service.dispose()
  })

  it('permission refusal never spawns a worker', async () => {
    const { service, workers } = setup(false)
    await service.init()
    await expect(service.start(1)).rejects.toThrow(
      'Phosphor cannot use the microphone. Allow it in your privacy settings.',
    )
    expect(workers).toEqual([])
    service.dispose()
  })

  it('load errors drop the failed worker and permit a fresh process', async () => {
    const { service, workers } = setup()
    await service.init()
    await service.start(1)
    workers[0]!.message({ type: 'error', message: 'bad model' })
    await expect(service.stop(1)).rejects.toThrow('Could not load the voice model: bad model')
    expect(workers[0]!.killed).toBe(true)
    await service.start(1)
    expect(workers).toHaveLength(2)
    service.dispose()
  })

  it('worker exit rejects a pending stop', async () => {
    const { service, workers } = setup()
    await service.init()
    await service.start(1)
    workers[0]!.message({ type: 'loaded' })
    const stopped = service.stop(1)
    const rejected = expect(stopped).rejects.toThrow('The voice process exited')
    workers[0]!.exit()
    await rejected
    service.dispose()
  })

  it('stop expires at sixty seconds and unloads the worker', async () => {
    vi.useFakeTimers()
    const { service, workers } = setup()
    await service.init()
    await service.start(1)
    workers[0]!.message({ type: 'loaded' })
    const stopped = service.stop(1)
    const rejected = expect(stopped).rejects.toThrow('Transcription timed out')
    await vi.advanceTimersByTimeAsync(59_999)
    expect(workers[0]!.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(workers[0]!.killed).toBe(true)
    service.dispose()
  })

  it('disabling rejects a pending stop even before the model loads', async () => {
    const { service, workers } = setup()
    await service.init()
    await service.start(1)
    const stopped = service.stop(1)
    const rejected = expect(stopped).rejects.toThrow('The voice process exited')
    await service.setPrefs({ ...ENABLED, enabled: false })
    await rejected
    expect(workers[0]!.killed).toBe(true)
    service.dispose()
  })

  it('cancel unloads only after three idle minutes and starting rearms the lifetime', async () => {
    vi.useFakeTimers()
    const { service, workers } = setup()
    await service.init()
    await service.start(1)
    service.cancel(1)
    expect(VOICE_IDLE_MS).toBe(180_000)
    await vi.advanceTimersByTimeAsync(VOICE_IDLE_MS - 1)
    expect(workers[0]!.killed).toBe(false)
    await service.start(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(workers[0]!.killed).toBe(false)
    service.cancel(1)
    await vi.advanceTimersByTimeAsync(VOICE_IDLE_MS)
    expect(workers[0]!.killed).toBe(true)
    service.dispose()
  })
})
