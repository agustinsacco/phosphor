import { TooltipButton } from '@/components/Tooltip'
import clsx from 'clsx'
import { ChevronDownIcon } from '@/components/icons'

/**
 * The composer's model · thinking split chip, shared by both owners.
 *
 * Two components drive it: `ModelPicker` (a live session, writing pi over
 * RPC) and `HomeModelPicker` (no session yet, writing pi's `settings.json`
 * defaults). That data split is deliberate — see the comment in
 * `HomeModelPicker`. The *presentation* was copy-pasted between them, and it
 * drifted: the session chip put the provider on the model's own line while
 * home still stacked it, and home named the provider for every model while
 * the session chip named it only when pi did not ship it. One of those was a
 * bug both times. The chrome lives here now so a change reaches both.
 *
 * The chip shows the model name and, as its right segment, the thinking
 * level. The provider is not on the chip: it goes in the chip's tooltip and,
 * for a session, in the status strip under the composer (`namedProvider`).
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

/**
 * The provider when it is worth naming, else nothing. Two providers can
 * expose the same model name (native anthropic and the Claude Code CLI
 * provider both offer "Claude Opus 5"), so for an installed provider the name
 * alone cannot answer "what is actually serving this session".
 */
export function namedProvider(provider: string | undefined): string | undefined {
  return provider !== undefined && !NATIVE_PROVIDERS.has(provider) ? provider : undefined
}

const CHIP_CLASS = 'h-8 px-2 text-base transition-colors'

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
  grouped,
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
  /** True when a `ThinkingChip` follows as the right half of the split. */
  grouped?: boolean | undefined
}): React.JSX.Element {
  return (
    <TooltipButton
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      data-loading={loading ? 'true' : undefined}
      title={title}
      className={clsx(
        CHIP_CLASS,
        'min-w-0 flex-1 text-left font-medium',
        grouped ? 'rounded-l-md' : 'rounded-md',
        disabled ? 'cursor-default' : 'cursor-pointer',
        chipTone(active),
      )}
    >
      {/* One line, always: a name that does not fit truncates rather than
          growing the footer a row. */}
      <span className="block truncate" data-testid="model-label">
        {name}
      </span>
    </TooltipButton>
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
    <TooltipButton
      onClick={onClick}
      data-testid={testId}
      tooltip="Thinking level"
      className={clsx(
        CHIP_CLASS,
        'border-border flex shrink-0 cursor-pointer items-center gap-1 rounded-r-md border-l',
        chipTone(active),
      )}
    >
      {label}
      <ChevronDownIcon size={10} className="text-text-tertiary" />
    </TooltipButton>
  )
}
