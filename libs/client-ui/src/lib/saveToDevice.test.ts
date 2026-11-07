// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { saveToDevice } from './saveToDevice'

const invoke = vi.fn()
const file = { name: 'a.svg', title: 'Save diagram', content: vi.fn(() => '<svg/>') }
beforeEach(() => {
  invoke.mockReset()
  file.content.mockClear()
  vi.stubGlobal('phosphor', { invoke })
})
afterEach(() => vi.restoreAllMocks())

it('nativeFiles: asks where, writes there and reveals it', async () => {
  invoke.mockImplementation(async (channel: string) =>
    channel === 'app:saveDialog' ? '/out/a.svg' : undefined,
  )
  await saveToDevice(file, true)
  expect(invoke.mock.calls).toEqual([
    ['app:saveDialog', { title: 'Save diagram', defaultPath: 'a.svg' }],
    ['fs:writeFile', '/out/a.svg', '<svg/>'],
    ['app:revealPath', '/out/a.svg'],
  ])
})

it('nativeFiles: a cancelled dialog never reads the content', async () => {
  invoke.mockResolvedValue(null)
  await saveToDevice(file, true)
  expect(file.content).not.toHaveBeenCalled()
  expect(invoke).toHaveBeenCalledOnce()
})

it('without nativeFiles: downloads as an octet stream, with no native channel', async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  vi.useFakeTimers()
  try {
    await saveToDevice(file, false)
    expect(invoke).not.toHaveBeenCalled()
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('a.svg')
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob
    expect(blob.type).toBe('application/octet-stream')
    // Revoked late: WebKit and older Firefox read the URL after the click returns.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
  } finally {
    vi.useRealTimers()
  }
})
