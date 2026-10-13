// @vitest-environment jsdom
import { describe, expect, it, afterEach, beforeAll } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ModelChip, ModelChipSkeleton, ThinkingChip, namedProvider } from './ModelChip'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let host: HTMLDivElement | null = null
let root: Root | null = null

function draw(node: React.ReactNode): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(node))
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

const find = (testId: string): HTMLElement | null =>
  host!.querySelector(`[data-testid="${testId}"]`)

/**
 * The rule that only a provider pi does not ship gets named. It feeds the
 * session composer's status strip; the chip itself never shows a provider.
 */
describe('namedProvider', () => {
  it('names a provider pi does not ship', () => {
    expect(namedProvider('pi-claude-cli')).toBe('pi-claude-cli')
  })

  it('stays quiet about a provider pi ships itself', () => {
    expect(namedProvider('anthropic')).toBeUndefined()
  })

  it('says nothing when there is no provider to name', () => {
    expect(namedProvider(undefined)).toBeUndefined()
  })
})

/**
 * The chip is shared by the session picker and the home picker precisely so
 * these rules cannot diverge again — they did, in both directions, while the
 * markup was copy-pasted between the two.
 */
describe('ModelChip', () => {
  const base = { testId: 'chip', active: false, onClick: () => undefined }

  it('keeps the name on one truncating line and shows no provider', () => {
    draw(<ModelChip {...base} name="Claude Opus 5" />)
    expect(find('model-label')!.className).toContain('truncate')
    expect(find('model-label')!.textContent).toBe('Claude Opus 5')
    expect(find('model-provider')).toBeNull()
  })

  it('carries a warning suffix from its owner', () => {
    draw(<ModelChip {...base} name={<span className="text-warning">gpt-9 · unavailable</span>} />)
    expect(find('model-label')!.textContent).toBe('gpt-9 · unavailable')
  })

  it('rounds only its outer corners as the left half of the split chip', () => {
    draw(<ModelChip {...base} name="Claude Opus 5" grouped />)
    expect(find('chip')!.className).toContain('rounded-l-md')
    expect(find('chip')!.className).not.toMatch(/\brounded-md\b/)
    draw(<ModelChip {...base} name="Claude Opus 5" />)
    expect(find('chip')!.className).toMatch(/\brounded-md\b/)
  })

  it('refuses clicks while its list is still loading', () => {
    draw(<ModelChip {...base} disabled loading name={<ModelChipSkeleton />} />)
    const chip = find('chip') as HTMLButtonElement
    expect(chip.disabled).toBe(true)
    expect(chip.dataset.loading).toBe('true')
  })
})

describe('ThinkingChip', () => {
  it('never grows or shrinks with the model name, and carries a caret', () => {
    draw(<ThinkingChip testId="think" active={false} onClick={() => undefined} label="Max" />)
    expect(find('think')!.className).toContain('shrink-0')
    expect(find('think')!.className).toContain('rounded-r-md')
    expect(find('think')!.querySelector('svg')).not.toBeNull()
  })
})
