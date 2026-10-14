import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  HOST_LIMITS,
  isLaneBranchName,
  parseClientFrame,
  parseHostFrame,
  utf8Length,
  type LanePiOp,
  type LaneSnapshot,
  type HostFrame,
} from './host-protocol'

const uuid = '00000000-0000-4000-8000-000000000001'
const epoch = '0123456789abcdef'
const time = '2026-01-01T00:00:00.000Z'
const cursor = { epoch, seq: 0 }
const control = { fence: 1, controller: { clientId: uuid, label: 'Viewer', connected: true } }
const summary = {
  laneId: uuid,
  repositoryId: epoch,
  cwd: '/test',
  title: 'Lane',
  branch: 'main',
  worktree: false,
  model: { provider: 'provider', id: 'model' },
  activity: 'idle' as const,
  createdAt: time,
  updatedAt: time,
  attention: 1,
  read: 0,
  control,
}
const snapshot: LaneSnapshot = {
  cursor,
  summary,
  state: null,
  messages: [{ role: 'user', content: 'Hello', timestamp: 0 }],
  pending: [{ type: 'agent_start' }],
  dialogs: [
    {
      type: 'extension_ui_request',
      id: 'dialog',
      method: 'confirm',
      title: 'Question',
      message: '?',
    },
  ],
  ui: [
    {
      type: 'extension_ui_request',
      id: 'status',
      method: 'setStatus',
      statusKey: 'key',
      statusText: 'text',
    },
  ],
}
const client = (value: unknown) => parseClientFrame(JSON.stringify(value))
const host = (value: unknown) => parseHostFrame(JSON.stringify(value))
const command = (op: unknown, fields: Record<string, unknown> = {}) =>
  client({ type: 'command', requestId: uuid, laneId: uuid, fence: 1, op, ...fields })
const snap = (patch: Record<string, unknown> = {}) => ({
  type: 'snapshot',
  id: 'lane',
  laneId: uuid,
  reset: false,
  snapshot: { ...snapshot, ...patch },
})
function replace(value: unknown, path: string, next: unknown): unknown {
  const [key, ...rest] = path.split('.')
  if (!key || value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid test path')
  const record: Record<string, unknown> = { ...value }
  record[key] = rest.length ? replace(record[key], rest.join('.'), next) : next
  return record
}

describe('host-protocol client parsers', () => {
  it('preserves discriminated pi operation fields at compile time', () => {
    expectTypeOf<Extract<LanePiOp, { type: 'prompt' }>>().toHaveProperty('message')
    expectTypeOf<Extract<LanePiOp, { type: 'set_model' }>>().toHaveProperty('provider')
    expectTypeOf<Extract<LanePiOp, { type: 'set_model' }>>().toHaveProperty('modelId')
  })
  it('counts UTF-8 correctly, including unmatched surrogates', () => {
    for (const s of ['', 'ASCII', 'é中😀', '\ud800', '\udc00', '\ud800x', '\ud800\ud800'])
      expect(utf8Length(s)).toBe(Buffer.byteLength(s))
  })
  it('rejects JSON, object and type failures and bounds exact inbound bytes', () => {
    for (const s of ['{', 'null', '[]', '1', '"text"', '{}', '{"type":"unknown"}'])
      expect(parseClientFrame(s).ok).toBe(false)
    const text = JSON.stringify({ type: 'ping', at: 0 })
    const exact = text + ' '.repeat(HOST_LIMITS.inboundFrameBytes - text.length)
    expect(parseClientFrame(exact).ok).toBe(true)
    expect(parseClientFrame(exact + ' ').ok).toBe(false)
  })
  it('validates all non-command frame fields and strips unknown envelope fields', () => {
    for (const value of [
      { type: 'auth', grant: 'token', challenge: 'a'.repeat(64) },
      { type: 'auth', grant: 'a'.repeat(4096) },
      { type: 'subscribe', id: 'x'.repeat(64), topic: 'lanes', after: cursor, trace: epoch },
      { type: 'subscribe', id: 'lane', topic: 'lane', laneId: uuid },
      { type: 'unsubscribe', id: 'sub' },
      { type: 'receipt-status', requestId: uuid },
      { type: 'call', id: 'call', method: 'unknown.method', params: {}, trace: epoch },
      { type: 'ping', at: Number.MAX_SAFE_INTEGER },
    ])
      expect(client(value).ok).toBe(true)
    for (const value of [
      { type: 'auth', grant: '' },
      { type: 'auth', grant: 'a'.repeat(4097) },
      { type: 'auth', grant: 'token', challenge: 'A'.repeat(64) },
      { type: 'subscribe', id: '', topic: 'lanes' },
      { type: 'subscribe', id: 'x'.repeat(65), topic: 'lanes' },
      { type: 'subscribe', id: 'bad.id', topic: 'lanes' },
      { type: 'subscribe', id: 'sub', topic: 'bad' },
      { type: 'subscribe', id: 'sub', topic: 'lane', laneId: 'bad' },
      { type: 'subscribe', id: 'sub', topic: 'lanes', after: { epoch, seq: -1 } },
      { type: 'subscribe', id: 'sub', topic: 'lanes', after: { epoch: 'A'.repeat(16), seq: 0 } },
      { type: 'subscribe', id: 'sub', topic: 'lanes', trace: 'bad' },
      { type: 'unsubscribe', id: 'bad.id' },
      { type: 'receipt-status', requestId: 'bad' },
      { type: 'ping', at: -1 },
      { type: 'ping', at: 0.5 },
      { type: 'ping', at: Number.MAX_SAFE_INTEGER + 1 },
      { type: 'command', requestId: 'bad', op: { type: 'abort' } },
      { type: 'call', id: 'bad.id', method: 'lane.state' },
    ])
      expect(client(value).ok).toBe(false)
    expect(client({ type: 'ping', at: 0, secret: 'ignored' })).toEqual({
      ok: true,
      frame: { type: 'ping', at: 0 },
    })
    for (const method of [
      '',
      'state',
      'Lane.state',
      'lane.bad_name',
      'lane.state.more.parts',
      'lane.' + 'x'.repeat(60),
    ])
      expect(client({ type: 'call', id: 'call', method })).toMatchObject({
        ok: false,
        reply: { kind: 'result', id: 'call', code: 'bad-request' },
      })
    expect(client({ type: 'call', id: 'call', method: 'lane.' + 'x'.repeat(59) }).ok).toBe(true)
    expect(client({ type: 'call', id: 'call', method: 'lane.state', trace: 'bad' }).ok).toBe(false)
  })
  it('parses every allowlisted operation and rejects every invalid operation field', () => {
    const image = { type: 'image', data: 'AA==', mimeType: 'image/png' }
    const create = {
      type: 'lane.create',
      repositoryId: epoch,
      worktree: { branch: 'feature/topic' },
      name: 'x'.repeat(80),
      provider: 'p',
      model: 'm',
      thinkingLevel: 'high',
    }
    for (const op of [
      ...['prompt', 'steer', 'follow_up'].map((type) => ({
        type,
        message: 'Hello',
        images: [image],
      })),
      { type: 'prompt', message: 'Hello', streamingBehavior: 'followUp' },
      ...[
        'abort',
        'abort_retry',
        'lane.resume',
        'lane.stop',
        'control.take',
        'control.release',
      ].map((type) => ({ type })),
      { type: 'set_model', provider: 'p'.repeat(200), modelId: 'm'.repeat(200) },
      ...['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => ({
        type: 'set_thinking_level',
        level,
      })),
      { type: 'compact' },
      { type: 'compact', customInstructions: 'compact' },
      { type: 'set_session_name', name: 'x'.repeat(80) },
      { type: 'lane.markRead', upTo: 0 },
      create,
      { type: 'lane.create', repositoryId: epoch, worktree: null },
      ...[{ value: '' }, { confirmed: false }, { cancelled: true }].map((r) => ({
        type: 'extension_ui_response',
        response: { type: 'extension_ui_response', id: 'dialog', ...r },
      })),
      { type: 'prompt', message: 'image', images: Array.from({ length: 16 }, () => image) },
      { type: 'prompt', message: 'image', images: [{ ...image, data: 'A'.repeat(1024 * 1024) }] },
    ])
      expect(command(op).ok).toBe(true)
    for (const op of [
      null,
      {},
      { type: 'prompt', message: '' },
      { type: 'steer' },
      { type: 'follow_up', message: 1 },
      { type: 'prompt', message: 'hi', streamingBehavior: 'bad' },
      ...[
        null,
        Array.from({ length: 17 }, () => image),
        [null],
        [{ ...image, type: 'text' }],
        [{ ...image, data: 'A' }],
        [{ ...image, data: '' }],
        [{ ...image, data: 'AA=A' }],
        [{ ...image, mimeType: 'text/html' }],
      ].map((images) => ({ type: 'prompt', message: 'hi', images })),
      { type: 'set_model', provider: '', modelId: 'm' },
      { type: 'set_model', provider: 'p', modelId: 'm'.repeat(201) },
      { type: 'set_model', provider: 'p'.repeat(201), modelId: 'm' },
      { type: 'set_thinking_level', level: 'bad' },
      { type: 'compact', customInstructions: '' },
      { type: 'set_session_name', name: 'x'.repeat(81) },
      { type: 'lane.markRead', upTo: -1 },
      { type: 'lane.markRead', upTo: 0.5 },
      ...[
        { repositoryId: 'bad' },
        { worktree: {} },
        { worktree: { branch: 'bad..branch' } },
        { name: '' },
        { provider: '' },
        { model: '' },
        { thinkingLevel: 'bad' },
      ].map((patch) => ({ ...create, ...patch })),
      ...[
        null,
        {},
        { type: 'bad', id: 'dialog', value: 'yes' },
        { type: 'extension_ui_response', id: 'bad.id', value: 'yes' },
        { type: 'extension_ui_response', id: 'dialog', cancelled: false },
        { type: 'extension_ui_response', id: 'dialog', value: 'yes', confirmed: true },
      ].map((response) => ({ type: 'extension_ui_response', response })),
    ])
      expect(command(op)).toMatchObject({
        ok: false,
        reply: { kind: 'receipt', code: 'bad-request' },
      })
    expect(command({ type: 'bash' })).toMatchObject({ ok: false, reply: { code: 'unsupported' } })
    for (const fields of [{ laneId: 'bad' }, { fence: 0 }, { fence: 1.5 }, { trace: 'bad' }])
      expect(command({ type: 'abort' }, fields).ok).toBe(false)
    expect(command({ type: 'abort', ignored: 'secret' })).toMatchObject({
      ok: true,
      frame: { op: { type: 'abort' } },
    })
  })
  it('enforces each narrowed branch rule and 200 vs 201 characters', () => {
    for (const branch of ['main', 'feature/topic', 'x'.repeat(200)])
      expect(isLaneBranchName(branch)).toBe(true)
    for (const branch of [
      '',
      'x'.repeat(201),
      'a\0b',
      'a b',
      'a\x7fb',
      'a~b',
      'a^b',
      'a:b',
      'a?b',
      'a*b',
      'a[b',
      'a\\b',
      'a..b',
      'a@{b',
      '@',
      '-a',
      '/a',
      'a/',
      'a//b',
      '.a',
      'a/.b',
      'a.lock',
      'a/b.lock',
      'a.',
      'é',
      'a\u202eb',
    ])
      expect(isLaneBranchName(branch)).toBe(false)
  })
})

describe('host-protocol Host parser', () => {
  const ready: HostFrame = {
    type: 'ready',
    protocolVersion: 1,
    hello: {
      hostId: uuid,
      hostVersion: '1.0.0',
      protocolVersion: 1,
      runtimeEpoch: epoch,
      capabilities: ['sessions.read'],
    },
    proof: 'A'.repeat(86),
    connectionId: epoch,
    grantExpiresAt: time,
    client: { id: uuid, label: 'Viewer' },
    capabilities: ['sessions.read'],
  }
  it('accepts every frame and pi payloads shallowly, strips protocol extras', () => {
    for (const f of [
      ready,
      { type: 'auth-renewed', grantExpiresAt: time },
      {
        type: 'lanes',
        id: 'all',
        cursor,
        repositories: [{ id: epoch, name: 'repo', path: '/repo' }],
        lanes: [summary],
      },
      {
        type: 'lanes-delta',
        id: 'all',
        cursor: { epoch, seq: 1 },
        upsert: [summary],
        remove: [uuid],
      },
      {
        type: 'attention',
        id: 'all',
        cursor: { epoch, seq: 1 },
        event: {
          id: uuid + ':1',
          laneId: uuid,
          kind: 'finished',
          attention: 1,
          at: time,
          title: null,
        },
      },
      snap(),
      snap({ state: {}, messages: [{ role: 'future' }], pending: [{ type: 'future' }] }),
      ...[
        { kind: 'control', control },
        { kind: 'summary', summary },
        { kind: 'dialog-resolved', dialogId: 'dialog' },
        { kind: 'pi', push: { kind: 'event', event: { type: 'future' } } },
        { kind: 'pi', push: { kind: 'extension-ui', request: snapshot.dialogs[0] } },
        { kind: 'pi', push: { kind: 'exit', code: 1, signal: null, expected: false } },
      ].map((event) => ({
        type: 'event',
        id: 'lane',
        laneId: uuid,
        cursor: { epoch, seq: 1 },
        event,
      })),
      { type: 'subscribe-failed', id: 'lane', code: 'too-large' },
      ...[
        { status: 'pending' },
        { status: 'unknown' },
        { status: 'done', fence: 1, laneId: uuid, data: {} },
        { status: 'failed', error: { code: 'pi-error', message: 'failure' } },
        { status: 'rejected', code: 'stale-fence', control },
      ].map((receipt) => ({ type: 'receipt', receipt: { requestId: uuid, ...receipt } })),
      { type: 'result', id: 'call', ok: true, data: null },
      {
        type: 'result',
        id: 'call',
        ok: false,
        error: { code: 'unsupported', message: 'unsupported' },
      },
      { type: 'error', code: 4409, message: 'unsupported' },
      { type: 'pong', at: 0 },
    ])
      expect(host(f).ok).toBe(true)
    expect(host({ type: 'pong', at: 0, secret: true })).toEqual({
      ok: true,
      value: { type: 'pong', at: 0 },
    })
  })
  it('rejects each ready and summary field failure', () => {
    for (const [path, value] of [
      ['protocolVersion', 2],
      ['hello', null],
      ['hello.hostId', 'bad'],
      ['hello.hostVersion', ''],
      ['hello.protocolVersion', 2],
      ['hello.runtimeEpoch', 'bad'],
      ['hello.capabilities', ['unknown']],
      ['hello.capabilities', ['sessions.read', 'sessions.read']],
      ['proof', 'A'.repeat(85)],
      ['proof', 'A'.repeat(85) + 'B'],
      ['connectionId', 'bad'],
      ['grantExpiresAt', '2026-02-30T00:00:00.000Z'],
      ['client', null],
      ['client.id', 'bad'],
      ['client.label', ''],
      ['capabilities', ['sessions.control']],
      ['capabilities', ['unknown']],
    ] as const)
      expect(host(replace(ready, path, value)).ok).toBe(false)
    for (const [path, value] of [
      ['laneId', 'bad'],
      ['repositoryId', 'bad'],
      ['cwd', ''],
      ['title', ''],
      ['branch', 'a..b'],
      ['worktree', 1],
      ['model', {}],
      ['model.provider', ''],
      ['model.id', ''],
      ['activity', 'bad'],
      ['createdAt', 'bad'],
      ['updatedAt', 'bad'],
      ['attention', -1],
      ['read', 2],
      ['control', null],
      ['control.fence', 0],
      ['control.controller', {}],
      ['control.controller.clientId', 'bad'],
      ['control.controller.label', ''],
      ['control.controller.connected', 1],
    ] as const)
      expect(host(snap({ summary: replace(summary, path, value) })).ok).toBe(false)
  })
  it('rejects malformed cursors, pi payloads, receipt fields, result errors and remaining envelopes', () => {
    for (const patch of [
      { cursor: { epoch, seq: -1 } },
      { state: [] },
      { messages: [{}] },
      { pending: [{}] },
      { dialogs: [{}] },
      { ui: snapshot.dialogs },
      { ui: Array.from({ length: 98 }, () => snapshot.ui[0]) },
    ])
      expect(host(snap(patch)).ok).toBe(false)
    for (const f of [
      { ...snap(), laneId: 'bad' },
      { ...snap(), reset: 1 },
      { ...snap(), laneId: '00000000-0000-4000-8000-000000000002' },
      { type: 'lanes', id: '', cursor, repositories: [], lanes: [] },
      { type: 'lanes', id: 'all', cursor, repositories: [{}], lanes: [] },
      { type: 'lanes-delta', id: 'all', cursor, upsert: [], remove: [] },
      { type: 'lanes-delta', id: 'all', cursor: { epoch, seq: 1 }, upsert: [], remove: ['bad'] },
      { type: 'event', id: 'lane', laneId: uuid, cursor, event: { kind: 'control', control } },
      {
        type: 'event',
        id: 'lane',
        laneId: uuid,
        cursor: { epoch, seq: 1 },
        event: { kind: 'pi', push: { kind: 'stderr', text: 'secret' } },
      },
      { type: 'subscribe-failed', id: 'lane', code: 'bad' },
      { type: 'result', id: 'call', ok: true },
      { type: 'result', id: 'call', ok: false, error: { code: 'bad', message: 'bad' } },
      {
        type: 'result',
        id: 'call',
        ok: false,
        error: { code: 'internal', message: 'x'.repeat(2001) },
      },
      { type: 'error', code: 4402, message: 'error' },
      { type: 'pong', at: -1 },
      { type: 'future' },
    ])
      expect(host(f).ok).toBe(false)
    for (const r of [
      { requestId: 'bad', status: 'done' },
      { requestId: uuid, status: 'other' },
      { requestId: uuid, status: 'done', fence: 0 },
      { requestId: uuid, status: 'done', laneId: 'bad' },
      { requestId: uuid, status: 'failed', error: { code: 'other', message: 'error' } },
      { requestId: uuid, status: 'failed', error: { code: 'internal', message: '' } },
      { requestId: uuid, status: 'rejected', code: 'other' },
      { requestId: uuid, status: 'rejected', code: 'busy', control: {} },
    ])
      expect(host({ type: 'receipt', receipt: r }).ok).toBe(false)
  })
  it('rejects each attention, event and envelope field failure', () => {
    const attention = {
      type: 'attention',
      id: 'all',
      cursor: { epoch, seq: 1 },
      event: {
        id: uuid + ':1',
        laneId: uuid,
        kind: 'finished',
        attention: 1,
        at: time,
        title: 'Lane',
      },
    }
    for (const [path, value] of [
      ['id', ''],
      ['cursor', {}],
      ['event', null],
      ['event.id', 'wrong'],
      ['event.laneId', 'bad'],
      ['event.attention', 0],
      ['event.kind', 'other'],
      ['event.at', 'bad'],
      ['event.title', ''],
    ] as const)
      expect(host(replace(attention, path, value)).ok).toBe(false)
    const event = {
      type: 'event',
      id: 'lane',
      laneId: uuid,
      cursor: { epoch, seq: 1 },
      event: { kind: 'pi', push: { kind: 'exit', code: 1, signal: null, expected: false } },
    }
    for (const [path, value] of [
      ['id', ''],
      ['laneId', 'bad'],
      ['cursor.epoch', 'bad'],
      ['cursor.seq', 0.5],
      ['event', null],
      ['event.kind', 'unknown'],
      ['event.push.code', -1],
      ['event.push.signal', 1],
      ['event.push.expected', 1],
    ] as const)
      expect(host(replace(event, path, value)).ok).toBe(false)
    for (const invalidEvent of [
      { kind: 'control', control: {} },
      { kind: 'summary', summary: { ...summary, laneId: '00000000-0000-4000-8000-000000000002' } },
      { kind: 'dialog-resolved', dialogId: 'bad.id' },
      { kind: 'pi', push: { kind: 'resync' } },
      { kind: 'pi', push: { kind: 'event', event: {} } },
      { kind: 'pi', push: { kind: 'extension-ui', request: {} } },
    ])
      expect(host({ ...event, event: invalidEvent }).ok).toBe(false)
    for (const patch of [{ cursor: {} }, { repositories: null }, { lanes: [{}] }])
      expect(
        host({ type: 'lanes', id: 'all', cursor, repositories: [], lanes: [], ...patch }).ok,
      ).toBe(false)
    for (const value of [
      { type: 'result', id: '', ok: true, data: {} },
      { type: 'auth-renewed', grantExpiresAt: 'bad' },
      { type: 'error', code: 4400, message: '' },
      { type: 'error', code: 4400, message: 'x'.repeat(2001) },
    ])
      expect(host(value).ok).toBe(false)
  })
  it('checks exact outbound, receipt-data, list, pending and UI boundaries', () => {
    const text = JSON.stringify({ type: 'pong', at: 0 })
    const exact = text + ' '.repeat(HOST_LIMITS.outboundFrameBytes - text.length)
    expect(parseHostFrame(exact).ok).toBe(true)
    expect(parseHostFrame(exact + ' ').ok).toBe(false)
    for (const text of ['{', 'null', '[]']) expect(parseHostFrame(text).ok).toBe(false)
    for (const n of [HOST_LIMITS.messageChars, HOST_LIMITS.messageChars + 1]) {
      for (const value of [
        { type: 'error', code: 4400, message: 'x'.repeat(n) },
        {
          type: 'result',
          id: 'call',
          ok: false,
          error: { code: 'internal', message: 'x'.repeat(n) },
        },
        {
          type: 'receipt',
          receipt: {
            requestId: uuid,
            status: 'failed',
            error: { code: 'pi-error', message: 'x'.repeat(n) },
          },
        },
      ])
        expect(host(value).ok).toBe(n === HOST_LIMITS.messageChars)
    }
    for (const n of [HOST_LIMITS.receiptDataBytes - 2, HOST_LIMITS.receiptDataBytes - 1])
      expect(
        host({ type: 'receipt', receipt: { requestId: uuid, status: 'done', data: 'x'.repeat(n) } })
          .ok,
      ).toBe(n === HOST_LIMITS.receiptDataBytes - 2)
    for (const n of [64, 65])
      expect(
        host({
          type: 'lanes',
          id: 'all',
          cursor,
          repositories: Array.from({ length: n }, () => ({
            id: epoch,
            name: 'repo',
            path: '/repo',
          })),
          lanes: [],
        }).ok,
      ).toBe(n === 64)
    for (const n of [1000, 1001])
      expect(
        host({
          type: 'lanes',
          id: 'all',
          cursor,
          repositories: [],
          lanes: Array.from({ length: n }, () => summary),
        }).ok,
      ).toBe(n === 1000)
    for (const n of [4000, 4001])
      expect(
        host(snap({ pending: Array.from({ length: n }, () => ({ type: 'agent_start' })) })).ok,
      ).toBe(n === 4000)
    const ui = [
      ...Array.from({ length: 64 }, (_, i) => ({
        type: 'extension_ui_request',
        id: 's' + i,
        method: 'setStatus',
        statusKey: 's' + i,
        statusText: 'text',
      })),
      ...Array.from({ length: 32 }, (_, i) => ({
        type: 'extension_ui_request',
        id: 'w' + i,
        method: 'setWidget',
        widgetKey: 'w' + i,
        widgetLines: ['text'],
      })),
      { type: 'extension_ui_request', id: 'title', method: 'setTitle', title: 'Title' },
    ]
    expect(host(snap({ ui })).ok).toBe(true)
    expect(host(snap({ ui: [...ui, ui[0]] })).ok).toBe(false)
    for (const [method, cap] of [
      ['setStatus', 64],
      ['setWidget', 32],
      ['setTitle', 1],
    ] as const) {
      expect(
        host(
          snap({
            ui: Array.from({ length: cap }, () => ({
              type: 'extension_ui_request',
              id: 'ui',
              method,
            })),
          }),
        ).ok,
      ).toBe(true)
      expect(
        host(
          snap({
            ui: Array.from({ length: cap + 1 }, () => ({
              type: 'extension_ui_request',
              id: 'ui',
              method,
            })),
          }),
        ).ok,
      ).toBe(false)
    }
  })
})

describe('host-protocol parser totality', () => {
  const nested = '['.repeat(20_000) + '0' + ']'.repeat(20_000)
  const receiptText = (data: string) =>
    `{"type":"receipt","receipt":{"requestId":"${uuid}","status":"done","data":${data}}}`

  it('rejects deeply nested receipt data without throwing', () => {
    expect(parseHostFrame(receiptText(nested)).ok).toBe(false)
  })
  it('never recurses into free-form client or pi payloads', () => {
    const clientTexts = [
      `{"type":"call","id":"call","method":"lane.state","params":${nested}}`,
      `{"type":"command","requestId":"${uuid}","op":{"type":"prompt","message":"hi","images":${nested}}}`,
      `{"type":"command","requestId":"${uuid}","op":{"type":"extension_ui_response","response":{"type":"extension_ui_response","id":"dialog","value":${nested}}}}`,
    ]
    for (const text of clientTexts) expect(typeof parseClientFrame(text).ok).toBe('boolean')
    const hostTexts = [
      `{"type":"result","id":"call","ok":true,"data":${nested}}`,
      `{"type":"event","id":"lane","laneId":"${uuid}","cursor":{"epoch":"${epoch}","seq":1},"event":{"kind":"pi","push":{"kind":"event","event":{"type":"message_update","payload":${nested}}}}}`,
      JSON.stringify(snap()).replace('"state":null', `"state":{"payload":${nested}}`),
      JSON.stringify(snap()).replace('"content":"Hello"', `"content":${nested}`),
      JSON.stringify(snap()).replace(
        '"type":"agent_start"',
        `"type":"agent_start","payload":${nested}`,
      ),
      JSON.stringify(snap()).replace('"message":"?"', `"message":${nested}`),
    ]
    for (const text of hostTexts) expect(typeof parseHostFrame(text).ok).toBe('boolean')
  })
  it('returns a result for 200 generated hostile strings through both parsers', () => {
    for (let i = 0; i < 200; i++) {
      const depth = i * 137
      const values = [
        '['.repeat(depth) + '0' + ']'.repeat(depth),
        '1e' + (300 + i),
        `{"__proto__":{"type":"done"},"constructor":${i}}`,
        '"' + '\ud800'.repeat(i + 1) + '"',
        '{"type":"receipt","receipt":' + '['.repeat(i),
      ]
      const value = values[i % values.length]
      if (value === undefined) throw new Error('Missing hostile value')
      for (const text of [
        receiptText(value),
        `{"type":"call","id":"call","method":"lane.state","params":${value}}`,
      ]) {
        expect(typeof parseClientFrame(text).ok).toBe('boolean')
        expect(typeof parseHostFrame(text).ok).toBe('boolean')
      }
    }
  })
})
