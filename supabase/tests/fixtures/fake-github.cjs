// GitHub's OAuth side for the local control stack's Supabase Auth, which
// reaches it as http://fake-github:54353 (supabase/config.toml).
// tools/scripts/auth-stack.mjs runs it in a node:22-alpine container on the
// stack's network. No dependencies and no upstream requests: it signs in one
// fixed user, or refuses when a test asks it to.
const http = require('node:http')
const { randomUUID } = require('node:crypto')

// The fixture's own client, as configured in supabase/config.toml. Not a secret.
const CLIENT = { id: 'phosphor-fake-github', secret: 'phosphor-fake-github-secret' }
// Supabase Auth's own callback: the only place this fake sends a browser.
const AUTH_CALLBACK = 'http://127.0.0.1:54351/auth/v1/callback'
const USER = {
  id: 20001,
  login: 'phosphor-e2e',
  name: 'Phosphor E2E',
  email: 'e2e@example.test',
  avatar_url: 'http://fake-github:54353/avatar.png',
}
const PROFILES = {
  a: USER,
  b: { ...USER, id: 20002, login: 'phosphor-e2e-b', email: 'e2e-b@example.test' },
}
let currentUser = USER

let deny = false
const codes = new Set()
const tokens = new Set()

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

/** The client's credentials, from a Basic header or the form, as OAuth allows both. */
function credentials(req, form) {
  const basic = req.headers.authorization?.match(/^Basic (.+)$/)
  if (!basic) return [form.get('client_id'), form.get('client_secret')]
  const [id, secret] = Buffer.from(basic[1], 'base64').toString().split(':')
  return [decodeURIComponent(id ?? ''), decodeURIComponent(secret ?? '')]
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://fake-github:54353')
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (Buffer.byteLength(body) > 1024) return send(res, 413, { error: 'too large' })
    }
    if (url.pathname === '/__user' && req.method === 'POST') {
      if (body !== 'a' && body !== 'b') return send(res, 400, { error: 'unknown profile' })
      currentUser = PROFILES[body]
      return send(res, 200, { ok: true })
    }
    if (url.pathname === '/__health') return send(res, 200, { ok: true })
    if (url.pathname === '/__deny' && req.method === 'POST') {
      deny = body === 'true'
      return send(res, 200, { deny })
    }
    if (url.pathname === '/login/oauth/authorize' && req.method === 'GET') {
      if (url.searchParams.get('client_id') !== CLIENT.id) {
        return send(res, 400, { error: 'unknown client' })
      }
      const back = new URL(url.searchParams.get('redirect_uri') ?? '')
      if (back.origin + back.pathname !== AUTH_CALLBACK) {
        return send(res, 400, { error: 'callback outside the local stack refused' })
      }
      back.searchParams.set('state', url.searchParams.get('state') ?? '')
      if (deny) {
        back.searchParams.set('error', 'access_denied')
        back.searchParams.set('error_description', 'The user denied access')
      } else {
        const code = randomUUID()
        codes.add(code)
        back.searchParams.set('code', code)
      }
      res.writeHead(302, { location: back.href })
      return res.end()
    }
    if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
      const form = new URLSearchParams(body)
      const [id, secret] = credentials(req, form)
      const code = form.get('code') ?? ''
      if (id !== CLIENT.id || secret !== CLIENT.secret || !codes.delete(code)) {
        return send(res, 400, { error: 'bad_verification_code' })
      }
      const token = randomUUID()
      tokens.add(token)
      const value = { access_token: token, token_type: 'bearer', scope: 'user:email' }
      if (req.headers.accept?.includes('application/json')) return send(res, 200, value)
      res.writeHead(200, { 'content-type': 'application/x-www-form-urlencoded' })
      return res.end(new URLSearchParams(value).toString())
    }
    const token = req.headers.authorization?.replace(/^(Bearer|token) /i, '')
    if (!token || !tokens.has(token)) return send(res, 401, { message: 'Bad credentials' })
    if (url.pathname === '/api/v3/user') return send(res, 200, currentUser)
    if (url.pathname === '/api/v3/user/emails')
      return send(res, 200, [{ email: currentUser.email, primary: true, verified: true }])
    send(res, 404, { message: 'Not Found' })
  } catch (error) {
    send(res, 500, { message: String(error) })
  }
})
server.listen(54353, '0.0.0.0')
// PID 1 in its container gets no default signal handling.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0))
