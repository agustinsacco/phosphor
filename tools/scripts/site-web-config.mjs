import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'

export function webEnabled(value = '') {
  if (value === '' || value === 'false') return false
  if (value === 'true') return true
  throw new Error('PHOSPHOR_WEB_ENABLED must be true or false (unset defaults to false)')
}

// Match Control's key admission without importing server code or exposing values.
export function validateWebSessionKeys(value = '') {
  const invalid = () => new Error('Invalid or missing CONTROL_WEB_SESSION_KEYS')
  if (!value || value.length > 4096) throw invalid()
  const entries = value.split(',')
  if (entries.length > 8) throw invalid()
  const ids = new Set()
  for (const entry of entries) {
    const [id, encoded, extra] = entry.split('=')
    if (
      !id ||
      id.length > 64 ||
      /[^A-Za-z0-9_-]/.test(id) ||
      !encoded ||
      extra !== undefined ||
      ids.has(id)
    )
      throw invalid()
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.length !== 32 || bytes.toString('base64url') !== encoded) throw invalid()
    ids.add(id)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const enabled = webEnabled(process.env.PHOSPHOR_WEB_ENABLED)
    if (process.argv[2] === '--require-keys' && enabled)
      validateWebSessionKeys(process.env.CONTROL_WEB_SESSION_KEYS)
    else if (process.argv.length > 2 && process.argv[2] !== '--require-keys')
      throw new Error('Unknown web configuration check')
    console.log(String(enabled))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
