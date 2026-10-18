import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'

export const WEB_PROJECT_REF = 'bzdbiswndlqvviiywsvj'
// Supabase glob syntax: escape the literal query delimiter; * cannot cross / or .
export const WEB_CALLBACK_PATTERN = 'https://phosphor-app.saccolabs.com/api/auth/callback\\?state=*'
const projectUrl = `https://api.supabase.com/v1/projects/${WEB_PROJECT_REF}`
const authUrl = `${projectUrl}/config/auth`
const usage =
  'Usage: node tools/scripts/web-activation.mjs --project-ref bzdbiswndlqvviiywsvj [--apply]'

class ActivationError extends Error {}
const refuse = (message) => {
  throw new ActivationError(message)
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true, apply: false }
  if (
    args[0] !== '--project-ref' ||
    ![2, 3].includes(args.length) ||
    (args.length === 3 && args[2] !== '--apply')
  )
    refuse(usage)
  if (args[1] !== WEB_PROJECT_REF) refuse('Refusing a different Supabase project')
  return { help: false, apply: args[2] === '--apply' }
}

// Fixed HTTPS endpoints, no redirect following or upstream diagnostics. Auth config
// can include provider secrets; keep even successful responses out of logs/files.
async function managementRequest(fetcher, token, url, body) {
  if (![projectUrl, authUrl].includes(url) || !url.startsWith('https://'))
    refuse('Refusing a different Management API endpoint')
  try {
    const response = await fetcher(url, {
      method: body === undefined ? 'GET' : 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      credentials: 'omit',
      signal: globalThis.AbortSignal.timeout(10_000),
    })
    if (response.redirected || (response.url && response.url !== url) || response.status !== 200)
      refuse('Management API request refused; check authorization, target and service health')
    // Bound the response while reading, not merely by a peer-supplied Content-Length.
    const reader = response.body?.getReader()
    if (!reader) refuse('Invalid Management API response')
    const chunks = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 1024 * 1024) refuse('Management API response exceeds limit')
        chunks.push(Buffer.from(value))
      }
    } finally {
      await reader.cancel()
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    if (error instanceof ActivationError) throw error
    refuse('Management API request failed; no upstream details recorded')
  }
}

function allowList(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    refuse('Invalid auth configuration response')
  const value = config.uri_allow_list
  if (value !== null && typeof value !== 'string') refuse('Invalid OAuth allowlist response')
  return value ?? ''
}

async function activate(args, env, fetcher) {
  const options = parseArgs(args)
  if (options.help) return usage
  const token = env.SUPABASE_ACCESS_TOKEN
  if (typeof token !== 'string' || !token || /\s/.test(token))
    refuse('Supply SUPABASE_ACCESS_TOKEN through a protected environment only')
  const request = (url, body = undefined) => managementRequest(fetcher, token, url, body)
  const project = await request(projectUrl)
  if (
    project?.ref !== WEB_PROJECT_REF ||
    project?.id !== WEB_PROJECT_REF ||
    project?.name !== 'phosphor' ||
    project?.status !== 'ACTIVE_HEALTHY'
  )
    refuse('Refusing unverified project identity, name or health')
  const current = allowList(await request(authUrl))
  if (current.split(',').some((entry) => entry.trim() === WEB_CALLBACK_PATTERN))
    return 'Verified phosphor target; callback pattern already present; no write'
  if (!options.apply)
    return 'Verified phosphor target; callback pattern missing; dry-run only (use --apply to append)'

  // Reduce stale-read risk; Management API has no documented conditional PATCH.
  // Operators must serialize Auth configuration edits for the remaining race window.
  if (allowList(await request(authUrl)) !== current)
    refuse('OAuth allowlist changed during preflight; no write; rerun after coordinating edits')
  const next = current ? `${current},${WEB_CALLBACK_PATTERN}` : WEB_CALLBACK_PATTERN
  await request(authUrl, { uri_allow_list: next })
  if (allowList(await request(authUrl)) !== next)
    refuse('OAuth allowlist verification failed after PATCH; inspect securely before retrying')
  return 'Verified phosphor target; callback pattern appended and read back; rollout unchanged'
}

/**
 * Only args and the environment supply operator input; fetch is injected for offline tests.
 * @param {{ args?: string[], env?: NodeJS.ProcessEnv, fetcher?: typeof globalThis.fetch }} options
 */
export async function webActivation({
  args = [],
  env = process.env,
  fetcher = globalThis.fetch,
} = {}) {
  try {
    return await activate(args, env, fetcher)
  } catch (error) {
    // Also sanitize unexpected injected/network errors, without retaining a secret-bearing cause.
    // eslint-disable-next-line preserve-caught-error -- An upstream cause can contain credentials.
    throw new Error(
      error instanceof ActivationError
        ? error.message
        : 'Web activation failed; no upstream details recorded',
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(await webActivation({ args: process.argv.slice(2) }))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
