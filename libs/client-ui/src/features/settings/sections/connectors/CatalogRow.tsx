import { useState } from 'react'
import { TooltipButton } from '@/components/Tooltip'
import { Button, Select, TextInput, Toggle } from '@/components/form'
import { CopyButton } from '@/components/CopyButton'
import { ChevronIcon } from '@/components/icons'
import {
  connectorUrl,
  type ConnectorEntry,
  type ConnectorChoice,
  type ConnectorSetup,
} from '@/features/connectors/catalog'

/**
 * A catalog entry that is not configured yet: vetted URL behind one button.
 * Where the scope holds no secrets (a folder), the client secret is not asked
 * for, and an entry that needs one is added at machine scope instead.
 */
export function CatalogRow({
  entry,
  secrets,
  disabled,
  onAdd,
}: {
  entry: ConnectorEntry
  secrets: boolean
  disabled: boolean
  onAdd: (choice: ConnectorChoice) => void
}): React.JSX.Element {
  const [variant, setVariant] = useState(entry.variants?.options[0]?.id ?? '')
  const [readOnly, setReadOnly] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const url = connectorUrl(entry, { variant, readOnly })
  const needsClientId = entry.authKind === 'preregistered'
  // A required client secret cannot live in a folder's file.
  const machineOnly = needsClientId && entry.secretRequired === true && !secrets
  const missingCredential = credentialProblem(entry, machineOnly, clientId, clientSecret)
  const hasOptions = Boolean(entry.variants || entry.readOnlyUrl || needsClientId || entry.setup)

  return (
    <div
      className="border-border bg-surface rounded-xl border"
      data-testid={`connector-${entry.id}`}
    >
      <div className="flex items-start gap-3 px-3.5 pt-3 pb-2.5">
        <CatalogSummary entry={entry} url={url} machineOnly={machineOnly} />
        <Button
          variant="primary"
          size="sm"
          className="shrink-0 whitespace-nowrap"
          // Slack and Google cannot be one click: they support no dynamic
          // registration and need a registered client up front. Showing that as
          // a disabled button beats letting `buildConnectorConfig` throw into
          // the error banner.
          disabled={disabled || Boolean(missingCredential)}
          tooltip={
            missingCredential
              ? { label: 'Add connector', description: missingCredential }
              : undefined
          }
          aria-description={
            machineOnly
              ? missingCredential
              : missingCredential
                ? `${entry.name} has no dynamic registration. Paste the client ${entry.secretRequired ? 'ID and secret' : 'ID'} of an app you registered.`
                : undefined
          }
          onClick={() =>
            onAdd({ variant, readOnly, clientId, ...(secrets ? { clientSecret } : {}) })
          }
        >
          Add
        </Button>
      </div>

      {hasOptions && (
        <CatalogOptions
          entry={entry}
          variant={variant}
          setVariant={setVariant}
          readOnly={readOnly}
          setReadOnly={setReadOnly}
          clientId={clientId}
          setClientId={setClientId}
          clientSecret={secrets ? clientSecret : undefined}
          setClientSecret={setClientSecret}
        />
      )}
    </div>
  )
}

/** Why Add is not available yet, or undefined. */
function credentialProblem(
  entry: ConnectorEntry,
  machineOnly: boolean,
  clientId: string,
  clientSecret: string,
): string | undefined {
  if (entry.authKind !== 'preregistered') return undefined
  if (machineOnly) return 'Switch to Machine scope to add it.'
  if (!clientId.trim()) return 'Paste a client ID first'
  if (entry.secretRequired && !clientSecret.trim()) return 'Paste the client secret too'
  return undefined
}

function CatalogSummary({
  entry,
  url,
  machineOnly,
}: {
  entry: ConnectorEntry
  url: string
  machineOnly: boolean
}): React.JSX.Element {
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate text-lg font-semibold">{entry.name}</div>
      <div className="text-text-secondary mt-0.5 text-base leading-snug">{entry.summary}</div>
      {machineOnly && (
        <div className="text-text-tertiary mt-1 text-sm">Switch to Machine scope to add it.</div>
      )}
      {entry.caveat && (
        <div className="text-text-tertiary mt-1 text-sm leading-snug">{entry.caveat}</div>
      )}
      <div className="text-text-tertiary mt-0.5 truncate font-mono text-sm" data-tooltip={url}>
        {url}
      </div>
    </div>
  )
}

function CatalogOptions({
  entry,
  variant,
  setVariant,
  readOnly,
  setReadOnly,
  clientId,
  setClientId,
  clientSecret,
  setClientSecret,
}: {
  entry: ConnectorEntry
  variant: string
  setVariant: (value: string) => void
  readOnly: boolean
  setReadOnly: (value: boolean) => void
  clientId: string
  setClientId: (value: string) => void
  /** Asked for only where the scope may hold it. */
  clientSecret: string | undefined
  setClientSecret: (value: string) => void
}): React.JSX.Element {
  const needsClientId = entry.authKind === 'preregistered'
  return (
    <div className="border-border text-text-secondary border-t px-3.5 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {entry.variants && (
          <span className="flex items-center gap-1.5">
            {entry.variants.label}
            <Select
              label={entry.variants.label}
              value={variant}
              options={entry.variants.options.map((option) => ({
                value: option.id,
                label: option.label,
              }))}
              onChange={setVariant}
              className="py-0.5"
            />
          </span>
        )}
        {entry.readOnlyUrl && (
          <span className="flex items-center gap-1.5">
            <Toggle label="Read-only" on={readOnly} onChange={setReadOnly} />
            Read-only
          </span>
        )}
        {needsClientId && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <TextInput
              size="sm"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="client ID"
              className="min-w-40 flex-1 font-mono"
            />
            {clientSecret !== undefined && (
              <TextInput
                type="password"
                size="sm"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={entry.secretRequired ? 'client secret' : 'client secret (optional)'}
                className="min-w-48 flex-1 font-mono"
              />
            )}
          </div>
        )}
      </div>
      {entry.setup && <SetupSteps setup={entry.setup} />}
    </div>
  )
}

/**
 * The console work a `preregistered` connector needs before its client id
 * exists. Collapsed by default — it is a one-time errand, and the row above
 * it is what people came for.
 */
function SetupSteps({ setup }: { setup: ConnectorSetup }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-text-tertiary mt-1.5 text-sm first:mt-0">
      <TooltipButton
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="hover:text-text flex items-center gap-1.5"
      >
        <ChevronIcon size={8} expanded={open} />
        Set up the app
      </TooltipButton>
      {open && (
        <ol className="mt-1 ml-4 list-decimal space-y-1">
          {setup.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {open && setup.snippet && (
        <div className="mt-2">
          <div className="flex items-center gap-2">
            <span>{setup.snippet.label}</span>
            <CopyButton size="sm" text={setup.snippet.text} title={`Copy ${setup.snippet.label}`} />
          </div>
          <pre className="border-border bg-bg-secondary mt-1 max-h-48 overflow-auto rounded border p-2 font-mono text-sm">
            {setup.snippet.text}
          </pre>
        </div>
      )}
    </div>
  )
}
