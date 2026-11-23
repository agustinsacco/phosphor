import { useState } from 'react'
import type { BrainJob } from '@shared/brain'
import { Button } from '@/components/form'
import { promptChoice } from '@/stores/prompt'
import { useBrain } from './useBrain'
import { brainLaneTitle } from './laneTitle'

export function BrainReadAgain({
  job,
  memories,
  replaceable,
}: {
  job: BrainJob
  memories: number
  replaceable: number
}): React.JSX.Element {
  const saving = useBrain((s) => s.saving)
  const [confirming, setConfirming] = useState(false)
  const read = async (): Promise<void> => {
    setConfirming(true)
    try {
      const kept = memories - replaceable
      const choice = await promptChoice({
        title: `Read “${brainLaneTitle(job.title)}” again?`,
        message:
          `Brain reads the whole lane again. The ${replaceable} memories from the earlier read stay until the new result is saved. Then they are replaced.` +
          (kept > 0 ? ` ${kept} memories that another lane also supports are kept.` : ''),
        choices: [{ value: 'read', label: 'Read again', primary: true }],
      })
      if (choice === 'read') await useBrain.getState().reread(job.id)
    } finally {
      setConfirming(false)
    }
  }
  return (
    <Button
      size="xs"
      tooltip="Read this lane again and replace these memories"
      disabled={saving || confirming}
      onClick={() => {
        void read()
      }}
    >
      Read again
    </Button>
  )
}
