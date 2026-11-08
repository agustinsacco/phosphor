import type { BrainModel } from '@phosphor/shared/brain'
import { resolvePiInvoker } from '../pi/invoker'
import { cachedPiHealth } from '../pi/health'

/** Explicit native API-key auth only. Never read pi auth files or copy ambient config. */
export async function resolveBrainProcessor(model: BrainModel) {
  const key =
    model.provider === 'anthropic'
      ? 'ANTHROPIC_API_KEY'
      : model.provider === 'openai'
        ? 'OPENAI_API_KEY'
        : undefined
  if (!key)
    throw new Error(
      'Brain requires a native Anthropic or OpenAI API-key model; CLI and OAuth are unsupported.',
    )
  const invoker = await resolvePiInvoker('minimal-stub')
  if (invoker.stub) throw new Error('Brain processing is unavailable with the pi test stub.')
  const health = await cachedPiHealth()
  if (!health.ok || !health.version) throw new Error('Brain requires a verified pi version.')
  if (!invoker.env[key]?.trim())
    throw new Error(
      `Brain requires ${key} in the local application environment; shared OAuth is not imported.`,
    )
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', key]) {
    if (invoker.env[name] !== undefined) env[name] = invoker.env[name]!
  }
  return {
    binaryPath: invoker.binaryPath,
    prefixArgs: invoker.prefixArgs,
    version: health.version,
    env,
  }
}
