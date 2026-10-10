// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ContextMeter } from './ContextMeter'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useContextBudgetStore } from '@/stores/contextBudgetPref'
import type { SessionStats } from '@shared/rpc'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const SESSION = 'sess-1'

/** Overridden per test; the default is one account and a healthy plan. */
let sessionAccount: unknown = null
let usageResult: unknown = null

/** Two signed-in accounts, so the switcher has somewhere to send the lane. */
const accountsResult = {
  prefs: { mode: 'ordered', accounts: [], cooldowns: {} },
  views: [
    {
      account: { id: 'acct-1', label: 'first', email: 'first@example.com', credentialDir: null },
      auth: { ok: true, loggedIn: true, email: 'first@example.com' },
      usage: null,
      cooldownUntil: null,
    },
    {
      account: { id: 'acct-2', label: 'second', email: 'second@example.com', credentialDir: null },
      auth: { ok: true, loggedIn: true, email: 'second@example.com' },
      usage: null,
      cooldownUntil: null,
    },
  ],
}

const invoke = vi.fn(async (channel: string, ..._args: unknown[]) => {
  if (channel === 'pi:codexUsage') return usageResult ?? { ok: false, error: 'no-usage' }
  if (channel === 'claude:sessionAccount') return sessionAccount
  if (channel === 'claude:accounts') return accountsResult
  if (channel === 'claude:assignSession') return undefined
  if (channel === 'claude:usageSnapshot') {
    if (usageResult) return usageResult
    return {
      ok: true,
      snapshot: {
        fetchedAt: Date.now(),
        stale: false,
        contributing: null,
        windows: [
          { label: 'Current session', kind: 'five_hour', percentUsed: 41, resetsAt: null },
          {
            label: 'Current week (all models)',
            kind: 'weekly',
            percentUsed: 63,
            resetsAt: null,
          },
        ],
      },
    }
  }
  return undefined
})

const stats = (contextUsage: SessionStats['contextUsage']): SessionStats => ({
  sessionId: SESSION,
  userMessages: 3,
  assistantMessages: 3,
  toolCalls: 8,
  toolResults: 8,
  totalMessages: 6,
  tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
  cost: 1.5,
  contextUsage,
})

function seed(
  contextUsage: SessionStats['contextUsage'],
  provider = 'pi-claude-cli',
  autoCompactionEnabled?: boolean,
): void {
  useChatStore.setState({
    sessions: {
      [SESSION]: {
        ...useChatStore.getState().sessions[SESSION],
        stats: stats(contextUsage),
        meta: {
          ...(autoCompactionEnabled === undefined ? {} : { autoCompactionEnabled }),
          model: {
            id: 'claude-fable-5',
            name: 'Claude Fable 5',
            api: provider,
            provider,
            reasoning: true,
            input: ['text'],
            contextWindow: 200_000,
            maxTokens: 64_000,
            cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          },
        },
      },
    } as never,
  })
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<ContextMeter sessionId={SESSION} />))
}

function click(text: string): void {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
  expect(button).toBeDefined()
  act(() => button!.click())
}

beforeEach(() => {
  invoke.mockClear()
  sessionAccount = null
  usageResult = null
  ;(globalThis as unknown as { window: { phosphor: unknown } }).window.phosphor = { invoke }
  useChatStore.setState({ sessions: {} })
  useExtensionUiStore.setState({ statuses: {} })
  useContextBudgetStore.setState({ contextBudget: '' })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  document.body.innerHTML = ''
})

describe('ContextMeter', () => {
  it('fetches Codex usage only on open, reuses the dials, and refreshes past the cache', async () => {
    usageResult = {
      ok: true,
      snapshot: {
        fetchedAt: Date.now(),
        windows: [
          { label: 'Weekly', kind: 'weekly', percentUsed: 48, resetsAt: Date.now() + 86400000 },
        ],
        credits: { limit: 200, remaining: 56.15, resetsAt: Date.now() + 86400000 },
      },
    }
    seed({ tokens: 50_000, contextWindow: 200_000, percent: 25 }, 'openai-codex')
    render()
    expect(invoke).not.toHaveBeenCalled()
    click('25%')
    expect(document.body.textContent).toContain('Checking…')
    await act(async () => {})
    expect(invoke).toHaveBeenCalledWith('pi:codexUsage', false)
    expect(invoke).not.toHaveBeenCalledWith('claude:sessionAccount', SESSION)
    expect(document.body.textContent).toContain('Plan usage · ChatGPT account')
    expect(document.body.textContent).toContain('48%')
    expect(document.body.textContent).toContain('Weekly')
    expect(document.body.textContent).not.toContain('5-hour')
    expect(document.body.textContent).toContain('56.2 of 200 credits left')
    click('Refresh')
    await act(async () => {})
    expect(invoke).toHaveBeenLastCalledWith('pi:codexUsage', true)
    act(() => seed({ tokens: 50_000, contextWindow: 200_000, percent: 25 }, 'anthropic'))
    expect(document.body.textContent).not.toContain('ChatGPT account')
  })

  it('shows a Codex failure instead of hiding usage, including rejected IPC', async () => {
    seed({ tokens: null, contextWindow: 200_000, percent: null }, 'openai-codex')
    invoke.mockRejectedValueOnce(new Error('IPC failed'))
    render()
    click('—')
    await act(async () => {})
    expect(document.body.textContent).toContain('ChatGPT usage is unavailable')
    click('Refresh')
    await act(async () => {})
    expect(document.body.textContent).toContain('ChatGPT returned no supported usage')
  })

  it('still renders when pi has no context percentage yet', async () => {
    // pi reports null context tokens from the moment a session compacts until
    // fresh usage arrives. The meter used to unmount there, which took the
    // popover — and the plan-usage fetch inside it — with it.
    seed({ tokens: null, contextWindow: 200_000, percent: null })
    render()

    expect(document.body.textContent).toContain('—')
    click('—')
    await act(async () => {})
    expect(document.body.textContent).toContain('Session usage')
    expect(invoke).toHaveBeenCalledWith('claude:usageSnapshot', undefined, false)
  })

  it('shows the percentage once pi reports one', () => {
    seed({ tokens: 50_000, contextWindow: 200_000, percent: 25 })
    render()
    expect(document.body.textContent).toContain('25%')
  })

  // A 128k window is smaller than the default budget: pi's own threshold
  // (window - reserveTokens) comes first, for Claude Code like any provider.
  it.each(['pi-claude-cli', 'openai-codex'])("uses pi's window and cap for %s", (provider) => {
    seed({ tokens: 208_000, contextWindow: 128_000, percent: 162.5 }, provider)
    render()
    expect(document.body.textContent).toContain('163%')
    expect(document.querySelector('button')?.title).not.toContain('budget')
  })

  describe.each(['pi-claude-cli', 'openai-codex'])('a large-window %s session', (provider) => {
    it('is measured against the budget it compacts at', () => {
      // 150k of a 1M window is 15% — but this session compacts at 200k, so it
      // is three quarters of the way there.
      seed({ tokens: 150_000, contextWindow: 1_000_000, percent: 15 }, provider)
      render()
      expect(document.body.textContent).toContain('75%')
      expect(document.querySelector('button')?.title).toMatch(/^Context: 75% of .* budget$/)
    })

    it('reads the configured budget', () => {
      // "500" is shorthand for 500k.
      useContextBudgetStore.setState({ contextBudget: '500' })
      seed({ tokens: 325_000, contextWindow: 1_000_000, percent: 32.5 }, provider)
      render()
      expect(document.body.textContent).toContain('65%')
    })

    it('shows overshoot but caps the ring, and explains the next safe check', () => {
      seed({ tokens: 260_000, contextWindow: 1_000_000, percent: 26 }, provider)
      render()
      expect(document.body.textContent).toContain('130%')
      expect(document.querySelectorAll('circle')[1]?.getAttribute('stroke-dasharray')).toBe(
        '40.8 40.8',
      )
      click('130%')
      expect(document.body.textContent).toContain('60.0k over budget')
      expect(document.body.textContent).toContain('before the next model request')
    })

    it("falls back to pi's window when the session's auto-compaction is off", () => {
      seed({ tokens: 150_000, contextWindow: 1_000_000, percent: 15 }, provider, false)
      render()
      expect(document.body.textContent).toContain('15%')
    })

    it("falls back to pi's window when there is no budget", () => {
      useContextBudgetStore.setState({ contextBudget: 'auto' })
      seed({ tokens: 150_000, contextWindow: 1_000_000, percent: 15 }, provider)
      render()
      expect(document.body.textContent).toContain('15%')
    })
  })

  it('renders the reported overshoot with a normalized bar and separate model capacity', () => {
    useContextBudgetStore.setState({ contextBudget: '400k' })
    seed({ tokens: 703_167, contextWindow: 400_000, percent: 175.8 }, 'openai-codex')
    useChatStore.getState().setModels(SESSION, [
      {
        ...useChatStore.getState().sessions[SESSION]!.meta!.model!,
        contextWindow: 1_000_000,
      },
    ])
    useExtensionUiStore.setState({
      statuses: {
        [SESSION]: {
          'phosphor-context-breakdown': JSON.stringify({
            totalTokens: 703_167,
            contextWindow: 400_000,
            approximate: true,
            parts: { messages: 338_000, systemPrompt: 11_300, tools: 7_100, mcpTools: 3_100 },
            counts: { messages: 661, tools: 27, mcpTools: 14 },
            mcpByServer: {},
          }),
        },
      },
    })
    render()
    click('176%')
    expect(document.body.textContent).toContain('1.0M model capacity')
    expect(document.body.textContent).toContain('303k over budget')
    const widths = [...document.querySelectorAll<HTMLElement>('[style]')]
      .filter((node) => node.style.width.endsWith('%'))
      .map((node) => parseFloat(node.style.width))
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100)
    expect(document.body.textContent).toContain('percentages are relative to the budget or window')
  })

  it('uses a live restored window after opt-out before the next stats poll', () => {
    useContextBudgetStore.setState({ contextBudget: 'off' })
    seed({ tokens: 100_000, contextWindow: 400_000, percent: 25 }, 'openai-codex')
    useExtensionUiStore.setState({
      statuses: {
        [SESSION]: {
          'phosphor-context-breakdown': JSON.stringify({
            totalTokens: 100_000,
            contextWindow: 1_000_000,
            approximate: true,
            parts: { messages: 80_000, systemPrompt: 1000, tools: 1000, mcpTools: 0 },
            counts: { messages: 10, tools: 4, mcpTools: 0 },
            mcpByServer: {},
          }),
        },
      },
    })
    render()
    expect(document.body.textContent).toContain('10%')
  })

  it('fetches and shows both plan windows for a Claude Code session', async () => {
    seed({ tokens: 50_000, contextWindow: 200_000, percent: 25 })
    render()
    click('25%')
    await act(async () => {})

    // Dials: a short caption per window, the percent inside the arc.
    expect(document.body.textContent).toContain('5-hour')
    expect(document.body.textContent).toContain('41')
    expect(document.body.textContent).toContain('Weekly')
    expect(document.body.textContent).toContain('63')
  })

  it('re-reads usage past the cache when refresh is clicked', async () => {
    seed({ tokens: 50_000, contextWindow: 200_000, percent: 25 })
    render()
    click('25%')
    await act(async () => {})
    expect(invoke).toHaveBeenCalledWith('claude:usageSnapshot', undefined, false)

    click('Refresh')
    await act(async () => {})
    // A refresh that returned main's 60 s cache would look broken, so this
    // call — and only this one — is allowed to skip it.
    expect(invoke).toHaveBeenCalledWith('claude:usageSnapshot', undefined, true)
  })

  it('shows a reason instead of vanishing when the usage run fails', async () => {
    usageResult = { ok: false, error: 'run-failed' }
    seed({ tokens: 50_000, contextWindow: 200_000, percent: 25 })
    render()
    click('25%')
    await act(async () => {})

    expect(document.body.textContent).toContain('Plan usage · Claude account')
    expect(document.body.textContent).toContain('did not complete')
  })

  it("names the lane's own account, and reads that account's usage", async () => {
    // The defect this guards: the popover asked for "the" plan usage with no
    // account, which reads whichever credential the CLI keeps by default —
    // routinely a different plan than the lane is spending.
    sessionAccount = {
      id: 'acct-2',
      label: 'second',
      email: 'second@example.com',
      total: 2,
      mode: 'round-robin',
      cooldownUntil: Date.now() + 60_000,
      alternative: { id: 'acct-1', label: 'first@example.com' },
    }
    seed({ tokens: 50_000, contextWindow: 200_000, percent: 25 })
    render()
    click('25%')
    await act(async () => {})

    expect(invoke).toHaveBeenCalledWith('claude:usageSnapshot', 'acct-2', false)
    expect(document.body.textContent).toContain('Plan usage · second@example.com')
    // A running lane cannot change account in place, so the popover says where
    // the next one goes — and offers to restart this one there too.
    expect(document.body.textContent).toContain('New sessions go to first@example.com')
    expect(document.body.textContent).toContain('Switch account')
  })

  it('lists the other accounts only when the switcher is opened, then moves the lane', async () => {
    sessionAccount = {
      id: 'acct-2',
      label: 'second',
      email: 'second@example.com',
      total: 2,
      mode: 'round-robin',
      cooldownUntil: null,
      alternative: { id: 'acct-1', label: 'first@example.com' },
    }
    const move = vi.fn(async () => null)
    useSessionsStore.setState({ moveSessionToAccount: move } as never)
    seed({ tokens: 50_000, contextWindow: 200_000, percent: 25 })
    render()
    click('25%')
    await act(async () => {})

    // `claude:accounts` runs `claude auth status` per account, so the popover
    // must not pay for it on every open.
    expect(invoke).not.toHaveBeenCalledWith('claude:accounts')
    click('Switch account')
    await act(async () => {})
    expect(invoke).toHaveBeenCalledWith('claude:accounts')
    expect(document.body.textContent).toContain('first@example.com')

    click('first@example.com')
    await act(async () => {})
    expect(move).toHaveBeenCalledWith(SESSION, 'acct-1')
  })

  it('stays with the old wording when only one account is configured', async () => {
    sessionAccount = {
      id: 'acct-1',
      label: 'only',
      email: 'only@example.com',
      total: 1,
      mode: 'ordered',
      cooldownUntil: null,
      alternative: null,
    }
    seed({ tokens: 50_000, contextWindow: 200_000, percent: 25 })
    render()
    click('25%')
    await act(async () => {})

    expect(document.body.textContent).toContain('Plan usage · Claude account')
    expect(document.body.textContent).not.toContain('New sessions go to')
  })

  it('gives the Headroom savings a full-width row of their own', async () => {
    // The redesign moved Tool calls into a two-column grid, and this section
    // was a fragment of labelled rows that followed it — putting it in that
    // column would wrap every value. It renders below the grid instead, and
    // only when the extension has actually compressed something.
    useExtensionUiStore.setState({
      statuses: {
        [SESSION]: {
          'phosphor-headroom': JSON.stringify({
            savedTokens: 12_400,
            beforeTokens: 48_000,
            afterTokens: 35_600,
            results: 37,
            skippedLossyTokens: 2100,
            lastMs: 118,
          }),
        },
      },
    })
    seed({ tokens: 50_000, contextWindow: 200_000, percent: 25 })
    render()
    click('25%')
    await act(async () => {})

    expect(document.body.textContent).toContain('Optimization · Headroom')
    expect(document.body.textContent).toContain('12.4k')
    expect(document.body.textContent).toContain('48.0k → 35.6k over 37 results')
    expect(document.body.textContent).toContain('118 ms last')
    expect(document.body.textContent).toContain('Skipped as lossy')
  })

  it('says nothing about Headroom on a session that never compressed anything', async () => {
    seed({ tokens: 50_000, contextWindow: 200_000, percent: 25 })
    render()
    click('25%')
    await act(async () => {})
    expect(document.body.textContent).not.toContain('Headroom')
  })

  it('never asks for plan usage on a session the Claude CLI does not serve', async () => {
    seed({ tokens: 50_000, contextWindow: 200_000, percent: 25 }, 'amazon-bedrock')
    render()
    click('25%')
    await act(async () => {})

    expect(invoke).not.toHaveBeenCalledWith('claude:usageSnapshot', undefined, false)
    expect(invoke).not.toHaveBeenCalledWith('claude:sessionAccount', SESSION, undefined)
    expect(document.body.textContent).not.toContain('Plan usage')
  })
})
