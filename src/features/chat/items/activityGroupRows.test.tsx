// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// The settings store subscribes to prefers-color-scheme at import time, and
// jsdom ships no matchMedia. Hoisted so it exists before that module loads.
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
})

import { readFileSync } from 'node:fs'

import { ActivityGroup, GUTTER_MARK, GUTTER_MARK_FILL, ROW_INSET } from './ActivityGroup'
import type { ActivityStep } from './transcriptRows'
import type { ToolState } from '../reducer'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { SUBAGENTS_STATUS_KEY } from '../subagentStatus'

/**
 * One activity group renders four different row shapes, and two of them only
 * ever appear in sessions running on the Claude Code provider:
 *
 *  - a pi tool call (ToolCard)
 *  - a CLI-side tool pi never executed (`[Claude Code · WebSearch {…}]`)
 *  - a sub-agent launch (`Agent`/`Task`)
 *  - reasoning with no tool call after it
 *
 * They are authored in four different places in ActivityGroup.tsx, so the
 * failure mode is drift: someone adjusts the tool row's inset and a
 * Claude-provider run ends up with rows starting at two different x positions
 * inside one card. These tests pin the shared inset and the provider-specific
 * content, so the mixed transcript keeps reading as a single column.
 */

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(ui: React.ReactNode): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(ui)
  })
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  document.body.innerHTML = ''
  useExtensionUiStore.setState({ statuses: {} })
})

/** Publish a `claude-subagents` snapshot the way the provider does. */
function publishAgents(sessionId: string, tasks: unknown[]): void {
  useExtensionUiStore.setState({
    statuses: { [sessionId]: { [SUBAGENTS_STATUS_KEY]: JSON.stringify({ tasks }) } },
  })
}

const tool = (id: string): ToolState => ({
  toolCallId: id,
  toolName: 'read',
  args: { path: 'src/app.ts' },
  argsText: '',
  status: 'done',
  output: null,
})

const step = (block: ActivityStep['block']): ActivityStep => ({
  itemId: 'a1',
  block,
  streaming: false,
  isLastInItem: false,
})

/** The mix a Claude-provider turn actually produces. */
const MIXED: ActivityStep[] = [
  step({ type: 'tool', index: 0, toolCallId: 't1' }),
  step({ type: 'externalTool', index: 1, name: 'WebSearch', args: '{"query":"pygame docs"}' }),
  // A sub-agent reaches the renderer already folded: one block per AGENT,
  // built by buildTranscriptRows from the three markers the CLI emits for it.
  step({
    type: 'subagent',
    index: 2,
    status: 'launched',
    description: 'Find rename code',
    prompt: 'In this Electron app…',
    seen: new Set(['call']),
  }),
  step({ type: 'thinking', index: 3, text: 'weighing options', closed: true }),
]

function renderMixed(): void {
  render(
    <ActivityGroup
      steps={MIXED}
      tools={{ t1: tool('t1') }}
      hideThinking={false}
      sessionId="s1"
      active={false}
    />,
  )
}

/** Every row's own container, in render order. */
function rowContainers(): HTMLElement[] {
  const card = document.querySelector('[data-testid="activity-group"] .divide-y')
  if (!card) throw new Error('group card not rendered')
  return [...card.children].map((step) => {
    // Each step wrapper holds exactly one row container.
    const el = step.firstElementChild ?? step
    return el as HTMLElement
  })
}

describe('ActivityGroup row shapes', () => {
  it('gives every row shape the same left inset', () => {
    renderMixed()
    const rows = rowContainers()
    expect(rows).toHaveLength(4)

    for (const row of rows) {
      // The row container itself, or the button inside it that carries the
      // padding (sub-agent and reasoning rows are buttons).
      const pad = ROW_INSET.split(' ')[0]!
      const carrier = row.className.includes(pad)
        ? row
        : (row.querySelector(`[class*="${pad}"]`) as HTMLElement | null)
      expect(carrier, `a row shape lost the shared inset: ${row.outerHTML.slice(0, 120)}`).not.toBe(
        null,
      )
      for (const cls of ROW_INSET.split(' ')) {
        expect(carrier!.className).toContain(cls)
      }
    }
  })

  /**
   * The padding bug this pins: `cc` used to be an inline pill, so every
   * Claude-provider row started its label ~25px right of the pi tool row above
   * it — and one turn interleaves the two, so the card's single column broke.
   * A gutter mark must be out of flow, and must not be the row's first in-flow
   * child.
   */
  it('floats the cc provenance mark in the gutter, not in front of the label', () => {
    renderMixed()
    const row = document.querySelector('[data-testid="external-tool-row"]')!
    const mark = row.querySelector('[aria-label="Ran by Claude Code"]')
    expect(mark).not.toBeNull()
    for (const cls of GUTTER_MARK.split(' ')) {
      expect((mark as HTMLElement).className).toContain(cls)
    }

    const inFlow = [...row.children].filter(
      (el) => !(el as HTMLElement).className.includes('absolute'),
    )
    expect(inFlow[0]!.textContent).toBe('Searched the web for')
  })

  it('renders a CLI-side tool with pi own verb, not the raw tool name', () => {
    renderMixed()
    const external = document.querySelector('[data-testid="external-tool-row"]')
    expect(external).not.toBeNull()

    // pi's vocabulary, not Claude Code's: a `WebSearch` marker reads the way
    // a pi search does. The tool's own name is provenance, not the headline.
    expect(external!.textContent).toContain('Searched the web for')
    expect(external!.textContent).toContain('pygame docs')
    expect(external!.textContent).not.toContain('WebSearch')

    // Provenance survives, compactly: a badge in the row, the full marker in
    // the title so a capped preview is still readable on hover.
    expect(external!.textContent).toContain('cc')
    expect(external!.getAttribute('title')).toContain('Claude Code · WebSearch')

    // The marker syntax itself must never reach the reader.
    expect(external!.textContent).not.toContain('[Claude Code ·')
  })

  /**
   * The complaint this pins: a Claude-provider turn showed
   * `Claude Code | Bash | <raw arg>` directly above pi's `Ran <command>`, in
   * a different type scale, with the command missing whenever the provider's
   * preview cap cut through it. Same act, two vocabularies, one card.
   */
  it('gives a CLI-side bash call the same shape as a pi bash call', () => {
    const piBash: ToolState = {
      toolCallId: 'b1',
      toolName: 'bash',
      args: { command: 'npm test' },
      argsText: '',
      status: 'done',
      output: null,
    }
    render(
      <ActivityGroup
        steps={[
          step({ type: 'tool', index: 0, toolCallId: 'b1' }),
          step({
            type: 'externalTool',
            index: 1,
            name: 'Bash',
            args: '{"command":"npm run lint"}',
          }),
        ]}
        tools={{ b1: piBash }}
        hideThinking={false}
        sessionId="s1"
        active={false}
      />,
    )

    const rows = rowContainers()
    expect(rows).toHaveLength(2)
    const [pi, cli] = rows.map((r) => r.textContent ?? '')

    // Same verb for the same act.
    expect(pi).toContain('Ran')
    expect(cli).toContain('Ran')
    expect(pi).toContain('npm test')
    expect(cli).toContain('npm run lint')

    // Same monospace treatment for the command itself, so the two rows line
    // up rather than reading as two different transcripts.
    const mono = (row: HTMLElement): boolean =>
      [...row.querySelectorAll('span')].some(
        (el) => el.className.includes('font-mono') && el.textContent?.includes('npm'),
      )
    expect(mono(rows[0]!)).toBe(true)
    expect(mono(rows[1]!)).toBe(true)
  })

  it('shows the command even when the preview cap cut through it', () => {
    render(
      <ActivityGroup
        steps={[
          step({
            type: 'externalTool',
            index: 0,
            // Exactly the shape the provider emits at its 142-char cap: one
            // `command` argument, sliced mid-value, no closing quote.
            name: 'Bash',
            args: '{"command":"grep -rn \\"bundledExtensions\\" electron/ipc/pi-session-han\u2026',
          }),
        ]}
        tools={{}}
        hideThinking={false}
        sessionId="s1"
        active={false}
      />,
    )
    const row = document.querySelector('[data-testid="external-tool-row"]')!
    expect(row.textContent).toContain('Ran')
    expect(row.textContent).toContain('bundledExtensions')
    expect(row.textContent).not.toContain('a command')
  })

  it('renders a sub-agent launch with its own badge and headline', () => {
    renderMixed()
    const subagent = document.querySelector('[data-testid="subagent-row"]')
    expect(subagent).not.toBeNull()
    expect(subagent!.textContent).toContain('agent')
    expect(subagent!.textContent).toContain('Find rename code')
    // "launched" and nothing more: the CLI has not confirmed a start, so the
    // row must not imply the agent is out there working.
    expect(subagent!.textContent).toContain('launched')
    expect(subagent!.getAttribute('data-status')).toBe('launched')
  })

  it('shows what a finished sub-agent cost, and drops the status word', () => {
    render(
      <ActivityGroup
        steps={[
          step({
            type: 'subagent',
            index: 0,
            status: 'completed',
            description: 'Dig into pi-claude-cli internals',
            subagentType: 'general-purpose',
            taskId: 'a8de7d982d824b56a',
            toolUses: 2,
            totalTokens: 1234,
            durationMs: 900,
            seen: new Set(['call', 'start', 'end']),
          }),
        ]}
        tools={{}}
        hideThinking={false}
        sessionId="s1"
        active={false}
      />,
    )
    const row = document.querySelector('[data-testid="subagent-row"]')!
    expect(row.textContent).toContain('Dig into pi-claude-cli internals')
    expect(row.textContent).toContain('2 tools')
    expect(row.textContent).toContain('1.2k tokens')
    expect(row.textContent).toContain('900ms')
    // A completed agent says so with its stats; the word would be noise.
    expect(row.textContent).not.toContain('completed')
  })

  it('names a killed sub-agent by its outcome', () => {
    render(
      <ActivityGroup
        steps={[
          step({
            type: 'subagent',
            index: 0,
            status: 'stopped',
            description: 'Find failing AskUserQuestion session',
            seen: new Set(['end']),
          }),
        ]}
        tools={{}}
        hideThinking={false}
        sessionId="s1"
        active={false}
      />,
    )
    const row = document.querySelector('[data-testid="subagent-row"]')!
    expect(row.textContent).toContain('stopped')
  })

  /**
   * The markers arrive at the start and the end of a sub-agent, so without the
   * live join every row in a fan-out says "running" and nothing else for the
   * whole run — eight identical lines for eight minutes, in the turn that
   * motivated this.
   */
  describe('live progress joined from the status channel', () => {
    const running = (taskId: string, description: string): ActivityStep =>
      step({
        type: 'subagent',
        index: 0,
        status: 'running',
        description,
        taskId,
        seen: new Set(['call', 'start']),
      })

    function renderRunning(steps: ActivityStep[]): void {
      render(
        <ActivityGroup
          steps={steps}
          tools={{}}
          hideThinking={false}
          sessionId="s1"
          active={true}
        />,
      )
    }

    it("gives each running agent its OWN step, not the strip's single line", () => {
      publishAgents('s1', [
        { taskId: 'a1', status: 'running', currentStep: 'Running Read TRACKER.md' },
        { taskId: 'a2', status: 'running', currentStep: 'Running Grep chat.md' },
      ])
      renderRunning([running('a1', 'Verify spec-drift'), running('a2', 'Verify perf findings')])

      const steps = [...document.querySelectorAll('[data-testid="subagent-step"]')].map(
        (el) => el.textContent,
      )
      expect(steps).toEqual(['Running Read TRACKER.md', 'Running Grep chat.md'])
    })

    it('falls back to the last tool when the step is cleared between calls', () => {
      publishAgents('s1', [{ taskId: 'a1', status: 'running', lastToolName: 'Grep' }])
      renderRunning([running('a1', 'Verify spec-drift')])
      expect(document.querySelector('[data-testid="subagent-step"]')!.textContent).toBe('Grep')
    })

    it('shows cost climbing before any terminal marker arrives', () => {
      publishAgents('s1', [
        { taskId: 'a1', status: 'running', toolUses: 3, totalTokens: 12000, durationMs: 4000 },
      ])
      renderRunning([running('a1', 'Verify spec-drift')])
      const row = document.querySelector('[data-testid="subagent-row"]')!
      expect(row.textContent).toContain('3 tools')
      expect(row.textContent).toContain('12.0k tokens')
    })

    it('leaves a settled row exactly as its markers left it', () => {
      // The provider clears the key at the end of an episode. A terminal row
      // must not blank out, and must not be re-dressed by a stale snapshot.
      publishAgents('s1', [
        { taskId: 'a1', status: 'running', currentStep: 'Running Read TRACKER.md', toolUses: 99 },
      ])
      render(
        <ActivityGroup
          steps={[
            step({
              type: 'subagent',
              index: 0,
              status: 'completed',
              description: 'Verify spec-drift',
              taskId: 'a1',
              toolUses: 2,
              seen: new Set(['call', 'start', 'end']),
            }),
          ]}
          tools={{}}
          hideThinking={false}
          sessionId="s1"
          active={false}
        />,
      )
      const row = document.querySelector('[data-testid="subagent-row"]')!
      expect(document.querySelector('[data-testid="subagent-step"]')).toBeNull()
      expect(row.textContent).toContain('2 tools')
      expect(row.textContent).not.toContain('99 tools')
    })

    it('says nothing extra for an agent the snapshot does not mention', () => {
      publishAgents('s1', [{ taskId: 'somebody-else', status: 'running', currentStep: 'Running' }])
      renderRunning([running('a1', 'Verify spec-drift')])
      expect(document.querySelector('[data-testid="subagent-step"]')).toBeNull()
      expect(document.querySelector('[data-testid="subagent-row"]')!.textContent).toContain(
        'running',
      )
    })

    it("does not read another session's agents", () => {
      publishAgents('other', [
        { taskId: 'a1', status: 'running', currentStep: 'Running Read TRACKER.md' },
      ])
      renderRunning([running('a1', 'Verify spec-drift')])
      expect(document.querySelector('[data-testid="subagent-step"]')).toBeNull()
    })
  })

  it('keeps trailing reasoning as its own row', () => {
    renderMixed()
    const marks = document.querySelectorAll('[data-testid="thought-mark"]')
    expect(marks.length).toBe(1)
    expect(marks[0]!.textContent).toContain('Reasoning')
  })

  it('anchors the summary, so its label and the card share a left edge', () => {
    renderMixed()
    const summary = document.querySelector('[data-testid="activity-summary"]') as HTMLElement
    const card = document.querySelector(
      '[data-testid="activity-group"] .divide-y',
    ) as HTMLElement | null
    expect(card).not.toBeNull()
    // jsdom has no layout, so the invariant is expressed through the classes
    // that produce it: the summary pulls its own padding back out, and the
    // card adds no left offset of its own.
    expect(summary.className).toContain('-ml-1.5')
    expect(card!.className).not.toMatch(/\bml-\d/)
  })
})

/**
 * The three constants above are one measurement written three times — the
 * padding a row opens, the box a mark centres in, and the rail an expanded
 * thought hangs off. Nothing in the type system ties them together, and they
 * have now drifted apart twice.
 *
 * The second drift is the one worth pinning: a mark was offset by hand with an
 * arbitrary `left` of bare `-3.5` — a number with no unit, so it is not a CSS
 * length. Tailwind emitted the declaration verbatim, the browser dropped it,
 * and every mark fell back to its static position: directly on top of the
 * label it is supposed to sit beside. It type-checked, it linted, and every
 * test in this file passed.
 */
describe('the gutter is one measurement', () => {
  const step = (cls: string, prefix: string): string => {
    const found = new RegExp(`\\b${prefix}-(\\d+)\\b`).exec(cls)
    if (!found) throw new Error(`no ${prefix}-<n> in "${cls}"`)
    return found[1]!
  }

  it('opens exactly the width its marks centre in', () => {
    expect(step(GUTTER_MARK, 'w')).toBe(step(ROW_INSET, 'pl'))
  })

  it('centres the mark rather than offsetting it by hand', () => {
    expect(GUTTER_MARK).toContain('left-0')
    expect(GUTTER_MARK).toContain('justify-center')
    // An arbitrary offset is how both drifts happened. There is nothing left
    // to hand-tune: the box is the gutter, so centring is the whole rule.
    expect(GUTTER_MARK).not.toMatch(/\[[^\]]*\]/)
  })

  it('keeps every mark fill narrower than the slot, so nothing touches the label', () => {
    // 14px floor for the ✳ square, and horizontal padding rather than a fixed
    // width so `cc` sets its own — both stay inside a 20px slot.
    expect(GUTTER_MARK_FILL).toContain('min-w-3.5')
    expect(GUTTER_MARK_FILL).toContain('px-0.5')
    expect(GUTTER_MARK_FILL).not.toMatch(/(^| )w-\d/)
  })

  it('hangs the expanded rails off that same length', () => {
    // The rails under a pinned thought and a sub-agent prompt have to line up
    // under the label, not under the card edge.
    const source = readFileSync('src/features/chat/items/ActivityGroup.tsx', 'utf8')
    const rails = [...source.matchAll(/mb-1\.5 ml-(\d+) mr-2/g)].map((m) => m[1])
    expect(rails).toHaveLength(3)
    for (const rail of rails) expect(rail).toBe(step(ROW_INSET, 'pl'))
  })
})
