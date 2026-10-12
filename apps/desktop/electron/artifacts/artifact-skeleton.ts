/**
 * Viewport-first HTML defaults, injected without spending model tokens on CSS.
 * Semantic typography needs no classes; .art-document opts into a reading column.
 * Markdown previews use the app's typography.
 * Neutrals and accent mirror the app, guarded by a drift test. The --art-*
 * namespace, series palette and opt-in layout classes remain for old artifacts.
 * Documents are rebuilt on every stage; model-authored styles still come last.
 */

/** Serialised into every staged document, including PDF exports. */
const ARTIFACT_STYLE = `
:root{
  color-scheme:dark;
  --art-bg:#1e1c18; --art-panel:#26231e; --art-panel-2:#24211c;
  --art-line:#3a352c; --art-line-soft:#3a352c;
  --art-ink:#ece7db; --art-ink-2:#aca496; --art-ink-3:#7c766a;
  --art-accent:#eca03d; --art-accent-dim:#3d3220;
  --art-s1:#c98500; --art-s2:#3987e5; --art-s3:#199e70; --art-s4:#9085e9; --art-s5:#d55181;
  --art-r1:#61461b; --art-r2:#89651b; --art-r3:#ac7a16; --art-r4:#cd8a04; --art-r5:#efb44e;
  --art-good:#199e70; --art-warn:#c98500; --art-crit:#e66767;
  --art-mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;
  --art-sans:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
}
/* The app's explicit theme wins over the OS in both directions. */
@media (prefers-color-scheme:light){
  :root:not([data-theme="dark"]){
    color-scheme:light;
    --art-bg:#f7f7f8; --art-panel:#efeff1; --art-panel-2:#f2f2f4;
    --art-line:#e4e4e7; --art-line-soft:#e4e4e7;
    --art-ink:#26262a; --art-ink-2:#66666e; --art-ink-3:#96969e;
    --art-accent:#b35c0f; --art-accent-dim:#f6e9d4;
    --art-s1:#eda100; --art-s2:#2a78d6; --art-s3:#1baf7a; --art-s4:#4a3aa7; --art-s5:#e87ba4;
    --art-r1:#f6e2b4; --art-r2:#eec97c; --art-r3:#e0a93c; --art-r4:#c58a10; --art-r5:#8f6209;
    --art-good:#1baf7a; --art-warn:#eda100; --art-crit:#e34948;
  }
}
:root[data-theme="light"]{
  color-scheme:light;
  --art-bg:#f7f7f8; --art-panel:#efeff1; --art-panel-2:#f2f2f4;
  --art-line:#e4e4e7; --art-line-soft:#e4e4e7;
  --art-ink:#26262a; --art-ink-2:#66666e; --art-ink-3:#96969e;
  --art-accent:#b35c0f; --art-accent-dim:#f6e9d4;
  --art-s1:#eda100; --art-s2:#2a78d6; --art-s3:#1baf7a; --art-s4:#4a3aa7; --art-s5:#e87ba4;
  --art-r1:#f6e2b4; --art-r2:#eec97c; --art-r3:#e0a93c; --art-r4:#c58a10; --art-r5:#8f6209;
  --art-good:#1baf7a; --art-warn:#eda100; --art-crit:#e34948;
}

*{box-sizing:border-box}
html{height:100%;background:var(--art-bg);color:var(--art-ink)}
body{
  margin:0; padding:0; min-height:100%;
  font-family:var(--art-sans); font-size:15px; line-height:1.6;
  overflow-wrap:anywhere; -webkit-font-smoothing:antialiased;
}
h1,h2,h3,h4{font-weight:600;line-height:1.3;margin:1.4em 0 .5em}
h1{font-size:1.5rem}
h2{font-size:1.2rem}
h3{font-size:1.05rem}
h4{font-size:1rem}
body>:first-child{margin-top:0}
p{margin:.65em 0}
a{color:var(--art-accent);text-underline-offset:.15em}
ul,ol{margin:.5em 0;padding-left:1.5em}
li{margin:.3em 0}
hr{border:0;border-top:1px solid var(--art-line);margin:1.5em 0}
img,svg,video{max-width:100%}
code,kbd,samp{font-family:var(--art-mono);font-size:.9em}
pre.code,pre{
  font-family:var(--art-mono);font-size:13px;
  background:var(--art-panel-2);border-radius:3px;
  padding:.75rem;margin:.8em 0;max-width:100%;overflow-x:auto;
}
pre code{font-size:inherit}
blockquote{margin:.8em 0;padding-left:1em;border-left:2px solid var(--art-line);color:var(--art-ink-2)}
dt,summary{font-weight:600}
dd{margin:0 0 .6em 1em}
details{margin:.8em 0}
summary{cursor:pointer}
figure{margin:1em 0}
figcaption{font-size:.9em;color:var(--art-ink-2)}
table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;margin:1em 0;font-size:.9em}
th,td{text-align:left;vertical-align:top;padding:.4em .6em;border-bottom:1px solid var(--art-line)}
th{font-weight:600}

/* Reading measure belongs to prose, never the viewport of a responsive app. */
.art-document{max-width:76ch;margin:0 auto;padding:clamp(1rem,3vw,1.5rem)}

/* Compatibility classes are opt-in, not an authoring vocabulary. */
.wrap{max-width:76ch;margin:0 auto}
.mono{font-family:var(--art-mono)}
.scroll{overflow-x:auto;max-width:100%}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr));gap:.75rem}

.eyebrow{font-family:var(--art-mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--art-accent);margin-bottom:.5rem}
.kicker{font-family:var(--art-mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--art-ink-3)}
.deck{color:var(--art-ink-2);max-width:46rem;margin-top:.6rem;font-size:1.02rem}
.lede{font-size:.95rem;color:var(--art-ink-2);margin-top:.35rem}
.lede b,.deck b{color:var(--art-ink);font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:1rem}
.chip{font-family:var(--art-mono);font-size:11px;color:var(--art-ink-2);background:var(--art-panel);border:1px solid var(--art-line);border-radius:2px;padding:.2rem .5rem}
.chip b{color:var(--art-ink);font-weight:600}

/* Hairline separators are the 1px grid gap showing through, never borders per cell. */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));gap:1px;background:var(--art-line);border:1px solid var(--art-line);border-radius:3px;overflow:hidden;margin:.9rem 0}
.kpi{background:var(--art-panel);padding:.6rem .7rem}
.k-label{font-family:var(--art-mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--art-ink-3)}
.k-val{font-size:1.5rem;font-weight:650;letter-spacing:-.02em;line-height:1.15;margin-top:.15rem;font-variant-numeric:tabular-nums}
.k-sub{font-family:var(--art-mono);font-size:10.5px;color:var(--art-ink-2);margin-top:.15rem}
.up{color:var(--art-crit)}
.down{color:var(--art-good)}

.panelbox{border:1px solid var(--art-line);border-radius:3px;background:var(--art-panel);padding:.75rem .85rem;position:relative}
.panelbox::after{content:"";position:absolute;top:-1px;left:-1px;width:8px;height:8px;border-top:1px solid var(--art-accent);border-left:1px solid var(--art-accent)}

.chart-title{font-size:.85rem;font-weight:600}
.chart-note{font-family:var(--art-mono);font-size:10.5px;color:var(--art-ink-3)}
.legend{display:flex;flex-wrap:wrap;gap:.85rem;font-family:var(--art-mono);font-size:10.5px;color:var(--art-ink-2);margin-top:.4rem}
.legend span{display:inline-flex;align-items:center;gap:.35rem}
.swatch{width:9px;height:9px;border-radius:2px;display:inline-block}
svg{display:block;width:100%;height:auto}
svg text{font-family:var(--art-mono);fill:var(--art-ink-2)}
.grid-line{stroke:var(--art-line);stroke-width:1}
.mark:hover{opacity:.82;cursor:default}

/* The panel an artifact is read in is often ~380px wide, so a table has to
   survive being narrower than it wants. min-width:min(100%,30rem) asks for
   30rem only while there is 30rem to ask for; the flat 30rem it replaces is
   what used to push the whole page into a horizontal scroll. Cells wrap rather
   than overflow, and a table too wide to squeeze goes in a .scroll wrapper. */
table.data{border-collapse:collapse;width:100%;font-size:.85rem;min-width:min(100%,30rem)}
table.data th{font-family:var(--art-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--art-ink-3);text-align:left;font-weight:500;padding:.4rem .6rem;border-bottom:1px solid var(--art-line)}
table.data td{padding:.42rem .6rem;border-bottom:1px solid var(--art-line-soft);font-variant-numeric:tabular-nums}
table.data th,table.data td{overflow-wrap:anywhere;hyphens:auto}
table.data td.num{text-align:right;font-family:var(--art-mono);white-space:nowrap}
table.data .pill{white-space:nowrap}
table.data tr:last-child td{border-bottom:0}

.callout{border-left:2px solid var(--art-accent);background:var(--art-accent-dim);padding:.6rem .8rem;font-size:.88rem;border-radius:0 3px 3px 0;margin:.75rem 0}
.callout b{color:var(--art-ink)}
.callout--crit{border-left-color:var(--art-crit)}
.pill{font-family:var(--art-mono);font-size:10px;padding:.05rem .3rem;border-radius:2px;border:1px solid var(--art-line);color:var(--art-ink-2)}
.pill.ok{color:var(--art-good);border-color:var(--art-good)}
.pill.no{color:var(--art-crit);border-color:var(--art-crit)}

/* Step rail — a sequence should look like a sequence. */
.rail:has(>.node>.gut){display:grid;margin-top:.6rem}
.rail .node:has(>.gut){display:grid;grid-template-columns:1.9rem 1fr;gap:.7rem}
.rail .gut{position:relative}
.rail .gut::before{content:"";position:absolute;left:.85rem;top:0;bottom:0;width:1px;background:var(--art-line)}
.rail .node:last-child .gut::before{bottom:auto;height:.75rem}
.rail .dot{position:relative;z-index:1;width:1.7rem;height:1.7rem;border-radius:50%;border:1px solid var(--art-line);background:var(--art-panel-2);display:grid;place-items:center;font-family:var(--art-mono);font-size:11px;color:var(--art-accent)}
.rail .body{padding-bottom:.85rem}
.rail h4{margin:.15rem 0 .2rem}
.rail p{font-size:.86rem;color:var(--art-ink-2);margin:0}

/* Ledger — charts collapsed into the text flow, for verification logs.
   The column grid engages ONLY for a row built from ledger cells. A .row of
   free prose has as many grid items as it has inline children, so the fixed
   four-column track sliced a sentence into one-word columns and then wrapped
   the remainder into implicit rows. Same guard on .steps and .rail: a
   primitive used as a paragraph style has to degrade to a paragraph. */
.ledger{font-family:var(--art-mono);font-size:12.5px}
.ledger .row{padding:.32rem 0;border-bottom:1px solid var(--art-line-soft)}
.ledger .row:has(>.idx,>.lab,>.bar,>.val){display:grid;grid-template-columns:1.6rem 1fr 4.5rem 4rem;gap:.5rem;align-items:center}
.ledger .row:not(:has(>.idx,>.lab,>.bar,>.val)){font-family:var(--art-sans);font-size:.88rem;color:var(--art-ink-2);padding:.45rem 0}
.ledger .row:last-child{border-bottom:0}
.ledger .row b,.ledger .row strong{color:var(--art-ink)}
.ledger .idx{color:var(--art-ink-3)}
.ledger .bar{height:8px;background:var(--art-line);border-radius:0 4px 4px 0;overflow:hidden}
.ledger .bar i{display:block;height:100%;border-radius:0 4px 4px 0}
.ledger .val{text-align:right;font-variant-numeric:tabular-nums}
.ledger .lab{color:var(--art-ink-2)}
.steps{font-family:var(--art-mono);font-size:12.5px;color:var(--art-ink-2)}
.steps .s{padding:.3rem 0;border-bottom:1px dotted var(--art-line)}
.steps .s:has(>.n){display:grid;grid-template-columns:1.5rem 1fr;gap:.5rem}
.steps .s:last-child{border-bottom:0}
.steps .n{color:var(--art-accent)}
.steps b{color:var(--art-ink);font-weight:600}

/* Opt-in drafting grid, for diagram-led plans. */
.blueprint{background:
  linear-gradient(var(--art-line-soft) 1px,transparent 1px) 0 0/100% 22px,
  linear-gradient(90deg,var(--art-line-soft) 1px,transparent 1px) 0 0/22px 100%,
  var(--art-panel)}

.verdict{border:1px solid var(--art-accent);border-radius:4px;background:var(--art-accent-dim);padding:.9rem 1rem;margin-top:1rem}
.verdict h3{margin-top:0;font-size:1rem}
footer{margin-top:2rem;padding-top:.9rem;border-top:1px solid var(--art-line);font-family:var(--art-mono);font-size:10.5px;color:var(--art-ink-3)}
`.trim()

/**
 * The pagination layer, added only when the document is being printed.
 *
 * A screen artifact is one continuous column and has no page breaks to place.
 * On paper it has a break every 11 inches whether or not anything asked for
 * one, so the sheet above — which says nothing about printing — let Chromium
 * put those breaks wherever the flow happened to land: through the middle of a
 * KPI strip, between a heading and the section it titles, across a table row.
 * The export dodged that by printing ONE page as tall as the whole document,
 * which is not a fix, it is a document no reader paginates and no printer can
 * put on paper. These rules are what make real Letter pages survivable.
 *
 * ## Why this is appended after the body, not merged into the sheet above
 *
 * The house sheet is a floor: it goes in `<head>` so the model's own `<style>`
 * lands later in document order and wins. That is right for look, and wrong
 * for pagination — a model writing `body{padding:2rem}` would beat the padding
 * reset here and double the gutter the page margins already provide. So the
 * print sheet is appended at the END of the document, where it is last. It is
 * scoped to `@media print`, so it can only affect the PDF path; nothing here
 * reaches the preview.
 *
 * The gutter itself is NOT here — page size and margins are set once, in
 * `artifact-pdf.ts`, so there is one place that decides paper geometry.
 */
const ARTIFACT_PRINT_STYLE = `
@media print{
  /* The page margins own the gutter. Padding here would indent only the first
     page's top and the last page's bottom, and inset every line on top of the
     margin everywhere else.

     A dark artifact therefore prints its ground INSIDE the margins only, with a
     faint frame around it. That is a Chromium limit, not an oversight: measured
     on Electron 43, a printToPDF margin is never painted with the document
     background — not from body, not from the root element, with or without
     color-scheme. All four combinations were rendered and sampled; the margin
     came out #121212 (the UA dark canvas) under a dark color-scheme and bare
     paper without one, while the content box stayed #0e0d0b in every one. The
     margin cannot be won, so it is spent on something worth having: real
     gutters, which physical printers require — they cannot print to the sheet
     edge, and a full-bleed page loses its outermost content on paper. */
  html,body{margin:0;padding:0;max-width:none;height:auto;min-height:0}
  /* The paper already provides a reading measure and gutters. */
  .wrap{max-width:none;margin:0}
  .art-document{max-width:none;margin:0;padding:0}

  /* A heading must not be the last thing on a page. */
  h1,h2,h3,h4{break-after:avoid-page;break-inside:avoid}
  p,li{orphans:2;widows:2}

  /* Each of these is read as one object, so it breaks as one object. An object
     taller than a page still splits — the rule is a preference, and Chromium
     ignores it rather than leaving a page blank. */
  .kpis,.panelbox,.callout,.verdict,.chips,.legend,.rail .node,.ledger .row,
  .steps .s,figure,pre,pre.code,svg,table tr{break-inside:avoid}

  /* A table long enough to cross a break repeats its header on the next page,
     or every column past the first is unlabelled numbers. */
  table{display:table;width:100%;overflow:visible}
  thead{display:table-header-group}

  /* Paper does not scroll. Anything that clipped or scrolled on screen has to
     wrap instead, or the overflow is simply gone from the PDF. */
  .scroll{overflow:visible}
  pre,pre.code{overflow-x:visible;white-space:pre-wrap;overflow-wrap:anywhere}
}
`.trim()

const HEAD =
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'

/** A document the model wrote in full, rather than the fragment the prompt asks for. */
function looksLikeFullDocument(html: string): boolean {
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(html)
}

/**
 * Stamp `data-theme` on an existing `<html>` tag, replacing any the document
 * already carried — Phosphor's theme is the authority here, not the model's guess.
 */
function stampHtmlTag(html: string, theme: 'light' | 'dark'): string {
  return html.replace(/<html\b[^>]*>/i, (tag) => {
    const stripped = tag.replace(/\sdata-theme\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    return `${stripped.slice(0, -1).trimEnd()} data-theme="${theme}">`
  })
}

/**
 * Wrap model-authored markup into the document that actually gets served.
 *
 * Two shapes arrive here. The prompt asks for a fragment, which is the common
 * one; the sheet goes in a real `<head>` above it. A full document (an older
 * artifact, or a model that ignored the prompt) must not be nested inside
 * another `<html>`, so the sheet is injected into the document it already has.
 *
 * `theme` is Phosphor's resolved theme, not the OS's. It is stamped as an
 * attribute AND backed by `nativeTheme.themeSource` in the main process, so an
 * artifact follows the app in both the token path and the media-query path.
 */
export function buildArtifactDocument(
  html: string,
  theme: 'light' | 'dark',
  options: { print?: boolean } = {},
): string {
  const style = `<style>${ARTIFACT_STYLE}</style>`
  // Last in the document on purpose — see ARTIFACT_PRINT_STYLE. Empty for the
  // preview, so a screen document is byte-identical to what it was before.
  const printStyle = options.print ? `<style>${ARTIFACT_PRINT_STYLE}</style>` : ''

  if (looksLikeFullDocument(html)) {
    const stamped = appendToBody(stampHtmlTag(html, theme), printStyle)
    // After <head> if there is one, else after <html>, else at the very front.
    // Either way the document's own styles still come later and still win.
    if (/<head\b[^>]*>/i.test(stamped)) {
      return stamped.replace(/<head\b[^>]*>/i, (tag) => `${tag}${style}`)
    }
    if (/<html\b[^>]*>/i.test(stamped)) {
      return stamped.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${HEAD}${style}</head>`)
    }
    return `${style}${stamped}`
  }

  return `<!doctype html><html lang="en" data-theme="${theme}"><head>${HEAD}${style}</head><body>${html}${printStyle}</body></html>`
}

/**
 * Put `extra` at the end of a full document's body — after the model's own
 * `<style>`, wherever in the body it wrote one.
 *
 * `</body>` is optional in HTML and plenty of model-authored documents omit it,
 * so the fallback appends to the end of the string. A `<style>` after
 * `</html>` is still parsed into the body, which is exactly where it is wanted.
 */
function appendToBody(html: string, extra: string): string {
  if (!extra) return html
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${extra}$&`) : `${html}${extra}`
}

/** Exported for tests and for the docs that quote the token names. */
export const __testing = { ARTIFACT_STYLE, ARTIFACT_PRINT_STYLE, looksLikeFullDocument }
