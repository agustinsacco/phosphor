import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_PI, writePiInstall } from './machine-files'

type Frame = {
  type: string
  id?: string
  data?: Record<string, unknown>
  message?: Record<string, unknown>
  toolName?: string
}
const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function fixture(args = ['--mode', 'rpc'], copied = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'fake-pi-characterization-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const executable = copied
    ? writePiInstall(root, {
        version: '1.2.0',
        manifestVersion: '1.2.0',
        engineRange: '>=22.19.0',
        rpc: true,
      }).pi
    : FAKE_PI
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: root,
    env: { HOME: root, PI_CODING_AGENT_DIR: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exit = once(child, 'exit')
    child.kill('SIGKILL')
    await exit
  })
  let output = ''
  let diagnostic = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (diagnostic += chunk))
  const records = (): Frame[] =>
    output
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  const request = async (type: string, data = {}) => {
    const id = randomUUID()
    child.stdin.write(JSON.stringify({ id, type, ...data }) + '\n')
    await expect.poll(() => records().find((frame) => frame.id === id)).toBeDefined()
    return records().find((frame) => frame.id === id)!
  }
  const settled = async (count: number) => {
    await expect.poll(() => records().filter((f) => f.type === 'agent_settled').length).toBe(count)
  }
  return {
    root,
    child,
    records,
    request,
    settled,
    output: () => output,
    diagnostic: () => diagnostic,
  }
}

async function sessionFile(h: ReturnType<typeof fixture>) {
  const file = (await h.request('get_state')).data?.sessionFile
  if (typeof file !== 'string') throw new Error('Missing session file')
  return file
}

function entries(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function expectChain(file: string) {
  const disk = entries(file)
  expect(disk[0]).toMatchObject({ type: 'session', version: 3 })
  for (let i = 1; i < disk.length; i++) {
    expect(disk[i]).toMatchObject({
      id: expect.any(String),
      parentId: i === 1 ? null : disk[i - 1]!.id,
    })
  }
  return disk
}

describe('fake pi executable characterization', () => {
  it('waits for print-mode stdin EOF before writing its exact LF reply', async () => {
    const h = fixture(['-p', 'name this'])
    h.child.stdin.write('not EOF\u2028or EOF\u2029')
    await expect.poll(h.diagnostic).toContain('FAKE_PI_PRINT_WAITING_FOR_EOF')
    expect(h.child.exitCode).toBeNull()
    expect(h.output()).toBe('')
    const exit = once(h.child, 'exit')
    h.child.stdin.end()
    await exit
    expect(h.output()).toBe('HOST_A_ONLY title\n')
    expect(existsSync(join(h.root, 'sessions'))).toBe(false)
  })

  it('frames only on LF, preserving Unicode separators and split input chunks', async () => {
    const h = fixture()
    await h.request('get_state')
    const message = 'PHX-framing\u2028middle\u2029end'
    const line = JSON.stringify({ id: 'split', type: 'prompt', message })
    const separator = line.indexOf('\u2028')
    h.child.stdin.write(line.slice(0, separator + 1))
    h.child.stdin.write(line.slice(separator + 1))
    // Not framed on U+2028: the single record below carries the whole message.
    h.child.stdin.write('\n')
    await h.settled(1)
    expect(h.records()).toContainEqual({
      type: 'message_end',
      message: { role: 'user', content: message },
    })
    expect(h.output().endsWith('\n')).toBe(true)
    expect(entries(await sessionFile(h))[1]).toMatchObject({ message: { content: message } })
  })

  it.each([false, true])(
    'preserves lazy creation, names, clone chains and resume recall (copied=%s)',
    async (copied) => {
      const h = fixture(['--mode', 'rpc', '-n', 'launch name'], copied)
      const original = await sessionFile(h)
      expect(existsSync(original)).toBe(false)
      const cwdFolder = `--${h.root.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
      expect(original).toContain(join('sessions', cwdFolder))
      await h.request('prompt', { message: 'PHX-persisted' })
      await h.settled(1)
      expect(expectChain(original)[1]).toMatchObject({ type: 'session_info', name: 'launch name' })
      await h.request('set_session_name', { name: 'manual name' })
      const before = expectChain(original)
      await h.request('prompt', { message: '/fake-clone' })
      const cloned = await sessionFile(h)
      expect(cloned).not.toBe(original)
      const cloneEntries = expectChain(cloned)
      expect(cloneEntries.slice(1)).toEqual(before.slice(1))
      expect(cloneEntries[0]!.id).not.toBe(before[0]!.id)
      await h.request('prompt', { message: 'PHX-cloned' })
      await h.settled(2)
      expect(entries(original)).toEqual(before)
      expectChain(cloned)
      const resumed = fixture(['--mode', 'rpc', '--session', cloned], copied)
      expect(await resumed.request('get_state')).toMatchObject({
        data: { sessionName: 'manual name', messageCount: 4 },
      })
      await resumed.request('prompt', { message: 'recall' })
      await resumed.settled(1)
      expect(await resumed.request('get_last_assistant_text')).toMatchObject({
        data: { text: 'PHX-cloned' },
      })
      expectChain(cloned)
    },
  )

  it('creates a header and chained name even before the first message', async () => {
    const h = fixture(['--mode', 'rpc', '-n', 'unused launch name'])
    const file = await sessionFile(h)
    await h.request('set_session_name', { name: 'early name' })
    expect(expectChain(file)).toHaveLength(2)
    await h.request('prompt', { message: 'hello' })
    await h.settled(1)
    const disk = expectChain(file)
    expect(disk.filter((entry) => entry.type === 'session_info')).toEqual([
      expect.objectContaining({ name: 'early name' }),
    ])
  })

  it.each([false, true])(
    'orders native tool events and persists versions, links and receipts (copied=%s)',
    async (copied) => {
      const h = fixture(['--mode', 'rpc'], copied)
      writeFileSync(join(h.root, 'remote.txt'), 'HOST_B_ONLY\n')
      await h.request('prompt', { message: 'artifact links receipt-test' })
      await h.settled(1)
      const toolEvents = h
        .records()
        .filter(
          (f) =>
            f.toolName ||
            f.message?.role === 'toolResult' ||
            (f.type === 'message_end' && f.message?.stopReason === 'toolUse'),
        )
      expect(toolEvents.map((f) => f.type)).toEqual(
        Array(4)
          .fill([
            'message_end',
            'tool_execution_start',
            'tool_execution_end',
            'message_start',
            'message_end',
          ])
          .flat(),
      )
      const file = await sessionFile(h)
      const disk = expectChain(file)
      expect(
        disk
          .filter((entry) => entry.type === 'message')
          .map((entry) => (entry.message as { role: string }).role),
      ).toEqual([
        'user',
        'assistant',
        'toolResult',
        'assistant',
        'toolResult',
        'assistant',
        'toolResult',
        'assistant',
        'toolResult',
        'assistant',
      ])
      expect(JSON.stringify(disk)).toContain('HOST_B_ONLY version 1')
      expect(JSON.stringify(disk)).toContain('HOST_B_ONLY guide line two')
      expect(JSON.stringify(disk)).toContain('1 test passed')
      expect(readFileSync(join(h.root, 'remote.txt'), 'utf8')).toBe('HOST_A_ONLY receipt edit\n')
      const resumed = fixture(['--mode', 'rpc', '--session', file], copied)
      await resumed.request('prompt', { message: 'artifact' })
      await resumed.settled(1)
      expect(resumed.records()).toContainEqual(
        expect.objectContaining({
          type: 'message_end',
          message: expect.objectContaining({
            role: 'toolResult',
            toolName: 'artifact_update',
            details: expect.objectContaining({ version: 2 }),
          }),
        }),
      )
      expectChain(file)
    },
  )

  it('reads attachment files and counts only PNG signature images', async () => {
    const h = fixture()
    const file = join(h.root, 'document.txt')
    writeFileSync(file, '  HOST_A_ONLY document\n')
    await h.request('prompt', {
      message: `PHX-hostinputs\n<attached-files>\n${file}\n</attached-files>`,
      images: [
        { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        { mimeType: 'image/jpeg', data: 'iVBORw0KGgo=' },
        { mimeType: 'image/png', data: 'bm90IGEgcG5n' },
      ],
    })
    await h.settled(1)
    expect(await h.request('get_last_assistant_text')).toMatchObject({
      data: { text: 'Attachments: HOST_A_ONLY document | 1 image/png' },
    })
  })
})
