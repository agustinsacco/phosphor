import type { SettingsNoticeProps } from '@/components/form'
import type { ConnectorChoice, ConnectorEntry } from '@/features/connectors/catalog'
import type { ConnectorCheckView } from '@/features/connectors/useConnectorChecks'
import type { ConnectFlow } from '@/stores/connectors'
import type { PiPackageEntry } from '@shared/models'
import type { McpFileState, McpResolvedServer, McpServerConfig, McpServerState } from '@shared/mcp'

/** What one machine can do with its connectors, beyond the list every machine shares. */
export interface ConnectorsCaps {
  /** Per-server tests, tool lists, tool visibility and lane status. */
  inspect: boolean
  /** Replace an existing entry in place. */
  edit: boolean
  /** The raw `mcp.json` editors. */
  rawFiles: boolean
  /** A remote trust boundary: checks and command connectors are confirmed first. */
  reviewed: boolean
}

/** What pi last reported for a connector, if anything. */
export interface ConnectorStatus {
  state?: McpServerState
  tools?: number
  checking?: boolean
  /** The check itself failed, which says nothing about the server. */
  failed?: boolean
}

/** One configured connector, as every machine shows it. */
export interface ConnectorView {
  name: string
  /** The file that defines it. */
  scope: 'global' | 'project'
  /** A machine connector seen from a folder: the folder only switches it on or off. */
  inherited: boolean
  /** The folder's override decides whether it is on. */
  overridden: boolean
  /** A folder definition replaces a machine one with the same name. */
  replacesGlobal?: boolean
  transport: 'https' | 'stdio'
  enabled: boolean
  /** pi signs in with MCP OAuth, so Sign in and Sign out apply. */
  oauth: boolean
  exposure: string
  /** The URL or command. A Host never sends it. */
  endpoint?: string
  entry?: ConnectorEntry
  status: ConnectorStatus
  /** This machine's sign-in in progress. */
  flow?: ConnectFlow
  /** pi's entry and its last inspection, where the machine can inspect. */
  inspection?: { server: McpResolvedServer; check?: ConnectorCheckView }
}

export type ConnectorOp =
  | { type: 'upsert'; name: string; config: McpServerConfig }
  | { type: 'catalogue'; entry: ConnectorEntry; choice: ConnectorChoice }
  | { type: 'enabled'; name: string; enabled: boolean }
  | { type: 'remove' | 'signIn' | 'signOut' | 'test'; name: string }
  | { type: 'checkAll' | 'cancelChecks' }

/** The connector section's data and actions on one machine. */
export interface ConnectorsSource {
  caps: ConnectorsCaps
  /** Writes go to the chosen folder's `.pi/mcp.json`, which holds no secrets. */
  folder: boolean
  /** null until the first read. */
  servers: ConnectorView[] | null
  notices: SettingsNoticeProps[]
  /** The last failed action. */
  error: string | null
  /** Nothing can be written: a legacy or malformed configuration. */
  locked: boolean
  /** Writes, checks or programs are in flight. */
  busy: boolean
  /** Sign in and Sign out can run now. */
  canSignIn: boolean
  checking: boolean
  /** Checks have run long enough to say so. */
  slow: boolean
  /** When the last aggregate check ran. */
  checkedAt?: number
  /** pi-mcp-adapter is still configured here, with what moving off it needs. */
  migration?: { workspacePath?: string; adapters: PiPackageEntry[] }
  /** The two files, for the raw editors (`caps.rawFiles`). */
  files?: { states: McpFileState[]; workspacePath?: string }
  /** The workspace whose active lane the rows report on (`caps.inspect`). */
  laneWorkspace?: string
  /** Resolves true once the change applied; failures land in `error`. */
  run(op: ConnectorOp): Promise<boolean>
  refresh(): Promise<void>
}
