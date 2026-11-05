import { describe, expect, it } from 'vitest'
import { SUBSCRIPTION_PROVIDERS } from './subscription-providers'

describe('SUBSCRIPTION_PROVIDERS', () => {
  it('uses ids pi accepts, and says what each one costs', () => {
    // These ids are the auth.json keys; a typo silently reports "unknown"
    // forever, so pin them.
    expect(SUBSCRIPTION_PROVIDERS.map((p) => p.id)).toEqual([
      'openai-codex',
      'anthropic',
      'github-copilot',
      'kimi-for-coding',
      'xai',
      'openrouter',
      'radius',
    ])
    for (const provider of SUBSCRIPTION_PROVIDERS) {
      expect(provider.name).toBeTruthy()
      expect(provider.requires).toBeTruthy()
    }
    // Subscriptions first — the Accounts tab renders in this order, and a
    // per-token provider sitting under "a plan you already pay for" would be
    // an outright lie about what signing in costs.
    const billing = SUBSCRIPTION_PROVIDERS.map((p) => p.billing)
    expect(billing.lastIndexOf('subscription')).toBeLessThan(billing.indexOf('balance'))
  })

  it('warns that Anthropic OAuth does not spend plan limits', () => {
    // The whole reason the Claude Code provider extension exists. If this
    // caveat ever disappears the tab starts quietly recommending the
    // more expensive path.
    const anthropic = SUBSCRIPTION_PROVIDERS.find((p) => p.id === 'anthropic')
    expect(anthropic?.caveat).toMatch(/not against your Claude plan limits/i)
  })
})
