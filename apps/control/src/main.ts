import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { parseConfig } from './config'
import { NonceCache, RATE_PURPOSE_CAPACITIES, RateLimiter } from './limits'
import { createSupabase } from './supabase'

const config = parseConfig(process.env)
const clock = Date.now
const app = createApp({
  config,
  clock,
  random: randomBytes,
  fetch,
  log: (entry) => console.log(JSON.stringify(entry)),
  supabase: createSupabase(config, fetch),
  limits: new RateLimiter(clock, RATE_PURPOSE_CAPACITIES),
  nonces: { key: new NonceCache(clock), host: new NonceCache(clock) },
  version: '0.1.0',
})
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(JSON.stringify({ level: 'info', event: 'listening', port: info.port }))
})
let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  const deadline = setTimeout(() => {
    if ('closeAllConnections' in server) server.closeAllConnections()
    process.exit(1)
  }, 10_000)
  deadline.unref()
  server.close(() => {
    clearTimeout(deadline)
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
