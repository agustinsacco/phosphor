import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { URL } from 'node:url'

// Keep this Docker context self-contained. Sources are real captures, copied
// byte-for-byte; the already-redacted accounts capture must stay redacted.
const source = new URL('../../site/src/assets/shots/', import.meta.url)
const destination = new URL('../src/assets/shots/', import.meta.url)
await mkdir(destination, { recursive: true })
const files = (await readdir(source)).filter((name) => /\.(webp|png)$/.test(name))
for (const file of files) await copyFile(new URL(file, source), new URL(file, destination))
console.log(`Copied ${files.length} real captures from site/src/assets/shots/`)
if (!files.includes('ide-flex.png')) {
  throw new Error(
    'The original ide-flex.png capture is required; do not substitute another session.',
  )
}
