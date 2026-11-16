// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ImageEditor } from './ImageEditor'
import { drawScene } from './render'
import type * as EditorRender from './render'
import type { Scene } from './scene'

vi.mock('./render', async (original) => ({
  ...(await original<typeof EditorRender>()),
  decodeImage: async () => ({ element: new Image(), width: 100, height: 100 }),
  drawScene: vi.fn(),
  measureWith: () => () => ({ w: 10, h: 10 }),
  flattenScene: async () => 'flattened',
}))

let root: Root
let container: HTMLDivElement
const onSave = vi.fn(() => true)
beforeEach(async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      callback: ResizeObserverCallback
      observe() {
        this.callback(
          [{ contentRect: { width: 200, height: 200 } }] as ResizeObserverEntry[],
          this as unknown as ResizeObserver,
        )
      }
      disconnect() {}
    },
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as never)
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 200,
    height: 200,
  } as DOMRect)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  onSave.mockClear()
  await act(async () =>
    root.render(
      <ImageEditor
        image={{ kind: 'image', name: 'x.png', data: 'original', mimeType: 'image/png' }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    ),
  )
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function pointer(type: string, x: number, y: number, pointerId = 1): void {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: 'touch' },
    isPrimary: { value: pointerId === 1 },
  })
  act(() => {
    document.querySelector('canvas')!.dispatchEvent(event)
  })
}
const scene = (): Scene => vi.mocked(drawScene).mock.calls.at(-1)![1]
const button = (label: string): HTMLButtonElement =>
  document.querySelector(`[aria-label="${label}"]`)!

it('draws a touch rectangle in image coordinates, with undo and redo', async () => {
  pointer('pointerdown', 20, 30)
  pointer('pointermove', 100, 130)
  pointer('pointerup', 100, 130)
  expect(scene().shapes).toEqual([
    expect.objectContaining({ kind: 'rect', x: 10, y: 15, w: 40, h: 50 }),
  ])
  expect(document.querySelector('canvas')!.className).toContain('touch-none')
  act(() => button('Undo').click())
  expect(scene().shapes).toHaveLength(0)
  act(() => button('Redo').click())
  expect(scene().shapes).toHaveLength(1)
  await act(async () =>
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!.click(),
  )
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ data: 'flattened', annotation: scene() }),
    true,
  )
})

it('ignores other fingers and discards a cancelled stroke', () => {
  act(() => button('Draw').click())
  pointer('pointerdown', 20, 20)
  pointer('pointerdown', 100, 100, 2)
  pointer('pointermove', 150, 150, 2)
  pointer('pointerup', 150, 150, 2)
  expect(scene().shapes).toEqual([
    expect.objectContaining({ kind: 'pen', points: [{ x: 10, y: 10 }] }),
  ])
  pointer('pointermove', 60, 60)
  pointer('pointercancel', 60, 60)
  expect(scene().shapes).toHaveLength(0)
  expect(button('Undo').disabled).toBe(true)
})

it('does not cancel the drawing finger when another pointer is cancelled', () => {
  pointer('pointerdown', 20, 20)
  pointer('pointermove', 100, 100)
  pointer('pointercancel', 80, 80, 2)
  pointer('pointerup', 100, 100)
  expect(scene().shapes).toHaveLength(1)
  expect(button('Undo').disabled).toBe(false)
})

it('discards a stroke when its pointer capture is lost and accepts a fresh pointer', () => {
  pointer('pointerdown', 20, 20)
  pointer('pointermove', 100, 100)
  pointer('lostpointercapture', 100, 100)
  expect(scene().shapes).toHaveLength(0)
  expect(button('Undo').disabled).toBe(true)
  const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 30 })
  Object.defineProperties(down, {
    pointerId: { value: 3 },
    pointerType: { value: 'touch' },
    isPrimary: { value: true },
  })
  act(() => document.querySelector('canvas')!.dispatchEvent(down))
  pointer('pointermove', 150, 150, 3)
  pointer('pointerup', 150, 150, 3)
  expect(scene().shapes).toEqual([
    expect.objectContaining({ kind: 'rect', x: 15, y: 15, w: 60, h: 60 }),
  ])
})

it('ignores capture loss from another pointer and after a completed stroke', () => {
  pointer('pointerdown', 20, 20)
  pointer('pointermove', 100, 100)
  pointer('lostpointercapture', 80, 80, 2)
  pointer('pointerup', 100, 100)
  pointer('lostpointercapture', 100, 100)
  expect(scene().shapes).toHaveLength(1)
  expect(button('Undo').disabled).toBe(false)
})
