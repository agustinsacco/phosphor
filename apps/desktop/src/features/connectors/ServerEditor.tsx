import { useState } from 'react'
import clsx from 'clsx'
import {
  directToolsText,
  parseDirectToolsText,
  type McpResolvedServer,
  type McpServerConfig,
  type McpWriteScope,
} from '@shared/mcp'
import { Button, TextInput } from '@/components/form'

/**
 * Add or edit one mcp.json entry. Split out of ConnectorsTab so the tab reads
 * as a list rather than a list plus a form.
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
  onSave: (scope: McpWriteScope, name: string, config: McpServerConfig) => void
}): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? '')
  const [kind, setKind] = useState<'url' | 'command'>(initial?.config.command ? 'command' : 'url')
  const [url, setUrl] = useState(initial?.config.url ?? '')
  const [command, setCommand] = useState(
    [initial?.config.command, ...(initial?.config.args ?? [])].filter(Boolean).join(' '),
  )
  // `true` and "search" are adapter forms too; a list-only reading threw on them.
  const [directTools, setDirectTools] = useState(directToolsText(initial?.config.directTools))
  const editableScope: McpWriteScope =
    initial?.scope === 'pi-global' || initial?.scope === 'pi-project' ? initial.scope : 'pi-global'
  const [scope, setScope] = useState<McpWriteScope>(editableScope)

  const save = (): void => {
    const config: McpServerConfig = { ...(initial?.config ?? {}) }
    delete config.url
    delete config.command
    delete config.args
    if (kind === 'url') {
      config.url = url.trim()
    } else {
      const [cmd = '', ...args] = command.trim().split(/\s+/)
      config.command = cmd
      if (args.length) config.args = args
      else delete config.args
    }
    const tools = parseDirectToolsText(directTools)
    if (tools !== undefined) config.directTools = tools
    else delete config.directTools
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
        <label className="flex items-center gap-1">
          <input type="radio" checked={kind === 'url'} onChange={() => setKind('url')} /> Remote URL
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={kind === 'command'} onChange={() => setKind('command')} />{' '}
          Local command
        </label>
      </div>
      {kind === 'url' ? (
        <TextInput
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp.example.com/sse"
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
      <TextInput
        value={directTools}
        onChange={(e) => setDirectTools(e.target.value)}
        placeholder="directTools: tool names, comma-separated, or all (optional)"
        className="w-full font-mono"
      />
      {initial === null && (
        <div className="flex items-center gap-3 text-base">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={scope === 'pi-global'}
              onChange={() => setScope('pi-global')}
            />
            Global (~/.pi/agent)
          </label>
          <label className={clsx('flex items-center gap-1', !workspacePath && 'opacity-50')}>
            <input
              type="radio"
              disabled={!workspacePath}
              checked={scope === 'pi-project'}
              onChange={() => setScope('pi-project')}
            />
            This project (.pi/mcp-adapter.json)
          </label>
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
