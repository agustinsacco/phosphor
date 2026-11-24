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
