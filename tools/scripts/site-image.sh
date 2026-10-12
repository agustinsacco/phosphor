#!/usr/bin/env bash
# Local and CI acceptance of the combined image. Only removes resources it creates.
set -euo pipefail
cd "$(dirname "$0")/../.."
name="phosphor-site-test-$$-$RANDOM"
work=$(mktemp -d)
container=''
built=false
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null; fi
  if [ "$built" = true ]; then docker image rm "$name" >/dev/null; fi
  rm -rf "$work"
}
trap cleanup EXIT

docker build -f apps/control/Dockerfile -t "$name" .
built=true
container=$(docker create --name "$name" --read-only --cap-drop ALL \
  --security-opt no-new-privileges --user 1000:1000 \
  -p 127.0.0.1::5015 "$name")
docker start "$container" >/dev/null
port=$(docker port "$container" 5015/tcp)
url="http://$port"
curl --fail --silent --show-error --max-time 5 --retry 10 --retry-all-errors \
  --retry-delay 1 "$url/healthz" -o /dev/null

request() {
  local path=$1 expected=$2
  shift 2
  local status
  status=$(curl --silent --show-error --max-time 10 -D "$work/headers" \
    -o "$work/body" -w '%{http_code}' "$@" "$url$path")
  test "$status" = "$expected"
  tr -d '\r' < "$work/headers" > "$work/clean-headers"
}
header() { grep -Eiq "^$1: $2$" "$work/clean-headers"; }
api_headers() {
  header content-type 'application/json(;.*)?'
  header cache-control no-store
  header x-content-type-options nosniff
  header referrer-policy no-referrer
  header content-security-policy "default-src 'none'; frame-ancestors 'none'"
  header x-request-id '[a-f0-9]{32}'
  if grep -Eiq '^access-control-allow-origin:' "$work/clean-headers"; then
    echo 'Unexpected CORS header' >&2
    exit 1
  fi
}
request / 200
header x-content-type-options nosniff
header referrer-policy strict-origin-when-cross-origin
grep '<title>' "$work/body" >/dev/null
request /api/v1/health 200
api_headers
jq -e '.ok == true and .configured == false' "$work/body" >/dev/null
# Unconfigured API routes fail closed, even if the route does not exist.
for path in /api/v1/me /api/v1/x; do
  request "$path" 503
  api_headers
  jq -e '.error.code == "unavailable"' "$work/body" >/dev/null
done
request /api/v1/x 503 -X OPTIONS -H 'Origin: https://example.com'
api_headers
request /no-such-page 404
header x-content-type-options nosniff
header referrer-policy strict-origin-when-cross-origin
if grep -Eiq '^access-control-allow-origin:|^content-type: application/json' "$work/clean-headers"; then
  echo 'Unexpected API or CORS header on site 404' >&2
  exit 1
fi
request /guides/claude-code 301
header location /guides/accounts/

SITE_TEST_URL="$url" npm test --prefix apps/site
echo 'Combined image API and site browser checks passed'
