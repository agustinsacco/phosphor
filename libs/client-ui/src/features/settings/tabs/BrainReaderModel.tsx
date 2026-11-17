import { useEffect, useState } from 'react'
import { Row } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { ModelChip } from '@/features/chat/composer/ModelChip'
import { ModelMenu } from '@/features/chat/composer/ModelMenu'
import {
  catalogueEmptyText,
  recordedModelName,
  useModelCatalogueStore,
} from '@/stores/modelCatalogue'

export function BrainReaderModel({
  model,
  saving,
  onChange,
}: {
  model: string | null
  saving: boolean
  onChange: (model: string | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { models, status, source, providers } = useModelCatalogueStore()
  useEffect(() => {
    void useModelCatalogueStore.getState().hydrate()
  }, [])
  return (
    <Row
      title="Model that reads lanes"
      description="Brain reads every queued lane with this model. A lane already started keeps the model it started with."
    >
      <div className="flex min-w-0 items-center gap-2">
        <ModelChip
          testId="brain-reader-model"
          name={model ? recordedModelName(models, model, model) : "Each lane's own model"}
          title={model ?? "Each lane's own model"}
          active={open}
          disabled={saving}
          onClick={() => {
            setOpen(true)
            void useModelCatalogueStore.getState().hydrate()
          }}
        />
        {model !== null && (
          <TooltipButton
            className="text-text-secondary hover:text-text shrink-0 text-sm"
            disabled={saving}
            onClick={() => onChange(null)}
          >
            Use each lane's own model
          </TooltipButton>
        )}
        {open && (
          <ModelMenu
            models={models.map(({ id, name, provider, reasoning, contextWindow, input }) => ({
              id,
              name,
              provider,
              reasoning,
              contextWindow,
              input,
            }))}
            isCurrent={(entry) => `${entry.provider}/${entry.id}` === model}
            onPick={(entry) => {
              setOpen(false)
              onChange(`${entry.provider}/${entry.id}`)
            }}
            onClose={() => setOpen(false)}
            loading={status === 'idle' || status === 'loading'}
            emptyText={catalogueEmptyText(status, providers)}
            notice={
              source === 'config'
                ? 'Showing only models.json. Reopen to retry the catalogue.'
                : undefined
            }
            className="w-[30rem] max-w-[92vw]"
          />
        )}
      </div>
    </Row>
  )
}
