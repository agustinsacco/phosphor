import { beforeEach, expect, it, vi } from 'vitest'
import type { VoicePrefs, VoiceStatus } from '@shared/voice'
import type { DownloadOptions } from './download'
import { VOICE_MANIFEST } from './manifest'
import type { VoicePorts } from './service'
import { deferred, VoiceServiceState } from './service-state'
import { VoiceModelService } from './model-service'

const disk = vi.hoisted(() => ({
  present: vi.fn(),
  prune: vi.fn(),
  download: vi.fn(),
}))
vi.mock('./download', () => ({
  filesPresent: disk.present,
  pruneDir: disk.prune,
  downloadFiles: disk.download,
}))
const ENABLED: VoicePrefs = { enabled: true, model: 'moonshine-tiny-en' }

function setup() {
  const published: VoiceStatus[] = []
  const state = new VoiceServiceState(ENABLED, (status) => published.push(status))
  const ports: VoicePorts = {
    dir: '/voice',
    loadPrefs: () => ENABLED,
    savePrefs: vi.fn(),
    publish: vi.fn(),
    spawnWorker: vi.fn(),
    allowMicrophone: vi.fn(),
    log: vi.fn(),
  }
  const unload = vi.fn()
  return { state, ports, unload, published, model: new VoiceModelService(state, ports, unload) }
}

beforeEach(() => {
  vi.resetAllMocks()
  disk.present.mockResolvedValue(false)
  disk.prune.mockResolvedValue(undefined)
})

it('throttles progress, completes the download before pruning, then reports ready', async () => {
  const { state, published, model } = setup()
  const finished = deferred<void>()
  let options: DownloadOptions = {}
  disk.download.mockImplementation((_dir, _files, next: DownloadOptions) => {
    options = next
    return finished.promise
  })
  const result = model.ensureModel()
  await Promise.resolve()
  expect(state.status.phase).toBe('downloading')
  options.onProgress?.(999_999)
  expect(published).toHaveLength(1)
  options.onProgress?.(1_000_000)
  expect(state.status.receivedBytes).toBe(1_000_000)
  options.onProgress?.(1_999_999)
  expect(published).toHaveLength(2)
  const total = VOICE_MANIFEST[ENABLED.model].reduce((sum, file) => sum + file.bytes, 0)
  options.onProgress?.(total)
  expect(state.status.receivedBytes).toBe(total)
  expect(disk.prune).not.toHaveBeenCalled()
  finished.resolve()
  await expect(result).resolves.toMatchObject({ phase: 'ready', totalBytes: total })
  expect(disk.prune).toHaveBeenCalledExactlyOnceWith(
    '/voice',
    VOICE_MANIFEST[ENABLED.model].map((file) => file.path),
  )
})

it('aborts on disable and prunes everything after unloading and saving prefs', async () => {
  const { model, state, unload, ports } = setup()
  disk.download.mockImplementation(
    (_dir, _files, options: DownloadOptions) =>
      new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  )
  const pending = model.ensureModel()
  await Promise.resolve()
  const controller = state.download!.controller
  disk.prune.mockImplementation(async () => {
    expect(controller.signal.aborted).toBe(true)
    expect(unload).toHaveBeenCalledOnce()
    expect(ports.savePrefs).toHaveBeenCalledWith({ ...ENABLED, enabled: false })
    expect(state.download).toBeNull()
  })
  await model.setPrefs({ ...ENABLED, enabled: false })
  await pending
  expect(disk.prune).toHaveBeenCalledExactlyOnceWith('/voice', [])
  expect(state.status.phase).toBe('off')
})

it('a superseded download cannot clear the replacement download or prune its files', async () => {
  const { model, state } = setup()
  const first = deferred<void>()
  const second = deferred<void>()
  disk.download.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const old = model.ensureModel()
  await Promise.resolve()
  const oldController = state.download!.controller
  const next = model.setPrefs({ ...ENABLED, model: 'moonshine-base-en' })
  await Promise.resolve()
  const replacement = state.download
  expect(oldController.signal.aborted).toBe(true)
  first.resolve()
  await old
  expect(state.download).toBe(replacement)
  expect(disk.prune).not.toHaveBeenCalled()
  second.resolve()
  await next
  expect(state.download).toBeNull()
  expect(disk.prune).toHaveBeenCalledExactlyOnceWith(
    '/voice',
    VOICE_MANIFEST['moonshine-base-en'].map((file) => file.path),
  )
})

it('reports download failures and clears the error on retry', async () => {
  const { model, state, ports } = setup()
  disk.download.mockRejectedValueOnce(new Error('HTTP 503'))
  await expect(model.ensureModel()).resolves.toMatchObject({
    phase: 'error',
    error: 'Download failed: HTTP 503',
  })
  expect(ports.log).toHaveBeenCalledWith('voice download failed: Error: HTTP 503')
  expect(state.download).toBeNull()
  disk.download.mockResolvedValueOnce(undefined)
  await expect(model.ensureModel()).resolves.toMatchObject({ phase: 'ready' })
  expect(state.status).not.toHaveProperty('error')
})

it('prunes a present model before publishing ready without downloading', async () => {
  const { model, state } = setup()
  disk.present.mockResolvedValue(true)
  disk.prune.mockImplementation(async () => expect(state.status.phase).toBe('off'))
  await model.ensureModel()
  expect(disk.download).not.toHaveBeenCalled()
  expect(state.status.phase).toBe('ready')
})
