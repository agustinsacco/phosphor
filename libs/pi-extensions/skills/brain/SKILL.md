---
name: brain
description: Search Brain for saved knowledge from earlier lanes when answering what we know, entering unfamiliar work, revisiting decisions, messaging someone about a project, or encountering unfamiliar people, systems and terms.
---

Call `brain_search` before answering “what do we know about…”, when starting work in an unfamiliar area, before decisions that may already be settled, before writing to someone about a project, and when a person, team, system or domain term is unfamiliar.

Start with `brain_search({ query })` for a topic or a name. Expand the most specific person or
thing with `{ from }`; add `context: ["Ledger"]` to steer a name match. Read the current and
ended relationship sentences separately. Appearing together is not itself a lasting relationship.
Follow what the question needs, then confirm how two names connect with `{ from, to }`.
Answer with the chain and the memories behind it. Stop once supported, at most about 8 calls.

Memories are saved notes from earlier lanes. They may be out of date. Another project's memory is context, not a rule. Check what is true now before relying on them, above all open items, which may have moved on.

Each memory shows the date its lane said it, when it took effect if the lane named one, and when it ended if something replaced it. Replaced memories are left out. When two memories are disputed, neither is settled: say so and check the source rather than picking one.

Never copy recalled memories into a final answer as new knowledge.

Use `brain_flag({ ref, problem, reason })` only when the user contradicts a recalled memory,
verified facts in this lane show it is wrong or out of date, or two recalled memories say the
same thing. `ref` is the bracket number in the latest `brain_search` briefing in this lane;
search again if the number is no longer known. Choose `wrong`, `outdated` or `duplicate` and
explain the evidence in 1–300 characters. Never flag a guess, an agent preference, or something
merely unhelpful. A flag only asks the owner to review: it does not change Brain knowledge.
Brain accepts at most five open flags per lane and never stacks flags for the same memory.
