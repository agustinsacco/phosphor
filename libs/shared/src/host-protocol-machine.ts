import type { ClaudeUsageSnapshotResult, ClaudeUsageWindow } from './models'
import type { ThinkingLevelMap } from './rpc'
import { parseModelCost, parseModelThinkingLevelMap } from './host-protocol-machine/model-fields'

/** Read-only machine methods. No executable, environment or filesystem root comes from a client. */
export const MACHINE_LIMITS = { models: 1000, skills: 500, textBytes: 2 * 1024 * 1024 } as const
export interface MachineModel {
  id: string
  name: string
  provider: string
  reasoning: boolean
  thinkingLevelMap?: ThinkingLevelMap | null
  contextWindow?: number
  maxTokens?: number
  input?: string[]
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}
export interface MachineProvider {
  id: string
  name: string
  status: 'ready' | 'not_ready' | 'unknown'
}
export interface MachineSkill {
  name: string
  description: string
  scope: 'user' | 'project'
}
export type SkillReadResult =
  { binary: true; size: number } | { binary: false; size: number; content: string }
export const machineRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = 200): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
const size = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
export function isSkillFile(v: unknown): v is string {
  return (
    text(v, 1024) &&
    !v.startsWith('/') &&
    !v.includes('\\') &&
    v.split('/').every((p) => p !== '' && p !== '..' && p !== '.' && p !== '.git')
  )
}
export function parseMachineParams(
  method: string,
  v: unknown,
): { laneId?: string; name?: string; file?: string; force?: boolean } | null {
  if (!machineRecord(v)) return null
  const keys =
    method === 'skills.read'
      ? ['laneId', 'name', 'file']
      : method === 'skills.export'
        ? ['name']
        : method === 'skills.list'
          ? ['laneId']
          : method === 'machine.claudeUsage'
            ? ['laneId', 'force']
            : []
  if (
    ![
      'machine.models',
      'machine.providers',
      'machine.claude',
      'machine.claudeUsage',
      'skills.list',
      'skills.read',
      'skills.export',
    ].includes(method) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    return null
  if (
    v.laneId !== undefined &&
    (typeof v.laneId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.laneId))
  )
    return null
  if (
    (method === 'skills.read' || method === 'skills.export') &&
    (!text(v.name, 64) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v.name))
  )
    return null
  if (v.file !== undefined && !isSkillFile(v.file)) return null
  if (v.force !== undefined && typeof v.force !== 'boolean') return null
  return {
    ...(v.force === true ? { force: true } : {}),
    ...(typeof v.laneId === 'string' ? { laneId: v.laneId } : {}),
    ...(typeof v.name === 'string' ? { name: v.name } : {}),
    ...(typeof v.file === 'string' ? { file: v.file } : {}),
  }
}
/** Project only reviewed model fields, never pi's open-ended metadata. */
export function parseMachineModels(v: unknown): MachineModel[] | null {
  if (!Array.isArray(v) || v.length > MACHINE_LIMITS.models) return null
  const models: MachineModel[] = []
  for (const m of v) {
    if (
      !machineRecord(m) ||
      !text(m.id) ||
      !text(m.name) ||
      !text(m.provider, 64) ||
      typeof m.reasoning !== 'boolean'
    )
      return null
    if (
      (m.contextWindow !== undefined && !size(m.contextWindow)) ||
      (m.maxTokens !== undefined && !size(m.maxTokens))
    )
      return null
    if (
      m.input !== undefined &&
      (!Array.isArray(m.input) ||
        m.input.length > 2 ||
        !m.input.every((x) => x === 'text' || x === 'image'))
    )
      return null
    const thinkingLevelMapResult = parseModelThinkingLevelMap(m.thinkingLevelMap)
    if (!thinkingLevelMapResult.ok) return null
    const costResult = parseModelCost(m.cost)
    if (!costResult.ok) return null
    const thinkingLevelMap = thinkingLevelMapResult.value
    const cost = costResult.value
    models.push({
      id: m.id,
      name: m.name,
      provider: m.provider,
      reasoning: m.reasoning,
      ...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
      ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
      ...(typeof m.maxTokens === 'number' ? { maxTokens: m.maxTokens } : {}),
      ...(Array.isArray(m.input)
        ? { input: m.input.filter((x): x is string => typeof x === 'string') }
        : {}),
      ...(cost ? { cost } : {}),
    })
  }
  return models
}
export function parseMachineProviders(v: unknown): MachineProvider[] | null {
  if (!Array.isArray(v) || v.length > 64) return null
  const out: MachineProvider[] = []
  for (const p of v) {
    if (
      !machineRecord(p) ||
      !text(p.id, 64) ||
      !text(p.name) ||
      !['ready', 'not_ready', 'unknown'].includes(String(p.status))
    )
      return null
    if (p.status !== 'ready' && p.status !== 'not_ready' && p.status !== 'unknown') return null
    out.push({ id: p.id, name: p.name, status: p.status })
  }
  return out
}
export function parseMachineSkills(v: unknown): MachineSkill[] | null {
  if (!Array.isArray(v) || v.length > MACHINE_LIMITS.skills) return null
  const out: MachineSkill[] = []
  for (const s of v) {
    if (
      !machineRecord(s) ||
      !text(s.name, 64) ||
      typeof s.description !== 'string' ||
      s.description.length > 1024 ||
      (s.scope !== 'user' && s.scope !== 'project')
    )
      return null
    out.push({ name: s.name, description: s.description, scope: s.scope })
  }
  return out
}
export function parseSkillReadResult(v: unknown): SkillReadResult | null {
  if (!machineRecord(v) || !size(v.size)) return null
  if (v.binary === true) return { binary: true, size: v.size }
  if (
    v.binary !== false ||
    typeof v.content !== 'string' ||
    v.size > MACHINE_LIMITS.textBytes ||
    v.content.length > MACHINE_LIMITS.textBytes
  )
    return null
  return { binary: false, size: v.size, content: v.content }
}

export type MachineClaude = {
  provider: 'ok' | 'missing' | 'outdated'
  cli: 'ok' | 'missing'
  auth: 'ok' | 'signed-out' | 'unknown'
}

export function parseMachineClaude(value: unknown): MachineClaude | null {
  if (
    !machineRecord(value) ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some((key) => !['provider', 'cli', 'auth'].includes(key))
  )
    return null
  const { provider, cli, auth } = value
  if (provider !== 'ok' && provider !== 'missing' && provider !== 'outdated') return null
  if (cli !== 'ok' && cli !== 'missing') return null
  if (auth !== 'ok' && auth !== 'signed-out' && auth !== 'unknown') return null
  return { provider, cli, auth }
}

/** Plan windows per `/usage` run; the CLI prints three or four today. */
const USAGE_WINDOWS = 16
const USAGE_KINDS: readonly ClaudeUsageWindow['kind'][] = [
  'five_hour',
  'weekly',
  'weekly_model',
  'other',
]
const stamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

/**
 * The Host's `machine.claudeUsage` answer: the windows its own `claude -p
 * /usage` printed for the lane's account, reset times already absolute. The
 * CLI's free-text "contributing" block never crosses the wire.
 */
export function parseMachineClaudeUsage(v: unknown): ClaudeUsageSnapshotResult | null {
  if (!machineRecord(v)) return null
  if (v.ok === false) {
    const error = v.error
    return error === 'claude-not-found' || error === 'run-failed' || error === 'no-usage'
      ? { ok: false, error }
      : null
  }
  const snap = v.snapshot
  if (v.ok !== true || !machineRecord(snap) || !stamp(snap.fetchedAt)) return null
  if (typeof snap.stale !== 'boolean' || !Array.isArray(snap.windows)) return null
  if (snap.windows.length > USAGE_WINDOWS) return null
  const windows: ClaudeUsageWindow[] = []
  for (const w of snap.windows) {
    if (!machineRecord(w) || !text(w.label)) return null
    const kind = USAGE_KINDS.find((k) => k === w.kind)
    const percentUsed = w.percentUsed
    if (!kind || typeof percentUsed !== 'number' || !Number.isInteger(percentUsed)) return null
    if (percentUsed < 0 || percentUsed > 200) return null
    if (w.resetsAt !== null && !stamp(w.resetsAt)) return null
    windows.push({ label: w.label, kind, percentUsed, resetsAt: w.resetsAt })
  }
  return {
    ok: true,
    snapshot: { fetchedAt: snap.fetchedAt, stale: snap.stale, windows, contributing: null },
  }
}
