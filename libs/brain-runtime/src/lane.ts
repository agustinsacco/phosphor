import { dirname, resolve } from 'node:path'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { extractText } from '@phosphor/session-runtime/pi/session-content'
import { sessionTitle } from '@phosphor/shared/session-title'
import { readLaneEntries, type LaneEntry } from './transcript'

export interface LaneMeta {
  sessionId: string
  cwd: string
  title?: string | null
  scope: string
  branch: string | null
  model: string
  thinking: string
  leafId: string | null
}

export async function projectContext(
  cwd: string,
): Promise<{ scope: string; branch: string | null }> {
  const options = { trim: true, isolateEnv: true, timeout: 5000, maxBuffer: 4096 }
  try {
    const common = await git(
      cwd,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      options,
    )
    const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], options).catch(() => '')
    return {
      scope: dirname(resolve(cwd, common)),
      branch: branch && branch !== 'HEAD' ? branch : null,
    }
  } catch {
    return { scope: cwd, branch: null }
  }
}

export function laneMetadata(
  entries: LaneEntry[],
  readerModel: string | null = null,
): Omit<LaneMeta, 'scope' | 'branch'> {
  const header = entries.find((entry) => entry.type === 'session')
  if (!header?.id || !header.cwd) throw new Error('This lane has no session header.')
  let provider: string | undefined
  let model: string | undefined
  let assistantModel: string | undefined
  let assistantProvider: string | undefined
  let thinking = 'off'
  let leafId: string | null = null
  for (const entry of entries) {
    if (entry.id) leafId = entry.id
    if (entry.type === 'model_change') {
      provider = entry.provider
      model = entry.modelId
    } else if (
      entry.message?.role === 'assistant' &&
      entry.message.provider &&
      entry.message.model
    ) {
      assistantProvider = entry.message.provider
      assistantModel = entry.message.model
    }
    if (entry.type === 'thinking_level_change') thinking = entry.thinkingLevel ?? 'off'
  }
  provider ??= assistantProvider
  model ??= assistantModel
  const selectedModel = readerModel ?? (provider && model ? `${provider}/${model}` : null)
  if (!selectedModel) throw new Error('This lane has no model to read it with.')
  return {
    sessionId: header.id,
    cwd: header.cwd,
    model: selectedModel,
    thinking: readerModel === null ? thinking : 'medium',
    leafId,
  }
}

export async function readLane(path: string, readerModel: string | null = null): Promise<LaneMeta> {
  return laneInfo(await readLaneEntries(path), readerModel)
}

/** readLane for a transcript already in hand. */
export async function laneInfo(
  entries: LaneEntry[],
  readerModel: string | null = null,
): Promise<LaneMeta> {
  const meta = laneMetadata(entries, readerModel)
  return { ...meta, title: laneTitle(entries), ...(await projectContext(meta.cwd)) }
}

/** Match the sidebar: latest name, else the first prompt's first line (scanner bounds apply). */
export function laneTitle(entries: LaneEntry[]): string | null {
  const explicitName = entries.findLast((entry) => entry.type === 'session_info')?.name
  let firstUserText: string | undefined
  for (const entry of entries) {
    if (entry.type === 'message' && entry.message?.role === 'user' && !firstUserText)
      firstUserText = extractText(entry.message.content)
  }
  return sessionTitle(
    { explicitName, firstUserText: firstUserText?.slice(0, 200) },
    { elide: false },
  )
}
