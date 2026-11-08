import {
  CLAUDE_PROVIDER_PACKAGE,
  claudeContextProviderShortfall,
  MIN_CLAUDE_CONTEXT_VERSION,
  type PiPackageEntry,
} from '@shared/models'

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

/** Refuse visibly rather than start Claude on an older provider. */
export function assertClaudeContextProvider(
  packages: Pick<PiPackageEntry, 'name' | 'version' | 'installed'>[],
): void {
  const found = claudeContextProviderShortfall(packages)
  if (found === null) return
  throw new Error(
    `Claude sessions need ${CLAUDE_PROVIDER_PACKAGE} ${MIN_CLAUDE_CONTEXT_VERSION} or newer (${found}). ` +
      'Update it in Settings → Extensions, then reopen the session.',
  )
}

/**
 * Enforce pi ownership even if the launcher inherited legacy provider settings.
 *
 * `PI_SUBAGENT_CACHE_RETENTION=short` makes pi-subagents ask for five-minute
 * cache entries on a child's requests, the split Claude Code makes for its own
 * sub-agents. Native providers already default to `short`. On Claude (from
 * pi-claude-cli 0.11.0) it replaces the subscription's one-hour entries, whose
 * writes cost 2x input instead of 1.25x: 98% of children's requests came within
 * five minutes of the last, so over 30 days it cuts their write cost by a third
 * (about 25M input tokens' worth), and a finished child's process parks for
 * five minutes, not an hour.
 */
export function claudeProviderSpawnEnv(): Record<string, string> {
  return {
    PI_CLAUDE_CLI_CONTEXT: 'pi',
    PI_CLAUDE_CLI_KEEPALIVE_MS: String(CLAUDE_KEEPALIVE_MS),
    PI_SUBAGENT_CACHE_RETENTION: 'short',
  }
}

/**
 * How long a session's parked Claude CLI process waits for the next turn.
 *
 * The parked process IS the prompt cache: it holds the conversation in the
 * shape the API cached, and the next user turn appends to it. Once it is
 * retired, the next turn starts a fresh CLI and imports pi's history as
 * role-labelled text, which is a different byte sequence, so the whole context
 * is written to the cache again even when the API-side cache is still warm.
 * Claude Code keeps a subscription's cache for an hour; the provider's own
 * default parks for ten minutes. Over the 30 days before this was set, three
 * in four user turns that followed a 10-60 minute pause re-wrote their whole
 * context (22M tokens). An idle `claude` process costs memory, not tokens, so
 * the park matches the cache. One-shots override it with `claudeOneShotEnv`.
 */
export const CLAUDE_KEEPALIVE_MS = 60 * 60 * 1000

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
