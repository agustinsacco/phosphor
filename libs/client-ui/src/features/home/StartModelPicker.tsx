import { useState } from 'react'
import clsx from 'clsx'
import type { ThinkingLevel } from '@shared/rpc'
import { Button } from '@/components/form'
import { ModelMenu, type ModelMenuEntry } from '@/features/chat/composer/ModelMenu'
import { ThinkingMenu, thinkingLabel } from '@/features/chat/composer/ThinkingMenu'
import { ModelChip, ModelChipSkeleton, ThinkingChip } from '@/features/chat/composer/ModelChip'
import './startModelPicker.css'

/**
 * One machine's models for a lane that does not exist yet: This Mac's pi
 * catalogue and defaults (`useLocalStartModel`), or a Host's catalogue and the
 * picks remembered for it (`RemoteModelPicker`).
 */
export interface StartModelSource {
  /** `home` on This Mac, `remote` on a Host: the e2e suites address the chips by these. */
  testIdPrefix: 'home' | 'remote'
  models: ModelMenuEntry[]
  current: { provider: string; id: string } | undefined
  chip: {
    text: string
    /** `warning`: a pick the machine cannot honour; `muted`: why there is no pick. */
    tone: 'normal' | 'warning' | 'muted'
    title: string
  }
  /** The list is still loading: the chip waits rather than write a half-known pick. */
  loading: boolean
  /** The current model's levels; the thinking chip shows only when there is a choice. */
  levels: ThinkingLevel[]
  thinking: ThinkingLevel
  choose: (model: { provider: string; id: string }) => void
  setThinking: (level: ThinkingLevel) => void
  /** Called as the model menu opens. */
  onOpen?: () => void
  menu: {
    emptyText: string
    notice?: string | undefined
    unavailable?: ReadonlyMap<string, { detail: string }> | undefined
  }
  /** What the machine offers when it has no usable model: Retry models, Sign in on it. */
  actions: { label: string; run: () => void }[]
}

/**
 * The new-lane composer's model and thinking chips, at every width and on every
 * machine: the same split chip and searchable `ModelMenu` as every lane composer.
 * It grows into the toolbar's free width, so a long model name is not clipped
 * to the chip's floor.
 */
export function StartModelPicker({ source }: { source: StartModelSource }): React.JSX.Element {
  const [open, setOpen] = useState<'model' | 'thinking' | null>(null)
  const { chip, levels, current } = source
  return (
    <div className="start-model-picker">
      <div className="relative flex min-w-0 max-w-full flex-1 items-center">
        <ModelChip
          testId={`${source.testIdPrefix}-model-picker`}
          grouped={levels.length > 1}
          active={open === 'model'}
          disabled={source.loading}
          loading={source.loading}
          onClick={() => {
            setOpen(open === 'model' ? null : 'model')
            if (open !== 'model') source.onOpen?.()
          }}
          title={chip.title}
          name={
            source.loading ? (
              <ModelChipSkeleton />
            ) : (
              <span
                className={clsx(
                  chip.tone === 'warning' && 'text-warning',
                  chip.tone === 'muted' && 'text-text-tertiary',
                )}
              >
                {chip.text}
              </span>
            )
          }
        />
        {levels.length > 1 && (
          <ThinkingPick
            source={source}
            open={open === 'thinking'}
            setOpen={(next) => setOpen(next ? 'thinking' : null)}
          />
        )}
        {open === 'model' && (
          <ModelMenu
            models={source.models}
            isCurrent={(m) => m.id === current?.id && m.provider === current.provider}
            onPick={(m) => {
              setOpen(null)
              source.choose({ provider: m.provider, id: m.id })
            }}
            onClose={() => setOpen(null)}
            loading={source.loading}
            emptyText={source.menu.emptyText}
            notice={source.menu.notice}
            unavailable={source.menu.unavailable}
            className="w-[30rem] max-w-[92vw]"
          />
        )}
      </div>
      {source.actions.map((action) => (
        <Button key={action.label} size="sm" onClick={action.run}>
          {action.label}
        </Button>
      ))}
    </div>
  )
}

/** The thinking chip and its menu, on its own anchor. */
function ThinkingPick({
  source,
  open,
  setOpen,
}: {
  source: StartModelSource
  open: boolean
  setOpen: (open: boolean) => void
}): React.JSX.Element {
  return (
    // Its own anchor: the picker spans the footer's free width, so a menu
    // placed against it opens under the model chip, not this one.
    <div className="relative shrink-0">
      <ThinkingChip
        testId={`${source.testIdPrefix}-thinking-picker`}
        active={open}
        onClick={() => setOpen(!open)}
        label={thinkingLabel(source.thinking)}
      />
      {open && (
        <ThinkingMenu
          levels={source.levels}
          current={source.thinking}
          onPick={(level) => {
            setOpen(false)
            source.setThinking(level)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
