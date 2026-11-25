import { tmpdir } from 'node:os'
import { createClaudeUsage, runUsageCommand } from '@phosphor/session-runtime/claude/usage'
import { runPrintMode } from '../pi/print-mode'
import { resolveBinary } from '../pi/packages'
import { piProcessEnv } from '@phosphor/session-runtime/pi/shell-env'

async function defaultRunner(binaryPath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const result = await runUsageCommand(runPrintMode, binaryPath, env, tmpdir())
  // runPrintMode never rejects; an error means "no answer" here.
  return result.error ? null : result.stdout
}

export const { cachedUsageSnapshot, fetchUsageSnapshot, clearUsageCache } = createClaudeUsage({
  binary: () => resolveBinary('claude'),
  environment: piProcessEnv,
  run: defaultRunner,
})
