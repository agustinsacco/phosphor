/** A ustar archive as the release builder writes it; entries may be faulted for refusal tests. */
export interface Entry {
  name: string
  text?: string
  type?: string
  size?: number
}
export function tar(entries: Entry[], ending = Buffer.alloc(1024)): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.from(entry.text ?? 'test')
    const h = Buffer.alloc(512)
    h.write(entry.name)
    h.write('0000755\0', 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    h.write((entry.size ?? data.length).toString(8).padStart(11, '0') + '\0', 124)
    h.write('00000000000\0', 136)
    h.fill(32, 148, 156)
    h.write(entry.type ?? '0', 156)
    h.write('ustar\0', 257)
    h.write('00', 263)
    h.write(
      h
        .reduce((n, b) => n + b, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    )
    parts.push(h, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length))
  }
  return Buffer.concat([...parts, ending])
}
