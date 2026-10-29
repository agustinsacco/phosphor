import { spawn, type ChildProcess } from 'node:child_process'
import type { ConnectorAuthState } from '@shared/models'
import {
  isMcpExposure,
  type McpExposure,
  type McpListResult,
  type McpServerReport,
  type McpServerState,
} from '@shared/mcp'
import { log } from '../debug-log'

/**
 * pi's own MCP commands: `pi mcp list --json`, `pi mcp login <server>` and
 * `pi mcp logout <server>`. They read the same files a session does and keep
 * credentials where a session finds them, so Settings works with no session
 * open and never holds a token.
 *
 * stdin is `ignore`, never a pipe: pi then knows it is not on a terminal, so a
 * login waits for the browser's loopback callback instead of asking for a
 * pasted URL, and nothing can sit waiting for an EOF (see print-mode.ts).
 */

export interface PiCli {
  binaryPath: string
  prefixArgs?: string[]
  /** pi's cwd — decides whether a project `.pi/mcp.json` applies. */
  cwd: string
  env?: Record<string, string>
  /** `pi --version`: decides whether a capability learned from this pi still holds. */
  version?: string
}

function spawnPi(cli: PiCli, args: string[]): ChildProcess {
  return spawn(cli.binaryPath, [...(cli.prefixArgs ?? []), 'mcp', ...args], {
    cwd: cli.cwd,
    ...(cli.env ? { env: cli.env } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Run one command to completion, killed after `timeoutMs`. */
function run(
  cli: PiCli,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child: ChildProcess
    try {
      child = spawnPi(cli, args)
    } catch (error) {
      resolve({
        code: null,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, error: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

const STATES = new Set<McpServerState>([
  'connected',
  'needs-auth',
  'failed',
  'disconnected',
  'connecting',
  'closed',
  'disabled',
])

function toolExposure(value: unknown): { toolExposure?: Record<string, McpExposure> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value).filter((entry): entry is [string, McpExposure] =>
    isMcpExposure(entry[1]),
  )
  return entries.length ? { toolExposure: Object.fromEntries(entries) } : {}
}

function lastLine(text: string): string {
  return text.trim().split('\n').filter(Boolean).pop() ?? ''
}

/**
 * Parse `pi mcp list --json`. Untrusted subprocess output: an entry that does
 * not look right is dropped, and a missing document is a failure with pi's
 * own words, never an empty list that reads as "nothing configured".
 */
export function parseMcpList(stdout: string, stderr: string): McpListResult {
  const start = stdout.indexOf('{')
  let parsed: unknown
  try {
    parsed = JSON.parse(start >= 0 ? stdout.slice(start) : '')
  } catch {
    return {
      ok: false,
      message: lastLine(stderr) || lastLine(stdout) || 'pi mcp list printed nothing.',
    }
  }
  const doc = parsed as { servers?: unknown; errors?: unknown; note?: unknown }
  if (!Array.isArray(doc.servers))
    return { ok: false, message: 'pi mcp list answered without servers.' }
  const servers: McpServerReport[] = []
  for (const raw of doc.servers) {
    const s = raw as Record<string, unknown>
    if (typeof s?.name !== 'string') continue
    servers.push({
      name: s.name,
      scope: typeof s.scope === 'string' ? s.scope : 'global',
      source: typeof s.source === 'string' ? s.source : '',
      ...(typeof s.override === 'string' ? { override: s.override } : {}),
      enabled: s.enabled !== false,
      exposure: typeof s.exposure === 'string' ? s.exposure : 'codemode',
      transport: typeof s.transport === 'string' ? s.transport : '',
      state: STATES.has(s.state as McpServerState) ? (s.state as McpServerState) : 'failed',
      tools: Array.isArray(s.tools)
        ? s.tools.filter((t): t is string => typeof t === 'string')
        : [],
      ...toolExposure(s.toolExposure),
      ...(typeof s.error === 'string' ? { error: s.error } : {}),
    })
  }
  return {
    ok: true,
    servers,
    errors: Array.isArray(doc.errors)
      ? doc.errors.filter((e): e is string => typeof e === 'string')
      : [],
    ...(typeof doc.note === 'string' ? { note: doc.note } : {}),
  }
}

/** Connect every enabled server once and report. pi exits 1 when any is down; that is not a failure here. */
export async function listMcpServers(cli: PiCli, timeoutMs = 90_000): Promise<McpListResult> {
  const result = await run(cli, ['list', '--json'], timeoutMs)
  if (result.error) return { ok: false, message: result.error }
  return parseMcpList(result.stdout, result.stderr)
}

/** `pi mcp logout`: delete the server's stored OAuth credentials. */
export async function logoutMcpServer(
  cli: PiCli,
  serverName: string,
): Promise<{ ok: boolean; message: string }> {
  const result = await run(cli, ['logout', serverName], 30_000)
  return {
    ok: result.code === 0,
    message: result.error ?? (lastLine(result.stdout) || lastLine(result.stderr)),
  }
}

/** How long pi waits for the browser before it gives up, seconds. */
const LOGIN_TIMEOUT_SECONDS = 300

const logins = new Map<string, ChildProcess>()

/**
 * Sign in to one server: pi prints the authorization URL, opens the browser
 * itself and waits for the callback. Every step is reported through
 * `onState`; the promise resolves when the process is gone.
 */
export function loginMcpServer(
  cli: PiCli,
  serverName: string,
  onState: (state: ConnectorAuthState) => void,
): Promise<void> {
  cancelMcpLogin(serverName)
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawnPi(cli, ['login', serverName, '--timeout', String(LOGIN_TIMEOUT_SECONDS)])
    } catch (error) {
      onState({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
      resolve()
      return
    }
    logins.set(serverName, child)
    onState({ phase: 'starting' })

    let stdout = ''
    let stderr = ''
    let announced = false
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (announced) return
      const url = /^https?:\/\/\S+$/m.exec(stdout)?.[0]
      if (url) {
        announced = true
        onState({ phase: 'awaiting-browser', authorizationUrl: url })
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))

    const settle = (state: ConnectorAuthState | null): void => {
      if (logins.get(serverName) === child) logins.delete(serverName)
      if (state) onState(state)
      resolve()
    }
    child.on('error', (error) => settle({ phase: 'failed', message: error.message }))
    child.on('close', (code, signal) => {
      // A cancel kills the process, and the UI has already dropped the flow.
      if (signal) return settle(null)
      if (code === 0) return settle({ phase: 'connected' })
      log('connectors', 'pi mcp login failed', { serverName, code, stderr })
      settle({
        phase: 'failed',
        message: lastLine(stderr) || `pi mcp login exited with ${String(code)}.`,
      })
    })
  })
}

/** Abandon a sign-in. pi's loopback listener goes with the process. */
export function cancelMcpLogin(serverName: string): void {
  logins.get(serverName)?.kill()
  logins.delete(serverName)
}

/** Kill every sign-in in flight (app quit). */
export function disposeMcpLogins(): void {
  for (const serverName of [...logins.keys()]) cancelMcpLogin(serverName)
}
