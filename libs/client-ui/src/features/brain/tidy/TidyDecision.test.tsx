// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrainStatus } from '@shared/brain'
import type { BrainTidyAction, BrainTidyPage, BrainTidySuggestionDetail } from '@shared/brain-tidy'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { usePromptStore } from '@/stores/prompt'
import { useSessionsStore } from '@/stores/sessions'
import { createMockBrain } from '../mockBrain'
import { useBrain } from '../useBrain'
import type { DecisionKeys } from '../inbox/DecisionFrame'
import { TidyDecision } from './TidyDecision'

let root: Root, container: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>, restore: () => void
let call: ReturnType<typeof createMockBrain>
let patch: ((value: BrainTidySuggestionDetail) => void) | undefined
const keys: { current: DecisionKeys } = { current: {} }
const apply = vi.fn<(id: string, action: BrainTidyAction, revision: number) => Promise<unknown>>()
const dismiss = vi.fn<(id: string, revision: number) => Promise<unknown>>()
const visit = vi.fn()
const reload = vi.fn(async (): Promise<BrainTidyPage | null> => null)

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  call = createMockBrain(() => 10000)
  patch = undefined
  apply.mockReset().mockImplementation((...args) => call('brain:tidyApply', args))
  dismiss.mockReset().mockImplementation((...args) => call('brain:tidyDismiss', args))
  visit.mockClear()
  reload.mockClear()
  fake = createFakePhosphor({
    'brain:tidySuggestion': async (id) => {
      const value = (await call('brain:tidySuggestion', [id])) as BrainTidySuggestionDetail
      patch?.(value)
      return value
    },
    'brain:tidyApply': apply as never,
    'brain:tidyDismiss': dismiss as never,
    'brain:status': () => call('brain:status', []) as Promise<BrainStatus>,
  })
  restore = installFakePhosphor(fake)
  useBrain.setState({
    status: (await call('brain:status', [])) as BrainStatus,
    error: '',
    saving: false,
  })
  useSessionsStore.setState({ disk: {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore()
  fake.dispose()
  vi.unstubAllGlobals()
})

async function render(index: number): Promise<void> {
  const page = (await call('brain:tidy', [null, null, 20])) as BrainTidyPage
  const suggestion = page.items.find((item) => item.id === `tidy-${index}`)!
  await act(async () =>
    root.render(
      <TidyDecision
        suggestion={suggestion}
        page={page}
        reload={reload}
        keys={keys}
        onContext={() => {}}
        onVisit={visit}
      />,
    ),
  )
}
/** A new Brain and a new mount, for a second action on the same suggestion. */
function fresh(): void {
  call = createMockBrain(() => 10000)
  act(() => root.unmount())
  root = createRoot(container)
}
const labels = (): (string | null)[] =>
  [...container.querySelectorAll('button')].map((b) => b.textContent)
async function click(label: string, index = 0): Promise<void> {
  const button = [...container.querySelectorAll('button')].filter((b) => b.textContent === label)[
    index
  ]
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}
const bar = (): Element => container.querySelector('[aria-label="Decision actions"]')!

it('merges two records into the larger one or keeps the other, and visits Knowledge', async () => {
  patch = (d) => {
    if (d.subjects[1]?.type === 'entity') d.subjects[1].value.entity.memories = 8
  }
  await render(0)
  expect(container.textContent).toContain('Found on this computer.')
  expect(container.textContent).toContain('Source lanes: Harbor planning')
  await click('Merge into Rina')
  expect(apply).toHaveBeenLastCalledWith('tidy-0', { kind: 'merge', survivorId: 'tidy-0-1' }, 0)
  fresh()
  await render(0)
  await click('Keep Rina Okafor instead')
  expect(apply.mock.lastCall?.[1]).toEqual({ kind: 'merge', survivorId: 'tidy-0-0' })
  await click('View in Knowledge')
  expect(visit).toHaveBeenCalledWith({ kind: 'entity', id: 'tidy-0-0', label: 'Rina Okafor' })
})

it('dismisses a pair the owner says is not the same', async () => {
  await render(0)
  await click('Not the same')
  expect(dismiss).toHaveBeenCalledWith('tidy-0', 0)
})

it('gives the model an opinion line under the reason, never a decision', async () => {
  patch = (d) => {
    d.suggestion.source = 'check'
    d.suggestion.model = 'demo/harbor-model'
    d.suggestion.verdict = { kind: 'different', reason: 'Only the name matches.' }
  }
  await render(0)
  const header = container.querySelector('article header + div header')!
  expect(header.textContent).toContain(
    'Checked by harbor-model, which thinks these are different. Merge only if you know they are the same.',
  )
  expect(labels()).toContain('Not the same')
  expect(labels().some((label) => label?.startsWith('Merge into'))).toBe(true)
})

it('shows scope, dates and evidence, and folds either memory', async () => {
  await render(1)
  expect(container.textContent).toContain('Project: /demo/Harbor · Branch: All branches')
  expect(container.querySelectorAll('blockquote')).toHaveLength(2)
  await click('Keep this one', 1)
  expect(apply.mock.lastCall?.[1]).toEqual({ kind: 'fold', survivorId: 'tidy-1-1' })
})

it('offers both replacements and dispute on a disagreement', async () => {
  await render(2)
  expect(container.textContent).toContain('Checked by harbor-model')
  await click('This one replaces that one', 0)
  expect(apply.mock.lastCall?.[1]).toEqual({ kind: 'replace', newerId: 'tidy-2-0' })
  fresh()
  await render(2)
  await click('Keep both as disputed')
  expect(apply.mock.lastCall?.[1]).toEqual({ kind: 'dispute' })
})

it('keeps a flag or forgets it only after a confirmation, with no pair to call different', async () => {
  await render(3)
  expect(labels()).not.toContain('Not the same')
  const lane = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Open the lane',
  )!
  expect(lane.disabled).toBe(true)
  await click('Forget')
  const prompt = usePromptStore.getState().requests[0]!
  expect(prompt.message).toContain('cannot be undone')
  expect(apply).not.toHaveBeenCalled()
  await act(async () => usePromptStore.getState().dismiss(prompt, 'forget'))
  expect(apply.mock.lastCall?.[1]).toEqual({ kind: 'forget' })
})

it('labels an unknown flag title as an unverified claim', async () => {
  patch = (d) => {
    d.suggestion.flag!.title = '<b>Kestrel review</b>'
  }
  await render(3)
  expect(container.textContent).toContain(
    'A lane calling itself <b>Kestrel review</b> says this is outdated.',
  )
  expect(container.querySelector('b')).toBeNull()
})

it('shows the engine fold refusal, not an inferred reason', async () => {
  patch = (d) => {
    d.allowed = ['dispute', 'replace']
    d.foldRefusal = 'applicability'
  }
  await render(1)
  expect(labels()).not.toContain('Keep this one')
  expect(container.textContent).toContain(
    'These apply to different projects or branches, so they cannot be folded into one.',
  )
})

it('shows a refused action as a sentence in the action bar', async () => {
  apply.mockImplementationOnce(async () => {
    throw new Error('Those memories already disagree with each other.')
  })
  await render(2)
  await click('Keep both as disputed')
  expect(bar().querySelector('[role="alert"]')?.textContent).toBe(
    'Those memories already disagree with each other.',
  )
  expect(labels()).toContain('Keep both as disputed')
})

it('says when the suggestion was settled elsewhere and reloads the queue', async () => {
  patch = (d) => {
    d.suggestion.state = 'applied'
    d.allowed = []
  }
  await render(0)
  expect(container.textContent).toContain('This suggestion was already settled.')
  expect(reload).toHaveBeenCalled()
  expect(bar()).toBeNull()
})

it('recovers a failed first detail load with Retry', async () => {
  const read = fake.api.invoke
  let failed = false
  vi.spyOn(fake.api, 'invoke').mockImplementation(((channel: string, ...args: unknown[]) => {
    if (channel === 'brain:tidySuggestion' && !failed) {
      failed = true
      return Promise.reject(new Error('Suggestion unavailable'))
    }
    return (read as (c: string, ...a: unknown[]) => Promise<unknown>)(channel, ...args)
  }) as typeof read)
  await render(0)
  expect(container.textContent).toContain('Suggestion unavailable')
  await click('Retry')
  expect(labels()).toContain('Not the same')
})

it('takes the primary action from the a key the Inbox forwards', async () => {
  await render(2)
  await act(async () => keys.current.primary?.())
  expect(apply.mock.lastCall?.[1]).toEqual({ kind: 'dispute' })
})

it('offers to take a shared name off one record, never a label, once Brain allows it', async () => {
  const names = (a: string[], b: string[]) => (d: BrainTidySuggestionDetail) => {
    const [left, right] = d.subjects
    if (left?.type === 'entity') left.value.entity.aliases = a
    if (right?.type === 'entity') right.value.entity.aliases = b
  }
  patch = names(['Rina'], [])
  await render(0)
  expect(labels().filter((label) => label?.startsWith('Not the same;'))).toEqual([])
  fresh()
  patch = (d) => {
    names(['Rina'], [])(d)
    d.allowed = [...d.allowed, 'unname']
  }
  apply.mockImplementationOnce(async () => ({
    ...((await call('brain:status', [])) as BrainStatus),
    operationId: 'op-1',
  }))
  await render(0)
  // "Rina" is B's own name, so it comes off A, where it is only another name.
  await click('Not the same; remove “Rina” from Rina Okafor')
  expect(apply).toHaveBeenLastCalledWith(
    'tidy-0',
    { kind: 'unname', entityId: 'tidy-0-0', name: 'Rina' },
    0,
  )
  fresh()
  patch = (d) => {
    names(['Rina'], ['Rina Okafor'])(d)
    d.allowed = [...d.allowed, 'unname']
  }
  await render(0)
  expect(labels()).toContain('Not the same; remove “Rina Okafor” from Rina')
})
