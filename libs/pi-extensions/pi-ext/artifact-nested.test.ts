import { describe, expect, it } from 'vitest'
import artifactsExtension from './artifacts'
import { ARTIFACT_ENTRY_TYPE } from './artifact-store'

type Handler = (event: unknown, ctx: unknown) => unknown

/** The extension loaded into a fake pi that records hooks and appended entries. */
function load() {
  const handlers = new Map<string, Handler[]>()
  const appended: Array<{ type: string; data: unknown }> = []
  artifactsExtension({
    registerTool: () => {},
    registerCommand: () => {},
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: (type, data) => appended.push({ type, data }),
  })
  const emit = (event: string, payload: object = {}): void => {
    for (const handler of handlers.get(event) ?? []) handler({ type: event, ...payload }, {})
  }
  return { emit, appended }
}

const details = { id: 'nvda-position-month', title: 'NVDA', type: 'html', content: '<p/>' }
const end = (extra: Record<string, unknown>) => ({
  toolCallId: 'toolu_1/2',
  toolName: 'artifact_create',
  isError: false,
  result: { content: [], details: { ...details, version: 1 } },
  ...extra,
})

describe('artifact writes a tool made through ctx.executeTool()', () => {
  it('are saved as artifact entries once the turn has appended its results', () => {
    const pi = load()
    pi.emit('tool_execution_end', end({ parentToolCallId: 'toolu_1' }))
    // pi appends the caller's tool result after this point; an entry now would
    // sit between the assistant's tool call and its result.
    expect(pi.appended).toEqual([])
    pi.emit('turn_end')
    expect(pi.appended).toEqual([{ type: ARTIFACT_ENTRY_TYPE, data: { ...details, version: 1 } }])
    pi.emit('turn_end')
    expect(pi.appended).toHaveLength(1)
  })

  it('also saves at agent_end, for a run that ends without a turn_end', () => {
    const pi = load()
    pi.emit('tool_execution_end', end({ parentToolCallId: 'toolu_1', toolName: 'artifact_edit' }))
    pi.emit('agent_end')
    expect(pi.appended).toHaveLength(1)
  })

  it('leaves model-issued, failed and non-writing calls to pi’s own tool results', () => {
    const pi = load()
    pi.emit('tool_execution_end', end({}))
    pi.emit('tool_execution_end', end({ parentToolCallId: 'toolu_1', isError: true }))
    pi.emit('tool_execution_end', end({ parentToolCallId: 'toolu_1', toolName: 'artifact_read' }))
    pi.emit('tool_execution_end', end({ parentToolCallId: 'toolu_1', result: { details: {} } }))
    pi.emit('turn_end')
    expect(pi.appended).toEqual([])
  })
})
