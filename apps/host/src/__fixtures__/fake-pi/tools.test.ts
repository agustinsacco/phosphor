import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  artifact,
  attachmentReply,
  createToolState,
  laneMarker,
  linkTool,
  receiptTools,
} from './tools.cjs'

type RecordValue = Record<string, unknown>
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'fake-pi-tools-'))
  roots.push(cwd)
  const trace: { port: string; record: RecordValue }[] = []
  return {
    cwd,
    trace,
    out: (record: RecordValue) => trace.push({ port: 'out', record }),
    persist: (record: RecordValue) => trace.push({ port: 'persist', record }),
    text: (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] }),
  }
}

function expectTool(trace: ReturnType<typeof fixture>['trace'], name: string) {
  expect(trace.map(({ port, record }) => [port, record.type ?? record.role])).toEqual([
    ['out', 'message_end'],
    ['persist', 'assistant'],
    ['out', 'tool_execution_start'],
    ['out', 'tool_execution_end'],
    ['out', 'message_start'],
    ['out', 'message_end'],
    ['persist', 'toolResult'],
    ['out', 'message_start'],
  ])
  const call = trace[1]!.record
  const start = trace[2]!.record
  const end = trace[3]!.record
  const result = trace[6]!.record
  expect(call).toEqual({
    role: 'assistant',
    stopReason: 'toolUse',
    content: [
      {
        type: 'toolCall',
        id: start.toolCallId,
        name,
        arguments: start.args,
      },
    ],
  })
  expect(start).toMatchObject({ toolName: name, toolCallId: expect.any(String) })
  expect(end).toMatchObject({ toolName: name, toolCallId: start.toolCallId, isError: false })
  expect(result).toEqual({
    role: 'toolResult',
    toolCallId: start.toolCallId,
    toolName: name,
    ...(end.result as RecordValue),
    isError: false,
  })
  expect(trace[0]!.record.message).toBe(call)
  expect(trace[4]!.record.message).toBe(result)
  expect(trace[5]!.record.message).toBe(result)
  expect(trace[7]!.record).toEqual({
    type: 'message_start',
    message: { role: 'assistant', content: [{ type: 'text', text: '' }] },
  })
}

describe('fake pi tool scenarios', () => {
  it('creates then updates artifacts with an explicit per-session version and lane marker', () => {
    const h = fixture()
    const state = createToolState([])
    expect(laneMarker(h.cwd)).toBe('HOST_A_ONLY')
    writeFileSync(join(h.cwd, 'remote.txt'), 'HOST_B_ONLY')
    expect(laneMarker(h.cwd)).toBe('HOST_B_ONLY')
    artifact(state, h)
    expectTool(h.trace, 'artifact_create')
    expect(h.trace[6]!.record.details).toEqual({
      id: 'host-card',
      title: 'HOST_B_ONLY card',
      type: 'html',
      content: '<h1>HOST_B_ONLY version 1</h1>',
      version: 1,
    })
    h.trace.length = 0
    artifact(state, h)
    expectTool(h.trace, 'artifact_update')
    expect(h.trace[6]!.record.details).toMatchObject({
      version: 2,
      content: '<h1>HOST_B_ONLY version 2</h1>',
    })
    expect(createToolState([]).artifactVersion).toBe(0)
  })

  it('recovers only the greatest host-card tool-result version from resumed messages', () => {
    const h = fixture()
    const state = createToolState([
      { role: 'toolResult', details: { id: 'host-card', version: 4 } },
      { role: 'toolResult', details: { id: 'host-card', version: 2 } },
      { role: 'toolResult', details: { id: 'host-card' } },
      { role: 'toolResult', details: { id: 'other', version: 99 } },
      { role: 'assistant', details: { id: 'host-card', version: 99 } },
    ])
    artifact(state, h)
    expectTool(h.trace, 'artifact_update')
    expect(h.trace[6]!.record.details).toMatchObject({ version: 5 })
  })

  it('emits a native read call/result using the provided cwd, not the test process cwd', () => {
    const h = fixture()
    linkTool(h)
    expectTool(h.trace, 'read')
    expect(h.trace[2]!.record.args).toEqual({ path: join(h.cwd, 'nested', 'guide.md'), offset: 2 })
    expect(h.trace[6]!.record.content).toEqual([
      { type: 'text', text: 'HOST_A_ONLY guide line two' },
    ])
  })

  it('writes the receipt file before emitting edit and bash tool transcripts', () => {
    const h = fixture()
    receiptTools({
      ...h,
      out: (record: RecordValue) => {
        expect(readFileSync(join(h.cwd, 'remote.txt'), 'utf8')).toBe('HOST_A_ONLY receipt edit\n')
        h.out(record)
      },
    })
    expectTool(h.trace.slice(0, 8), 'edit')
    expectTool(h.trace.slice(8), 'bash')
    expect(readFileSync(join(h.cwd, 'remote.txt'), 'utf8')).toBe('HOST_A_ONLY receipt edit\n')
    expect(h.trace[2]!.record.args).toEqual({
      path: join(h.cwd, 'remote.txt'),
      oldText: 'HOST_A_ONLY',
      newText: 'HOST_A_ONLY receipt edit',
    })
    expect(h.trace[6]!.record.details).toEqual({
      diff: '-1 HOST_A_ONLY\n+1 HOST_A_ONLY receipt edit',
    })
    expect(h.trace[10]!.record.args).toEqual({ command: 'npm test' })
    expect(h.trace[14]!.record).toMatchObject({
      content: [{ type: 'text', text: '1 test passed' }],
      details: { exitCode: 0 },
    })
  })

  it('trims attachment documents and requires both PNG MIME and signature bytes', () => {
    const h = fixture()
    const first = join(h.cwd, 'first.txt')
    const second = join(h.cwd, 'second.txt')
    writeFileSync(first, '  first\n')
    writeFileSync(second, '\nsecond  ')
    expect(
      attachmentReply(`<attached-files>\n${first}\n${second}\n</attached-files>`, [
        { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        { mimeType: 'image/jpeg', data: 'iVBORw0KGgo=' },
        { mimeType: 'image/png', data: 'bm90IGEgcG5n' },
      ]),
    ).toBe('Attachments: first; second | 1 image/png')
    expect(attachmentReply('no documents', [])).toBe('Attachments:  | 0 image/png')
  })
})
