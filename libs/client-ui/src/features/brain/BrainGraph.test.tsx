// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrainGraph } from './BrainGraph'
import { mockBrainData } from './mockBrainData'

let root: Root
let container: HTMLDivElement
let svg: SVGSVGElement
const focus = vi.fn()
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  root = createRoot(container)
  focus.mockReset()
  const { entities, details } = mockBrainData()
  await act(async () =>
    root.render(
      <BrainGraph
        entities={entities}
        memories={details.map((d) => d.memory)}
        focus={null}
        onFocus={focus}
      />,
    ),
  )
  svg = container.querySelector('svg')!
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: 800,
    height: 400,
    bottom: 400,
    right: 800,
    toJSON: () => ({}),
  })
})
afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const stage = (): string => svg.querySelector('g')!.getAttribute('transform')!
function pointer(target: Element, type: string, x: number, y: number): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }))
  })
}
async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === label || b.textContent === label,
  )!
  await act(async () => button.click())
}

it('renders nodes, relationship edges and a kind legend; click and keyboard focus nodes', () => {
  expect(svg.querySelectorAll('[data-node]')).toHaveLength(3)
  expect(svg.querySelectorAll('line')).toHaveLength(2)
  expect(container.querySelector('[aria-label="Entity kinds"]')?.textContent).toContain('person')
  const node = svg.querySelector('[data-node=harbor]')!
  pointer(node, 'pointerdown', 100, 100)
  pointer(svg, 'pointerup', 100, 100)
  expect(focus).toHaveBeenCalledWith('harbor')
  act(() => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  expect(focus).toHaveBeenCalledTimes(2)
})

it('drags nodes without focusing them and pans only from the background', () => {
  const node = svg.querySelector('[data-node=harbor]')!
  const position = node.getAttribute('transform')
  const view = stage()
  pointer(node, 'pointerdown', 200, 100)
  pointer(svg, 'pointermove', 350, 140)
  pointer(svg, 'pointerup', 350, 140)
  expect(node.getAttribute('transform')).not.toBe(position)
  expect(stage()).toBe(view)
  expect(focus).not.toHaveBeenCalled()
  pointer(svg, 'pointerdown', 100, 100)
  pointer(svg, 'pointermove', 180, 150)
  pointer(svg, 'pointerup', 180, 150)
  expect(stage()).not.toBe(view)
})

it('zooms with controls and modifier-wheel, ignores ordinary scroll, and fits', async () => {
  const original = stage()
  await click('Zoom in')
  expect(stage()).not.toBe(original)
  await click('Fit')
  expect(stage()).toBe(original)
  const ordinary = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 })
  act(() => {
    svg.dispatchEvent(ordinary)
  })
  expect(stage()).toBe(original)
  expect(ordinary.defaultPrevented).toBe(false)
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -100,
      clientX: 200,
      clientY: 100,
      [modifier]: true,
    })
    act(() => {
      svg.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(stage()).not.toBe(original)
    await click('Fit')
  }
  await click('Zoom out')
  expect(stage()).not.toBe(original)
})

it('highlights neighbours on hover and restores all nodes on leave', () => {
  const postgres = svg.querySelector('[data-node=postgres]')!
  const rina = svg.querySelector('[data-node=rina]')!
  const harbor = svg.querySelector('[data-node=harbor]')!
  act(() => {
    postgres.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  expect(rina.getAttribute('opacity')).toBe('0.25')
  expect(harbor.getAttribute('opacity')).toBe('1')
  act(() => {
    postgres.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
  })
  expect(rina.getAttribute('opacity')).toBe('1')
})

it('shows the predicate of each connected edge on hover', () => {
  act(() => {
    svg
      .querySelector('[data-node=harbor]')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  expect([...svg.querySelectorAll('text')].map((text) => text.textContent)).toContain('uses')
  expect([...svg.querySelectorAll('text')].map((text) => text.textContent)).toContain('owns')
})

it('uses circles and capped right-hand labels with full titles, focus rings and Space activation', async () => {
  const { entities } = mockBrainData()
  const label = 'Harbor billing service with a deliberately long entity name'
  await act(async () =>
    root.render(
      <BrainGraph
        entities={[{ ...entities[0]!, label }]}
        memories={[]}
        focus="harbor"
        onFocus={focus}
      />,
    ),
  )
  const node = svg.querySelector('[data-node=harbor]')!
  expect(node.querySelector('rect')).toBeNull()
  expect(node.querySelectorAll('circle')).toHaveLength(2)
  expect(node.querySelector('title')?.textContent).toBe(label)
  expect(node.querySelector('text')?.textContent).toBe(`${label.slice(0, 31)}…`)
  expect(node.querySelector('text')?.getAttribute('x')).toBe('10')
  expect(node.getAttribute('aria-pressed')).toBe('true')
  act(() => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  })
  expect(focus).toHaveBeenCalledWith('harbor')
})

it('measures its pane and disconnects the resize observer on unmount', () => {
  act(() => root.unmount())
  let resize!: () => void
  const disconnect = vi.fn()
  const observe = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe = observe
      disconnect = disconnect
    },
  )
  root = createRoot(container)
  const { entities, details } = mockBrainData()
  act(() =>
    root.render(
      <BrainGraph
        entities={entities}
        memories={details.map((d) => d.memory)}
        focus={null}
        onFocus={focus}
      />,
    ),
  )
  svg = container.querySelector('svg')!
  vi.spyOn(svg.parentElement!, 'getBoundingClientRect').mockReturnValue({
    x: 10,
    y: 10,
    left: 10,
    top: 10,
    width: 450,
    height: 900,
    bottom: 910,
    right: 460,
    toJSON: () => ({}),
  })
  act(resize)
  expect(svg.getAttribute('viewBox')).toBe('0 0 450 900')
  expect(observe).toHaveBeenCalledWith(svg.parentElement)
  act(() => root.unmount())
  expect(disconnect).toHaveBeenCalledOnce()
})

it('pans an externally focused node to the measured centre in 300ms and stops', () => {
  act(() => root.unmount())
  const frames = new Map<number, FrameRequestCallback>()
  let serial = 0
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++serial, callback)
      return serial
    }),
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => frames.delete(id)),
  )
  const flush = (time: number): void => {
    const callbacks = [...frames.values()]
    frames.clear()
    act(() => callbacks.forEach((callback) => callback(time)))
  }
  root = createRoot(container)
  const { entities, details } = mockBrainData()
  const memories = details.map((d) => d.memory)
  act(() =>
    root.render(
      <BrainGraph entities={entities} memories={memories} focus={null} onFocus={focus} />,
    ),
  )
  svg = container.querySelector('svg')!
  for (let i = 0; i < 301; i++) flush(i * 16)
  const original = stage()
  act(() =>
    root.render(
      <BrainGraph entities={entities} memories={memories} focus="harbor" onFocus={focus} />,
    ),
  )
  expect(frames.size).toBe(1)
  flush(5000)
  expect(stage()).toBe(original)
  flush(5150)
  expect(stage()).not.toBe(original)
  flush(5300)
  expect(frames.size).toBe(0)
  const view = stage()
    .match(/-?[\d.]+/g)!
    .map(Number)
  const position = svg
    .querySelector('[data-node=harbor]')!
    .getAttribute('transform')!
    .match(/-?[\d.]+/g)!
    .map(Number)
  expect(position[0]! * view[2]! + view[0]!).toBeCloseTo(400)
  expect(position[1]! * view[2]! + view[1]!).toBeCloseTo(200)
})

it('centres external focus with no animation frames under reduced motion', () => {
  act(() => root.unmount())
  const raf = vi.fn()
  vi.stubGlobal('requestAnimationFrame', raf)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  root = createRoot(container)
  const { entities, details } = mockBrainData()
  const memories = details.map((d) => d.memory)
  act(() =>
    root.render(
      <BrainGraph entities={entities} memories={memories} focus={null} onFocus={focus} />,
    ),
  )
  svg = container.querySelector('svg')!
  const original = stage()
  act(() =>
    root.render(
      <BrainGraph entities={entities} memories={memories} focus="rina" onFocus={focus} />,
    ),
  )
  expect(stage()).not.toBe(original)
  expect(raf).not.toHaveBeenCalled()
})

it('keeps the fitted scale when a deferred reduced-motion layout arrives with a focus', () => {
  act(() => root.unmount())
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  root = createRoot(container)
  const template = mockBrainData().entities[0]!
  const entities = Array.from({ length: 400 }, (_, i) => ({
    ...template,
    id: `harbor-${i}`,
    label: `Harbor billing ${i}`,
  }))
  act(() =>
    root.render(<BrainGraph entities={entities} memories={[]} focus="harbor-7" onFocus={focus} />),
  )
  for (let count = 0; frames.length && count < 400; count++)
    act(() => frames.splice(0).forEach((callback) => callback(count * 16)))
  svg = container.querySelector('svg')!
  const [x, y, scale] = stage()
    .match(/-?[\d.]+/g)!
    .map(Number)
  expect(scale).toBeLessThan(1)
  const [nodeX, nodeY] = svg
    .querySelector('[data-node=harbor-7]')!
    .getAttribute('transform')!
    .match(/-?[\d.]+/g)!
    .map(Number)
  expect(nodeX! * scale! + x!).toBeCloseTo(400)
  expect(nodeY! * scale! + y!).toBeCloseTo(200)
})
