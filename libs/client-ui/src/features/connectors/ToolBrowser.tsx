import { useState } from 'react'
import type { McpToolDetail } from '@shared/mcp-inspection'
import { TextInput } from '@/components/form'
import { MCP_EXPOSURES, type McpExposure } from '@shared/mcp'

export function ToolBrowser({
  tools,
  rules,
  onExposure,
  saving,
}: {
  tools: McpToolDetail[]
  rules?: Record<string, McpExposure>
  onExposure?: (name: string, exposure: McpExposure | 'inherit') => void
  saving?: boolean
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = tools.filter((tool) =>
    `${tool.name}\n${tool.description ?? ''}`.toLowerCase().includes(needle),
  )
  return (
    <div className="border-border border-t px-3.5 py-2.5">
      <TextInput
        size="sm"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Search ${tools.length} tools by name or description`}
        className="mb-2 w-full"
      />
      <ul className="max-h-80 overflow-y-auto">
        {shown.map((tool) => (
          <li key={tool.name} className="border-border border-b py-2 last:border-0">
            <div className="flex flex-wrap gap-2">
              <span className="text-text font-mono text-sm break-all">{tool.name}</span>
              <span className="text-text-tertiary text-xs">{tool.exposure}</span>
              {onExposure && (
                <select
                  aria-label={`Exposure for ${tool.name}`}
                  disabled={saving}
                  value={rules?.[tool.name] ?? 'inherit'}
                  onChange={(event) =>
                    onExposure(tool.name, event.target.value as McpExposure | 'inherit')
                  }
                >
                  <option value="inherit">Inherit rules</option>
                  {MCP_EXPOSURES.map((exposure) => (
                    <option key={exposure}>{exposure}</option>
                  ))}
                </select>
              )}
            </div>
            <p className="text-text-secondary mt-1 text-sm whitespace-pre-wrap break-words">
              {tool.description || 'No description provided by this server.'}
            </p>
          </li>
        ))}
        {!shown.length && (
          <li className="text-text-tertiary text-sm">
            {tools.length
              ? 'No matching tools.'
              : 'No tools discovered yet. Test this connector to discover its tools.'}
          </li>
        )}
      </ul>
    </div>
  )
}
