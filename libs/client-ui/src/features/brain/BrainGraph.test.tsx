// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { BrainGraph, MAX_BRAIN_EDGES, MAX_BRAIN_NODES } from './BrainGraph'
import { brainFixture } from './__fixtures__/brain'

it('bounds SVG and list, reports truncation, and pauses while hidden', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    configurable: true,
  })
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  const fixture = brainFixture().snapshot
  const nodes = Array.from({ length: 100 }, (_, i) => ({
    ...fixture.entities[0]!,
    id: `entity-${i}`,
  }))
  const edges = Array.from({ length: 200 }, (_, i) => ({
    ...fixture.claims[0]!,
    id: `claim-${i}`,
    subjectId: 'entity-0',
    objectId: 'entity-1',
  }))
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(<BrainGraph graph={{ nodes, edges, truncated: false }} onEntity={vi.fn()} />),
    )
    expect(container.querySelectorAll('circle')).toHaveLength(MAX_BRAIN_NODES)
    expect(container.querySelectorAll('line')).toHaveLength(MAX_BRAIN_EDGES)
    expect(container.querySelectorAll('ul button')).toHaveLength(MAX_BRAIN_NODES)
    expect(container.textContent).toContain('Truncated graph')
    expect(container.querySelector('svg')?.dataset.paused).toBe('false')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(container.querySelector('svg')?.dataset.paused).toBe('true')
    expect(container.textContent).toContain('Adjacency is not causation')
  } finally {
    await act(async () => root.unmount())
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    vi.unstubAllGlobals()
  }
})
