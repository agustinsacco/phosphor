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
  Darwin:x86_64) target=darwin-x64; mvflag=-h; base64flag=-D ;;
  Darwin:arm64) target=darwin-arm64; mvflag=-h; base64flag=-D ;;
  *) fail ;;
esac
tmp=$(mktemp -d "${TMPDIR:-/tmp}/phosphor-install.XXXXXXXX")
stage=
new_version=
selection_started=0
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
    if [ "$selection_started" = 1 ] && selects_new; then
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
      if { [ -n "$new_version" ] || [ "$selection_started" = 1 ]; } && [ -d "$root/versions/$version" ]; then
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
  stem=phosphor-host-$requested.manifest
else
  base=${override:-$repo/host-latest}
  stem=phosphor-host.manifest
fi
# file:// supports offline tests. All other downloads and redirects require HTTPS.
download() {
  case $1 in
    file://*) set -- "$@" --proto '=file' ;;
    https://*) set -- "$@" --location --max-redirs 3 --proto '=https' --proto-redir '=https' ;;
    *) return 1 ;;
  esac
  url=$1 dest=$2 limit=$3; shift 3
  status=$(curl --fail --silent --show-error --max-time 120 --max-filesize "$limit" \
    "$@" -w '%{http_code}' "$url" -o "$dest") || {
    code=$?
    if [ "$code:$status" = '22:404' ]; then return 44; fi
    case $url in file://*) [ "$code" != 37 ] || [ -e "${url#file://}" ] || return 44 ;; esac
    return 1
  }
  [ "$(wc -c < "$dest" | tr -d ' ')" -le "$limit" ]
}
schema=2
manifest=$stem.v2.json
download "$base/$manifest" "$tmp/manifest" 16384 || {
  [ "$?" = 44 ] || fail
  schema=1
  manifest=$stem.json
  download "$base/$manifest" "$tmp/manifest" 16384 || fail
}
download "$base/$manifest.sig" "$tmp/signature" 8192 || fail
ssh-keygen -Y verify -f "$tmp/allowed_signers" -I phosphor-release -n phosphor-host-release -s "$tmp/signature" < "$tmp/manifest" > /dev/null 2>&1 || fail
# Ed25519 + this namespace gives fixed SSHSIG field offsets. Enforce the same
# empty reserved field and sha512 algorithm as the Node verifier.
sed '1d;$d' "$tmp/signature" | base64 "$base64flag" > "$tmp/sshsig" 2>/dev/null || fail
[ "$(wc -c < "$tmp/sshsig" | tr -d ' ')" = 191 ] || fail
fields=$(od -An -tu1 -j90 -N14 "$tmp/sshsig" | tr '\n' ' ' | awk '{$1=$1; print}')
[ "$fields" = '0 0 0 0 0 0 0 6 115 104 97 53 49 50' ] || fail
# No system Node, Python or jq required.
LC_ALL=C awk -v wanted="$target" -v schema="$schema" '
# Signed, size-bounded JSON. Store children by parent node id and key/index;
# extension fields cannot shadow a known field in another object. Strings stay
# escaped: the release builder emits plain ASCII for all known identifiers.
function bad() { exit 1 }
function consume(n) { input=substr(input,n+1); sub(/^[ \t\r\n]+/, "", input) }
function take(s) { if(substr(input,1,1)!=s) bad(); consume(1) }
function string(    s) {
  if(!match(input,/^"([^"\\[:cntrl:]]|\\(["\\\/bfnrt]|u[0-9a-fA-F]{4}))*"/)) bad()
  s=substr(input,2,RLENGTH-2); consume(RLENGTH); return s
}
function parse(depth,    id,c,end,k) {
  if(depth>64) bad()
  id=++nodes; c=substr(input,1,1); type[id]=c
  if(c=="{") end="}"
  else if(c=="[") end="]"
  if(end!="") {
    consume(1)
    if(substr(input,1,1)!=end) do {
      if(c=="{") { k=string(); take(":"); if((id SUBSEP k) in child) bad() }
      else k=count[id]+1
      count[id]++; child[id,k]=parse(depth+1)
      if(substr(input,1,1)!=",") break
      consume(1)
    } while(1)
    take(end)
  } else if(c=="\"") val[id]=string()
  else {
    if(!match(input,/^(true|false|null|-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?)/)) bad()
    val[id]=substr(input,1,RLENGTH); consume(RLENGTH)
  }
  return id
}
function text(id) { if(type[id]!="\"") bad(); return val[id] }
function uint(id,max) { if(type[id]=="\"" || val[id]!~/^[1-9][0-9]*$/ || val[id]+0>max) bad(); return val[id] }
function version(s,    a,i) {
  if(split(s,a,".")!=3) bad()
  for(i=1;i<=3;i++) if(a[i]!~/^(0|[1-9][0-9]*)$/ || length(a[i])>9) bad()
  return s
}
function array(id,min,max) { if(type[id]!="[" || count[id]<min || count[id]>max) bad(); return id }
{input=input $0 "\n"}
END {
  consume(0); r=parse(0)
  if(input!="" || type[r]!="{" || uint(child[r,"schema"],2)!=schema || (schema==1 && count[r]!=6)) bad()
  v=version(text(child[r,"version"])); version(text(child[r,"node"]))
  sha=text(child[r,"sourceCommit"]); if(length(sha)!=40 || sha!~/^[0-9a-f]+$/) bad()
  p=array(child[r,"protocols"],1,8)
  for(i=1;i<=count[p];i++) if(protocols[uint(child[p,i],65535)]++) bad()
  if(schema==2) {
    p=array(child[r,"features"],0,32)
    for(i=1;i<=count[p];i++) {
      f=text(child[p,i]); if(length(f)>40 || f!~/^[a-z][a-z0-9-]*$/ || features[f]++) bad()
    }
  }
  p=array(child[r,"artifacts"],1,(schema==2?16:3))
  for(i=1;i<=count[p];i++) {
    a=child[p,i]; if(type[a]!="{" || (schema==1 && count[a]!=4)) bad()
    t=text(child[a,"target"])
    if(t!~/^(linux-x64|linux-arm64|darwin-arm64)$/ && !(schema==2 && t=="darwin-x64")) {
      if(schema==1) bad(); continue
    }
    file=text(child[a,"file"]); if(seen[t]++ || file!="phosphor-host-" v "-" t ".tar.gz") bad()
    bytes=uint(child[a,"bytes"],268435456); sha=text(child[a,"sha256"])
    if(length(sha)!=64 || sha!~/^[0-9a-f]+$/) bad()
    if(t==wanted) { found=1; metadata=v "\n" file "\n" bytes "\n" sha }
  }
  if(!found) bad(); print metadata
}
' "$tmp/manifest" > "$tmp/metadata" || fail
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
# A stateful install is protected even after uninstall or with a different XDG root.
# Inspect parents first so a dangling link cannot look like absent state.
state_has_brain() {
  for name in brain brain-handover; do
    if [ -L "$1/$name" ] || [ -e "$1/$name" ]; then return 0; fi
  done
  return 1
}
safe_state_path() (
  [ "$1" != / ] || return 0
  safe_state_path "$(dirname "$1")" || return 1
  [ ! -L "$1" ] && { [ ! -e "$1" ] || { [ -d "$1" ] && [ -x "$1" ]; }; }
)
command=$home/.local/bin/phosphor
brain_required=0
if [ -L "$root/.brain-required" ] || [ -e "$root/.brain-required" ]; then
  brain_required=1
else
  case ${XDG_STATE_HOME:-} in
    /*) state=$XDG_STATE_HOME/phosphor-host ;;
    *) state=$home/.local/state/phosphor-host ;;
  esac
  for state_path in "$state" "$home/.local/state/phosphor-host"; do
    safe_state_path "$state_path" || fail
    if state_has_brain "$state_path"; then brain_required=1; fi
  done
fi
if [ "$brain_required" = 1 ]; then
  # Run only with the signature/hash-verified candidate's Node. No installed code proves repair.
  cat > "$tmp/verify-brain.mjs" <<'PHOSPHOR_BRAIN_VERIFIER'
import{closeSync as L,constants as b,fstatSync as Z,lstatSync as l,openSync as M,readdirSync as v,readlinkSync as k,readSync as O}from"node:fs";import{join as d}from"node:path";var C=new Set(["bin/phosphor","node/bin/node","lib/native/node-pty/build/Release/spawn-helper"]);function A(e){return C.has(e)?493:420}var H=["linux-x64","linux-arm64","darwin-arm64"];var re=16*1024,oe=256*1024*1024,S=/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;var ie=[...H,"darwin-x64"];import{lstatSync as G,realpathSync as I}from"node:fs";import{join as u,relative as V,resolve as Y}from"node:path";import{constants as g,closeSync as F,fstatSync as $,lstatSync as le,openSync as z,readSync as K,renameSync as fe,rmSync as ue,chmodSync as me,fsyncSync as pe,writeFileSync as be}from"node:fs";function h(e,n){let r=z(e,g.O_RDONLY|g.O_NOFOLLOW|g.O_NONBLOCK);try{let s=$(r);if(!s.isFile()||s.size>n)throw new Error("Invalid update record");let t=Buffer.alloc(n+1),i=K(r,t,0,t.length,0);if(i>n)throw new Error("Invalid update record");return t.subarray(0,i).toString("utf8")}finally{F(r)}}var p={id:"embeddinggemma-300m-q4@5090578d9565bb06545b4552f76e6bc2c93e4a66",label:"EmbeddingGemma 300M \xB7 Q4",dimensions:768,downloadBytes:218726989,modelUrl:"https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX",termsUrl:"https://ai.google.dev/gemma/terms",usePolicyUrl:"https://ai.google.dev/gemma/prohibited_use_policy"};var y="5090578d9565bb06545b4552f76e6bc2c93e4a66";function f(e,n,r){return{path:e,url:`${p.modelUrl}/resolve/${y}/${e}`,sha256:r,bytes:n}}var E={id:p.id,revision:y,dimensions:p.dimensions,directoryName:`embeddinggemma-300m-q4-${y.slice(0,12)}`,dtype:"q4",maxTokens:512,prefixes:{query:"task: search result | query: ",document:"title: none | text: "},files:[f("config.json",1765,"6e1f06404b7163e0325ed2ea3e6781cde50f4a50b31780a95ad0d30e8404d77b"),f("tokenizer.json",20323312,"4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47"),f("tokenizer_config.json",1156830,"3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a"),f("onnx/model_q4.onnx",519322,"ad1dfee81a70f7944b9b9d1cc6e48075b832881cf33fab2f2b248be78f3f0043"),f("onnx/model_q4.onnx_data",196725760,"599962c3143b040de2dd05e5975be3e9091dd067cacc6a8f7186e3203bab9e02")]},He=E.files.reduce((e,n)=>e+n.bytes,0);var U=["darwin-arm64"];function x(e,n){return U.includes(`${e}-${n}`)}var _={version:"24.14.1",archives:{"linux-x64":"ace9fa104992ed0829642629c46ca7bd7fd6e76278cb96c958c4b387d29658ea","linux-arm64":"734ff04fa7f8ed2e8a78d40cacf5ac3fc4515dac2858757cbab313eb483ba8a2","darwin-x64":"2526230ad7d922be82d4fdb1e7ee1e84303e133e3b4b0ec4c2897ab31de0253d","darwin-arm64":"25495ff85bd89e2d8a24d88566d7e2f827c6b0d3d872b2cebf75371f93fcb1fe"}};var q="brain-workers",N="brain-search-worker.js",T="brain-embedding-worker.js",Ve=`v${_.version}`,X="QUALIFIED.json",J=[N,T,"package.json","../brain-ext/brain.mjs","../brain-ext/brain-curator.mjs","../brain-ext/brain-fork-guard.mjs","../brain-ext/brain-agent-guard.mjs","../skills/brain/SKILL.md","../node_modules/brain-transformers/dist/transformers.node.mjs","../node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node","../node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib","../node_modules/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.5.node","../node_modules/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib"];function Q(e){return{target:e,node:_.version,modelRevision:E.revision}}function w(e,n=process){if(!x(n.platform,n.arch))return null;let r=Q(`${n.platform}-${n.arch}`);if(n.version!==`v${r.node}`)return null;let s=u(e,q);try{let t=u(s,X),i=I(e),o=a=>I(a)===Y(i,V(e,a))&&G(a).isFile();return!o(t)||h(t,512)!==`${JSON.stringify(r)}
`||!J.every(a=>o(u(s,a)))?null:{searchWorker:u(s,N),embeddingWorker:u(s,T)}}catch{return null}}var j=b.O_RDONLY|b.O_NOFOLLOW|b.O_NONBLOCK,m=Buffer.alloc(64*1024),D=Buffer.alloc(m.length);function ee(e,n,r){let s=M(e,j);try{let t=M(n,j);try{let i=Z(t);if(!i.isFile()||i.nlink!==1||i.size!==r)return!1;for(let o=0;o<r;o+=m.length){let c=Math.min(m.length,r-o);if(O(s,m,0,c,o)!==c||O(t,D,0,c,o)!==c||!m.subarray(0,c).equals(D.subarray(0,c)))return!1}return!0}finally{L(t)}}finally{L(s)}}var ne=(e,n)=>n.mode,te=(e,n)=>n.mode&b.S_IFMT|(e===""?448:n.isDirectory()?493:A(e));function B(e,n,r,s=""){let t=l(e),i=l(n);if(r(s,t)!==i.mode||i.uid!==process.getuid?.())return!1;if(t.isDirectory()&&i.isDirectory()){let o=v(e),c=new Set(v(n));return o.length===c.size&&o.every(a=>c.has(a)&&B(d(e,a),d(n,a),r,s?`${s}/${a}`:a))}return t.isFile()&&i.isFile()&&i.nlink===1&&t.size===i.size&&ee(e,n,t.size)}function P(e,n,r,s){try{if(!w(d(e,"lib")))return!1;let t=d(n,"current"),i=l(s,{throwIfNoEntry:!1});if(i&&(!i.isSymbolicLink()||k(s)!==d(t,"bin/phosphor")))return!1;let o,c=l(t,{throwIfNoEntry:!1});if(c){if(!c.isSymbolicLink()||(o=k(t),!o.startsWith("versions/")||!S.test(o.slice(9))))return!1;let R=l(d(n,o),{throwIfNoEntry:!1});if(R?!R.isDirectory():o!==`versions/${r}`)return!1}let a=d(n,"versions",r);return l(a,{throwIfNoEntry:!1})?(!o||o===`versions/${r}`)&&(B(e,a,ne)||B(e,a,te)):!0}catch{return!1}}P(...process.argv.slice(2))||(process.exitCode=1);
PHOSPHOR_BRAIN_VERIFIER
  if ! env -i PATH=/usr/bin:/bin "$tmp/unpacked/node/bin/node" "$tmp/verify-brain.mjs" "$tmp/unpacked" "$root" "$version" "$command"; then
    printf '%s\n' 'This install requires a qualified Host Brain bundle and safe repair paths.' >&2
    fail
  fi
fi
[ ! -e "$root/current" ] || [ -L "$root/current" ] || fail
already=0
reuse=0
if [ -e "$root/versions/$version" ] || [ -L "$root/versions/$version" ]; then
  if [ "$brain_required" = 1 ]; then
    # The protected verifier checked the entire installed tree against the signed unpacked tree.
    reuse=1
    if selects_new; then already=1; fi
  elif [ ! -L "$root/versions/$version" ] && [ -d "$root/versions/$version" ] &&
    [ -L "$root/current" ] && [ "$(CDPATH= cd -P "$root/current" && pwd)" = "$root/versions/$version" ] &&
    [ ! -L "$root/current/VERSION" ] && [ -f "$root/current/VERSION" ] &&
    [ "$(wc -c < "$root/current/VERSION" | tr -d ' ')" -le 32 ] &&
    [ "$(cat "$root/current/VERSION")" = "$version" ]; then already=1
  else
    printf 'Existing version: %s. Run phosphor update --rollback, or remove this folder and run again.\n' "$root/versions/$version" >&2
    exit 1
  fi
fi
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
  if [ "$reuse" = 0 ]; then mv "$tmp/unpacked" "$stage/version" || fail; fi
  ln -s "versions/$version" "$stage/current"
fi
ln -s "$root/current/bin/phosphor" "$stage/phosphor"
if [ "$ours" = 1 ]; then cp -P "$command" "$stage/old-command"; fi
# Only same-filesystem renames occur while signals are deferred. Finish a
# consistent publication, or roll it back, before honoring the signal.
critical=1
if [ "$already" = 0 ] && [ "$reuse" = 0 ]; then
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
if [ "$already" = 0 ]; then
  selection_started=1
  rename_safe "$stage/current" "$root/current" || fail
fi
committed=1
end_critical
# Ordinary installs add PATH under the lock. Protected repair changes only install pointers.
path_message=
if [ "$brain_required" = 0 ]; then
  path_message=$("$command" internal-install-path) || path_message='Could not update shell startup file; use the PATH export below.'
fi
# Finish cleanup before claiming success; it can record a deferred signal too.
cleanup
if [ "$foreign" = 1 ]; then
  printf 'Previous launcher kept at %s. If a Host service is running, run phosphor setup again.\n' "$backup"
fi
if [ -n "$path_message" ]; then printf '%s\n' "$path_message"; fi
next='phosphor setup'
case :${PATH:-}: in
  *:"$home/.local/bin":*) ;;
  *)
    next='~/.local/bin/phosphor setup'
    printf '%s\n' 'For this terminal, run: export PATH="$HOME/.local/bin:$PATH"'
    ;;
esac
if [ "$already" = 1 ]; then printf 'Phosphor Host already installed. Next: %s\n' "$next"
else printf 'Installed Phosphor Host. Next: %s\n' "$next"; fi
