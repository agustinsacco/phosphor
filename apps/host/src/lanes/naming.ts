import { spawn } from 'node:child_process'
import { resolvePackagePaths } from '@phosphor/session-runtime/pi/package-resources'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { claudeOneShotEnv } from '@phosphor/session-runtime/pi/provider-detect'
import type { HostMachine } from '../session/runtime'
import {
  pickTitleModel,
  sanitizeTitle,
  titleArgs,
  titlePrompt,
  type TitleModel,
  type TitleCandidate,
} from './title-policy'

export type NamingOutcome =
  | 'applied'
  | 'skipped-not-eligible'
  | 'skipped-no-model'
  | 'skipped-no-provider-package'
  | 'print-failed'
  | 'print-timeout'
  | 'stale'
  | 'set-failed'

/** One bounded print run; neither output nor errors are logged. */
export function printTitle(
  machine: Pick<HostMachine, 'pi' | 'env'>,
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
  signal?: AbortSignal,
  failed?: (outcome: 'print-failed' | 'print-timeout') => void,
): Promise<string | null> {
  if (signal?.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const child = spawn(machine.pi.binaryPath, [...machine.pi.prefixArgs, ...args], {
      cwd,
      env: { ...machine.env, ...claudeOneShotEnv() },
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
    })
    let output = ''
    let ended = false
    const finish = (ok: boolean, outcome: 'print-failed' | 'print-timeout' = 'print-failed') => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        /* Already exited. */
      }
      const title = ok ? sanitizeTitle(output) : null
      if (!title) failed?.(outcome)
      resolve(title)
    }
    const abort = () => finish(false)
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => finish(false, 'print-timeout'), timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.length > 4096) finish(false)
      else output += chunk.toString('utf8')
    })
    child.on('error', () => finish(false))
    // close waits for stdout to drain; exit can arrive before its final data.
    child.on('close', (code) => finish(code === 0))
  })
}

/** FIFO work is bounded independently of the lane count. Failed naming stays silent. */
export function createLaneNamer(machine: Pick<HostMachine, 'pi' | 'env'>) {
  const controller = new AbortController()
  let tail = Promise.resolve()
  let pending = 0
  const name = (options: {
    cwd: string
    message: string
    model: TitleModel
    models: TitleCandidate[]
    current(): boolean
    apply(title: string): Promise<'applied' | 'stale' | 'set-failed' | void>
    outcome?(outcome: NamingOutcome): void
  }) => {
    if (controller.signal.aborted || pending >= 64) {
      options.outcome?.('stale')
      return
    }
    pending++
    tail = tail
      .then(async () => {
        if (controller.signal.aborted || !options.current()) {
          options.outcome?.('stale')
          return
        }
        const model =
          pickTitleModel(options.models, options.model.provider, options.model.id) ?? options.model
        let extensions: string[] = []
        if (model.provider === 'pi-claude-cli') {
          const pkg = (await listPackages(options.cwd)).find(
            (p) => p.name === '@saccolabs/pi-claude-cli' && p.installed,
          )
          // Package resources are display names, not executable extension paths.
          extensions = pkg?.installPath ? resolvePackagePaths(pkg.installPath).extensions : []
          if (!extensions.length) {
            options.outcome?.('skipped-no-provider-package')
            return
          }
        }
        if (controller.signal.aborted || !options.current()) {
          options.outcome?.('stale')
          return
        }
        let failure: NamingOutcome = 'print-failed'
        const title = await printTitle(
          machine,
          options.cwd,
          [...titleArgs({ model, extensions }), titlePrompt(options.message, [])],
          30_000,
          controller.signal,
          (outcome) => {
            failure = outcome
          },
        )
        if (!options.current() || controller.signal.aborted) options.outcome?.('stale')
        else if (!title) options.outcome?.(failure)
        else {
          try {
            const applied = await options.apply(title)
            options.outcome?.(applied ?? 'applied')
          } catch {
            options.outcome?.('set-failed')
          }
        }
      })
      .catch(() => {
        options.outcome?.('print-failed')
      })
      .finally(() => {
        pending--
      })
  }
  return Object.assign(name, {
    cancel() {
      controller.abort()
    },
  })
}

export function titleCandidates(data: unknown): TitleCandidate[] {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('models' in data) ||
    !Array.isArray(data.models) ||
    data.models.length > 20000
  )
    return []
  return data.models.flatMap((m: unknown) => {
    if (
      typeof m !== 'object' ||
      m === null ||
      !('provider' in m) ||
      !('id' in m) ||
      typeof m.provider !== 'string' ||
      typeof m.id !== 'string'
    )
      return []
    const cost = 'cost' in m ? m.cost : null
    return [
      {
        provider: m.provider,
        id: m.id,
        ...(typeof cost === 'object' &&
        cost !== null &&
        'input' in cost &&
        'output' in cost &&
        typeof cost.input === 'number' &&
        typeof cost.output === 'number'
          ? { cost: { input: cost.input, output: cost.output } }
          : {}),
      },
    ]
  })
}
