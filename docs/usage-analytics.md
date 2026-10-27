# Usage analytics

Phosphor counts downloads and active installs without identifying anyone. The
counters live in the control plane's own database, and no third party is
involved. The public [privacy page](../apps/site/src/pages/privacy.astro)
states the same facts for users. Change both in the same diff.

## What is stored

| Counter         | Route                     | Row key                             | Values                               |
| --------------- | ------------------------- | ----------------------------------- | ------------------------------------ |
| Downloads       | `GET /download/:artifact` | UTC day, artifact                   | `downloads`                          |
| Active installs | `POST /api/v1/usage/ping` | UTC day, product, version, OS, arch | `pings`, `firsts`, `weeks`, `months` |

No row names an install, account, address, browser or referrer, and neither
table references a user. The server adds to a counter and keeps nothing else
about the request. The request log records the route, status and timing, with no
IP field. The only other line these routes write is a failed download count.
Counters are kept indefinitely; they hold no personal data.

## Downloads

| Path                   | 302 to                                                                         |
| ---------------------- | ------------------------------------------------------------------------------ |
| `/download/latest`     | `https://github.com/agustinsacco/Phosphor/releases/latest`                     |
| `/download/install-sh` | `https://github.com/agustinsacco/Phosphor/releases/latest/download/install.sh` |

The targets are constants in `apps/control/src/routes/usage.ts`. The query
string is ignored, so the route can't become an open redirect. The response has
`Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
`X-Robots-Tag: noindex, nofollow`. The site's links carry `rel="nofollow"`, and
`robots.txt` disallows `/download/`. HEAD gets the same redirect but isn't
counted. Any other artifact, any other method, and every path on the app origin
fall through to the static site, which answers 404.

The redirect never waits for the database. A failed write logs `usage.download`
with `result: unrecorded` and the artifact name. Only the site's own links are
counted (`apps/site/src/lib/content.ts`, `download`). A test in
`tools/scripts/site-repo-links.test.ts` keeps every link in `DOWNLOAD_ARTIFACTS`.
This counts clicks and install-command fetches, not finished installs. GitHub's
asset counts cover the rest, including the updater and the Host installer.

## The usage ping

`POST /api/v1/usage/ping` accepts exactly these keys (`parseUsagePing` in
`libs/shared/src/control-api/usage.ts`):

```json
{
  "v": 1,
  "product": "desktop",
  "version": "0.1.542",
  "os": "darwin",
  "arch": "arm64",
  "first": false,
  "newWeek": true,
  "newMonth": false
}
```

- `product` is `desktop` or `host`, `os` is `linux`, `darwin` or `win32`, and
  `arch` is `x64` or `arm64`. `version` must be a release `x.y.z`.
- `first` means this install has never pinged before. `newWeek` and `newMonth`
  mean its first ping in this ISO week or calendar month, both in UTC. A first
  ping also counts as new for its week and month.
- Summing `weeks` over a week gives the installs active that week, with no id.
  The same goes for `months`. `pings` for one day gives that day's active
  installs, and `firsts` gives new installs.

It answers 204 with no body, or 503 when the counter can't be written. A body
with any other key or value gets 400. A request carrying `Authorization` gets
400 too, so a ping is never tied to an account. One carrying `Origin` gets 403,
so no web page can send one. The route is not served on the app origin.

Desktop sends it; the Host doesn't yet.

### Desktop

`apps/desktop/electron/usage/ping.ts` sends at most one ping per UTC day. The
planner and sender are shared in `libs/shared/src/usage-ping.ts`.

- **On unless turned off.** Settings → Advanced → Privacy holds the switch
  and shows the next ping's exact body ([settings.md](settings.md#advanced)).
- **Notice first.** Nothing is sent until the renderer has shown a one-time
  notice (`noticeUsagePing`) and recorded it with `app:setUsagePing`. The notice
  isn't shown where nothing would be sent.
- **Never from dev, E2E or an opt-out.** Unpackaged builds,
  `DO_NOT_TRACK` (any value but empty, `0`, `false` or `no`) and
  `PHOSPHOR_NO_USAGE_PING` block it. No timer is set at all then.
- **When.** The renderer's `app:usagePing` read on window load starts the
  schedule: a first try 2–10 minutes later, then a recheck every 6 hours, so an
  app left open over midnight counts on the new day too. A launch that never
  opens a window never pings.
- **What it keeps.** `usage-ping.json` in userData, apart from the renderer's
  prefs: the switch, the notice flag, and the UTC day, ISO week and month of the
  last counted ping. The flags are derived from these marks. The marks move only
  on a 204, so a failed ping is retried on the next check.
- **How it sends.** Node's `fetch` from main, not Electron's `net`, so no
  session cookie or proxy credential can ride along. No `Authorization`,
  `Origin` or client header, `redirect: 'error'`, a 10 s timeout, and always to
  `DEFAULT_CONTROL_URL`.

## Abuse limits

Each address gets 20 counted pings a day and 20 counted downloads an hour. The
limiter key is an HMAC of the address (an IPv4 address, or an IPv6 /64). The
HMAC key is 32 random bytes made when the process starts and never written
down, so a key can't be turned back into an address, and a restart forgets
every one. Over the limit, or when the purpose's 10,000 keys are full, the
request is answered as usual and simply not counted, so a sender can't probe
the limit. These are the `usage-ping` and `usage-download` purposes in
[Control plane](control-plane.md) rate limiting.

## Admin summary

`GET /api/v1/admin/stats` returns aggregates to one person. Each check runs in
order, and any failure answers 404, the same as an unknown route:

1. The request is on the app origin with a browser session cookie. The native
   API, bearer tokens and the site origin never reach the route.
2. The ordinary user guard passes, including account suspension.
3. `admin-read:<user>` allows 60 reads a minute (429 past that).
4. `control_admin_check(user, ADMIN_GITHUB_ID)` returns exactly `true`.

The server then calls `control_admin_stats()`. It returns the result through
`parseAdminStats`, which drops any field it doesn't list, and logs `admin.read`
with the user id. A malformed summary returns 503.

### Who is admin

Admin is one GitHub account, numeric id `5874561` (agustinsacco). All three
locks must agree:

1. `ADMIN_GITHUB_ID` in `apps/control/src/routes/admin.ts`.
2. The single row in `control_private.admins`. Its check constraint admits only
   that id. A test pins the constant to the constraint.
3. The signed-in user holds that GitHub identity in `auth.identities`
   (`provider = 'github'`). Supabase writes this only through a completed GitHub
   sign-in. `user_metadata` and the stored login are never read: users can edit
   metadata, and GitHub logins can be reused.

The table ships empty. No API role can read or write it, `service_role`
included; only the security-definer `control_admin_check` reads it. Adding
anyone else takes a reviewed migration and a code change, on purpose.

After the migration is applied to the hosted project, turn admin on as
`postgres` in the SQL editor:

```sql
insert into control_private.admins (github_id) values ('5874561');
```

`delete from control_private.admins;` turns it off at once.

### What the summary holds

- Accounts: total, plus new in the last 7 and 30 days.
- Hosts: enrolled. Online means a `running` heartbeat within 90 seconds; also
  counted are those seen in the last 24 hours.
- Downloads: the last 7 days, the last 30 days, all time, and per artifact over
  30 days.
- Active installs per product: yesterday, this and last ISO week, this and last
  calendar month, and new installs in the last 7 and 30 days.
- A 90-day daily series.
- The top 40 version rows and top 40 platform rows of the last 7 days. Any cell
  under 3 is returned as `null`.

No login, label, hostname or id leaves the database. Periods are computed in UTC.

## Schema

`supabase/migrations/20261027120000_usage_admin.sql` adds:

- `public.usage_daily` and `public.usage_downloads`. RLS is on, and only
  `service_role` gets `select`, `insert` and `update`.
- `control_private.admins`. RLS is on, and every privilege is revoked.
- Security-invoker functions `control_usage_ping`, `control_usage_download` and
  `control_admin_stats`.
- Security-definer functions `control_admin_check` and `control_account_delete`
  ([Control plane](control-plane.md#routes-and-boundaries), `DELETE /api/v1/me`).

Only `service_role` can execute any of them. `supabase/tests/usage_admin.test.sql`
covers the privileges, the admin constraint and identity match, UTC days,
small-cell suppression, a check that no column holds personal data, and
cascading account deletion.
