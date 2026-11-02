import { LOCAL_ONLY, section, type SettingEntry } from '../settingEntry'

/** MCP Connectors, on every machine; the raw files only where they exist (This Mac). */
export const CONNECTORS_ROWS: SettingEntry[] = [
  ...section('connectors', null, [
    ['Connected', 'mcp servers sign in sign out enabled remove'],
    ['Add a connector', 'mcp server oauth url catalogue custom authorization'],
  ]),
  ...section('connectors', null, [['Config files', 'mcp.json']], LOCAL_ONLY),
]
