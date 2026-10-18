import { Button } from '@/components/form'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { CONNECTORS } from '@/features/connectors/catalog'
import type { McpServerConfig } from '@shared/mcp'
import { CatalogueConnectorFields, CustomConnectorFields } from './HostConnectorFields'
import { useHostConnectorForm } from './useHostConnectorForm'
export function AddHostConnector({
  label,
  busy,
  onClose,
  onSave,
}: {
  label: string
  busy: boolean
  onClose(): void
  onSave(name: string, config: McpServerConfig): Promise<void>
}): React.JSX.Element {
  const form = useHostConnectorForm(onSave)
  const { entryId, setEntryId, setChoice, setSecret, entry, error, save } = form
  return (
    <ModalOverlay
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={`Add connector on ${label}`}>
        <ModalPanel
          width={620}
          title={`Add connector on ${label}`}
          footer={
            <>
              <Button disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Review and add'}
              </Button>
            </>
          }
        >
          <div className="max-h-[65vh] space-y-4 overflow-y-auto p-5 text-base">
            <label className="block">
              Connector
              <select
                aria-label="Connector catalogue"
                className="border-border bg-bg mt-1 w-full rounded-md border p-2"
                value={entryId}
                onChange={(e) => {
                  setEntryId(e.target.value)
                  setChoice({ readOnly: true })
                  setSecret('')
                }}
              >
                {CONNECTORS.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
                <option value="custom">Custom server</option>
              </select>
            </label>
            {entry ? (
              <CatalogueConnectorFields form={form} />
            ) : (
              <CustomConnectorFields form={form} label={label} />
            )}
            {error && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
            <p className="text-text-tertiary text-sm">
              Nothing is copied to another machine. This form does not display stored credentials or
              write to the control plane.
            </p>
          </div>
        </ModalPanel>
      </div>
    </ModalOverlay>
  )
}
