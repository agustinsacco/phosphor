import { useEffect, useState } from 'react'
import type { McpScope } from '@shared/mcp'
import { MonacoEditor } from '@/features/files/MonacoEditor'
import { ModalOverlay } from '@/components/Modal'
import { Button } from '@/components/form'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { errorText } from '@shared/errors'

/**
 * Nested modal for editing a raw JSON config file.
 *
 * Rendered above the settings modal, so it relies on ModalOverlay's
 * depth-aware Escape handling: Escape closes only this editor, leaving the
 * settings modal (and any unsaved JSON) alone.
 *
 * The file itself is injected as a `ConfigFileSource` — pi's own settings and
 * the MCP chain's per-scope files differ only in which IPC pair reads and
 * writes them, and used to have a copy of this editor each.
 */
export interface ConfigFileSource {
  /** Monaco keys its model (and undo stack) on this; keep it unique per file. */
  key: string
  /** Seed for a file that does not exist yet. */
  fallback: string
  read: () => Promise<{ path: string; content: string }>
  write: (content: string) => Promise<void>
  /** Toast to raise after a successful write; omit for none. */
  savedToast?: string
}

/** One of pi's own config files (`~/.pi/agent`). */
export function piConfigFile(name: 'settings' | 'models' | 'web-search'): ConfigFileSource {
  return {
    key: `${name}.json`,
    fallback: '{\n}\n',
    read: () => window.phosphor.invoke('pi:readConfigFile', name),
    write: (content) => window.phosphor.invoke('pi:writeConfigFile', name, content),
    savedToast: `${name}.json saved — restart sessions to apply`,
  }
}

/** One `mcp.json` in the adapter's resolution chain. */
export function mcpConfigFile(scope: McpScope, workspacePath?: string): ConfigFileSource {
  return {
    // The workspace is part of the file's identity for project scopes, and the
    // key is what makes the editor re-read when either half changes.
    key: `mcp-${scope}${workspacePath ? `-${workspacePath}` : ''}.json`,
    fallback: '{\n  "mcpServers": {}\n}\n',
    read: () => window.phosphor.invoke('mcp:readFile', scope, workspacePath),
    write: (content) => window.phosphor.invoke('mcp:writeFile', scope, workspacePath, content),
  }
}

export function ConfigFileEditor({
  source,
  onClose,
}: {
  source: ConfigFileSource
  onClose: () => void
}): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Keyed on the file, not the descriptor: callers build `source` inline on
  // every render, so depending on the object itself would re-read in a loop.
  useEffect(() => {
    void source.read().then((file) => {
      setContent(file.content || source.fallback)
      setPath(file.path)
    })
  }, [source.key])

  const save = async (): Promise<void> => {
    if (content === null) return
    setError(null)
    try {
      await source.write(content)
      if (source.savedToast) useExtensionUiStore.getState().pushToast(source.savedToast, 'info')
      onClose()
    } catch (err) {
      setError(`Invalid JSON: ${errorText(err)}`)
    }
  }

  return (
    <ModalOverlay onClose={onClose} backdrop="strong" z={50}>
      <div className="border-border bg-bg flex h-[70vh] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-xl border shadow-2xl">
        <div className="border-border flex items-center gap-2 border-b px-4 py-2.5">
          <span className="flex-1 truncate font-mono text-base">{path}</span>
          {error && <span className="text-danger text-sm">{error}</span>}
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void save()}>
            Save
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          {content !== null && (
            <MonacoEditor
              path={`pi-config://${source.key}`}
              language="json"
              value={content}
              onChange={setContent}
              onSave={() => void save()}
            />
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
