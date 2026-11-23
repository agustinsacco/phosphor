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
- **Never read matching lane titles**: title patterns, seeded with `1:1`, `1-1`, `one on one`
  and `1on1`. They match case-insensitively, never inside a longer word or number (`Rina 1-1 prep`
  matches; `2021-11-12` does not). Add or remove up to fifty patterns of eighty characters each.
  The lane menu switches individual lanes (at most 5,000). A failed save retains the draft for retry.
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
sidebar's Brain item show how many decisions wait (“N to decide”: reviews, including those
Brain is refreshing, plus open Tidy suggestions), hidden at zero. The Inbox opens first when something waits; otherwise Lanes
opens when there are jobs but no memories, and Knowledge in every other case. Switching tabs
keeps each tab's selection, the Knowledge trail and the selected read.

One thin status strip under the tabs says what runs now: “Reading <lane> · <step> · N queued”
or, while a review's refresh runs, “Refreshing the review of <lane>”, with a link to Lanes; and
while Tidy checks, “Checking N of M pairs with <model>” with Cancel. It is empty when nothing
runs; a refresh waiting its turn, or one whose answers are all cached and ends at once, may
never show.

The frame stays put and only the panes scroll. Each tab is a list on the left and one thing
in the middle; Inbox and Knowledge add a third column. When the page is about 1060 px wide or
less, the third column goes (Knowledge's map becomes a **Map** tab in the profile), and at
about 700 px or less the panes stack. The sizes are the page's own width, not the window's.

Keys are scoped to the page and ignored in fields, dialogs and menus. `/` focuses the
Knowledge search; ⌘K stays the global command palette.

### Inbox

The left column is the queue, grouped by kind with counts: **From lanes** (reads to review),
**Same person or thing?**, **Said twice**, **These disagree** and **Flagged by a lane**. Empty
groups disappear. Each row is a title and one line: “2 memories to review · read again”,
“Refreshing · Brain changed since it was read” for a review Brain is recomputing, or a
suggestion's reason. The queue loads the newest twenty suggestions; a kind shows its header and
count even before any of its rows has loaded, and **Show N more** under it loads up to twenty
more of that kind (`brain:tidy` with the kind), which later reloads keep. With nothing waiting
it says “Nothing to decide.” and how decisions arrive. `j` and `k` move the selection, `a`
takes the decision's primary action and `r` rejects a review; ↑ and ↓ move focus between rows.
After a decision the next item opens: the one after it, else the one before. A reload never
swaps the open suggestion for another: when newer suggestions push it beyond the loaded rows it
stays open, last in its group, until it is applied, dismissed or cleared.

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

The left column lists reads by state, each group with its count: **Reading**, **Refreshing**,
**Queued**, **Failed** and **Read** (the newest 200 finished reads, newest first, a row per
read, so a lane read twice has two; rejected and empty reads join them; it says when there are
more). Rows are the lane's title and one line: the reported step and how long it has run,
“Refreshing for 2 min” (or “Waits to refresh” before its attempt starts), the queue position
(“Queued 2 h ago · 1 ahead”, where a waiting refresh counts as ahead), the error, or
“2 memories from this read · 5 min ago”: what that read kept that is still in Brain, so an older
read that Read again replaced says 0. An empty read says “Nothing worth keeping” and a rejected
one “Rejected”. Times are words (“3 min”, “1 h 20 min”), never a clock, and come from the
current attempt (`runStartedAt`): a resumed, retried or refreshed read never counts from its
first start, and no time is negative. **Recent changes** follows: the newest fifty Tidy journal
operations with who made them (Automatic or By you), when, and **Undo**. **Never read** ends the
list with one row, “2 title patterns · 1 lane switched off”. With nothing read it says
“Right-click a lane and choose Queue for knowledge extraction.” A review waiting for the owner
is not here; it belongs to the Inbox. While Brain refreshes one, it is listed under Refreshing
as well.

The middle column shows the selection. A reading job shows its model and step list (Prepare,
Read the conversation (part x of y), Match people and things, Compare with what Brain knows,
Index) and Cancel; a failed one shows the whole error with **Retry** and **Dismiss**. Both
show the calls made so far, the claim outcomes and **Source lane at extraction** once a record
exists, and “No calls yet.” before. A refreshing review says Brain changed since the lane was
read, that there is nothing to do, and that the review opens in the Inbox once it is ready; it
has no Cancel. **Never read** shows the title patterns in words (“A lane whose title contains
“1:1”, “1-1”, “one on one” or “1on1”, in any case and not inside a longer word or number”), how
many lanes are switched off one by one, and **Change in Settings**, which opens Settings ›
Brain. A finished read is described under Inspecting a finished read. A change shows what it did, who, when, and Undo or when it was undone. A read asked for
by id that the list does not show stays open; a listed read that disappears moves the
selection on.

## Queueing a lane

Right-click a local lane and choose **Queue for knowledge extraction** when Brain has never
read it, or **Read new messages for Brain** after a finished read. A queued, waiting or
running lane offers **Cancel knowledge extraction** instead. The queue
(`libs/brain-runtime/src/queue.ts`) runs one lane at a time and only while the embedding model
is ready. A lane whose agent is working (`SessionActivity.busy`) waits until it is idle. A
lane with nothing new since its newest finished read (`done`, `empty` or `rejected`) is
refused with “Nothing new in this lane since its last read.” Queue reads only entries after
that read's leaf, regardless of extractor version. Use **Read again** to apply a newer
extractor from the beginning. A failed job shows **Retry**, which requeues the same job and
resumes from its saved steps. If a later read of that lane exists, Retry refuses; Dismiss
remains available. The incremental cursor follows queue order, not completion order, so an
older read finishing late never moves it backwards. Jobs left running when the app quit resume
where they stopped.

### Lanes Brain never reads

Both Queue and Read again refuse an excluded lane. Title rules use the current name from the
lane file, or the sidebar's first-prompt title when unnamed, never a title supplied by the UI.
Brain stores an empty lane's title as empty, and the page shows it as “Untitled lane”
(`brainLaneTitle` in `features/brain/laneTitle.ts`, used wherever a read's or a memory source's
title appears), so no title rule ever matches that placeholder. A job's stored title follows the
lane: Queue, the start of a read, the stale-review check and opening a review store the lane's
current name when it changed. Storing a title never changes the knowledge revision, so it never
stales or refreshes a review. Changing the rules cancels an excluded lane's queued and
waiting jobs, not its pending review; the Inbox still offers that review, with Reject as its
primary action. Those jobs are checked against the titles Brain remembers, reading only a lane
file that changed since. A waiting lane renamed to a matching title, with no rules change, is
dropped when its read starts, before any model call. Refresh also skips excluded lanes using their current names. A stale review
can always be rejected, because rejection saves nothing; approving one that cannot be refreshed
asks you to reject it instead. If neither the stored transcript nor its `.archived` twin
exists, the pending review stays in the Inbox and any waiting refresh returns to review; Brain
makes no model call and does not offer a failing Retry. Its stored proposal still opens for
inspection and Reject works. Approve is refused with “This lane was deleted, so this review
can't be refreshed. Reject it.” Recall is unaffected. A title-rule match takes precedence in the lane menu:
**Brain never reads this lane (title rule in Settings › Brain)** is disabled, with no Queue or
per-lane switch that could falsely promise to override the title rule. A lane excluded only by
its id offers **Let Brain read this lane**, with no Queue. Other lanes offer their ordinary
Queue/New messages action and **Never let Brain read this lane**. Removing an id never overrides
a title rule.

## Read lanes and Read again

The **Read** section of Lanes shows the newest 200 finished reads and says when more exist.
Brain retains up to twenty finished reads per lane, with each read's leaf, cursor, saved steps
and extraction record. Each row counts only the current (active or disputed) memories produced
by that read. Its Read again count remains lane-wide: every unshared memory from the lane,
including older reads. After replacement, older rows can show zero; they stay in history.
Rejected reviews remain as `rejected` (nothing saved); a read with nothing worth keeping
remains `empty`. The next queue continues after either, as after approval. The list reloads
when jobs or knowledge change; a failed load has Retry. Model names match the picker;
unavailable names fall back to the id without its provider prefix. A row opens the finished
read in the same pane.

**Read again** in a finished read reads the whole lane, even if nothing changed.
It confirms how many earlier memories will be replaced. Memories another lane also supports
are kept. The lane must still be readable and have no queued, running or review job. Busy lanes
wait as usual; leaf and model freeze at first start. Retry keeps the replacement intent.

Earlier memories remain searchable while the new read runs and waits for review. Reconcile
excludes the memories this read will replace; entity identity still reuses shared entities.
Approval saves the checked candidates and removes the earlier, unshared memories from that
lane in one transaction, including memories from older reads whose job rows are gone. Partial
approval, or approval with no candidates checked, still replaces them. With review off, saving
happens immediately. A citation or relationship supported by a different lane protects its
memory unchanged. Entries a fork copied from its source lane are the same evidence, not
another lane's support; a message written in the fork is. Replacing bumps the revision once.
If the search index fails to refresh after an automatic save, the read still ends as done and
the failure is logged. A rejected, cancelled or permanently failed reread removes no
knowledge. An **empty** reread (nothing kept) also removes nothing. Rejecting or dismissing a
reread keeps the earlier finished read in history. Successful saving keeps both finished reads
in the bounded history.

## Reading a lane

Brain reads archived lanes too: when the stored transcript path is missing, it reads only that
path's `.archived` twin in the same folder. This applies to queued reads, review refreshes,
current-title exclusions and the source shown in a read's record; it never searches for another
transcript. When neither file exists, a read with no review yet fails with “This lane was
deleted, so Brain can't read it.”, and a pending review stays in the Inbox as described under
Lanes Brain never reads.

Brain parses a lane file only when it needs the transcript or the file changed
(`libs/brain-runtime/src/lane-files.ts`). It remembers each lane's current title, in memory,
with the size and modification time of the file it read (the stored path or its `.archived`
twin). Queue reads the lane once to check it. A read reads it once more when it starts: the
start check reads only a file that changed since, and hands that transcript to the read
instead of reading it again. A waiting read is not checked while its lane is busy, so the
queue's two-second wait for a busy lane reads nothing. A stale review is checked on every queue
pass, but an unchanged file is not read again, and a pass that changes nothing notifies
nobody. Opening a stale review reads its lane at most twice: once to check its current title
when the file changed, and once to refresh it.

A job freezes the lane's leaf, chosen reader model, thinking level and git branch when it first
starts. A resume never moves them. It then reads the lane's path to that leaf, applies pi's
`context_edit` entries, and keeps only user and assistant text. Tool calls, tool output,
custom messages, branch summaries and compaction summaries are not evidence. Every segment is
scrubbed of secrets, email addresses and phone numbers before any prompt. User messages longer
than 6,000 characters keep their first 4,000 and last 1,900 around an explicit
`[… N chars omitted …]` marker. Assistant text is never elided. No quote may cross a marker.

An incremental read begins after its previous leaf with two earlier segments marked **context
only**. Claims supported only by those overlap segments are dropped and recorded, even if the
reader proposes them. If the lane branched, it starts after the deepest common ancestor and
records that fallback; if no shared ancestor remains, it starts at the beginning. The newest
sixty current lane memories are frozen as **Already kept** context for the first and later
parts. Reconcile still compares claims against all of Brain. **Read again** has no cursor and
reads the entire selected path.

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
   claim that passes, up to 25, a ceiling rather than a target (most parts keep fewer than ten);
   an empty answer is valid only when nothing passes. Extra claims are dropped with a recorded
   reason, and a part that returns exactly 25 gets a noted outcome. No kind of claim ranks
   first. The model looks for people and structure (who is on which team, who leads, owns or
   decides what, which customer a project is for), how systems, vendors, data and customers
   behave, decisions with reasons, preferences and corrections, reusable procedures, remaining
   risks and open questions for a named person or team. A standing role passes; a ticket event
   does not. Status, one-off events, near-term plans and dates, facts stated "as of" now, pull
   requests, code facts, file paths, the assistant's work log, instructions for one task,
   unaccepted proposals, corrected statements, generic advice, personal matters about a person
   (health, family, pay, leveling, promotion and calibration, performance, conduct, feelings or
   morale, leave or absence, feedback about how they work, and anything from a one-on-one about
   the person in it), secrets and contact details do not pass; the prompt gives a made-up
   example of each personal kind.
   It returns lasting entities (`n1…`), self-contained claims (`c1…`) with one or two quotes,
   typed links with their own quotes, and parent assessments for new projects, components,
   documents and teams. A stated parent needs a kept structural link whose subject is that
   entity. Missing or invalid parent assessments mean not stated. People are humans, never
   agents or bots. Pull requests, tickets, commits, branches and files are not entities, nor are
   database tables, feature flags, service accounts, scheduled jobs or contract clauses unless
   people discuss one as a thing someone owns. The model is asked for every lasting relationship
   the conversation shows between a kept claim's entities, for member_of whenever a claim names
   a person and their team, and for leads when a person leads a team or project (leading is not
   owning). A link sits on a claim that mentions both ends, and its quote may come from any
   segment. A person is linked only for a real role, never to a tool they merely use. Claims
   call the user by name when the conversation gives it: the model then adds the user as a
   person entity marked as the user. A part that marks more than one person marks none, and
   later parts learn the mark from the entities they are offered. Parsing turns a leading "The
   user" or "The user's" into that name and adds the mention once; with no marked person the
   sentence stays as written. The mark never reaches identity or review. A claim the model kept
   although unsure comes back held, temporary or personal, and fixed rules add holds that only
   mark, never drop, both when a part is parsed and when the proposal is assembled (so a refresh
   that reuses parts read before holds existed marks them too): personal for a claim naming a
   person that speaks of promotion, calibration, leveling or L1–L9, being upset, absence, leave
   (on, taking, parental or sick leave) or vacation, or their performance next to a review or
   within a few words of expectations, a review, an improvement plan or a PIP (never after a
   technical word, as in "query performance"); temporary for "as of", "currently", "still",
   "for now", "for the time being", "temporarily", "this week", "this sprint" or "this
   quarter", "until" a weekday, a month, a date or "further notice", a ticket or pull request as
   its subject, or a date (in the sentence or its validity) within 60 days after it was said.
   Whole words only: "distillation", "until marketing" and "until Kestrel 2.1" mark nothing. The answer rules are repeated after the
   conversation, because a long one buries them.
2. **Links**, after each part's extraction. The model sees only kept claims that mention two or
   more entities, those entities, existing links and short excerpts around each claim's quotes.
   Each excerpt stays in its segment, stops at an elision marker and adds at most 600 characters
   on each side. Overlapping excerpts merge. Links join two entities the claim already mentions,
   obey the same endpoint-kind rules and need their own verified quote from a claim excerpt's
   segment; a person named with their team is linked member_of it. Duplicate links are dropped.
   A new structural link can supply a previously unstated parent. A fixed filter then runs over
   both calls' links: it drops a uses or prefers link from the user, and a works_on link beside
   owns for the same pair in one claim, each with a recorded outcome. When no claim mentions two
   entities, this call is skipped. Its validated result has a separate per-part checkpoint; the
   extraction checkpoint stays unchanged.
3. **Fold** (code). Claims with the same text and links merge their quotes; entities with the
   same name merge within the lane. A person merges this way only on a full name.
4. **Identity.** Each new entity gets up to 12 candidates: the store's exact keys, names and
   aliases, word and trigram matches, nearest entity vectors, and the job's other entities. A
   unique key match, or an exact name plus a shared neighbour, reuses the existing entity; a
   person is never reused on name alone. Anything else goes to the model in batches of eight:
   reuse a named candidate, new, or uncertain. Three or more entities sharing a leading name
   with no parent become a review question ("Are these part of one Harbor?"). No separate model
   call looks for parents.
5. **Reconcile.** Each claim is compared with up to five candidates: existing memories that
   state the same link or own the same thing, near vectors (cosine 0.7 or more), the newest 128
   memories of each entity it names, and earlier claims from this lane. They rank together by
   evidence strength: same text and links, same text, a shared link (the same subject,
   predicate and object, or another owner of the same thing; `uses(Harbor, Ledger)` does not
   count for `depends_on(Harbor, Ledger)`), cosine at least 0.7 (highest first), and then a
   shared entity alone, ranked by
   similarity to the claim rather than recency, so a busy person's newer memories cannot hide a
   close one. Paraphrases can match without shared entities. A superseded memory among those
   entities' newest memories at cosine 0.85 or more is offered too, marked replaced earlier, so
   a read cannot bring back a memory the owner or a later read replaced. Same text and links
   confirm deterministically; otherwise the model picks add, confirm (same assertion, nothing
   new), enrich (same assertion, new supported links), supersede, conflict, or resolve an open
   question. A claim that repeats a replaced memory (the model says so, or its text and links
   equal it and no current memory's do) is dropped, and the outcome says "Repeats a memory that
   was replaced earlier". A claim answered add whose own sentence says it supersedes, replaces
   or no longer holds something, while something it could change was offered, is asked about
   once more with a short correction on its row; if the answer still adds, it is kept and a
   noted outcome says so. Within one lane, a later claim replaces an earlier one. Cosine offers
   candidates but never decides.
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
  **Yes, Harbor**, **Someone new** or **Something new**, and the other candidates. A
  **required** question (exactly one stored record of that kind goes by this name, as its
  label or another name in any case, and Brain is not sure it is the same one) comes first, says **Needs an answer** and has no default. A possible
  group asks “Are these part of one Harbor?” with **Yes, one Harbor** and **No**, which is the
  default.
- When the chosen existing record is described differently by this read, both descriptions show
  with **Use this read’s description for <name>**, unticked. Ticked, approval replaces the stored
  description (`decision.descriptions`) and the record's vector with the one computed for the
  read's description, so identity candidates and semantic search compare against the new
  meaning; switching that identity to Someone new drops it.
- One folded line counts the rest: “N people and things matched without doubt · M new people
  and things · K memories confirm what Brain knows”. Opening it lists each match, which can
  still be overruled, and each confirmation. Only confirmations that are not held count there:
  they add their quotes with any approval.
- **Memories · k of n ticked** groups the proposed memories by type, each group with a checkbox
  for the whole group (including its other pages). A row shows the type, the sentence, the
  names it uses, what it changes, its links (“Rina Okafor → owns → Harbor ledger”) and its
  quotes. Groups page at twenty. **Probably temporary** (status, near-term plans and one-off
  instructions) and **About a person** (remarks about a named person beyond their role) come
  last, unticked, each saying “Not kept unless you tick it”. A held confirmation (this lane
  says again what a stored memory says) sits in its held group as “Confirms “<memory>””;
  ticked, it is sent in `decision.confirmations` and its quote is added to that memory.
- The fixed bar has **Approve N** (or **Approve k of n**, counting held confirmations, or
  **Approve confirmations** when the read has no new memories and nothing is ticked, so only its
  ordinary confirmations apply; `a`) and **Reject read** (`r`). Approve is off with “Answer 1 question” while a required question
  is open. A read again says “Replaces N memories from the last read”; a read of a lane Brain
  read before says “Reads new messages only”.
- A review of a lane the never-read rule matches (its current title, which opening the review
  reads from the lane file, or its own switch, checked by `brainLaneNeverRead`) starts with “You set Brain to never read this lane. Reject to discard
  this read.” **Reject read** becomes the primary button and `a` rejects.
- A refusal shows in the action bar beside **Reject read**, and the ticks and answers stay. The
  review reloads only on the two exact refusals that mean it is being recomputed
  (`BRAIN_REVIEW_REFRESHING`, `BRAIN_REVIEW_CHANGED` in `@phosphor/shared/brain-review`); a
  stale review that cannot refresh (a never-read or deleted lane) keeps its refusal in place.

**Approve** stores the ticked memories, the identity choices and confirmed groups in one
transaction; **Reject** stores nothing. A held claim is saved only when ticked, and a held
confirmation adds its quote, or becomes a new memory, only when ticked; ticking a confirmation
that is not held is refused (“Brain confirmation choice is invalid.”). Approval that saves
anything naming a required identity waits for its answer: “Say whether “Rina Okafor” is someone
Brain already knows or someone new before approving.” Any other uncertain entity without a choice
becomes new, and only entities that a saved memory or group uses are created. A reused record keeps
its stored description unless the owner chooses the read's description for it. A confirmed group
creates or reuses the parent and one fact per member ("X is part of Harbor"), quoted as "Stated by
you in review". If knowledge changed since the proposal was computed, the review says “Refreshing
this review: Brain changed since it was read.” It stays a review (`refreshing`), retains its
previous memory count, and recomputes identity and reconcile from saved extract and links steps. A
refresh never sends the conversation to the model again; it asks again only the questions whose
inputs changed. Even after an extractor prompt upgrade it reuses validated source windows by part
name whenever the read has a stored proposal or prepare checkpoint, including Retry and interrupted
pre-upgrade recomputes; missing windows are read normally. New reads and Read again create new jobs
without saved source windows. An upgrade may change a decision's candidate format, so its first
refresh can ask that changed identity or reconcile question again, but never re-extracts saved
windows. The queue refreshes stale reviews in the background, oldest first, before new reads. A
finished refresh never changes knowledge. The internal `knowledge_revision` counter tracks memories,
entities, names, aliases, descriptions, links, states and merges; Tidy suggestions, verdicts,
dismissals, flags, coverage and run state change only the general revision used by the explorer and
Tidy guards. Approval uses the knowledge guard too. Accepted identity and reconcile answers are
keyed by their complete prompt, not either revision: unchanged questions, including answers saved by
older apps, never call the model again. A changed candidate changes only the prompt that contains
it. The job's `startedAt` is its first start, and `runStartedAt` is the current attempt (null while
not running or refreshing). A read's duration is the time the model spent on this read's calls:
their traced times added up, the questions a refresh asked again included. Stages run one call at a
time, so nothing is counted twice. It is never the gap between the first start and the last save,
which counts waits, refreshes and app quits. With no calls, or a call without a trace, no duration
is shown. With review off, the defaults apply: held claims and held confirmations are not saved,
uncertain becomes new, groups are skipped and conflicts are saved as disputed; a read with a
required question stays in the Inbox. A confirmation whose identity the owner changed is saved as a
new memory, unless it is held and unticked.

A superseded memory leaves recall but keeps its history. A disputed pair stays visible on both
sides until one is superseded or forgotten. **Forget** deletes one memory, then any evidence and
entities nothing else uses; entities named only by superseded memories stay.

## Exploring

**Knowledge** is an index, a profile and a map.

- **Index** (left): the search “Search people, things, memories” (`/` focuses it; debounced;
  ↑/↓ and Enter; Escape clears and leaves it) over names, aliases and keys, word and trigram
  matches, then nearest vectors (`brain:find`). Its memories are the top of the ranking
  `brain_search` uses (see Recall), read as an agent with no project would: the same order, up
  to the requested limit (at most 50). People and things matched by name, alias or key come
  first. Kind chips show All and each populated kind
  with its count, whichever chip is pressed. A result line (“N people and things”) and a sort
  select: **Most connected**, **Recently learned** or **A to Z**; while searching it reads “By
  best match”. Rows are a kind dot, the name and the memory count (current memories only:
  active and disputed, as everywhere a count is shown), thirty at a time
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
    clicking walks there. **Show more** pages each row (`brain:connections`). Each button is one
    neighbour within a relation and direction, carrying its newest link and how many memories
    support it; row counts count distinct neighbours, and the profile's link count counts
    distinct (neighbour, relation) pairs.
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
  revision it saw, toasts with Undo, and shows a refusal in the dialog. In the engine:
  - **Describe** (`brain:describe`) replaces the description: trimmed, scrubbed, 1–160 characters.
  - **Remove a name** (`brain:removeName`) removes one alias, never the label.
  - **Split** (`brain:split`) moves 1–200 chosen memories, all naming the record, to a new record
    with the owner's label (1–80 characters) and kind: their mentions and the links they support
    go with them. The original keeps the rest, its aliases, keys and merge history. Splitting off
    every current (active or disputed) memory is refused (that is a rename), and the two records
    are remembered as separate. A superseded memory moves only when chosen; one left behind stays
    on the original, and undoing the split never touches it.
  - Each takes the revision like a merge, refuses a stale one, and is journaled with a one-line
    Recent changes summary and Undo.

The 3D graph keeps its behaviour: selecting keeps the bounded overview (`brain:overview`) drawn,
with the selection, its neighbours and links bright and the rest dimmed. The camera stays put for
an in-view selection in **Whole graph** mode and fits the graph when the selection is outside the
view or new. A memory highlights every named entity and the links it supports. Selected things
outside the overview are included with their neighbours, still capped at 300 nodes: selection
first, then route nodes, direct neighbours and the rest. `brain:overview` and
`brain:neighbourhood` payloads carry at most 300 nodes and 1,500 links: one link per pair and
link word (the newest read), from at most eight neighbours per link word and direction per node
(one slot per neighbour, so a pair said many times hides no other), centre first. A hub's
neighbourhood on a million-memory Brain is about 70 KB. A notice says when the graph is
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
`brain:entities(kind | null, offset, limit, sort)` accepts limits 1–100, returns entity/count rows,
`more`, populated `kinds`, `counts` per populated kind (whatever the kind filter) and `total`
for the filter, leaving out memory-less and merged-away rows. Finding the kinds and counts makes
one entity-table pass. Sorts:

- `connected` walks `entities_connections`: connection count descending, then row number.
- `name`: label case-insensitively, then id.
- `recent`: the newest current memory naming the entity, newest first; ties and entities with
  none by row number. It reads current memories newest first through `memories_recent` and stops
  once it has the page, so work grows with the offset, not the Brain. A kind whose entities hold
  at most 20,000 current memories is ordered from their own mentions instead.

On the 100,000-entity, million-memory benchmark Brain each sort's first page, a page at offset
2,000 and a rare kind each take 15–25 ms warm. `brain:recent(limit)` accepts
1–50, walks at most twenty finished jobs through `jobs_finished`, and reads their active/disputed
memories through `memories_job`, newest read first and recorded time descending within each read.
It stops when full. Memories without a surviving finished job are omitted. `learnedAt` is the
memory's recorded time, not when the source originally said it. These are bounded result sets,
not an assertion that every browse query has constant work at a million memories.

## Inspecting a finished read

A Read row on Lanes, **See how it was read** in a review, or **See the read** on a memory opens
the read. Lanes selects its row when the list has one; an older read outside the newest 200
stays open without a fabricated row. Missing records offer Retry.

The header shows the lane, the model, how long the read took in words (the time the model spent
on this read's calls; none without calls or when a call has no trace) and when it finished.
Three counts follow: **kept**, **confirmed what Brain knew** and **left out**; a rejected read
says “Rejected · nothing was saved” instead and has no memories to see. **Covered** says what
the read took in: “Whole lane”, or “New messages after <date and time>” of the read it
continues, or “New messages since the previous read” when that read is no longer listed. Then
the actions: **Read new messages** reads only what came after this read and is off when nothing
came; **Read again** (finished `done` reads only) reads the whole lane after a confirmation that
says how many earlier memories will be replaced; **Dismiss** removes an empty read; **Open
lane**. **See these memories · N memories**, closed at first, opens each memory on Knowledge (a
review's **See how it was read** shows the same list open, as **Memories from this lane**).
**What happened to each claim** lists each candidate with its outcome and reason, the first
twenty with **Show more**; forgotten memories say “removed”, not a dead link. A remark about the read that keeps
and drops nothing shows as “noted” and counts in none of the three. **How it was read
· n calls** has one closed disclosure per call, named in plain words with part number and how
long it took in words (“42 s”, “3 min”), never a clock. Opening one shows the scrubbed raw
output with Copy, the rebuilt prompt and diagnostics, without cost or token counts. Raw output,
prompts and source text each scroll inside a capped box.

**Source lane at extraction** is the scrubbed transcript through the frozen leaf. Records
store no prompt text; a prompt whose inputs are gone says so. Records are kept while their job
is in the inbox or is one of its lane's twenty retained finished reads, without an age limit.
These jobs also keep step inputs, so finished-read prompts can be rebuilt. Removing or
replacing a job deletes its step inputs. Records displaced by the twenty-read cap are deleted
with their jobs. Any other record without a job survives only while a memory references it,
and expires 30 days after it finished; its prompts are unavailable. With neither job nor
memory, the record is pruned immediately.

## Storage

`<userData>/brain/brain.sqlite` (`libs/memory-engine`, schema version 7, WAL) holds settings,
the queue and its saved steps, proposals, extraction records, entities (names, aliases, keys),
memories, mentions, supported relations, citations, evidence, float/sign-bit vectors, Tidy
suggestions, a bounded operation journal, and the saved sweep cursor and run checkpoint.
Full text search covers memories, entity words and entity name trigrams.

Versions 4 and 5 upgrade in place in one transaction. Version 4 first gains the jobs
`replaces` column and lane-memory/finished-read indexes; both versions then gain the Tidy
tables and indexes and become version 6. Versions 4, 5 and 6 then gain nullable job columns
`from_leaf` and `run_started_at` and become version 7. Knowledge, preferences, jobs and
records stay. A failed upgrade rolls back completely. Version 7 opens without altering its run
checkpoint; the runtime owns interrupted-run recovery. Newer versions are refused. An older
app refuses a version 7 Brain; it never resets it. Opening versions 0 to 3 deletes their
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
subjects offer no actions. A same person or thing pair whose records share a name also allows
`unname` while one of them holds that name as an alias: it removes the name from that record
(never its label), closes the pair as not the same, and is undoable like **Remove a name**.
Every refusal is an error carrying one plain sentence the page shows; a stale revision is
"Brain changed; refresh Tidy and try again." and writes nothing.

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
exhaustive comparison of every pair; the cursor's own fields never leave the engine. A pass in
progress reports the totals it set out to check; a finished pass reports today's memory and
entity counts, because every memory saved since is swept as it lands or by the maintenance batches
right after. Name/alias buckets inspect at most 16 candidates, eight
names per entity; a one-word person name also offers full-name token matches. Records pair with
their own kind, except that an exact name (folded label or alias) also pairs a component, an
organization and a project with one another, because lanes store one vendor or system under
different kinds: "Same name, stored as a component and as an organization." A merge keeps the
survivor's kind. The sweep never merges entities automatically. Reasons name the matching labels
or alias; shared full-name evidence takes precedence over one-word matches. After a merge, suggestions about the removed
record close, and a bounded sweep reconnects the survivor to remaining matching records and
compares the merged records' memories again.

Near-memory detection uses the four mentioned entities with the fewest memories, plus up to
16 name-matching siblings for each, through those same bounded name buckets. Each
identity contributes its newest 256 stored memories (numeric insertion order). The sweep scores
those windows by cosine, retains the best 32 candidates across all identities, and offers at
most eight pairs per swept memory at cosine 0.84 or above. Project and branch differences are
shown in the reason, not excluded from comparison. The threshold admits observed 0.86
paraphrases and contradictions while excluding the observed topic-only pairs at 0.80 or below.
Similarity only raises a question, never applies a change. Two memories supporting one link
are not a defect.

A near pair whose negation words differ in number (no, not, never, without, cannot, n't,
instead of) is offered as **These disagree** with the reason "These may disagree.", and goes to
the model check like any unjudged pair. Below 0.84 the sweep queues pairs **only for the model
check**:

- a possible disagreement: two facts, two decisions or two preferences from different lanes or
  projects, at cosine 0.6 or above, sharing at least two people or things (disagreements across
  lanes usually score 0.55–0.75);
- a looser paraphrase: any pair at 0.75 or above sharing at least two people or things.

These are stored as kind `unchecked` and appear on no page, count, badge or action until the
model answers: `same` shows the pair as **Said twice**, `conflict` or `replaces` as **These
disagree**, and `different` clears it quietly. A surfaced pair counts as new from that moment. A
memory queues at most two, one sweep call at most sixteen, and at most 400 wait unjudged; a
fuller queue leaves the rest for the next pass and counts them as limited checks.

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

Every merge, fold, dispute and replacement, and every entity edit (split, removed name,
description), records a reversible operation. An entity edit captures only the tables it
changes: a description only the record, a removed name only its names, a split its moved
mentions and links and the record it created. The newest 200
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
the operation's one-line record. Undoing a merge, fold, dispute or replacement also remembers the
pair as dismissed, including automatic folds and manual entity merges, so the next sweep does not
repeat the undone change. Undoing a split deletes the record it created last, keeps quotes added
to the moved memories since, and refuses when anything written later names the new record; a
constraint a later change introduced becomes the same plain "Later changes" refusal.

Forget remains permanent, including knowledge folded into the memory at any depth. Fold
ancestry references survive intervening undo and retention pruning, so Forget redacts all
reachable retained before-images. It deletes suggestions about that memory and preserves only
safe operation ids/labels; an operation whose undo would restore forgotten text becomes unavailable.
That includes a description, name or merge label in any retained before-image that quotes the
forgotten memory, whichever operation holds it.
Folding scrubs removed subjects' suggestion text (even after undo), except on the suggestion the
fold applies, which keeps its reason, so its settled detail still shows the model's sentence. An
open lane flag moves to the survivor if it has no open flag or prior flag from that lane; otherwise it closes. The fold's journal records the move, so undoing the fold puts the flag back on the memory the lane flagged, and Forget of that memory erases its flags wherever they sit. A merge can still be undone for its other memories. Reset erases
all Tidy state as well as the knowledge. These guarantees do not change existing proposal and
extraction-record retention: source transcripts retained for finished reads can still contain
the original statement until those records are removed under the retention rules above.

- Entities (`BRAIN_ENTITY_KINDS`): person, team, organization, project, component, document,
  concept, event. Shared across projects.
- Links (`BRAIN_PREDICATES`): owns, works_on, member_of, part_of, for_customer, documents,
  depends_on, uses, decided, prefers, leads (a person leads a team or project; read “leads” from
  the person and “led by” from the team or project). A memory states any number of links and
  names any number of entities.
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
| leads        | person                                         | team, project                                          |

A link needs its own supporting quote. Co-mention and shared name prefixes do not justify links.

Search runs in its own utility process (`brain-search-worker`) with a read-only connection and
the sign-bit index in memory, so scans and walks never block main or the writer. Nearest
neighbours below 2,000 items are exact; above, a Hamming scan keeps the closest 2% (2,000 to
20,000), an asymmetric score keeps 1,000, and exact cosine picks the result. On real
EmbeddingGemma vectors of 60,000 made-up sentences it returns 99.9% of the exact top 10
(recall@10 0.9992, 400 queries); at a million that is extrapolated, not measured.

## Tidy checks and lane flags

A Tidy check (**Check with <model>** in the Inbox) first runs bounded local sweep chunks,
then checks at most forty unjudged pairs, eight per call: every visible suggestion first, oldest
first, and only then pairs queued for the model alone, so those never take a visible
suggestion's place. It shares the Brain reader queue with lane reads: neither runs beside
another. The check only proposes; it never applies a model verdict. For two memories,
`different` clears and remembers the pair. The model never takes two people or things off the
owner's list: for an entity pair, `different` records the verdict and its reason, keeps the
sweep's reason, and leaves the suggestion open. The page then says "Checked by <model>, which
thinks these are different. Merge only if you know they are the same." and still offers Merge
and Not the same; only Not the same closes it. A pair with a verdict is not sent to the model
again. `conflict` and `replaces` remain for review as **These disagree**, with the proposed newer
side when supported, and `same` on two memories as **Said twice**. Uncertain answers are `different`, not permission to merge people by name. A
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
entity names, aliases, kind, description, memory count and up to five distinct neighbours with link
words.
It sends neither the whole Brain nor whole lanes. Text is scrubbed and escaped inside a
`background-data` wrapper with no instruction authority. Model reasons and verdicts are stored
with the exact reader model id, not usage or cost figures. Progress is saved between calls.
Cancel stops further calls; an interrupted run retains progress and offers Retry rather than
silently calling a model on startup. The run records the exact model it used (`model`). A
verdict counts as checked only when it was recorded: a pair the owner settled, merged or forgot
while the model read it counts in `settled` instead, and the run says "Checked 11 pairs; you
settled 1 while it ran." A failed batch leaves its pairs unjudged while later
batches continue. Malformed items and unknown handles are dropped and counted; Retry checks
only pairs still without a verdict.

With recall on, **brain_flag** takes `{ ref, problem, reason }`: a memory's bracket number from
the latest search briefing in that lane, `wrong`, `outdated` or `duplicate`, and 1–300 characters
of evidence. The owner retains only the displayed number-to-id map for that live lane.
Unknown numbers require another search. The server accepts active or disputed memories, one
open flag per memory, at most five open flags per lane session and at most fifty open flags in
the whole Brain; the same lane cannot flag the same memory twice. Brain accepts ten
flag requests a minute from all lanes together. The owner supplies the session id and title,
never the tool. The page uses the id to find the lane in Phosphor's own list. Reasons are
untrusted, bounded data, never instructions. A flag adds a review suggestion, not a knowledge
change. The skill asks agents to flag only user contradictions, verified wrong or outdated
facts, or duplicate recalled memories—never a guess, an agent preference or mere irrelevance.

## Recall

When Brain and recall are on, lane startup contributes `-e brain-ext/brain.mjs` and
`--skill skills/brain`, not a Brain socket address or token. On an op-channel lane
(`PHOSPHOR_OPS=v1`), `brain_search` and `brain_flag` use the `brain.search` and
`brain.flag` service ops. The owner supplies the workspace and lane identity. If no
Brain service answers, the tool reports “Brain is unavailable right now.” This is
not a no-match result or a request for user input. Search stays read-only; flags
only ask the owner to review.

Desktop registers Brain with the local Phosphor service on its attested owner connection, updates registration when recall changes, and registers again on reconnect. Extraction waits for a fresh lane activity projection, not cached idle status.
It keeps the private socket address and capability only until that connection closes or a
new registration replaces it. The daemon checks the socket's owner and its private parent
folder before each request. Only the recall preference survives in `app-services.json`, so
new lanes can still load the recall skill with Desktop closed and answer “unavailable”.
The service never opens Brain's database or puts the capability in a lane environment.

`brain_search(query, limit?)` returns 8 memories by default, up to 20:

- **Seeds.** Entities named by the query (whole-word names, aliases and keys; "Harbor" never
  names Harborview), entities found by words, trigrams and vectors, and the entities of memories
  whose meaning matches (cosine 0.35 or more).
- **Walk.** Two hops out along live links, three for structural ones (part of, for customer,
  owns, member of, documents), at most 200 entities and 400 links, never through an entity with
  more than 200 connections unless the query named it. From each entity it follows the newest
  link to each of at most eight neighbours per link word and direction.
- **Ranking.** Reciprocal rank fusion weighs meaning, words, named entities and walked links 2,
  1, 1 and 0.5; the lane's own project counts 1.25 times; freshness only breaks near-ties
  (half-lives: open 30 days, risk 60, decision and fact 180, procedure and preference 365).
  Superseded memories are left out. Without the model or while the index loads, search uses
  words and names and says so.
- **Branch.** The asking lane's branch is read per search; memories that hold only on another
  branch are listed apart.

The Brain page's Find (`brain:find`) returns the top of this same ranking, read for an agent with
no project, up to 50 memories. On the benchmark Brain a 20-result query takes 34 ms (p50, 47 ms
p95) at 100,000 memories and about 300 ms at a million, in the search worker; while the index
loads, word-only search stays under 30 ms.

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
- A merge, fold, dispute, replacement, split, removed name or description can be undone while its
  journal is retained and later changes permit a clean restoration. Forget is never undone.
- Desktop only, one machine. Nothing syncs between machines or to Hosts.
