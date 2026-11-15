# Storyboards

What each film shows and says, scene by scene. The on-screen copy below is the films' full text;
`apps/site/src/lib/films.ts` carries the same four steps as the page's written walkthrough.
Times are seconds from the start of the film. Captures are the files in `docs/img/`.

Every scene with the product on screen also shows the rail (which of four steps this is), a step
label, and the slate `Product demo · fictional data`.

## phosphor-overview (25 s)

One idea: a task becomes work you can inspect, on machines you own.

| Time      | Scene     | Capture          | On screen                                                                                       | What happens                                                                                              |
| --------- | --------- | ---------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 0-4.4     | `lane`    | home             | **Start with a lane** · Choose the repository and model. Tasks stay on separate worktrees.      | Lane tiles on the workbench, then a whip to the composer; its machine, folder and branch row is outlined. |
| 4.4-9.0   | `inspect` | chat, artifacts  | **Inspect the work** · Tool calls, changed files and versioned artifacts, not just the summary. | The lane's reply, then the camera travels right as the artifact pane opens.                               |
| 9.0-13.2  | `review`  | lane-pr          | **Check the evidence** · Hand-off buttons draft a message. You decide whether to send.          | The pull request inspector; a push to the stage rail, outlined.                                           |
| 13.2-17.3 | `brain`   | brain-graph      | **Keep what you approve** · Brain is opt-in on Desktop, with review on by default.              | A slow push into the Harbor Ledger neighbourhood.                                                         |
| 17.3-21.5 | `hosts`   | machines, mobile | **Reach your own machines** · Hosts you run, from Desktop or the browser app.                   | The Machines list; the phone-sized browser app rises beside it showing the same lanes.                    |
| 21.5-25   | `end`     | (mark)           | Phosphor · **Your work. In context.** · phosphor.saccolabs.com · macOS and Linux                | The mark lands, the wordmark wipes in, the headline sharpens word by word.                                |

The Home framing stays on the lane tiles and the composer; the illustrative spend and token
totals between them are never the subject.

## brain-walkthrough (39 s)

One idea: Brain keeps only what you queue and approve, and says where each step runs.

| Time      | Scene     | Capture                   | On screen                                                                                                                                                        | What happens                                                                                                                      |
| --------- | --------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0-8       | `enable`  | brain-setup, brain-ready  | **Brain is off until you enable it** · Desktop only. Read the model terms before you turn it on. → It downloads EmbeddingGemma, so search runs on this computer. | The terms link is outlined; the cursor presses the switch and the enabled settings appear; "EmbeddingGemma is ready" is outlined. |
| 8-12.2    | `keep`    | brain-ready               | **Keep review on** · New memories wait in Brain until you approve them.                                                                                          | "Review before saving" is outlined; the cursor goes to Open Brain.                                                                |
| 12.2-17.4 | `queue`   | brain-queue               | **Queue a local lane** · Extraction calls that lane's provider, so it can use quota.                                                                             | The inbox; the job reading a conversation is outlined; the cursor goes to Review.                                                 |
| 17.4-25.4 | `review`  | brain-review              | **Check what it proposes** · Identities, relationships and quotes wait for your decision. → Uncertain matches are yours to settle. Approve or reject.            | "Nothing is searchable until you approve it" is outlined, then the uncertain identity.                                            |
| 25.4-33.4 | `explore` | brain-graph, brain-memory | **Explore the graph** · Typed connections between people, projects and documents. → Open a memory to read the quotes that support it.                            | A push into the graph, then across to a memory and its quoted source.                                                             |
| 33.4-39   | `recall`  | brain-recall              | **New lanes can search it** · A read-only tool. Restart open lanes; nothing syncs to Hosts or the browser.                                                       | A lane's `brain_search` call and briefing; the tool name is outlined.                                                             |

## lane-to-review (35 s)

One idea: you read, inspect and decide; nothing merges or sends on its own.

| Time      | Scene     | Capture                   | On screen                                                                                                                                    | What happens                                                                                            |
| --------- | --------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 0-5.3     | `read`    | chat                      | **Read what the lane did** · Its steps, tool output and reply stay in the conversation.                                                      | The lane, then a push to the reply; the steps line is outlined; the cursor heads to the Changes button. |
| 5.3-10.2  | `changes` | chat, changes             | **Then check Changes** · The files its tools touched, before you call the work finished.                                                     | The press opens the Changes pane; the changed file is outlined.                                         |
| 10.2-18   | `pr`      | chat, lane-pr             | **Open the PR pill** · Checks, reviews, threads and activity for each pull request. → A missing check is never shown as passing.             | The press opens the inspector; its tabs, then the stage rail, are outlined.                             |
| 18-23.5   | `fix`     | lane-pr                   | **Fix drafts the hand-off** · You read it and send it yourself. GitHub stays read-only.                                                      | A push to the status rows; Fix and Address are outlined. Nothing is pressed.                            |
| 23.5-31.5 | `return`  | slack-pill, notifications | **Return to the right thread** · A Slack link already in the conversation, one click away. → Or a notice returns you to work that needs you. | The Slack thread list, its entry outlined; the cursor presses the bell and the drawer opens.            |
| 31.5-35   | `close`   | notifications             | **Nothing merges or sends on its own** · You stay the reviewer.                                                                              | The camera pulls back to the whole lane.                                                                |

## Storylines not built

Each film had two other candidates; they are kept here so a later pass can switch.

- **Overview.** _Result first_: open on the pull request inspector and walk backwards to the
  prompt that produced it. _Split screen to one_: four lanes at once collapsing into the one that
  needs you. Both lean on Home's activity, which the fixture shows idle.
- **Brain.** _One memory's journey_: follow a single sentence from a lane, through extraction and
  review, into the graph and back out through recall. It needs captures of the same memory at
  every stage. _Myth turned over_: "it remembers everything" struck through, then what it
  actually keeps. Rejected as copy-led rather than product-led.
- **Lane to review.** _The failing check_: open on the red stage and work outward to why.
  _Notification first_: start from the drawer and arrive at the lane. Both reorder the steps the
  page's written walkthrough lists.
