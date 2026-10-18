import { describe, expect, it } from 'vitest'
import {
  commit,
  dragHandle,
  handles,
  hitTest,
  initHistory,
  isDegenerate,
  nextStep,
  normalizeBox,
  placeLayer,
  redo,
  sceneBytes,
  translate,
  undo,
  withShape,
  type LayerImage,
  type MeasureText,
  type Scene,
  type Shape,
} from './scene'

const base: LayerImage = {
  id: 'base',
  data: 'BASE',
  mimeType: 'image/png',
  width: 1000,
  height: 500,
}
const measure: MeasureText = (s) => ({ w: s.text.length * 10, h: s.size * 1.25 })

const rect: Shape = {
  kind: 'rect',
  id: 'r',
  color: 'red',
  width: 4,
  x: 100,
  y: 100,
  w: 200,
  h: 100,
}
const ellipse: Shape = {
  kind: 'ellipse',
  id: 'e',
  color: 'red',
  width: 4,
  x: 400,
  y: 100,
  w: 200,
  h: 100,
}
const arrow: Shape = {
  kind: 'arrow',
  id: 'a',
  color: 'red',
  width: 4,
  from: { x: 0, y: 0 },
  to: { x: 100, y: 100 },
}
const pen: Shape = {
  kind: 'pen',
  id: 'p',
  color: 'red',
  width: 4,
  highlight: false,
  points: [
    { x: 700, y: 300 },
    { x: 800, y: 300 },
  ],
}
const text: Shape = {
  kind: 'text',
  id: 't',
  color: 'red',
  at: { x: 50, y: 400 },
  text: 'hello',
  size: 20,
}
const step: Shape = { kind: 'step', id: 's', color: 'red', at: { x: 900, y: 50 }, n: 2, size: 15 }

describe('normalizeBox', () => {
  it('accepts a drag in any direction', () => {
    expect(normalizeBox({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 40, h: 60 })
  })

  it('squares the box on the longer side, keeping the drag direction', () => {
    expect(normalizeBox({ x: 50, y: 50 }, { x: 10, y: 40 }, true)).toEqual({
      x: 10,
      y: 10,
      w: 40,
      h: 40,
    })
  })
})

describe('hitTest', () => {
  const shapes = [rect, ellipse, arrow, pen, text, step]
  const at = (x: number, y: number): string | undefined => hitTest(shapes, { x, y }, 3, measure)?.id

  it('finds each kind of shape where it is drawn', () => {
    expect(at(150, 150)).toBe('r')
    expect(at(500, 150)).toBe('e')
    expect(at(50, 50)).toBe('a')
    expect(at(750, 302)).toBe('p')
    expect(at(60, 410)).toBe('t')
    expect(at(905, 55)).toBe('s')
  })

  it('misses the corners of an ellipse and empty space', () => {
    expect(at(402, 102)).toBeUndefined()
    expect(at(950, 450)).toBeUndefined()
    // Off the arrow's line, though inside its bounding box.
    expect(at(90, 10)).toBeUndefined()
  })

  it('keeps a shape selectable after a box is drawn around it', () => {
    const inner: Shape = { ...arrow, id: 'inner', from: { x: 150, y: 130 }, to: { x: 250, y: 170 } }
    // The box was drawn last, so it is on top, but only its outline is ink.
    expect(hitTest([inner, rect], { x: 200, y: 150 }, 3, measure)?.id).toBe('inner')
    expect(hitTest([inner, rect], { x: 101, y: 150 }, 3, measure)?.id).toBe('r')
    // Empty inside still selects the box when nothing else is there.
    expect(hitTest([inner, rect], { x: 120, y: 190 }, 3, measure)?.id).toBe('r')
  })

  it('prefers the shape painted last', () => {
    const top: Shape = { ...rect, id: 'top' }
    expect(hitTest([rect, top], { x: 150, y: 150 }, 3, measure)?.id).toBe('top')
  })
})

describe('dragHandle', () => {
  it('moves one corner and keeps the opposite one fixed', () => {
    expect(dragHandle(rect, 'nw', { x: 50, y: 60 })).toMatchObject({ x: 50, y: 60, w: 250, h: 140 })
    expect(dragHandle(rect, 'se', { x: 400, y: 300 })).toMatchObject({
      x: 100,
      y: 100,
      w: 300,
      h: 200,
    })
  })

  it('flips cleanly when a corner is dragged past its opposite', () => {
    expect(dragHandle(rect, 'se', { x: 50, y: 50 })).toMatchObject({ x: 50, y: 50, w: 50, h: 50 })
  })

  it('never squashes a pasted image', () => {
    const layer: Shape = { kind: 'image', id: 'i', image: base, x: 0, y: 0, w: 200, h: 100 }
    const resized = dragHandle(layer, 'se', { x: 400, y: 120 })
    expect(resized).toMatchObject({ x: 0, y: 0, w: 400, h: 200 })
  })

  it('moves either end of an arrow', () => {
    expect(dragHandle(arrow, 'to', { x: 5, y: 9 })).toMatchObject({
      from: { x: 0, y: 0 },
      to: { x: 5, y: 9 },
    })
  })

  it('offers corner handles for boxes, end handles for arrows, none otherwise', () => {
    expect(handles(rect).map((h) => h.handle)).toEqual(['nw', 'ne', 'sw', 'se'])
    expect(handles(arrow).map((h) => h.handle)).toEqual(['from', 'to'])
    expect(handles(text)).toEqual([])
  })
})

describe('translate', () => {
  it('moves every kind of shape by the same offset', () => {
    expect(translate(rect, 10, 5)).toMatchObject({ x: 110, y: 105 })
    expect(translate(arrow, 10, 5)).toMatchObject({ from: { x: 10, y: 5 }, to: { x: 110, y: 105 } })
    expect(translate(pen, 10, 5)).toMatchObject({
      points: [
        { x: 710, y: 305 },
        { x: 810, y: 305 },
      ],
    })
    expect(translate(text, 10, 5)).toMatchObject({ at: { x: 60, y: 405 } })
  })
})

describe('markers and clicks', () => {
  it('numbers the next marker one past the highest placed', () => {
    expect(nextStep([])).toBe(1)
    expect(nextStep([rect, step, { ...step, id: 's2', n: 5 }])).toBe(6)
  })

  it('treats a click with a box or arrow tool as nothing drawn', () => {
    expect(isDegenerate({ ...rect, w: 1, h: 2 }, 4)).toBe(true)
    expect(isDegenerate({ ...rect, w: 1, h: 30 }, 4)).toBe(false)
    expect(isDegenerate({ ...arrow, to: { x: 1, y: 1 } }, 4)).toBe(true)
    expect(isDegenerate(step, 4)).toBe(false)
  })

  it('centres a pasted image and shrinks it to fit within 60% of the base', () => {
    const big: LayerImage = { ...base, id: 'big', width: 2000, height: 1000 }
    expect(placeLayer(big, base)).toMatchObject({ kind: 'image', x: 200, y: 100, w: 600, h: 300 })
    const small: LayerImage = { ...base, id: 'small', width: 100, height: 50 }
    expect(placeLayer(small, base)).toMatchObject({ x: 450, y: 225, w: 100, h: 50 })
  })
})

describe('history', () => {
  const scene: Scene = { base, shapes: [] }
  const withRect: Scene = { base, shapes: [rect] }

  it('undoes and redoes commits', () => {
    const h = commit(initHistory(scene), withRect)
    expect(h.present).toBe(withRect)
    expect(undo(h).present).toBe(scene)
    expect(redo(undo(h)).present).toBe(withRect)
  })

  it('drops the redo branch on a new commit and ignores a no-op commit', () => {
    const h = undo(commit(initHistory(scene), withRect))
    expect(commit(h, { base, shapes: [arrow] }).future).toEqual([])
    expect(commit(h, h.present)).toBe(h)
  })

  it('caps how far back it remembers', () => {
    let h = initHistory(scene)
    for (let i = 0; i < 150; i++) h = commit(h, { base, shapes: [{ ...rect, x: i }] })
    expect(h.past).toHaveLength(100)
  })

  it('replaces or deletes one shape by id', () => {
    expect(withShape(withRect, 'r', { ...rect, color: 'blue' }).shapes[0]).toMatchObject({
      color: 'blue',
    })
    expect(withShape(withRect, 'r', null).shapes).toEqual([])
  })

  it('counts the base and pasted layers it keeps alive', () => {
    const layer: Shape = {
      kind: 'image',
      id: 'i',
      image: { ...base, data: 'LAYERDATA' },
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    }
    expect(sceneBytes({ base, shapes: [rect, layer] })).toBe('BASE'.length + 'LAYERDATA'.length)
  })
})
