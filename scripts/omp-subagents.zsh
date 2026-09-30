#!/bin/zsh -f
# omp subagent check - see scripts/omp-subagents.ts for what each scenario
# exercises and the environment variables it reads.
#
#   /bin/zsh -f scripts/omp-subagents.zsh
#
# Bundles the driver with esbuild (Phosphor's own modules, resolved through
# tsconfig paths) and runs it in plain Node. stdout: one JSON line; exit 0 only
# when every scenario passed. All logs go to stderr.
set -u

repo=${0:A:h:h}
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/omp-subagents-build.XXXXXX")
bundle=$build_dir/omp-subagents.cjs
trap 'rm -rf "$build_dir"' EXIT

fail_all() {
  print -r -- '{"scenarios":[{"id":"scenario_01","status":"failed"},{"id":"scenario_02","status":"failed"},{"id":"scenario_03","status":"failed"},{"id":"scenario_04","status":"failed"}],"version":1}'
  exit 1
}

# A sanitized caller (a CI runner, `env -i`, a GUI launcher) may pass a PATH
# without node or omp. Adopt the login shell's PATH then, the same way
# electron/pi/shell-env.ts does for GUI launches: `-lic` first, because
# version managers are usually wired up in .zshrc; the markers keep rc-file
# chatter out of the value.
if (( ! $+commands[node] || ! $+commands[${OMP_SUBAGENTS_BIN:-omp}] )); then
  login_shell=${SHELL:-/bin/zsh}
  for flags in -lic -lc; do
    login_out=$("$login_shell" $flags 'printf "\n__PATH__%s__PATH__\n" "$PATH"' 2>/dev/null </dev/null)
    if [[ $login_out =~ '__PATH__(.*)__PATH__' ]]; then
      export PATH=$match[1]
      rehash
      print -u2 -- "[omp-subagents] adopted the login-shell PATH ($login_shell $flags)"
      break
    fi
  done
fi
(( $+commands[node] )) || { print -u2 -- '[omp-subagents] node not found on PATH'; fail_all }

cd "$repo" || fail_all

# `electron` stays external: the modules exercised here only reference it in
# code paths that need a running app (the debug log stays uninitialised).
if ! "$repo/node_modules/.bin/esbuild" scripts/omp-subagents.ts \
    --bundle --platform=node --format=cjs --target=node20 \
    --tsconfig=tsconfig.node.json --external:electron \
    --log-level=warning --outfile="$bundle" >&2; then
  print -u2 -- '[omp-subagents] bundling the driver failed'
  fail_all
fi

# NODE_PATH: the bundle sits outside the repo but still requires `electron`.
# A driver that dies before reporting must still leave the one result line.
result=$(OMP_SUBAGENTS_REPO=$repo NODE_PATH=$repo/node_modules node "$bundle")
code=$?
[[ -n $result ]] || fail_all
print -r -- "$result"
exit $code
