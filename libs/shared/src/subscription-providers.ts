import type { SubscriptionProvider } from './models'

/**
 * Every provider pi offers under "Sign in with an account".
 *
 * Hand-curated, because pi offers no way to enumerate them: `/login` is
 * TUI-only, the RPC protocol has no auth command, and `@earendil-works/pi-ai`
 * stopped exporting its OAuth registry publicly — in 0.84 the `./oauth`
 * subpath is types-only, and the runtime moved from where 0.79 kept it.
 * Deep-importing that private path would break on a pi upgrade, so this list
 * is read off pi's own login screen instead (pi 0.84.1) and maintained by
 * hand. Every id here is verified to be accepted by `pi auth check
 * --provider`; an id pi does not know answers `provider_not_found`, which
 * surfaces as "unknown".
 *
 * Order is the order the Accounts tab renders: subscriptions first, because
 * using a plan you already pay for is the whole point of signing in here.
 */
export const SUBSCRIPTION_PROVIDERS: SubscriptionProvider[] = [
  {
    id: 'openai-codex',
    name: 'ChatGPT (Codex)',
    requires: 'ChatGPT Plus or Pro',
    billing: 'subscription',
    caveat:
      'Signing in through an OSS client is a supported path — OpenAI names pi specifically. Usage counts against your included ChatGPT usage.',
  },
  {
    id: 'anthropic',
    name: 'Claude Pro/Max',
    requires: 'Claude Pro or Max',
    billing: 'subscription',
    caveat:
      'Per pi’s own docs, third-party harness usage bills per token from extra usage — not against your Claude plan limits. For plan-limit usage, use the Claude Code provider extension instead.',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    requires: 'a Copilot subscription',
    billing: 'subscription',
    caveat:
      'Signs into github.com. For a GitHub Enterprise Server host, use “Open pi’s login terminal” instead — the host cannot be guessed.',
  },
  {
    id: 'kimi-for-coding',
    name: 'Kimi For Coding',
    requires: 'a Kimi For Coding plan',
    billing: 'subscription',
  },
  {
    id: 'xai',
    name: 'xAI',
    requires: 'an xAI account',
    billing: 'balance',
    caveat: 'Billed per token against your xAI credit balance, not a flat plan.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    requires: 'an OpenRouter account',
    billing: 'balance',
    caveat: 'Billed per token against your OpenRouter credit balance, not a flat plan.',
  },
  {
    id: 'radius',
    name: 'Radius',
    requires: 'a Radius account',
    billing: 'balance',
  },
]
