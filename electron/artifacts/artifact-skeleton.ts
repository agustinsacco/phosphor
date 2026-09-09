/**
 * The house style every artifact is served with.
 *
 * ## Why this is injected rather than prompted
 *
 * The look of an artifact used to be entirely the model's own default, because
 * nothing here styled one: `phosphor-artifact://` served the model's markup
 * byte for byte. The tool description asked for "theme-aware palettes" and
 * named no colors, so every artifact invented its own — and every artifact
 * paid output tokens to invent it again.
 *
 * Injecting the sheet at publish time costs zero model tokens, cannot drift
 * between two artifacts in the same session, and applies retroactively: an
 * artifact written last week re-renders in the current style, because the
 * document is rebuilt on every stage.
 *
 * The model's own `<style>` lands after this one in document order, so it
 * still wins — this is a floor, not a cage.
 *
 * ## Why the tokens are NOT the app's `--px-*` neutrals
 *
 * An artifact is a document, not app chrome: darker ground, denser type, and a
 * validated categorical palette that app chrome has no use for. Mirroring
 * `--px-*` here would make this a sixth satellite copy of the neutrals (see
 * docs/style-guide.md) and bind two surfaces that want different things. It is
 * deliberately off-palette in the same way Shiki's syntax colors are, and
 * carries its own `--art-*` namespace so the two can never be confused.
 *
 * ## The palette is computed, not chosen
 *
 * Series colors are checked with the dataviz six-checks validator on each
 * surface — lightness band, chroma floor, CVD separation, normal-vision floor,
 * contrast. The dark five pass adjacent-pair separation on `#14120f`; the
 * first three also pass all-pairs (scatter, small multiples), which is why the
 * prompt caps those forms at three series. The light five pass adjacent with a
 * documented contrast relief, which the direct labels and evidence tables the
 * prompt requires are what satisfy. Do not "improve" a hex here without
 * re-running the validator for both modes.
 */

/** Serialised into every artifact document. Keep in sync with the prompt in `pi-ext/artifacts.ts`. */
const ARTIFACT_STYLE = `
:root{
  color-scheme:dark;
  --art-bg:#0e0d0b; --art-panel:#14120f; --art-panel-2:#191713;
  --art-line:#2b2621; --art-line-soft:#201d18;
  --art-ink:#f1ede5; --art-ink-2:#a7a096; --art-ink-3:#6e6961;
  --art-accent:#f2ab4e; --art-accent-dim:#2a1f10;
  --art-s1:#c98500; --art-s2:#3987e5; --art-s3:#199e70; --art-s4:#9085e9; --art-s5:#d55181;
  --art-r1:#61461b; --art-r2:#89651b; --art-r3:#ac7a16; --art-r4:#cd8a04; --art-r5:#efb44e;
  --art-good:#199e70; --art-warn:#c98500; --art-crit:#e66767;
  --art-mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;
  --art-sans:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
}
/* Light is the override: this surface is dark by design, not by default. The
   media query covers the OS; the attribute stamp is Phosphor's own theme and
   must win in both directions. */
@media (prefers-color-scheme:light){
  :root:not([data-theme="dark"]){
    color-scheme:light;
    --art-bg:#f6f5f2; --art-panel:#fff; --art-panel-2:#faf9f6;
    --art-line:#dedad2; --art-line-soft:#ebe8e1;
    --art-ink:#15130f; --art-ink-2:#55514a; --art-ink-3:#8b867d;
    --art-accent:#b26a12; --art-accent-dim:#f7eddc;
    --art-s1:#eda100; --art-s2:#2a78d6; --art-s3:#1baf7a; --art-s4:#4a3aa7; --art-s5:#e87ba4;
    --art-r1:#f6e2b4; --art-r2:#eec97c; --art-r3:#e0a93c; --art-r4:#c58a10; --art-r5:#8f6209;
    --art-good:#1baf7a; --art-warn:#eda100; --art-crit:#e34948;
  }
}
:root[data-theme="light"]{
  color-scheme:light;
  --art-bg:#f6f5f2; --art-panel:#fff; --art-panel-2:#faf9f6;
  --art-line:#dedad2; --art-line-soft:#ebe8e1;
  --art-ink:#15130f; --art-ink-2:#55514a; --art-ink-3:#8b867d;
  --art-accent:#b26a12; --art-accent-dim:#f7eddc;
  --art-s1:#eda100; --art-s2:#2a78d6; --art-s3:#1baf7a; --art-s4:#4a3aa7; --art-s5:#e87ba4;
  --art-r1:#f6e2b4; --art-r2:#eec97c; --art-r3:#e0a93c; --art-r4:#c58a10; --art-r5:#8f6209;
  --art-good:#1baf7a; --art-warn:#eda100; --art-crit:#e34948;
}

*{box-sizing:border-box}
body{
  margin:0; padding:clamp(1rem,3vw,2.25rem);
  background:var(--art-bg); color:var(--art-ink);
  font-family:var(--art-sans); font-size:15px; line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
/* No padding here: body owns it, so nesting .wrap cannot double it. */
.wrap{max-width:62rem;margin:0 auto}
h1,h2,h3,h4{margin:0;font-weight:650;letter-spacing:-0.015em}
h1{font-size:clamp(1.7rem,4.5vw,2.4rem);line-height:1.1}
h2{font-size:1.15rem;margin-top:1.6rem}
h3{font-size:1.05rem;margin-top:1.2rem}
h4{font-size:.92rem;font-weight:620}
p{margin:0 0 .65em}
a{color:var(--art-accent)}
ul,ol{margin:.4rem 0 .8rem;padding-left:1.15rem;color:var(--art-ink-2)}
li{margin-bottom:.25rem}
li>b,li>strong{color:var(--art-ink)}
hr{border:0;border-top:1px solid var(--art-line);margin:1.75rem 0}
img,svg,video{max-width:100%}
code{font-family:var(--art-mono);font-size:.86em}
pre.code,pre{
  font-family:var(--art-mono);font-size:11.5px;color:var(--art-ink-2);
  background:var(--art-panel-2);border:1px solid var(--art-line);border-radius:3px;
  padding:.55rem .7rem;margin:.5rem 0 0;overflow-x:auto;
}
pre b{color:var(--art-accent);font-weight:500}
.mono{font-family:var(--art-mono)}
.scroll{overflow-x:auto}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:.75rem}

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

table.data{border-collapse:collapse;width:100%;font-size:.85rem;min-width:30rem}
table.data th{font-family:var(--art-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--art-ink-3);text-align:left;font-weight:500;padding:.4rem .6rem;border-bottom:1px solid var(--art-line)}
table.data td{padding:.42rem .6rem;border-bottom:1px solid var(--art-line-soft);font-variant-numeric:tabular-nums}
table.data td.num{text-align:right;font-family:var(--art-mono)}
table.data tr:last-child td{border-bottom:0}

.callout{border-left:2px solid var(--art-accent);background:var(--art-accent-dim);padding:.6rem .8rem;font-size:.88rem;border-radius:0 3px 3px 0;margin:.75rem 0}
.callout b{color:var(--art-ink)}
.callout--crit{border-left-color:var(--art-crit)}
.pill{font-family:var(--art-mono);font-size:10px;padding:.05rem .3rem;border-radius:2px;border:1px solid var(--art-line);color:var(--art-ink-2)}
.pill.ok{color:var(--art-good);border-color:var(--art-good)}
.pill.no{color:var(--art-crit);border-color:var(--art-crit)}

/* Step rail — a sequence should look like a sequence. */
.rail{display:grid;margin-top:.6rem}
.rail .node{display:grid;grid-template-columns:1.9rem 1fr;gap:.7rem}
.rail .gut{position:relative}
.rail .gut::before{content:"";position:absolute;left:.85rem;top:0;bottom:0;width:1px;background:var(--art-line)}
.rail .node:last-child .gut::before{bottom:auto;height:.75rem}
.rail .dot{position:relative;z-index:1;width:1.7rem;height:1.7rem;border-radius:50%;border:1px solid var(--art-line);background:var(--art-panel-2);display:grid;place-items:center;font-family:var(--art-mono);font-size:11px;color:var(--art-accent)}
.rail .body{padding-bottom:.85rem}
.rail h4{margin:.15rem 0 .2rem}
.rail p{font-size:.86rem;color:var(--art-ink-2);margin:0}

/* Ledger — charts collapsed into the text flow, for verification logs. */
.ledger{font-family:var(--art-mono);font-size:12.5px}
.ledger .row{display:grid;grid-template-columns:1.6rem 1fr 4.5rem 4rem;gap:.5rem;align-items:center;padding:.32rem 0;border-bottom:1px solid var(--art-line-soft)}
.ledger .row:last-child{border-bottom:0}
.ledger .idx{color:var(--art-ink-3)}
.ledger .bar{height:8px;background:var(--art-line);border-radius:0 4px 4px 0;overflow:hidden}
.ledger .bar i{display:block;height:100%;border-radius:0 4px 4px 0}
.ledger .val{text-align:right;font-variant-numeric:tabular-nums}
.ledger .lab{color:var(--art-ink-2)}
.steps{font-family:var(--art-mono);font-size:12.5px;color:var(--art-ink-2)}
.steps .s{display:grid;grid-template-columns:1.5rem 1fr;gap:.5rem;padding:.3rem 0;border-bottom:1px dotted var(--art-line)}
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
export function buildArtifactDocument(html: string, theme: 'light' | 'dark'): string {
  const style = `<style>${ARTIFACT_STYLE}</style>`

  if (looksLikeFullDocument(html)) {
    const stamped = stampHtmlTag(html, theme)
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

  return `<!doctype html><html lang="en" data-theme="${theme}"><head>${HEAD}${style}</head><body>${html}</body></html>`
}

/** Exported for tests and for the docs that quote the token names. */
export const __testing = { ARTIFACT_STYLE, looksLikeFullDocument }
