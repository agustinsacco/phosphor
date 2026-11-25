// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_BRAIN_PREFS, type BrainEntityView, type BrainStatus } from '@shared/brain'
import { useExtensionUiStore } from '@/stores/extensionUi'
import {
  createFakePhosphor,
  installFakePhosphor,
  type FakePhosphorHandlers,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { createMockBrain } from '../mockBrain'
import { useBrain } from '../useBrain'
import { EntityEditDialog, profileMenu, type EntityEdit } from './EntityEdits'

const CHANNELS = [
  'brain:status',
  'brain:entity',
  'brain:entityMemories',
  'brain:describe',
  'brain:removeName',
  'brain:split',
] as const
let root: Root, container: HTMLDivElement
let mock: ReturnType<typeof createMockBrain>
let fake: ReturnType<typeof createFakePhosphor>, restore: () => void
const sent = vi.fn<(channel: string, args: unknown[]) => void>()
const onClose = vi.fn()
/** The next edit is refused with this sentence, as the main process would. */
let refusal = ''

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mock = createMockBrain(() => 10_000)
  await mock('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  refusal = ''
  sent.mockReset()
  onClose.mockReset()
  const handlers = Object.fromEntries(
    CHANNELS.map((channel) => [
      channel,
      async (...args: unknown[]) => {
        sent(channel, args)
        if (refusal && !['brain:status', 'brain:entity', 'brain:entityMemories'].includes(channel))
          throw new Error(refusal)
        return mock(channel, args)
      },
    ]),
  ) as FakePhosphorHandlers
  fake = createFakePhosphor(handlers)
  restore = installFakePhosphor(fake)
  useBrain.setState({
    status: (await mock('brain:status', [])) as BrainStatus,
    error: '',
    saving: false,
  })
  useExtensionUiStore.setState({ toasts: [] })
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

const entity = async (id: string) => (await mock('brain:entity', [id])) as BrainEntityView
async function open(edit: EntityEdit, id: string): Promise<void> {
  const view = await entity(id)
  await act(async () => root.render(<EntityEditDialog edit={edit} view={view} onClose={onClose} />))
}
const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[role="dialog"]')!
function button(text: string): HTMLButtonElement | undefined {
  return [...dialog().querySelectorAll('button')].find((b) => b.textContent === text)
}
async function click(text: string): Promise<void> {
  const target = button(text)
  expect(target, text).toBeDefined()
  await act(async () => target!.click())
}
async function type(label: string, value: string): Promise<void> {
  const input = dialog().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const lastToast = () => useExtensionUiStore.getState().toasts.at(-1)

it('describes in one field of at most 160 characters, sends the revision and toasts Undo', async () => {
  await open('describe', 'harbor')
  expect(dialog().getAttribute('aria-label')).toBe('Describe Harbor')
  const field = dialog().querySelector<HTMLInputElement>('input[aria-label="Description"]')!
  expect(field.maxLength).toBe(160)
  expect(button('Save')!.disabled).toBe(true)
  await type('Description', '  Harbor runs the docks.  ')
  expect(dialog().textContent).toContain('26 / 160')
  await click('Save')
  expect(sent).toHaveBeenCalledWith('brain:describe', ['harbor', 'Harbor runs the docks.', 0])
  expect((await entity('harbor')).entity.description).toBe('Harbor runs the docks.')
  expect(lastToast()).toMatchObject({
    message: 'Changed the description of Harbor',
    openLabel: 'Undo',
  })
  expect(onClose).toHaveBeenCalledOnce()
})

it('removes one of the other names, never the label, and shows a refusal in place', async () => {
  await open('removeName', 'harbor')
  const names = [...dialog().querySelectorAll('[aria-label="Other names"] li')]
  expect(names.map((li) => li.firstChild?.textContent)).toEqual(['Harbor customer'])
  expect(button('Remove “Harbor”')).toBeUndefined()
  refusal = 'That name already belongs to Ledger.'
  await click('Remove “Harbor customer”')
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
    'That name already belongs to Ledger.',
  )
  expect(onClose).not.toHaveBeenCalled()
  refusal = ''
  await click('Remove “Harbor customer”')
  expect(sent).toHaveBeenCalledWith('brain:removeName', ['harbor', 'Harbor customer', 0])
  expect((await entity('harbor')).entity.aliases).toEqual([])
  expect(lastToast()?.openLabel).toBe('Undo')
  expect(onClose).toHaveBeenCalledOnce()
})

it('splits the ticked memories into a new record with its own name and kind', async () => {
  await open('split', 'harbor')
  const boxes = () => [
    ...dialog().querySelectorAll<HTMLInputElement>(
      '[aria-label="Memories to split off"] input[type="checkbox"]',
    ),
  ]
  expect(boxes().length).toBeGreaterThan(1)
  expect(button('Split off')!.disabled).toBe(true)
  await act(async () => boxes()[0]!.click())
  expect(button('Split off 1 memory')!.disabled).toBe(true)
  // The engine takes 1 to 80 characters for the new name.
  expect(dialog().querySelector<HTMLInputElement>('[aria-label="New name"]')!.maxLength).toBe(80)
  await type('New name', 'Harbor docks')
  const kind = dialog().querySelector<HTMLSelectElement>('select[aria-label="Kind"]')!
  await act(async () => {
    kind.value = 'component'
    kind.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click('Split off 1 memory')
  const [, args] = sent.mock.calls.find(([channel]) => channel === 'brain:split')!
  expect(args).toMatchObject([
    'harbor',
    [expect.any(String)],
    { label: 'Harbor docks', kind: 'component' },
    0,
  ])
  const found = (await mock('brain:find', ['Harbor docks', 5])) as {
    entities: { label: string; kind: string }[]
  }
  expect(found.entities[0]).toMatchObject({ label: 'Harbor docks', kind: 'component' })
  expect(lastToast()).toMatchObject({
    message: 'Split Harbor docks from Harbor',
    openLabel: 'Undo',
  })
})

it('says why a split of every memory is refused, and stays open', async () => {
  await open('split', 'rina')
  for (const box of dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    await act(async () => box.click())
  await type('New name', 'Rina from finance')
  await click('Split off 5 memories')
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
    'Splitting off every memory is a rename; keep at least one.',
  )
  expect(onClose).not.toHaveBeenCalled()
})

it('offers Remove a name only when there is another name', async () => {
  const edit = vi.fn()
  const items = (view: BrainEntityView) => profileMenu(view, edit, () => {})
  expect(items(await entity('harbor')).map((item) => [item.label, !!item.disabled])).toEqual([
    ['Split…', false],
    ['Remove a name…', false],
    ['Edit description…', false],
    ['Show in the whole graph', false],
  ])
  expect(items(await entity('rina')).find((item) => item.label === 'Remove a name…')).toMatchObject(
    { disabled: true, hint: 'no other names' },
  )
})
