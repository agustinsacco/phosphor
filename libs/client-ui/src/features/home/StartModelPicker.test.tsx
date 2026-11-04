// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StartModelPicker, type StartModelSource } from './StartModelPicker'

let root: Root
let el: HTMLDivElement

function source(overrides: Partial<StartModelSource>): StartModelSource {
  return {
    testIdPrefix: 'home',
    models: [{ id: 'one', name: 'Model One', provider: 'p', reasoning: true }],
    current: { provider: 'p', id: 'one' },
    chip: { text: 'Model One', tone: 'normal', title: 'Model One' },
    loading: false,
    levels: ['off', 'high'],
    thinking: 'high',
    choose: vi.fn(),
    setThinking: vi.fn(),
    menu: { emptyText: 'none' },
    actions: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn(async () => ({})) })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})

afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

it.each(['home', 'remote'] as const)(
  'renders the %s machine through one view that grows into the toolbar',
  (prefix) => {
    act(() => root.render(<StartModelPicker source={source({ testIdPrefix: prefix })} />))
    expect(el.firstElementChild?.className).toBe('start-model-picker')
    expect(el.querySelector(`[data-testid="${prefix}-model-picker"]`)?.textContent).toBe(
      'Model One',
    )
    expect(el.querySelector(`[data-testid="${prefix}-thinking-picker"]`)?.textContent).toBe('High')
  },
)

it("renders a machine's remedies as buttons after the chips", () => {
  const retry = vi.fn()
  const signIn = vi.fn()
  act(() =>
    root.render(
      <StartModelPicker
        source={source({
          current: undefined,
          levels: [],
          chip: { text: 'No signed-in model on bee1.', tone: 'muted', title: '' },
          actions: [
            { label: 'Retry models', run: retry },
            { label: 'Sign in on bee1', run: signIn },
          ],
        })}
      />,
    ),
  )
  const buttons = [...el.querySelectorAll('button')].map((b) => b.textContent)
  expect(buttons).toEqual(['No signed-in model on bee1.', 'Retry models', 'Sign in on bee1'])
  act(() => [...el.querySelectorAll('button')][1]!.click())
  act(() => [...el.querySelectorAll('button')][2]!.click())
  expect(retry).toHaveBeenCalledTimes(1)
  expect(signIn).toHaveBeenCalledTimes(1)
})
