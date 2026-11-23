import { lazy, Suspense, useState } from 'react'
import { Button, Row } from '@/components/form'
import { machineRecord } from '@phosphor/shared/host-protocol-machine'
import { runAgentOp } from '@/features/agent-control/agentOps'
import { useHostSection } from '../../machine/HostSection'
import type { ConfigFileSource } from '../../ConfigFileEditor'
const Editor = lazy(() =>
  import('../../ConfigFileEditor').then((m) => ({ default: m.ConfigFileEditor })),
)

/** The daemon exposes reviewed behavior fields, not the whole settings file. */
function reviewedFile(
  hostId: string,
  label: string,
  refresh: () => Promise<void>,
): ConfigFileSource {
  return {
    key: `${hostId}/settings.json`,
    fallback: '{}',
    read: async () => {
      const { data } = await runAgentOp(hostId, 'config.read', { file: 'settings' })
      if (!machineRecord(data) || typeof data.content !== 'string')
        throw Error('Unreadable settings.')
      return { path: `${label} · Reviewed settings`, content: data.content }
    },
    write: async (content) => {
      await runAgentOp(hostId, 'config.write', { file: 'settings', content })
      await refresh()
    },
  }
}
export function ReviewedSettings({ blocked }: { blocked: boolean }) {
  const { machine, connection, repositoryId, settings } = useHostSection()
  const [editing, setEditing] = useState(false)
  if (
    repositoryId ||
    !connection?.configFiles ||
    !connection.ops ||
    !connection.capabilities.includes('sessions.control')
  )
    return null
  return (
    <Row
      title="Reviewed settings"
      description="Edit machine-wide agent behavior as JSON. Settings not shown here stay on disk."
    >
      <Button size="sm" disabled={blocked} onClick={() => setEditing(true)}>
        Edit reviewed JSON
      </Button>
      {editing && (
        <Suspense fallback={null}>
          <Editor
            source={reviewedFile(machine.id, machine.label, settings.refresh)}
            onClose={() => setEditing(false)}
          />
        </Suspense>
      )}
    </Row>
  )
}
