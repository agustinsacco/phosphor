/** Runtime facts carried with a lane, not provider credentials or configuration. */
export interface LaneRuntimeFacts {
  piVersion: string | null
  claudeVersion: string | null
  provider: string | null
  model: string | null
}

export function parseLaneRuntimeFacts(value: unknown): LaneRuntimeFacts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const version = (s: unknown): s is string | null =>
    s === null || (typeof s === 'string' && /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(s))
  // eslint-disable-next-line no-control-regex
  const controls = /[\x00-\x1f\x7f]/
  const name = (s: unknown): s is string | null =>
    s === null || (typeof s === 'string' && s.length > 0 && s.length <= 200 && !controls.test(s))
  if (
    Object.keys(v).length !== 4 ||
    !version(v.piVersion) ||
    !version(v.claudeVersion) ||
    !name(v.provider) ||
    !name(v.model)
  )
    return null
  return {
    piVersion: v.piVersion,
    claudeVersion: v.claudeVersion,
    provider: v.provider,
    model: v.model,
  }
}
