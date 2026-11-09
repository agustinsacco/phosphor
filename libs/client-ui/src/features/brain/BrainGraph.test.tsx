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
    svg.querySelector('[data-node=harbor]')!.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true }),
    )
  })
  expect([...svg.querySelectorAll('text')].map((text) => text.textContent)).toContain('uses')
  expect([...svg.querySelectorAll('text')].map((text) => text.textContent)).toContain('owns')
})
