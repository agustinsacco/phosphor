import { useCallback, useEffect, useState } from 'react'
import type { BrainHistory } from '@shared/brain'
import { useBrain } from './useBrain'
import { useBrainResource } from './useBrainResource'

/** Keep rows while refreshing: a review becoming a read must not lose its selection. */
export function useBrainHistory() {
  const inbox = useBrain((s) => JSON.stringify(s.status?.jobs))
  const load = useCallback(
    async () => ({ value: await window.phosphor.invoke('brain:history', 200), inbox }),
    [inbox],
  )
  const resource = useBrainResource(load)
  const data = resource.data?.inbox === inbox ? resource.data.value : null
  const [previous, setPrevious] = useState<BrainHistory | null>(null)
  useEffect(() => {
    if (data) setPrevious(data)
  }, [data])
  return { ...resource, data, history: data ?? previous }
}
