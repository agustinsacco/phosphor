import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runLiveScenarios } from './live-scenarios.mjs'

type ScenarioState = {
  events: string[]
  filters: RegExp[]
  hidden: Set<string>
  unavailable: Set<string>
  expanded: string
}
class ScenarioLocator {
  constructor(
    readonly name: string,
    readonly state: ScenarioState,
  ) {}
  record(action: string) {
    this.state.events.push(`${action}:${this.name}`)
  }
  first() {
    return this
  }
  last() {
    return this
  }
  nth(index: number) {
    return new ScenarioLocator(`${this.name}[${index}]`, this.state)
  }
  or(_other: ScenarioLocator) {
    return this
  }
  filter({ hasText }: { hasText: RegExp }) {
    this.state.filters.push(hasText)
    return this
  }
  getByRole(_role: string, { name }: { name: string | RegExp }) {
    return new ScenarioLocator(`${this.name}/${name}`, this.state)
  }
  async click() {
    this.record('click')
  }
  async check() {
    this.record('check')
  }
  async uncheck() {
    this.record('uncheck')
  }
  async fill(text: string) {
    this.record(`fill=${text}`)
  }
  async waitFor(options: object) {
    this.record(`wait=${JSON.stringify(options)}`)
  }
  async getAttribute(_name: string) {
    return this.state.expanded
  }
  async isVisible() {
    if (this.state.unavailable.has(this.name)) throw new Error('detached')
    return !this.state.hidden.has(this.name)
  }
  async evaluate(callback: (element: { scrollTop: number }) => unknown) {
    const element = { scrollTop: 0 }
    callback(element)
    this.record(`scroll=${element.scrollTop}`)
  }
}

function fixture() {
  const state: ScenarioState = {
    events: [],
    filters: [],
    hidden: new Set(),
    unavailable: new Set(),
    expanded: 'false',
  }
  const locator = (name: string | RegExp) => new ScenarioLocator(String(name), state)
  const page = {
    getByRole: (role: string, options: { name: string | RegExp; exact?: boolean }) => {
      state.events.push(`role:${role}:${options.name}:${options.exact ?? false}`)
      return locator(options.name)
    },
    getByLabel: (name: string, options: object) => {
      state.events.push(`label:${name}:${JSON.stringify(options)}`)
      return locator(name)
    },
    getByPlaceholder: locator,
    getByTestId: locator,
    getByTitle: locator,
    getByText: locator,
    locator,
    waitForTimeout: async (ms: number) => {
      state.events.push(`settle:${ms}`)
    },
    keyboard: {
      press: async (key: string) => {
        state.events.push(`key:${key}`)
      },
      type: async (text: string) => {
        state.events.push(`type:${text}`)
      },
    },
  }
  const shot = vi.fn(async (name: string) => {
    state.events.push(`shot:${name}`)
  })
  const config = {
    PROVIDER_EDIT: 'openai+codex.(x)[v1]$^|\\',
    MODEL_EDIT: 'edit model',
    TASK_EDIT: 'unchanged edit prompt',
    PROVIDER_ARTIFACT: 'pi-claude-cli',
    MODEL_ARTIFACT: 'artifact model',
    TASK_ARTIFACT: 'unchanged artifact prompt',
  }
  return { state, shot, config, run: () => runLiveScenarios({ page, shot }, config) }
}

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => undefined))
afterEach(() => vi.restoreAllMocks())

it('escapes provider chips as literal anchored names before filling each model search', async () => {
  const { run, state, config } = fixture()
  await run()
  expect(state.filters).toHaveLength(2)
  expect(state.filters[0]!.test(config.PROVIDER_EDIT)).toBe(true)
  expect(state.filters[0]!.test(`${config.PROVIDER_EDIT} 42`)).toBe(true)
  expect(state.filters[0]!.test(`prefix ${config.PROVIDER_EDIT}`)).toBe(false)
  expect(state.filters[0]!.test('openaiXcodexYxv1')).toBe(false)
  expect(state.filters[1]!.test('pi-claude-cli 7')).toBe(true)
  expect(state.filters[1]!.test('pi-claude-cli extra')).toBe(false)
  expect(state.events.filter((event) => event.endsWith(':model-search'))).toEqual([
    'fill=edit model:model-search',
    'fill=artifact model:model-search',
  ])
})

it('keeps edit in a worktree, artifact on the checkout, and waits for each exact Stop lifecycle', async () => {
  const { run, state } = fixture()
  await run()
  const events = state.events
  expect(events.filter((event) => /^(?:un)?check:/.test(event))).toEqual([
    'check:new branch',
    'uncheck:new branch',
  ])
  expect(
    events.filter(
      (event) => event.endsWith(':Describe a task or ask a question') && event.startsWith('fill='),
    ),
  ).toEqual([
    'fill=unchanged edit prompt:Describe a task or ask a question',
    'fill=unchanged artifact prompt:Describe a task or ask a question',
  ])
  expect(events.filter((event) => event.startsWith('label:'))).toEqual([
    'label:Stop:{"exact":true}',
    'label:Stop:{"exact":true}',
  ])
  expect(events.filter((event) => event.endsWith(':Stop'))).toEqual([
    'wait={"timeout":90000}:Stop',
    'wait={"state":"hidden","timeout":600000}:Stop',
    'wait={"timeout":90000}:Stop',
    'wait={"state":"hidden","timeout":600000}:Stop',
  ])
  expect(events.indexOf('check:new branch')).toBeLessThan(
    events.indexOf('fill=edit model:model-search'),
  )
  expect(events.indexOf('uncheck:new branch')).toBeLessThan(
    events.indexOf('fill=artifact model:model-search'),
  )
  expect(events).toContain('type:git log --oneline -6')
  expect(events).toContain('scroll=260:artifact-scroll')
  expect(events).toContain('click:session-row[1]')
  expect(events).toContain('click:Dark')
  expect(events).toContain('click:Light')
})

it.each(['hidden', 'unavailable'] as const)(
  'handles %s optional UI without skipping required panes',
  async (visibility) => {
    const { run, state, shot } = fixture()
    for (const name of ['/Open Folder/i', '/Edited\\s/', 'thinking-chip', 'artifact-scroll']) {
      // Open Folder does not swallow errors; only test its normal hidden case.
      if (name === '/Open Folder/i') state.hidden.add(name)
      else state[visibility].add(name)
    }
    state.expanded = 'true'
    await run()
    expect(state.events).not.toContain('click:/Open Folder/i')
    expect(state.events).not.toContain('click:activity-summary')
    expect(state.events).not.toContain('click:/Edited\\s/')
    expect(state.events).toContain('click:Artifacts pane')
    expect(shot.mock.calls.map(([name]) => name)).toEqual([
      'chat',
      'changes',
      'files',
      'files-left',
      'files-full',
      'terminal',
      'artifacts',
      'models',
      'context',
      'commands',
      'mentions',
      'home',
      'settings',
      'accounts',
      'connectors',
      'light',
    ])
  },
)

it('propagates a failed capture instead of running later scenarios', async () => {
  const { run, state, shot } = fixture()
  shot.mockRejectedValueOnce(new Error('capture failed'))
  await expect(run()).rejects.toThrow('capture failed')
  expect(shot).toHaveBeenCalledExactlyOnceWith('chat')
  expect(state.events).not.toContain('uncheck:new branch')
})
