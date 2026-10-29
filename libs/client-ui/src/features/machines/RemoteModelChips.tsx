import { useState } from 'react'
import { supportedThinkingLevels } from '@shared/thinking'
import { ModelMenu } from '@/features/chat/composer/ModelMenu'
import { ThinkingMenu, thinkingLabel } from '@/features/chat/composer/ThinkingMenu'
import { ModelChip, ThinkingChip } from '@/features/chat/composer/ModelChip'
import type { useRemoteModel } from './useRemoteModel'

/**
 * The Host start page's model and thinking chips, at every width.
 *
 * The same split chip and searchable `ModelMenu` as This Mac's home and every
 * lane composer, so starting a lane on a Host looks like starting one here.
 * Only the data differs: the Host's catalogue, remembered per Host.
 */
export function RemoteModelChips({
  selection,
}: {
  selection: ReturnType<typeof useRemoteModel>
}): React.JSX.Element {
  const { model, thinking } = selection
  const levels = model ? supportedThinkingLevels(model) : []
  const [open, setOpen] = useState<'model' | 'thinking' | null>(null)
  return (
    <div className="relative flex min-w-0 max-w-full flex-1 items-center">
      <ModelChip
        testId="remote-model-picker"
        grouped={levels.length > 1}
        active={open === 'model'}
        onClick={() => setOpen(open === 'model' ? null : 'model')}
        title={model ? `${model.name} · ${selection.explanation}` : selection.hint}
        name={model?.name ?? <span className="text-text-tertiary">{selection.hint}</span>}
      />
      {levels.length > 1 && (
        <div className="relative shrink-0">
          <ThinkingChip
            testId="remote-thinking-picker"
            active={open === 'thinking'}
            onClick={() => setOpen(open === 'thinking' ? null : 'thinking')}
            label={thinkingLabel(thinking)}
          />
          {open === 'thinking' && (
            <ThinkingMenu
              levels={levels}
              current={thinking}
              onPick={(level) => {
                setOpen(null)
                selection.setThinking(level)
              }}
              onClose={() => setOpen(null)}
            />
          )}
        </div>
      )}
      {open === 'model' && (
        <ModelMenu
          models={selection.models}
          isCurrent={(m) => m.id === model?.id && m.provider === model.provider}
          onPick={(m) => {
            setOpen(null)
            selection.choose({ provider: m.provider, id: m.id })
          }}
          onClose={() => setOpen(null)}
          emptyText={selection.hint}
          unavailable={selection.unavailable}
          className="w-[30rem] max-w-[92vw]"
        />
      )}
    </div>
  )
}
