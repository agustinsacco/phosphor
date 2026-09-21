# Feedback

How a rating and an honest opinion get from the app into a queryable place,
without Phosphor holding a credential and without ever interrupting anyone.

GitHub issues are the database. Every submission carries the `feedback` label
and a `rating:<1-5>` label, so "what do people think" is a label filter rather
than a parse:

```bash
gh issue list --repo agustinsacco/Phosphor --label feedback
gh issue list --repo agustinsacco/Phosphor --label feedback --label rating:1
```

## The form

`src/features/feedback/FeedbackModal.tsx`. A 1–5 star rating, two free-text
answers ("what's working, what isn't" and "features you'd like to see"), an
anonymity choice, an optional contact, and an opt-out for attaching the app
version and platform. Nothing else about the machine, the code or any session
is ever attached — `buildFeedbackIssue` in `shared/feedback.ts` is the whole
payload, and it only reads the draft.

Submit needs at least one of the two text answers. A rating alone is a number
with no story behind it.

## Two ways in, and only one of them can be anonymous

`shared/feedback.ts` is the contract; `electron/feedback/feedback-service.ts`
runs it. Which path is live depends only on whether a relay is configured.

| Mode               | When                            | Who the issue is from         |
| ------------------ | ------------------------------- | ----------------------------- |
| `github` (default) | No relay configured             | The user's own GitHub account |
| `relay`            | An HTTPS endpoint is configured | The relay's bot account       |

**`github`** builds a prefilled `issues/new` URL and opens it with
`shell.openExternal`. No secret anywhere — but GitHub attributes the issue to
whoever presses the green button, so the form disables the anonymity checkbox
and says why rather than making a promise it cannot keep.

**`relay`** POSTs `{title, body, labels, rating, anonymous}` as JSON and lets
the endpoint create the issue under its own identity. That is what makes
anonymous actually anonymous. Configure it with the `PHOSPHOR_FEEDBACK_ENDPOINT`
environment variable, or the `feedback.relayEndpoint` pref. HTTPS only, no
credentials in the URL, 10s timeout, redirects refused, cookies omitted — a
value that fails any of those falls back to `github` mode rather than sending
anything. A 2xx answer may carry `{"url": "..."}` to link the created issue;
anything non-http(s) there is dropped.

**Phosphor never holds a GitHub token, and must not start.** Shipping one in a
desktop binary is shipping it to everyone who downloads the app. The relay
exists so that the token lives on a server the maintainer controls.

## The nudge is one sentence, once

`src/features/feedback/FeedbackButton.tsx` sits in the sidebar footer above
Settings. It is a quiet `Send feedback` row at all times — findable, never in
the way.

After **5 app launches** and **3 days** since the first one, and only then, it
promotes itself once: an accent dot, `How is Phosphor going?`, and an ✕ to
dismiss. That is the entire prompting strategy. There is no launch popup, no
toast, and no second ask — dismissing it or sending feedback retires it
permanently (`dismissedAt` / `submittedAt` in the `feedback` pref block, read
by `shouldNudgeForFeedback`).

Launches are counted in main, once per `app.whenReady()` (`recordAppLaunch`).

## Labels have to exist

GitHub drops `?labels=` values that do not exist in the repo, silently, and a
feedback issue with no label is invisible to the query above. Once per repo:

```bash
gh label create feedback --description "In-app feedback and ratings" --color 1D76DB
for n in 1 2 3 4 5; do gh label create "rating:$n" --color BFD4F2; done
```

`.github/ISSUE_TEMPLATE/feedback.yml` gives the same fields to anyone filing by
hand, so a browser-filed issue and an app-filed one read the same way.

## Where the pieces are

| Path                                    | Holds                                                     |
| --------------------------------------- | --------------------------------------------------------- |
| `shared/feedback.ts`                    | Types, the issue builder, the URL builder, the rules      |
| `electron/feedback/feedback-service.ts` | Relay POST, browser fallback, launch counting             |
| `electron/ipc/feedback-handlers.ts`     | `feedback:state` / `feedback:submit` / `feedback:dismiss` |
| `src/features/feedback/`                | The store, the modal, the sidebar button                  |
| `.github/ISSUE_TEMPLATE/feedback.yml`   | The hand-filed version of the same form                   |
