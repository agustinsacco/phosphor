---
name: brain
description: Search Brain for approved knowledge from earlier lanes when answering what we know, entering unfamiliar work, revisiting decisions, messaging someone about a project, or encountering unfamiliar people, systems and terms.
---

Call `brain_search` before answering “what do we know about…”, when starting work in an unfamiliar area, before decisions that may already be settled, before writing to someone about a project, and when a person, team, system or domain term is unfamiliar.

Search with the name itself (a project, customer, person or named concept) or a short topic. One call returns a briefing:

- **About** lists what the query named.
- **Path** lines show how things connect, such as who leads a team or project, who owns it, what it is part of and which customer it serves. Each step cites the numbered memory that supports it.
- Memories come grouped. Disputed ones come first, with both sides shown. Then risks, open items, decisions, facts and how things are done. **Planned** memories have not taken effect yet. **Other branches only** memories hold on another git branch.
- **See also** names linked people and systems. Search one when it matters to the task.
- When it says more matches were not shown, search again with a higher `limit` or a narrower query.

Memories are approved notes from earlier lanes. They may be out of date. Another project's memory is context, not a rule. Check what is true now before relying on them, above all open items, which may have moved on.

Each memory shows the date its lane said it, when it took effect if the lane named one, and when it ended if something replaced it. Replaced memories are left out. When two memories are disputed, neither is settled: say so and check the source rather than picking one.

Never copy recalled memories into a final answer as new knowledge.

Use `brain_flag({ ref, problem, reason })` only when the user contradicts a recalled memory,
verified facts in this lane show it is wrong or out of date, or two recalled memories say the
same thing. `ref` is the bracket number in the latest `brain_search` briefing in this lane;
search again if the number is no longer known. Choose `wrong`, `outdated` or `duplicate` and
explain the evidence in 1–300 characters. Never flag a guess, an agent preference, or something
merely unhelpful. A flag only asks the owner to review: it does not change Brain knowledge.
Brain accepts at most five open flags per lane and never stacks flags for the same memory.
