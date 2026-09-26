import { MIN_CLAUDE_CONTEXT_VERSION, type PiPackageEntry } from '@shared/models'
import { meetsMinimum } from '@shared/version'

/**
 * Will this spawn land on the Claude Code provider (`pi-claude-cli`)?
 *
 * Used for account routing and the context-policy version gate. All sessions
 * now retain pi's project context, including sessions that switch providers.
 *
 * Deliberately conservative: when the answer depends on pi's fuzzy model
 * matching (a bare pattern with no explicit provider), only a `claude*`
 * pattern under a `pi-claude-cli` default counts. A miss in that direction
 * is caught by the resolved-model check before prompting; a false positive
 * would require the Claude package for a session that never uses it.
 */
export function usesClaudeCliProvider(
  options: { provider?: string; model?: string },
  defaultProvider: string | undefined,
): boolean {
  if (options.provider) return options.provider === 'pi-claude-cli'
  // pi's `--model` accepts "provider/id" (and ":thinking" suffixes), which
  // pins the provider regardless of the default.
  if (options.model?.includes('/')) return options.model.split('/')[0] === 'pi-claude-cli'
  if (options.model) return defaultProvider === 'pi-claude-cli' && /^claude/i.test(options.model)
  return defaultProvider === 'pi-claude-cli'
}

/**
 * Refuse visibly rather than start Claude on an older provider. Before 0.9.0
 * the CLI loads its own context beside pi's, and on pi 0.86+ it misses pi's
 * prompt entirely, so the session would run without pi's instructions or skills.
 */
export function assertClaudeContextProvider(
  packages: Pick<PiPackageEntry, 'name' | 'version' | 'installed'>[],
): void {
  const providers = packages.filter((pkg) => pkg.name === '@saccolabs/pi-claude-cli')
  const unusable = providers.filter(
    (pkg) => !pkg.installed || !meetsMinimum(pkg.version, MIN_CLAUDE_CONTEXT_VERSION),
  )
  if (providers.length > 0 && unusable.length === 0) return
  // Name what is there, so "I already updated it" has an answer: a stale
  // project-scope copy fails the check even beside a current global one.
  const found =
    providers.length === 0
      ? 'it is not installed'
      : unusable
          .map((pkg) =>
            pkg.installed
              ? `found ${pkg.version ?? 'no version'}`
              : 'it is listed but not installed',
          )
          .join('; ')
  throw new Error(
    `Claude sessions need @saccolabs/pi-claude-cli ${MIN_CLAUDE_CONTEXT_VERSION} or newer (${found}). ` +
      'Update it in Settings → Extensions, then reopen the session.',
  )
}

/** Enforce pi ownership even if the launcher inherited legacy provider settings. */
export function claudeProviderSpawnEnv(): Record<string, string> {
  return { PI_CLAUDE_CLI_CONTEXT: 'pi' }
}

/**
 * Extra environment a ONE-SHOT `pi -p` run needs when it may land on the
 * Claude provider. Not for sessions — they want the park.
 *
 * pi-claude-cli >= 0.7.0 keeps one CLI process per session and, after
 * `result`, PARKS it for the next turn instead of ending it
 * (`PI_CLAUDE_CLI_KEEPALIVE_MS`, default ten minutes). A parked child holds
 * pi's event loop open, so `pi -p` prints its answer and then never exits.
 * Measured on 0.7.0: the title landed on stdout at 4.6s and the process was
 * still alive at 90s. `runPrintMode` gave up at 30s, so from the moment
 * 0.7.0 was installed every session auto-name failed — and with it every
 * branch rename, which only runs on a non-null title.
 *
 * A one-shot has no next turn to park for, so `0` costs it nothing.
 * Harmless env for every other provider, and ignored below 0.7.0.
 *
 * `PI_CLAUDE_CLI_EPHEMERAL` is the same argument for disk: `pi --no-session`
 * keeps pi's own transcript off disk, but the provider still saved a CLI
 * transcript, a session-map entry and a stored system prompt for every naming
 * run — none ever read again (238 orphaned transcripts on one install). Newer
 * providers skip all three; older ones ignore the variable.
 */
export function claudeOneShotEnv(): Record<string, string> {
  return { PI_CLAUDE_CLI_KEEPALIVE_MS: '0', PI_CLAUDE_CLI_EPHEMERAL: '1' }
}
