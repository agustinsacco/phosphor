import { describe, expect, it } from 'vitest'
import { parseSubagentStatus, summarizeSubagents } from './subagentStatus'

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
})
