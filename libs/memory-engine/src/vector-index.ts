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
  refresh(rebuild: boolean): void {
    const { ctx, kind } = this
    if (rebuild) {
      this.last = 0
      this.numbers = []
      this.bits = new Uint32Array()
    }
    const rows = all<{ n: number; bits: Uint8Array }>(
      ctx,
      `SELECT ${kind} AS n,bits FROM ${kind}_bits WHERE ${kind}>? ORDER BY ${kind}`,
      this.last,
    )
    const bits = new Uint32Array(this.bits.length + rows.length * BIT_WORDS)
    bits.set(this.bits)
    rows.forEach((row, index) => {
      bits.set(
        new Uint32Array(Uint8Array.from(row.bits).buffer),
        this.bits.length + index * BIT_WORDS,
      )
      this.numbers.push(row.n)
      this.last = row.n
    })
    this.bits = bits
  }
  stale(): boolean {
    const table = this.kind === 'entity' ? 'entities' : 'memories'
    const actual = one<{ total: number }>(
      this.ctx,
      `SELECT COUNT(*) AS total FROM ${this.kind}_bits b JOIN ${table} t ON t.n=b.${this.kind}`,
    )!.total
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
    const statement = ctx.db.prepare(
      `SELECT t.id,v.vector FROM ${kind}_vectors v JOIN ${table} t ON t.n=v.${kind} WHERE v.${kind}=? ${kind === 'memory' ? "AND t.state IN ('active','disputed')" : ''}`,
    )
    return indices
      .flatMap((index) => {
        const row = statement.get(this.numbers[index]!) as
          { id: string; vector: Uint8Array } | undefined
        return row ? [{ id: row.id, score: cosine(vector, decodeVector(row.vector)) }] : []
      })
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, k))
  }
}
