import { describe, expect, it } from 'vitest'
import { matchErrorRemedy } from './errorRemedies'

describe('matchErrorRemedy', () => {
  it('matches the real Bedrock SSO expiry message', () => {
    const remedy = matchErrorRemedy(
      "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.",
    )
    expect(remedy?.command).toBe('aws sso login')
    expect(remedy?.retryAfter).toBe(true)
    expect(remedy?.hint).toMatch(/--profile/)
  })

  it('targets the active AWS profile when one is set', () => {
    const remedy = matchErrorRemedy('Token is expired, run aws sso login', { awsProfile: 'prod' })
    expect(remedy?.command).toBe('aws sso login --profile prod')
    expect(remedy?.hint).toContain('"prod"')
  })

  it('matches expired STS credentials', () => {
    expect(matchErrorRemedy('ExpiredTokenException: the token has expired')?.command).toMatch(
      /aws sso login/,
    )
    expect(
      matchErrorRemedy('The security token included in the request is invalid')?.command,
    ).toMatch(/aws sso login/)
  })

  it('offers the in-app rebuild for a Claude context policy mismatch', () => {
    // Verbatim from `context-policy.ts` in @saccolabs/pi-claude-cli.
    const remedy = matchErrorRemedy(
      'Claude context policy changed (or its saved prompt is missing). Start a fresh pi session; the existing Claude transcript was not migrated.',
    )
    expect(remedy?.action).toBe('resetClaudeContext')
    expect(remedy?.retryAfter).toBe(true)
    // No command and no docs link: Phosphor performs this one itself.
    expect(remedy?.command).toBeUndefined()
    expect(remedy?.docsUrl).toBeUndefined()
    // Switching models would not help — the transcript is the problem.
    expect(remedy?.suggestModelSwitch).toBeUndefined()
  })

  it('suggests pi /login for OAuth failures', () => {
    const remedy = matchErrorRemedy('OAuth refresh token rejected')
    expect(remedy?.command).toBe('pi')
    expect(remedy?.label).toBe('Run pi /login')
  })

  it('explains the Bedrock data retention failure without inventing a command', () => {
    const remedy = matchErrorRemedy(
      "Validation error: The model returned the following errors: data retention mode 'default' is not available for this model See https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html for supported data retention modes.",
    )
    expect(remedy?.command).toBeUndefined()
    expect(remedy?.docsUrl).toBe(
      'https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html',
    )
    expect(remedy?.suggestModelSwitch).toBe(true)
    expect(remedy?.retryAfter).toBe(false)
    expect(remedy?.hint).toMatch(/account-level/i)
  })

  it('points on-demand-throughput failures at an inference profile', () => {
    const remedy = matchErrorRemedy(
      "Validation error: Invocation of model ID anthropic.claude-fable-5 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model.",
    )
    expect(remedy?.label).toBe('Pick an inference profile')
    expect(remedy?.command).toBeUndefined()
    expect(remedy?.suggestModelSwitch).toBe(true)
    expect(remedy?.hint).toMatch(/region-prefixed/i)
  })

  it('prefers the retention diagnosis over the auth rules', () => {
    // The retention message mentions a docs URL and can co-occur with words the
    // OAuth/401 rule keys on; the specific diagnosis must win.
    const remedy = matchErrorRemedy(
      "data retention mode 'default' is not available for this model; unauthorized login",
    )
    expect(remedy?.docsUrl).toBeTruthy()
    expect(remedy?.command).toBeUndefined()
  })

  it('returns null for unknown errors rather than guessing a command', () => {
    expect(matchErrorRemedy('The model request failed.')).toBeNull()
    expect(matchErrorRemedy('rate limit exceeded, please slow down')).toBeNull()
    expect(matchErrorRemedy('overloaded_error: upstream capacity')).toBeNull()
    expect(matchErrorRemedy(undefined)).toBeNull()
    expect(matchErrorRemedy('')).toBeNull()
  })

  it('does not fire on a plain 401 with no login hint', () => {
    expect(matchErrorRemedy('401 Unauthorized')).toBeNull()
  })
})
