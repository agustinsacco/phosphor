import type { McpScope, McpServerConfig } from './mcp'

/**
 * What any machine may write into pi's MCP files, from Settings on This Mac or
 * through a Host's `mcp.upsert`. Applied on write only: pi's own rules
 * (`serverProblem`) still decide what an existing file loads, so a hand-written
 * entry this policy refuses keeps working.
 */

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/**
 * Why a connector URL may not be written, or null. It must be https, or http to
 * this machine's loopback (a local server or an OAuth callback), and must not
 * carry credentials in its userinfo.
 */
export function mcpUrlProblem(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'The connector URL is not valid.'
  }
  if (parsed.username || parsed.password)
    return 'The connector URL must use https and must not contain a user name or password.'
  if (
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && LOOPBACK_HOSTS.includes(parsed.hostname))
  )
    return null
  return 'The connector URL must use https (plain http only for localhost).'
}

/**
 * Why a connector may not be written to this scope, or null. A folder's
 * `.pi/mcp.json` lives in the repository and is often committed, so it holds
 * no headers, environment values or OAuth client secret: those go in a machine
 * connector, which the folder can then switch on or off.
 */
export function mcpSecretProblem(
  config: Pick<McpServerConfig, 'headers' | 'env' | 'oauth'>,
  scope: McpScope,
): string | null {
  if (scope !== 'project') return null
  if (
    config.headers !== undefined ||
    config.env !== undefined ||
    config.oauth?.clientSecret !== undefined
  )
    return 'A folder connector cannot hold headers, environment values or a client secret. Add it as a machine connector and switch it on in this folder.'
  return null
}

/** Every write rule for one connector entry, or null when it may be written. */
export function mcpWriteProblem(config: McpServerConfig, scope: McpScope): string | null {
  const urls = [config.url, config.oauth?.callbackUrl, config.oauth?.authServerMetadataUrl]
  for (const url of urls) {
    const problem = typeof url === 'string' ? mcpUrlProblem(url) : null
    if (problem) return problem
  }
  return mcpSecretProblem(config, scope)
}
