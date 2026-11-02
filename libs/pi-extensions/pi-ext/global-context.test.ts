import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filterSystemMessages } from './context-files'
import globalContext, {
  applyGlobalContext,
  globalContextReader,
  liveSystemPrompt,
  swapGlobalContext,
} from './global-context'

/** pi 1.3.0's `renderProjectContext` plus its section wrapper, byte for byte. */
function render(files: Array<{ path: string; content: string }>): string {
  const inner = [
    'Project-specific instructions and guidelines:',
    ...files.map(
      ({ path, content }) =>
        `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
    ),
  ].join('\n\n')
  return `<project_context>\n${inner}\n</project_context>`
}

const DIR = '/home/u/.pi/agent'
const OLD = { path: `${DIR}/AGENTS.md`, content: 'Old global' }
const NEW = { path: `${DIR}/AGENTS.md`, content: 'New global' }
const REPO = { path: '/repo/AGENTS.md', content: 'Repo rules' }
const CLAUDE = { path: '/repo/CLAUDE.md', content: 'Claude rules' }

describe('swapGlobalContext', () => {
  it('replaces the global block and leaves repository files as pi rendered them', () => {
    expect(swapGlobalContext(render([OLD, REPO]), NEW, DIR)).toBe(render([NEW, REPO]))
  })

  it('returns the section itself when the file has not changed', () => {
    const section = render([OLD, REPO])
    expect(swapGlobalContext(section, OLD, DIR)).toBe(section)
  })

  it('adds a file created after the lane started, first, as pi orders it', () => {
    expect(swapGlobalContext(render([REPO]), NEW, DIR)).toBe(render([NEW, REPO]))
    expect(swapGlobalContext(undefined, NEW, DIR)).toBe(render([NEW]))
  })

  it('removes a deleted file, and the section when nothing is left', () => {
    expect(swapGlobalContext(render([OLD, REPO]), null, DIR)).toBe(render([REPO]))
    expect(swapGlobalContext(render([OLD]), null, DIR)).toBeNull()
    expect(swapGlobalContext(undefined, null, DIR)).toBeUndefined()
  })

  it('follows a change of file name in the agent directory', () => {
    const override = { path: `${DIR}/AGENTS.override.md`, content: 'Override' }
    expect(swapGlobalContext(render([OLD, REPO]), override, DIR)).toBe(render([override, REPO]))
  })

  it('leaves a shape it does not know alone', () => {
    const odd = '<project_context>\nsomething else\n</project_context>'
    expect(swapGlobalContext(odd, NEW, DIR)).toBe(odd)
  })
})

describe('applyGlobalContext', () => {
  it('updates the leading prompt and later section patches in place', () => {
    const messages = [
      { role: 'system', sections: { preamble: 'p', project_context: render([OLD, REPO]) } },
      { role: 'user', content: 'hi' },
      { role: 'system', sections: { project_context: render([OLD]) } },
    ]
    expect(applyGlobalContext(messages, NEW, DIR)).toBe(true)
    expect(messages[0]!.sections).toEqual({ preamble: 'p', project_context: render([NEW, REPO]) })
    expect(messages[2]!.sections).toEqual({ project_context: render([NEW]) })
  })

  it('declares a new section in the leading message only, where pi puts it', () => {
    const messages = [
      { role: 'system', sections: { preamble: 'p', addendum: 'a', skills: 's', cwd: '/r' } },
      { role: 'system', sections: { tools: 't' } },
    ]
    expect(applyGlobalContext(messages, NEW, DIR)).toBe(true)
    expect(Object.keys(messages[0]!.sections)).toEqual([
      'preamble',
      'addendum',
      'project_context',
      'skills',
      'cwd',
    ])
    expect(messages[1]!.sections).toEqual({ tools: 't' })
  })

  it('removes an emptied section: dropped when leading, null when a later patch', () => {
    const messages = [
      { role: 'system', sections: { preamble: 'p', project_context: render([OLD]) } },
      { role: 'system', sections: { project_context: render([OLD]) } },
    ]
    applyGlobalContext(messages, null, DIR)
    expect(messages[0]!.sections).toEqual({ preamble: 'p' })
    expect(messages[1]!.sections).toEqual({ project_context: null })
  })

  it('reports no change when the file matches what pi loaded', () => {
    const messages = [{ role: 'system', sections: { project_context: render([OLD, REPO]) } }]
    expect(applyGlobalContext(messages, OLD, DIR)).toBe(false)
  })

  it('composes with the repository-file filter, which keeps the global block', () => {
    const messages = [
      { role: 'system', sections: { project_context: render([OLD, REPO, CLAUDE]) } },
    ]
    applyGlobalContext(messages, NEW, DIR)
    filterSystemMessages(messages, new Set(['agents', 'claude']), DIR)
    expect(messages[0]!.sections.project_context).toBe(render([NEW]))
  })
})

describe('liveSystemPrompt', () => {
  it('measures the prompt as it is sent, not as the lane started', () => {
    const prompt = `pre\n\n${render([OLD, REPO])}\n\n<cwd>\n/r\n</cwd>`
    expect(liveSystemPrompt(prompt, NEW, DIR)).toBe(
      `pre\n\n${render([NEW, REPO])}\n\n<cwd>\n/r\n</cwd>`,
    )
    expect(liveSystemPrompt('pre', NEW, DIR)).toBe(`pre\n\n${render([NEW])}`)
    expect(liveSystemPrompt(`pre\n\n${render([OLD])}`, null, DIR)).toBe('pre\n\n')
  })
})

describe('global context on disk', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'phosphor-global-context-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the file pi would pick, in pi’s order, without a BOM', () => {
    const read = globalContextReader(dir)
    expect(read()).toBeNull()
    writeFileSync(join(dir, 'CLAUDE.md'), 'claude')
    expect(read()).toEqual({ path: join(dir, 'CLAUDE.md'), content: 'claude' })
    writeFileSync(join(dir, 'AGENTS.md'), '\ufeffagents')
    expect(read()).toEqual({ path: join(dir, 'AGENTS.md'), content: 'agents' })
    mkdirSync(join(dir, 'AGENTS.override.md'))
    expect(read()?.path).toBe(join(dir, 'AGENTS.md'))
  })

  it('picks up an edit on the next read', () => {
    const file = join(dir, 'AGENTS.md')
    writeFileSync(file, 'one')
    const read = globalContextReader(dir)
    expect(read()?.content).toBe('one')
    writeFileSync(file, 'two, longer')
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect(read()?.content).toBe('two, longer')
  })

  function wire(argv: string[] = ['node', 'pi', '--mode', 'rpc']) {
    let handler!: (event: unknown, ctx: unknown) => unknown
    const live = globalContext({ on: (_event, h) => void (handler = h) }, dir, argv)
    const send = (section: string) =>
      handler({ messages: [{ role: 'system', sections: { project_context: section } }] }, {}) as
        { messages: Array<{ sections: Record<string, string> }> } | undefined
    return { live, send }
  }

  it('sends a running lane the file as saved, before every request', () => {
    const file = join(dir, 'AGENTS.md')
    writeFileSync(file, 'as started')
    const started = render([{ path: file, content: 'as started' }, REPO])
    const lane = wire()
    expect(lane.send(started)).toBeUndefined()
    writeFileSync(file, 'saved from Settings')
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect(lane.send(started)?.messages[0]!.sections.project_context).toBe(
      render([{ path: file, content: 'saved from Settings' }, REPO]),
    )
    expect(lane.live.prompt(started)).toContain('saved from Settings')
  })

  it('adds nothing to a pi started without context files', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'global')
    for (const flag of ['--no-context-files', '-nc']) {
      const lane = wire(['node', 'pi', flag])
      expect(lane.send(render([REPO]))).toBeUndefined()
      expect(lane.live.prompt('pre')).toBe('pre')
    }
  })
})
