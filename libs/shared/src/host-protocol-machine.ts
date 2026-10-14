import type { ThinkingLevel, ThinkingLevelMap } from './rpc'

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
): { laneId?: string; name?: string; file?: string } | null {
  if (!machineRecord(v)) return null
  const keys =
    method === 'skills.read'
      ? ['laneId', 'name', 'file']
      : method === 'skills.list'
        ? ['laneId']
        : []
  if (
    !['machine.models', 'machine.providers', 'skills.list', 'skills.read'].includes(method) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    return null
  if (
    v.laneId !== undefined &&
    (typeof v.laneId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.laneId))
  )
    return null
  if (method === 'skills.read' && (!text(v.name, 64) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v.name)))
    return null
  if (v.file !== undefined && !isSkillFile(v.file)) return null
  return {
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
    let thinkingLevelMap: ThinkingLevelMap | null | undefined
    if (m.thinkingLevelMap !== undefined) {
      if (m.thinkingLevelMap === null) thinkingLevelMap = null
      else {
        const map = m.thinkingLevelMap
        const levels: readonly ThinkingLevel[] = [
          'off',
          'minimal',
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
        ]
        if (
          !machineRecord(map) ||
          Object.keys(map).some((key) => !levels.some((level) => level === key))
        )
          return null
        thinkingLevelMap = {}
        for (const level of levels) {
          const value = map[level]
          if (value === undefined) continue
          if (value !== null && !text(value, 100)) return null
          thinkingLevelMap[level] = value
        }
      }
    }
    let cost: MachineModel['cost']
    if (m.cost !== undefined) {
      const c = m.cost
      if (
        !machineRecord(c) ||
        ![c.input, c.output, c.cacheRead, c.cacheWrite].every(
          (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0,
        ) ||
        typeof c.input !== 'number' ||
        typeof c.output !== 'number' ||
        typeof c.cacheRead !== 'number' ||
        typeof c.cacheWrite !== 'number'
      )
        return null
      cost = { input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite }
    }
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
