import {
  CONNECTORS,
  buildConnectorConfig,
  type ConnectorChoice,
} from '@/features/connectors/catalog'
import type { McpServerConfig } from '@shared/mcp'
import { MCP_SERVER_NAME } from '@shared/mcp'
import { useState } from 'react'
export function useHostConnectorForm(
  onSave: (name: string, config: McpServerConfig) => Promise<void>,
) {
  const [entryId, setEntryId] = useState(CONNECTORS[0]?.id ?? 'custom')
  const [choice, setChoice] = useState<ConnectorChoice>({ readOnly: true })
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'https' | 'stdio'>('https')
  const [endpoint, setEndpoint] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const entry = CONNECTORS.find((e) => e.id === entryId)
  const save = async () => {
    setError(null)
    try {
      const serverName = entry?.serverName ?? name.trim()
      if (!serverName || serverName.length > 64 || !MCP_SERVER_NAME.test(serverName))
        throw new Error('Use a server name with letters, numbers, underscores or hyphens.')
      let config: McpServerConfig
      if (entry) config = buildConnectorConfig(entry, choice)
      else if (kind === 'https') {
        const url = new URL(endpoint.trim())
        if (
          url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        )
          throw new Error('Use HTTPS, or an HTTP loopback server running on the Host.')
        if (url.username || url.password)
          throw new Error(
            'Do not embed credentials in the URL. Use the one-time Authorization field.',
          )
        config = {
          url: url.href,
          ...(secret.trim() ? { headers: { Authorization: secret.trim() } } : {}),
        }
      } else {
        if (!command.trim() || /[\n\r\0]/.test(command))
          throw new Error(
            'Enter one command name or Host executable path. Arguments go below, one per line.',
          )
        config = { command: command.trim(), args: args.split('\n').filter(Boolean) }
      }
      await onSave(serverName, config)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add connector.')
    }
  }
  return {
    entryId,
    setEntryId,
    choice,
    setChoice,
    name,
    setName,
    kind,
    setKind,
    endpoint,
    setEndpoint,
    command,
    setCommand,
    args,
    setArgs,
    secret,
    setSecret,
    error,
    entry,
    save,
  }
}
export type HostConnectorForm = ReturnType<typeof useHostConnectorForm>
