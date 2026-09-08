/**
 * Actionable remediation for provider/auth errors surfaced in the transcript.
 *
 * A turn that dies on "token expired" is not a modelling problem — it is a
 * one-command fix the user has to go find. Matching the handful of errors we
 * know the shell fix for turns each into a play button, while anything
 * unrecognized still renders as plain text (never a guessed command).
 */

export interface ErrorRemedy {
  /** Short imperative label for the button. */
  label: string
  /**
   * Shell command pasted into the session terminal. Omitted when the fix is
   * not a shell command at all (an AWS console setting, say) — inventing a
   * runnable-looking command for those would be worse than showing none.
   */
  command?: string
  /** One-line explanation shown under the error. */
  hint: string
  /**
   * True when the fix invalidates the current pi process's credentials — the
   * user must restart the session (or at least retry) after running it.
   */
  retryAfter: boolean
  /** Docs to read when the fix is a configuration change, not a command. */
  docsUrl?: string
  /**
   * True when switching models is a viable workaround, i.e. the failure is a
   * property of the chosen model rather than of the session or credentials.
   * Drives the "pick another model" affordance next to the error.
   */
  suggestModelSwitch?: boolean
}

/**
 * Best-effort AWS profile for the login command. `AWS_PROFILE` is the only
 * signal the renderer can see; without it `aws sso login` targets `default`,
 * which is usually NOT what a multi-profile setup wants — so we say so in the
 * hint rather than silently producing a command that logs into the wrong
 * account.
 */
function awsLoginCommand(profile: string | undefined): { command: string; hint: string } {
  if (profile) {
    return {
      command: `aws sso login --profile ${profile}`,
      hint: `Refreshes the expired SSO token for the "${profile}" profile, then retry.`,
    }
  }
  return {
    command: 'aws sso login',
    hint: 'Refreshes the expired SSO token, then retry. Add --profile <name> if you use named profiles.',
  }
}

/**
 * Map an error message to a runnable fix. Ordered most-specific first;
 * returns null when we do not know a safe command.
 */
export function matchErrorRemedy(
  message: string | undefined,
  context: { awsProfile?: string } = {},
): ErrorRemedy | null {
  if (!message) return null
  const text = message.toLowerCase()

  // Bedrock data retention mode. An account/profile-level Bedrock setting that
  // newer Claude models refuse to run under; nothing about the session, the
  // credentials or Phosphor can change it, so the only honest advice is "an admin
  // changes the account setting, or pick another model meanwhile".
  if (text.includes('data retention mode')) {
    return {
      label: 'Read the data retention docs',
      hint: 'This model requires a Bedrock data retention mode your AWS account does not have set. It is an account-level Bedrock setting, so a Bedrock admin has to change it — switching to a Claude 4.x model works meanwhile.',
      docsUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html',
      retryAfter: false,
      suggestModelSwitch: true,
    }
  }

  // Bare Bedrock foundation id invoked on-demand. The model menu now blocks
  // picking these, but a session pinned to one before that (or via pi's own
  // settings.json) still fails here.
  if (text.includes('on-demand throughput') && text.includes("isn't supported")) {
    return {
      label: 'Pick an inference profile',
      hint: 'This Bedrock model can only be invoked through an inference profile. Pick the region-prefixed variant of the same model (US, EU, or Global) from the model menu.',
      retryAfter: false,
      suggestModelSwitch: true,
    }
  }

  // Anthropic subscription usage consumed by a third-party app. Not an auth
  // failure and not retryable: the account has to top up, or the session has
  // to run on a provider that is not billed against the plan.
  if (text.includes('extra usage') && text.includes('plan limits')) {
    return {
      label: 'Open usage settings',
      hint: 'Your Claude plan limit is used up for third-party apps like Phosphor. Add usage credit on claude.ai, or switch to a model on another provider (or a local one) to keep working now.',
      docsUrl: 'https://claude.ai/settings/usage',
      retryAfter: false,
      suggestModelSwitch: true,
    }
  }

  // AWS SSO token expiry (Bedrock). The message names the fix explicitly.
  if (
    (text.includes('token is expired') || text.includes('token has expired')) &&
    (text.includes('sso') || text.includes('aws'))
  ) {
    const { command, hint } = awsLoginCommand(context.awsProfile)
    return { label: 'Run aws sso login', command, hint, retryAfter: true }
  }

  // Generic expired/invalid AWS credentials.
  if (
    text.includes('expiredtoken') ||
    (text.includes('security token') && text.includes('invalid'))
  ) {
    const { command, hint } = awsLoginCommand(context.awsProfile)
    return { label: 'Refresh AWS credentials', command, hint, retryAfter: true }
  }

  // pi's own OAuth providers (Anthropic/OpenAI/Copilot via `pi /login`).
  if (
    text.includes('oauth') ||
    text.includes('refresh token') ||
    ((text.includes('unauthorized') || text.includes('401')) && text.includes('login'))
  ) {
    return {
      label: 'Run pi /login',
      command: 'pi',
      hint: 'Opens pi in the terminal — use /login to re-authenticate, then retry.',
      retryAfter: true,
    }
  }

  return null
}
