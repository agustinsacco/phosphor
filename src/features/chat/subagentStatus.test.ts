import { describe, expect, it } from 'vitest'
import { findLiveSubagent, parseSubagentStatus, summarizeSubagents } from './subagentStatus'

/**
 * The payload is a wire contract from another repo, so the tests are written
 * against captured strings rather than against a type. The first one below is
 * what actually reached the status strip in the incident that motivated this:
 * the whole JSON blob was printed verbatim along the bottom of the window,
 * because the key was not registered as structured.
 */
describe('parseSubagentStatus', () => {
  const CAPTURED = JSON.stringify({
    tasks: [
      {
        taskId: 'a8de7d982d824b56a',
        description: 'Dig into pi-claude-cli internals',
        subagentType: 'general-purpose',
        status: 'running',
        currentStep: 'Running Read stream-parser.ts',
      },
      {
        taskId: 'a600d45bcde2ddb13',
        description: 'Map phosphor/pi dialog surfaces',
        subagentType: 'Explore',
        status: 'completed',
        toolUses: 12,
        totalTokens: 48210,
        durationMs: 91000,
      },
    ],
    active: 1,
    completed: 1,
  })

  it('reads the tasks, the live step and the cost', () => {
    const snapshot = parseSubagentStatus(CAPTURED)!
    expect(snapshot.tasks).toHaveLength(2)
    expect(snapshot.tasks[0]).toMatchObject({
      taskId: 'a8de7d982d824b56a',
      status: 'running',
      currentStep: 'Running Read stream-parser.ts',
    })
    expect(snapshot.tasks[1]).toMatchObject({ toolUses: 12, totalTokens: 48210, durationMs: 91000 })
  })

  it('recomputes the counts rather than trusting them', () => {
    // Two sources for one number is two chances to disagree; the array is the
    // one this side renders.
    const lying = JSON.stringify({
      tasks: [{ taskId: 'a', status: 'running' }],
      active: 7,
      completed: 9,
    })
    expect(parseSubagentStatus(lying)).toMatchObject({ active: 1, completed: 0 })
  })

  it('renders nothing for a payload it cannot trust', () => {
    expect(parseSubagentStatus(undefined)).toBeNull()
    expect(parseSubagentStatus('')).toBeNull()
    expect(parseSubagentStatus('not json')).toBeNull()
    expect(parseSubagentStatus('[]')).toBeNull()
    expect(parseSubagentStatus('{"tasks":"soon"}')).toBeNull()
    // An empty snapshot is how the provider says "the turn is over".
    expect(parseSubagentStatus('{"tasks":[],"active":0,"completed":0}')).toBeNull()
    // Entries with no id are unusable; a payload of only those is nothing.
    expect(parseSubagentStatus('{"tasks":[{"status":"running"}]}')).toBeNull()
  })

  it('summarizes the run in one line, with the newest live step', () => {
    expect(summarizeSubagents(parseSubagentStatus(CAPTURED)!)).toBe(
      '1 agent running · Running Read stream-parser.ts',
    )
  })

  it('says done once nothing is running', () => {
    const finished = JSON.stringify({
      tasks: [
        { taskId: 'a', status: 'completed' },
        { taskId: 'b', status: 'stopped' },
      ],
    })
    expect(summarizeSubagents(parseSubagentStatus(finished)!)).toBe('2 agents done')
  })

  it('reads the last tool name, which outlives the step', () => {
    const between = JSON.stringify({
      tasks: [{ taskId: 'a', status: 'running', lastToolName: 'Read' }],
    })
    expect(parseSubagentStatus(between)!.tasks[0]).toMatchObject({
      lastToolName: 'Read',
      currentStep: undefined,
    })
  })
})

/**
 * The join a transcript row makes to find its own live state. Every agent in a
 * fan-out has a step; the strip renders one of them, so before this the other
 * seven were parsed and dropped.
 */
describe('findLiveSubagent', () => {
  const RUNNING = JSON.stringify({
    tasks: [
      { taskId: 'a1', status: 'running', currentStep: 'Running Read TRACKER.md', toolUses: 4 },
      { taskId: 'a2', status: 'running', lastToolName: 'Grep' },
    ],
  })

  it('finds an agent by its task id', () => {
    expect(findLiveSubagent(RUNNING, 'a1')).toMatchObject({
      currentStep: 'Running Read TRACKER.md',
      toolUses: 4,
    })
    expect(findLiveSubagent(RUNNING, 'a2')).toMatchObject({ lastToolName: 'Grep' })
  })

  it('has nothing to say without both halves of the join', () => {
    expect(findLiveSubagent(RUNNING, undefined)).toBeUndefined()
    expect(findLiveSubagent(RUNNING, 'nobody')).toBeUndefined()
    // The provider CLEARS the key when the episode ends. A row must fall back
    // to its markers rather than blank out.
    expect(findLiveSubagent(undefined, 'a1')).toBeUndefined()
    expect(findLiveSubagent('not json', 'a1')).toBeUndefined()
  })

  it('re-parses when the payload changes', () => {
    // The memo is keyed on the exact string; a stale hit here would freeze
    // every row's step at the first tick of the turn.
    expect(findLiveSubagent(RUNNING, 'a1')?.currentStep).toBe('Running Read TRACKER.md')
    const moved = JSON.stringify({
      tasks: [{ taskId: 'a1', status: 'running', currentStep: 'Running Bash npm test' }],
    })
    expect(findLiveSubagent(moved, 'a1')?.currentStep).toBe('Running Bash npm test')
    expect(findLiveSubagent(RUNNING, 'a1')?.currentStep).toBe('Running Read TRACKER.md')
  })
})
