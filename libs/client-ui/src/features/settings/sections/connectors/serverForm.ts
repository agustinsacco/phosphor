import { MCP_SERVER_NAME, type McpExposure, type McpScope, type McpServerConfig } from '@shared/mcp'
import { mcpSecretProblem, mcpWriteProblem } from '@shared/mcp-write-policy'

/**
 * The custom connector form's values and the one entry they make, on every
 * machine. The write policy is checked here first so a refusal reads as a
 * form error, not a failed save.
 */
export interface ServerFormValues {
  name: string
  transport: 'https' | 'stdio'
  url: string
  /** A new Authorization header. Empty keeps the entry's existing headers. */
  authorization: string
  command: string
  /** One argument per line, so an argument may hold spaces. */
  args: string
  exposure: McpExposure
}

/** The form's starting values: blank, or the entry being edited as its own file has it. */
export function serverFormValues(initial?: {
  name: string
  defined: McpServerConfig
}): ServerFormValues {
  const base = initial?.defined
  return {
    name: initial?.name ?? '',
    transport: base?.command ? 'stdio' : 'https',
    url: base?.url ?? '',
    authorization: '',
    command: base?.command ?? '',
    args: (base?.args ?? []).join('\n'),
    exposure: base?.exposure ?? 'codemode',
  }
}

/** Whether this scope may hold an Authorization header, client secret or environment. */
export function scopeHoldsSecrets(scope: McpScope): boolean {
  return mcpSecretProblem({ headers: {} }, scope) === null
}

/**
 * The entry to write for these values, or why not. Keys the form does not show
 * (oauth, env, toolExposure, …) are kept from `base`, except those the other
 * transport cannot use.
 */
export function serverFormEntry(
  values: ServerFormValues,
  scope: McpScope,
  base: McpServerConfig = {},
): { name: string; config: McpServerConfig } | { problem: string } {
  const name = values.name.trim()
  if (!name || name.length > 64 || !MCP_SERVER_NAME.test(name))
    return { problem: 'Use a server name with letters, numbers, underscores or hyphens.' }
  const config: McpServerConfig = { ...base }
  delete config.url
  delete config.command
  delete config.args
  if (values.transport === 'https') {
    if (!values.url.trim()) return { problem: 'Enter the server URL.' }
    config.url = values.url.trim()
    delete config.env
    delete config.cwd
    const authorization = values.authorization.trim()
    if (authorization) config.headers = { ...config.headers, Authorization: authorization }
  } else {
    const command = values.command.trim()
    if (!command || /[\n\r\0]/.test(command))
      return { problem: 'Enter one command or executable path. Arguments go below, one per line.' }
    config.command = command
    const args = values.args.split(/\r?\n/).filter((arg) => arg.trim() !== '')
    if (args.length) config.args = args
    delete config.headers
    delete config.oauth
    delete config.auth
  }
  if (values.exposure === 'codemode') delete config.exposure
  else config.exposure = values.exposure
  const problem = mcpWriteProblem(config, scope)
  return problem ? { problem } : { name, config }
}
