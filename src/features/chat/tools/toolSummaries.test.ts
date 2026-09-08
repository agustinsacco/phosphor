import { describe, it, expect } from 'vitest'
import {
  toolText,
  editDiffStats,
  partialStringArg,
  summarizeTool,
  tryParseArgs,
  truncate,
} from './toolSummaries'
import type { ToolState } from '../reducer'

function tool(overrides: Partial<ToolState> = {}): ToolState {
  return {
    toolCallId: 't1',
    toolName: 'read',
    argsText: '',
    status: 'done',
    output: null,
    ...overrides,
  }
}

/** ToolPartialResult requires `content`; these cases only exercise `details`. */
function res(details: unknown): { content: []; details: unknown } {
  return { content: [], details }
}

describe('truncate', () => {
  it('collapses all whitespace runs to single spaces and trims', () => {
    expect(truncate('  a \n\t b  ', 80)).toBe('a b')
  })

  it('leaves text at or under the limit untouched', () => {
    expect(truncate('abcde', 5)).toBe('abcde')
  })

  it('cuts to max-1 chars and appends an ellipsis when over the limit', () => {
    expect(truncate('abcdef', 5)).toBe('abcd…')
    expect(truncate('abcdef', 5)).toHaveLength(5)
  })
})

describe('tryParseArgs', () => {
  it('returns undefined for empty text', () => {
    expect(tryParseArgs('')).toBeUndefined()
  })

  it('parses a JSON object', () => {
    expect(tryParseArgs('{"path":"a.ts"}')).toEqual({ path: 'a.ts' })
  })

  it('returns undefined for malformed JSON rather than throwing', () => {
    expect(tryParseArgs('{"path":')).toBeUndefined()
  })

  it('rejects valid JSON that is not an object', () => {
    expect(tryParseArgs('42')).toBeUndefined()
    expect(tryParseArgs('null')).toBeUndefined()
    expect(tryParseArgs('"str"')).toBeUndefined()
  })

  it('accepts arrays, which are objects', () => {
    expect(tryParseArgs('[1,2]')).toEqual([1, 2])
  })
})

describe('toolText', () => {
  it('returns empty string when there is no content', () => {
    expect(toolText(tool())).toBe('')
  })

  it('prefers output over result', () => {
    const t = tool({
      output: { content: [{ type: 'text', text: 'from-output' }] },
      result: { content: [{ type: 'text', text: 'from-result' }] },
    })
    expect(toolText(t)).toBe('from-output')
  })

  it('falls back to result when output is null', () => {
    const t = tool({ result: { content: [{ type: 'text', text: 'from-result' }] } })
    expect(toolText(t)).toBe('from-result')
  })

  it('joins multiple text blocks with newlines and skips non-text blocks', () => {
    const t = tool({
      output: {
        content: [
          { type: 'text', text: 'one' },
          { type: 'image', data: 'xxx', mimeType: 'image/png' },
          { type: 'text', text: 'two' },
        ],
      },
    })
    expect(toolText(t)).toBe('one\ntwo')
  })
})

describe('editDiffStats', () => {
  // pi's display-diff format is `<marker><lineNo> <content>`.
  const diff = ['+2 added line', '-2 removed line', ' 1 context'].join('\n')
  const patch = ['--- a/f.ts', '+++ b/f.ts', '@@ -1,2 +1,2 @@', '-old', '+new'].join('\n')

  it('returns null when neither diff nor patch is present', () => {
    expect(editDiffStats(tool({ toolName: 'edit' }))).toBeNull()
  })

  it('reads details from result', () => {
    expect(editDiffStats(tool({ toolName: 'edit', result: res({ diff }) }))).toEqual({
      additions: 1,
      deletions: 1,
    })
  })

  it('reads details from output when result has none', () => {
    expect(editDiffStats(tool({ toolName: 'edit', output: res({ diff }) }))).toEqual({
      additions: 1,
      deletions: 1,
    })
  })

  it('prefers result over output', () => {
    const t = tool({
      toolName: 'edit',
      result: res({ diff: '+1 a' }),
      output: res({ diff: '+1 a\n+2 b\n+3 c' }),
    })
    expect(editDiffStats(t)).toEqual({ additions: 1, deletions: 0 })
  })

  it('prefers diff over patch when both are present', () => {
    const t = tool({ toolName: 'edit', result: res({ diff: '+1 a\n+2 b', patch }) })
    expect(editDiffStats(t)).toEqual({ additions: 2, deletions: 0 })
  })

  it('falls back to unified patch stats', () => {
    expect(editDiffStats(tool({ toolName: 'edit', result: res({ patch }) }))).toEqual({
      additions: 1,
      deletions: 1,
    })
  })
})

describe('summarizeTool', () => {
  it('uses past-tense labels when done and present participles while running', () => {
    const args = { path: 'src/a.ts' }
    expect(summarizeTool(tool({ toolName: 'read', args, status: 'done' })).label).toBe('Read')
    expect(summarizeTool(tool({ toolName: 'read', args, status: 'running' })).label).toBe('Reading')
    expect(summarizeTool(tool({ toolName: 'read', args, status: 'starting' })).label).toBe(
      'Reading',
    )
  })

  it('treats error status as not-running', () => {
    expect(summarizeTool(tool({ toolName: 'read', status: 'error' })).label).toBe('Read')
  })

  it('reduces read/edit/write paths to a basename', () => {
    const args = { path: 'src/deep/a.ts' }
    expect(summarizeTool(tool({ toolName: 'read', args })).object).toBe('a.ts')
    expect(summarizeTool(tool({ toolName: 'edit', args })).object).toBe('a.ts')
    expect(summarizeTool(tool({ toolName: 'write', args })).object).toBe('a.ts')
  })

  it('parses args from argsText when args is absent', () => {
    const t = tool({ toolName: 'read', argsText: '{"path":"src/from-text.ts"}' })
    expect(summarizeTool(t).object).toBe('from-text.ts')
  })

  it('prefers validated args over streamed argsText', () => {
    const t = tool({
      toolName: 'read',
      args: { path: 'validated.ts' },
      argsText: '{"path":"streamed.ts"}',
    })
    expect(summarizeTool(t).object).toBe('validated.ts')
  })

  describe('bash', () => {
    it('marks the command as monospace and truncates at 64 chars', () => {
      const command = 'echo ' + 'x'.repeat(100)
      const summary = summarizeTool(tool({ toolName: 'bash', args: { command } }))
      expect(summary.mono).toBe(true)
      expect(summary.object).toHaveLength(64)
    })

    it('falls back to "a command" without monospace when the command is missing', () => {
      const summary = summarizeTool(tool({ toolName: 'bash' }))
      expect(summary.object).toBe('a command')
      expect(summary.mono).toBe(false)
    })

    it('drops a leading cd into the workspace, keeping the real command', () => {
      const ws = '/home/u/src/phosphor/.phosphor/worktrees/fix-sidebar'
      const t = tool({ toolName: 'bash', args: { command: `cd ${ws} && git status` } })
      expect(summarizeTool(t, ws).object).toBe('git status')
    })

    it('handles quoted cd targets and trailing slashes in the workspace', () => {
      const ws = '/home/u/src/phosphor/.phosphor/worktrees/fix-sidebar/'
      const trimmed = ws.replace(/\/+$/, '')
      const t = tool({ toolName: 'bash', args: { command: `cd "${trimmed}" && npm test` } })
      expect(summarizeTool(t, ws).object).toBe('npm test')
    })

    it('collapses later workspace mentions to the folder basename', () => {
      const ws = '/home/u/src/phosphor/.phosphor/worktrees/fix-sidebar'
      const t = tool({ toolName: 'bash', args: { command: `git -C ${ws} diff` } })
      expect(summarizeTool(t, ws).object).toBe('git -C fix-sidebar diff')
    })

    it('keeps the full workspace path when no workspace is known', () => {
      const ws = '/home/u/src/phosphor/.phosphor/worktrees/fix-sidebar'
      const t = tool({ toolName: 'bash', args: { command: `cd ${ws} && git status` } })
      expect(summarizeTool(t).object).toBe('git status')
    })

    it('drops a cd into any directory, not only the workspace', () => {
      // cd is setup wherever it points; the expanded detail keeps the wd.
      const ws = '/home/u/src/phosphor/.phosphor/worktrees/fix-sidebar'
      const t = tool({ toolName: 'bash', args: { command: 'cd /tmp && ls' } })
      const summary = summarizeTool(t, ws)
      expect(summary.object).toBe('ls')
      expect(summary.hint).toBeUndefined()
    })

    it('labels a multi-line script by its operative line, not its setup', () => {
      // The measured shape: 96% of real bash calls are multi-line and 94%
      // open with cd/echo/VAR= — the old flatten+truncate showed only those.
      const ws = '/home/u/src/phosphor/.phosphor/worktrees/fix-sidebar'
      const command = `cd ${ws}\necho "=== scopes ==="\ngrep -n "mcp.json" electron/pi/mcp-config.ts`
      const summary = summarizeTool(tool({ toolName: 'bash', args: { command } }), ws)
      expect(summary.object).toBe('grep -n "mcp.json" electron/pi/mcp-config.ts')
      expect(summary.hint).toBeUndefined()
    })

    it('counts the other working commands as a +N hint', () => {
      const command = 'grep -n "a" f.ts\nsed -n 1,5p g.ts\nwc -l h.ts'
      const summary = summarizeTool(tool({ toolName: 'bash', args: { command } }))
      expect(summary.object).toBe('grep -n "a" f.ts')
      expect(summary.hint).toBe('+2 more')
    })

    it('does not count noise lines toward the +N hint', () => {
      const command = 'cd /x\nexport A=1\nF=$(ls)\n# comment\ngrep -n "a" f.ts'
      const summary = summarizeTool(tool({ toolName: 'bash', args: { command } }))
      expect(summary.object).toBe('grep -n "a" f.ts')
      expect(summary.hint).toBeUndefined()
    })

    it('splits on ; and && within one line', () => {
      const command = 'echo "=== a ==="; cat ~/.claude/.mcp.json && jq -r keys ~/.claude.json'
      const summary = summarizeTool(tool({ toolName: 'bash', args: { command } }))
      expect(summary.object).toBe('cat ~/.claude/.mcp.json')
      expect(summary.hint).toBe('+1 more')
    })

    it('falls back to the first line when every part is noise', () => {
      const command = 'echo "just a banner"'
      const summary = summarizeTool(tool({ toolName: 'bash', args: { command } }))
      expect(summary.object).toBe('echo "just a banner"')
    })

    it('shortens workspace mentions inside the picked line', () => {
      const ws = '/home/u/src/phosphor/.phosphor/worktrees/fix-sidebar'
      const command = `echo hi\ngrep -rn "x" ${ws}/src`
      expect(summarizeTool(tool({ toolName: 'bash', args: { command } }), ws).object).toBe(
        'grep -rn "x" fix-sidebar/src',
      )
    })
  })

  describe('write', () => {
    it('counts content lines as additions', () => {
      const t = tool({ toolName: 'write', args: { path: 'a.ts', content: 'a\nb\nc' } })
      expect(summarizeTool(t).stats).toEqual({ additions: 3, deletions: 0 })
    })

    it('reports null stats when content is absent', () => {
      expect(summarizeTool(tool({ toolName: 'write', args: { path: 'a.ts' } })).stats).toBeNull()
    })

    it('counts empty-string content as one line', () => {
      const t = tool({ toolName: 'write', args: { path: 'a.ts', content: '' } })
      expect(summarizeTool(t).stats).toEqual({ additions: 1, deletions: 0 })
    })
  })

  it('truncates grep and find patterns at 48 chars and marks them monospace', () => {
    const pattern = 'y'.repeat(100)
    for (const toolName of ['grep', 'find']) {
      const summary = summarizeTool(tool({ toolName, args: { pattern } }))
      expect(summary.object).toHaveLength(48)
      expect(summary.mono).toBe(true)
    }
  })

  it('defaults ls to "directory" when no path is given', () => {
    expect(summarizeTool(tool({ toolName: 'ls' })).object).toBe('directory')
  })

  it('falls back to the tool name for unknown tools', () => {
    const summary = summarizeTool(tool({ toolName: 'custom_thing' }))
    expect(summary).toMatchObject({ label: 'Used', object: 'custom_thing', mono: true })
  })

  describe('unidentified streaming tools', () => {
    it('reads as "Preparing tool", never as a literal name', () => {
      const summary = summarizeTool(tool({ toolName: null, status: 'starting' }))
      expect(summary.label).toBe('Preparing tool')
      expect(summary.object).toBeUndefined()
      // The whole point: nothing in the UI may say "unknown".
      expect(JSON.stringify(summary)).not.toContain('unknown')
    })

    it('reports streamed payload size as the only honest progress signal', () => {
      const summary = summarizeTool(
        tool({ toolName: null, status: 'running', argsText: 'x'.repeat(2048) }),
      )
      expect(summary.hint).toBe('2.0 KB')
    })

    it('omits the size hint before any args arrive', () => {
      expect(summarizeTool(tool({ toolName: null, status: 'starting' })).hint).toBeUndefined()
    })
  })

  describe('artifact tools', () => {
    it('labels creation and updates distinctly, in both tenses', () => {
      expect(summarizeTool(tool({ toolName: 'artifact_create', status: 'running' })).label).toBe(
        'Writing artifact',
      )
      expect(summarizeTool(tool({ toolName: 'artifact_create', status: 'done' })).label).toBe(
        'Created artifact',
      )
      expect(summarizeTool(tool({ toolName: 'artifact_update', status: 'running' })).label).toBe(
        'Updating artifact',
      )
      expect(summarizeTool(tool({ toolName: 'artifact_update', status: 'done' })).label).toBe(
        'Updated artifact',
      )
    })

    it('shows the title from the result details and the version as the hint', () => {
      const summary = summarizeTool(
        tool({
          toolName: 'artifact_create',
          status: 'done',
          result: res({ id: 'a', title: 'Spacing plan', version: 3 }),
        }),
      )
      expect(summary).toMatchObject({ object: 'Spacing plan', hint: 'v3' })
    })

    it('recovers the title mid-stream from unparseable args', () => {
      // Artifact payloads are one huge `content` field, so JSON.parse fails for
      // most of the call's lifetime; the title still streams first.
      const argsText = '{"title": "Chat spacing audit", "type": "markdown", "content": "# Cha'
      const summary = summarizeTool(
        tool({ toolName: 'artifact_create', status: 'running', argsText }),
      )
      expect(summary.object).toBe('Chat spacing audit')
      expect(summary.hint).toBe('69 B')
    })
  })
})

describe('partialStringArg', () => {
  it('reads a completed string value out of a truncated payload', () => {
    expect(partialStringArg('{"title": "Done", "content": "unfinis', 'title')).toBe('Done')
  })

  it('tolerates no whitespace and other keys first', () => {
    expect(partialStringArg('{"type":"markdown","title":"T"}', 'title')).toBe('T')
  })

  it('returns undefined until the closing quote arrives', () => {
    expect(partialStringArg('{"title": "Half arri', 'title')).toBeUndefined()
  })

  it('returns undefined for a missing key or a non-string value', () => {
    expect(partialStringArg('{"other": "x"}', 'title')).toBeUndefined()
    expect(partialStringArg('{"title": 42}', 'title')).toBeUndefined()
    expect(partialStringArg('', 'title')).toBeUndefined()
  })

  it('unescapes quotes, newlines and tabs inside the value', () => {
    expect(partialStringArg('{"title": "a\\"b"}', 'title')).toBe('a"b')
    expect(partialStringArg('{"title": "a\\nb\\tc"}', 'title')).toBe('a\nb\tc')
  })

  it('does not read past an escaped closing quote', () => {
    expect(partialStringArg('{"title": "end\\\\"}', 'title')).toBe('end\\')
  })

  it('decodes \\uXXXX escapes instead of pasting the escape body through', () => {
    // A serializer that escapes non-ASCII rendered "Café" as "Cafu00e9" on
    // the streaming card for the whole (minutes-long) content stream.
    expect(partialStringArg('{"title": "Caf\\u00e9 menu"}', 'title')).toBe('Café menu')
  })

  it('decodes the remaining JSON escapes (\\r, \\b, \\f, \\/)', () => {
    expect(partialStringArg('{"title": "a\\rb"}', 'title')).toBe('a\rb')
    expect(partialStringArg('{"title": "a\\bb\\fc"}', 'title')).toBe('a\bb\fc')
    expect(partialStringArg('{"title": "a\\/b"}', 'title')).toBe('a/b')
  })

  it('under-labels rather than mangling an unknown or half-arrived escape', () => {
    // Contract: never render truncated-but-confident.
    expect(partialStringArg('{"title": "a\\qb"}', 'title')).toBeUndefined()
    expect(partialStringArg('{"title": "Caf\\u00', 'title')).toBeUndefined()
    expect(partialStringArg('{"title": "Caf\\uZZZZ"}', 'title')).toBeUndefined()
  })
})

describe('artifact tool labels', () => {
  it('distinguishes the cheap edit from the whole-document update', () => {
    expect(summarizeTool(tool({ toolName: 'artifact_edit', status: 'running' })).label).toBe(
      'Editing artifact',
    )
    expect(summarizeTool(tool({ toolName: 'artifact_edit', status: 'done' })).label).toBe(
      'Edited artifact',
    )
    expect(summarizeTool(tool({ toolName: 'artifact_update', status: 'done' })).label).toBe(
      'Updated artifact',
    )
  })
})
