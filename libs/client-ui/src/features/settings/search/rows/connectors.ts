import { LOCAL_ONLY, onHost, section, type SettingEntry } from '../settingEntry'

/** MCP Connectors: This Mac's rows, until a view every machine shares renders them. */
export const CONNECTORS_ROWS: SettingEntry[] = [
  ...section(
    'connectors',
    null,
    [
      ['Connected', 'mcp servers'],
      ['Add a connector', 'mcp server oauth url'],
      ['Config files', 'mcp.json'],
    ],
    LOCAL_ONLY,
  ),
]

/** The Host's MCP Connectors panel, by the heading it renders. */
export const CONNECTORS_HOST_HEADING: SettingEntry[] = onHost('connectors', [
  'MCP Connectors',
  'Host mcp servers',
])
