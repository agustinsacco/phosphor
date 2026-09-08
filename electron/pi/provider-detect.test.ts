import { describe, expect, it } from 'vitest'
import { claudeOneShotEnv, claudeProviderSpawnEnv, usesClaudeCliProvider } from './provider-detect'

describe('usesClaudeCliProvider', () => {
  it('trusts an explicit provider over everything else', () => {
    expect(usesClaudeCliProvider({ provider: 'pi-claude-cli' }, 'google')).toBe(true)
    expect(usesClaudeCliProvider({ provider: 'google' }, 'pi-claude-cli')).toBe(false)
    expect(
      usesClaudeCliProvider(
        { provider: 'google', model: 'pi-claude-cli/claude-opus-5' },
        undefined,
      ),
    ).toBe(false)
  })

  it('reads a provider/id model pattern as pinning the provider', () => {
    expect(usesClaudeCliProvider({ model: 'pi-claude-cli/claude-opus-5' }, 'google')).toBe(true)
    expect(usesClaudeCliProvider({ model: 'pi-claude-cli/claude-opus-5:high' }, undefined)).toBe(
      true,
    )
    expect(usesClaudeCliProvider({ model: 'google/gemini-2.5-pro' }, 'pi-claude-cli')).toBe(false)
  })

  it('falls back to the default provider when nothing is pinned', () => {
    expect(usesClaudeCliProvider({}, 'pi-claude-cli')).toBe(true)
    expect(usesClaudeCliProvider({}, 'google')).toBe(false)
    expect(usesClaudeCliProvider({}, undefined)).toBe(false)
  })

  it('requires a claude-ish bare pattern under a claude default', () => {
    expect(usesClaudeCliProvider({ model: 'claude-opus-5' }, 'pi-claude-cli')).toBe(true)
    // A bare non-claude pattern can fuzzy-match into another provider even
    // when the default is pi-claude-cli — do not strip context files there.
    expect(usesClaudeCliProvider({ model: 'gemini-2.5-pro' }, 'pi-claude-cli')).toBe(false)
    expect(usesClaudeCliProvider({ model: 'claude-opus-5' }, 'google')).toBe(false)
  })
})

describe('claudeProviderSpawnEnv', () => {
  it('asks pi-claude-cli for --strict-mcp-config', () => {
    expect(claudeProviderSpawnEnv().PI_CLAUDE_CLI_STRICT_MCP).toBe('1')
  })

  it("never sets hermetic mode, which would strip the CLI's CLAUDE.md", () => {
    // Phosphor passes --no-context-files, so pi does not send CLAUDE.md either.
    // Hermetic reaches the same MCP flag but also empties --setting-sources,
    // leaving the model with project instructions from neither side.
    expect(claudeProviderSpawnEnv()).not.toHaveProperty('PI_CLAUDE_CLI_HERMETIC')
  })

  // A session wants the park: it is the whole point of one CLI process per
  // session. Only one-shots opt out.
  it('leaves the 0.7.0 keepalive alone for real sessions', () => {
    expect(claudeProviderSpawnEnv()).not.toHaveProperty('PI_CLAUDE_CLI_KEEPALIVE_MS')
  })
})

describe('claudeOneShotEnv', () => {
  it('turns the 0.7.0 park off so `pi -p` can exit', () => {
    // With the park on, a print-mode run answers and then holds pi's event
    // loop for ten minutes. That is what stopped session auto-naming, and
    // with it every branch rename, the day 0.7.0 was installed.
    expect(claudeOneShotEnv().PI_CLAUDE_CLI_KEEPALIVE_MS).toBe('0')
  })
})
