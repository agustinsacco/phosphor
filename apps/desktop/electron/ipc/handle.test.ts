import { expect, it, vi, type Mock } from 'vitest'
const main = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: main }))
import type { IpcInvokeChannel } from '@shared/ipc'
import { REMOTE_UNAVAILABLE } from '../hosts/lane-ops'
import { handle, rejectRemoteArguments, setRemoteReadRouter } from './handle'

it('rejects opaque workspaces and remote handles before any local handler runs', () => {
  const local = vi.fn()
  handle('fs:readFile', local)
  const wrapped: unknown = main.handle.mock.calls[0]?.[1]
  if (typeof wrapped !== 'function') throw new Error('Missing handler')
  expect(() => wrapped({}, 'host:machine/repository')).toThrow('Not available on remote lanes yet.')
  expect(local).not.toHaveBeenCalled()
  expect(() => rejectRemoteArguments('sessions:delete', ['remote-0123456789abcdef'])).toThrow()
  expect(() =>
    rejectRemoteArguments('pi:createSession', [{ workspacePath: 'host:machine/repository' }]),
  ).toThrow()
  wrapped({}, '/local/file')
  expect(local).toHaveBeenCalledOnce()
})
it('allows app channels and explicitly routed pi calls, but bounds nested traversal', () => {
  expect(() => rejectRemoteArguments('hosts:openLane', ['remote-0123456789abcdef'])).not.toThrow()
  expect(() => rejectRemoteArguments('pi:command', ['remote-0123456789abcdef'])).not.toThrow()
  expect(() =>
    rejectRemoteArguments(
      'fs:readFile',
      Array.from({ length: 4096 }, () => 'local'),
    ),
  ).toThrow()
  expect(() =>
    rejectRemoteArguments(
      'fs:readFile',
      Array.from({ length: 4095 }, () => 'local'),
    ),
  ).not.toThrow()
  let nested: unknown = 'local'
  for (let i = 0; i < 17; i++) nested = [nested]
  expect(() => rejectRemoteArguments('fs:readFile', [nested])).toThrow()
})

it('routes reads before local side effects and retains the refusal for writes', async () => {
  const local = vi.fn()
  const call = vi.fn(async () => ['a.ts'])
  setRemoteReadRouter((windowId, channel, args) => {
    if (channel !== 'fs:listFiles' || !String(args[0]).startsWith('host:')) return null
    expect(windowId).toBe(7)
    return { result: call() }
  })
  try {
    handle('fs:listFiles', local)
    const read: unknown = main.handle.mock.calls.at(-1)?.[1]
    if (typeof read !== 'function') throw new Error('Missing handler')
    expect(await read({ sender: { id: 7 } }, 'host:machine/repository')).toEqual(['a.ts'])
    expect(local).not.toHaveBeenCalled()
    handle('fs:writeFile', local)
    const write: unknown = main.handle.mock.calls.at(-1)?.[1]
    if (typeof write !== 'function') throw new Error('Missing handler')
    expect(() => write({ sender: { id: 7 } }, 'host:machine/repository/a.ts', 'write')).toThrow(
      'Not available on remote lanes yet.',
    )
    expect(local).not.toHaveBeenCalled()
  } finally {
    setRemoteReadRouter(() => null)
  }
})

const REMOTE_KEYS = ['host:machine/repository', 'remote-0123456789abcdef']
const SENDER = { sender: { id: 1 } }
/** True when the call was refused with the fixed remote text; other errors propagate. */
function refusal(call: () => unknown): boolean {
  try {
    call()
    return false
  } catch (error) {
    if (error instanceof Error && error.message === REMOTE_UNAVAILABLE) return true
    throw error
  }
}
function refuses(channel: IpcInvokeChannel, ...args: unknown[]): boolean {
  return refusal(() => rejectRemoteArguments(channel, args))
}
/** The wrapper handle() registers with ipcMain for this channel. */
function registered(channel: IpcInvokeChannel, local: Mock) {
  handle(channel, local)
  const wrapped: unknown = main.handle.mock.calls.at(-1)?.[1]
  if (typeof wrapped !== 'function') throw new Error('Missing handler')
  return (event: unknown, ...args: unknown[]): unknown => wrapped(event, ...args)
}
const ROUTINE = {
  name: 'Nightly',
  instructions: 'Summarise',
  workspacePath: '/local/repository',
  isolated: false,
  intent: 'report',
  provider: 'anthropic',
  model: 'claude',
  timezone: 'UTC',
  schedule: { kind: 'manual' },
  period: 'none',
  catchUpHours: 0,
  maxRuntimeMinutes: 30,
  enabled: true,
  trusted: false,
}
const SKILL = { scope: 'project', name: 'Skill', description: 'd', content: 'c', draft: false }
const SEARCH = { searchId: 's1', query: { text: 'needle' } }

it('characterize: app channels and the four routed pi channels are not inspected', () => {
  for (const key of REMOTE_KEYS) {
    expect(refuses('hosts:openLane', key, key)).toBe(false)
    expect(refuses('app:recordWorkspace', key)).toBe(false)
    expect(refuses('clipboard:writeFiles', [key], false)).toBe(false)
    expect(refuses('pi:command', key, { type: 'get_state' })).toBe(false)
    expect(refuses('pi:extensionUiResponse', key, { id: 'ui', cancelled: true })).toBe(false)
    expect(refuses('pi:disposeSession', key)).toBe(false)
    expect(refuses('pi:listLiveSessions', key)).toBe(false)
  }
})

it('characterize: a router answer wins before the guard; a decline falls to the guard', async () => {
  const local = vi.fn(() => 'local')
  setRemoteReadRouter((_windowId, channel, args) => {
    if (channel === 'fs:writeFile' && args[0] === 'host:lane/a')
      return { result: Promise.resolve('routed') }
    if (channel === 'fs:trash' && args[0] === 'host:gone/a') throw new Error(REMOTE_UNAVAILABLE)
    return null
  })
  try {
    const write = registered('fs:writeFile', local)
    expect(await write(SENDER, 'host:lane/a', 'host:machine/content')).toBe('routed')
    const trash = registered('fs:trash', local)
    expect(refusal(() => trash(SENDER, 'host:gone/a'))).toBe(true)
    expect(refusal(() => trash(SENDER, 'host:declined/a'))).toBe(true)
    expect(local).not.toHaveBeenCalled()
  } finally {
    setRemoteReadRouter(() => null)
  }
})

it('characterize: local calls reach the handler with the event and arguments unchanged', async () => {
  const local = vi.fn(async (_event: unknown, path: unknown) => `read ${String(path)}`)
  const read = registered('fs:readFile', local)
  expect(await read(SENDER, '/local/a.ts')).toBe('read /local/a.ts')
  expect(local).toHaveBeenCalledWith(SENDER, '/local/a.ts')
  const list = vi.fn(() => ['/local/a.ts'])
  expect(registered('fs:statDirs', list)(SENDER, ['/local', '/local/src'])).toEqual(['/local/a.ts'])
  expect(list).toHaveBeenCalledWith(SENDER, ['/local', '/local/src'])
})

it('characterize: a remote secondary rename or transfer path never reaches local disk', () => {
  const local = vi.fn()
  const rename = registered('fs:rename', local)
  const transfer = registered('fs:transfer', local)
  for (const key of REMOTE_KEYS) {
    expect(refusal(() => rename(SENDER, '/local/a', key))).toBe(true)
    expect(refusal(() => transfer(SENDER, '/local', key, '/local', 'copy'))).toBe(true)
    expect(refusal(() => transfer(SENDER, '/local', '/local/a', key, 'move'))).toBe(true)
    expect(refusal(() => transfer(SENDER, key, '/local/a', '/local', 'copy'))).toBe(true)
  }
  expect(local).not.toHaveBeenCalled()
})

it('characterize: declared resource positions refuse host: workspaces and remote handles', () => {
  for (const key of REMOTE_KEYS) {
    expect(refuses('pi:createSession', { workspacePath: key })).toBe(true)
    expect(refuses('pi:createSession', { workspacePath: '/w', sessionPath: key })).toBe(true)
    expect(refuses('pi:createSession', { workspacePath: '/w', forkFrom: key })).toBe(true)
    expect(refuses('routines:save', { ...ROUTINE, workspacePath: key })).toBe(true)
    expect(refuses('routines:check', { ...ROUTINE, workspacePath: key })).toBe(true)
    expect(refuses('skills:create', { ...SKILL, workspacePath: key })).toBe(true)
    expect(refuses('skills:importConfirm', { sourcePath: key, scope: 'user' })).toBe(true)
    expect(
      refuses('skills:importConfirm', {
        sourcePath: '/s.zip',
        scope: 'project',
        workspacePath: key,
      }),
    ).toBe(true)
    expect(refuses('skills:writeFile', '/skills/a', 'SKILL.md', 'text', key)).toBe(true)
    expect(refuses('app:saveDialog', { title: 'Save', defaultPath: key })).toBe(true)
    expect(refuses('fs:searchWorkspace', { ...SEARCH, workspacePath: key })).toBe(true)
    expect(refuses('fs:statDirs', ['/local', key])).toBe(true)
    expect(refuses('git:infoBatch', [key])).toBe(true)
    expect(refuses('artifacts:list', ['/local/s.jsonl', key])).toBe(true)
    expect(refuses('sessions:delete', undefined, key)).toBe(true)
    expect(refuses('pty:create', '/local', 80, 24, key)).toBe(true)
    expect(refuses('git:commitAll', key, 'message')).toBe(true)
    expect(refuses('mcp:writeFile', 'project', key, '{}')).toBe(true)
    expect(refuses('packages:run', 'install', 'npm:x', 'project', key)).toBe(true)
    expect(refuses('claude:bindSession', '/local/s.jsonl', key)).toBe(true)
  }
  expect(refuses('pi:createSession', { workspacePath: '/w', sessionPath: '/w/s.jsonl' })).toBe(
    false,
  )
  expect(refuses('routines:list')).toBe(false)
  expect(refuses('mcp:readFile', 'global', undefined)).toBe(false)
  expect(refuses('skills:importConfirm', { sourcePath: '/s.zip', scope: 'user' })).toBe(false)
  expect(refuses('fs:searchWorkspace', { ...SEARCH, workspacePath: '/local' })).toBe(false)
})

it('regression: file content, terminal input and commit messages reach local handlers', () => {
  for (const text of REMOTE_KEYS) {
    const local = vi.fn(() => 'local')
    const write = registered('fs:writeFile', local)
    const input = registered('pty:write', local)
    const commit = registered('git:commitAll', local)
    expect(refusal(() => write(SENDER, '/local/a.ts', text, null))).toBe(false)
    expect(refusal(() => input(SENDER, 'pty-1', text))).toBe(false)
    expect(refusal(() => commit(SENDER, '/local/repository', text))).toBe(false)
    expect(local.mock.calls).toEqual([
      [SENDER, '/local/a.ts', text, null],
      [SENDER, 'pty-1', text],
      [SENDER, '/local/repository', text],
    ])
  }
})

it('regression: routine, label, title, HTML, MCP, config and skill text is never a resource', () => {
  for (const text of REMOTE_KEYS) {
    const routine = { ...ROUTINE, name: text, instructions: text, model: text }
    expect(refuses('routines:save', routine, undefined, undefined, undefined)).toBe(false)
    expect(refuses('routines:check', routine)).toBe(false)
    expect(refuses('sessions:appendLabel', '/local/s.jsonl', 'entry', text)).toBe(false)
    expect(refuses('pi:generateTitle', '/local', text, [text])).toBe(false)
    expect(refuses('artifacts:stageHtml', text, 'dark')).toBe(false)
    expect(refuses('artifacts:exportPdf', { html: text, title: text, theme: 'light' })).toBe(false)
    const server = { command: text, args: [text], env: { KEY: text } }
    expect(refuses('mcp:upsertServer', 'global', undefined, text, server)).toBe(false)
    expect(refuses('mcp:writeFile', 'project', '/local', text)).toBe(false)
    expect(refuses('pi:writeConfigFile', 'settings', text)).toBe(false)
    expect(refuses('pi:patchAgentSettings', 'project', '/local', { model: text })).toBe(false)
    expect(refuses('pi:patchWebSearchConfig', { provider: text })).toBe(false)
    expect(refuses('skills:writeFile', '/skills/a', 'SKILL.md', text, '/local')).toBe(false)
    const skill = { ...SKILL, name: text, description: text, content: text }
    expect(refuses('skills:create', skill)).toBe(false)
    expect(refuses('skills:install', 'library', text, { targetName: text })).toBe(false)
    expect(refuses('git:addWorktree', '/local', text, { kind: 'new', name: text })).toBe(false)
    expect(refuses('git:renameBranch', '/local', text, text)).toBe(false)
    expect(refuses('fs:searchWorkspace', { ...SEARCH, workspacePath: '/l', include: text })).toBe(
      false,
    )
    expect(refuses('claude:submitCode', text)).toBe(false)
  }
})

it('regression: only selected arrays are bounded; other payloads are not walked', () => {
  const paths = (count: number) => Array.from({ length: count }, (_, i) => `/local/${i}`)
  expect(refuses('fs:statDirs', paths(4096))).toBe(false)
  expect(refuses('fs:statDirs', paths(4097))).toBe(true)
  expect(refuses('git:infoBatch', paths(4097))).toBe(true)
  expect(refuses('artifacts:list', paths(4097))).toBe(true)
  const names = Array.from({ length: 5000 }, (_, i) => `name ${i}`)
  expect(refuses('pi:generateTitle', '/local', 'message', names)).toBe(false)
  let deep: unknown = 'host:machine/repository'
  for (let level = 0; level < 32; level++) deep = { level: deep }
  expect(refuses('pi:patchAgentSettings', 'global', undefined, { deep })).toBe(false)
  expect(refuses('mcp:upsertServer', 'global', undefined, 'n', { command: 'c', env: deep })).toBe(
    false,
  )
})

it('regression: malformed selected containers and keys fail closed', () => {
  expect(refuses('pi:createSession', null)).toBe(true)
  expect(refuses('pi:createSession', '/local')).toBe(true)
  expect(refuses('pi:createSession', [{ workspacePath: '/local' }])).toBe(true)
  expect(refuses('pi:createSession', { workspacePath: 42 })).toBe(true)
  expect(refuses('pi:createSession', {})).toBe(true)
  expect(refuses('pi:createSession', { workspacePath: '/local', sessionPath: null })).toBe(true)
  expect(refuses('app:saveDialog', null)).toBe(true)
  expect(refuses('routines:check', 'routine')).toBe(true)
  expect(refuses('fs:statDirs', '/local')).toBe(true)
  expect(refuses('fs:statDirs', { 0: '/local', length: 1 })).toBe(true)
  expect(refuses('fs:statDirs', ['/local', 7])).toBe(true)
  expect(refuses('git:infoBatch', ['/local', undefined])).toBe(true)
  expect(refuses('fs:readFile', 42)).toBe(true)
  expect(refuses('fs:readFile', undefined)).toBe(true)
  expect(refuses('fs:readFile')).toBe(true)
  expect(refuses('fs:rename', '/local/a', { path: '/local/b' })).toBe(true)
  expect(refuses('routines:list', undefined)).toBe(false)
  expect(refuses('mcp:readConfigs')).toBe(false)
  expect(refuses('sessions:delete', undefined, 'session-1')).toBe(false)
  expect(refuses('app:saveDialog', { title: 'Save' })).toBe(false)
})
