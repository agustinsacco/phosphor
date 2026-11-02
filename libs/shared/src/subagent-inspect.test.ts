import { describe, expect, it } from 'vitest'
import { parseSubagentInspectRequest, subagentInspectPrompt } from './subagent-inspect'

const requestId = '2f1c7a3e-9b2d-4c1a-8e5f-0a1b2c3d4e5f'

describe('subagent inspection requests', () => {
  it('builds the one fixed command, with or without a child', () => {
    expect(subagentInspectPrompt({ requestId, runId: 'run-1' })).toBe(
      `/subagents-inspect-rpc ${requestId} run-1 --lines 100`,
    )
    expect(subagentInspectPrompt({ requestId, runId: 'run-1', childId: 'step:0' })).toBe(
      `/subagents-inspect-rpc ${requestId} run-1 step:0 --lines 100`,
    )
  })

  it('keeps only the fields it knows', () => {
    expect(parseSubagentInspectRequest({ requestId, runId: 'run-1', extra: 'x' })).toEqual({
      requestId,
      runId: 'run-1',
    })
    expect(parseSubagentInspectRequest({ requestId, runId: 'run-1', childId: 'c' })).toEqual({
      requestId,
      runId: 'run-1',
      childId: 'c',
    })
  })

  it.each([
    ['no object', null],
    ['an array', [requestId, 'run']],
    ['a request id pi-subagents refuses', { requestId: 'a b', runId: 'run' }],
    ['a long request id', { requestId: 'a'.repeat(65), runId: 'run' }],
    ['no run', { requestId }],
    ['an empty run', { requestId, runId: '' }],
    ['a run that splits into two arguments', { requestId, runId: 'run --lines 9999' }],
    ['a run that splits on a line separator', { requestId, runId: 'run\u2028x' }],
    ['a run that is a flag', { requestId, runId: '--lines' }],
    ['a long run', { requestId, runId: 'r'.repeat(257) }],
    ['an empty child', { requestId, runId: 'run', childId: '' }],
    ['a child that is a flag', { requestId, runId: 'run', childId: '--json' }],
    ['a child that is not text', { requestId, runId: 'run', childId: 3 }],
  ])('refuses %s', (_name, value) => {
    expect(parseSubagentInspectRequest(value)).toBeNull()
  })
})
