// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrainTidySuggestionDetail } from '@shared/brain-tidy'
import { createMockBrain } from '../mockBrain'
import { TidyDetail } from './TidyDetail'
import { usePromptStore } from '@/stores/prompt'
import { useSessionsStore } from '@/stores/sessions'
import { openBrainSource } from '../openBrainSource'

vi.mock('../openBrainSource', () => ({ openBrainSource: vi.fn(async () => {}) }))
let root: Root, container: HTMLDivElement
const apply = vi.fn(),
  dismiss = vi.fn(),
  visit = vi.fn()
let data: BrainTidySuggestionDetail
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  apply.mockClear()
  dismiss.mockClear()
  visit.mockClear()
  useSessionsStore.setState({ disk: {} })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function render(index: number, patch?: (value: BrainTidySuggestionDetail) => void) {
  const call = createMockBrain(() => 10000)
  data = (await call('brain:tidySuggestion', [`tidy-${index}`])) as BrainTidySuggestionDetail
  patch?.(data)
  await act(async () =>
    root.render(
      <TidyDetail data={data} busy={false} onApply={apply} onDismiss={dismiss} onVisit={visit} />,
    ),
  )
}
async function click(label: string, index = 0) {
  const button = [...container.querySelectorAll('button')].filter((b) => b.textContent === label)[
    index
  ]
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}
it('compares full entities, defaults to the larger record, swaps and visits Knowledge', async () => {
  await render(0, (d) => {
    if (d.subjects[1]?.type === 'entity') d.subjects[1].value.entity.memories = 8
  })
  expect(container.textContent).toContain('Found on this computer')
  expect(container.textContent).toContain('Harbor migration lead')
  expect(container.textContent).toContain('Source lanes: Harbor planning')
  await click('Merge into Rina')
  expect(apply).toHaveBeenLastCalledWith({ kind: 'merge', survivorId: 'tidy-0-1' })
  await click('Swap surviving record')
  await click('Merge into Rina Okafor')
  expect(apply).toHaveBeenLastCalledWith({ kind: 'merge', survivorId: 'tidy-0-0' })
  await click('Not the same')
  expect(dismiss).toHaveBeenCalledOnce()
  await click('View in Knowledge')
  expect(visit).toHaveBeenCalledWith({ kind: 'entity', id: 'tidy-0-0', label: 'Rina Okafor' })
})
it('warns under the reason when the checked model thinks an open entity pair is different', async () => {
  await render(0, (d) => {
    d.suggestion.source = 'check'
    d.suggestion.model = 'demo/harbor-model'
    d.suggestion.verdict = { kind: 'different', reason: 'Only the name matches.' }
  })
  const header = container.querySelector('header')!
  expect(header.textContent).toContain(
    'Checked by harbor-model, which thinks these are different. Merge only if you know they are the same.',
  )
  expect(header.textContent!.indexOf('These records share a name')).toBeLessThan(
    header.textContent!.indexOf('which thinks these are different'),
  )
  const labels = [...container.querySelectorAll('button')].map((b) => b.textContent)
  expect(labels).toContain('Not the same')
  expect(labels.some((label) => label?.startsWith('Merge into'))).toBe(true)
})
it('shows scope, dates and labelled evidence and folds either memory', async () => {
  await render(1)
  expect(container.textContent).toContain('Project: /demo/Harbor · Branch: All branches')
  expect(container.querySelectorAll('blockquote')).toHaveLength(2)
  expect(container.textContent).toContain('You · Ledger planning')
  await click('Keep this one', 0)
  expect(apply).toHaveBeenLastCalledWith({ kind: 'fold', survivorId: 'tidy-1-0' })
  await click('Keep this one', 1)
  expect(apply).toHaveBeenLastCalledWith({ kind: 'fold', survivorId: 'tidy-1-1' })
})
it('offers both replacements, dispute and dismissal with the checked model name', async () => {
  await render(2)
  expect(container.textContent).toContain('Checked by harbor-model')
  await click('Keep both as disputed')
  expect(apply).toHaveBeenLastCalledWith({ kind: 'dispute' })
  await click('This one replaces that one', 0)
  expect(apply).toHaveBeenLastCalledWith({ kind: 'replace', newerId: 'tidy-2-0' })
  await click('This one replaces that one', 1)
  expect(apply).toHaveBeenLastCalledWith({ kind: 'replace', newerId: 'tidy-2-1' })
  await click('Not the same')
  expect(dismiss).toHaveBeenCalledOnce()
})
it('keeps a flag or confirms permanent Forget, and disables an unknown lane', async () => {
  await render(3)
  const lane = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Open the lane',
  )!
  expect(lane.disabled).toBe(true)
  expect(lane.getAttribute('data-tooltip')).toContain('no longer on this computer')
  await click('Keep')
  expect(apply).toHaveBeenLastCalledWith({ kind: 'keep' })
  await click('Forget')
  const prompt = usePromptStore.getState().requests[0]!
  expect(prompt.message).toContain('cannot be undone')
  expect(apply).toHaveBeenCalledTimes(1)
  await act(async () => usePromptStore.getState().dismiss(prompt, 'forget'))
  expect(apply).toHaveBeenLastCalledWith({ kind: 'forget' })
})
it('opens only a flagging lane resolved from the known sidebar metadata', async () => {
  useSessionsStore.setState({
    disk: {
      '/demo/Harbor': [
        {
          sessionId: 'harbor-lane',
          path: '/demo/Harbor/known.jsonl',
          cwd: '/demo/Harbor',
          createdAt: '2026-11-06',
          firstUserText: 'Harbor planning',
          userMessages: 1,
          assistantMessages: 0,
          toolCalls: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
          headroomSavedTokens: 0,
          entryCount: 1,
          branchCount: 0,
          mtimeMs: 1,
          lastActivityAt: '2026-11-06',
        },
      ],
    },
  })
  await render(3)
  await click('Open the lane')
  expect(openBrainSource).toHaveBeenCalledWith('/demo/Harbor/known.jsonl')
})

it('uses allowed actions rather than the Said twice label for dispute and replacement', async () => {
  await render(1)
  await click('Keep both as disputed')
  expect(apply).toHaveBeenLastCalledWith({ kind: 'dispute' })
  await click('This one replaces that one', 1)
  expect(apply).toHaveBeenLastCalledWith({ kind: 'replace', newerId: 'tidy-1-1' })
})
it.each([
  [
    'applicability',
    'These apply to different projects or branches, so they cannot be folded into one.',
  ],
  [
    'history',
    'One of these already replaced or disputes another memory, so they cannot be folded into one.',
  ],
] as const)(
  'shows the engine fold refusal %s, not an inferred reason',
  async (foldRefusal, text) => {
    await render(1, (d) => {
      d.allowed = ['dispute', 'replace']
      d.foldRefusal = foldRefusal
    })
    expect(container.textContent).not.toContain('Keep this one')
    expect(container.textContent).toContain(text)
    await click('Keep both as disputed')
    expect(apply).toHaveBeenLastCalledWith({ kind: 'dispute' })
    await click('Not the same')
    expect(dismiss).toHaveBeenCalledOnce()
  },
)
it('does not invent a refusal reason and suppresses unoffered actions', async () => {
  await render(2, (d) => {
    d.allowed = ['replace']
    d.foldRefusal = null
  })
  expect(container.textContent).not.toContain('cannot be folded')
  expect(container.textContent).not.toContain('Keep both as disputed')
  expect(container.textContent).not.toContain('Keep this one')
})
it('offers no mutation buttons for a settled or missing-subject comparison', async () => {
  await render(0, (d) => {
    d.suggestion.state = 'applied'
    d.allowed = []
    d.subjects = []
  })
  expect(container.querySelector('button')).toBeNull()
})

it('labels an unknown flag title as unverified plain text', async () => {
  await render(3, (d) => {
    d.suggestion.flag!.title = '<b>Kestrel review</b>'
  })
  expect(container.textContent).toContain(
    'A lane calling itself <b>Kestrel review</b> says this is outdated.',
  )
  expect(container.querySelector('b')).toBeNull()
})

it('uses the known lane name instead of the caller-supplied flag title', async () => {
  useSessionsStore.setState({
    disk: {
      '/demo/Harbor': [
        {
          sessionId: 'harbor-lane',
          path: '/demo/Harbor/known.jsonl',
          cwd: '/demo/Harbor',
          name: 'Harbor verified title',
          firstUserText: 'Harbor planning',
          createdAt: '2026-11-06',
          userMessages: 1,
          assistantMessages: 0,
          toolCalls: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
          headroomSavedTokens: 0,
          entryCount: 1,
          branchCount: 0,
          mtimeMs: 1,
          lastActivityAt: '2026-11-06',
        },
      ],
    },
  })
  await render(3, (d) => {
    d.suggestion.flag!.title = 'Untrusted Kestrel title'
  })
  expect(container.textContent).toContain('Harbor verified title says this is outdated.')
  expect(container.textContent).not.toContain('Untrusted Kestrel title')
  expect(container.textContent).not.toContain('A lane calling itself')
})

it('offers only Forget and Keep on a flag, which has no pair to call different', async () => {
  await render(3)
  const labels = [...container.querySelectorAll('button')].map((b) => b.textContent)
  expect(labels).toContain('Forget')
  expect(labels).toContain('Keep')
  expect(labels).not.toContain('Not the same')
})
it.each([
  ['wrong', 'says this is wrong.'],
  ['duplicate', 'says this is a duplicate.'],
] as const)('says a %s flag in a sentence', async (problem, sentence) => {
  await render(3, (d) => {
    d.suggestion.flag!.problem = problem
  })
  expect(container.textContent).toContain(`A lane calling itself Harbor planning ${sentence}`)
})
it('counts one memory of an entity in the singular', async () => {
  await render(0, (d) => {
    if (d.subjects[0]?.type === 'entity') d.subjects[0].value.entity.memories = 1
  })
  expect(container.textContent).toContain('· 1 memory')
  expect(container.textContent).not.toContain('· 1 memories')
})
