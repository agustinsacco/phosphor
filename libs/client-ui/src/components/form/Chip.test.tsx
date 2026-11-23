// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clsx } from 'clsx'
import { CHIP, CHIP_MARK, Chip } from '.'

/** The shape the top bar's workspace, branch, machine and pull-request chips share. */
const SHAPE = ['inline-flex', 'min-w-0', 'items-center', 'gap-1.5', 'rounded-md', 'px-2', 'py-0.5']

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const render = (node: React.ReactNode): void => act(() => root.render(node))
const only = (): HTMLElement => container.firstElementChild as HTMLElement

describe('Chip', () => {
  it('owns the shape the header’s chips share', () => {
    for (const name of SHAPE.concat('text-sm')) expect(CHIP.split(' ')).toContain(name)
    // The ground is the caller’s, and the pointer cursor is `index.css`’s.
    expect(CHIP).not.toContain('bg-')
    expect(CHIP).not.toContain('cursor-pointer')
  })

  it('draws the shared shape and keeps the label', () => {
    render(<Chip data-testid="c">This Mac</Chip>)
    expect(only().textContent).toBe('This Mac')
    expect(only().tagName).toBe('SPAN')
    for (const name of SHAPE) expect(only().classList).toContain(name)
  })

  it('carries no ground of its own, so each chip keeps its own theme', () => {
    render(<Chip>plain</Chip>)
    expect([...only().classList].sort()).toEqual(CHIP.split(' ').sort())
  })

  it('keeps a caller’s colours beside the shape', () => {
    render(<Chip className="border-success/30 bg-success/10 text-success">#745</Chip>)
    for (const name of SHAPE.concat('bg-success/10', 'text-success', 'border-success/30'))
      expect(only().classList).toContain(name)
  })

  it('passes through the attributes a header chip is found by', () => {
    render(
      <Chip data-testid="lane-location" data-tone="ready">
        repo
      </Chip>,
    )
    expect(only().getAttribute('data-testid')).toBe('lane-location')
    expect(only().getAttribute('data-tone')).toBe('ready')
  })
})

describe('CHIP_MARK', () => {
  it('is the smaller mark a chip nests, in the tone the caller gives it', () => {
    render(<span className={clsx('bg-accent-soft text-accent', CHIP_MARK)}>wt</span>)
    for (const name of ['rounded', 'px-1', 'text-2xs', 'font-medium', 'bg-accent-soft'])
      expect(only().classList).toContain(name)
  })
})
