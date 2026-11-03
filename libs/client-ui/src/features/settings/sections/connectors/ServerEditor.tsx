import { useState } from 'react'
import { MCP_EXPOSURES, type McpExposure, type McpScope, type McpServerConfig } from '@shared/mcp'
import { Button, Segmented, Select, TextInput } from '@/components/form'
import {
  scopeHoldsSecrets,
  serverFormEntry,
  serverFormValues,
  type ServerFormValues,
} from './serverForm'

/** What each exposure costs and buys, in the words the editor shows. */
export const EXPOSURE_HINTS: Record<McpExposure, string> = {
  codemode: 'Scripts find and call the tools. Nothing in context until used. (default)',
  deferred: 'Loaded by tool search when needed, then called directly.',
  direct: 'Declared on every request, like a built-in tool. Costs the full schemas.',
  hidden: 'Connected, but its tools are unreachable.',
}

const FIELD = 'border-border bg-surface w-full rounded-md border px-2.5 py-1.5 font-mono'

/**
 * Add or edit one entry in the scope's mcp.json, on every machine. The scope
 * is the page's (Machine or the chosen folder); a folder never takes an
 * Authorization header. Keys this form does not show are kept as they were.
 */
interface ServerEditorProps {
  initial: { name: string; defined: McpServerConfig } | null
  scope: McpScope
  /** Command connectors run as the machine's service user and are confirmed first. */
  reviewed: boolean
  busy: boolean
  onClose: () => void
  /** Resolves true once saved, which closes the editor. */
  onSave: (name: string, config: McpServerConfig) => Promise<boolean>
}

export function ServerEditor(props: ServerEditorProps): React.JSX.Element {
  const { initial, scope, reviewed, busy, onClose, onSave } = props
  const [values, setValues] = useState(() => serverFormValues(initial ?? undefined))
  const [problem, setProblem] = useState<string | null>(null)
  const set = (patch: Partial<typeof values>): void => setValues((v) => ({ ...v, ...patch }))
  const save = async (): Promise<void> => {
    const result = serverFormEntry(values, scope, initial?.defined)
    if ('problem' in result) return setProblem(result.problem)
    setProblem(null)
    if (await onSave(result.name, result.config)) onClose()
  }
  const remote = values.transport === 'https'
  return (
    <div className="border-border bg-bg-secondary/40 mt-4 space-y-2 rounded-lg border p-3">
      <div className="text-lg font-semibold">
        {initial ? `Edit ${initial.name}` : 'Add MCP server'}
      </div>
      <TextInput
        aria-label="Server name"
        autoFocus={!initial}
        value={values.name}
        onChange={(e) => set({ name: e.target.value })}
        disabled={initial !== null}
        placeholder="server name (e.g. linear)"
        className="w-full font-mono"
      />
      <Segmented
        label="Transport"
        value={values.transport}
        options={[
          { value: 'https', label: 'Remote URL' },
          { value: 'stdio', label: 'Local command' },
        ]}
        onChange={(transport) => set({ transport })}
      />
      <TransportFields values={values} set={set} scope={scope} reviewed={reviewed} />
      <div className="flex items-center gap-2 text-base">
        <span className="text-text-secondary">Tools reach the model</span>
        <Select
          label="Exposure"
          value={values.exposure}
          options={MCP_EXPOSURES.map((option) => ({ value: option, label: option }))}
          onChange={(exposure) => set({ exposure })}
          className="py-0.5"
        />
      </div>
      <div className="text-text-tertiary text-sm">{EXPOSURE_HINTS[values.exposure]}</div>
      {problem && (
        <p role="alert" className="text-danger text-sm">
          {problem}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={
            busy || !values.name.trim() || (remote ? !values.url.trim() : !values.command.trim())
          }
        >
          Save
        </Button>
      </div>
    </div>
  )
}

function TransportFields({
  values,
  set,
  scope,
  reviewed,
}: {
  values: ServerFormValues
  set: (patch: Partial<ServerFormValues>) => void
  scope: McpScope
  reviewed: boolean
}): React.JSX.Element {
  return values.transport === 'https' ? (
    <>
      <TextInput
        aria-label="Server URL"
        value={values.url}
        onChange={(e) => set({ url: e.target.value })}
        placeholder="https://mcp.example.com/mcp"
        className="w-full font-mono"
      />
      {scopeHoldsSecrets(scope) && (
        <TextInput
          type="password"
          autoComplete="off"
          aria-label="Authorization header"
          value={values.authorization}
          onChange={(e) => set({ authorization: e.target.value })}
          placeholder="Authorization header (optional, never shown again)"
          className="w-full font-mono"
        />
      )}
    </>
  ) : (
    <>
      <TextInput
        aria-label="Command"
        value={values.command}
        onChange={(e) => set({ command: e.target.value })}
        placeholder="npx"
        className="w-full font-mono"
      />
      <textarea
        aria-label="Arguments"
        value={values.args}
        onChange={(e) => set({ args: e.target.value })}
        placeholder={'Arguments, one per line\n-y\n@vendor/mcp-server'}
        className={`${FIELD} min-h-20`}
      />
      {reviewed && (
        <p className="text-warning text-sm">
          This command runs as the machine’s service user, outside any sandbox. You are asked to
          trust it before it is saved.
        </p>
      )}
    </>
  )
}
