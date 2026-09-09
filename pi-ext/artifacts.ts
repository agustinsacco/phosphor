/**
 * Phosphor artifacts extension — loaded into every Phosphor session via
 * `pi --mode rpc -e <this file>`.
 *
 * Registers the artifact tool family. Tool results keep chat output short
 * (confirmation text) while the full payload rides in `details`, which Phosphor
 * consumes from tool_execution_end events and from session history on resume
 * (toolResult messages persist in the JSONL).
 *
 * `details` is NEVER sent to the model — pi-ai's `convertToolResult` reads
 * only `content`, `toolCallId` and `isError`. So the token cost of an
 * artifact is entirely the ARGUMENTS the model writes, which is why
 * `artifact_edit` exists: re-sending a 75k-char document to change nine lines
 * cost ~20k output tokens, and the same edit costs ~120.
 *
 * The mirror of `ArtifactDetails` lives in `src/stores/artifacts.ts`
 * (`ArtifactToolDetails`) — change both together.
 *
 * Imports resolve against pi's own runtime when it loads the extension.
 */
import { Type } from 'typebox'

interface ArtifactDetails {
  id: string
  title: string
  type: string
  language?: string
  content: string
  version: number
}

interface ToolResultLike {
  content: Array<{ type: 'text'; text: string }>
  details: ArtifactDetails
}

// Loose structural types: the real ones live in @earendil-works/pi-coding-agent,
// which is provided by pi at load time (not a Phosphor dependency).
interface PiExtensionApi {
  registerTool(definition: Record<string, unknown>): void
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
}

const ARTIFACT_TYPES = ['html', 'markdown', 'svg', 'mermaid', 'code', 'chart'] as const

/** Longest single-line excerpt echoed back in an edit confirmation. */
const EXCERPT_LIMIT = 80

export function slugifyArtifactId(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'artifact'
  )
}

/**
 * Exact-string replacement with Claude Code's `Edit` semantics: the match must
 * be unique unless `replaceAll` is set, and a no-op is an error rather than a
 * silent new version.
 *
 * Pure and exported so the failure modes are unit-testable without a fake pi.
 */
export function applyArtifactEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): { content: string; replacements: number } {
  if (oldString === '') {
    throw new Error('old_string is empty — use artifact_update to replace the whole document.')
  }
  if (oldString === newString) {
    throw new Error('No changes to make: old_string and new_string are exactly the same.')
  }

  const occurrences = content.split(oldString).length - 1
  if (occurrences === 0) {
    throw new Error(
      'String to replace not found in the artifact. Whitespace and indentation must match ' +
        'exactly — call artifact_read to see the current content.',
    )
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `Found ${occurrences} matches of old_string, but replace_all is false. Add surrounding ` +
        'context to identify one instance, or set replace_all to true.',
    )
  }

  // NB: never String.replace here. Even with a string pattern it expands `$&`,
  // `$\'`, "$`" and `$1` in the REPLACEMENT, so a new_string containing `$&`
  // (CSS, shell, regex source) would be silently corrupted. split/join and
  // slice are both literal.
  if (replaceAll) {
    return { content: content.split(oldString).join(newString), replacements: occurrences }
  }
  const at = content.indexOf(oldString)
  return {
    content: content.slice(0, at) + newString + content.slice(at + oldString.length),
    replacements: 1,
  }
}

/** One-line, length-capped preview of an edit, for the confirmation text. */
export function editExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_LIMIT ? `${flat.slice(0, EXCERPT_LIMIT)}…` : flat
}

export default function artifactsExtension(pi: PiExtensionApi): void {
  /**
   * Full current state per artifact, not just a version counter: `artifact_edit`
   * has to apply a patch to the live content, and after a resume that content
   * only exists in session history. Rebuilt in `session_start`.
   */
  const artifacts = new Map<string, ArtifactDetails>()

  const uniqueId = (base: string): string => {
    if (!artifacts.has(base)) return base
    let i = 2
    while (artifacts.has(`${base}-${i}`)) i++
    return `${base}-${i}`
  }

  const mustGet = (id: string): ArtifactDetails => {
    const record = artifacts.get(id)
    if (!record) {
      const known = [...artifacts.keys()]
      throw new Error(
        `No artifact with id "${id}" in this session.` +
          (known.length ? ` Known ids: ${known.join(', ')}.` : ' Use artifact_create first.'),
      )
    }
    return record
  }

  /** Store the next version of a record and return the tool result for it. */
  const commit = (record: ArtifactDetails, text: string): ToolResultLike => {
    artifacts.set(record.id, record)
    return { content: [{ type: 'text', text }], details: record }
  }

  pi.registerTool({
    name: 'artifact_create',
    label: 'Create artifact',
    description:
      'Render a self-contained page as an artifact — a private web page shown ' +
      'beside the chat. Use this when a visual or interactive deliverable is ' +
      'clearer than terminal text: a report the team will read, a plan others ' +
      'will follow, a reference document, a dashboard mockup, an interactive ' +
      'prototype, or a decision case the team has not made yet. A finished ' +
      'deliverable with an audience is not fully delivered while it lives only ' +
      'in scrollback — finish it as an artifact, then link it in your reply as ' +
      '[Title](artifact://<id>), which opens the panel on that artifact ' +
      '(add #v2 to open one version). ' +
      'When the user asks for such a page, offer it; when they ask only for ' +
      'advice they will act on alone now, in the code at hand, no audience ' +
      'exists — keep it as text. ' +
      'Type is one of: ' +
      ARTIFACT_TYPES.join(', ') +
      '. ' +
      'Author HTML as a FRAGMENT — no <!DOCTYPE>, <html>, <head>, or <body> ' +
      'tags; the viewer wraps it and injects the house stylesheet at publish ' +
      'time. Never write a palette: the sheet already defines dark-first ' +
      'tokens, typography and layout primitives, and it follows the app theme. ' +
      'Use its classes and tokens, add CSS only for what it lacks. ' +
      'Tokens: --art-bg / --art-panel / --art-panel-2 (surfaces), --art-ink / ' +
      '--art-ink-2 / --art-ink-3 (text), --art-line / --art-line-soft (rules), ' +
      '--art-accent, --art-s1..--art-s5 (series, fixed order, never cycled), ' +
      '--art-r1..--art-r5 (sequential ramp), --art-good / --art-warn / ' +
      '--art-crit, --art-mono / --art-sans. ' +
      'Classes: .wrap .eyebrow .kicker .deck .lede .chips>.chip · ' +
      '.kpis>.kpi>(.k-label .k-val .k-sub) · .panelbox .grid .scroll · ' +
      '.chart-title .chart-note .legend>span>i.swatch .grid-line .mark · ' +
      'table.data (td.num) · .callout .pill.ok|.no · .rail>.node>(.gut>.dot, ' +
      '.body) · .ledger>.row · .steps>.s · .blueprint .verdict · pre.code. ' +
      'House style — dense, dark, chart-first, for readers who read diffs: ' +
      'lead with the finding in one sentence, then the numbers; no abstract, ' +
      'no closing summary. Charts are HAND-AUTHORED INLINE SVG — the artifact ' +
      'CSP has no network at all, so a chart library, a CDN script or a ' +
      'webfont renders nothing. Hairline solid gridlines, 2px lines, bars ' +
      'under 24px with a 4px rounded data-end, markers at least 8px with a 2px ' +
      'surface ring, area fills near 10% opacity. A legend for two or more ' +
      'series; direct labels only at endpoints or extremes, never on every ' +
      'point; text wears ink tokens, never a series colour. Cap scatter and ' +
      'small multiples at three series (--art-s1..s3). Any chart carrying a ' +
      'claim gets a table.data under it — that is the evidence and the ' +
      'accessible fallback. Set a short noun-phrase title (2–4 words, ' +
      'distinctive to the page); the explanation belongs in the title ' +
      'parameter, not appended to the name. ' +
      'TABLES — the reading panel is often only ~380px wide, so a table has to ' +
      'earn every column: five columns at most, the first the label, numbers ' +
      'right in td.num, and each cell a value or a short phrase. A sentence in ' +
      'a cell belongs in the paragraph above the table instead; a wide matrix ' +
      'of yes/no marks is a chart, a .kpis strip or a short list, not a table. ' +
      'When a table genuinely needs more width, put it in ' +
      '<div class="scroll"> so it scrolls on its own — the body must never ' +
      'scroll horizontally. ' +
      'THE ROW PRIMITIVES ARE COLUMN GRIDS, NOT PARAGRAPH STYLES: a ' +
      '.ledger>.row is exactly .idx/.lab/.bar/.val, a .steps>.s is .n plus its ' +
      'body, a .rail>.node is .gut plus .body. Free prose in one of those rows ' +
      'is laid out as columns, one word wide. Prose goes in <p>, a <ul>, or a ' +
      '.callout. Otherwise stay responsive: relative units, flex or grid, wide ' +
      'content (code, diagrams, SVG) in its own overflow-x: auto container. ' +
      'Small snippets and inline code stay in chat, not artifacts.',
    promptSnippet:
      'Create a rich artifact (html / svg / markdown / mermaid / chart / code) in the side panel — dense, dark, chart-first house style',
    promptGuidelines: [
      'Use artifact_create for substantial, self-contained deliverables — reports, walkthroughs, plans, mockups, diagrams, or complete code files meant for review. Small snippets stay inline in chat.',
      'Never write a palette or a type scale: the viewer injects the house stylesheet at publish time (dark-first --art-* tokens plus .kpis / .panelbox / table.data / .rail / .ledger primitives). Write against those, and add CSS only for what they lack.',
      'House style is dense, dark and chart-first: verdict in the first sentence, numbers next, a chart wherever a shape beats a paragraph, and a table.data under any chart that carries a claim.',
      'Charts are hand-authored inline SVG. The artifact CSP grants no network, so Chart.js, a CDN script or a webfont renders nothing at all.',
      'Tables hold values, not prose: five columns max (the panel is often ~380px wide), label first, numbers right in td.num, a wide one wrapped in <div class="scroll">. A broad matrix of yes/no marks is a chart or a list instead. And .ledger/.steps/.rail rows are fixed column grids — a row of free prose gets laid out as columns, one word wide, so prose goes in <p>, a list, or a .callout.',
      'To revise: prefer artifact_edit (exact-string replacement, lowest token cost) over artifact_update (full rewrite). If you no longer have the current content (after compaction or a resumed session), call artifact_list then artifact_read first. Never guess old_string — whitespace and indentation must match exactly.',
      'Hand over the finished artifact with a link: write [Title](artifact://<id>) in your reply (append #v2 for a specific version). The link opens the Artifacts pane on that artifact, so the reader does not have to go find it.',
      'Format: HTML artifacts are fragments — no <!DOCTYPE>, <html>, <head> or <body> tags. Markdown is only for documents; when a user shares markdown content meant as an artifact, author an HTML page based on its substance rather than transcribing it one-to-one.',
    ],
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({ description: 'Stable slug id; generated from the title if omitted' }),
      ),
      title: Type.String({ description: 'Human-readable title shown in the panel' }),
      type: Type.String({
        description: `Artifact type: ${ARTIFACT_TYPES.join(' | ')}`,
      }),
      content: Type.String({ description: 'Full artifact content' }),
      language: Type.Optional(
        Type.String({ description: 'Language for type=code (e.g. typescript, python)' }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { id?: string; title: string; type: string; content: string; language?: string },
    ): Promise<ToolResultLike> {
      const type = params.type.toLowerCase()
      if (!(ARTIFACT_TYPES as readonly string[]).includes(type)) {
        throw new Error(
          `Unknown artifact type "${params.type}" — use one of: ${ARTIFACT_TYPES.join(', ')}`,
        )
      }
      const id = params.id
        ? slugifyArtifactId(params.id)
        : uniqueId(slugifyArtifactId(params.title))
      const version = (artifacts.get(id)?.version ?? 0) + 1
      return commit(
        {
          id,
          title: params.title,
          type,
          language: params.language,
          content: params.content,
          version,
        },
        `Created artifact "${params.title}" (id: ${id}, v${version}, ${type}, ` +
          `${params.content.length} chars). It is now visible in the artifact panel. ` +
          `Link to it in your reply as [${params.title}](artifact://${id}). ` +
          'Use artifact_edit to revise it.',
      )
    },
  })

  pi.registerTool({
    name: 'artifact_edit',
    label: 'Edit artifact',
    description:
      'Replace an exact string inside an existing artifact, creating the next version. ' +
      'This is the cheap way to revise an artifact: prefer it over artifact_update, which ' +
      're-sends the whole document. old_string must match the current content EXACTLY, ' +
      'including whitespace and indentation, and must be unique unless replace_all is true. ' +
      'Call artifact_read first if you are not certain of the current text.',
    promptSnippet: 'Edit part of an existing artifact by exact string replacement',
    parameters: Type.Object({
      id: Type.String({ description: 'Id of the artifact to edit' }),
      old_string: Type.String({ description: 'Exact text to replace (must be unique)' }),
      new_string: Type.String({ description: 'Replacement text' }),
      replace_all: Type.Optional(
        Type.Boolean({ description: 'Replace every occurrence instead of requiring uniqueness' }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { id: string; old_string: string; new_string: string; replace_all?: boolean },
    ): Promise<ToolResultLike> {
      const previous = mustGet(slugifyArtifactId(params.id))
      const { content, replacements } = applyArtifactEdit(
        previous.content,
        params.old_string,
        params.new_string,
        params.replace_all ?? false,
      )
      const version = previous.version + 1
      const delta = content.length - previous.content.length
      return commit(
        { ...previous, content, version },
        `Edited ${previous.id} → v${version}: ${replacements} replacement` +
          `${replacements === 1 ? '' : 's'}, ${previous.content.length} → ${content.length} chars ` +
          `(${delta >= 0 ? '+' : ''}${delta}). Replaced "${editExcerpt(params.old_string)}".`,
      )
    },
  })

  pi.registerTool({
    name: 'artifact_update',
    label: 'Update artifact',
    description:
      'Replace an existing artifact’s ENTIRE content, creating the next version. ' +
      'Costs tokens proportional to the whole document, so use artifact_edit for targeted ' +
      'changes and reserve this for rewrites that touch most of the content.',
    promptSnippet: 'Rewrite an existing artifact in full (new version)',
    parameters: Type.Object({
      id: Type.String({ description: 'Id of the artifact to update' }),
      content: Type.String({ description: 'Full replacement content' }),
      title: Type.Optional(Type.String({ description: 'New title (optional)' })),
    }),
    async execute(
      _toolCallId: string,
      params: { id: string; content: string; title?: string },
    ): Promise<ToolResultLike> {
      const previous = mustGet(slugifyArtifactId(params.id))
      const version = previous.version + 1
      return commit(
        {
          ...previous,
          // Carry the real type and previous title forward. This used to emit
          // `type: 'update'` and fall back to the slug id, which the renderer
          // store had to defend against — see ArtifactToolDetails.
          title: params.title ?? previous.title,
          content: params.content,
          version,
        },
        `Updated ${previous.id} to v${version} (${params.content.length} chars).`,
      )
    },
  })

  pi.registerTool({
    name: 'artifact_read',
    label: 'Read artifact',
    description:
      'Return the current content of an artifact. Use before artifact_edit when the text is ' +
      'not already in context (after compaction, or in a resumed session) so old_string can ' +
      'be matched exactly. This is the one artifact tool whose output enters the context ' +
      'window, so read only what you need to edit.',
    promptSnippet: 'Read an artifact’s current content back into context',
    parameters: Type.Object({
      id: Type.String({ description: 'Id of the artifact to read' }),
    }),
    async execute(_toolCallId: string, params: { id: string }): Promise<ToolResultLike> {
      const record = mustGet(slugifyArtifactId(params.id))
      return {
        content: [
          {
            type: 'text',
            text:
              `${record.id} v${record.version} (${record.type}, ${record.content.length} chars)\n\n` +
              record.content,
          },
        ],
        details: record,
      }
    },
  })

  pi.registerTool({
    name: 'artifact_list',
    label: 'List artifacts',
    description:
      'List the artifacts that exist in this session with their ids, types, versions and ' +
      'sizes. Cheap — it never returns content. Use it to recover ids after compaction.',
    promptSnippet: 'List this session’s artifacts',
    parameters: Type.Object({}),
    async execute(): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
      if (artifacts.size === 0) {
        return { content: [{ type: 'text', text: 'No artifacts in this session yet.' }] }
      }
      const lines = [...artifacts.values()].map(
        (a) => `${a.id}  v${a.version}  ${a.type}  ${a.content.length} chars  "${a.title}"`,
      )
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    },
  })

  /**
   * Rebuild state from history so resumed sessions keep counting AND can still
   * be edited. Reading only the version number here was survivable while
   * `artifact_update` resent everything; `artifact_edit` needs the content.
   */
  pi.on('session_start', (_event, ctx) => {
    artifacts.clear()
    const manager = (ctx as { sessionManager?: { getBranch?: () => unknown[] } }).sessionManager
    const entries = manager?.getBranch?.() ?? []
    for (const entry of entries) {
      const record = entry as {
        type?: string
        message?: { role?: string; toolName?: string; details?: Partial<ArtifactDetails> }
      }
      if (record.type !== 'message' || record.message?.role !== 'toolResult') continue
      if (!record.message.toolName?.startsWith('artifact_')) continue
      const details = record.message.details
      if (!details?.id || typeof details.version !== 'number') continue
      if (typeof details.content !== 'string') continue
      const current = artifacts.get(details.id)
      if (current && current.version >= details.version) continue
      artifacts.set(details.id, {
        id: details.id,
        title: details.title ?? current?.title ?? details.id,
        // Old sessions carry the `'update'` sentinel; never let it become the type.
        type:
          details.type && (ARTIFACT_TYPES as readonly string[]).includes(details.type)
            ? details.type
            : (current?.type ?? 'code'),
        language: details.language ?? current?.language,
        content: details.content,
        version: details.version,
      })
    }
  })
}
