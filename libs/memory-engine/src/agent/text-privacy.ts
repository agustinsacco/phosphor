import { all, run, type Context } from '../database'

/** Erasure reasons cannot preserve even a long excerpt of the erased statement. */
export function repeatsMemoryText(reason: string, summary: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/gu, ' ').trim()
  const text = normalize(summary),
    why = normalize(reason)
  if (!text) return false
  if (text.length < 40) return why.includes(text)
  for (let i = 0; i <= text.length - 40; i++) if (why.includes(text.slice(i, i + 40))) return true
  return false
}
export function redactAgentReasons(ctx: Context, summary: string): void {
  for (const row of all<{ operation_id: string; role: string; reason: string }>(
    ctx,
    'SELECT operation_id,role,reason FROM agent_notes',
  ))
    if (repeatsMemoryText(row.reason, summary))
      run(
        ctx,
        'UPDATE agent_notes SET reason=? WHERE operation_id=? AND role=?',
        'Reason removed with an erased memory.',
        row.operation_id,
        row.role,
      )
}
