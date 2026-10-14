import { describe, expect, it } from 'vitest'
import { parseClientFrame, parseHostFrame } from './host-protocol'
import {
  TERMINAL_LIMITS as L,
  parseTerminalOp,
  parseTerminalInput,
  parseTerminalSubscribe,
  parseTerminalList,
  parseTerminalFrame,
  parseTerminalCreated,
} from './host-protocol-terminals'
const id = '00000000-0000-4000-8000-000000000001'
const epoch = 'a'.repeat(16)
describe('host-protocol-terminals', () => {
  it('parses bounded strict create, resize and kill ops through the command envelope', () => {
    for (const op of [
      { type: 'terminal.create', cols: 2, rows: 1 },
      { type: 'terminal.resize', terminalId: id, cols: 1000, rows: 1000 },
      { type: 'terminal.kill', terminalId: id },
    ]) {
      expect(
        parseClientFrame(
          JSON.stringify({ type: 'command', requestId: id, laneId: id, fence: 1, op }),
        ).ok,
      ).toBe(true)
      expect(parseTerminalOp({ ...op, env: {} })).toBeNull()
    }
    for (const dims of [
      { cols: 1, rows: 1 },
      { cols: 1001, rows: 1 },
      { cols: 2, rows: 0 },
      { cols: 2, rows: 1001 },
      { cols: 2.5, rows: 1 },
    ])
      expect(parseTerminalOp({ type: 'terminal.create', ...dims })).toBeNull()
  })
  it('bounds UTF-8 input, sequences and exact keys', () => {
    const frame = {
      type: 'terminal.input',
      terminalId: id,
      seq: 1,
      data: '💡'.repeat(L.inputBytes / 4),
    }
    expect(parseClientFrame(JSON.stringify(frame)).ok).toBe(true)
    expect(parseTerminalInput({ ...frame, data: frame.data + 'x' })).toBeNull()
    expect(parseTerminalInput({ ...frame, seq: 0 })).toBeNull()
    expect(parseTerminalInput({ ...frame, laneId: id })).toBeNull()
    expect(parseTerminalInput({ ...frame, terminalId: '../' })).toBeNull()
  })
  it('strictly parses subscriptions, cursors, results and output frames', () => {
    expect(parseTerminalCreated({ terminalId: id })).toEqual({ terminalId: id })
    expect(parseTerminalCreated({ terminalId: '../' })).toBeNull()
    expect(parseTerminalCreated({ terminalId: id, path: '/tmp' })).toBeNull()
    const sub = {
      type: 'subscribe',
      topic: 'terminal',
      id: 's',
      terminalId: id,
      after: { epoch, seq: 0 },
    }
    expect(parseClientFrame(JSON.stringify(sub)).ok).toBe(true)
    expect(parseTerminalSubscribe({ ...sub, after: { epoch, seq: -1 } })).toBeNull()
    expect(parseTerminalSubscribe({ ...sub, path: '/tmp' })).toBeNull()
    expect(parseTerminalList([{ terminalId: id, laneId: id, status: 'running' }])).not.toBeNull()
    expect(
      parseTerminalList(Array(33).fill({ terminalId: id, laneId: id, status: 'running' })),
    ).toBeNull()
    const frame = {
      type: 'terminal.output',
      id: 's',
      terminalId: id,
      epoch,
      seq: 1,
      data: 'x'.repeat(L.chunkBytes),
    }
    expect(parseHostFrame(JSON.stringify(frame)).ok).toBe(true)
    expect(parseTerminalFrame({ ...frame, data: frame.data + 'x' })).toBeNull()
    expect(parseTerminalFrame({ ...frame, extra: 1 })).toBeNull()
    expect(
      parseTerminalFrame({
        ...frame,
        type: 'terminal.reset',
        inputSeq: 0,
        status: 'interrupted',
        data: 'x'.repeat(L.scrollbackBytes),
      }),
    ).not.toBeNull()
    expect(
      parseTerminalFrame({
        ...frame,
        type: 'terminal.reset',
        inputSeq: 0,
        status: 'running',
        data: 'x'.repeat(L.scrollbackBytes + 1),
      }),
    ).toBeNull()
    expect(
      parseTerminalFrame({ type: 'terminal.ack', terminalId: id, seq: 1, accepted: true }),
    ).not.toBeNull()
    expect(
      parseTerminalFrame({ ...frame, type: 'terminal.exit', data: undefined, exitCode: 0 }),
    ).toBeNull()
  })
})
