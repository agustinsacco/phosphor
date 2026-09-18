/** Bounded UTF-16 tail. Append never joins the retained output; only attach does. */
export class ScrollbackBuffer {
  private chunks: string[] = []
  private head = 0
  private offset = 0
  private length = 0

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid scrollback limit')
  }

  append(data: string): void {
    if (!data) return
    if (data.length >= this.limit) {
      this.chunks = [data.slice(-this.limit)]
      this.head = this.offset = 0
      this.length = this.limit
      return
    }
    this.chunks.push(data)
    this.length += data.length
    while (this.length > this.limit) {
      const available = this.chunks[this.head]!.length - this.offset
      const removed = Math.min(available, this.length - this.limit)
      this.offset += removed
      this.length -= removed
      if (removed === available) {
        // Release the string immediately, without shifting the entire queue.
        this.chunks[this.head++] = ''
        this.offset = 0
      }
    }
    // Amortized compaction also bounds array slots for long-lived terminals.
    if (this.head >= 1024 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }

  snapshot(): string {
    const tail = this.chunks.slice(this.head)
    if (this.offset) tail[0] = tail[0]!.slice(this.offset)
    return tail.join('')
  }
}
