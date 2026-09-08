/**
 * Will this spawn land on the Claude Code provider (`pi-claude-cli`)?
 *
 * Decided at spawn time so Phosphor can pass `--no-context-files` for those
 * sessions: the Claude CLI loads CLAUDE.md itself as memory, and pi embedding
 * the same file in its system prompt bills it twice on every request
 * (~4,900 tokens measured on this repo's CLAUDE.md). See
 * docs/log/2026-08-29-claude-provider-token-overhead.md.
 *
 * Deliberately conservative: when the answer depends on pi's fuzzy model
 * matching (a bare pattern with no explicit provider), only a `claude*`
 * pattern under a `pi-claude-cli` default counts. A miss in that direction
 * costs the ~4,900 duplicated tokens (status quo), while a false positive
 * would silently strip CLAUDE.md from a non-Claude provider's prompt.
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
 * Extra environment a Claude-provider spawn needs, on top of `piProcessEnv()`.
 *
 * `PI_CLAUDE_CLI_STRICT_MCP` confines the Claude CLI to the schema-only server
 * pi-claude-cli generates from pi's own tool registry, so MCP reaches the
 * model through one door: pi-mcp-adapter's `mcp` gateway, configured by
 * Settings -> Connectors. Without it the CLI also loads whatever is in
 * `~/.claude/.mcp.json`, `~/.claude.json` and the user's claude.ai connectors.
 * Those servers are invisible to Phosphor (the status chip and the context meter
 * both read the adapter, which only knows its own chain), they never become pi
 * `tool_execution_*` events, so `pi-ext/worktree-paths.ts` cannot guard them,
 * and they make the same project behave differently on two machines.
 *
 * Deliberately NOT `PI_CLAUDE_CLI_HERMETIC`, which would reach the same flag
 * but also pass an empty `--setting-sources`. That drops the CLI's CLAUDE.md
 * auto-memory, and Phosphor already passes `--no-context-files` so pi does not
 * send its own copy — the model would end up with project instructions from
 * neither side. See docs/mcp.md.
 *
 * Requires pi-claude-cli >= 0.5.1; older versions ignore the variable, which
 * leaves the pre-existing behaviour rather than breaking a session.
 */
export function claudeProviderSpawnEnv(): Record<string, string> {
  return { PI_CLAUDE_CLI_STRICT_MCP: '1' }
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
