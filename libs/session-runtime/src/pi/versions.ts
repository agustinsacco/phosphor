/** Pull a version like "0.78.0" out of mixed CLI output. */
export function extractVersion(output: string): string | null {
  for (const line of output.split('\n')) {
    const match = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(line.trim())
    if (match) return match[1]!
  }
  return null
}
