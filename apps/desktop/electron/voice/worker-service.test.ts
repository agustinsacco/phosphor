import { afterEach, expect, it, vi } from 'vitest'
import type { VoicePrefs } from '@shared/voice'
import type { FromVoiceWorker, ToVoiceWorker } from './protocol'
import type { VoicePorts } from './service'
import { deferred, VoiceServiceState } from './service-state'
import { VOICE_IDLE_MS, VoiceWorkerService } from './worker-service'

class Worker {
  posted: ToVoiceWorker[] = []
  killed = false
  reply: (message: FromVoiceWorker) => void = () => undefined
  exit: () => void = () => undefined
  post(message: ToVoiceWorker): void {
    this.posted.push(message)
  }
  onMessage(listener: typeof this.reply): void {
    this.reply = listener
  }
  onExit(listener: () => void): void {
    this.exit = listener
  }
  kill(): void {
    this.killed = true
    this.exit()
  }
}
const ENABLED: VoicePrefs = { enabled: true, model: 'moonshine-tiny-en' }

function setup() {
  const workers: Worker[] = []
  const state = new VoiceServiceState(ENABLED, vi.fn())
  state.set({ phase: 'ready' })
  const ports: VoicePorts = {
    dir: '/voice',
    loadPrefs: () => ENABLED,
    savePrefs: vi.fn(),
    publish: vi.fn(),
    spawnWorker: () => {
      const worker = new Worker()
      workers.push(worker)
      return worker
    },
    allowMicrophone: vi.fn().mockResolvedValue(true),
    log: vi.fn(),
  }
  return { state, ports, workers, service: new VoiceWorkerService(state, ports) }
}
afterEach(() => vi.useRealTimers())

it('loads absolute paths once and a late exit cannot clear the replacement worker or pending', async () => {
  const { service, workers, state } = setup()
  const first = service.load()
  expect(service.load()).toBe(first)
  expect(workers[0]!.posted[0]).toEqual({
    type: 'load',
    files: {
      encoder: '/voice/moonshine-tiny-en/encoder_model.ort',
      decoder: '/voice/moonshine-tiny-en/decoder_model_merged.ort',
      tokens: '/voice/moonshine-tiny-en/tokens.txt',
      vad: '/voice/silero_vad.onnx',
    },
  })
  state.set({ prefs: { ...ENABLED, model: 'moonshine-base-en' } })
  await service.start(8)
  const replacement = state.loaded
  const reply = deferred<string>()
  state.pending.set(9, reply)
  workers[0]!.exit()
  expect(state.loaded).toBe(replacement)
  expect(state.owner).toBe(8)
  expect(state.pending.get(9)).toBe(reply)
  service.unload()
})

it('transfers ownership, ignores foreign audio and cancel, and routes only valid chunks', async () => {
  const { service, state, workers } = setup()
  await service.start(1)
  await service.start(2)
  service.audio(1, new Float32Array(2))
  service.audio(2, new Float32Array(80_001))
  const samples = new Float32Array(80_000)
  service.audio(2, samples)
  service.cancel(1)
  expect(state.owner).toBe(2)
  expect(workers[0]!.posted.slice(1)).toEqual([
    { type: 'begin' },
    { type: 'cancel' },
    { type: 'begin' },
    { type: 'audio', samples },
  ])
  await expect(service.stop(1)).resolves.toEqual({ text: '' })
  service.unload()
})

it('routes text and id-specific errors to pending stops and removes the entries', async () => {
  const { service, workers, state } = setup()
  await service.start(1)
  workers[0]!.reply({ type: 'loaded' })
  const first = service.stop(1)
  workers[0]!.reply({ type: 'text', id: 999, text: 'ignored' })
  expect(state.pending.size).toBe(1)
  workers[0]!.reply({ type: 'text', id: 1, text: 'Hello' })
  await expect(first).resolves.toEqual({ text: 'Hello' })
  expect(state.pending.size).toBe(0)
  await service.start(1)
  const second = service.stop(1)
  const rejected = expect(second).rejects.toThrow('decode failed')
  workers[0]!.reply({ type: 'error', id: 2, message: 'decode failed' })
  await rejected
  expect(workers[0]!.killed).toBe(true)
  expect(state.pending.size).toBe(0)
})

it('surfaces a mid-dictation error even when the text reply succeeds', async () => {
  const { service, workers, state } = setup()
  await service.start(1)
  workers[0]!.reply({ type: 'loaded' })
  workers[0]!.reply({ type: 'error', message: 'audio failed' })
  const stopped = service.stop(1)
  const rejected = expect(stopped).rejects.toThrow('audio failed')
  workers[0]!.reply({ type: 'text', id: 1, text: 'partial' })
  await rejected
  await service.start(1)
  expect(state.dictationError).toBeNull()
  service.unload()
})

it('unloading clears ownership, rejects pending replies and clears idle timers', async () => {
  vi.useFakeTimers()
  const { service, workers, state } = setup()
  await service.start(1)
  workers[0]!.reply({ type: 'loaded' })
  const stopped = service.stop(1)
  const rejected = expect(stopped).rejects.toThrow('Voice input stopped')
  service.armIdle()
  service.unload()
  await rejected
  expect(state.loaded).toBeNull()
  expect(state.owner).toBeNull()
  expect(state.pending.size).toBe(0)
  expect(state.idleTimer).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('a pending stop from an old worker cannot unload or arm idle for its replacement', async () => {
  vi.useFakeTimers()
  const { service, workers, state } = setup()
  await service.start(1)
  workers[0]!.reply({ type: 'loaded' })
  const stopped = service.stop(1)
  const rejected = expect(stopped).rejects.toThrow('Voice input stopped')
  state.set({ prefs: { ...ENABLED, model: 'moonshine-base-en' } })
  await service.start(2)
  await rejected
  expect(state.loaded?.worker).toBe(workers[1])
  expect(state.owner).toBe(2)
  expect(state.idleTimer).toBeNull()
  await vi.advanceTimersByTimeAsync(VOICE_IDLE_MS)
  expect(workers[1]!.killed).toBe(false)
  service.unload()
})

it('stop deadline and successful idle unload leave no timers behind', async () => {
  vi.useFakeTimers()
  const { service, workers } = setup()
  await service.start(1)
  workers[0]!.reply({ type: 'loaded' })
  const stopped = service.stop(1)
  const rejected = expect(stopped).rejects.toThrow('Transcription timed out')
  await vi.advanceTimersByTimeAsync(60_000)
  await rejected
  expect(vi.getTimerCount()).toBe(0)
  await service.start(1)
  workers[1]!.reply({ type: 'loaded' })
  const next = service.stop(1)
  workers[1]!.reply({ type: 'text', id: 2, text: '' })
  await next
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(VOICE_IDLE_MS)
  expect(workers[1]!.killed).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
