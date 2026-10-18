// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { editorFontOptions, loadBundledFonts } from './fonts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function setup(load: (face: FontFace) => Promise<FontFace>) {
  const faces: FontFace[] = []
  const add = vi.fn()
  vi.stubGlobal(
    'FontFace',
    class {
      status = 'unloaded'
      constructor(
        public family: string,
        _url: string,
        public descriptors: FontFaceDescriptors,
      ) {
        faces.push(this as unknown as FontFace)
      }
      load() {
        return load(this as unknown as FontFace)
      }
    },
  )
  vi.stubGlobal('document', { fonts: { add } })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return { faces, add }
}

it('maps the same explicit font preferences for editors and diffs', () => {
  expect(editorFontOptions({ editorFontSize: 18, monoFont: 'Menlo' })).toEqual({
    fontSize: 18,
    fontFamily: 'Menlo, ui-monospace, SF Mono, Menlo, monospace',
  })
})

it('registers loaded normal/italic faces without touching user preferences', async () => {
  const { faces, add } = setup(async (face) => {
    Object.defineProperty(face, 'status', { value: 'loaded' })
    return face
  })
  await loadBundledFonts()
  expect(faces.map((face) => face.family)).toEqual([
    'Inter',
    'Inter',
    'JetBrains Mono',
    'JetBrains Mono',
  ])
  expect(add.mock.calls.map(([face]) => face)).toEqual(faces)
})

it('keeps failed fonts out of the set and still allows startup', async () => {
  const { add } = setup(async () => {
    throw new Error('missing asset')
  })
  await expect(loadBundledFonts()).resolves.toBeUndefined()
  expect(add).not.toHaveBeenCalled()
})

it('bounds startup and never registers fonts that finish after the deadline', async () => {
  vi.useFakeTimers()
  const finish: (() => void)[] = []
  const { add } = setup(
    (face) =>
      new Promise((resolve) => {
        finish.push(() => {
          Object.defineProperty(face, 'status', { value: 'loaded' })
          resolve(face)
        })
      }),
  )
  const loading = loadBundledFonts()
  await vi.advanceTimersByTimeAsync(1500)
  await loading
  expect(add).not.toHaveBeenCalled()
  finish.forEach((resolve) => resolve())
  await vi.runAllTimersAsync()
  expect(add).not.toHaveBeenCalled()
})
