import { describe, expect, it } from 'vitest'
import contextFiles, {
  applyContextFileArgs,
  contextFileKind,
  contextFilesIn,
  filterProjectContext,
  filterSystemMessages,
  parseProjectContext,
  type ContextFileKind,
} from './context-files'

/** pi 0.87.1's `renderProjectContext` plus its section wrapper, byte for byte. */
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

const CLAUDE = { path: '/repo/CLAUDE.md', content: '# Repo rules\n\nUse tabs.\n' }
const AGENTS = { path: '/repo/pkg/AGENTS.md', content: 'Agents notes' }
const GLOBAL = { path: '/home/u/.pi/agent/AGENTS.override.md', content: 'Global notes' }
const off = (...kinds: ContextFileKind[]) => new Set(kinds)

describe('contextFileKind', () => {
  it('sorts pi’s context file names into the two toggles, any case', () => {
    expect(contextFileKind('/r/CLAUDE.md')).toBe('claude')
    expect(contextFileKind('/r/claude.MD')).toBe('claude')
    expect(contextFileKind('/r/AGENTS.md')).toBe('agents')
    expect(contextFileKind('C:\\r\\AGENTS.MD')).toBe('agents')
    expect(contextFileKind('/r/AGENTS.override.md')).toBe('agents')
    expect(contextFileKind('/r/README.md')).toBeNull()
  })
})

describe('applyContextFileArgs', () => {
  it('changes only the kinds named', () => {
    expect([...applyContextFileArgs(off('agents'), 'claude=off')]).toEqual(['agents', 'claude'])
    expect([...applyContextFileArgs(off('claude', 'agents'), 'agents=on')]).toEqual(['claude'])
    expect([...applyContextFileArgs(off(), 'claude=off,agents=off')]).toEqual(['claude', 'agents'])
    expect([...applyContextFileArgs(off('claude'), '')]).toEqual(['claude'])
  })

  it('refuses anything else rather than guessing', () => {
    expect(() => applyContextFileArgs(off(), 'claude=no')).toThrow(/Invalid/)
    expect(() => applyContextFileArgs(off(), 'readme=off')).toThrow(/Invalid/)
  })
})

describe('parseProjectContext', () => {
  it('reads the blocks back out of pi’s rendering', () => {
    const blocks = parseProjectContext(render([CLAUDE, AGENTS]))
    expect(blocks?.map((b) => b.path)).toEqual([CLAUDE.path, AGENTS.path])
  })

  it('does not split a file that quotes the tags mid-line', () => {
    const tricky = {
      path: '/r/CLAUDE.md',
      content: 'pi wraps files in <project_instructions path="x">',
    }
    expect(parseProjectContext(render([tricky, AGENTS]))?.map((b) => b.path)).toEqual([
      tricky.path,
      AGENTS.path,
    ])
  })

  it('returns null for a shape it does not know', () => {
    expect(parseProjectContext('<project_context>\nsomething else\n</project_context>')).toBeNull()
    expect(parseProjectContext('plain text')).toBeNull()
  })
})

describe('filterProjectContext', () => {
  it('drops only the disabled kind and keeps pi’s format', () => {
    expect(filterProjectContext(render([CLAUDE, AGENTS]), off('claude'))).toBe(render([AGENTS]))
    expect(filterProjectContext(render([CLAUDE, AGENTS, GLOBAL]), off('agents'))).toBe(
      render([CLAUDE]),
    )
  })

  it('returns null when nothing is left, and the input when nothing matched', () => {
    expect(filterProjectContext(render([CLAUDE]), off('claude'))).toBeNull()
    const section = render([AGENTS])
    expect(filterProjectContext(section, off('claude'))).toBe(section)
  })

  it('sends an unknown shape unchanged rather than mangling it', () => {
    expect(filterProjectContext('<project_context>\n?\n</project_context>', off('claude'))).toBe(
      '<project_context>\n?\n</project_context>',
    )
  })
})

describe('filterSystemMessages', () => {
  it('removes a file from the leading prompt and from later section patches', () => {
    const messages = [
      { role: 'system', sections: { preamble: 'p', project_context: render([CLAUDE, AGENTS]) } },
      { role: 'user', content: 'hi' },
      // pi patches the section when a file changes on disk between runs.
      { role: 'system', sections: { project_context: render([CLAUDE]) } },
    ]
    expect(filterSystemMessages(messages, off('claude'))).toBe(true)
    expect(messages[0]).toEqual({
      role: 'system',
      sections: { preamble: 'p', project_context: render([AGENTS]) },
    })
    // A later patch emptied by the filter must REMOVE the section, or the
    // AGENTS.md block declared by the leading message would still apply.
    expect(messages[2]).toEqual({ role: 'system', sections: { project_context: null } })
  })

  it('drops an emptied leading section instead of sending an empty one', () => {
    const messages = [
      { role: 'system', sections: { preamble: 'p', project_context: render([CLAUDE]) } },
    ]
    filterSystemMessages(messages, off('claude'))
    expect(messages[0]!.sections).toEqual({ preamble: 'p' })
  })

  it('reports no change when there is nothing to remove', () => {
    const messages = [{ role: 'system', sections: { project_context: render([AGENTS]) } }]
    expect(filterSystemMessages(messages, off('claude'))).toBe(false)
  })
})

describe('contextFilesIn', () => {
  it('lists the files with their cost and whether they are sent', () => {
    const prompt = `preamble\n\n${render([CLAUDE, AGENTS])}\n\n<cwd>\n/repo\n</cwd>`
    const files = contextFilesIn(prompt, off('claude'))
    expect(files.map(({ path, kind, included }) => ({ path, kind, included }))).toEqual([
      { path: CLAUDE.path, kind: 'claude', included: false },
      { path: AGENTS.path, kind: 'agents', included: true },
    ])
    expect(files[0]!.tokens).toBeGreaterThan(0)
  })

  it('is empty when pi found no context files', () => {
    expect(contextFilesIn('preamble\n\n<cwd>\n/repo\n</cwd>', off())).toEqual([])
  })
})

describe('context files extension', () => {
  function fakePi(initial?: string) {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    let command!: (args: string, ctx: unknown) => Promise<void>
    const changes: unknown[] = []
    const state = contextFiles(
      {
        on: (event, handler) => void handlers.set(event, handler),
        registerCommand: (_name, spec) => {
          command = spec.handler
        },
      },
      (ctx) => changes.push(ctx),
      initial,
    )
    const request = () => [
      { role: 'system', sections: { project_context: render([CLAUDE, AGENTS]) } },
    ]
    return {
      state,
      changes,
      command: (args: string) => command(args, 'ctx'),
      send: () => handlers.get('context_with_system')!({ messages: request() }, {}),
    }
  }

  it('starts from the environment and leaves every request alone when nothing is off', () => {
    expect([...fakePi('claude=off').state.off()]).toEqual(['claude'])
    expect(fakePi().send()).toBeUndefined()
    // A malformed value sends every file, as pi would.
    expect([...fakePi('claude=maybe').state.off()]).toEqual([])
  })

  it('applies a toggle to the next request and announces it', async () => {
    const pi = fakePi()
    await pi.command('agents=off')
    expect(pi.changes).toEqual(['ctx'])
    const result = pi.send() as { messages: Array<{ sections: Record<string, string> }> }
    expect(result.messages[0]!.sections.project_context).toBe(render([CLAUDE]))
    await pi.command('agents=on')
    expect(pi.send()).toBeUndefined()
  })
})
