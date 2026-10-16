#!/bin/sh
# Generated from HOST_RELEASE_KEYS by tools/host-release/installer.mjs.
set -eu
umask 077
critical=0
pending=
on_signal() { if [ "$critical" = 1 ]; then pending=${pending:-$1}; else exit "$1"; fi; }
end_critical() { critical=0; [ -z "$pending" ] || exit "$pending"; }
fail() { printf '%s\n' 'Host installation failed; existing install is unchanged.' >&2; exit "${pending:-1}"; }
valid_version() {
  printf '%s\n' "$1" | awk -F. 'NR != 1 || NF != 3 {exit 1} {for(i=1;i<=3;i++) if ($i !~ /^[0-9]+$/ || length($i)>9 || (length($i)>1 && substr($i,1,1)=="0")) exit 1}'
}
requested=
replace_launcher=0
while [ "$#" -gt 0 ]; do
  case $1 in
    --replace-launcher) [ "$replace_launcher" = 0 ] || fail; replace_launcher=1 ;;
    *) [ -z "$requested" ] || fail; valid_version "$1" || fail; requested=$1 ;;
  esac
  shift
done
case $(uname -s):$(uname -m) in
  Linux:x86_64) target=linux-x64; mvflag=-T; base64flag=-d ;;
  Linux:aarch64|Linux:arm64) target=linux-arm64; mvflag=-T; base64flag=-d ;;
  Darwin:arm64) target=darwin-arm64; mvflag=-h; base64flag=-D ;;
  *) fail ;;
esac
tmp=$(mktemp -d "${TMPDIR:-/tmp}/phosphor-install.XXXXXXXX")
stage=
new_version=
committed=0
command_published=0
lock=
gate=
retired=
backup_moved=0
remove_retired() {
  rm -f "$1/pid"
  if [ ! -L "$1/recovery" ]; then rmdir "$1/recovery" 2>/dev/null || :; fi
  rmdir "$1"
}
# Keep child exit status truthful even when a signal reaches the process group.
rename_safe() { ( trap '' HUP INT TERM; exec mv -f "$mvflag" "$@" ); }
mkdir_safe() { ( trap '' HUP INT TERM; exec mkdir "$@" ); }
selects_new() { [ -L "$root/current" ] && [ "$(readlink "$root/current")" = "versions/$version" ]; }
command_is_ours() { [ -L "$command" ] && [ "$(readlink "$command")" = "$root/current/bin/phosphor" ]; }
# Cleanup decides by filesystem state and values, not exit statuses: inside the
# EXIT trap, dash resets $? to the exit status after a deferred signal's trap.
current_target() { ( trap '' HUP INT TERM; exec readlink "$root/current" ) 2>/dev/null || :; }
cleanup() {
  status=$?
  set +e
  critical=1
  trap - 0
  if [ "$committed" = 0 ]; then
    restore_failed=0
    if [ -n "$new_version" ] && selects_new; then
      if [ -n "$old_current" ]; then
        ln -s "$old_current" "$stage/restore-current" && rename_safe "$stage/restore-current" "$root/current"
      else rm -f "$root/current"; fi
      selects_new && restore_failed=1
    fi
    if [ "$restore_failed" = 0 ] && [ "$backup_moved" = 1 ] &&
      { [ -e "$backup" ] || [ -L "$backup" ]; }; then
      if command_is_ours; then rm -f "$command"; fi
      if [ ! -e "$command" ] && [ ! -L "$command" ]; then rename_safe "$backup" "$command"; fi
      if [ -e "$backup" ] || [ -L "$backup" ]; then restore_failed=1; fi
    elif [ "$restore_failed" = 0 ] && [ "$command_published" = 1 ] && command_is_ours; then
      rm -f "$command"
      if command_is_ours; then restore_failed=1; fi
    fi
    if [ "$restore_failed" = 1 ]; then
      # Keep the complete new bundle. Roll forward only through entries we own.
      if [ -n "$new_version" ] && [ -d "$new_version" ]; then
        if ! selects_new; then
          ln -s "versions/$version" "$stage/forward-current" && rename_safe "$stage/forward-current" "$root/current"
        fi
        if [ ! -e "$command" ] && [ ! -L "$command" ]; then
          ln -s "$root/current/bin/phosphor" "$stage/forward-command" && rename_safe "$stage/forward-command" "$command"
        fi
      fi
      printf '%s\n' 'Host installation may have completed; rerunning the installer is safe.' >&2
    elif [ -n "$new_version" ]; then
      case $(current_target) in "versions/$version") ;; *) rm -rf "$new_version" ;; esac
    fi
  fi
  [ -z "$stage" ] || rm -rf "$stage"
  [ -z "$gate" ] || rmdir "$gate"
  if [ -n "$lock" ]; then
    destination=$root/.install-lock.retired.$$
    if [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
      rename_safe "$lock" "$destination"
      if [ -d "$destination" ] && [ ! -L "$destination" ]; then retired=$destination; fi
    fi
  fi
  [ -z "$retired" ] || remove_retired "$retired"
  rm -rf "$tmp"
  critical=0
  [ -z "$pending" ] || exit "$pending"
  return "$status"
}
trap cleanup 0
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
cat > "$tmp/allowed_signers" <<'PHOSPHOR_KEYS'
phosphor-release namespaces="phosphor-host-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINswBTu86+bi4tXFWnoIf6lHw0MwkPtqnqyN+KfxM3AN
PHOSPHOR_KEYS
[ -n "$(tr -d '\n' < "$tmp/allowed_signers")" ] || fail
repo=https://github.com/agustinsacco/Phosphor/releases/download
override=${PHOSPHOR_HOST_RELEASE_URL:-}
if [ -n "$requested" ]; then
  base=${override:-$repo/host-v$requested}
  manifest=phosphor-host-$requested.manifest.json
else
  base=${override:-$repo/host-latest}
  manifest=phosphor-host.manifest.json
fi
# file:// supports offline tests. All other downloads and redirects require HTTPS.
download() {
  case $1 in
    file://*) curl --fail --silent --show-error --max-time 120 --max-filesize "$3" --proto '=file' "$1" -o "$2" ;;
    https://*) curl --fail --silent --show-error --location --max-redirs 3 --max-time 120 --max-filesize "$3" --proto '=https' --proto-redir '=https' "$1" -o "$2" ;;
    *) return 1 ;;
  esac
  [ "$(wc -c < "$2" | tr -d ' ')" -le "$3" ]
}
download "$base/$manifest" "$tmp/manifest" 16384 || fail
download "$base/$manifest.sig" "$tmp/signature" 8192 || fail
ssh-keygen -Y verify -f "$tmp/allowed_signers" -I phosphor-release -n phosphor-host-release -s "$tmp/signature" < "$tmp/manifest" > /dev/null 2>&1 || fail
# Ed25519 + this namespace gives fixed SSHSIG field offsets. Enforce the same
# empty reserved field and sha512 algorithm as the Node verifier.
sed '1d;$d' "$tmp/signature" | base64 "$base64flag" > "$tmp/sshsig" 2>/dev/null || fail
[ "$(wc -c < "$tmp/sshsig" | tr -d ' ')" = 191 ] || fail
fields=$(od -An -tu1 -j90 -N14 "$tmp/sshsig" | tr '\n' ' ' | awk '{$1=$1; print}')
[ "$fields" = '0 0 0 0 0 0 0 6 115 104 97 53 49 50' ] || fail
# Parse the builder's JSON grammar without requiring system Node or Python.
# Strings have no escapes because every manifest string is a bounded identifier.
awk -v wanted="$target" '
function bad() {exit 1}
function token(    c, n) {
  sub(/^[ \t\r\n]+/, "", input)
  c=substr(input,1,1)
  kind="punctuation"
  if(c=="\"") {
    kind="string"
    if (!match(input, /^"[^"\\]*"/)) bad()
    n=RLENGTH; t=substr(input,2,n-2)
  } else if (match(input,/^[0-9]+/)) {kind="number"; n=RLENGTH; t=substr(input,1,n)}
  else {n=1; t=c}
  input=substr(input,n+1)
}
function take(x) {
  token(); if(t!=x) bad()
  if(x=="1") {if(kind!="number" || length(t)!=1) bad()}
  else if(length(x)==1 && index("{}:[],",x)) {if(kind!="punctuation") bad()}
  else if(kind!="string") bad()
}
function text() {token(); if(kind!="string") bad()}
function field(x) {take(x); take(":")}
function version(v,    a,i) {
  if(split(v,a,".")!=3) bad()
  for(i=1;i<=3;i++) if(a[i]!~/^[0-9]+$/ || length(a[i])>9 || (length(a[i])>1 && substr(a[i],1,1)=="0")) bad()
}
{input=input $0 "\n"}
END {
  take("{"); field("schema"); take("1"); take(",")
  field("version"); text(); v=t; version(v); take(",")
  field("protocols"); take("["); count=0
  do {token(); if(kind!="number" || t!~/^[1-9][0-9]*$/ || t+0<1 || t+0>65535 || seen[t]++ || ++count>8) bad(); token()} while(kind=="punctuation" && t==",")
  if(kind!="punctuation" || t!="]") bad(); take(",")
  field("node"); text(); version(t); take(",")
  field("sourceCommit"); text(); if(length(t)!=40 || t!~/^[0-9a-f]+$/) bad(); take(",")
  field("artifacts"); take("["); count=0
  do {
    take("{"); field("target"); text(); target=t
    if(target!~/^(linux-x64|linux-arm64|darwin-arm64)$/ || targets[target]++ || ++count>3) bad()
    take(","); field("file"); text(); file=t
    if(file!="phosphor-host-" v "-" target ".tar.gz") bad()
    take(","); field("bytes"); token(); bytes=t
    if(kind!="number" || bytes!~/^[1-9][0-9]*$/ || bytes+0>268435456) bad()
    take(","); field("sha256"); text(); hash=t
    if(length(hash)!=64 || hash!~/^[0-9a-f]+$/) bad()
    take("}")
    if(target==wanted) {found=1; f=file; b=bytes; h=hash}
    token()
  } while(kind=="punctuation" && t==",")
  if(kind!="punctuation" || t!="]") bad(); take("}"); token(); if(t!="" || !found) bad()
  print v; print f; print b; print h
}' "$tmp/manifest" > "$tmp/metadata" || fail
version=$(sed -n '1p' "$tmp/metadata")
file=$(sed -n '2p' "$tmp/metadata")
bytes=$(sed -n '3p' "$tmp/metadata")
hash=$(sed -n '4p' "$tmp/metadata")
[ -z "$requested" ] || [ "$version" = "$requested" ] || fail
artifact_base=${override:-$repo/host-v$version}
download "$artifact_base/$file" "$tmp/bundle" "$bytes" || fail
[ "$(wc -c < "$tmp/bundle" | tr -d ' ')" = "$bytes" ] || fail
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp/bundle")
else actual=$(shasum -a 256 "$tmp/bundle"); fi
[ "${actual%% *}" = "$hash" ] || fail
# Refuse traversal, links and special files before extracting a signed archive.
tar -tzf "$tmp/bundle" > "$tmp/entries" || fail
awk 'BEGIN {n=0} {if(++n>4096 || length($0)>100 || $0 !~ /^(bin\/phosphor|node\/bin\/node|node\/LICENSE|VERSION|lib\/[-A-Za-z0-9_.\/]+)$/ || $0 ~ /(^|\/)\.\.?($|\/)/) exit 1} END {if(n==0) exit 1}' "$tmp/entries" || fail
tar -tvzf "$tmp/bundle" | awk 'substr($0,1,1)!="-" {exit 1}' || fail
mkdir "$tmp/unpacked"
tar -xzf "$tmp/bundle" -C "$tmp/unpacked" || fail
[ "$(cat "$tmp/unpacked/VERSION")" = "$version" ] || fail
[ -x "$tmp/unpacked/bin/phosphor" ] && [ -x "$tmp/unpacked/node/bin/node" ] && [ -f "$tmp/unpacked/lib/phosphor.mjs" ] || fail
home=$(CDPATH= cd -P "$HOME" && pwd)
# Do not follow a preexisting install-directory symlink outside HOME.
for dir in "$home/.local" "$home/.local/lib" "$home/.local/lib/phosphor-host" "$home/.local/lib/phosphor-host/versions" "$home/.local/bin"; do
  [ ! -L "$dir" ] || fail
  mkdir -p "$dir" || fail
done
root=$home/.local/lib/phosphor-host
lock_path=$root/.install-lock
lock_refused() {
  printf 'Install lock: %s. Remove it only if no install or update is running.\n' "$lock_path" >&2
  exit "${pending:-1}"
}
# Sweep only exact, non-link retired folders, with bounded work.
swept=0
for leftover in "$root"/.install-lock.retired.*; do
  suffix=${leftover#"$root/.install-lock.retired."}
  case $suffix in ''|*[!0-9]*|0*) continue ;; esac
  [ "${#suffix}" -le 10 ] || continue
  [ ! -L "$leftover" ] && [ -d "$leftover" ] || continue
  swept=$((swept + 1)); [ "$swept" -le 16 ] || break
  if ! kill -0 "$suffix" 2>/dev/null; then
    remove_retired "$leftover" || lock_refused
  fi
done
# Defer signals before mkdir: ownership must be recorded even if a child
# delivers a signal immediately after the directory is created.
critical=1
if ! mkdir_safe "$lock_path" 2>/dev/null; then
  end_critical
  [ ! -L "$lock_path" ] && [ -d "$lock_path" ] || lock_refused
  [ ! -L "$lock_path/pid" ] && [ -f "$lock_path/pid" ] || lock_refused
  [ "$(wc -c < "$lock_path/pid" | tr -d ' ')" -le 20 ] || lock_refused
  owner=$(cat "$lock_path/pid")
  case $owner in ''|*[!0-9]*|0) lock_refused ;; esac
  [ "${#owner}" -le 10 ] || lock_refused
  if kill -0 "$owner" 2>/dev/null; then lock_refused; fi
  # One reclaimer at a time, inside the old lock. Compare again under its gate
  # so two installers cannot delete the pid of a newly acquired lock.
  critical=1
  mkdir_safe "$lock_path/recovery" 2>/dev/null || lock_refused
  gate=$lock_path/recovery
  if [ ! -f "$lock_path/pid" ] || [ -L "$lock_path/pid" ] ||
    [ "$(cat "$lock_path/pid")" != "$owner" ] || kill -0 "$owner" 2>/dev/null; then lock_refused; fi
  destination=$root/.install-lock.retired.$$
  [ ! -e "$destination" ] && [ ! -L "$destination" ] || lock_refused
  rename_safe "$lock_path" "$destination" || lock_refused
  retired=$destination
  gate=
  remove_retired "$retired" || lock_refused
  retired=
  end_critical
  critical=1
  mkdir_safe "$lock_path" 2>/dev/null || lock_refused
fi
lock=$lock_path
printf '%s\n' "$$" > "$lock/pid" || fail
end_critical
[ ! -e "$root/current" ] || [ -L "$root/current" ] || fail
already=0
if [ -e "$root/versions/$version" ] || [ -L "$root/versions/$version" ]; then
  if [ ! -L "$root/versions/$version" ] && [ -d "$root/versions/$version" ] &&
    [ -L "$root/current" ] && [ "$(CDPATH= cd -P "$root/current" && pwd)" = "$root/versions/$version" ] &&
    [ ! -L "$root/current/VERSION" ] && [ -f "$root/current/VERSION" ] &&
    [ "$(wc -c < "$root/current/VERSION" | tr -d ' ')" -le 32 ] &&
    [ "$(cat "$root/current/VERSION")" = "$version" ]; then already=1
  else
    printf 'Existing version: %s. Run phosphor update --rollback, or remove this folder and run again.\n' "$root/versions/$version" >&2
    exit 1
  fi
fi
command=$home/.local/bin/phosphor
backup=$command.before-release
ours=0
if [ -L "$command" ] && [ "$(readlink "$command")" = "$root/current/bin/phosphor" ]; then ours=1; fi
foreign=0
if [ -e "$command" ] || [ -L "$command" ]; then
  if [ "$ours" = 0 ]; then
    if [ "$replace_launcher" = 0 ]; then
      printf 'Existing launcher: %s. Use --replace-launcher to keep a backup and replace it.\n' "$command" >&2
      exit 1
    fi
    [ -L "$command" ] || [ -f "$command" ] || fail
    [ "$(ls -dn "$command" | awk '{print $3}')" = "$(id -u)" ] || fail
    [ ! -e "$backup" ] && [ ! -L "$backup" ] || fail
    foreign=1
  fi
fi
old_current=
if [ -L "$root/current" ]; then old_current=$(readlink "$root/current"); fi
stage=$(mktemp -d "$root/.install.XXXXXXXX")
# Cross-filesystem staging can be interrupted safely before publication.
if [ "$already" = 0 ]; then
  mv "$tmp/unpacked" "$stage/version" || fail
  ln -s "versions/$version" "$stage/current"
fi
ln -s "$root/current/bin/phosphor" "$stage/phosphor"
if [ "$ours" = 1 ]; then cp -P "$command" "$stage/old-command"; fi
# Only same-filesystem renames occur while signals are deferred. Finish a
# consistent publication, or roll it back, before honoring the signal.
critical=1
if [ "$already" = 0 ]; then
  new_version=$root/versions/$version
  rename_safe "$stage/version" "$new_version" || fail
fi
if [ "$foreign" = 1 ]; then
  backup_moved=1
  rename_safe "$command" "$backup" || fail
fi
if [ "$ours" = 0 ]; then
  command_published=1
  rename_safe "$stage/phosphor" "$command" || fail
fi
if [ "$already" = 0 ]; then rename_safe "$stage/current" "$root/current" || fail; fi
committed=1
end_critical
# Finish cleanup before claiming success; it can record a deferred signal too.
cleanup
if [ "$foreign" = 1 ]; then
  printf 'Previous launcher kept at %s. If a Host service is running, run phosphor setup again.\n' "$backup"
fi
# Future shells use one recognizable block. Never follow an rc symlink.
add_path_block() {
  rc=$1
  if [ -L "$rc" ] || { [ -e "$rc" ] && { [ ! -f "$rc" ] || [ "$(ls -dn "$rc" | awk '{print $3}')" != "$(id -u)" ]; }; }; then
    printf 'Left unsafe shell startup file unchanged: %s\n' "$rc"
    return
  fi
  if [ -f "$rc" ] && grep -F -q '# >>> Phosphor Host PATH >>>' "$rc"; then return; fi
  if cat >> "$rc" <<'PHOSPHOR_PATH'

# >>> Phosphor Host PATH >>>
case ":$PATH:" in
  *:"$HOME/.local/bin":*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
# <<< Phosphor Host PATH <<<
PHOSPHOR_PATH
  then printf 'Added Phosphor Host PATH to %s\n' "$rc"
  else printf 'Could not update shell startup file: %s\n' "$rc"; fi
}
next='phosphor setup'
case :${PATH:-}: in
  *:"$home/.local/bin":*) ;;
  *)
    next='~/.local/bin/phosphor setup'
    if [ "${PHOSPHOR_NO_MODIFY_PATH:-}" != 1 ]; then
      case ${SHELL:-} in
        */zsh) add_path_block "$home/.zshrc" ;;
        */bash)
          add_path_block "$home/.bashrc"
          case $target in darwin-*) add_path_block "$home/.profile" ;; esac
          ;;
      esac
    fi
    printf '%s\n' 'For this terminal, run: export PATH="$HOME/.local/bin:$PATH"'
    ;;
esac
if [ "$already" = 1 ]; then printf 'Phosphor Host already installed. Next: %s\n' "$next"
else printf 'Installed Phosphor Host. Next: %s\n' "$next"; fi
