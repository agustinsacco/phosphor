import { CopyButton } from '@/components/CopyButton'
import { TextInput } from '@/components/form'
import type { HostConnectorForm } from './useHostConnectorForm'
type FormProps = { form: HostConnectorForm }
export function CatalogueConnectorFields({ form }: FormProps): React.JSX.Element | null {
  const { entry, choice, setChoice } = form
  if (!entry) return null
  return (
    <>
      <p className="text-text-secondary">{entry.summary}</p>
      {entry.caveat && <p className="text-warning">{entry.caveat}</p>}
      {entry.variants && (
        <label className="block">
          {entry.variants.label}
          <select
            aria-label="Connector variant"
            className="border-border bg-bg mt-1 w-full rounded-md border p-2"
            value={choice.variant ?? entry.variants.options[0]?.id}
            onChange={(e) => setChoice({ ...choice, variant: e.target.value })}
          >
            {entry.variants.options.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {entry.readOnlyUrl && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={choice.readOnly !== false}
            onChange={(e) => setChoice({ ...choice, readOnly: e.target.checked })}
          />
          Use the read-only endpoint
        </label>
      )}
      <ConnectorSetup entry={entry} />
      {entry.authKind === 'preregistered' && (
        <>
          <label className="block">
            Client ID
            <TextInput
              aria-label="Client ID"
              value={choice.clientId ?? ''}
              onChange={(e) => setChoice({ ...choice, clientId: e.target.value })}
              className="mt-1 w-full"
            />
          </label>
          <label className="block">
            Client secret {entry.secretRequired ? '(required)' : '(optional)'}
            <TextInput
              type="password"
              autoComplete="off"
              aria-label="Client secret"
              value={choice.clientSecret ?? ''}
              onChange={(e) => setChoice({ ...choice, clientSecret: e.target.value })}
              className="mt-1 w-full"
            />
          </label>
        </>
      )}
    </>
  )
}

function ConnectorSetup({
  entry,
}: {
  entry: NonNullable<HostConnectorForm['entry']>
}): React.JSX.Element {
  return (
    <>
      {entry.setup && (
        <div className="space-y-2">
          <ol className="text-text-secondary list-inside list-decimal space-y-1">
            {entry.setup.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {entry.setup.snippet && (
            <div>
              <CopyButton
                text={entry.setup.snippet.text}
                title={`Copy ${entry.setup.snippet.label}`}
              />
              <pre className="border-border mt-2 max-h-40 overflow-auto rounded-md border p-2 font-mono text-sm">
                {entry.setup.snippet.text}
              </pre>
            </div>
          )}
        </div>
      )}
    </>
  )
}
export function CustomConnectorFields({
  form,
  label,
}: FormProps & { label: string }): React.JSX.Element {
  const { name, setName, kind, setKind } = form
  return (
    <>
      <label className="block">
        Server name
        <TextInput
          aria-label="Server name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full"
        />
      </label>
      <label className="block">
        Transport
        <select
          aria-label="Connector transport"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          className="border-border bg-bg mt-1 w-full rounded-md border p-2"
        >
          <option value="https">HTTPS server</option>
          <option value="stdio">Command running on {label}</option>
        </select>
      </label>
      <ConnectorTransportFields form={form} />
    </>
  )
}
function ConnectorTransportFields({ form }: FormProps): React.JSX.Element {
  const { kind, endpoint, setEndpoint, secret, setSecret, command, setCommand, args, setArgs } =
    form
  return (
    <>
      {kind === 'https' ? (
        <>
          <label className="block">
            URL on the Host network
            <TextInput
              aria-label="Server URL"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              className="mt-1 w-full"
              placeholder="https://example.com/mcp"
            />
          </label>
          <label className="block">
            Authorization header (optional, never read back)
            <TextInput
              type="password"
              autoComplete="off"
              aria-label="Authorization header"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="mt-1 w-full"
              placeholder="Bearer …"
            />
          </label>
        </>
      ) : (
        <>
          <label className="block">
            Command
            <TextInput
              aria-label="Host command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="mt-1 w-full"
              placeholder="npx"
            />
          </label>
          <label className="block">
            Arguments, one per line
            <textarea
              aria-label="Host command arguments"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              className="border-border bg-bg mt-1 min-h-24 w-full rounded-md border p-2 font-mono"
              placeholder={'-y\n@vendor/mcp-server'}
            />
          </label>
          <p className="text-warning">
            This command runs as the Host user, not inside a sandbox. You must explicitly trust it.
          </p>
        </>
      )}
    </>
  )
}
