import { describe, it, expect } from 'vitest'
import artifactsExtension, { applyArtifactEdit, editExcerpt, slugifyArtifactId } from './artifacts'

describe('applyArtifactEdit', () => {
  it('replaces a unique match', () => {
    expect(applyArtifactEdit('a b c', 'b', 'B')).toEqual({ content: 'a B c', replacements: 1 })
  })

  it('refuses a missing match, and says why it might not match', () => {
    expect(() => applyArtifactEdit('a b c', 'z', 'Z')).toThrow(/not found/)
    expect(() => applyArtifactEdit('a b c', 'z', 'Z')).toThrow(/artifact_read/)
  })

  it('refuses an ambiguous match unless replace_all is set', () => {
    expect(() => applyArtifactEdit('x x', 'x', 'y')).toThrow(/Found 2 matches/)
    expect(applyArtifactEdit('x x', 'x', 'y', true)).toEqual({ content: 'y y', replacements: 2 })
  })

  it('refuses a no-op rather than minting an identical version', () => {
    expect(() => applyArtifactEdit('a', 'a', 'a')).toThrow(/exactly the same/)
  })

  it('refuses an empty old_string instead of prepending', () => {
    expect(() => applyArtifactEdit('a', '', 'b')).toThrow(/artifact_update/)
  })

  it('treats old_string literally, not as a regex', () => {
    // `$&` in a replacement and `.` in a pattern are the classic String.replace traps.
    expect(applyArtifactEdit('a.c', '.', '-')).toEqual({ content: 'a-c', replacements: 1 })
    expect(applyArtifactEdit('price', 'price', '$&x').content).toBe('$&x')
  })

  it('handles multi-line CSS edits, the real use case', () => {
    const css = '.dl{display:none}\n.emptysel{padding:14px}\n'
    const { content } = applyArtifactEdit(
      css,
      '.emptysel{padding:14px}',
      'body:has(#l1:checked) .dl-1{display:flex}\n.emptysel{padding:14px}',
    )
    expect(content).toContain('.dl-1{display:flex}')
    expect(content).toContain('.dl{display:none}')
  })
})

describe('editExcerpt', () => {
  it('flattens whitespace and caps length', () => {
    expect(editExcerpt('  a\n\n  b  ')).toBe('a b')
    expect(editExcerpt('x'.repeat(200))).toHaveLength(81) // 80 + ellipsis
  })
})

describe('slugifyArtifactId', () => {
  it('slugifies and falls back', () => {
    expect(slugifyArtifactId('Lane Management: PR status!')).toBe('lane-management-pr-status')
    expect(slugifyArtifactId('!!!')).toBe('artifact')
  })
})

/** Minimal fake pi that captures registered tools and hooks. */
function harness(): {
  tools: Map<string, { execute: (id: string, params: unknown) => Promise<ToolResult> }>
  start: (entries: unknown[]) => void
} {
  const tools = new Map()
  let sessionStart: ((event: unknown, ctx: unknown) => unknown) | undefined
  artifactsExtension({
    registerTool: (definition: Record<string, unknown>) =>
      tools.set(definition.name as string, definition as never),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event === 'session_start') sessionStart = handler
    },
  })
  return {
    tools,
    start: (entries) => sessionStart?.({}, { sessionManager: { getBranch: () => entries } }),
  }
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  details?: { id: string; version: number; type: string; title: string; content: string }
}

const call = async (
  h: ReturnType<typeof harness>,
  name: string,
  params: unknown,
): Promise<ToolResult> => h.tools.get(name)!.execute('call-1', params)

describe('artifact tools', () => {
  it('loads the style guide on demand rather than in every prompt', async () => {
    const definitions: Record<string, unknown>[] = []
    artifactsExtension({ registerTool: (tool) => definitions.push(tool), on: () => {} })
    const create = definitions.find((tool) => tool.name === 'artifact_create')!
    expect(String(create.description).length).toBeLessThan(400)
    expect(JSON.stringify(create.promptGuidelines).length).toBeLessThan(250)
    expect(create.description).toContain('artifact_help')
    expect(create.description).not.toContain('--art-bg')
    const guide = await call(harness(), 'artifact_help', {})
    expect(guide.content[0]?.text).toContain('--art-bg')
    expect(guide.content[0]?.text).toContain('.ledger>.row')
    expect(guide.content[0]?.text).toContain('no network')
    expect(guide.details).toBeUndefined()
  })

  it('creates, edits and versions without resending content', async () => {
    const h = harness()
    const created = await call(h, 'artifact_create', {
      title: 'Demo',
      type: 'html',
      content: '<p>one</p>',
    })
    expect(created.details!.id).toBe('demo')
    expect(created.details!.version).toBe(1)

    const edited = await call(h, 'artifact_edit', {
      id: 'demo',
      old_string: 'one',
      new_string: 'two',
    })
    expect(edited.details!.content).toBe('<p>two</p>')
    expect(edited.details!.version).toBe(2)
    expect(edited.content[0]!.text).toMatch(/1 replacement/)
  })

  it('keeps the real type and title through an update — no "update" sentinel', async () => {
    const h = harness()
    await call(h, 'artifact_create', { title: 'Demo', type: 'html', content: 'a' })
    const updated = await call(h, 'artifact_update', { id: 'demo', content: 'b' })
    expect(updated.details!.type).toBe('html')
    expect(updated.details!.title).toBe('Demo')
  })

  it('errors on an unknown id and names the ids it does know', async () => {
    const h = harness()
    await call(h, 'artifact_create', { title: 'Demo', type: 'html', content: 'a' })
    await expect(
      call(h, 'artifact_edit', { id: 'nope', old_string: 'a', new_string: 'b' }),
    ).rejects.toThrow(/Known ids: demo/)
  })

  it('rejects an unknown artifact type', async () => {
    const h = harness()
    await expect(
      call(h, 'artifact_create', { title: 'D', type: 'pdf', content: 'a' }),
    ).rejects.toThrow(/Unknown artifact type/)
  })

  it('reads content back, and lists without content', async () => {
    const h = harness()
    await call(h, 'artifact_create', { title: 'Demo', type: 'html', content: '<p>hi</p>' })
    const read = await call(h, 'artifact_read', { id: 'demo' })
    expect(read.content[0]!.text).toContain('<p>hi</p>')

    const list = await call(h, 'artifact_list', {})
    expect(list.content[0]!.text).toContain('demo  v1  html')
    expect(list.content[0]!.text).not.toContain('<p>hi</p>')
  })

  it('rebuilds editable content from history on resume', async () => {
    const h = harness()
    h.start([
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'artifact_create',
          details: { id: 'demo', title: 'Demo', type: 'html', content: 'v1 body', version: 1 },
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'artifact_edit',
          details: { id: 'demo', title: 'Demo', type: 'html', content: 'v2 body', version: 2 },
        },
      },
    ])
    // The edit must apply to the LATEST version recovered from history.
    const edited = await call(h, 'artifact_edit', {
      id: 'demo',
      old_string: 'v2 body',
      new_string: 'v3 body',
    })
    expect(edited.details!.version).toBe(3)
    expect(edited.details!.content).toBe('v3 body')
  })

  it('never resurrects the legacy "update" sentinel as a type', async () => {
    const h = harness()
    h.start([
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'artifact_create',
          details: { id: 'demo', title: 'Demo', type: 'html', content: 'a', version: 1 },
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'artifact_update',
          details: { id: 'demo', title: 'demo', type: 'update', content: 'b', version: 2 },
        },
      },
    ])
    const read = await call(h, 'artifact_read', { id: 'demo' })
    expect(read.details!.type).toBe('html')
  })
})
