import { describe, it, expect } from 'vitest'
import { collectTouchedFiles } from './collectTouchedFiles'
import type { ToolState } from '@/features/chat/reducer'

const WS = '/home/u/project'

function tool(overrides: Partial<ToolState> = {}): ToolState {
  return {
    toolCallId: 't1',
    toolName: 'edit',
    argsText: '',
    status: 'done',
    output: null,
    ...overrides,
  }
}

/** ToolPartialResult requires `content`; tests only care about `details`. */
function res(details: unknown): { content: []; details: unknown } {
  return { content: [], details }
}

/** pi display-diff format: `<marker><lineNo> <content>`. */
const diff = (adds: number, dels: number): string =>
  [
    ...Array.from({ length: adds }, (_, i) => `+${i + 1} added`),
    ...Array.from({ length: dels }, (_, i) => `-${i + 1} removed`),
  ].join('\n')

describe('collectTouchedFiles', () => {
  it('returns nothing for no tools', () => {
    expect(collectTouchedFiles({}, WS)).toEqual([])
  })

  it('ignores tools that are not done', () => {
    for (const status of ['starting', 'running', 'error'] as const) {
      const tools = { a: tool({ status, args: { path: `${WS}/a.ts` } }) }
      expect(collectTouchedFiles(tools, WS)).toEqual([])
    }
  })

  it('ignores tools that are neither edit nor write', () => {
    const tools = { a: tool({ toolName: 'read', args: { path: `${WS}/a.ts` } }) }
    expect(collectTouchedFiles(tools, WS)).toEqual([])
  })

  it('ignores tools with no path argument', () => {
    expect(collectTouchedFiles({ a: tool({ args: {} }) }, WS)).toEqual([])
    expect(collectTouchedFiles({ a: tool({ args: { path: 42 } }) }, WS)).toEqual([])
  })

  it('skips undefined entries in the tool record', () => {
    expect(collectTouchedFiles({ a: undefined }, WS)).toEqual([])
  })

  it('makes workspace-absolute paths relative', () => {
    const tools = { a: tool({ args: { path: `${WS}/src/a.ts` }, result: res({}) }) }
    expect(collectTouchedFiles(tools, WS)[0]!.relativePath).toBe('src/a.ts')
  })

  it('leaves already-relative paths alone', () => {
    const tools = { a: tool({ args: { path: 'src/a.ts' }, result: res({}) }) }
    expect(collectTouchedFiles(tools, WS)[0]!.relativePath).toBe('src/a.ts')
  })

  it('leaves absolute paths outside the workspace alone', () => {
    const tools = { a: tool({ args: { path: '/etc/hosts' }, result: res({}) }) }
    expect(collectTouchedFiles(tools, WS)[0]!.relativePath).toBe('/etc/hosts')
  })

  it('does not treat a sibling directory with a shared prefix as inside the workspace', () => {
    const tools = { a: tool({ args: { path: `${WS}-other/a.ts` }, result: res({}) }) }
    expect(collectTouchedFiles(tools, WS)[0]!.relativePath).toBe(`${WS}-other/a.ts`)
  })

  describe('write tools', () => {
    it('marks the file created and counts content lines as additions', () => {
      const tools = {
        a: tool({ toolName: 'write', args: { path: `${WS}/a.ts`, content: 'x\ny\nz' } }),
      }
      expect(collectTouchedFiles(tools, WS)).toEqual([
        { relativePath: 'a.ts', created: true, additions: 3, deletions: 0, patches: [] },
      ])
    })

    it('counts empty content as zero additions but still marks created', () => {
      const tools = { a: tool({ toolName: 'write', args: { path: `${WS}/a.ts`, content: '' } }) }
      expect(collectTouchedFiles(tools, WS)[0]).toMatchObject({ created: true, additions: 0 })
    })

    it('treats missing content as zero additions', () => {
      const tools = { a: tool({ toolName: 'write', args: { path: `${WS}/a.ts` } }) }
      expect(collectTouchedFiles(tools, WS)[0]).toMatchObject({ created: true, additions: 0 })
    })
  })

  describe('edit tools', () => {
    it('accumulates diff stats', () => {
      const tools = { a: tool({ args: { path: `${WS}/a.ts` }, result: res({ diff: diff(2, 1) }) }) }
      expect(collectTouchedFiles(tools, WS)[0]).toMatchObject({
        created: false,
        additions: 2,
        deletions: 1,
      })
    })

    it('collects unified patches in order', () => {
      const tools = {
        a: tool({ toolCallId: 'a', args: { path: `${WS}/a.ts` }, result: res({ patch: 'P1' }) }),
        b: tool({ toolCallId: 'b', args: { path: `${WS}/a.ts` }, result: res({ patch: 'P2' }) }),
      }
      expect(collectTouchedFiles(tools, WS)[0]!.patches).toEqual(['P1', 'P2'])
    })

    it('reads details from output when result has none, so streaming edits still count', () => {
      const tools = { a: tool({ args: { path: `${WS}/a.ts` }, output: res({ patch: 'P1' }) }) }
      expect(collectTouchedFiles(tools, WS)[0]!.patches).toEqual(['P1'])
    })

    it('tolerates an edit with no diff or patch', () => {
      const tools = { a: tool({ args: { path: `${WS}/a.ts` } }) }
      expect(collectTouchedFiles(tools, WS)[0]).toMatchObject({ additions: 0, patches: [] })
    })
  })

  it('merges repeated edits of one file into a single row', () => {
    const tools = {
      a: tool({ toolCallId: 'a', args: { path: `${WS}/a.ts` }, result: res({ diff: diff(2, 0) }) }),
      b: tool({ toolCallId: 'b', args: { path: `${WS}/a.ts` }, result: res({ diff: diff(1, 3) }) }),
    }
    const files = collectTouchedFiles(tools, WS)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ relativePath: 'a.ts', additions: 3, deletions: 3 })
  })

  it('keeps created=true when a write is followed by an edit of the same file', () => {
    const tools = {
      a: tool({ toolCallId: 'a', toolName: 'write', args: { path: `${WS}/a.ts`, content: 'x' } }),
      b: tool({ toolCallId: 'b', args: { path: `${WS}/a.ts` }, result: res({ diff: diff(1, 0) }) }),
    }
    expect(collectTouchedFiles(tools, WS)[0]).toMatchObject({ created: true, additions: 2 })
  })

  it('separates distinct files', () => {
    const tools = {
      a: tool({ toolCallId: 'a', args: { path: `${WS}/a.ts` }, result: res({ diff: diff(1, 0) }) }),
      b: tool({ toolCallId: 'b', args: { path: `${WS}/b.ts` }, result: res({ diff: diff(2, 0) }) }),
    }
    const files = collectTouchedFiles(tools, WS)
    expect(files.map((f) => f.relativePath).sort()).toEqual(['a.ts', 'b.ts'])
  })
})
