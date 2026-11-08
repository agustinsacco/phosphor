import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import subagentChild, {
  findRegister,
  registerSubagentChildren,
  SUBAGENT_EXTENSION_ID,
  type RegisterChildren,
} from './subagent-children'

function parent(find: () => Promise<RegisterChildren | undefined>) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  registerSubagentChildren(
    { on: (event, handler) => handlers.set(event, handler) },
    find,
    '/x/sc.ts',
  )
  const start = (sessionId: string) =>
    handlers.get('session_start')!({}, { sessionManager: { getSessionId: () => sessionId } })
  return { start, shutdown: () => handlers.get('session_shutdown')!({}, {}) }
}

describe('registerSubagentChildren', () => {
  it('registers this file for each session and releases it on the next or at shutdown', async () => {
    const disposals: string[] = []
    const register = vi.fn<RegisterChildren>(({ sessionId }) => ({
      dispose: () => disposals.push(sessionId),
    }))
    const pi = parent(async () => register)
    await pi.start('s1')
    expect(register).toHaveBeenCalledWith({
      sessionId: 's1',
      extensions: [{ id: SUBAGENT_EXTENSION_ID, path: '/x/sc.ts' }],
    })
    await pi.start('s2') // /new in the same process
    expect(disposals).toEqual(['s1'])
    pi.shutdown()
    expect(disposals).toEqual(['s1', 's2'])
  })

  it('does nothing without pi-subagents and survives a refused registration', async () => {
    await expect(parent(async () => undefined).start('s')).resolves.toBeUndefined()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const refuse: RegisterChildren = () => {
      throw new Error('already registered')
    }
    await expect(parent(async () => refuse).start('s')).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('already registered'))
    error.mockRestore()
  })
})

describe('findRegister', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

  /** A pi-subagents install whose `subagent` tool came from its index file. */
  function install(exports: object) {
    const dir = mkdtempSync(join(tmpdir(), 'phosphor-subagents-'))
    dirs.push(dir)
    const pkg = join(dir, 'node_modules', 'pi-subagents')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'pi-subagents', type: 'module', exports }),
    )
    writeFileSync(
      join(pkg, 'api.js'),
      'export const registerRequiredChildExtensions = () => "ok"\n',
    )
    const tools = [
      { name: 'read' },
      { name: 'subagent', sourceInfo: { path: join(pkg, 'index.ts') } },
    ]
    return { on: vi.fn(), getAllTools: () => tools }
  }

  it("resolves the API through the package that registered pi-subagents' tools", async () => {
    const register = await findRegister(
      install({ './required-child-extensions': { default: './api.js' } }),
    )
    expect(register?.({ sessionId: 's', extensions: [] })).toBe('ok')
  })

  it('finds nothing without pi-subagents or in one from before the API', async () => {
    expect(await findRegister({ on: vi.fn(), getAllTools: () => [] })).toBeUndefined()
    expect(await findRegister(install({ '.': './api.js' }))).toBeUndefined()
  })
})

describe('the child set', () => {
  it('guards paths and tool names, filters context files and applies the budget', () => {
    const events: string[] = []
    const commands: string[] = []
    subagentChild({
      on: (event) => void events.push(event),
      registerCommand: (name) => void commands.push(name),
      setModel: vi.fn(),
    })
    expect(events).toEqual(
      expect.arrayContaining(['tool_call', 'message_end', 'context_with_system', 'turn_end']),
    )
    expect(commands.sort()).toEqual(['phosphor-context-budget', 'phosphor-context-files'])
    expect(events).not.toContain('agent_settled') // no Swarm
  })
})
