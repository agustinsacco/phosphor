import { TooltipLabel } from '@/components/Tooltip'
import { useState } from 'react'
import clsx from 'clsx'
import {
  MCP_EXPOSURES,
  type McpExposure,
  type McpResolvedServer,
  type McpScope,
  type McpServerConfig,
} from '@shared/mcp'
import { Button, TextInput } from '@/components/form'

/** What each exposure costs and buys, in the words the editor shows. */
export const EXPOSURE_HINTS: Record<McpExposure, string> = {
  codemode: 'Scripts find and call the tools. Nothing in context until used. (default)',
  deferred: 'Loaded by tool search when needed, then called directly.',
  direct: 'Declared on every request, like a built-in tool. Costs the full schemas.',
  hidden: 'Connected, but its tools are unreachable.',
}

/**
 * Add or edit one mcp.json entry. Split out of ConnectorsTab so the tab reads
 * as a list rather than a list plus a form. Keys this form does not show
 * (headers, oauth, env, …) are kept as they were.
 */
export function ServerEditor({
  initial,
  workspacePath,
  onClose,
  onSave,
}: {
  initial: McpResolvedServer | null
  workspacePath?: string
  onClose: () => void
  onSave: (scope: McpScope, name: string, config: McpServerConfig) => void
}): React.JSX.Element {
  const base = initial?.defined
  const [name, setName] = useState(initial?.name ?? '')
  const [kind, setKind] = useState<'url' | 'command'>(base?.command ? 'command' : 'url')
  const [url, setUrl] = useState(base?.url ?? '')
  const [command, setCommand] = useState(
    [base?.command, ...(base?.args ?? [])].filter(Boolean).join(' '),
  )
  const [exposure, setExposure] = useState<McpExposure>(base?.exposure ?? 'codemode')
  const [scope, setScope] = useState<McpScope>(initial?.scope ?? 'global')

  const save = (): void => {
    const config: McpServerConfig = { ...(base ?? {}) }
    delete config.url
    delete config.command
    delete config.args
    if (kind === 'url') {
      config.url = url.trim()
      delete config.env
      delete config.cwd
    } else {
      const [cmd = '', ...args] = command.trim().split(/\s+/)
      config.command = cmd
      if (args.length) config.args = args
      delete config.headers
      delete config.oauth
      delete config.auth
    }
    if (exposure === 'codemode') delete config.exposure
    else config.exposure = exposure
    onSave(scope, name.trim(), config)
  }

  return (
    <div className="border-border bg-bg-secondary/40 mt-4 space-y-2 rounded-lg border p-3">
      <div className="text-lg font-semibold">
        {initial ? `Edit ${initial.name}` : 'Add MCP server'}
      </div>
      <TextInput
        autoFocus={!initial}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={initial !== null}
        placeholder="server name (e.g. linear)"
        className="w-full font-mono"
      />
      <div className="flex items-center gap-3 text-base">
        <TooltipLabel className="flex items-center gap-1">
          <input type="radio" checked={kind === 'url'} onChange={() => setKind('url')} /> Remote URL
        </TooltipLabel>
        <TooltipLabel className="flex items-center gap-1">
          <input type="radio" checked={kind === 'command'} onChange={() => setKind('command')} />{' '}
          Local command
        </TooltipLabel>
      </div>
      {kind === 'url' ? (
        <TextInput
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp.example.com/mcp"
          className="w-full font-mono"
        />
      ) : (
        <TextInput
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="npx some-mcp-server --flag"
          className="w-full font-mono"
        />
      )}
      <label className="flex items-center gap-2 text-base">
        <span className="text-text-secondary">Tools reach the model</span>
        <select
          aria-label="Exposure"
          value={exposure}
          onChange={(e) => setExposure(e.target.value as McpExposure)}
          className="border-border bg-bg-secondary rounded px-1.5 py-0.5"
        >
          {MCP_EXPOSURES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <div className="text-text-tertiary text-sm">
        {EXPOSURE_HINTS[exposure]}
        {initial?.overridden && ' This project overrides it, and the override wins here.'}
      </div>
      {initial === null && (
        <div className="flex items-center gap-3 text-base">
          <TooltipLabel className="flex items-center gap-1">
            <input type="radio" checked={scope === 'global'} onChange={() => setScope('global')} />
            Global (~/.pi/agent/mcp.json)
          </TooltipLabel>
          <TooltipLabel className={clsx('flex items-center gap-1', !workspacePath && 'opacity-50')}>
            <input
              type="radio"
              disabled={!workspacePath}
              checked={scope === 'project'}
              onChange={() => setScope('project')}
            />
            This project (.pi/mcp.json)
          </TooltipLabel>
        </div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={save}
          disabled={!name.trim() || (kind === 'url' ? !url.trim() : !command.trim())}
        >
          Save
        </Button>
      </div>
    </div>
  )
}
