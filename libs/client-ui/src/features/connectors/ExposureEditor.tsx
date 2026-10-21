import { useEffect, useRef, useState } from 'react'
import { MCP_EXPOSURES, isMcpExposure, type McpExposure, type McpResolvedServer } from '@shared/mcp'
import { errorText } from '@shared/errors'
import { Button } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'

export function parseExposureRules(text: string): Record<string, McpExposure> {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Rules must be a JSON object.')
  const entries = Object.entries(value)
  if (
    entries.length > 2000 ||
    entries.some(([name, exposure]) => !name || !isMcpExposure(exposure))
  )
    throw new Error('Each tool name or pattern must map to codemode, deferred, direct or hidden.')
  return Object.fromEntries(entries) as Record<string, McpExposure>
}

export function useToolVisibility(
  server: McpResolvedServer,
  workspacePath: string | undefined,
  onSaved: () => void | Promise<void>,
) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const savedRules = useRef(server.config.toolExposure)
  useEffect(() => {
    savedRules.current = server.config.toolExposure
  }, [server.config.toolExposure])
  const update = async (name: string, exposure: McpExposure | 'inherit') => {
    setSaving(true)
    setError(undefined)
    const rules = { ...savedRules.current }
    if (exposure === 'inherit') delete rules[name]
    else rules[name] = exposure
    try {
      await window.phosphor.invoke(
        'mcp:setExposure',
        server.overridden ? 'project' : server.scope,
        workspacePath,
        server.name,
        server.config.exposure ?? 'codemode',
        rules,
      )
      savedRules.current = rules
      await onSaved()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }
  return { saving, error, update }
}

/** Changes only visibility fields in the defining file, or the existing project override. */
export function ExposureEditor({
  server,
  workspacePath,
  onSaved,
}: {
  server: McpResolvedServer
  workspacePath?: string
  onSaved: () => void | Promise<void>
}): React.JSX.Element {
  const [exposure, setExposure] = useState(server.config.exposure ?? 'codemode')
  const [rules, setRules] = useState(JSON.stringify(server.config.toolExposure ?? {}, null, 2))
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    setError(undefined)
    try {
      await window.phosphor.invoke(
        'mcp:setExposure',
        server.overridden ? 'project' : server.scope,
        workspacePath,
        server.name,
        exposure,
        parseExposureRules(rules),
      )
      await onSaved()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <details className="border-border border-t px-3.5 py-2 text-sm">
      <TooltipSummary className="cursor-pointer">Tool visibility</TooltipSummary>
      <label className="mt-2 flex items-center gap-2">
        Server default
        <select
          aria-label="Server tool exposure"
          value={exposure}
          onChange={(event) => setExposure(event.target.value as McpExposure)}
        >
          {MCP_EXPOSURES.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>
      <p className="text-text-tertiary my-2">
        Per-tool rules use exact names or * patterns. Exact names win; otherwise the first matching
        pattern wins. Direct tools cost context on every request.
      </p>
      <textarea
        aria-label="Per-tool exposure rules"
        className="border-border bg-bg-secondary w-full rounded border p-2 font-mono"
        rows={4}
        value={rules}
        onChange={(event) => setRules(event.target.value)}
      />
      <p className="text-text-tertiary">
        Example: {'{"get_*":"direct","delete_*":"hidden"}'}. Changes apply to running lanes before
        their next turn.
      </p>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <Button size="sm" disabled={saving} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save visibility'}
      </Button>
    </details>
  )
}
