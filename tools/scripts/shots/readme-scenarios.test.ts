import { describe, expect, it, vi } from 'vitest'
import type * as ReadmeCapture from './readme-capture.mjs'
import {
  startSession,
  captureChatAndChanges,
  captureFiles,
  captureTerminalAndHome,
  captureArtifacts,
  captureSubagents,
  captureSettings,
} from './readme-scenarios.mjs'

vi.mock('./readme-capture.mjs', async (original) => ({
  ...(await original<typeof ReadmeCapture>()),
  captureShot: async (state: { events: string[] }, name: string) => {
    state.events.push(`shot:${name}`)
  },
}))

function scenarioState({ pickerVisible = true, expanded = 'false' } = {}) {
  const events: string[] = []
  const selector = (method: string, args: unknown[]) => {
    const name = (args[1] as { name?: unknown } | undefined)?.name
    return `${method.replace('getBy', '')}:${String(name ?? args[0])}`
  }
  const locator = (route: string): object =>
    new Proxy(
      {},
      {
        get: (_, key: string | symbol) => {
          if (key === Symbol.toPrimitive) return () => route
          if (typeof key !== 'string' || key === 'then') return undefined
          return (...args: unknown[]) => {
            if (key === 'first') return locator(`${route}.first`)
            if (key === 'nth') return locator(`${route}[${args[0]}]`)
            if (key === 'filter')
              return locator(`${route}.filter:${(args[0] as { hasText: string }).hasText}`)
            if (key === 'or') return locator(`${route}|${String(args[0])}`)
            if (key.startsWith('getBy')) return locator(`${route}>${selector(key, args)}`)
            if (key === 'evaluate') {
              const el = { scrollTop: 0 }
              ;(args[0] as (el: { scrollTop: number }) => void)(el)
              events.push(`${route}.scroll:${el.scrollTop}`)
              return
            }
            events.push(`${route}.${key}${args.length ? ':' + JSON.stringify(args) : ''}`)
            if (key === 'isVisible') return pickerVisible
            if (key === 'getAttribute') return expanded
          }
        },
      },
    )
  const page = new Proxy(
    {
      keyboard: {
        press: async (key: string) => {
          events.push(`press:${key}`)
        },
      },
    },
    {
      get: (target, key: string) => {
        if (key === 'keyboard') return target.keyboard
        if (key === 'waitForTimeout')
          return async (ms: number) => {
            events.push(`settle:${ms}`)
          }
        return (...args: unknown[]) => locator(selector(key, args))
      },
    },
  )
  const homeComposer = locator('Placeholder:Describe a task or ask a question')
  return { page, homeComposer, events }
}

const home = 'Placeholder:Describe a task or ask a question'
const row = 'TestId:session-row.first'
const rename = 'Label:Session name'
const start = 'Role:/Start session/i.click'

describe('readme scenario steps', () => {
  it('starts on the checked-out branch and renames through the sidebar', async () => {
    const state = scenarioState()
    await startSession(state)
    expect(state.events).toEqual([
      `Role:/Open Folder/i|${home}.first.waitFor:[{"timeout":60000}]`,
      'Role:/Open Folder/i.isVisible',
      'Role:/Open Folder/i.click',
      `${home}.waitFor:[{"timeout":30000}]`,
      'TestId:workspace-chip.waitFor:[{"timeout":15000}]',
      'Role:new branch.uncheck',
      `${home}.fill:["Update hello.ts"]`,
      start,
      'Text:/Done:\\s*hello\\.ts\\s*updated\\./.waitFor:[{"timeout":60000}]',
      `${row}.waitFor:[{"timeout":30000}]`,
      `${row}.dblclick`,
      `${rename}.waitFor:[{"timeout":10000}]`,
      `${rename}.fill:["Update hello world greeting"]`,
      'press:Enter',
      `${row}.click`,
    ])
  })

  it('does not open the folder picker when already on workspace home', async () => {
    const state = scenarioState({ pickerVisible: false })
    await startSession(state)
    expect(state.events).not.toContain('Role:/Open Folder/i.click')
    expect(state.events).toContain(`${home}.fill:["Update hello.ts"]`)
  })

  it('expands activity, opens the edit, then captures chat and Changes', async () => {
    const state = scenarioState()
    await captureChatAndChanges(state)
    expect(state.events).toEqual([
      'TestId:activity-summary.first.waitFor:[{"timeout":30000}]',
      'TestId:activity-summary.first.getAttribute:["aria-expanded"]',
      'TestId:activity-summary.first.click',
      'Role:/Edited\\s+hello\\.ts/.waitFor:[{"timeout":20000}]',
      'Role:/Edited\\s+hello\\.ts/.click',
      'Title:Artifacts pane.click',
      'settle:3500',
      'shot:chat',
      'Title:/Changes pane/.click',
      'Text:Files changed.waitFor:[{"timeout":15000}]',
      'Text:hello.ts.first.waitFor:[{"timeout":15000}]',
      'settle:3500',
      'shot:changes',
    ])
  })

  it('leaves expanded activity open', async () => {
    const state = scenarioState({ expanded: 'true' })
    await captureChatAndChanges(state)
    expect(state.events).not.toContain('TestId:activity-summary.first.click')
    expect(state.events).toContain('shot:chat')
  })

  it('scopes the file selection and restores docking and fullscreen after shots', async () => {
    const state = scenarioState()
    await captureFiles(state)
    expect(state.events).toEqual([
      'Title:/Files pane/.click',
      'settle:3500',
      'TestId:right-pane>Role:hello.ts.click',
      'settle:3000',
      'shot:files',
      'Title:Move pane to the left.click',
      'settle:3500',
      'shot:files-left',
      'Title:Move pane to the right.click',
      'settle:2500',
      'Title:Fullscreen pane.click',
      'settle:3000',
      'shot:files-full',
      'Title:Exit fullscreen.click',
      'settle:2500',
    ])
  })

  it('captures terminal before navigating home and waiting for the ledger', async () => {
    const state = scenarioState()
    await captureTerminalAndHome(state)
    expect(state.events).toEqual([
      'Title:/Terminal pane/.click',
      'settle:3500',
      'shot:terminal',
      'Role:/^New$/.click',
      'TestId:home-ledger.waitFor:[{"timeout":20000}]',
      'settle:2200',
      'shot:home',
    ])
  })

  it('uses the longartifact stub prompt, scrolls the document and renames before capture', async () => {
    const state = scenarioState()
    await captureArtifacts(state)
    expect(state.events).toEqual([
      'Role:/^New$/.click',
      `${home}.waitFor:[{"timeout":20000}]`,
      'Role:new branch.uncheck',
      `${home}.fill:["write a longartifact please"]`,
      start,
      'TestId:artifact-scroll.waitFor:[{"timeout":60000}]',
      'TestId:artifact-scroll.scroll:260',
      `${row}.dblclick`,
      `${rename}.waitFor:[{"timeout":10000}]`,
      `${rename}.fill:["Draft the long-form report"]`,
      'press:Enter',
      'settle:2500',
      'shot:artifacts',
    ])
  })

  it('uses the parallel stub trigger and waits for the fourth child', async () => {
    const state = scenarioState()
    await captureSubagents(state)
    expect(state.events).toEqual([
      'Role:/^New$/.click',
      `${home}.waitFor:[{"timeout":20000}]`,
      'Role:new branch.uncheck',
      `${home}.fill:["Fix the token refresh bug, split the work in parallel"]`,
      start,
      'Role:/Running workflow/.waitFor:[{"timeout":60000}]',
      `${row}.dblclick`,
      `${rename}.waitFor:[{"timeout":10000}]`,
      `${rename}.fill:["Fix the token refresh bug"]`,
      'press:Enter',
      'Role:/Running workflow/.click',
      'TestId:subagent-child[3].waitFor:[{"timeout":10000}]',
      'settle:3000',
      'shot:subagents',
    ])
  })

  it('captures Appearance, switches Light and selects the named artifact session', async () => {
    const state = scenarioState()
    await captureSettings(state)
    expect(state.events).toEqual([
      'press:ControlOrMeta+Comma',
      'Role:Appearance.click',
      'settle:2400',
      'shot:settings',
      'Role:Light.click',
      'press:Escape',
      'TestId:session-row.filter:Draft the long-form report.click',
      'Placeholder:/Describe a task…/.waitFor:[{"timeout":20000}]',
      'settle:3500',
      'shot:light',
    ])
  })
})
