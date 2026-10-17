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
 * A session's OWN artifacts always come from its own branch, never from
 * Phosphor's artifact store, so they work exactly the same in plain pi. The
 * store (read-only here, `artifact-store.ts`) only answers for artifacts of
 * OTHER sessions, through a `<sessionId>/<slug>` ref.
 *
 * Imports resolve against pi's own runtime when it loads the extension.
 */
import { Type } from 'typebox'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  SNAPSHOT_COMMAND,
  SNAPSHOT_WIDGET,
  SNAPSHOT_PREFIX,
  SNAPSHOT_LIMIT,
  snapshotContent,
  validTargetId,
} from './subagent-snapshot'
import {
  ARTIFACT_ENTRY_TYPE,
  ARTIFACT_STORE_ENV,
  ARTIFACT_TYPES,
  branchVersion,
  currentVersion,
  findIndex,
  formatArtifactRef,
  parseArtifactRef,
  readAllIndexes,
  readBlob,
  type ArtifactRef,
} from './artifact-store'

interface ArtifactDetails {
  id: string
  title: string
  type: string
  language?: string
  content: string
  version: number
  /** Set by `artifact_create({ from })`: the ref the content was copied from. */
  derivedFrom?: string
}

/**
 * What a read of ANOTHER session's artifact records. Deliberately without
 * `id` and `content`: every version of the session_start rebuild (this one
 * and the ones already shipped) treats any `artifact_*` result carrying both
 * as this session's own artifact, so carrying them would adopt a foreign
 * artifact into this session the next time it resumes.
 */
interface ForeignReadDetails {
  ref: string
  foreign: true
  version: number
}

interface ToolResultLike {
  content: Array<{ type: 'text'; text: string }>
  details: ArtifactDetails
}

interface BranchEntry {
  type?: string
  id?: string
  firstKeptEntryId?: string
  customType?: string
  data?: Partial<ArtifactDetails>
  message?: { role?: string; toolName?: string; details?: Partial<ArtifactDetails> }
}

interface ContextLike {
  getSystemPromptOptions?: () => {
    skills?: Array<{ name: string; filePath: string; disableModelInvocation: boolean }>
  }
  sessionManager?: { getBranch?: () => unknown[]; getSessionId?: () => string }
}

interface AgentMessageLike {
  role?: string
  timestamp?: number
}

// Loose structural types: the real ones live in @earendil-works/pi-coding-agent,
// which is provided by pi at load time (not a Phosphor dependency).
interface PiExtensionApi {
  registerTool(definition: Record<string, unknown>): void
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
  appendEntry?(type: string, data: unknown): void
  registerCommand?(
    name: string,
    command: {
      description: string
      handler: (
        args: string,
        ctx: {
          sessionManager: { getSessionId(): string; getSessionFile(): string | undefined }
          ui: { setWidget(key: string, lines: string[] | undefined): void }
        },
      ) => Promise<void>
    },
  ): void
}

/** Entries in the post-compaction note before it says "and N more". */
const NOTE_LIMIT = 40
/** Rows `artifact_list({ scope: 'all' })` prints before asking for a query. */
const LIST_LIMIT = 50

/** Read the SAME skill pi resolved, never a hidden bundled fallback. */
export async function artifactGuide(ctx?: ContextLike): Promise<string> {
  const skill = ctx
    ?.getSystemPromptOptions?.()
    .skills?.find((entry) => entry.name === 'visual-artifacts' && !entry.disableModelInvocation)
  const unavailable =
    "The visual-artifacts skill is unavailable or hidden. Follow the user's instructions; " +
    'do not reinstall it automatically. The user can restore it in Skills. ' +
    'Reload pi or start a new session after changing skill availability.'
  if (!skill) return unavailable
  try {
    const content = await readFile(skill.filePath, 'utf8')
    // Honor hiding immediately too, before pi refreshes its skills index.
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? ''
    if (/^disable-model-invocation:\s*["']?true["']?\s*(?:#.*)?$/m.test(frontmatter))
      return unavailable
    if (Buffer.byteLength(content) > 128 * 1024)
      throw new Error('Artifact skill exceeds 128 KiB; move examples into references.')
    return `Artifact authoring skill: ${skill.filePath}\nReferences are relative to ${dirname(skill.filePath)}.\n\n${content}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return unavailable
    throw error
  }
}

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

type BranchRecord = Partial<ArtifactDetails> & Pick<ArtifactDetails, 'id' | 'version' | 'content'>

/**
 * The artifact record a branch entry holds, if any: the rule the session_start
 * rebuild has always used, shared by everything that reads the branch. Any
 * `artifact_*` result carrying an id, a version and a string content counts,
 * which is why a foreign read must carry neither.
 */
function branchRecord(entry: unknown): BranchRecord | null {
  const record = entry as BranchEntry
  const saved = record.type === 'custom' && record.customType === ARTIFACT_ENTRY_TYPE
  if (
    !saved &&
    (record.type !== 'message' ||
      record.message?.role !== 'toolResult' ||
      !record.message.toolName?.startsWith('artifact_'))
  )
    return null
  const details = saved ? record.data : record.message?.details
  if (!details?.id || typeof details.version !== 'number') return null
  if (typeof details.content !== 'string') return null
  return details as BranchRecord
}

/** Fold one branch entry into an artifact map, keeping each id's newest version. */
export function foldArtifactEntry(artifacts: Map<string, ArtifactDetails>, entry: unknown): void {
  const details = branchRecord(entry)
  if (!details) return
  const current = artifacts.get(details.id)
  if (current && current.version >= details.version) return
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

/**
 * The artifacts a compaction summarised away: everything written before the
 * latest compaction's first kept entry. Empty when the branch never compacted,
 * which is what keeps the note off sessions that do not need it.
 */
export function artifactsBeforeCompaction(entries: unknown[]): ArtifactDetails[] {
  let last = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if ((entries[i] as BranchEntry).type === 'compaction') {
      last = i
      break
    }
  }
  if (last === -1) return []
  const firstKept = (entries[last] as BranchEntry).firstKeptEntryId
  const before = new Map<string, ArtifactDetails>()
  for (let i = 0; i < last; i++) {
    const entry = entries[i] as BranchEntry
    if (firstKept && entry.id === firstKept) break
    foldArtifactEntry(before, entry)
  }
  return [...before.values()]
}

/** The note itself. Stable for the life of one compaction, so the cache holds. */
export function compactionNoteText(artifacts: ArtifactDetails[]): string | null {
  if (artifacts.length === 0) return null
  const lines = artifacts
    .slice(0, NOTE_LIMIT)
    .map((a) => `- ${a.id} v${a.version} ${a.type} "${a.title}"`)
  if (artifacts.length > NOTE_LIMIT) {
    lines.push(`- and ${artifacts.length - NOTE_LIMIT} more (artifact_list shows all)`)
  }
  return (
    'Artifacts created earlier in this session, before the conversation was compacted. ' +
    'Their content is not in your context: call artifact_read with an id to see one, ' +
    'or artifact_list for the current versions.\n' +
    lines.join('\n')
  )
}

/**
 * Put the note right after the compaction summary. Request-local: `context`
 * results are never persisted, so session files do not change.
 */
export function withCompactionNote<T extends AgentMessageLike>(
  messages: T[],
  note: string,
): T[] | undefined {
  let at = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'compactionSummary') {
      at = i
      break
    }
  }
  if (at === -1) return undefined
  const message = {
    role: 'custom',
    customType: 'phosphor-artifact-index',
    content: note,
    display: false,
    // The summary's own time, so the note never moves within the transcript.
    timestamp: messages[at]?.timestamp ?? 0,
  } as unknown as T
  return [...messages.slice(0, at + 1), message, ...messages.slice(at + 1)]
}

/** 1-based line window, the same convention as pi's own `read`. */
export function sliceLines(
  content: string,
  offset?: number,
  limit?: number,
): { text: string; range?: string } {
  if (offset == null && limit == null) return { text: content }
  const lines = content.split('\n')
  const start = Math.max(1, Math.floor(offset ?? 1))
  if (start > lines.length) {
    throw new Error(`offset ${start} is past the end (${lines.length} lines).`)
  }
  const end = limit == null ? lines.length : Math.min(lines.length, start + Math.floor(limit) - 1)
  return {
    text: lines.slice(start - 1, end).join('\n'),
    range: `lines ${start}-${end} of ${lines.length}`,
  }
}

const NO_STORE =
  'Artifacts from other sessions are only available in a session Phosphor started ' +
  '(this one has no artifact store). Artifacts of this session still work.'

interface ForeignArtifact {
  ref: string
  sessionLabel: string
  title: string
  type: string
  language?: string
  version: number
  content: string
}

/** Resolve a ref against the store. Throws a message the model can act on. */
function readForeign(root: string | undefined, ref: ArtifactRef): ForeignArtifact {
  if (!root) throw new Error(NO_STORE)
  const index = findIndex(root, ref.session)
  if (index === 'ambiguous') {
    throw new Error(`"${ref.session}" matches more than one session; use the full session id.`)
  }
  if (!index) throw new Error(`No session "${ref.session}" in the artifact store.`)
  const artifact = Object.hasOwn(index.artifacts, ref.slug) ? index.artifacts[ref.slug] : undefined
  if (!artifact) {
    const known = Object.keys(index.artifacts)
    throw new Error(
      `No artifact "${ref.slug}" in session ${index.sessionId}.` +
        (known.length ? ` Known ids there: ${known.join(', ')}.` : ''),
    )
  }
  const version =
    ref.version != null ? branchVersion(artifact, ref.version) : currentVersion(artifact)
  if (!version) {
    throw new Error(
      ref.version != null
        ? `${ref.slug} has no v${ref.version} on that session's branch.`
        : `${ref.slug} has no version on that session's branch.`,
    )
  }
  const content = readBlob(root, version.sha256)
  if (content == null)
    throw new Error(`The stored content of ${ref.slug} v${version.version} is missing.`)
  return {
    ref: formatArtifactRef(index.sessionId, ref.slug),
    sessionLabel: index.name ?? index.firstUserText?.slice(0, 60) ?? index.sessionId,
    title: version.title || artifact.title,
    type: artifact.type,
    language: artifact.language,
    version: version.version,
    content,
  }
}

export default function artifactsExtension(pi: PiExtensionApi): void {
  /**
   * Full current state per artifact, not just a version counter: `artifact_edit`
   * has to apply a patch to the live content, and after a resume that content
   * only exists in session history. Rebuilt in `session_start`.
   */
  const artifacts = new Map<string, ArtifactDetails>()
  /** The post-compaction note for the current branch, or null for none. */
  let compactionNote: string | null = null
  let ownSessionId: string | undefined

  /** Read lazily: the env is fixed for the process, but tests set it per case. */
  const storeRoot = (): string | undefined => process.env[ARTIFACT_STORE_ENV] || undefined

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

  /**
   * What an id names. A bare id, or a ref to this very session, is local.
   * Anything else is another session's, and only readable.
   */
  const resolve = (
    text: string,
  ): { foreign: ArtifactRef } | { local: string; version?: number } => {
    const ref = parseArtifactRef(text)
    if (!ref) return { local: slugifyArtifactId(text) }
    if (ownSessionId?.startsWith(ref.session)) return { local: ref.slug, version: ref.version }
    return { foreign: ref }
  }

  /** A local artifact to change. Another session's is refused, with the way out. */
  const writable = (text: string): ArtifactDetails => {
    const target = resolve(text)
    if ('foreign' in target) {
      throw new Error(
        `${text} belongs to another session and cannot be changed from here. ` +
          `Copy it into this session first: artifact_create with from: "${text}".`,
      )
    }
    return mustGet(target.local)
  }

  /** Store the next version of a record and return the tool result for it. */
  const commit = (record: ArtifactDetails, text: string): ToolResultLike => {
    artifacts.set(record.id, record)
    return { content: [{ type: 'text', text }], details: record }
  }

  /**
   * Rebuild state from the branch so resumed sessions keep counting AND can
   * still be edited. Reading only the version number here was survivable while
   * `artifact_update` resent everything; `artifact_edit` needs the content.
   */
  const rebuild = (ctx: unknown): void => {
    artifacts.clear()
    const manager = (ctx as ContextLike | undefined)?.sessionManager
    ownSessionId = manager?.getSessionId?.() ?? ownSessionId
    const entries = manager?.getBranch?.() ?? []
    for (const entry of entries) foldArtifactEntry(artifacts, entry)
    compactionNote = compactionNoteText(artifactsBeforeCompaction(entries))
  }

  /** A local artifact, at one version when asked: older ones come off the branch. */
  const localVersion = (ctx: unknown, id: string, version?: number): ArtifactDetails => {
    const current = mustGet(id)
    if (version == null || version === current.version) return current
    const entries = (ctx as ContextLike | undefined)?.sessionManager?.getBranch?.() ?? []
    for (const entry of entries) {
      const details = branchRecord(entry)
      if (details?.id === id && details.version === version) {
        return {
          ...current,
          title: details.title ?? current.title,
          content: details.content,
          version,
        }
      }
    }
    throw new Error(`${id} has no v${version} on this branch (current is v${current.version}).`)
  }

  pi.registerCommand?.(SNAPSHOT_COMMAND, {
    description: 'Save a bounded subagent inspection as an artifact, without a model turn',
    async handler(args, ctx) {
      const [requestId, encoded, ...extra] = args.trim().split(/\s+/)
      if (!validTargetId(requestId)) throw new Error('Invalid save request.')
      let reply: object
      try {
        if (!encoded || extra.length || encoded.length > SNAPSHOT_LIMIT * 9)
          throw new Error('Invalid snapshot payload.')
        const content = snapshotContent(
          JSON.parse(decodeURIComponent(encoded)),
          ctx.sessionManager.getSessionId(),
        )
        if (!pi.appendEntry) throw new Error('This Pi cannot save artifacts.')
        const sessionFile = ctx.sessionManager.getSessionFile()
        if (!sessionFile || !existsSync(sessionFile))
          throw new Error(
            'This session is not persisted yet. Complete its first parent turn before saving.',
          )
        const record: ArtifactDetails = {
          id: `subagent-${randomUUID()}`,
          title: 'Saved subagent snapshot',
          type: 'markdown',
          content,
          version: 1,
        }
        pi.appendEntry(ARTIFACT_ENTRY_TYPE, record)
        commit(record, '')
        reply = { requestId, artifact: record }
      } catch (error) {
        reply = { requestId, error: error instanceof Error ? error.message : String(error) }
      }
      ctx.ui.setWidget(SNAPSHOT_WIDGET, [`${SNAPSHOT_PREFIX}${JSON.stringify(reply)}`])
      ctx.ui.setWidget(SNAPSHOT_WIDGET, undefined)
    },
  })

  pi.registerTool({
    name: 'artifact_help',
    label: 'Artifact guide',
    description: 'Load the active visual-artifacts skill before creating or restyling an artifact.',
    promptSnippet: 'Load artifact authoring and styling guidance on demand',
    parameters: Type.Object({}),
    async execute(
      _id: string,
      _params: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      ctx?: ContextLike,
    ) {
      return { content: [{ type: 'text', text: await artifactGuide(ctx) }], details: undefined }
    },
  })

  pi.registerTool({
    name: 'artifact_create',
    label: 'Create artifact',
    description:
      'Create a self-contained artifact in the side panel. Call artifact_help before authoring ' +
      'to choose the medium with the visual-artifacts skill. HTML is a sandboxed fragment with no network. ' +
      'Link the result as [Title](artifact://<id>). Small snippets stay in chat.',
    promptSnippet: 'Create a side-panel artifact; load artifact_help to choose its medium',
    promptGuidelines: [
      'Use artifacts for requested pages or substantial deliverables, not routine updates. ' +
        'Call artifact_help before authoring; prefer artifact_edit for revisions.',
    ],
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({ description: 'Stable slug id; generated from the title if omitted' }),
      ),
      title: Type.String({ description: 'Human-readable title shown in the panel' }),
      type: Type.Optional(
        Type.String({
          description: `Artifact type: ${ARTIFACT_TYPES.join(' | ')}. Required unless from is set`,
        }),
      ),
      content: Type.Optional(
        Type.String({ description: 'Full artifact content. Omit only when from is set' }),
      ),
      language: Type.Optional(
        Type.String({ description: 'Language for type=code (e.g. typescript, python)' }),
      ),
      from: Type.Optional(
        Type.String({
          description:
            'Copy an existing artifact (an id here, or a <sessionId>/<slug> ref from artifact_list) as the starting content',
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        id?: string
        title: string
        type?: string
        content?: string
        language?: string
        from?: string
      },
      _signal?: unknown,
      _onUpdate?: unknown,
      ctx?: unknown,
    ): Promise<ToolResultLike> {
      let source: { type: string; language?: string; content: string; ref: string } | undefined
      if (params.from) {
        const target = resolve(params.from)
        if ('foreign' in target) {
          const foreign = readForeign(storeRoot(), target.foreign)
          source = { ...foreign, ref: `${foreign.ref}@v${foreign.version}` }
        } else {
          const local = localVersion(ctx, target.local, target.version)
          source = { ...local, ref: `${local.id}@v${local.version}` }
        }
      }
      const rawType = params.type ?? source?.type
      if (!rawType) throw new Error('type is required (or set from to copy an artifact).')
      const content = params.content ?? source?.content
      if (content == null) throw new Error('content is required (or set from to copy an artifact).')
      const type = rawType.toLowerCase()
      if (!(ARTIFACT_TYPES as readonly string[]).includes(type)) {
        throw new Error(
          `Unknown artifact type "${rawType}" — use one of: ${ARTIFACT_TYPES.join(', ')}`,
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
          language: params.language ?? source?.language,
          content,
          version,
          ...(source ? { derivedFrom: source.ref } : {}),
        },
        `Created artifact "${params.title}" (id: ${id}, v${version}, ${type}, ` +
          `${content.length} chars${source ? `, copied from ${source.ref}` : ''}). ` +
          'It is now visible in the artifact panel. ' +
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
      const previous = writable(params.id)
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
      const previous = writable(params.id)
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
      'Return the content of an artifact: one of this session, or another session’s by its ' +
      '<sessionId>/<slug> ref from artifact_list. Use before artifact_edit when the text is ' +
      'not already in context (after compaction, or in a resumed session) so old_string can ' +
      'be matched exactly. This is the one artifact tool whose output enters the context ' +
      'window, so read only what you need: offset/limit return a range of lines.',
    promptSnippet: 'Read an artifact’s content back into context',
    parameters: Type.Object({
      id: Type.String({ description: 'Id of the artifact, or a <sessionId>/<slug> ref' }),
      version: Type.Optional(
        Type.Number({ description: 'Version to read; the current one if omitted' }),
      ),
      offset: Type.Optional(Type.Number({ description: 'First line to return (1-based)' })),
      limit: Type.Optional(Type.Number({ description: 'Number of lines to return' })),
    }),
    async execute(
      _toolCallId: string,
      params: { id: string; version?: number; offset?: number; limit?: number },
      _signal?: unknown,
      _onUpdate?: unknown,
      ctx?: unknown,
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }> {
      const target = resolve(params.id)
      if ('foreign' in target) {
        const foreign = readForeign(storeRoot(), {
          ...target.foreign,
          ...(params.version != null ? { version: params.version } : {}),
        })
        const { text, range } = sliceLines(foreign.content, params.offset, params.limit)
        const details: ForeignReadDetails = {
          ref: foreign.ref,
          foreign: true,
          version: foreign.version,
        }
        return {
          content: [
            {
              type: 'text',
              text:
                `${foreign.ref} v${foreign.version} (${foreign.type}, ${foreign.content.length} chars` +
                `${range ? `, ${range}` : ''}) from session "${foreign.sessionLabel}". ` +
                'Read-only here; copy it with artifact_create({ from }) to change it.\n\n' +
                text,
            },
          ],
          details,
        }
      }
      const current = mustGet(target.local)
      const record = localVersion(ctx, target.local, params.version ?? target.version)
      const { text, range } = sliceLines(record.content, params.offset, params.limit)
      return {
        content: [
          {
            type: 'text',
            text:
              `${record.id} v${record.version} (${record.type}, ${record.content.length} chars` +
              `${range ? `, ${range}` : ''})\n\n` +
              text,
          },
        ],
        // The CURRENT record, as before: the session_start rebuild keeps the
        // newest version it sees, so an older one here could never regress it,
        // but there is no reason to record anything new either.
        details: current,
      }
    },
  })

  pi.registerTool({
    name: 'artifact_list',
    label: 'List artifacts',
    description:
      'List artifacts with their ids, types, versions and sizes. Cheap: it never returns ' +
      'content. Use it to recover ids after compaction. scope "all" also lists other ' +
      'sessions’ artifacts as <sessionId>/<slug> refs for artifact_read and ' +
      'artifact_create({ from }); query filters by id or title.',
    promptSnippet: 'List this session’s artifacts (or every session’s)',
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union([Type.Literal('session'), Type.Literal('all')], {
          description: 'session (default) or all',
        }),
      ),
      query: Type.Optional(Type.String({ description: 'Case-insensitive id/title filter' })),
    }),
    async execute(
      _toolCallId: string,
      params: { scope?: 'session' | 'all'; query?: string } = {},
    ): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
      const query = params.query?.trim().toLowerCase()
      const matches = (id: string, title: string): boolean =>
        !query || id.toLowerCase().includes(query) || title.toLowerCase().includes(query)
      const local = [...artifacts.values()]
        .filter((a) => matches(a.id, a.title))
        .map((a) => `${a.id}  v${a.version}  ${a.type}  ${a.content.length} chars  "${a.title}"`)

      if (params.scope !== 'all') {
        if (local.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text:
                  artifacts.size === 0
                    ? 'No artifacts in this session yet.'
                    : `No artifacts in this session match "${params.query}".`,
              },
            ],
          }
        }
        return { content: [{ type: 'text', text: local.join('\n') }] }
      }

      const root = storeRoot()
      if (!root) throw new Error(NO_STORE)
      const others: Array<{ line: string; at: string }> = []
      for (const index of readAllIndexes(root)) {
        if (ownSessionId && index.sessionId === ownSessionId) continue
        const label = index.name ?? index.firstUserText?.slice(0, 60) ?? 'untitled session'
        for (const artifact of Object.values(index.artifacts)) {
          const version = currentVersion(artifact)
          if (!version) continue
          const title = version.title || artifact.title
          const ref = formatArtifactRef(index.sessionId, artifact.slug)
          if (!matches(ref, title) && !matches(artifact.slug, label)) continue
          others.push({
            at: version.createdAt,
            line:
              `${ref}  v${version.version}  ${artifact.type}  ${version.bytes} bytes  "${title}"` +
              `  (session: ${label}${index.deleted ? ', deleted' : ''})`,
          })
        }
      }
      others.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      const sections = [
        `This session:\n${local.length ? local.join('\n') : '(none)'}`,
        `Other sessions, newest first:\n${
          others.length
            ? others
                .slice(0, LIST_LIMIT)
                .map((o) => o.line)
                .join('\n')
            : '(none)'
        }`,
      ]
      if (others.length > LIST_LIMIT) {
        sections.push(`${others.length - LIST_LIMIT} more; narrow it with query.`)
      }
      return { content: [{ type: 'text', text: sections.join('\n\n') }] }
    },
  })

  pi.on('session_start', (_event, ctx) => rebuild(ctx))
  // Navigating the tree inside a running pi changes the branch without a restart.
  pi.on('session_tree', (_event, ctx) => rebuild(ctx))
  pi.on('session_compact', (_event, ctx) => rebuild(ctx))

  pi.on('context', (event) => {
    if (!compactionNote) return undefined
    const messages = (event as { messages?: AgentMessageLike[] }).messages
    if (!messages) return undefined
    const next = withCompactionNote(messages, compactionNote)
    return next ? { messages: next } : undefined
  })
}
