import { setImmediate } from 'node:timers/promises'
import { BIT_WORDS, asymmetric, shortlist } from './bits'
import { all, one, type Context } from './database'
import type { Neighbour } from './types'
import { cosine, decodeVector, encodeVector } from './vectors'

type Kind = 'entity' | 'memory'
export class VectorIndex {
  private bits = new Uint32Array()
  private numbers: number[] = []
  private last = 0
  constructor(
    private ctx: Context,
    private kind: Kind,
  ) {}
  /** Build a replacement privately. Readers keep the complete old index until publication. */
  async refresh(rebuild: boolean, current: () => boolean): Promise<VectorIndex | null> {
    await setImmediate()
    if (!current()) return null
    const { ctx, kind } = this
    const next = new VectorIndex(ctx, kind)
    if (!rebuild) {
      next.last = this.last
      next.numbers = this.numbers.slice()
    }
    const end = one<{ n: number }>(ctx, `SELECT COALESCE(MAX(${kind}),0) AS n FROM ${kind}_bits`)!.n
    const count = Number(
      one<{ value: string }>(ctx, 'SELECT value FROM meta WHERE key=?', `${kind}_bits`)!.value,
    )
    const capacity = next.numbers.length + Math.min(count, Math.max(0, end - next.last))
    next.bits = new Uint32Array(capacity * BIT_WORDS)
    if (!rebuild) next.bits.set(this.bits)
    while (next.last < end) {
      if (!current()) return null
      const rows = all<{ n: number; bits: Uint8Array }>(
        ctx,
        `SELECT ${kind} AS n,bits FROM ${kind}_bits WHERE ${kind}>? AND ${kind}<=? ORDER BY ${kind} LIMIT 2048`,
        next.last,
        end,
      )
      if (!rows.length) break
      // Inserts between chunks can fill deleted gaps. Grow only the private replacement.
      if ((next.numbers.length + rows.length) * BIT_WORDS > next.bits.length) {
        const grown = new Uint32Array((next.numbers.length + rows.length) * BIT_WORDS)
        grown.set(next.bits)
        next.bits = grown
      }
      const bytes = new Uint8Array(next.bits.buffer)
      for (const row of rows) {
        bytes.set(row.bits, next.numbers.length * BIT_WORDS * 4)
        next.numbers.push(row.n)
        next.last = row.n
      }
      await setImmediate()
    }
    if (!current()) return null
    next.bits = next.bits.subarray(0, next.numbers.length * BIT_WORDS)
    return next
  }
  stale(): boolean {
    const actual = Number(
      one<{ value: string }>(this.ctx, 'SELECT value FROM meta WHERE key=?', `${this.kind}_bits`)
        ?.value ?? 0,
    )
    return this.numbers.length > 0 && actual < this.numbers.length * 0.8
  }
  nearest(vector: Float32Array, k: number): Neighbour[] {
    encodeVector(vector)
    let indices: number[]
    if (this.numbers.length < 2000) indices = this.numbers.map((_, index) => index)
    else {
      const count = Math.min(
        this.numbers.length,
        Math.max(2000, Math.min(20_000, Math.ceil(this.numbers.length * 0.02))),
      )
      indices = shortlist(vector, this.bits, count)
        .map((index) => ({ index, score: asymmetric(vector, this.bits, index * BIT_WORDS) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 1000)
        .map((item) => item.index)
    }
    const { kind, ctx } = this
    const table = kind === 'entity' ? 'entities' : 'memories'
    // CROSS JOIN keeps the shortlist first: otherwise SQLite can scan every live memory.
    // Primary-key order also avoids random similarity-ordered vector reads.
    const numbers = indices.map((index) => this.numbers[index]!).sort((a, b) => a - b)
    return all<{ id: string; vector: Uint8Array }>(
      ctx,
      `SELECT t.id,v.vector FROM json_each(?) j CROSS JOIN ${kind}_vectors v ON v.${kind}=j.value CROSS JOIN ${table} t ON t.n=v.${kind} ${kind === 'memory' ? "WHERE t.state IN ('active','disputed')" : ''}`,
      JSON.stringify(numbers),
    )
      .map((row) => ({ id: row.id, score: cosine(vector, decodeVector(row.vector)) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, k))
  }
}
