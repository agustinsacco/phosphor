import { describe, expect, it, vi } from 'vitest'
import artifactsExtension from './artifacts'
import { ARTIFACT_ENTRY_TYPE } from './artifact-store'

type Handler = (event: unknown, ctx: unknown) => unknown

interface ToolLike {
  execute(
    toolCallId: string,
    params: never,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ): Promise<{ content: Array<{ type: 'text'; text: string }> }>
}

/** The extension loaded into a fake pi that records hooks, tools and appended entries. */
function load(options: { appendEntry?: boolean; failAppend?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>()
  const appended: Array<{ type: string; data: unknown }> = []
  const tools = new Map<string, ToolLike>()
  const api: Record<string, unknown> = {
    registerTool: (definition: Record<string, unknown>) =>
      void tools.set(String(definition.name), definition as unknown as ToolLike),
    registerCommand: () => {},
    on: (event: string, handler: Handler) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  }
  if (options.appendEntry !== false)
    api.appendEntry = (type: string, data: unknown): void => {
      if (options.failAppend) throw new Error('session file is not writable')
      appended.push({ type, data })
    }
  artifactsExtension(api as unknown as Parameters<typeof artifactsExtension>[0])
  const emit = (event: string, payload: object = {}): void => {
    for (const handler of handlers.get(event) ?? []) handler({ type: event, ...payload }, {})
  }
  return {
    emit,
    appended,
    call: (name: string, params: object, toolCallId: string) =>
      tools.get(name)!.execute(toolCallId, params as never),
  }
}

const CREATE = { title: 'NVDA', type: 'markdown', content: '# hi' }
const RECORD = { id: 'nvda', title: 'NVDA', type: 'markdown', content: '# hi' }
/** pi's id for a call a codemode script made: `<the script's id>/<n>`. */
const NESTED = 'toolu_1/2'

const nestedEnd = (extra: Record<string, unknown> = {}) => ({
  toolCallId: NESTED,
  toolName: 'artifact_create',
  isError: false,
  parentToolCallId: 'toolu_1',
  result: { content: [], details: { ...RECORD, version: 1 } },
  ...extra,
})

describe('an artifact write a script made', () => {
  it('is saved from the tool itself, with no event from pi', async () => {
    const pi = load()
    await pi.call('artifact_create', CREATE, NESTED)
    // Nothing yet: pi appends the script's result after the turn's tool calls, and an
    // entry before it would sit between a tool call and its result.
    expect(pi.appended).toEqual([])
    pi.emit('turn_end')
    expect(pi.appended).toEqual([
      {
        type: ARTIFACT_ENTRY_TYPE,
        data: { ...RECORD, version: 1, toolCallId: NESTED },
      },
    ])
  })

  it('is saved once when the tool and pi’s event both report it', async () => {
    const pi = load()
    await pi.call('artifact_create', CREATE, NESTED)
    pi.emit('tool_execution_end', nestedEnd())
    pi.emit('turn_end')
    expect(pi.appended).toHaveLength(1)
  })

  it('is saved at agent_end too, for a run that ends without a turn_end', async () => {
    const pi = load()
    await pi.call('artifact_create', CREATE, NESTED)
    await pi.call('artifact_update', { id: 'nvda', content: '# twice' }, 'toolu_1/3')
    pi.emit('agent_end')
    expect(pi.appended.map((e) => e.data)).toMatchObject([
      { id: 'nvda', version: 1, toolCallId: NESTED },
      { id: 'nvda', version: 2, toolCallId: 'toolu_1/3' },
    ])
  })

  it('leaves a model-issued write to the tool result pi persists', async () => {
    const pi = load()
    await pi.call('artifact_create', CREATE, 'toolu_1')
    pi.emit('turn_end')
    expect(pi.appended).toEqual([])
  })

  it('still saves a write pi reported, whatever its call id looks like', () => {
    const pi = load()
    pi.emit('tool_execution_end', nestedEnd({ toolCallId: 'reported' }))
    pi.emit('turn_end')
    expect(pi.appended).toHaveLength(1)
  })

  it('leaves failed, unread and model-issued events alone', () => {
    const pi = load()
    pi.emit('tool_execution_end', nestedEnd({ parentToolCallId: undefined }))
    pi.emit('tool_execution_end', nestedEnd({ isError: true }))
    pi.emit('tool_execution_end', nestedEnd({ toolName: 'artifact_read' }))
    pi.emit('tool_execution_end', nestedEnd({ result: { details: {} } }))
    pi.emit('turn_end')
    expect(pi.appended).toEqual([])
  })

  it('refuses a scripted write this Pi cannot save, rather than losing it', async () => {
    const pi = load({ appendEntry: false })
    await expect(pi.call('artifact_create', CREATE, NESTED)).rejects.toThrow(/cannot save/)
    pi.emit('turn_end')
    expect(pi.appended).toEqual([])
  })

  it('says so when Pi refuses the entry, instead of failing in silence', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pi = load({ failAppend: true })
    await pi.call('artifact_create', CREATE, NESTED)
    pi.emit('turn_end')
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(NESTED))
    // A failed save is not retried into a later turn, where it would land out of order.
    pi.emit('turn_end')
    expect(errors).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })
})
