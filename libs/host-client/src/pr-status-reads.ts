import { isPrRef, parsePrRefs, parsePrSummaryOptions } from '@phosphor/shared/github-pr-refs'
import { hostOfPrStatusMachine } from '@phosphor/shared/host-protocol-pr-status'
import { parsePrDetailResult, parsePrReadResult } from '@phosphor/shared/host-protocol-pr-results'
import type { GhPrDetail, GhPrRead, GhPrRef } from '@phosphor/shared/models'
import type { createHostConnection } from './connection'
import { REMOTE_UNAVAILABLE } from './lane-ops'

type Connection = Pick<ReturnType<typeof createHostConnection>, 'snapshot' | 'incarnation' | 'call'>

/**
 * `gh:prSummaries` and `gh:prDetail` with a `host:<hostId>` machine: PR status
 * by number on that Host's gh. A Host that does not offer it (no `prStatus`
 * marker, or it answers `unsupported`) reads as unavailable, the same null
 * This Mac answers without gh; it is never an error the user sees.
 */
export function prStatusReads(connection: (hostId: string) => Connection | undefined) {
  async function call<T>(
    machine: unknown,
    method: 'github.prSummaries' | 'github.prDetail',
    params: Record<string, unknown>,
    parse: (data: unknown) => T | null,
  ): Promise<T | null> {
    const hostId = hostOfPrStatusMachine(machine)
    const c = hostId ? connection(hostId) : undefined
    if (!hostId || !c) throw new Error(REMOTE_UNAVAILABLE)
    const generation = c.incarnation().generation
    const ready = () =>
      connection(hostId) === c &&
      c.incarnation().generation === generation &&
      c.snapshot().state === 'ready' &&
      c.snapshot().capabilities.includes('workspaces.read')
    if (!ready()) throw new Error(REMOTE_UNAVAILABLE)
    if (c.snapshot().prStatus !== true) return null
    const reply = await c.call(method, params)
    if (!ready()) throw new Error(REMOTE_UNAVAILABLE)
    return reply.ok ? parse(reply.data) : null
  }
  return {
    async summaries(refs: unknown, options: unknown, machine: unknown): Promise<GhPrRead | null> {
      const parsed = parsePrRefs(refs)
      const opts = parsePrSummaryOptions(options)
      if (!parsed?.length || !opts) throw new Error(REMOTE_UNAVAILABLE)
      return call(machine, 'github.prSummaries', { refs: parsed, options: opts }, (data) =>
        data === null ? null : parsePrReadResult(data, parsed),
      )
    },
    async detail(ref: unknown, options: unknown, machine: unknown): Promise<GhPrDetail | null> {
      const opts = parsePrSummaryOptions(options)
      if (!isPrRef(ref) || !opts) throw new Error(REMOTE_UNAVAILABLE)
      const exact: GhPrRef = {
        host: ref.host,
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
      }
      return call(machine, 'github.prDetail', { ref: exact, options: opts }, (data) =>
        data === null ? null : parsePrDetailResult(data, exact),
      )
    },
  }
}

/** A `gh:prSummaries` / `gh:prDetail` call that names a machine goes to that Host, never This Mac. */
export function routePrStatus(
  reads: ReturnType<typeof prStatusReads>,
  channel: string,
  args: readonly unknown[],
): { result: Promise<unknown> } | null {
  if ((channel !== 'gh:prSummaries' && channel !== 'gh:prDetail') || args[2] === undefined)
    return null
  return {
    result:
      channel === 'gh:prSummaries'
        ? reads.summaries(args[0], args[1], args[2])
        : reads.detail(args[0], args[1], args[2]),
  }
}
