import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Deterministic private credential slots, never a real Claude login. */
export async function installFixtureClaude(root: string): Promise<void> {
  await writeFile(
    join(root, 'bin', 'claude'),
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const defaultAuth = ${JSON.stringify(join(root, 'default-claude-auth.json'))};
const scope = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
const file = scope ? path.join(scope, 'fixture-auth.json') : defaultAuth;
const args = process.argv.slice(2);
const observe = extra => fs.appendFileSync(${JSON.stringify(join(root, 'claude-fixture.log'))}, JSON.stringify({ args: args.slice(0,2), scoped: !!scope, ...extra }) + '\\n');
observe({ phase: 'invoked' });
if (args[0] === '--version') { console.log('2.1.301'); process.exit(0); }
if (args[0] !== 'auth') process.exit(1);
if (args[1] === 'login') {
  console.log('HOST_A_ONLY Claude account email:');
  let input = '';
  process.stdin.on('data', chunk => {
input += chunk.toString();
if (!input.includes('\\n')) return;
const email = input.trim();
if (!email.includes('@')) process.exit(1);
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
fs.writeFileSync(file, JSON.stringify({ loggedIn: true, email, subscriptionType: 'max', accessToken: 'HOST_ONLY_PRIVATE_CLAUDE_TOKEN' }), { mode: 0o600 });
observe({ phase: 'login-saved', email });
console.log('HOST_A_ONLY Login successful.'); process.exit(0);
  });
} else if (args[1] === 'logout') { if (scope) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, '{"loggedIn":false}', { mode: 0o600 }); process.exit(0); }
else if (args[1] === 'status') {
  if (!scope && !fs.existsSync(file)) console.log(JSON.stringify({ loggedIn: true, email: 'first@host.example', subscriptionType: 'max' }));
  else console.log(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{"loggedIn":false}');
} else process.exit(1);
`,
    { mode: 0o700 },
  )
}
