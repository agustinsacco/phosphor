import { tmpdir } from 'node:os'
import { createClaudeUsage } from '@phosphor/session-runtime/claude/usage'
import { runPrintMode } from '../pi/print-mode'
import { resolveBinary } from '../pi/packages'
import { piProcessEnv } from '../pi/shell-env'
export {
  parseResetStamp,
  windowKind,
  parseUsageText,
  parseUsageOutput,
} from '@phosphor/session-runtime/claude/usage'
export type { UsageRunner } from '@phosphor/session-runtime/claude/usage'

async function defaultRunner(binaryPath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  // `--no-session-persistence`: without it every poll saved a transcript under
  // ~/.claude/projects/<tmpdir> — nearly a thousand of them on one install.
  const result = await runPrintMode(
    binaryPath,
    ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
    { cwd: tmpdir(), env, timeoutMs: 20_000 },
  )
  // runPrintMode never rejects; an error means "no answer" here.
  return result.error ? null : result.stdout
}

export const { cachedUsageSnapshot, fetchUsageSnapshot, clearUsageCache } = createClaudeUsage({
  binary: () => resolveBinary('claude'),
  environment: piProcessEnv,
  run: defaultRunner,
})
