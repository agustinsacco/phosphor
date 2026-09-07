import clsx from 'clsx'

/**
 * The composer's model and thinking chips, shared by both owners.
 *
 * Two components drive these: `ModelPicker` (a live session, writing pi over
 * RPC) and `HomeModelPicker` (no session yet, writing pi's `settings.json`
 * defaults). That data split is deliberate — see the comment in
 * `HomeModelPicker`. The *presentation* was copy-pasted between them, and it
 * drifted: the session chip put the provider on the model's own line while
 * home still stacked it, and home named the provider for every model while
 * the session chip named it only when pi did not ship it. One of those was a
 * bug both times. The chrome lives here now so a change reaches both.
 */

/**
 * Providers shipped by pi itself. Anything else is a package the user
 * installed, and worth naming in the UI.
 */
const NATIVE_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'google',
  'azure',
  'bedrock',
  'vertex',
  'groq',
  'mistral',
  'cerebras',
  'xai',
  'openrouter',
  'zai',
  'baseten',
  'fireworks',
  'together',
])

const CHIP_CLASS = 'min-h-8 rounded-md px-2 py-1 text-lg transition-colors'

function chipTone(active: boolean): string {
  return active
    ? 'bg-bg-secondary text-text'
    : 'text-text-secondary hover:bg-bg-secondary hover:text-text'
}

/** The pulse that stands in for a model name still being fetched. */
export function ModelChipSkeleton(): React.JSX.Element {
  return (
    <span className="bg-bg-secondary inline-block h-3.5 w-24 animate-pulse rounded align-middle" />
  )
}

export function ModelChip({
  testId,
  title,
  active,
  disabled,
  loading,
  onClick,
  name,
  provider,
}: {
  testId: string
  title?: string | undefined
  active: boolean
  /** Home disables the chip until the catalogue lands: a click on a
   *  half-known list writes a real mis-set, not a cosmetic one. */
  disabled?: boolean | undefined
  loading?: boolean | undefined
  onClick: () => void
  /** A node, not a string: home appends its own ` · unavailable` warnings. */
  name: React.ReactNode
  /** Named only when it is not a provider pi ships. */
  provider?: string | undefined
}): React.JSX.Element {
  const named = provider !== undefined && !NATIVE_PROVIDERS.has(provider)
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      data-loading={loading ? 'true' : undefined}
      title={title}
      className={clsx(
        CHIP_CLASS,
        'min-w-0 flex-1 text-left font-medium',
        disabled ? 'cursor-default' : 'cursor-pointer',
        chipTone(active),
      )}
    >
      {/* One line. Stacking the provider under the name gave the footer a
          second row for a detail most sessions do not even show. */}
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate" data-testid="model-label">
          {name}
        </span>
        {/* Two providers can expose the same model name (native anthropic
            and the Claude Code CLI provider both offer "Claude Opus 5"), so
            the name alone cannot answer "what is actually serving this
            session". The provider gives up its width first, since the name
            is what answers the question and the provider only disambiguates. */}
        {named && (
          <span
            data-testid="model-provider"
            className="text-text-tertiary min-w-0 shrink-[9999] truncate font-mono text-sm font-normal"
          >
            {provider}
          </span>
        )}
      </span>
    </button>
  )
}

export function ThinkingChip({
  testId,
  active,
  onClick,
  label,
}: {
  testId: string
  active: boolean
  onClick: () => void
  label: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={clsx(CHIP_CLASS, 'shrink-0 cursor-pointer', chipTone(active))}
    >
      {label}
    </button>
  )
}
