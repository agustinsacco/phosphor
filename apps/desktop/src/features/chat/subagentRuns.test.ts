import { describe, expect, it } from 'vitest'
import {
  launchedAgentCount,
  parseFleetWidget,
  parseSubagentNotice,
  scriptAgents,
  subagentCall,
  subagentRun,
  summarizeFleet,
  summarizeSubagentCall,
} from './subagentRuns'

/**
 * The shapes are a wire contract with pi-subagents, so the fixtures are
 * captured payloads (session 01a0e90a, 2026-09-28, pi-subagents 0.73.1)
 * rather than values built from a type this repo does not have.
 */

/** What a running foreground run streams on `tool_execution_update`. */
const PARTIAL = {
  mode: 'single',
  results: [
    {
      index: 0,
      agent: 'reviewer',
      task: '[prompt redacted]',
      sessionName: 'reviewer: Review the auth diff for regressions',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    },
  ],
  progress: [
    {
      index: 0,
      agent: 'reviewer',
      status: 'running',
      task: '[prompt redacted]',
      currentTool: 'read',
      currentToolArgs: 'src/auth.ts',
      recentTools: [
        { tool: 'read', args: 'SKILL.md', endMs: 1 },
        { tool: 'bash', args: 'git diff main', endMs: 2 },
      ],
      recentOutput: ['Looking at the error branch.'],
      toolCount: 3,
      turnCount: 2,
      tokens: 4200,
      durationMs: 9100,
      model: 'openai-codex/gpt-6-astra',
    },
  ],
}

/** The same run, settled. */
const FINAL = {
  mode: 'single',
  runId: 'cc0f172e-5ef7-401b-9b89-8653e3185b00',
  results: [
    {
      index: 0,
      agent: 'reviewer',
      task: '[prompt redacted]',
      sessionName: 'reviewer: Review the auth diff for regressions',
      exitCode: 0,
      usage: { input: 73153, output: 6845, cacheRead: 0, cacheWrite: 0, cost: 1.9, turns: 23 },
      model: 'openai-codex/gpt-6-astra',
      finalOutput: 'No actionable regressions.',
      sessionFile: '/Users/me/.pi/agent/sessions/x/0b48d48b-1.jsonl',
    },
  ],
  progress: [
    {
      index: 0,
      agent: 'reviewer',
      status: 'completed',
      task: '[prompt redacted]',
      recentTools: [],
      recentOutput: [],
      toolCount: 44,
      turnCount: 23,
      tokens: 79998,
      durationMs: 267277,
    },
  ],
}

describe('subagentCall', () => {
  it('reads a launch and a management action apart', () => {
    expect(subagentCall({ agent: 'reviewer', task: 'Review it', async: true })).toEqual({
      kind: 'launch',
      agent: 'reviewer',
      task: 'Review it',
      async: true,
      script: undefined,
      workflow: undefined,
    })
    expect(subagentCall({ action: 'status', id: 'cc0f172e-5ef7-401b-9b89-8653e3185b00' })).toEqual({
      kind: 'manage',
      action: 'status',
      target: 'cc0f172e-5ef7-401b-9b89-8653e3185b00',
      topic: undefined,
    })
  })

  it('names the agents a workflow script mentions, once each', () => {
    expect(
      scriptAgents(
        `const a = await runs.run("scout", { agent: "scout", task: "x" });
         await runs.all([{ key: "r1", agent: 'reviewer', task: "y" }, { key: "r2", agent: 'reviewer' }])`,
      ),
    ).toEqual(['scout', 'reviewer'])
  })
})

describe('launchedAgentCount', () => {
  it('counts reported children, else the tasks the call named, else one', () => {
    const parallel = {
      mode: 'parallel',
      progress: [0, 1, 2].map((index) => ({ index, agent: 'worker', status: 'running' })),
    }
    expect(launchedAgentCount({ tasks: [{}, {}, {}] }, parallel)).toBe(3)
    expect(launchedAgentCount({ tasks: [{}, {}, {}, {}] }, undefined)).toBe(4)
    expect(launchedAgentCount({ agent: 'scout', task: 't' }, PARTIAL)).toBe(1)
    expect(launchedAgentCount({ agent: 'scout', async: true }, { background: true })).toBe(1)
    expect(launchedAgentCount(undefined, 'not details')).toBe(1)
  })
})

describe('subagentRun', () => {
  it('joins the streamed progress onto the child while it runs', () => {
    const run = subagentRun(PARTIAL, false)!
    expect(run.children).toHaveLength(1)
    expect(run.children[0]).toMatchObject({
      agent: 'reviewer',
      label: 'Review the auth diff for regressions',
      status: 'running',
      currentTool: 'read src/auth.ts',
      recentTools: ['read SKILL.md', 'bash git diff main'],
      recentOutput: ['Looking at the error branch.'],
      toolCount: 3,
      tokens: 4200,
      model: 'openai-codex/gpt-6-astra',
    })
    // A cost of zero is no cost, not a $0 line.
    expect(run.children[0]!.costUsd).toBeUndefined()
  })

  it('reads the verdict from the result once the tool settled', () => {
    const run = subagentRun(FINAL, true)!
    expect(run.runId).toBe('cc0f172e-5ef7-401b-9b89-8653e3185b00')
    expect(run.async).toBe(false)
    expect(run.children[0]).toMatchObject({
      status: 'completed',
      output: 'No actionable regressions.',
      toolCount: 44,
      tokens: 79998,
      costUsd: 1.9,
      durationMs: 267277,
      sessionFile: '/Users/me/.pi/agent/sessions/x/0b48d48b-1.jsonl',
    })
  })

  it('calls a non-zero exit a failure and a stop a stop', () => {
    const failed = { ...FINAL, results: [{ ...FINAL.results[0], exitCode: 1, error: 'boom' }] }
    expect(subagentRun(failed, true)!.children[0]!.status).toBe('failed')
    const stopped = { ...FINAL, results: [{ ...FINAL.results[0], stopped: true }] }
    expect(subagentRun(stopped, true)!.children[0]!.status).toBe('stopped')
  })

  it('recognises a detached launch, which has no children of its own', () => {
    const run = subagentRun(
      {
        mode: 'single',
        runId: 'cc0f172e-5ef7-401b-9b89-8653e3185b00',
        asyncId: 'cc0f172e-5ef7-401b-9b89-8653e3185b00',
        results: [],
        timeoutMs: 2700000,
      },
      true,
    )!
    expect(run.async).toBe(true)
    expect(run.children).toEqual([])
    expect(run.timeoutMs).toBe(2700000)
  })

  it('reads the agent catalogue from a list action', () => {
    const run = subagentRun(
      {
        mode: 'management',
        results: [],
        agentCapabilities: {
          agents: [
            { name: 'reviewer', description: 'Reviews', source: 'builtin', executable: true },
            {
              name: 'codex-exec',
              source: 'builtin',
              executable: true,
              runner: { available: false, unavailableReason: "'codex' was not found on PATH." },
              model: { value: 'inherit' },
            },
          ],
        },
      },
      true,
    )!
    expect(run.agents).toEqual([
      {
        name: 'reviewer',
        description: 'Reviews',
        source: 'builtin',
        model: undefined,
        available: true,
        unavailableReason: undefined,
      },
      {
        name: 'codex-exec',
        description: undefined,
        source: 'builtin',
        model: 'inherit',
        available: false,
        unavailableReason: "'codex' was not found on PATH.",
      },
    ])
  })

  it('returns null for details it cannot read', () => {
    expect(subagentRun(undefined, true)).toBeNull()
    expect(subagentRun('text', true)).toBeNull()
  })
})

describe('summarizeSubagentCall', () => {
  it('reads "Delegating to reviewer · read src/auth.ts · 3 tools" while it runs', () => {
    const call = subagentCall({ agent: 'reviewer', task: 'Review it' })
    expect(summarizeSubagentCall(call, subagentRun(PARTIAL, false), true)).toEqual({
      label: 'Delegating to',
      object: 'reviewer',
      hint: 'read src/auth.ts · 3 tools',
    })
  })

  it('reads what it cost once it settled', () => {
    const call = subagentCall({ agent: 'reviewer', task: 'Review it' })
    expect(summarizeSubagentCall(call, subagentRun(FINAL, true), false)).toEqual({
      label: 'Delegated to',
      object: 'reviewer',
      hint: '44 tools · 80.0k tokens · 4m 27s',
    })
  })

  it('says a background launch is one, and names the workflow agents', () => {
    expect(
      summarizeSubagentCall(subagentCall({ agent: 'scout', task: 'x', async: true }), null, false),
    ).toEqual({ label: 'Started', object: 'scout', hint: 'in background' })
    expect(
      summarizeSubagentCall(
        subagentCall({
          workflowScript: 'runs.run("a", { agent: "scout" }); runs.run("b", { agent: "worker" })',
        }),
        null,
        true,
      ),
    ).toEqual({ label: 'Running workflow', object: 'scout · worker', hint: undefined })
  })

  it('gives management actions their own verbs', () => {
    expect(summarizeSubagentCall(subagentCall({ action: 'list' }), null, false)).toEqual({
      label: 'Listed',
      object: 'agents',
    })
    expect(
      summarizeSubagentCall(
        subagentCall({ action: 'stop', id: 'cc0f172e-5ef7-401b-9b89-8653e3185b00' }),
        null,
        false,
      ),
    ).toEqual({ label: 'Stopped', object: 'cc0f172e' })
    expect(
      summarizeSubagentCall(subagentCall({ action: 'guide', topic: 'workflows' }), null, false),
    ).toEqual({ label: 'Read the guide on', object: 'workflows' })
  })
})

describe('parseFleetWidget', () => {
  // The line that was printed verbatim above the composer.
  const CAPTURED =
    'PI_SUBAGENT_ASYNC_JSON:' +
    JSON.stringify({
      kind: 'pi-subagents.async-status-snapshot',
      version: 1,
      generatedAt: 1790622703762,
      caps: {
        maxRuns: 20,
        maxChildrenPerNode: 8,
        maxDepth: 3,
        maxStringLength: 160,
        maxSerializedBytes: 32768,
      },
      omitted: { runs: 0, children: 0, byteLimitExceeded: false },
      runs: [
        {
          id: 'cc0f172e-5ef7-401b-9b89-8653e3185b00',
          kind: 'subagent',
          label: 'delegate',
          state: 'running',
          startedAt: 1790622610420,
          updatedAt: 1790622698492,
          activity: { lastActivityAt: 1790622698433, turnCount: 12, toolCount: 17 },
          children: [
            {
              id: 'step:0',
              kind: 'step',
              label: 'delegate',
              state: 'running',
              startedAt: 1790622610422,
              activity: {
                currentTool: 'bash',
                lastActivityAt: 1790622698433,
                turnCount: 12,
                toolCount: 17,
              },
            },
          ],
        },
      ],
    })

  it('reads the tree, and finds the running tool down in the step', () => {
    const fleet = parseFleetWidget([CAPTURED])!
    expect(fleet.active).toBe(1)
    expect(fleet.runs[0]).toMatchObject({ label: 'delegate', state: 'running', toolCount: 17 })
    expect(fleet.runs[0]!.children[0]).toMatchObject({ id: 'step:0', currentTool: 'bash' })
    expect(summarizeFleet(fleet)).toBe('1 background run active · delegate · bash')
  })

  it('does not conflate inactivity with success', () => {
    const done = CAPTURED.replace(/"state":"running"/g, '"state":"complete"')
    expect(summarizeFleet(parseFleetWidget([done])!)).toBe('No background runs active')
  })

  it('renders nothing for another widget, a future version, or broken JSON', () => {
    expect(parseFleetWidget(undefined)).toBeNull()
    expect(parseFleetWidget(['async subagent worker · background'])).toBeNull()
    expect(
      parseFleetWidget(['PI_SUBAGENT_ASYNC_JSON:{"kind":"x","version":1,"runs":[]}']),
    ).toBeNull()
    expect(parseFleetWidget(['PI_SUBAGENT_ASYNC_JSON:{nope'])).toBeNull()
  })
})

describe('parseSubagentNotice', () => {
  it('reads who finished, how, and keeps the output as the body', () => {
    const notice = parseSubagentNotice(
      'subagent-notify',
      'Background task completed: **delegate**\n\ndelegate:\n# PR review\n\nNo findings.',
    )!
    expect(notice).toMatchObject({
      kind: 'completion',
      status: 'completed',
      agents: ['delegate'],
      headline: 'delegate finished in the background',
    })
    expect(notice.body).toBe('delegate:\n# PR review\n\nNo findings.')
  })

  it('reads a grouped completion and a failure', () => {
    expect(
      parseSubagentNotice(
        'subagent-notify',
        'Background tasks completed (2): **scout**, **reviewer**\n\n1. scout\n…',
      ),
    ).toMatchObject({
      agents: ['scout', 'reviewer'],
      headline: 'scout, reviewer finished in the background',
    })
    expect(
      parseSubagentNotice('subagent-notify', 'Detached foreground task failed: **worker**\n\nboom'),
    ).toMatchObject({ status: 'failed', headline: 'worker failed after detaching' })
  })

  it('keeps an unfamiliar header as the headline rather than inventing a status', () => {
    const notice = parseSubagentNotice('subagent-notify', 'Something else: **x**\nbody')!
    expect(notice).toMatchObject({
      kind: 'completion',
      headline: 'Something else: x',
      body: 'body',
    })
    expect(notice.status).toBeUndefined()
  })

  it('treats the control and steering notices as their own kinds, and nothing else at all', () => {
    expect(
      parseSubagentNotice('subagent_control_notice', 'delegate needs attention\n\nIdle for 10m.'),
    ).toMatchObject({
      kind: 'attention',
      headline: 'delegate needs attention',
      body: 'Idle for 10m.',
    })
    expect(parseSubagentNotice('subagent_steering_notice', 'Steer delivered')).toMatchObject({
      kind: 'steering',
    })
    expect(parseSubagentNotice('other', 'x')).toBeNull()
  })
})
