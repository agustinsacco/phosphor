import { describe, expect, it } from 'vitest'
import { hydrateFromMessages } from '../reducer'
import {
  buildTranscriptRows,
  externalToolInfo,
  parseExternalToolMarker,
  summarizeActivity,
  trailingUnfinishedAgents,
  type ActivityStep,
  type SubagentBlock,
} from './transcriptRows'
import { settledVerb, summarizeExternalTool } from '../tools/toolSummaries'
import type { AgentMessage } from '@shared/rpc'
import fixture from '../__fixtures__/claude-cli-blocks.json'

/**
 * Rendering contract for sessions produced by the Claude Code provider
 * (`@saccolabs/pi-claude-cli`), where two block shapes are unlike anything
 * pi's own providers emit:
 *
 *  - CLI-side tools (WebSearch, MCP servers, ToolSearch) arrive as one-line
 *    marker TEXT blocks, because pi cannot execute them and so never sees
 *    them as tool calls.
 *  - Encrypted thinking arrives as a thinking block with a signature and no
 *    plaintext (fable-5, opus-5, sonnet-5 all do this; haiku-4-5 does not).
 *
 * The fixture is trimmed from real captured sessions.
 */
const messages = fixture as unknown as AgentMessage[]

const rowsFor = (msgs: AgentMessage[]): ReturnType<typeof buildTranscriptRows> =>
  buildTranscriptRows(hydrateFromMessages(msgs).items)

describe('parseExternalToolMarker', () => {
  it('reads the tool name and leaves the argument preview opaque', () => {
    expect(parseExternalToolMarker('[Claude Code · WebSearch {"query":"pygame"}]')).toEqual({
      name: 'WebSearch',
      args: '{"query":"pygame"}',
    })
    // Truncated args (the provider caps the preview) must still parse.
    expect(
      parseExternalToolMarker('[Claude Code · Monitor {"command":"for i in 1 2 3; do ec…]'),
    ).toMatchObject({ name: 'Monitor' })
    // No arguments at all.
    expect(parseExternalToolMarker('[Claude Code · ListAgents]')).toEqual({
      name: 'ListAgents',
      args: undefined,
    })
  })

  it('does not claim ordinary prose', () => {
    expect(parseExternalToolMarker('Claude Code is a CLI.')).toBeNull()
    expect(parseExternalToolMarker('[note] see [Claude Code · docs]')).toBeNull()
    expect(parseExternalToolMarker('')).toBeNull()
  })
})

describe('Claude Code provider transcripts', () => {
  it('renders CLI-side tool markers as activity steps, never as prose', () => {
    const rows = rowsFor(messages)

    const textRows = rows.filter((r) => r.kind === 'text')
    for (const row of textRows) {
      const text = (row as Extract<typeof row, { kind: 'text' }>).block.text
      expect(parseExternalToolMarker(text), `prose row leaked a marker: ${text}`).toBeNull()
    }

    const steps = rows
      .filter((r) => r.kind === 'activity')
      .flatMap((r) => (r as { steps: ActivityStep[] }).steps)
    const external = steps.filter((s) => s.block.type === 'externalTool')
    expect(external.map((s) => (s.block as { name: string }).name)).toEqual([
      'ToolSearch',
      'WebSearch',
    ])
  })

  it('keeps the real answer prose intact', () => {
    const rows = rowsFor(messages)
    const prose = rows
      .filter((r) => r.kind === 'text')
      .map((r) => (r as Extract<typeof r, { kind: 'text' }>).block.text)
    expect(prose.some((t) => t.includes('Pygame'))).toBe(true)
  })

  it('drops encrypted thinking blocks so no empty "thought" is advertised', () => {
    const state = hydrateFromMessages(messages)
    const rows = buildTranscriptRows(state.items)
    const steps = rows
      .filter((r) => r.kind === 'activity')
      .flatMap((r) => (r as { steps: ActivityStep[] }).steps)

    expect(steps.some((s) => s.block.type === 'thinking')).toBe(false)

    const summary = summarizeActivity(steps, state.tools, (t) => settledVerb(t.toolName ?? ''))
    expect(summary.thinkingCount).toBe(0)
  })

  it('counts CLI-side tools in the activity summary', () => {
    const state = hydrateFromMessages(messages)
    const steps = buildTranscriptRows(state.items)
      .filter((r) => r.kind === 'activity')
      .flatMap((r) => (r as { steps: ActivityStep[] }).steps)

    const summary = summarizeActivity(steps, state.tools, (t) => settledVerb(t.toolName ?? ''))
    expect(summary.detail).toContain('claude code 2 tools')
  })

  it('summarizes sub-agent launches as launched agents, not anonymous tools', () => {
    const launch: AgentMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '[Claude Code · Agent {"description":"Find rename code"}]' },
        ],
        stopReason: 'stop',
      } as unknown as AgentMessage,
    ]
    const state = hydrateFromMessages(launch)
    const steps = buildTranscriptRows(state.items)
      .filter((r) => r.kind === 'activity')
      .flatMap((r) => (r as { steps: ActivityStep[] }).steps)

    const summary = summarizeActivity(steps, state.tools, (t) => settledVerb(t.toolName ?? ''))
    expect(summary.detail).toContain('launched 1 agent')
    expect(summary.detail).not.toContain('claude code')
  })

  it('still shows a thinking block that carries real text', () => {
    const withThought: AgentMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'weighing options', thinkingSignature: 'sig' },
          { type: 'text', text: 'done' },
        ],
        stopReason: 'stop',
      } as unknown as AgentMessage,
    ]
    const state = hydrateFromMessages(withThought)
    const steps = buildTranscriptRows(state.items)
      .filter((r) => r.kind === 'activity')
      .flatMap((r) => (r as { steps: ActivityStep[] }).steps)

    expect(steps.filter((s) => s.block.type === 'thinking')).toHaveLength(1)
  })
})

describe('externalToolInfo', () => {
  it('reads an agent launch: description headline, prompt detail', () => {
    const info = externalToolInfo(
      'Agent',
      '{"description":"Find rename code","prompt":"In this Electron app, locate…"}',
    )
    expect(info.isAgent).toBe(true)
    expect(info.headline).toBe('Find rename code')
    expect(info.detail).toBe('In this Electron app, locate…')
  })

  it('recovers complete fields from a truncated preview', () => {
    // The provider caps the preview mid-string — JSON.parse fails, but the
    // complete description pair must still surface.
    const info = externalToolInfo(
      'Task',
      '{"description":"Find chat rename and sort code","prompt":"In this Electron app (pide…',
    )
    expect(info.isAgent).toBe(true)
    expect(info.headline).toBe('Find chat rename and sort code')
  })

  it('unescapes JSON escapes in recovered fields', () => {
    const info = externalToolInfo('WebSearch', '{"query":"say \\"hi\\""}')
    expect(info.headline).toBe('say "hi"')
  })

  it('picks a meaningful headline for ordinary tools and tolerates no args', () => {
    expect(externalToolInfo('WebSearch', '{"query":"pygame docs"}').headline).toBe('pygame docs')
    expect(externalToolInfo('ListAgents').headline).toBeUndefined()
    expect(externalToolInfo('ListAgents').isAgent).toBe(false)
  })

  /**
   * Real captures from a live lane, where 6 of 9 rows rendered as a bare
   * "Claude Code Bash" with no command. `Bash` carries ONE argument, so when
   * the provider's cap lands inside it there is no complete `"key":"value"`
   * pair left for the pair scan and the row loses its entire content.
   */
  describe('a value the preview cap cut through', () => {
    it('recovers the partial command when nothing else survived', () => {
      const info = externalToolInfo(
        'Bash',
        '{"command":"grep -n \\"bundledExtensions\\" -A 30 electron/ipc/pi-session-handlers.ts | head -60; echo ---; grep -rn \\"isO\u2026',
      )
      expect(info.fields['command']).toContain('bundledExtensions')
      expect(info.fields['command']).toContain('head -60')
      // Escapes inside the surviving part still read naturally.
      expect(info.fields['command']).not.toContain('\\"')
      expect(info.headline).toBe(info.fields['command'])
    })

    it('does not let a partial value overwrite a complete one', () => {
      const info = externalToolInfo(
        'Task',
        '{"description":"Find rename code","prompt":"In this Electron app (pide\u2026',
      )
      expect(info.headline).toBe('Find rename code')
      expect(info.fields['prompt']).toContain('In this Electron app')
    })

    it('survives a cut mid-escape rather than throwing', () => {
      // A lone trailing backslash, and a half-written \\uXXXX.
      expect(externalToolInfo('Bash', '{"command":"echo hi \\').fields['command']).toBe('echo hi ')
      expect(externalToolInfo('Bash', '{"command":"echo \\u26').fields['command']).toBe('echo ')
      // An EVEN number of trailing backslashes is a complete escape: keep it.
      expect(externalToolInfo('Bash', '{"command":"cd a\\\\').fields['command']).toBe('cd a\\')
    })

    /**
     * The wholesale-unescape regression (F9 in the tool-call audit). The cap
     * appends its ellipsis right after a backslash, so the fragment ends in
     * the invalid escape `\…`. The old JSON.parse round-trip threw on it and
     * returned the WHOLE string raw — every `\n` in a long command rendered
     * as two visible characters, exactly as screenshotted in a live session.
     * One bad escape costs itself now, never the rest of the string.
     */
    it('keeps unescaping the rest of the string past an invalid escape', () => {
      const info = externalToolInfo('Bash', '{"command":"cd /ws/review-this-session\\ngrep -n \\…')
      // The \n BEFORE the bad escape is a real newline, not two characters.
      expect(info.fields['command']).toContain('\n')
      expect(info.fields['command']).not.toContain('\\n')
      // The orphaned escape itself stays visibly literal.
      expect(info.fields['command']).toContain('\\…')
    })

    it('leaves an invalid mid-string escape literal without eating neighbours', () => {
      // \q is not a JSON escape; the \" after it must still unescape.
      const info = externalToolInfo('Bash', '{"command":"a \\q b \\"quoted\\" end"}')
      expect(info.fields['command']).toBe('a \\q b "quoted" end')
    })
  })
})

describe('summarizeExternalTool', () => {
  it('speaks pi\u2019s vocabulary for the tools pi also has', () => {
    expect(summarizeExternalTool('Bash', { command: 'npm test' })).toMatchObject({
      label: 'Ran',
      object: 'npm test',
      mono: true,
    })
    expect(summarizeExternalTool('Read', { file_path: '/a/b/ChatView.tsx' })).toMatchObject({
      label: 'Read',
      object: 'ChatView.tsx',
    })
    expect(summarizeExternalTool('Grep', { pattern: 'TODO' })).toMatchObject({
      label: 'Searched for',
      object: 'TODO',
      mono: true,
    })
    expect(summarizeExternalTool('Write', { file_path: '/a/b/new.ts' })).toMatchObject({
      label: 'Created',
      object: 'new.ts',
    })
  })

  it('strips the worktree prefix out of a command, exactly as pi rows do', () => {
    const summary = summarizeExternalTool(
      'Bash',
      { command: 'cd /w/.phosphor/worktrees/lane && npm test' },
      '/w/.phosphor/worktrees/lane',
    )
    expect(summary.object).toBe('npm test')
  })

  it('keeps the NAME as the emphasis for a tool pi has no verb for', () => {
    const summary = summarizeExternalTool('mcp__linear__save_issue', { description: 'ship it' })
    expect(summary.object).toBe('mcp__linear__save_issue')
    expect(summary.hint).toBe('ship it')
  })

  it('says a command ran even when the cap left nothing of it', () => {
    expect(summarizeExternalTool('Bash', {})).toMatchObject({ label: 'Ran', object: 'a command' })
  })
})

/**
 * One row per sub-agent, folded from the three markers the CLI emits for it.
 *
 * Every marker string here is copied verbatim from a real captured session
 * (pi session 01a04614, 2026-08-28), where three agents produced eight rows
 * and a strip that said "8 sub-agents were started".
 */
describe('sub-agent lifecycle folding', () => {
  const message = (role: string, content: unknown): AgentMessage =>
    ({ role, content, stopReason: 'stop' }) as unknown as AgentMessage
  const text = (t: string): unknown => ({ type: 'text', text: t })

  const agentsIn = (msgs: AgentMessage[]): SubagentBlock[] =>
    rowsFor(msgs)
      .filter((r) => r.kind === 'activity')
      .flatMap((r) => (r as { steps: ActivityStep[] }).steps)
      .map((s) => s.block)
      .filter((b): b is SubagentBlock => b.type === 'subagent')

  it('folds the model call, the start and the finish into one agent', () => {
    const agents = agentsIn([
      message('user', 'go'),
      message('assistant', [
        text(
          '[Claude Code · Agent {"description":"Dig into pi-claude-cli internals","subagent_type":"general-purpose","prompt":"Investigate how the @sacco…]',
        ),
        text(
          '[Claude Code · Task {"status":"started","description":"Dig into pi-claude-cli internals","subagent_type":"general-purpose","task_id":"a8de7d982d824b56a"}]',
        ),
      ]),
      message('assistant', [
        text(
          '[Claude Code · Task {"status":"completed","description":"Dig into pi-claude-cli internals","task_id":"a8de7d982d824b56a","tool_uses":2,"total_tokens":1234,"duration_ms":900}]',
        ),
        text('The agent found it.'),
      ]),
    ])

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      status: 'completed',
      description: 'Dig into pi-claude-cli internals',
      subagentType: 'general-purpose',
      taskId: 'a8de7d982d824b56a',
      toolUses: 2,
      totalTokens: 1234,
      durationMs: 900,
    })
    // The prompt survives from the model's own call, which is the only
    // marker that carries it.
    expect(agents[0]?.prompt).toContain('Investigate how the @sacco')
  })

  it('keeps same-named parallel agents apart', () => {
    // A fan-out routinely launches several agents under one description, and
    // pre-0.4.14 providers send no task_id to tell them apart. Each block
    // absorbs one marker per phase, so three calls stay three agents.
    const agents = agentsIn([
      message('user', 'go'),
      message('assistant', [
        text('[Claude Code · Agent {"description":"Explore","subagent_type":"Explore"}]'),
        text('[Claude Code · Agent {"description":"Explore","subagent_type":"Explore"}]'),
        text('[Claude Code · Task {"status":"started","description":"Explore"}]'),
        text('[Claude Code · Task {"status":"started","description":"Explore"}]'),
      ]),
    ])
    expect(agents).toHaveLength(2)
    expect(agents.every((a) => a.status === 'running')).toBe(true)
  })

  it('joins on task_id when descriptions collide', () => {
    const agents = agentsIn([
      message('user', 'go'),
      message('assistant', [
        text(
          '[Claude Code · Task {"status":"started","description":"Explore","task_id":"aaaaaaaaaaaaa1"}]',
        ),
        text(
          '[Claude Code · Task {"status":"started","description":"Explore","task_id":"aaaaaaaaaaaaa2"}]',
        ),
        text(
          '[Claude Code · Task {"status":"completed","description":"Explore","task_id":"aaaaaaaaaaaaa2","tool_uses":7}]',
        ),
      ]),
    ])
    expect(agents).toHaveLength(2)
    expect(agents[0]).toMatchObject({ taskId: 'aaaaaaaaaaaaa1', status: 'running' })
    expect(agents[1]).toMatchObject({ taskId: 'aaaaaaaaaaaaa2', status: 'completed', toolUses: 7 })
  })

  it('never walks a finished agent back to launched', () => {
    // Markers can arrive out of order across cycles; a stale start must not
    // undo a completion.
    const agents = agentsIn([
      message('user', 'go'),
      message('assistant', [
        text(
          '[Claude Code · Task {"status":"completed","description":"scout","task_id":"bbbbbbbbbbbb1"}]',
        ),
        text('[Claude Code · Agent {"description":"scout","prompt":"look around"}]'),
      ]),
    ])
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ status: 'completed', prompt: 'look around' })
  })

  it('does not name a row after a raw task id', () => {
    // provider 0.4.13 filled the missing description of a late notification
    // with the task id itself.
    const agents = agentsIn([
      message('user', 'go'),
      message('assistant', [
        text('[Claude Code · Task {"status":"stopped","description":"a8de7d982d824b56a"}]'),
      ]),
    ])
    expect(agents).toHaveLength(1)
    expect(agents[0]?.description).toBeUndefined()
    expect(agents[0]?.status).toBe('stopped')
  })

  it('summarizes a fan-out by agents, not by markers', () => {
    const rows = rowsFor([
      message('user', 'go'),
      message('assistant', [
        text('[Claude Code · Agent {"description":"one"}]'),
        text('[Claude Code · Task {"status":"started","description":"one"}]'),
        text('[Claude Code · Agent {"description":"two"}]'),
        text('[Claude Code · Task {"status":"started","description":"two"}]'),
        text('[Claude Code · WebSearch {"query":"x"}]'),
      ]),
    ])
    const steps = rows
      .filter((r) => r.kind === 'activity')
      .flatMap((r) => (r as { steps: ActivityStep[] }).steps)
    const summary = summarizeActivity(steps, {}, (t) => settledVerb(t.toolName ?? ''))
    expect(summary.detail).toBe('launched 2 agents, claude code 1 tool')
  })
})

describe('trailingUnfinishedAgents', () => {
  const message = (role: string, content: unknown): AgentMessage =>
    ({ role, content, stopReason: 'stop' }) as unknown as AgentMessage
  const text = (t: string): unknown => ({ type: 'text', text: t })
  const agentText = '[Claude Code · Agent {"description":"scout"}]'

  it('counts agents that never reached a terminal state', () => {
    const state = hydrateFromMessages([
      message('user', 'go'),
      message('assistant', [text(agentText), text('Launched a scout.')]),
    ])
    expect(trailingUnfinishedAgents(buildTranscriptRows(state.items))).toBe(1)
  })

  it('stays silent once the agent reports back', () => {
    // The 0.4.14 shape: the CLI keeps running, the agent finishes, and its
    // report lands in the same turn. Nothing was lost, so nothing is warned
    // about.
    const state = hydrateFromMessages([
      message('user', 'go'),
      message('assistant', [
        text('[Claude Code · Agent {"description":"scout","task_id":"cccccccccccc1"}]'),
        text(
          '[Claude Code · Task {"status":"started","description":"scout","task_id":"cccccccccccc1"}]',
        ),
        text(
          '[Claude Code · Task {"status":"completed","description":"scout","task_id":"cccccccccccc1"}]',
        ),
        text('The scout reported back.'),
      ]),
    ])
    expect(trailingUnfinishedAgents(buildTranscriptRows(state.items))).toBe(0)
  })

  it('counts a killed agent, which is the failure worth reporting', () => {
    const state = hydrateFromMessages([
      message('user', 'go'),
      message('assistant', [
        text('[Claude Code · Agent {"description":"scout"}]'),
        text('[Claude Code · Agent {"description":"other"}]'),
        text('[Claude Code · Task {"status":"started","description":"scout"}]'),
      ]),
    ])
    expect(trailingUnfinishedAgents(buildTranscriptRows(state.items))).toBe(2)
  })

  it('resets once the user replies', () => {
    const state = hydrateFromMessages([
      message('user', 'go'),
      message('assistant', [text(agentText)]),
      message('user', 'any news?'),
    ])
    expect(trailingUnfinishedAgents(buildTranscriptRows(state.items))).toBe(0)
  })

  it('ignores ordinary external tools', () => {
    const state = hydrateFromMessages([
      message('user', 'go'),
      message('assistant', [text('[Claude Code · WebSearch {"query":"x"}]')]),
    ])
    expect(trailingUnfinishedAgents(buildTranscriptRows(state.items))).toBe(0)
  })
})
