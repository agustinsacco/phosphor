#!/bin/sh
# Generated from HOST_RELEASE_KEYS by tools/host-release/installer.mjs.
set -eu
umask 077
fail() { printf '%s\n' 'Host installation failed; existing install is unchanged.' >&2; exit 1; }
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
backup_moved=0
cleanup() {
  set +e
  if [ "$committed" = 0 ] && [ "$command_published" = 1 ]; then
    if [ "$backup_moved" = 1 ]; then :
    elif [ -L "$stage/old-command" ]; then mv -f "$mvflag" "$stage/old-command" "$home/.local/bin/phosphor"
    else rm -f "$home/.local/bin/phosphor"; fi
  fi
  if [ "$committed" = 0 ] && [ "$backup_moved" = 1 ]; then
    mv -f "$mvflag" "$home/.local/bin/phosphor.before-release" "$home/.local/bin/phosphor"
  fi
  [ -z "$stage" ] || rm -rf "$stage"
  if [ "$committed" = 0 ] && [ -n "$new_version" ]; then rm -rf "$new_version"; fi
  if [ -n "$lock" ]; then rm -f "$lock/pid"; rmdir "$lock"; fi
  rm -rf "$tmp"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$tmp/allowed_signers" <<'PHOSPHOR_KEYS'

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
  do {token(); if(kind!="number" || t!~/^[1-9][0-9]*$/ || t+0<1 || t+0>65535 || seen[t]++ || ++count>8) bad(); token()} while(t==",")
  if(t!="]") bad(); take(",")
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
  } while(t==",")
  if(t!="]") bad(); take("}"); token(); if(t!="" || !found) bad()
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
  exit 1
}
if ! mkdir "$lock_path" 2>/dev/null; then
  [ ! -L "$lock_path" ] && [ -d "$lock_path" ] || lock_refused
  [ ! -L "$lock_path/pid" ] && [ -f "$lock_path/pid" ] || lock_refused
  [ "$(wc -c < "$lock_path/pid" | tr -d ' ')" -le 20 ] || lock_refused
  owner=$(cat "$lock_path/pid")
  case $owner in ''|*[!0-9]*|0) lock_refused ;; esac
  [ "${#owner}" -le 10 ] || lock_refused
  if kill -0 "$owner" 2>/dev/null; then lock_refused; fi
  # One reclaimer at a time, inside the old lock. Compare again under its gate
  # so two installers cannot delete the pid of a newly acquired lock.
  mkdir "$lock_path/recovery" 2>/dev/null || lock_refused
  if [ "$(cat "$lock_path/pid")" != "$owner" ] || kill -0 "$owner" 2>/dev/null; then
    rmdir "$lock_path/recovery"
    lock_refused
  fi
  rm "$lock_path/pid"
  rmdir "$lock_path/recovery"
  rmdir "$lock_path" || lock_refused
  mkdir "$lock_path" 2>/dev/null || lock_refused
fi
lock=$lock_path
printf '%s\n' "$$" > "$lock/pid"
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
stage=$(mktemp -d "$root/.install.XXXXXXXX")
if [ "$already" = 0 ]; then
  mv "$tmp/unpacked" "$stage/version"
  mv "$stage/version" "$root/versions/$version"
  new_version=$root/versions/$version
  ln -s "versions/$version" "$stage/current"
fi
ln -s "$root/current/bin/phosphor" "$stage/phosphor"
if [ "$ours" = 1 ]; then cp -P "$command" "$stage/old-command"; fi
# Signals are ignored during publication. A trap cannot remove a version that
# current has selected, or leave a replaced source launcher without its backup.
trap '' HUP INT TERM
if [ "$foreign" = 1 ]; then
  mv "$command" "$backup" || fail
  backup_moved=1
fi
if [ "$ours" = 0 ]; then
  mv -f "$mvflag" "$stage/phosphor" "$command" || fail
  command_published=1
fi
if [ "$already" = 0 ]; then mv -f "$mvflag" "$stage/current" "$root/current" || fail; fi
committed=1
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$foreign" = 1 ]; then
  printf 'Previous launcher kept at %s. If a Host service is running, run phosphor service install again.\n' "$backup"
fi
if [ "$already" = 1 ]; then printf '%s\n' 'Phosphor Host already installed. Next: phosphor setup'
else printf '%s\n' 'Installed Phosphor Host. Next: phosphor setup'; fi
