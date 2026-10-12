import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import contextFiles, {
  applyContextFileArgs,
  contextFileKind,
  contextFilesIn,
  filterProjectContext,
  filterSystemMessages,
  parseProjectContext,
  savedContextFiles,
  CONTEXT_FILES_ENTRY,
  type ContextFileKind,
} from './context-files'

afterEach(() => vi.unstubAllEnvs())

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

  it('distinguishes user-global rules from cwd and ancestor rules of the same kind', () => {
    const files = contextFilesIn(
      render([GLOBAL, AGENTS, CLAUDE]),
      off('agents'),
      '/home/u/.pi/agent',
    )
    expect(files.map(({ scope, included }) => ({ scope, included }))).toEqual([
      { scope: 'global', included: false },
      { scope: 'project', included: false },
      { scope: 'project', included: true },
    ])
  })

  it('honors the configured agent directory without treating nested or adjacent paths as global', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '~/custom-pi/')
    const paths = [
      join(homedir(), 'custom-pi', 'CLAUDE.md'),
      join(homedir(), 'custom-pi', 'nested', 'AGENTS.md'),
      join(homedir(), 'custom-pi-other', 'AGENTS.md'),
      join(homedir(), '.pi', 'agent', 'AGENTS.md'),
    ]
    expect(
      contextFilesIn(render(paths.map((path) => ({ path, content: '' }))), off()).map(
        (file) => file.scope,
      ),
    ).toEqual(['global', 'project', 'project', 'project'])
  })

  it('resolves the default and relative agent directories like pi', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '')
    const global = { path: join(homedir(), '.pi', 'agent', 'AGENTS.md'), content: '' }
    expect(contextFilesIn(render([global]), off())[0]?.scope).toBe('global')
    const relative = { path: resolve('custom-pi', 'AGENTS.md'), content: '' }
    expect(contextFilesIn(render([relative]), off(), 'custom-pi')[0]?.scope).toBe('global')
  })

  it('is empty when pi found no context files', () => {
    expect(contextFilesIn('preamble\n\n<cwd>\n/repo\n</cwd>', off())).toEqual([])
  })
})

describe('context files extension', () => {
  // '' rather than undefined: the default reads PHOSPHOR_CONTEXT_FILES, which
  // a run inside Phosphor has set.
  function fakePi(initial = '') {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    let command!: (args: string, ctx: unknown) => Promise<void>
    const changes: unknown[] = []
    const entries: unknown[] = []
    const state = contextFiles(
      {
        on: (event, handler) => void handlers.set(event, handler),
        registerCommand: (_name, spec) => {
          command = spec.handler
        },
        appendEntry: (customType, data) => void entries.push({ type: 'custom', customType, data }),
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
      entries,
      start: (branch: unknown[]) =>
        handlers.get('session_start')!({}, { sessionManager: { getBranch: () => branch } }),
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

  it('saves each toggle so a reload or a reopened lane keeps it over the environment', async () => {
    const before = fakePi()
    await before.command('claude=off')
    expect(before.entries).toEqual([
      { type: 'custom', customType: CONTEXT_FILES_ENTRY, data: { off: ['claude'] } },
    ])
    // The rebuilt extension starts from an environment that says otherwise.
    const after = fakePi('agents=off')
    after.start([{ type: 'message' }, ...before.entries])
    expect([...after.state.off()]).toEqual(['claude'])
    // A lane that never toggled keeps the environment's value.
    const untouched = fakePi('agents=off')
    untouched.start([{ type: 'message' }])
    expect([...untouched.state.off()]).toEqual(['agents'])
  })
})

describe('savedContextFiles', () => {
  const entry = (data: unknown) => ({ type: 'custom', customType: CONTEXT_FILES_ENTRY, data })
  it('takes the newest entry on the branch and ignores what it cannot read', () => {
    expect(savedContextFiles([])).toBeNull()
    expect([...savedContextFiles([entry({ off: ['claude'] }), entry({ off: [] })])!]).toEqual([])
    expect([...savedContextFiles([entry({ off: ['agents', 'readme'] })])!]).toEqual(['agents'])
    expect(savedContextFiles([entry({ off: 'claude' })])).toBeNull()
    expect(
      savedContextFiles([{ type: 'custom', customType: 'other', data: { off: [] } }]),
    ).toBeNull()
  })
})
