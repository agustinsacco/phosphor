---
name: visual-artifacts
description: Create or revise Phosphor side-panel artifacts, visual technical plans, architecture explanations, UI reviews, comparisons and interactive walkthroughs. Use for substantial artifact deliverables, especially when relationships, sequences, states or interfaces need to be understood. Not for routine chat updates or editing application source code.
---

# Visual artifacts

Choose the medium for the reader's task, not a universal format default. Show
relationships visually; use prose for reasoning. A visual should reduce the
work of understanding something, not decorate a wall of text.

## Choose the medium

| Reader's task                                              | Medium                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| Understand architecture, dependencies, sequences or states | Markdown with Mermaid fences                                         |
| Inspect one substantial diagram                            | A standalone `mermaid` artifact                                      |
| Review a UI                                                | Annotated screenshots; HTML for layout or an interactive walkthrough |
| Compare alternatives or try a prototype                    | HTML when spatial layout or interaction helps                        |
| See quantitative patterns                                  | Chart.js (`chart`) or Vega-Lite fences in Markdown                   |
| Understand a bespoke illustration                          | SVG, standalone or inline in HTML                                    |
| Read straightforward reference material                    | Markdown                                                             |
| Inspect source as the deliverable                          | `code`, with its language                                            |

Use a diagram for a multi-component architecture or process unless it would
add no information. Do not substitute ASCII boxes or wireframes for supported
visuals. Keep code blocks for code, commands and literal output. Do not invent
numbers to justify a chart; test results often need only a compact evidence table.

Read only the reference needed, relative to this skill directory:

- [Mermaid recipes](references/mermaid.md): architecture, sequences, states and dependency maps.
- [HTML and charts](references/html-and-charts.md): interactive layouts, theme tokens and chart formats.

## Compose the artifact

1. Lead with the purpose or conclusion, then the visual that explains it.
2. Keep the overview small. Put technical detail and evidence below it; use
   HTML disclosures when they improve navigation, not to hide required context.
3. Label current, proposed, simulated and tested behavior distinctly. Give
   dates or commit references when status could go stale. Link evidence.
4. Keep paragraphs outside comparison tables. Use meaningful status labels,
   not decorative cards, giant metrics or the same summary repeated three times.
5. Give diagrams a brief text alternative. Label edges and units, use readable
   type, and never rely only on color to encode status.
6. For a UI review, keep a few representative annotated screenshots beside the
   decisions they inform. Current HTML supports embedded data images, not local
   file or remote image URLs. There is no asset-import tool yet. If screenshots
   cannot be embedded reasonably, disclose that limit and link the local evidence;
   do not claim that an ASCII mockup is the tested interface.

## Publish, inspect, revise

- Use `artifact_create` for requested pages or substantial deliverables, not
  routine updates. Link the result as `[Title](artifact://<id>)`.
- Preview with the available browser/UI tools when possible. Artifact creation
  confirms storage, not visual correctness. Check Mermaid parse errors, clipping,
  readable labels, narrow (~380px) and wide layouts, and light/dark themes.
- Exercise every interaction you claim works. HTML runs inline JavaScript but
  has no network, persistent storage or access to the parent app. A prototype
  must label simulated behavior rather than imply real system actions.
- Report what was actually checked. If rendered inspection was unavailable,
  say so; source inspection is not visual validation.
- Prefer `artifact_edit` for revisions; read the current version first when it
  is no longer in context. Use `artifact_update` only for substantial rewrites.

The skill is an editable user-owned copy of Phosphor's bundled default. Its
references are editable too. Deleting or hiding it must not be worked around by
restoring a default without the user's request.
