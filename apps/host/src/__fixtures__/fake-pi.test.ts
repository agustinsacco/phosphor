import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const executable = resolve(import.meta.dirname, 'fake-pi.cjs')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(args: string[] = ['--mode', 'rpc']) {
  const root = await mkdtemp(join(tmpdir(), 'host-fake-pi-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [executable, ...args], {
    cwd: root,
    env: { HOME: root, PI_CODING_AGENT_DIR: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    child.kill('SIGKILL')
    await exited
  })
  let output = ''
  let diagnostic = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    diagnostic = (diagnostic + chunk).slice(-8192)
  })
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
  })
  const records = () =>
    output
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => {
        const value: unknown = JSON.parse(line)
        if (typeof value !== 'object' || value === null || Array.isArray(value))
          throw new Error('Bad fake frame')
        return value
      })
  const request = async (type: string, data = {}) => {
    const id = randomUUID()
    child.stdin.write(JSON.stringify({ id, type, ...data }) + '\n')
    await expect.poll(() => records().some((frame) => 'id' in frame && frame.id === id)).toBe(true)
    return records().find((frame) => 'id' in frame && frame.id === id)
  }
  const settled = async (count: number) => {
    await expect
      .poll(() => records().filter((frame) => 'type' in frame && frame.type === 'agent_end').length)
      .toBe(count)
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

describe('Host fake pi acceptance scripts', () => {
  it('print mode waits for EOF and creates no session', async () => {
    const h = await fixture(['-p', 'name this'])
    h.child.stdin.write('input is still open')
    const exit = new Promise<void>((done) => h.child.once('exit', () => done()))
    await expect.poll(h.diagnostic).toContain('FAKE_PI_PRINT_WAITING_FOR_EOF')
    expect(h.child.exitCode).toBeNull()
    expect(h.output()).toBe('')
    h.child.stdin.end()
    await exit
    expect(h.output()).toBe('HOST_A_ONLY title\n')
  })

  it('finishes turns, recalls persisted tokens, and persists a manual name on resume', async () => {
    const h = await fixture()
    await h.request('prompt', { message: 'PHX-persisted' })
    await h.settled(1)
    await h.request('set_session_name', { name: 'HOST_A_ONLY manual name' })
    await h.request('get_state')
    const response = h
      .records()
      .findLast(
        (frame) =>
          'data' in frame &&
          typeof frame.data === 'object' &&
          frame.data !== null &&
          'sessionFile' in frame.data,
      )
    if (
      !response ||
      !('data' in response) ||
      typeof response.data !== 'object' ||
      response.data === null ||
      !('sessionFile' in response.data) ||
      typeof response.data.sessionFile !== 'string'
    )
      throw new Error('Missing file')
    const sessionFile = response.data.sessionFile
    const disk = await readFile(sessionFile, 'utf8')
    expect(disk).toContain('PHX-persisted')
    expect(disk).toContain('session_info')
    const resumed = await fixture(['--mode', 'rpc', '--session', sessionFile])
    expect(await resumed.request('get_state')).toMatchObject({
      data: { sessionName: 'HOST_A_ONLY manual name' },
    })
    await resumed.request('prompt', { message: 'recall' })
    await resumed.settled(1)
    expect(await resumed.request('get_last_assistant_text')).toMatchObject({
      data: { text: 'PHX-persisted' },
    })
  })

  it('consumes steering and follow-up after abort without duplicate user messages', async () => {
    const h = await fixture()
    await h.request('prompt', { message: 'stream' })
    await h.request('steer', { message: 'PHX-steer' })
    await h.request('follow_up', { message: 'PHX-follow' })
    await h.request('abort')
    await h.settled(3)
    expect(await h.request('get_messages')).toMatchObject({
      data: {
        messages: [
          { role: 'user', content: 'stream' },
          { role: 'assistant', stopReason: 'aborted' },
          { role: 'user', content: 'PHX-steer' },
          { role: 'assistant', content: [{ text: 'PHX-steer' }] },
          { role: 'user', content: 'PHX-follow' },
          { role: 'assistant', content: [{ text: 'PHX-follow' }] },
        ],
      },
    })
  })

  it('keeps a controlled slow turn streaming beyond the ordinary slow limit until released', async () => {
    const h = await fixture()
    const release = join(h.root, 'release')
    await h.request('prompt', { message: `slow-until ${release}` })
    await expect.poll(h.output).toContain('"delta":"13 "')
    expect(await h.request('get_state')).toMatchObject({ data: { isStreaming: true } })
    expect(
      h.records().filter((frame) => 'type' in frame && frame.type === 'agent_end'),
    ).toHaveLength(0)
    await writeFile(release, '')
    await h.settled(1)
    expect(await h.request('get_state')).toMatchObject({ data: { isStreaming: false } })
    expect(await h.request('get_messages')).toMatchObject({
      data: {
        messages: [
          { role: 'user', content: `slow-until ${release}` },
          {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ text: expect.stringMatching(/^1 2 3 /) }],
          },
        ],
      },
    })
  })

  it('offers two models, handles Host commands without a turn, and compacts', async () => {
    const h = await fixture(['--mode', 'rpc', '-e', '/fixture/context-breakdown.ts'])
    expect(await h.request('get_available_models')).toMatchObject({
      data: {
        models: [
          { provider: 'fake', name: 'HOST_A_ONLY Fast' },
          { provider: 'anthropic', name: 'HOST_B_ONLY Reasoner' },
        ],
      },
    })
    expect(await h.request('get_commands')).toMatchObject({
      data: {
        commands: expect.arrayContaining([
          { name: 'host-only', description: 'HOST_A_ONLY command', source: 'extension' },
        ]),
      },
    })
    await h.request('prompt', { message: '/host-only' })
    expect(
      h.records().filter((frame) => 'type' in frame && frame.type === 'agent_start'),
    ).toHaveLength(0)
    await h.request('set_model', { provider: 'anthropic', modelId: 'host-reasoner' })
    await h.request('set_thinking_level', { level: 'high' })
    expect(await h.request('get_state')).toMatchObject({
      data: { model: { provider: 'anthropic', contextWindow: 100000 }, thinkingLevel: 'high' },
    })
    expect(await h.request('compact')).toMatchObject({ data: { summary: 'HOST_A_ONLY compacted' } })
  })

  it('persists native artifact calls/results and versions, links, slow and failed turns', async () => {
    const h = await fixture()
    for (const [index, message] of [
      'artifact',
      'artifact version two',
      'links',
      'slow',
      'fail-turn',
    ].entries()) {
      await h.request('prompt', { message })
      await h.settled(index + 1)
    }
    const messages = await h.request('get_messages')
    expect(JSON.stringify(messages)).toContain('artifact_create')
    expect(JSON.stringify(messages)).toContain('artifact_update')
    expect(JSON.stringify(messages)).toContain('toolResult')
    expect(JSON.stringify(messages)).toContain('HOST_A_ONLY version 2')
    expect(JSON.stringify(messages)).toContain('nested/guide.md#L2')
    expect(JSON.stringify(messages)).toContain('"stopReason":"error"')
  })

  it('provider-login script writes credentials that auth check reports ready', async () => {
    const h = await fixture(['--no-session', '--no-extensions'])
    await writeFile(join(h.root, 'auth.json'), '{}')
    h.child.stdin.write('/login anthropic\n')
    await expect.poll(() => readFile(join(h.root, 'auth.json'), 'utf8')).toContain('anthropic')
    const check = spawn(
      process.execPath,
      [executable, 'auth', 'check', '--provider', 'anthropic'],
      { env: { HOME: h.root, PI_CODING_AGENT_DIR: h.root }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    check.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    check.stderr.resume()
    await new Promise<void>((done) => check.once('exit', () => done()))
    expect(JSON.parse(output)).toMatchObject({ status: 'ready', provider: 'anthropic' })
    h.child.stdin.write('/quit\n')
  })
})
