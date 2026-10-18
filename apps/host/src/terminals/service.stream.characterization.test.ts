import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  TERMINAL_LIMITS as L,
  type TerminalFrame,
  type TerminalSubscribe,
} from '@phosphor/shared/host-protocol-terminals'
import { createTerminals } from './service'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'terminal-stream-')))
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))
afterAll(() => rmSync(root, { recursive: true, force: true }))
function setup() {
  let data = (_: string) => {}
  let exit = (_: { exitCode: number }) => {}
  const owner = randomUUID()
  const laneId = randomUUID()
  const pty = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData(cb: typeof data) {
      data = cb
      return { dispose() {} }
    },
    onExit(cb: typeof exit) {
      exit = cb
      return { dispose() {} }
    },
  }
  const save = vi.fn()
  const service = createTerminals({
    native: { spawn: () => pty },
    context: {
      store: {
        getLane: () => ({
          laneId,
          repositoryId: 'a'.repeat(16),
          cwd: root,
          worktree: false,
          sessionFile: null,
          removedAt: null,
          title: null,
          branch: null,
          model: null,
          activity: 'idle',
          control: { fence: 1, controller: { clientId: owner, label: 'test', connected: true } },
          attention: 0,
          read: 0,
          createdAt: '',
          updatedAt: '',
        }),
        listRepositories: () => [{ id: 'a'.repeat(16), name: 'repo', path: root }],
      },
      env: {},
      home: root,
      log() {},
    },
    env: {},
    epoch: 'a'.repeat(16),
    shell: () => '/bin/sh',
    load: () => [],
    save,
  })
  cleanup.push(service.close)
  const watch = (id: string, after?: TerminalSubscribe['after'], client = owner) => {
    const frames: TerminalFrame[] = []
    const unsubscribe = service.subscribe(
      { type: 'subscribe', topic: 'terminal', id: 'watch', terminalId: id, after },
      (frame) => frames.push(frame),
      client,
    )
    return { frames, unsubscribe }
  }
  return {
    service,
    owner,
    laneId,
    pty,
    save,
    data: (s: string) => data(s),
    exit: (code: number) => exit({ exitCode: code }),
    watch,
  }
}
async function create(f: ReturnType<typeof setup>) {
  const result = await f.service.execute(f.laneId, { type: 'terminal.create', cols: 80, rows: 24 })
  if (
    !result ||
    typeof result !== 'object' ||
    !('terminalId' in result) ||
    typeof result.terminalId !== 'string'
  )
    throw new Error('missing id')
  return result.terminalId
}
describe('terminal stream characterization', () => {
  it('splits UTF8 codepoints, evicts byte/count overflow and resets invalid cursors', async () => {
    const f = setup()
    const id = await create(f)
    const live = f.watch(id)
    f.data('x'.repeat(L.chunkBytes - 1) + '💡é')
    expect(live.frames.slice(1)).toMatchObject([
      { type: 'terminal.output', data: 'x'.repeat(L.chunkBytes - 1), seq: 1 },
      { type: 'terminal.output', data: '💡é', seq: 2 },
    ])
    f.data('💡'.repeat(L.scrollbackBytes / 4 + 1))
    const bounded = f.watch(id).frames[0]
    expect(bounded).toMatchObject({
      type: 'terminal.reset',
      data: '💡'.repeat((L.scrollbackBytes - L.chunkBytes) / 4 + 1),
    })
    for (let n = 0; n < 2049; n++) f.data('é')
    const reset = f.watch(id).frames[0]
    expect(reset).toMatchObject({ type: 'terminal.reset', data: 'é'.repeat(2048), seq: 2068 })
    for (const after of [
      { epoch: 'b'.repeat(16), seq: 2068 },
      { epoch: 'a'.repeat(16), seq: 0 },
      { epoch: 'a'.repeat(16), seq: 9999 },
    ])
      expect(f.watch(id, after).frames[0]).toEqual(reset)
    f.data('tail')
    expect(f.watch(id, { epoch: 'a'.repeat(16), seq: 2068 }).frames).toMatchObject([
      { type: 'terminal.output', seq: 2069, data: 'tail', id: 'watch' },
    ])
  })
  it('reports consumed input sequence in reset and hides login contents from other owners', async () => {
    const f = setup()
    const id = await create(f)
    expect(
      f.service.input(f.owner, { type: 'terminal.input', terminalId: id, seq: 1, data: 'x' }),
    ).toBe(true)
    expect(f.watch(id).frames[0]).toMatchObject({ type: 'terminal.reset', inputSeq: 1 })
    let loginId = ''
    const run = f.service.loginRunner(f.owner, (id) => {
      loginId = id
    })('/host/login', [], { cwd: root, env: {} })
    f.data('secret')
    expect(f.watch(loginId, undefined, randomUUID())).toEqual({ frames: [], unsubscribe: null })
    expect(f.watch(loginId).frames[0]).toMatchObject({ data: 'secret', status: 'running' })
    expect(f.save.mock.calls.flat(2)).not.toContainEqual(
      expect.objectContaining({ terminalId: loginId }),
    )
    f.service.machineOp(f.owner, { type: 'terminal.kill', terminalId: loginId })
    await expect(run).resolves.toEqual({ code: null })
  })
  it('completes the first subscriber to an exited login with a content-free tombstone', async () => {
    const f = setup()
    let id = ''
    const run = f.service.loginRunner(f.owner, (value) => {
      id = value
    })('/host/login', [], { cwd: root, env: {} })
    f.data('private login output')
    f.exit(7)
    f.data('late private output')
    await expect(run).resolves.toEqual({ code: null })
    expect(f.watch(id, undefined, randomUUID()).unsubscribe).toBeNull()
    expect(f.watch(id).frames).toEqual([
      {
        type: 'terminal.reset',
        id: 'watch',
        terminalId: id,
        epoch: 'a'.repeat(16),
        seq: 2,
        data: '',
        inputSeq: 0,
        status: 'exited',
      },
      {
        type: 'terminal.exit',
        id: 'watch',
        terminalId: id,
        epoch: 'a'.repeat(16),
        seq: 3,
        exitCode: 7,
      },
    ])
    expect(f.watch(id).unsubscribe).toBeNull()
  })
})
