// Freezes the Host protocol's frame discriminants. Baselines are literal
// values, never snapshots, so no update flag can rewrite them. Acceptance here
// is shape only: grants, proofs and authorization stay with the conformance
// suite (libs/shared/src/host-protocol-testing/conformance.ts).
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  HOST_API_PORT,
  HOST_API_ROUTES,
  HOST_CALL_METHODS,
  HOST_PROTOCOL_VERSION,
  LANE_PI_OPS,
  UNFENCED_OPS,
  parseClientFrame,
  parseHostFrame,
  type ClientFrame,
  type HostFrame,
} from '@phosphor/shared/host-protocol'
import { FILE_METHODS } from '@phosphor/shared/host-protocol-files'
import { ROUTINE_OPS } from '@phosphor/shared/host-protocol-routines'
import {
  CLIENT_FRAMES,
  HOST_FRAMES,
  LANE_OP_TYPES,
  LANE_PI_PUSHES,
  REQUEST_ID,
  frameCases,
  laneEventFrame,
} from './__fixtures__/protocol-freeze'

const clientCases = frameCases<ClientFrame>(CLIENT_FRAMES)
const hostCases = frameCases<HostFrame>(HOST_FRAMES)
const client = (value: unknown) => parseClientFrame(JSON.stringify(value))
const host = (value: unknown) => parseHostFrame(JSON.stringify(value))
/** Discriminant values that no frame union has, or only differ by case or spacing. */
const unknownTypes = [
  undefined,
  null,
  42,
  true,
  '',
  ' ',
  'constructor',
  'toString',
  '__proto__',
  'hasOwnProperty',
  'terminal.',
  'terminal.unknown',
  'subscribe.lanes',
]

describe('client frame discriminants', () => {
  it('pins every ClientFrame type and subscribe topic', () => {
    expect(Object.keys(CLIENT_FRAMES).sort()).toStrictEqual([
      'auth',
      'call',
      'command',
      'ping',
      'receipt-status',
      'subscribe',
      'terminal.input',
      'unsubscribe',
    ])
    expect(Object.keys(CLIENT_FRAMES.subscribe).sort()).toStrictEqual(['lane', 'lanes', 'terminal'])
  })

  it.each(clientCases)('parseClientFrame accepts $type ($variant)', ({ type, frame }) => {
    const parsed = client(frame)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.frame.type).toBe(type)
  })

  it('keeps each subscribe topic as its own variant', () => {
    for (const [topic, frame] of Object.entries(CLIENT_FRAMES.subscribe))
      expect(client(frame)).toMatchObject({ ok: true, frame: { type: 'subscribe', topic } })
  })

  it('rejects unknown and Host-only frame kinds by type', () => {
    const kinds = [...unknownTypes, 'AUTH', 'Ping', 'ping ', 'auth\u0000', 'ready', 'pong']
    for (const type of kinds)
      expect(client({ type, at: 1 }), String(type)).toStrictEqual({ ok: false, reason: 'type' })
  })

  it('rejects unknown subscribe topics', () => {
    for (const topic of [undefined, null, '', 'Lanes', 'lanes ', 'terminals', 'routines', 'host'])
      expect(client({ ...CLIENT_FRAMES.subscribe.lanes, topic }), String(topic)).toStrictEqual({
        ok: false,
        reason: 'frame',
      })
  })

  it.each(hostCases)('parseClientFrame rejects Host frame $type ($variant)', ({ frame }) => {
    expect(client(frame)).toStrictEqual({ ok: false, reason: 'type' })
  })
})

describe('Host frame discriminants', () => {
  it('pins every HostFrame type and its variant keys', () => {
    expect(Object.keys(HOST_FRAMES).sort()).toStrictEqual([
      'attention',
      'auth-renewed',
      'error',
      'event',
      'lanes',
      'lanes-delta',
      'pong',
      'ready',
      'receipt',
      'result',
      'routines-changed',
      'snapshot',
      'subscribe-failed',
      'terminal.ack',
      'terminal.exit',
      'terminal.output',
      'terminal.reset',
    ])
    expect(Object.keys(HOST_FRAMES.event).sort()).toStrictEqual([
      'control',
      'dialog-resolved',
      'pi',
      'summary',
    ])
    expect(Object.keys(LANE_PI_PUSHES).sort()).toStrictEqual(['event', 'exit', 'extension-ui'])
    expect(Object.keys(HOST_FRAMES.receipt).sort()).toStrictEqual([
      'done',
      'failed',
      'pending',
      'rejected',
      'unknown',
    ])
    expect(Object.keys(HOST_FRAMES.result).sort()).toStrictEqual(['error', 'ok'])
  })

  it.each(hostCases)('parseHostFrame accepts $type ($variant)', ({ type, frame }) => {
    const parsed = host(frame)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.value.type).toBe(type)
  })

  it('accepts every lane event kind, pi push kind, receipt status and result outcome', () => {
    for (const [kind, frame] of Object.entries(HOST_FRAMES.event))
      expect(host(frame)).toMatchObject({ ok: true, value: { type: 'event', event: { kind } } })
    for (const [kind, push] of Object.entries(LANE_PI_PUSHES))
      expect(host(laneEventFrame({ kind: 'pi', push }))).toMatchObject({
        ok: true,
        value: { event: { kind: 'pi', push: { kind } } },
      })
    for (const [status, frame] of Object.entries(HOST_FRAMES.receipt))
      expect(host(frame)).toMatchObject({ ok: true, value: { receipt: { status } } })
    expect(host(HOST_FRAMES.result.ok)).toMatchObject({ ok: true, value: { ok: true } })
    expect(host(HOST_FRAMES.result.error)).toMatchObject({ ok: true, value: { ok: false } })
  })

  it('rejects unknown and client-only frame kinds by type', () => {
    const rejected = { ok: false, reason: 'host-frame' }
    const kinds = [...unknownTypes, 'READY', 'Pong', 'pong ', 'auth', 'ping', 'terminal.input']
    for (const type of kinds) {
      expect(host({ type, at: 1 }), String(type)).toStrictEqual(rejected)
      expect(host({ ...HOST_FRAMES['terminal.output'].output, type }), String(type)).toStrictEqual(
        rejected,
      )
    }
  })

  it('rejects unknown lane event kinds, unforwarded pi pushes and unknown receipt statuses', () => {
    const rejected = { ok: false, reason: 'host-frame' }
    for (const kind of ['unknown', 'Pi', 'resync', 'stderr'])
      expect(
        host({ ...HOST_FRAMES.event['dialog-resolved'], event: { kind, dialogId: 'dialog' } }),
      ).toStrictEqual(rejected)
    // A Desktop session push that the lane stream never forwards.
    for (const push of [{ kind: 'stderr', text: 'secret' }, { kind: 'resync' }, { kind: 'x' }])
      expect(host({ ...HOST_FRAMES.event.pi, event: { kind: 'pi', push } })).toStrictEqual(rejected)
    for (const status of ['unknown ', 'Done', 'accepted', 'cancelled', undefined])
      expect(host({ type: 'receipt', receipt: { requestId: REQUEST_ID, status } })).toStrictEqual(
        rejected,
      )
    for (const ok of ['true', 1, null, undefined])
      expect(host({ ...HOST_FRAMES.result.ok, ok })).toStrictEqual(rejected)
  })

  it.each(clientCases)('parseHostFrame rejects client frame $type ($variant)', ({ frame }) => {
    expect(host(frame)).toStrictEqual({ ok: false, reason: 'host-frame' })
  })
})

describe('parser outputs', () => {
  it.each(clientCases)('parseClientFrame returns $type ($variant) unchanged', ({ frame }) => {
    expect(client(frame)).toStrictEqual({ ok: true, frame })
  })

  it.each(hostCases)('parseHostFrame returns $type ($variant) unchanged', ({ frame }) => {
    expect(host(frame)).toStrictEqual({ ok: true, value: frame })
  })

  it('returns every forwarded pi push unchanged', () => {
    for (const push of Object.values(LANE_PI_PUSHES)) {
      const frame = laneEventFrame({ kind: 'pi', push })
      expect(host(frame)).toStrictEqual({ ok: true, value: frame })
    }
  })
})

const sharedTsconfig = resolve(import.meta.dirname, '../tsconfig.json')
const sharedSource = resolve(import.meta.dirname, '../src')
const fixturePath = resolve(import.meta.dirname, '__fixtures__/protocol-freeze.ts')
const COMPILE_TIMEOUT_MS = 120_000

/** Adds `member` as the first arm of the exported union `name`. */
function addUnionMember(source: string, name: string, member: string): string {
  const declaration = `export type ${name} =\n`
  if (!source.includes(declaration)) throw new Error(`${name} is no longer declared as a union`)
  return source.replace(declaration, `${declaration}  | ${member}\n`)
}

interface CompileError {
  readonly file: string
  readonly code: number
  /** The trimmed source line the error points at. */
  readonly at: string
  readonly message: string
}

/** tsc errors in `files` under libs/shared/tsconfig.json, optionally rewriting sources. */
function compileErrors(
  files: readonly string[],
  rewrites: Readonly<Record<string, (source: string) => string>> = {},
): CompileError[] {
  const config = ts.getParsedCommandLineOfConfigFile(
    sharedTsconfig,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      },
    },
  )
  if (!config) throw new Error('libs/shared/tsconfig.json did not parse')
  const compilerHost = ts.createCompilerHost(config.options)
  const readFile = compilerHost.readFile.bind(compilerHost)
  compilerHost.readFile = (fileName) => {
    const source = readFile(fileName)
    const rewrite = rewrites[resolve(fileName)]
    return source === undefined || !rewrite ? source : rewrite(source)
  }
  const program = ts.createProgram(files, config.options, compilerHost)
  return files
    .flatMap((file) => {
      const source = program.getSourceFile(file)
      if (!source) throw new Error(`${file} was not compiled`)
      return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    })
    .map(({ file, start, code, messageText }) => {
      const line = file && start !== undefined ? file.getLineAndCharacterOfPosition(start).line : -1
      return {
        file: file ? relative(import.meta.dirname, file.fileName) : 'global',
        code,
        at: file ? (file.text.split('\n')[line] ?? '').trim() : '',
        message: ts.flattenDiagnosticMessageText(messageText, ' '),
      }
    })
}

// `npm run typecheck` does not cover libs/shared/test, so the exhaustive
// `satisfies` maps are compiled here, where every unit-test run enforces them.
describe('compile-time exhaustiveness', () => {
  it('type-checks the fixture maps and both freeze suites', { timeout: COMPILE_TIMEOUT_MS }, () => {
    expect(
      compileErrors([
        fixturePath,
        resolve(import.meta.dirname, 'host-protocol.freeze.test.ts'),
        resolve(import.meta.dirname, 'control-api.freeze.test.ts'),
      ]),
    ).toStrictEqual([])
  })

  it(
    'fails tsc when a frame union, forwarded pi push or command op gains a member',
    { timeout: COMPILE_TIMEOUT_MS },
    () => {
      const drift = "{ readonly type: 'freeze-drift' }"
      const errors = compileErrors([fixturePath], {
        [resolve(sharedSource, 'host-protocol.ts')]: (source) =>
          ['ClientFrame', 'HostFrame', 'LaneOp'].reduce(
            (next, name) => addUnionMember(next, name, drift),
            source,
          ),
        [resolve(sharedSource, 'models.ts')]: (source) =>
          addUnionMember(source, 'SessionPush', "{ kind: 'freeze-drift' }"),
      })
      // One error per exhaustive map, each naming the member it lacks.
      expect(errors.map(({ file, code, at }) => ({ file, code, at }))).toStrictEqual(
        [
          "} satisfies { readonly [K in LanePiPush['kind']]: Extract<LanePiPush, { kind: K }> }",
          '} satisfies FramesByType<ClientFrame>',
          '} satisfies FramesByType<HostFrame>',
          '} satisfies Record<LaneOpType, true>',
        ].map((at) => ({ file: '__fixtures__/protocol-freeze.ts', code: 1360, at })),
      )
      for (const { message } of errors)
        expect(message).toContain(`Property '"freeze-drift"' is missing`)
    },
  )
})

describe('Host API constants and op lists', () => {
  it('keeps the Host API routes, port and protocol version exactly', () => {
    expect(HOST_API_ROUTES).toStrictEqual({ hello: '/v1/hello', stream: '/v1/stream' })
    expect(HOST_API_PORT).toBe(47615)
    expect(HOST_PROTOCOL_VERSION).toBe(1)
  })

  it('keeps the call method and command op lists exactly, in order', () => {
    expect(HOST_CALL_METHODS).toStrictEqual([
      'host.repositories',
      'lane.state',
      'lane.messages',
      'lane.receipt',
      'lane.stats',
      'lane.models',
      'lane.commands',
    ])
    expect(FILE_METHODS).toStrictEqual([
      'files.list',
      'files.read',
      'git.status',
      'git.diff',
      'git.show',
    ])
    expect(LANE_PI_OPS).toStrictEqual([
      'prompt',
      'steer',
      'follow_up',
      'abort',
      'abort_retry',
      'set_model',
      'set_thinking_level',
      'compact',
      'set_session_name',
    ])
    expect(ROUTINE_OPS).toStrictEqual([
      'routine.save',
      'routine.run',
      'routine.cancel',
      'routine.skipNext',
      'routine.archive',
      'routine.delete',
      'routine.pauseAll',
    ])
    expect(UNFENCED_OPS).toStrictEqual([
      'lane.create',
      'lane.markRead',
      'control.take',
      'host.repositories.add',
      'host.repositories.remove',
      'host.repositories.createFolder',
    ])
  })

  it('lists only op types the command union carries', () => {
    for (const op of [...LANE_PI_OPS, ...ROUTINE_OPS, ...UNFENCED_OPS])
      expect(Object.hasOwn(LANE_OP_TYPES, op), op).toBe(true)
  })

  it('refuses unknown and non-allowlisted pi command ops as unsupported', () => {
    const reply = (code: string) => ({
      ok: false,
      reason: 'command',
      reply: { kind: 'receipt', requestId: REQUEST_ID, code },
    })
    const command = (op: unknown) => client({ ...CLIENT_FRAMES.command.fenced, op })
    for (const type of ['freeze.unknown', 'Prompt', 'constructor', 'bash', 'get_state', 'fork'])
      expect(command({ type }), type).toStrictEqual(reply('unsupported'))
    expect(command({ type: 'prompt' })).toStrictEqual(reply('bad-request'))
  })

  it('holds literal baselines that a snapshot update cannot rewrite', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, 'host-protocol.freeze.test.ts'),
      'utf8',
    )
    expect(source.match(/\.(?:toMatch|toThrowErrorMatching)\w*Snapshot\(/g)).toBeNull()
  })
})
