// @vitest-environment jsdom
import { describe, expect, it, afterEach, beforeAll } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ModelChip, ModelChipSkeleton, ThinkingChip } from './ModelChip'

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
 * The chip is shared by the session picker and the home picker precisely so
 * these rules cannot diverge again — they did, in both directions, while the
 * markup was copy-pasted between the two.
 */
describe('ModelChip', () => {
  const base = { testId: 'chip', active: false, onClick: () => undefined }

  it('names a provider pi does not ship', () => {
    draw(<ModelChip {...base} name="Claude Opus 5" provider="pi-claude-cli" />)
    expect(find('model-provider')?.textContent).toBe('pi-claude-cli')
  })

  it('stays quiet about a provider pi ships itself', () => {
    draw(<ModelChip {...base} name="Claude Opus 5" provider="anthropic" />)
    expect(find('model-provider')).toBeNull()
  })

  it('says nothing when there is no provider to name', () => {
    draw(<ModelChip {...base} name="No model" />)
    expect(find('model-provider')).toBeNull()
  })

  it('keeps the provider beside the name, never under it', () => {
    draw(<ModelChip {...base} name="Claude Opus 5" provider="pi-claude-cli" />)
    const row = find('model-label')!.parentElement!
    expect(row.className).toContain('flex')
    expect(row.className).toContain('items-baseline')
    // A second line needs the provider to be its own block.
    expect(find('model-provider')!.className).not.toContain('block')
  })

  it('lets the provider give up its width before the name does', () => {
    draw(<ModelChip {...base} name="Claude Opus 5" provider="pi-claude-cli" />)
    expect(find('model-provider')!.className).toContain('shrink-[9999]')
    expect(find('model-label')!.className).toContain('truncate')
  })

  it('carries a warning suffix from its owner without losing the provider', () => {
    draw(
      <ModelChip
        {...base}
        name={<span className="text-warning">gpt-9 · unavailable</span>}
        provider="pi-claude-cli"
      />,
    )
    expect(find('model-label')!.textContent).toBe('gpt-9 · unavailable')
    expect(find('model-provider')).not.toBeNull()
  })

  it('refuses clicks while its list is still loading', () => {
    draw(<ModelChip {...base} disabled loading name={<ModelChipSkeleton />} />)
    const chip = find('chip') as HTMLButtonElement
    expect(chip.disabled).toBe(true)
    expect(chip.dataset.loading).toBe('true')
  })
})

describe('ThinkingChip', () => {
  it('never grows or shrinks with the model name', () => {
    draw(<ThinkingChip testId="think" active={false} onClick={() => undefined} label="Max" />)
    expect(find('think')!.className).toContain('shrink-0')
  })
})
