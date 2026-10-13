import { URL } from 'node:url'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
export function isEntryPoint(url) {
  return (
    process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url))
  )
}
export const root = fileURLToPath(new URL('../../', import.meta.url))
export const pin = JSON.parse(readFileSync(new URL('node.json', import.meta.url), 'utf8'))
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const result = await build({
  stdin: {
    contents:
      "export * from './libs/shared/src/host-release'; export { HOST_PROTOCOL_VERSION } from './libs/shared/src/remote-host'",
    resolveDir: root,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
export const contract = await import(
  `data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`
)
