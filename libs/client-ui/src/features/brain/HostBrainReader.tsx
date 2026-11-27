import { useEffect, useState } from 'react'
import { parseMachineModelList, type MachineModel } from '@shared/host-protocol-machine'
import { Button, Row } from '@/components/form'
import type { ReadyBrainSurface } from './useHostBrain'

/** The selected Host's live catalogue only; never the device catalogue or config fallback. */
export function HostBrainReader({
  brain,
  hostId,
  model,
  disabled,
  save,
}: {
  brain: ReadyBrainSurface
  hostId: string
  model: string | null
  disabled: boolean
  save: (model: string | null) => void
}) {
  const [models, setModels] = useState<MachineModel[]>()
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const { capture } = brain
  useEffect(() => {
    const scoped = capture()
    let mounted = true
    const current = () => mounted && scoped()
    const failed = () => {
      if (current()) {
        setModels(undefined)
        setError(true)
      }
    }
    void window.phosphor.invoke('hosts:models', hostId).then((reply) => {
      if (!current()) return
      const catalogue = parseMachineModelList(reply)
      if (!catalogue || catalogue.source) return failed()
      setModels(catalogue.models)
      setError(false)
    }, failed)
    return () => {
      mounted = false
    }
  }, [hostId, capture, retry])
  const value = model ?? ''
  const listed = models?.some((m) => `${m.provider}/${m.id}` === value)
  return (
    <Row
      title="Model that reads lanes"
      description="This Host sends scrubbed excerpts to the selected reader’s provider."
    >
      <select
        aria-label="Model that reads lanes"
        value={value}
        disabled={disabled || !models}
        onChange={(e) => save(e.target.value || null)}
      >
        <option value="">Each lane’s own model</option>
        {!!value && !listed && (
          <option value={value} disabled>
            Configured reader (not listed)
          </option>
        )}
        {models?.map((model) => (
          <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
            {model.name} · {model.provider}
          </option>
        ))}
      </select>
      {error && (
        <Button size="xs" onClick={() => setRetry((n) => n + 1)}>
          Retry reader list
        </Button>
      )}
    </Row>
  )
}
