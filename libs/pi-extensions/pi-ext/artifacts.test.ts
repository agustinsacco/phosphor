import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import artifactsExtension, {
  applyArtifactEdit,
  artifactGuide,
  artifactsBeforeCompaction,
  compactionNoteText,
  editExcerpt,
  sliceLines,
  slugifyArtifactId,
  withCompactionNote,
} from './artifacts'
import {
  ARTIFACT_INDEX_FORMAT,
  ARTIFACT_STORE_ENV,
  contentHash,
  indexFile,
  readIndex,
  type SessionArtifactIndex,
} from './artifact-store'

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

describe('artifactGuide', () => {
  it('uses pi resolution and saved edits, respecting hidden or removed guidance without a fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-guide-'))
    const filePath = join(dir, 'SKILL.md')
    const skill = { name: 'visual-artifacts', filePath, disableModelInvocation: false }
    const ctx = { getSystemPromptOptions: () => ({ skills: [skill] }) }
    try {
      writeFileSync(filePath, 'My project-selected guidance')
      expect(await artifactGuide(ctx)).toContain('My project-selected guidance')
      writeFileSync(filePath, 'Saved edits')
      expect(await artifactGuide(ctx)).toContain('Saved edits')
      skill.disableModelInvocation = true
      expect(await artifactGuide(ctx)).toContain('unavailable or hidden')
      skill.disableModelInvocation = false
      writeFileSync(
        filePath,
        '---\nname: visual-artifacts\ndisable-model-invocation: true\n---\nHidden now',
      )
      expect(await artifactGuide(ctx)).not.toContain('Hidden now')
      rmSync(filePath)
      expect(await artifactGuide(ctx)).toContain('unavailable or hidden')
      expect(await artifactGuide()).toContain('do not reinstall it automatically')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('artifact tools', () => {
  it('loads the style guide on demand rather than in every prompt', async () => {
    const definitions: Record<string, unknown>[] = []
    artifactsExtension({ registerTool: (tool) => definitions.push(tool), on: () => {} })
    const create = definitions.find((tool) => tool.name === 'artifact_create')!
    expect(String(create.description).length).toBeLessThan(400)
    expect(JSON.stringify(create.promptGuidelines).length).toBeLessThan(250)
    expect(create.description).toContain('artifact_help')
    expect(create.description).not.toContain('--art-bg')
    expect(create.description).toContain('visual-artifacts')
    expect(create.description).toContain('sandboxed fragment with no network')
    const filePath = resolve(import.meta.dirname, '../skills/visual-artifacts/SKILL.md')
    const ctx = {
      getSystemPromptOptions: () => ({
        skills: [{ name: 'visual-artifacts', filePath, disableModelInvocation: false }],
      }),
    }
    const guide = await (
      definitions.find((tool) => tool.name === 'artifact_help')!.execute as (
        ...args: unknown[]
      ) => Promise<ToolResult>
    )('id', {}, undefined, undefined, ctx)
    expect(guide.content[0]!.text).toContain('Choose the medium for the reader')
    expect(guide.content[0]!.text).toContain('references/mermaid.md')
    expect(guide.content[0]!.text).toContain(filePath)
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

const OWN_SESSION = '01a10e05-0000-7000-8000-00000000000a'
const OTHER_SESSION = '01a10e05-0000-7000-8000-00000000000b'

/** A fake pi with every hook, a session manager, and an optional store. */
function sessionHarness(entries: unknown[] = []): {
  tools: Map<string, { execute: (...args: unknown[]) => Promise<ToolResult> }>
  hooks: Map<string, (event: unknown, ctx: unknown) => unknown>
  ctx: { sessionManager: { getBranch: () => unknown[]; getSessionId: () => string } }
  branch: unknown[]
} {
  const tools = new Map()
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  artifactsExtension({
    registerTool: (definition: Record<string, unknown>) =>
      tools.set(definition.name as string, definition as never),
    on: (event, handler) => hooks.set(event, handler),
  })
  const branch = [...entries]
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => OWN_SESSION } }
  hooks.get('session_start')?.({}, ctx)
  return { tools, hooks, ctx, branch }
}

const run = (
  h: ReturnType<typeof sessionHarness>,
  name: string,
  params: unknown,
): Promise<ToolResult> => h.tools.get(name)!.execute('call-1', params, undefined, undefined, h.ctx)

function result(tool: string, details: Record<string, unknown>, id = `e-${Math.random()}`) {
  return { type: 'message', id, message: { role: 'toolResult', toolName: tool, details } }
}

/** A store holding one artifact of another session. */
function storeWithForeign(root: string): void {
  const content = '<h1>guide</h1>\nline two\nline three'
  const sha256 = contentHash(content)
  mkdirSync(join(root, 'blobs'), { recursive: true })
  writeFileSync(join(root, 'blobs', sha256), content)
  const index: SessionArtifactIndex = {
    format: ARTIFACT_INDEX_FORMAT,
    sessionId: OTHER_SESSION,
    sessionFile: '/sessions/other.jsonl',
    cwd: '/work',
    name: 'Remote access',
    deleted: false,
    scan: { offset: 0, size: 0, mtimeMs: 0, signature: '', leafId: null },
    artifacts: {
      guide: {
        slug: 'guide',
        title: 'Field Guide',
        type: 'html',
        versions: [
          {
            version: 7,
            toolCallId: 'c7',
            entryId: 'e7',
            sha256,
            bytes: content.length,
            createdAt: '2026-10-06T18:15:14.792Z',
            title: 'Field Guide',
            onBranch: true,
          },
        ],
      },
    },
  }
  mkdirSync(join(root, 'sessions'), { recursive: true })
  writeFileSync(join(root, 'sessions', `${OTHER_SESSION}.json`), JSON.stringify(index))
}

describe('artifacts of other sessions', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'artifact-ext-'))
    storeWithForeign(root)
    process.env[ARTIFACT_STORE_ENV] = root
  })
  afterEach(() => {
    delete process.env[ARTIFACT_STORE_ENV]
    rmSync(root, { recursive: true, force: true })
  })

  it('lists them as refs with scope all, and leaves the default list alone', async () => {
    const h = sessionHarness()
    await run(h, 'artifact_create', { title: 'Mine', type: 'html', content: 'x' })
    expect((await run(h, 'artifact_list', {})).content[0]!.text).toBe(
      'mine  v1  html  1 chars  "Mine"',
    )
    const all = (await run(h, 'artifact_list', { scope: 'all' })).content[0]!.text
    expect(all).toContain('This session:\nmine  v1')
    expect(all).toContain(`${OTHER_SESSION}/guide  v7  html`)
    expect(all).toContain('session: Remote access')
    expect(
      (await run(h, 'artifact_list', { scope: 'all', query: 'nothing' })).content[0]!.text,
    ).toContain('Other sessions, newest first:\n(none)')
  })

  it('reads one by ref without adopting it into this session', async () => {
    const h = sessionHarness()
    const read = await run(h, 'artifact_read', { id: `${OTHER_SESSION}/guide` })
    expect(read.content[0]!.text).toContain('<h1>guide</h1>')
    expect(read.content[0]!.text).toContain('Read-only here')
    // No id and no content: no session_start rebuild, old or new, can take it as ours.
    expect(read.details).toEqual({ ref: `${OTHER_SESSION}/guide`, foreign: true, version: 7 })
    h.branch.push(result('artifact_read', read.details as never))
    h.hooks.get('session_start')!({}, h.ctx)
    expect((await run(h, 'artifact_list', {})).content[0]!.text).toBe(
      'No artifacts in this session yet.',
    )
  })

  it('reports the ordinary missing error for an inherited constructor slug', async () => {
    const h = sessionHarness()
    await expect(run(h, 'artifact_read', { id: `${OTHER_SESSION}/constructor` })).rejects.toThrow(
      `No artifact "constructor" in session ${OTHER_SESSION}. Known ids there: guide.`,
    )
    await expect(
      run(h, 'artifact_read', { id: `${OTHER_SESSION}/constructor@v7` }),
    ).rejects.toThrow(/No artifact "constructor"/)
  })

  it('reads an own constructor slug from the persisted store without losing its sibling', async () => {
    const index = readIndex(root, OTHER_SESSION)!
    index.artifacts['constructor'] = { ...index.artifacts.guide!, slug: 'constructor' }
    writeFileSync(indexFile(root, OTHER_SESSION), JSON.stringify(index))
    const h = sessionHarness()
    const read = await run(h, 'artifact_read', { id: `${OTHER_SESSION}/constructor` })
    expect(read.content[0]!.text).toContain('<h1>guide</h1>')
    expect(read.details).toEqual({ ref: `${OTHER_SESSION}/constructor`, foreign: true, version: 7 })
    const versioned = await run(h, 'artifact_read', { id: `${OTHER_SESSION}/constructor@v7` })
    expect(versioned.content).toEqual(read.content)
    expect(
      (await run(h, 'artifact_read', { id: `${OTHER_SESSION}/guide` })).content[0]!.text,
    ).toContain('<h1>guide</h1>')
    expect((await run(h, 'artifact_list', {})).content[0]!.text).toBe(
      'No artifacts in this session yet.',
    )
  })

  it('reads a range of lines', async () => {
    const h = sessionHarness()
    const read = await run(h, 'artifact_read', {
      id: `${OTHER_SESSION}/guide`,
      offset: 2,
      limit: 1,
    })
    expect(read.content[0]!.text).toContain('lines 2-2 of 3')
    expect(read.content[0]!.text.endsWith('\n\nline two')).toBe(true)
  })

  it('copies one into this session with from, without resending the content', async () => {
    const h = sessionHarness()
    const created = await run(h, 'artifact_create', {
      title: 'My guide',
      from: `${OTHER_SESSION}/guide`,
    })
    expect(created.details).toMatchObject({
      id: 'my-guide',
      version: 1,
      type: 'html',
      content: '<h1>guide</h1>\nline two\nline three',
      derivedFrom: `${OTHER_SESSION}/guide@v7`,
    })
    // The copy is ours to edit.
    const edited = await run(h, 'artifact_edit', {
      id: 'my-guide',
      old_string: 'guide</h1>',
      new_string: 'mine</h1>',
    })
    expect(edited.details!.version).toBe(2)
  })

  it('refuses to edit another session’s artifact and says how to copy it', async () => {
    const h = sessionHarness()
    await expect(
      run(h, 'artifact_edit', { id: `${OTHER_SESSION}/guide`, old_string: 'a', new_string: 'b' }),
    ).rejects.toThrow(/artifact_create with from/)
    await expect(
      run(h, 'artifact_update', { id: `${OTHER_SESSION}/guide`, content: 'b' }),
    ).rejects.toThrow(/another session/)
  })

  it('treats a ref to this very session as a local id', async () => {
    const h = sessionHarness()
    await run(h, 'artifact_create', { title: 'Mine', type: 'html', content: 'x' })
    const edited = await run(h, 'artifact_edit', {
      id: `${OWN_SESSION}/mine`,
      old_string: 'x',
      new_string: 'y',
    })
    expect(edited.details!.content).toBe('y')
  })

  it('names what it does know when a ref misses', async () => {
    const h = sessionHarness()
    await expect(run(h, 'artifact_read', { id: `${OTHER_SESSION}/nope` })).rejects.toThrow(
      /Known ids there: guide/,
    )
    await expect(run(h, 'artifact_read', { id: `${OTHER_SESSION}/guide@v3` })).rejects.toThrow(
      /no v3/,
    )
  })
})

describe('without an artifact store (plain pi)', () => {
  it('keeps this session’s artifacts working and explains the rest', async () => {
    delete process.env[ARTIFACT_STORE_ENV]
    const h = sessionHarness()
    await run(h, 'artifact_create', { title: 'Mine', type: 'html', content: 'x' })
    expect((await run(h, 'artifact_read', { id: 'mine' })).content[0]!.text).toContain('x')
    await expect(run(h, 'artifact_list', { scope: 'all' })).rejects.toThrow(/only available/)
    await expect(run(h, 'artifact_read', { id: `${OTHER_SESSION}/guide` })).rejects.toThrow(
      /only available/,
    )
  })

  it('still requires type and content when there is nothing to copy', async () => {
    const h = sessionHarness()
    await expect(run(h, 'artifact_create', { title: 'T', content: 'x' })).rejects.toThrow(
      /type is required/,
    )
    await expect(run(h, 'artifact_create', { title: 'T', type: 'html' })).rejects.toThrow(
      /content is required/,
    )
  })
})

describe('older versions of this session’s artifacts', () => {
  it('reads one from the branch on request', async () => {
    const h = sessionHarness([
      result('artifact_create', {
        id: 'demo',
        title: 'Demo',
        type: 'html',
        content: 'one',
        version: 1,
      }),
      result('artifact_edit', {
        id: 'demo',
        title: 'Demo',
        type: 'html',
        content: 'two',
        version: 2,
      }),
    ])
    const read = await run(h, 'artifact_read', { id: 'demo', version: 1 })
    expect(read.content[0]!.text).toBe('demo v1 (html, 3 chars)\n\none')
    // details stay the current record, exactly as an unversioned read records it.
    expect(read.details!.version).toBe(2)
    await expect(run(h, 'artifact_read', { id: 'demo', version: 9 })).rejects.toThrow(/no v9/)
  })

  it('copies one into a new artifact from a ref to this session', async () => {
    const h = sessionHarness([
      result('artifact_create', {
        id: 'demo',
        title: 'Demo',
        type: 'html',
        content: 'one',
        version: 1,
      }),
      result('artifact_edit', {
        id: 'demo',
        title: 'Demo',
        type: 'html',
        content: 'two',
        version: 2,
      }),
    ])
    const copy = await run(h, 'artifact_create', { title: 'Old', from: `${OWN_SESSION}/demo@v1` })
    expect(copy.details).toMatchObject({ id: 'old', content: 'one', derivedFrom: 'demo@v1' })
  })
})

describe('after compaction', () => {
  const created = (id: string, entryId: string) =>
    result(
      'artifact_create',
      { id, title: id.toUpperCase(), type: 'html', content: 'c', version: 1 },
      entryId,
    )

  it('lists only what the compaction summarised away', () => {
    const entries = [
      created('old', 'e1'),
      { type: 'message', id: 'kept', message: { role: 'user' } },
      created('kept-tail', 'e3'),
      { type: 'compaction', id: 'c1', firstKeptEntryId: 'kept' },
      created('new', 'e5'),
    ]
    expect(artifactsBeforeCompaction(entries).map((a) => a.id)).toEqual(['old'])
    expect(artifactsBeforeCompaction([created('x', 'e1')])).toEqual([])
  })

  it('puts a stable note right after the summary, and nothing without a compaction', () => {
    const h = sessionHarness([
      created('old', 'e1'),
      { type: 'compaction', id: 'c1', firstKeptEntryId: 'c1' },
    ])
    const messages = [
      { role: 'compactionSummary', summary: 's', timestamp: 42 },
      { role: 'user', content: 'hi', timestamp: 50 },
    ]
    const first = h.hooks.get('context')!({ messages }, h.ctx) as { messages: unknown[] }
    const second = h.hooks.get('context')!({ messages }, h.ctx) as { messages: unknown[] }
    expect(first.messages[1]).toMatchObject({
      role: 'custom',
      customType: 'phosphor-artifact-index',
      display: false,
      timestamp: 42,
    })
    expect(String((first.messages[1] as { content: string }).content)).toContain(
      '- old v1 html "OLD"',
    )
    expect(first).toEqual(second)
    expect(messages).toHaveLength(2)

    const fresh = sessionHarness([created('old', 'e1')])
    expect(fresh.hooks.get('context')!({ messages }, fresh.ctx)).toBeUndefined()
  })

  it('caps the note and points at artifact_list for the rest', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({
      id: `a${i}`,
      title: 'A',
      type: 'html',
      content: '',
      version: 1,
    }))
    const note = compactionNoteText(many)!
    expect(note.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(41)
    expect(note).toContain('and 5 more')
    expect(withCompactionNote([{ role: 'user' }], note)).toBeUndefined()
  })
})

describe('tree navigation', () => {
  it('rebuilds from the new branch', async () => {
    const h = sessionHarness([
      result('artifact_create', {
        id: 'demo',
        title: 'Demo',
        type: 'html',
        content: 'one',
        version: 1,
      }),
      result('artifact_edit', {
        id: 'demo',
        title: 'Demo',
        type: 'html',
        content: 'two',
        version: 2,
      }),
    ])
    h.branch.splice(1)
    h.hooks.get('session_tree')!({}, h.ctx)
    expect((await run(h, 'artifact_read', { id: 'demo' })).content[0]!.text).toContain('v1')
  })
})

describe('sliceLines', () => {
  it('uses 1-based lines and refuses an offset past the end', () => {
    expect(sliceLines('a\nb\nc', 2)).toEqual({ text: 'b\nc', range: 'lines 2-3 of 3' })
    expect(sliceLines('a\nb\nc')).toEqual({ text: 'a\nb\nc' })
    expect(() => sliceLines('a', 5)).toThrow(/past the end/)
  })
})
