import type { PiPackageEntry } from '@shared/models'
import { compareVersions } from './health'

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

/** The first provider release supporting pi context with native Claude tools. */
export const MIN_CLAUDE_CONTEXT_VERSION = '0.7.1'

/** Fail visibly rather than silently enabling two context loaders on old providers. */
export function assertClaudeContextProvider(
  packages: Pick<PiPackageEntry, 'name' | 'version' | 'installed'>[],
): void {
  const providers = packages.filter((pkg) => pkg.name === '@saccolabs/pi-claude-cli')
  if (
    providers.length === 0 ||
    providers.some(
      (pkg) =>
        !pkg.installed ||
        !pkg.version ||
        !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
        compareVersions(pkg.version, MIN_CLAUDE_CONTEXT_VERSION) < 0,
    )
  ) {
    throw new Error(
      `Claude context alignment requires @saccolabs/pi-claude-cli ${MIN_CLAUDE_CONTEXT_VERSION}+ ` +
        'as an installed pi package. Update it in Settings → Extensions, then start a fresh session.',
    )
  }
}

/**
 * Sent to every pi spawn so switching from a native provider to Claude keeps
 * the same project context. Other providers ignore these variables. Claude
 * keeps its own default prompt and native tools; pi alone supplies project
 * files, skills and custom integrations. The provider aligns tool vocabulary
 * and disables duplicate discovery, while preserving explicit host guards.
 *
 * `PI_CLAUDE_CLI_TOOL_RESULTS` is what makes a CLI-side tool row show an
 * OUTCOME. Without it the provider forwards the invocation and nothing else,
 * so every `Read`, `Bash` and `Grep` the CLI ran itself rendered as a row
 * that could never say whether it worked — 21 rows of "Ran ls" with no line
 * counts, no exit codes and nothing to expand into. It is a provider opt-in
 * because the flag changes the marker wire shapes (calls gain a `#<id>` tag,
 * results arrive as their own markers); `items/transcriptRows.ts` parses
 * both. Additive: a provider that predates the flag ignores it, and one
 * between 0.6.0 and 0.7.1 sends the leaner payload the same code reads.
 */
export function claudeProviderSpawnEnv(): Record<string, string> {
  return {
    PI_CLAUDE_CLI_STRICT_MCP: '1',
    PI_CLAUDE_CLI_CONTEXT: 'pi',
    PI_CLAUDE_CLI_TOOL_RESULTS: '1',
  }
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
 */
export function claudeOneShotEnv(): Record<string, string> {
  return { PI_CLAUDE_CLI_KEEPALIVE_MS: '0' }
}
