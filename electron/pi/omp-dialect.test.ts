import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '@shared/rpc'
import {
  decodeOmpFrame,
  encodeOmpCommand,
  offersProtocolV2,
  OmpChunkDecoder,
  OmpEndedTools,
  ompCommandsToSlashCommands,
  ompRpcArgs,
  ompSubagentSnapshots,
  type OmpAvailableCommand,
} from './omp-dialect'

describe('ompCommandsToSlashCommands', () => {
  it('files each omp source under the menu section it behaves like', () => {
    const rows = ompCommandsToSlashCommands([
      { name: 'compact', description: 'Compact', source: 'builtin' },
      { name: 'skill:save', description: 'Save', source: 'skill' },
      { name: 'review', source: 'file' },
      { name: 'mcp__docs__ask', source: 'mcp_prompt' },
      { name: 'deploy', source: 'custom' },
      { name: 'plan', source: 'extension' },
    ])
    expect(rows.map((row) => [row.name, row.source])).toEqual([
      ['compact', 'extension'],
      ['skill:save', 'skill'],
      ['review', 'prompt'],
      ['mcp__docs__ask', 'prompt'],
      ['deploy', 'extension'],
      ['plan', 'extension'],
    ])
  })

  it('emits aliases as rows sharing the builtin path, so the menu folds them', () => {
    const rows = ompCommandsToSlashCommands([
      { name: 'exit', aliases: ['quit'], description: 'Exit', source: 'builtin' },
      { name: 'skill:x', aliases: ['x'], description: 'X', source: 'skill' },
    ])
    expect(rows.map((row) => row.name)).toEqual(['exit', 'quit', 'skill:x', 'x'])
    expect(rows[0]!.sourceInfo).toEqual(rows[1]!.sourceInfo)
    expect(rows[0]!.sourceInfo?.source).toBe('omp')
    // Only builtins claim to be built in; a skill has no invented provenance.
    expect(rows[2]!.sourceInfo).toBeUndefined()
  })
})

describe('encodeOmpCommand', () => {
  const response = (command: string, data: unknown): RpcResponse =>
    ({ type: 'response', id: 'px-1', command, success: true, data }) as RpcResponse

  it('asks omp for get_available_commands and answers as get_commands', () => {
    const { wire, decode } = encodeOmpCommand({ type: 'get_commands' })
    expect(wire.type).toBe('get_available_commands')
    const commands: OmpAvailableCommand[] = [
      { name: 'skill:save', description: 'Save', source: 'skill' },
    ]
    const decoded = decode!(response('get_available_commands', { commands }))
    expect(decoded).toMatchObject({
      command: 'get_commands',
      success: true,
      data: { commands: [{ name: 'skill:save', source: 'skill', description: 'Save' }] },
    })
  })

  it('keeps a failed command-list answer a failure', () => {
    const { decode } = encodeOmpCommand({ type: 'get_commands' })
    const failed = decode!({
      type: 'response',
      id: 'px-1',
      command: 'get_available_commands',
      success: false,
      error: 'boom',
    } as RpcResponse)
    expect(failed).toMatchObject({ command: 'get_commands', success: false, error: 'boom' })
  })

  it('rewinds with branch and reads its reply as fork', () => {
    const { wire, decode } = encodeOmpCommand({ type: 'fork', entryId: 'e1' })
    expect(wire).toEqual({ type: 'branch', entryId: 'e1' })
    expect(decode!(response('branch', { text: 'hi', cancelled: false }))).toMatchObject({
      command: 'fork',
      data: { text: 'hi', cancelled: false },
    })
  })

  it('reads omp queuedMessageCount as pendingMessageCount', () => {
    const { decode } = encodeOmpCommand({ type: 'get_state' })
    const state = decode!(response('get_state', { sessionId: 's', queuedMessageCount: 2 }))
    expect(state.success && state.data).toMatchObject({ pendingMessageCount: 2 })
  })

  it('passes every other command through untouched', () => {
    const command = { type: 'abort' } as const
    expect(encodeOmpCommand(command)).toEqual({ wire: command })
  })
})

describe('decodeOmpFrame', () => {
  it('drops frames with no pi counterpart', () => {
    expect(decodeOmpFrame({ type: 'available_commands_update', commands: [] })).toBeNull()
    expect(decodeOmpFrame({ type: 'prompt_result' })).toBeNull()
  })

  it('reads session_settled as agent_settled', () => {
    expect(decodeOmpFrame({ type: 'session_settled' })).toEqual({ type: 'agent_settled' })
  })

  it('marks a non-terminal agent_end as retrying, and leaves a terminal one alone', () => {
    expect(decodeOmpFrame({ type: 'agent_end', isTerminal: false })).toMatchObject({
      willRetry: true,
    })
    expect(decodeOmpFrame({ type: 'agent_end', isTerminal: true })).toEqual({
      type: 'agent_end',
      isTerminal: true,
    })
  })
})

describe('ompRpcArgs', () => {
  it('resumes with --resume and leaves out the flags omp would exit on', () => {
    expect(
      ompRpcArgs({
        cwd: '/w',
        sessionPath: '/s.jsonl',
        sessionId: 'id',
        name: 'n',
        noContextFiles: true,
        model: 'm',
        extensions: ['/a.ts'],
      }),
    ).toEqual(['--mode', 'rpc', '--resume', '/s.jsonl', '--model', 'm', '-e', '/a.ts'])
  })

  it('refuses a launch-time fork instead of silently starting fresh', () => {
    expect(() => ompRpcArgs({ cwd: '/w', forkFrom: '/s.jsonl' })).toThrow(/fork/)
  })
})

describe('offersProtocolV2', () => {
  it('upgrades only when the ready frame lists 2', () => {
    expect(
      offersProtocolV2({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] }),
    ).toBe(true)
    expect(
      offersProtocolV2({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1] }),
    ).toBe(false)
    expect(offersProtocolV2({ type: 'ready', protocolVersion: 1 })).toBe(false)
  })
})

describe('ompSubagentSnapshots', () => {
  const answer = (data: unknown): RpcResponse =>
    ({ type: 'response', command: 'get_subagents', success: true, data }) as RpcResponse

  it('keeps the rows that name a subagent', () => {
    const row = { id: 'ListSrc', index: 1, agent: 'scout', status: 'running' }
    expect(ompSubagentSnapshots(answer({ subagents: [row, null, { index: 2 }, 'x'] }))).toEqual([
      row,
    ])
  })

  it('reads a failure or a malformed answer as none running', () => {
    const failed = {
      type: 'response',
      command: 'get_subagents',
      success: false,
      error: 'Unknown command: get_subagents',
    } as RpcResponse
    expect(ompSubagentSnapshots(failed)).toEqual([])
    expect(ompSubagentSnapshots(answer(undefined))).toEqual([])
    expect(ompSubagentSnapshots(answer({ subagents: {} }))).toEqual([])
  })
})

describe('OmpEndedTools', () => {
  it('drops an update only once its call ended', () => {
    const ended = new OmpEndedTools()
    const update = { type: 'tool_execution_update', toolCallId: 't1' }
    expect(ended.admit(update)).toBe(true)
    expect(ended.admit({ type: 'tool_execution_end', toolCallId: 't1' })).toBe(true)
    expect(ended.admit(update)).toBe(false)
    expect(ended.admit({ type: 'tool_execution_update', toolCallId: 't2' })).toBe(true)
    expect(ended.admit({ type: 'agent_end' })).toBe(true)
  })

  it('forgets the oldest call past its bound', () => {
    const ended = new OmpEndedTools()
    for (let i = 0; i <= 256; i++) ended.admit({ type: 'tool_execution_end', toolCallId: `t${i}` })
    expect(ended.admit({ type: 'tool_execution_update', toolCallId: 't0' })).toBe(true)
    expect(ended.admit({ type: 'tool_execution_update', toolCallId: 't256' })).toBe(false)
  })
})

describe('OmpChunkDecoder', () => {
  /** A logical frame split the way omp splits it, into `size`-byte slices. */
  function chunk(frame: unknown, size: number, chunkId = 'rpc-1'): Record<string, unknown>[] {
    const bytes = Buffer.from(JSON.stringify(frame), 'utf8')
    const count = Math.ceil(bytes.length / size)
    return Array.from({ length: count }, (_, index) => ({
      type: 'rpc_chunk',
      chunkId,
      index,
      count,
      byteLength: bytes.length,
      data: bytes.subarray(index * size, (index + 1) * size).toString('base64'),
    }))
  }
  const frame = {
    type: 'response',
    id: 'px-1',
    success: true,
    data: { text: 'héllo wörld'.repeat(20) },
  }
  const feed = (decoder: OmpChunkDecoder, records: Record<string, unknown>[]) =>
    records.map((record) => decoder.push(record))

  it('reassembles an in-order run, even when a slice splits a character', () => {
    // 7-byte slices cut through the two-byte é and ö.
    const results = feed(new OmpChunkDecoder(1 << 20), chunk(frame, 7))
    expect(results.slice(0, -1).every((r) => r.frame === null && !r.error)).toBe(true)
    expect(results.at(-1)).toEqual({ frame })
  })

  it('passes ordinary frames straight through', () => {
    const record = { type: 'agent_start' }
    expect(new OmpChunkDecoder(1 << 20).push(record)).toEqual({ frame: record })
  })

  it('rejects a run that skips or reorders an index', () => {
    const chunks = chunk(frame, 16)
    const results = feed(new OmpChunkDecoder(1 << 20), [chunks[0]!, chunks[2]!, chunks[1]!])
    expect(results[1]!.error?.message).toMatch(/expected index 1, got 2/)
    expect(results.every((r) => r.frame === null)).toBe(true)
  })

  it('rejects a run that does not start at index 0', () => {
    const [result] = feed(new OmpChunkDecoder(1 << 20), [chunk(frame, 16)[1]!])
    expect(result!.error?.message).toMatch(/did not start at index 0/)
  })

  it('rejects interleaved runs', () => {
    const a = chunk(frame, 16, 'rpc-1')
    const b = chunk(frame, 16, 'rpc-2')
    const results = feed(new OmpChunkDecoder(1 << 20), [a[0]!, b[0]!])
    expect(results[1]!.error?.message).toMatch(/rpc-1 interleaved with rpc-2/)
  })

  it('reports an interruption but still dispatches the interrupting frame', () => {
    const decoder = new OmpChunkDecoder(1 << 20)
    decoder.push(chunk(frame, 16)[0]!)
    const result = decoder.push({ type: 'agent_start' })
    expect(result.frame).toEqual({ type: 'agent_start' })
    expect(result.error?.message).toMatch(/interrupted by a agent_start frame/)
  })

  it('drops the tail of a rejected run quietly, then accepts a fresh run', () => {
    const decoder = new OmpChunkDecoder(1 << 20)
    const chunks = chunk(frame, 16)
    decoder.push(chunks[0]!)
    expect(decoder.push({ type: 'agent_start' }).error).toBeDefined()
    // The rest of the broken run: neither dispatched nor reported again.
    expect(feed(decoder, chunks.slice(1))).toEqual(chunks.slice(1).map(() => ({ frame: null })))
    expect(feed(decoder, chunk(frame, 16, 'rpc-2')).at(-1)).toEqual({ frame })
  })

  it.each([
    ['index >= count', { index: 5, count: 5 }],
    ['negative index', { index: -1 }],
    ['zero count', { count: 0, index: 0 }],
    ['fractional count', { count: 2.5 }],
    ['empty chunkId', { chunkId: '' }],
    ['missing byteLength', { byteLength: undefined }],
  ])('rejects bad metadata: %s', (_label, patch) => {
    const [first] = chunk(frame, 16)
    const result = new OmpChunkDecoder(1 << 20).push({ ...first!, ...patch })
    expect(result.error?.message).toMatch(/invalid chunkId\/index\/count\/byteLength/)
  })

  it('rejects a run whose count or byteLength changes midway', () => {
    const chunks = chunk(frame, 16)
    const results = feed(new OmpChunkDecoder(1 << 20), [chunks[0]!, { ...chunks[1]!, count: 99 }])
    expect(results[1]!.error?.message).toMatch(/changed its count or byteLength/)
  })

  it('rejects bytes that do not add up to byteLength', () => {
    const declaredLonger = chunk(frame, 16).map((c) => ({
      ...c,
      byteLength: (c.byteLength as number) + 1,
    }))
    expect(feed(new OmpChunkDecoder(1 << 20), declaredLonger).at(-1)!.error?.message).toMatch(
      /carried \d+ bytes, declared \d+/,
    )
    const declaredShorter = chunk(frame, 16).map((c) => ({
      ...c,
      byteLength: (c.byteLength as number) - 20,
    }))
    expect(
      feed(new OmpChunkDecoder(1 << 20), declaredShorter).find((r) => r.error)!.error?.message,
    ).toMatch(/exceeds its declared/)
  })

  it('enforces the advertised reassembly limit before buffering anything', () => {
    const chunks = chunk(frame, 16)
    const limit = (chunks[0]!.byteLength as number) - 1
    const [result] = feed(new OmpChunkDecoder(limit), [chunks[0]!])
    expect(result!.error?.message).toMatch(/over the \d+-byte reassembly limit/)
  })

  it('rejects invalid UTF-8, bad base64 and a payload that is not one JSON object', () => {
    const run = (bytes: Buffer) =>
      new OmpChunkDecoder(1 << 20).push({
        type: 'rpc_chunk',
        chunkId: 'rpc-1',
        index: 0,
        count: 1,
        byteLength: bytes.length,
        data: bytes.toString('base64'),
      })
    expect(run(Buffer.from([0x7b, 0xc3, 0x28, 0x7d])).error?.message).toMatch(/not valid UTF-8/)
    expect(run(Buffer.from('[1,2]')).error?.message).toMatch(/did not carry a JSON object/)
    expect(run(Buffer.from('{"a":')).error?.message).toMatch(/not valid JSON/)
    const [first] = chunk(frame, 16)
    expect(
      new OmpChunkDecoder(1 << 20).push({ ...first!, data: 'not base64!' }).error?.message,
    ).toMatch(/not base64/)
  })
})
