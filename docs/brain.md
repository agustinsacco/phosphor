# Brain

Brain is Desktop's machine-local knowledge graph. It learns only from lanes you queue: the
reader model reads the lane in a few private, tool-less calls and proposes memories, the
people, projects and systems they name, and how those connect. You approve them, and agents in
every lane can recall them. It is off by default and Desktop-only; the browser client and Hosts
refuse every `brain:*` channel (`libs/shared/src/ipc-web-exclusions.ts`).

## Turning it on

Settings → Brain works like Settings → Voice. One switch saves at once. Turning it on downloads
the pinned local embedding model, EmbeddingGemma 300M Q4 (`BRAIN_EMBEDDING_MODEL`, 208.6 MB),
with a progress bar; the switch's description links the Gemma Terms of Use. Once on, these rows
appear:

- **Recall in lanes** (default on): new lanes get the `brain_search` tool and the bundled `brain`
  skill. Lanes already running pick it up when restarted.
- **Review before saving** (default on): proposals wait for approval. Off approves them as soon
  as a job finishes, with the defaults described under Review.
- **Model that reads lanes** (default **Each lane's own model**): choose one provider/model for
  every queued lane, including lanes without a model. A job keeps the model it first starts with,
  even after this setting changes or you Retry it. Use **Use each lane's own model** to clear it.
  A stored setting is checked when read as well as when written: a malformed value reads as its
  default.
- **Knowledge**: counts and an Open Brain button.
- **Reset Brain knowledge**: after a confirmation, deletes every memory, entity, job, proposal
  and extraction record. Settings and the embedding model stay; review turns back on.

Turning Brain off keeps the model and all knowledge, stops the queue and removes recall from new
lanes. **Remove model** appears only while Brain is off and the model is on disk. The Brain item
shows in the sidebar's top navigation only while Brain is on.

## The Brain page

The header shows **Brain**, “N memories · M people and things”, **Go to anyone or anything**
(`/`) and Settings. Three underlined tabs split the jobs: **Inbox** holds every decision,
**Knowledge** is what Brain knows, and **Lanes** is where it came from. The Inbox tab and the
sidebar's Brain item show how many decisions wait (“N to decide”: reviews plus open Tidy
suggestions), hidden at zero. The Inbox opens first when something waits; otherwise Lanes
opens when there are jobs but no memories, and Knowledge in every other case. Switching tabs
keeps each tab's selection, the Knowledge trail and the selected read.

One thin status strip under the tabs says what runs now: “Reading <lane> · <step> · N queued”
with a link to Lanes, and while Tidy checks, “Checking N of M pairs with <model>” with Cancel.
It is empty when nothing runs.

The frame stays put and only the panes scroll. Each tab is a list on the left and one thing
in the middle; Inbox and Knowledge add a third column. When the page is about 1060 px wide or
less, the third column goes (Knowledge's map becomes a **Map** tab in the profile), and at
about 700 px or less the panes stack. The sizes are the page's own width, not the window's.

Keys are scoped to the page and ignored in fields, dialogs and menus. `/` focuses the
Knowledge search; ⌘K stays the global command palette.

### Inbox

The left column is the queue, grouped by kind with counts: **From lanes** (reads to review),
**Same person or thing?**, **Said twice**, **These disagree** and **Flagged by a lane**. Empty
groups disappear. Each row is a title and one line: “2 memories to review · read again”, or a
suggestion's reason. **Show more suggestions** loads twenty more. With nothing waiting it says
“Nothing to decide.” and how decisions arrive. `j` and `k` move the selection, `a` takes the
decision's primary action and `r` rejects a review; ↑ and ↓ move focus between rows. After a
decision the next item opens: the one after it, else the one before.

Under the queue, **Tidy check** starts a check: **Check with <model>** (the pinned reader, or
the newest read's model) or **Check for repeats** when no model is known. Its tooltip says
Tidy looks for repeats on this computer and sends at most forty pairs to the model. Below it,
one status line: the run's progress, or what the last run found, which model checked how many
pairs, and how many the owner settled while it ran; then the coverage of the local pass and
any checks cut short. No cost or token counts appear.

The middle column shows one decision: a small group label, a title, the body, and a fixed
action bar at the bottom whose refusals appear as a sentence beside the buttons, never as
silence. The right column, **What Brain knows**, has a card for each person or thing involved
(up to six): name, kind, description, memory and link counts and **Open profile**.

**A Tidy suggestion** starts with its reason and one opinion line: “Found on this computer.”,
“Flagged by a lane.”, or “Checked by <model>, which thinks …”, never a decision. The two sides
sit side by side with their names, descriptions, memory counts, dates, scope and quotes; each
opens on Knowledge. A pair of people or things offers **Merge into A** (the one with more
memories; `a`), **Keep B instead** and **Not the same**, plus **Not the same; remove “X” from
B** when Brain allows taking off a name one record holds as another name (never a label).
Memory pairs offer what the engine allows: either side can survive a fold (**Keep this one**),
both can stay disputed, or either can replace the other. When folding is refused, a quiet line
gives the engine's reason. A lane flag offers **Keep**, or **Forget** after a confirmation, and
says in one sentence who flagged what (“Harbor planning says this is outdated.”); a lane
missing from the lane list shows as “A lane calling itself …”. Open the lane resolves only a
lane the sidebar knows. Every change toasts with Undo. A suggestion settled elsewhere says so
and the queue reloads; a changed revision says “Brain changed. Check this again.”

Automatic folds produce one “Brain folded N exact repeats” toast and notice, which opens Lanes
on Recent changes. New suggestions replace the single `brain:tidy` notice, “Brain has N things
to tidy”, which opens the Inbox. A finished check announces its result only while the Inbox is
not visible. Startup suggestions and falling counts are silent; turning Brain off removes its
Tidy notices. While the page is visible and Brain is on, it checks status every ten seconds,
or every two seconds during work; these reads never start a sweep or a model call.

### Lanes

The left column lists reads by state, each group with its count: **Reading**, **Queued**,
**Failed** and **Read** (the newest 200 finished reads, one per lane; it says when there are
more). Rows are the lane's title and one line: the reported step and how long it has run, the
queue position, the error, or “2 memories · 5 min ago” (“Nothing worth keeping” for an empty
read). Times are words (“3 min”, “1 h 20 min”), never a clock. **Recent changes** follows:
the newest fifty Tidy journal operations with who made them (Automatic or By you), when, and
**Undo**. With nothing read it says “Right-click a lane and choose Queue for knowledge
extraction.” Reviews are not here; they belong to the Inbox.

The middle column shows the selection. A reading job shows its model and step list (Prepare,
Read the conversation (part x of y), Match people and things, Compare with what Brain knows,
Index) and Cancel; a failed one shows the whole error with **Retry** and **Dismiss**. Both
show the calls made so far, the claim outcomes and **Source lane at extraction** once a record
exists, and “No calls yet.” before. A finished read is described under Inspecting a finished
read. A change shows what it did, who, when, and Undo or when it was undone. A read asked for
by id that the list does not show stays open; a listed read that disappears moves the
selection on.

## Queueing a lane

Right-click a local lane and choose **Queue for knowledge extraction**; a queued, waiting or
running lane offers **Cancel knowledge extraction** instead. The queue
(`libs/brain-runtime/src/queue.ts`) runs one lane at a time and only while the embedding model is
ready. A lane whose agent is working (`SessionActivity.busy`) waits until it is idle. A lane with
nothing new since its last finished extraction by the same extractor version is refused; a new
extractor version may read it once more. A failed job shows **Retry**, which requeues the same
job and resumes from its saved steps. Jobs left running when the app quit resume where they
stopped.

## Read lanes and Read again

The **Read** section of Lanes shows the newest 200 finished reads, with one history row per
lane, and says when more exist. The list reloads when jobs or knowledge change; a failed load
has Retry. Model names match the picker; unavailable names fall back to the id without its
provider prefix. A row opens the finished read in the same pane.

**Read again** in a finished read reads the whole lane, even if nothing changed.
It confirms how many earlier memories will be replaced. Memories another lane also supports
are kept. The lane must still be readable and have no queued, running or review job. Busy lanes
wait as usual; leaf and model freeze at first start. Retry keeps the replacement intent.

Earlier memories remain searchable while the new read runs and waits for review. Reconcile
excludes the memories this read will replace; entity identity still reuses shared entities.
Approval saves the checked candidates and removes the earlier, unshared memories from that lane
in one transaction, including memories from older reads whose job rows are gone. Partial
approval, or approval with no candidates checked, still replaces them. With review off, saving
happens immediately. A citation or relationship supported by a different lane protects its
memory unchanged. Entries a fork copied from its source lane are the same evidence, not another
lane's support; a message written in the fork is. Replacing bumps the revision once. If the
search index fails to refresh after an automatic save, the read still ends as done and the
failure is logged. A rejected, cancelled or permanently failed reread removes no knowledge.
An **empty** reread (nothing kept) also removes nothing. Rejecting or dismissing a reread keeps
the earlier finished read in history. Successful saving replaces that history row.

## Reading a lane

A job freezes the lane's leaf, chosen reader model, thinking level and git branch when it first
starts. A resume never moves them. It then reads the lane's path to that leaf, applies pi's
`context_edit` entries, and keeps only user and assistant text. Tool calls, tool output,
custom messages, branch summaries and compaction summaries are not evidence. Every segment is
scrubbed of secrets, email addresses and phone numbers before any prompt. User messages longer
than 6,000 characters keep their first 4,000 and last 1,900 around an explicit
`[… N chars omitted …]` marker. Assistant text is never elided. No quote may cross a marker.

The conversation is read in parts of at most 300,000 characters, with two segments of overlap.
Each segment has a handle, role and ISO date. Most lanes fit in one part. A part can be about
100,000 tokens. A reader model with a smaller context window fails with the provider's error.

Each model call runs pi in print mode with no session and no tools. It uses the chosen reader
provider and model, or the lane's own model when unset. The binary and Claude account come from
the lane:

```
pi -p --mode json --no-session --model <reader model> --thinking <t> --no-tools --no-mcp
   --no-skills --no-prompt-templates --no-context-files --no-themes --no-approve --offline
   -e brain-fork-guard.mjs --system-prompt <call dir>/system.md        (prompt on stdin)
```

The prompt goes on stdin, so no transcript text sits in argv. The call runs in a private
directory under `<userData>/brain/calls/<job>/`, removed when the call ends, as a Claude
one-shot (`claudeOneShotEnv`) with its own `PI_CLAUDE_CLI_STATE_DIR`, and without the lane's
context-compression environment, so quotes match the source. The guard extension refuses any
tool call. A call that takes longer than 600 seconds fails. With a reader model selected, thinking
is `medium`. Otherwise it uses the lane's level, capped at `medium`. An unknown level also uses
`medium`.

A job calls extract, links, identity and reconcile. Each call's validated output is saved as a
step, keyed by a hash of its input, so a retry or restart reuses it:

1. **Extract**, once per part. The model sees the conversation, the entities this job already
   knows (`r1…`), and the claim sentences kept from earlier parts. The prompt assumes any work
   session, not only a coding one. Both speakers are evidence: the user's messages are
   first-hand, and the assistant's replies report what it found in code, data, documents and
   tools. Only the assistant's account of its own work is skipped. A claim is kept if a future
   session would act differently, it would take real digging to learn again, and it will
   probably still hold in a month or records a decision with its reason. Each part keeps every
   claim that passes, up to 25; an empty answer is valid only when nothing passes. Extra claims
   are dropped with a recorded reason. No kind of claim ranks first. The model looks for people
   and structure (who is on which team, who leads, owns or decides what, which customer a
   project is for), how systems, vendors, data and customers behave, decisions with reasons,
   preferences and corrections, reusable procedures, remaining risks and open questions for a
   named person or team. A standing role passes; a ticket event does not. Status, one-off
   events, near-term dates, pull requests, code facts, file paths, the assistant's work log,
   instructions for one task, unaccepted proposals, corrected statements, generic advice,
   personal matters about a person (health, family, pay, performance, conduct), secrets and
   contact details do not pass.
   It returns lasting entities (`n1…`), self-contained claims (`c1…`) with one or two quotes,
   typed links with their own quotes, and parent assessments for new projects, components,
   documents and teams. A stated parent needs a kept structural link whose subject is that entity.
   Missing or invalid parent assessments mean not stated. People are humans, never agents or bots.
   Pull requests, tickets, commits, branches and files are not entities. The model is asked for
   every lasting relationship the conversation shows between a kept claim's entities. A link
   sits on a claim that mentions both ends, and its quote may come from any segment. A person is
   linked only for a real role, never to a tool they merely use. The answer rules are repeated
   after the conversation, because a long one buries them.
2. **Links**, after each part's extraction. The model sees only kept claims that mention two or
   more entities, those entities, existing links and short excerpts around each claim's quotes.
   Each excerpt stays in its segment, stops at an elision marker and adds at most 600 characters
   on each side. Overlapping excerpts merge. Links join two entities the claim already mentions,
   obey the same endpoint-kind rules and need their own verified quote from a claim excerpt's
   segment. Duplicate links are dropped. A new structural link can supply a previously unstated
   parent. When no claim mentions two entities, this call is skipped. Its validated result has a
   separate per-part checkpoint; the extraction checkpoint stays unchanged.
3. **Fold** (code). Claims with the same text and links merge their quotes; entities with the
   same name merge within the lane. A person merges this way only on a full name.
4. **Identity.** Each new entity gets up to 12 candidates: the store's exact keys, names and
   aliases, word and trigram matches, nearest entity vectors, and the job's other entities. A
   unique key match, or an exact name plus a shared neighbour, reuses the existing entity; a
   person is never reused on name alone. Anything else goes to the model in batches of eight:
   reuse a named candidate, new, or uncertain. Three or more entities sharing a leading name
   with no parent become a review question ("Are these part of one Harbor?"). No separate model
   call looks for parents.
5. **Reconcile.** Each claim is compared with up to five existing memories: ones with the same
   link, ones naming the same entities, and near vectors (cosine 0.7 or more), plus earlier
   claims from this lane. Earlier claims rank by same text, shared link pair, cosine at least
   0.7 (highest first), then shared entity. Paraphrases can match without shared entities.
   Same text and links confirm deterministically; otherwise the model picks add, confirm (same
   assertion, nothing new), enrich (same assertion, new supported links), supersede, conflict,
   or resolve an open question. Within one lane, a later claim replaces an earlier one.
   Cosine offers candidates but never decides.
6. **Propose.** At most 300 claims per job: structural links first, then decisions, risks and
   open questions, then the rest; anything held back is recorded. New memories and entity cards
   are embedded and the proposal is stored with the store revision it was computed against.

Parsing drops the smallest invalid item and records why. A bad entity or claim cannot fail a
lane. A bad link is dropped while its claim and known endpoint mentions remain. The first valid
ref wins. Quotes match exactly in the cited segment, then any segment, then with flexible
whitespace, straight/curly quotation marks and no Markdown emphasis marks (backticks, and
asterisks that touch text and are not inside a word or number, so `a*b` and `2 * 3` keep theirs),
by a linear search. Flexible matches store the source's own substring.
Every quote stays within one unelided span. Only unusable JSON or missing entity/claim arrays (or the links array in a links call)
gets one repair call; a second unusable answer fails visibly.

Identity and reconcile keep valid decisions and ask once more for undecided rows alone. The
accepted answer to each prompt is saved, so a retry asks only for rows it still lacks. Still
missing identity decisions become uncertain; missing reconcile decisions become add. Invalid,
duplicate and unoffered decisions cannot fail a lane. An unusable decision envelope gets one
repair call. A call that ends without a usable answer because the provider, the transport or the process
failed retries once after two seconds (`error`, `no-text`, `exit` or `spawn`). Abort, timeout and
output overflow do not retry. The trace keeps the actual failure reason. Each attempt has its own recorded call and input
checkpoint, and both attempts count toward usage.

## Review

A read waiting for review opens in the Inbox under **From lanes**. Its header shows the lane,
“N memories · Q questions · read by <model>” and **See how it was read**, which shows the read
in the same pane with **Back to review**. Claims held back over the read's limit are counted
in one line.

- **Questions** come first. An identity Brain is unsure of reads “Is “Harbor” in this lane
  Harbor?” with the candidate's kind, description, memory and link counts, and buttons:
  **Yes, Harbor**, **Someone new** or **Something new**, and the other candidates. A possible
  group asks “Are these part of one Harbor?” with **Yes, one Harbor** and **No**, which is the
  default.
- One folded line counts the rest: “N people and things matched without doubt · M new people
  and things · K memories confirm what Brain knows”. Opening it lists each match, which can
  still be overruled, and each confirmation.
- **Memories · k of n ticked** groups the proposed memories by type, each group with a checkbox
  for the whole group (including its other pages). A row shows the type, the sentence, the
  names it uses, what it changes, its links (“Rina Okafor → owns → Harbor ledger”) and its
  quotes. Groups page at twenty.
- The fixed bar has **Approve N** (or **Approve k of n**, or **Approve confirmations**; `a`)
  and **Reject read** (`r`). A read again says “Replaces N memories from the last read”.

**Approve** stores the ticked memories, the identity choices and confirmed groups in one
transaction; **Reject** stores nothing. An uncertain entity without a choice becomes new, and only
entities that a saved memory or group uses are created. A confirmed group creates or reuses the
parent and one fact per member ("X is part of Harbor"), quoted as "Stated by you in review". If
Brain changed since the proposal was computed, the review says “Refreshing this review: Brain
changed since it was read.”, recomputes identity and reconcile from the saved extract steps, and
returns to review. With review off, the defaults apply: uncertain becomes new, groups are skipped
and conflicts are saved as disputed.

A superseded memory leaves recall but keeps its history. A disputed pair stays visible on both
sides until one is superseded or forgotten. **Forget** deletes one memory, then any evidence and
entities nothing else uses; entities named only by superseded memories stay.

## Exploring

**Knowledge** is an index, a profile and a map.

- **Index** (left): the search “Search people, things, memories” (`/` focuses it; debounced;
  ↑/↓ and Enter; Escape clears and leaves it) over names, aliases and keys, word and trigram
  matches, then nearest vectors (`brain:find`). Kind chips show All and each populated kind
  with its count, whichever chip is pressed. A result line (“N people and things”) and a sort
  select: **Most connected**, **Recently learned** or **A to Z**; while searching it reads “By
  best match”. Rows are a kind dot, the name and the memory count, thirty at a time
  (`brain:entities`); when Brain changes, the rows already shown reload in one bounded pass.
  While searching, a **Memories** section lists matching memories.
- **Start**: with nothing selected, **Recently learned** lists the twenty newest memories from
  finished reads (`brain:recent`) with lane and time.
- **Profile** (middle): the trail (Back and Forward, also `[` and `]`, and the last three
  steps), the name and kind, **Find route…**, **Merge into…** and a ⋯ menu with **Split…**,
  **Remove a name…** (when there is one), **Edit description…** and **Show on full map**.
  Under them, one line: “13 memories · 10 links · from 3 lanes · last learned 2 days ago”. The
  description follows, then “Also called” with every other name once; names merged in say
  “merged” in place. Tabs: **Memories N**, **Connections N**, **Lanes N**, and **Map** when the
  page is narrow.
  - **Memories**: type chips with counts, a lane select and a state select (Current or Include
    replaced), “N shown · newest first”, then rows: type, the sentence, lane and “said <date>”,
    with disputed called out. A row opens in place with its quotes, the other people and things
    in it, **Open in lane**, **Show on map**, **See the read** and **Forget** (confirmed;
    permanent).
  - **Connections**: one row per relation in plain words from this side (Owns / Owned by, Part
    of / Contains, Works on, Uses, …) with its count, then one button per neighbour with its
    kind dot and how many memories support the connection. Hovering lights it on the map;
    clicking walks there. **Show more** pages each row (`brain:connections`).
  - **Lanes**: each lane its memories came from, with how many it holds, **Its memories**
    (filters Memories to that lane) and **Open lane**.
- **A memory** opened from search or the start page opens inside the profile of the first
  person or thing it names, with that memory open. A memory that names no one stands alone.
- **Map** (right): the selection in the middle and its neighbours around it, one or two steps,
  at most 24 drawn and “+N more” opening Connections. A legend lists the kinds shown. Hovering a
  row lights its node; **Show on map** lights a memory's people and things; clicking a node walks
  there. **Full map** opens the whole graph.
- **Full map** replaces profile and map with the 3D graph. Clicking a node selects it and opens
  an inspector card with **Open profile**; it never walks. The selection chip's ✕ or Escape
  clears it, including the profile's own entity. **Back to profile** (or **Close full map**)
  returns.
- **Find route…**: up to three shortest supported routes to another person or thing, at most
  four steps, each step with its memory (`brain:path`). **Show route N on the map** opens the full
  map with the route lit.
- **Merge into…**: folds this record into another after a typed confirmation that shows both
  descriptions and memory counts. Names, keys, links and memories move; the source is deleted
  and the merge is journaled.
- **Split…** moves the ticked memories (and the links they support) to a new record with its own
  name and kind; at least one memory stays. **Remove a name…** lists the other names; the label
  cannot be removed. **Edit description…** is one field of at most 160 characters. Each sends the
  revision it saw, toasts with Undo, and shows a refusal in the dialog.

The 3D graph keeps its behaviour: selecting keeps the bounded overview (`brain:overview`) drawn,
with the selection, its neighbours and links bright and the rest dimmed. The camera stays put for
an in-view selection in **Whole graph** mode and fits the graph when the selection is outside the
view or new. A memory highlights every named entity and the links it supports. Selected things
outside the overview are included with their neighbours, still capped at 300 nodes: selection
first, then route nodes, direct neighbours and the rest. A notice says when the graph is
truncated. **Neighbours only** switches to one or two steps (`brain:neighbourhood`) and fits that
neighbourhood; clearing resets it. Fit, zoom and 2D/3D remain. The legend lists only present
kinds in the theme's kind colours; the keyboard focus badge sits inside the canvas, clear of the
legend and selection controls. Node labels keep a twelve-pixel height, draw over spheres in front
of them and hide when they would cover a more important label: a selected or hovered label always
shows, then lit nodes, link words and the rest by size. Labels take no pointer hits; nodes and
links do. Directed links show predicate words on selection or hover; hovering a link loads its
supporting memory. On an unselected graph a hover lights the node and its neighbours; with a
selection it lights only the hovered node. Unlinked groups stop repelling at a fixed range.
Reduced motion uses instantaneous camera moves.

Views reload when Brain's revision or generation changes, and a failed load offers Retry.

The two browse reads run in the search worker and keep the browse indexes introduced in **schema v5**:
`brain:entities(kind | null, offset, limit)` accepts limits 1–100, returns entity/count rows,
`more` and populated `kinds`. It walks `entities_connections` in connection-count descending,
row-number ascending order, leaving out memory-less and merged-away rows. Kind filtering may
walk farther; finding populated kinds makes one entity-table pass. `brain:recent(limit)` accepts
1–50, walks at most twenty finished jobs through `jobs_finished`, and reads their active/disputed
memories through `memories_job`, newest read first and recorded time descending within each read.
It stops when full. Memories without a surviving finished job are omitted. `learnedAt` is the
memory's recorded time, not when the source originally said it. These are bounded result sets,
not an assertion that every browse query has constant work at a million memories.

## Inspecting a finished read

A Read row on Lanes, **See how it was read** in a review, or **See the read** on a memory opens
the read. Lanes selects its row when the list has one; an older read outside the newest 200
stays open without a fabricated row. Missing records offer Retry.

The header shows the lane, the model, how long the read took in words and when it finished.
Three counts follow: **kept**, **confirmed what Brain knew** and **left out**. Then the actions:
**Read new messages** reads only what came after this read and is off when nothing came;
**Read again** (finished `done` reads only) reads the whole lane after a confirmation that says
how many earlier memories will be replaced; **Dismiss** removes an empty read; **Open lane**.
**Memories from this lane** opens each memory on Knowledge. **What happened to each claim** lists
each candidate with its outcome and reason, the first twenty with **Show more**; forgotten
memories say “removed”, not a dead link. **How it was read · n calls** has one closed disclosure
per call, named in plain words with part number and duration. Opening one shows the scrubbed raw
output with Copy, the rebuilt prompt and diagnostics, without cost or token counts. Raw output,
prompts and source text each scroll inside a capped box.

**Source lane at extraction** is the scrubbed transcript through the frozen leaf. Records store no
prompt text; a prompt whose inputs are gone says so. Records are kept while their job is in the
inbox or is the latest finished read of its lane, without an age limit. These jobs also keep
step inputs, so finished-read prompts can be rebuilt. Removing or replacing a job deletes its
step inputs. A record without a job survives only while a memory references it, and expires
30 days after it finished; its prompts are unavailable. With neither job nor memory, the record
is pruned immediately.

## Storage

`<userData>/brain/brain.sqlite` (`libs/memory-engine`, schema version 6, WAL) holds settings,
the queue and its saved steps, proposals, extraction records, entities (names, aliases, keys),
memories, mentions, supported relations, citations, evidence, float/sign-bit vectors, Tidy
suggestions, a bounded operation journal, and the saved sweep cursor and run checkpoint.
Full text search covers memories, entity words and entity name trigrams.

Versions 4 and 5 upgrade in place in one transaction. Version 4 first gains the jobs `replaces`
column and lane-memory/finished-read indexes; both versions then gain the Tidy tables and
indexes and become version 6. Knowledge, preferences, jobs and records stay. A failed upgrade
rolls back completely. Version 6 opens without altering its run checkpoint; the runtime owns
interrupted-run recovery. Newer versions are refused. Opening versions 0 to 3 deletes their
knowledge, keeps preferences with review on, and starts a new generation, as **Reset Brain
knowledge** does. The model lives under `<userData>/brain/embeddings`.

### Tidy storage and local sweep

Suggestions have indexed kind, source, state, subject ids, reasons, verdict, reader model and
lane-flag fields. A canonical two-subject pair key does not depend on its suggestion kind;
dismissed and cleared pairs stay suppressed. A flag key combines the memory and lane session;
flag limits are under Tidy checks and lane flags. Missing or superseded memories refuse flags
without changing the revision.
Known states are validated on write; unfamiliar future kinds are omitted from reads.
Suggestion details remain readable after they settle, with only surviving subjects; a removed
suggestion returns null rather than an error. Details include engine-owned `allowed` actions;
apply uses the same guards. Either two-memory suggestion kind supports dispute and replacement.
Folding also requires active memories with no history or dispute. `foldRefusal` distinguishes
applicability from history, and an existing dispute cannot be added twice. Settled or missing
subjects offer no actions.

An approval commits before sweeping its touched records. Entity merges and undo also sweep
changed mention sets. Inside the change, this maintenance sweeps at most 128 touched memories
(lowest row numbers first). The rest lose their fingerprints and wait in memory; after the change
returns, the runtime sweeps them 128 at a time, yielding between batches, refreshing search and
notifying after each, and stopping on dispose or reset. If Phosphor closes first, the missing
fingerprints bring those memories into the next Tidy check: when a whole-Brain pass reaches its last
memory, it reads the memory table in windows of 4,096 rows from a second cursor and sweeps the
active memories that have no fingerprint, 128 per call. The pass is done only when that closing
walk finds none left, so a memory deferred behind the cursor is covered in the same pass. Only a
sweep writes a memory's fingerprint. A sweep failure emits a
warning and does not roll back or report the saved approval/change as failed; running Tidy
again retries local detection. Each whole-Brain
sweep call walks at most 128 entity or memory rows from a saved numeric cursor and fixed pass
watermarks. Coverage reports records visited, totals, limited checks and pass completion, not an
exhaustive comparison of every pair. Name/alias buckets inspect at most 16 candidates, eight
names per entity; a one-word person name also offers full-name token matches. The sweep never
merges entities automatically. Reasons name the matching labels or alias; shared full-name
evidence takes precedence over one-word matches. After a merge, suggestions about the removed
record close, and a bounded sweep reconnects the survivor to remaining matching records and
compares the merged records' memories again.

Near-memory detection uses the four mentioned entities with the fewest memories, plus up to
16 same-kind name-matching siblings for each, through those same bounded name buckets. Each
identity contributes its newest 256 stored memories (numeric insertion order). The sweep scores
those windows by cosine, retains the best 32 candidates across all identities, and offers at
most eight pairs per swept memory at cosine 0.84 or above. Project and branch differences are
shown in the reason, not excluded from comparison. The threshold admits observed 0.86
paraphrases and contradictions while excluding the observed topic-only pairs at 0.80 or below.
Similarity only raises a question, never applies a change. Two memories supporting one link
are not a defect.

A sweep call caches up to 128 entity vector windows in least-recently-used order (about 96 MiB
of vectors); eviction permits a re-read without changing candidates. Folds invalidate the
windows because mentions changed. Limited checks count:

- a memory that mentions more than four people or things;
- more than 16 same-name records offered together as siblings;
- more than eight names on one record;
- more than 256 memories about one person or thing;
- a name shared by more than 16 records.

These are checks cut short, not distinct records or cache evictions. The page shows the count
quietly under coverage and explains that a repeat could be missed there. An older partner beyond
a memory window can be missed. A single memory scores at most 4 × 17 × 256 vectors before the
shared best-32 cut.

Only exact repeats fold automatically: the folded sentence, type, project scope, branch,
validity dates and complete mentioned-entity set must match. Disputed or historical memories
are not automatically folded. Fingerprints are indexed and updated when mentions change;
upgrades create the index empty and the sweep fills it incrementally, not during startup.
Folding preserves the survivor's sentence and unions mentions, citations and supported links;
a copied quote with the same entry id is not independent support. Different scopes, branches
or validity periods cannot be folded.

Every merge, fold, dispute and replacement records a reversible operation. The newest 200
operations retain versioned, validated before-images of changed source rows, with an expected
after-row digest. Unchanged rows an undo depends on are kept as guards: key and digest only,
never a before-image, and never a vector. A fold guards both memories' quotes, mentions, links
and evidence. A merge guards only the memories whose mentions or relations it rewrote: their
rows that name the survivor and their memory links. Float vectors use base64 blobs. Counts, FTS
indexes and sign bits are rebuilt, not journaled. Undo restores only the rows the operation
changed and refuses when later edits prevent a clean restoration; new survivor facts stay.
Added support, mentions or links on a fold's memories refuse its undo rather than lose later
contributions. A merge refuses only when a later write depends on it: a relation or mention
naming the survivor on a memory it rewrote, or a later merge, fold, dispute or replacement on
those records. A later quote, or a mention of someone else, leaves a merge undoable: the
mention goes back to the restored person and the later quote stays. Dispute and
replacement undo preserve independent additions and recompute dispute state from surviving links. Search's normal refresh reloads vectors
restored below its previous watermark. Undo drops its before-images immediately but retains
the operation's one-line record. Undo also remembers the pair as dismissed, including automatic
folds and manual entity merges, so the next sweep does not repeat the undone change.

Forget remains permanent, including knowledge folded into the memory at any depth. Fold
ancestry references survive intervening undo and retention pruning, so Forget redacts all
reachable retained before-images. It deletes suggestions about that memory and preserves only
safe operation ids/labels; an operation whose undo would restore forgotten text becomes unavailable.
Folding scrubs removed subjects' suggestion text (even after undo), while an open lane flag moves
to the survivor if it has no open flag or prior flag from that lane; otherwise it closes. The fold's journal records the move, so undoing the fold puts the flag back on the memory the lane flagged, and Forget of that memory erases its flags wherever they sit. A merge can still be undone for its other memories. Reset erases
all Tidy state as well as the knowledge. These guarantees do not change existing proposal and
extraction-record retention: source transcripts retained for finished reads can still contain
the original statement until those records are removed under the retention rules above.

- Entities (`BRAIN_ENTITY_KINDS`): person, team, organization, project, component, document,
  concept, event. Shared across projects.
- Links (`BRAIN_PREDICATES`): owns, works_on, member_of, part_of, for_customer, documents,
  depends_on, uses, decided, prefers. A memory states any number of
  links and names any number of entities.
- Types (`BRAIN_MEMORY_TYPES`): decision, open, risk, procedure, preference, fact, each recording
  how it is known (observed, reported, inferred), its project, its branch when it only holds
  there, its lane, and its state (active, superseded, disputed).

Extraction enforces these endpoint kinds (`BRAIN_LINK_RULES`). Review can re-point identities
across kinds, so the engine does not enforce these rules.

| Link         | Subject kinds                                  | Object kinds                                           |
| ------------ | ---------------------------------------------- | ------------------------------------------------------ |
| owns         | person, team, organization                     | project, component, document                           |
| works_on     | person, team                                   | project, component, document                           |
| member_of    | person, team                                   | team, organization                                     |
| part_of      | component, project, document, team             | component, project, team, organization                 |
| for_customer | project, component, document, team             | organization                                           |
| documents    | document                                       | project, component, concept, team, organization, event |
| depends_on   | component, project                             | component, project, organization                       |
| uses         | component, project, team, person, organization | component, project, organization, concept, document    |
| decided      | person, team, organization                     | project, component, document, concept, event           |
| prefers      | person, team, organization                     | component, project, concept, document, organization    |

A link needs its own supporting quote. Co-mention and shared name prefixes do not justify links.

Search runs in its own utility process (`brain-search-worker`) with a read-only connection and
the sign-bit index in memory, so scans and walks never block main or the writer. Nearest
neighbours below 2,000 items are exact; above, a Hamming scan keeps the closest 2% (2,000 to
20,000), an asymmetric score keeps 1,000, and exact cosine picks the result. On real
EmbeddingGemma vectors of 60,000 made-up sentences it returns 99.9% of the exact top 10
(recall@10 0.9992, 400 queries); at a million that is extrapolated, not measured.

## Tidy checks and lane flags

A Tidy check (**Check with <model>** in the Inbox) first runs bounded local sweep chunks,
then checks at most forty oldest unjudged pairs, eight per call. It shares the Brain reader queue with lane reads: neither runs beside
another. The check only proposes; it never applies a model verdict. For two memories,
`different` clears and remembers the pair. The model never takes two people or things off the
owner's list: for an entity pair, `different` records the verdict and its reason, keeps the
sweep's reason, and leaves the suggestion open. The page then says "Checked by <model>, which
thinks these are different. Merge only if you know they are the same." and still offers Merge
and Not the same; only Not the same closes it. A pair with a verdict is not sent to the model
again. `conflict` and `replaces` remain for review, with the proposed newer side when
supported. Uncertain answers are `different`, not permission to merge people by name. A
different project or branch alone never decides a verdict: the model judges whether the
assertion is limited to its project or branch or holds anywhere, so two contradicting standing
preferences of one person in two projects are a `conflict`.

The check uses **Model that reads lanes** when pinned, otherwise the model of the newest
finished read whose launch is available. It tries the newest five finished reads for an account
and launch, even with a pinned model; without one it explains why the check was skipped. The
local pass still runs. It uses the same private, tool-less, session-less one-shot path and
600-second timeout as lane reads, with thinking capped at medium and one transport retry.

Only bounded pair evidence leaves this machine, sent to that reader model's provider: memory
sentence, type, dates, project scope, branch, entity names and up to two quotes of 300 characters;
entity names, aliases, kind, description, memory count and up to five neighbours with link words.
It sends neither the whole Brain nor whole lanes. Text is scrubbed and escaped inside a
`background-data` wrapper with no instruction authority. Model reasons and verdicts are stored
with the exact reader model id, not usage or cost figures. Progress is saved between calls.
Cancel stops further calls; an interrupted run retains progress and offers Retry rather than
silently calling a model on startup. A failed batch leaves its pairs unjudged while later
batches continue. Malformed items and unknown handles are dropped and counted; Retry checks
only pairs still without a verdict.

With recall on, **brain_flag** takes `{ ref, problem, reason }`: a memory's bracket number from
the latest search briefing in that lane, `wrong`, `outdated` or `duplicate`, and 1–300 characters
of evidence. The extension retains only that briefing's displayed number-to-id map per session.
Unknown numbers require another search. The server accepts active or disputed memories, one
open flag per memory, at most five open flags per lane session and at most fifty open flags in
the whole Brain; the same lane cannot flag the same memory twice. The local bridge accepts ten
flag requests a minute from all lanes together, so a lane cannot dodge the limits by claiming
another lane's id. It records the claimed lane id and title; the page trusts only the id, to find
the lane in Phosphor's own list. Reasons are
untrusted, bounded data, never instructions. A flag adds a review suggestion, not a knowledge
change. The skill asks agents to flag only user contradictions, verified wrong or outdated
facts, or duplicate recalled memories—never a guess, an agent preference or mere irrelevance.

## Recall

When Brain and recall are on, lane startup (`SessionStartupRuntime.recall`) adds
`PHOSPHOR_BRAIN_ENDPOINT`, `PHOSPHOR_BRAIN_TOKEN`, `-e brain-ext/brain.mjs` and
`--skill skills/brain`. The endpoint is a local socket; the token is random per app run. Recall
never blocks a lane: any failure starts it without Brain. Search stays read-only; flags only
ask the owner to review. Both tools use the version 5 local bridge.

`brain_search(query, limit?)` returns 8 memories by default, up to 20:

- **Seeds.** Entities named by the query (whole-word names, aliases and keys; "Harbor" never
  names Harborview), entities found by words, trigrams and vectors, and the entities of memories
  whose meaning matches (cosine 0.35 or more).
- **Walk.** Two hops out along live links, three for structural ones (part of, for customer,
  owns, member of, documents), at most 200 entities and 400 links, never through an entity with
  more than 200 connections unless the query named it.
- **Ranking.** Reciprocal rank fusion weighs meaning, words, named entities and walked links 2,
  1, 1 and 0.5; the lane's own project counts 1.25 times; freshness only breaks near-ties
  (half-lives: open 30 days, risk 60, decision and fact 180, procedure and preference 365).
  Superseded memories are left out. Without the model or while the index loads, search uses
  words and names and says so.
- **Branch.** The asking lane's branch is read per search; memories that hold only on another
  branch are listed apart.

The tool returns one briefing, never evidence text:

```text
About: Harbor (organization, also Harbor Freight)
Path: Harbor CS workflow part of Harbor [2] → Tom Lee owns Harbor CS workflow [4]
Disputed, both sides shown:
- [1] …
Risks: / Open, may have changed since: / Decisions: / Facts: / How things are done: / Preferences:
- [2] … · harbor (this project) · 2026-11-06, since 2026-10-01
Planned, not in effect yet: / Other branches only:
- …
3 more matches not shown. Search again with a higher limit (up to 20) or a narrower query.
See also: Rina Okafor, Ledger. Search a name to see what Brain holds about it.
```

Each path step cites the numbered memory that states it. Lines give the project, branch, the
date said, and the dates it took effect and ended when known. "50+" stands for a larger cut. It
fits 6,000 characters and is wrapped in `<background-data authority="none">`, with `<` and `>`
escaped so stored text cannot close it. The skill tells agents to search by name or short topic
before "what do we know about…" answers, in unfamiliar areas, before settled decisions and before
writing to someone about a project, to follow See also when it matters, to treat another
project's memories as context, and to report a dispute rather than pick a side.

## Limits

- Extraction quality is the reader model's. Review catches a wrong link or identity; afterwards,
  Forget and Merge into… fix it.
- A merge, fold, dispute or replacement can be undone while its journal is retained and later
  changes permit a clean restoration. Forget is never undone.
- Desktop only, one machine. Nothing syncs between machines or to Hosts.
