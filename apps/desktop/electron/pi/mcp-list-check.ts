import { isMcpExposure, type McpListResult } from '@shared/mcp'
import type { McpToolDetail } from '@shared/mcp-inspection'
import type { InspectionResult, McpInspectorCli } from '@phosphor/session-runtime/pi/mcp-inspection'

type Cli = McpInspectorCli & { version?: string }
type Inspect = (cli: Cli, name: string, signal: AbortSignal) => Promise<InspectionResult>
type List = (cli: Cli, signal: AbortSignal) => Promise<McpListResult>

const CANCELLED: InspectionResult = { ok: false, message: 'Check cancelled.' }

/** One server of `pi mcp list --json` as an inspection report. The list names tools without descriptions. */
export function inspectionFromList(list: McpListResult, name: string): InspectionResult {
  // A failed list's message can quote pi's stderr, which may hold a secret.
  if (!list.ok) return { ok: false, message: 'pi could not report connector status. Test again.' }
  const server = list.servers.find((item) => item.name === name)
  if (!server) return { ok: false, message: 'pi did not report this connector. Test again.' }
  const fallback = isMcpExposure(server.exposure) ? server.exposure : 'codemode'
  const tools: McpToolDetail[] = [...new Set(server.tools)]
    .filter((tool) => tool && tool.length <= 256)
    .slice(0, 2000)
    .map((tool) => ({ name: tool, exposure: server.toolExposure?.[tool] ?? fallback }))
  return {
    ok: true,
    report: {
      name,
      state: server.state,
      tools,
      ...(server.error ? { error: server.error.slice(0, 2000) } : {}),
    },
  }
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const abort = () => resolve(null)
    signal.addEventListener('abort', abort, { once: true })
    void work.then((value) => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    })
  })
}

/**
 * Prefers `pi mcp inspect` (one server, with tool descriptions). No pi release
 * ships it yet (1.4.0 does not), so a pi that refuses it is remembered per binary
 * and version, and its checks share one `pi mcp list --json` run per scope
 * instead of starting one per connector card.
 */
export class NativeMcpCheck {
  private readonly support = new Map<string, Promise<boolean | undefined>>()
  private readonly lists = new Map<string, Promise<McpListResult>>()
  private readonly stop = new AbortController()

  constructor(
    private readonly inspect: Inspect,
    private readonly list: List,
  ) {}

  /** `scope` must change with any config pi reads, so no check reuses a list of older config. */
  async check(
    cli: Cli,
    scope: string,
    name: string,
    signal: AbortSignal,
  ): Promise<InspectionResult> {
    const key = JSON.stringify([cli.binaryPath, cli.prefixArgs ?? [], cli.version ?? ''])
    let known = this.support.get(key)
    let result: InspectionResult
    if (known) {
      if ((await known) === false) return this.fromList(cli, scope, name, signal)
      result = await this.inspect(cli, name, signal)
    } else {
      // The first check decides for the checks that arrive while it runs.
      const pending = this.inspect(cli, name, signal)
      known = pending.then((value) => (value.ok ? true : value.unsupported ? false : undefined))
      this.support.set(key, known)
      result = await pending
      // Timed out or cancelled: still undecided, so the next check probes again.
      if (!result.ok && !result.unsupported && this.support.get(key) === known)
        this.support.delete(key)
    }
    if (result.ok || !result.unsupported) return result
    this.support.set(key, Promise.resolve(false))
    return this.fromList(cli, scope, name, signal)
  }

  private async fromList(
    cli: Cli,
    scope: string,
    name: string,
    signal: AbortSignal,
  ): Promise<InspectionResult> {
    const key = JSON.stringify([cli.binaryPath, cli.prefixArgs ?? [], cli.cwd, scope])
    let run = this.lists.get(key)
    if (!run) {
      const started = this.list(cli, this.stop.signal).catch((): McpListResult => ({
        ok: false,
        message: 'pi mcp list failed.',
      }))
      this.lists.set(key, started)
      void started.then(() => {
        if (this.lists.get(key) === started) this.lists.delete(key)
      })
      run = started
    }
    const list = await untilAborted(run, signal)
    return list ? inspectionFromList(list, name) : CANCELLED
  }

  /** Stops shared list runs; each kills its own process tree. */
  async dispose(): Promise<void> {
    this.stop.abort()
    await Promise.all(this.lists.values())
  }
}
