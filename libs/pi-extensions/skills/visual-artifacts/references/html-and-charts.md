# HTML and charts

## HTML runtime

Author a fragment. Phosphor injects semantic typography and its current theme.
Use headings, figures/captions, sections, lists, tables and details/summary.
Add CSS for purposeful layout, not to rebuild the theme. Inline scripts work;
network requests, CDN imports, remote images, nested frames, parent-app access
and persistent storage do not. There is no React/JSX compilation or preloaded
Mermaid/Chart.js inside HTML. Keep interactions self-contained.

Available CSS tokens:

```css
/* surfaces */ --art-bg; --art-panel; --art-panel-2;
/* text */ --art-ink; --art-ink-2; --art-ink-3;
/* structure */ --art-line; --art-line-soft; --art-accent;
/* status */ --art-good; --art-warn; --art-crit;
/* series */ --art-s1; --art-s2; --art-s3; --art-s4; --art-s5;
/* type */ --art-sans; --art-mono;
```

Use status words alongside colors. Avoid placing many tiny labels in a fixed
SVG viewBox. Let genuinely wide diagrams scroll locally; the page should not
need horizontal scrolling. HTML's default body is a reading column; override
its width deliberately for a spatial comparison.

## Responsive comparison recipe

```html
<style>
  body {
    max-width: 64rem;
  }
  .comparison {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
    gap: 1rem;
  }
  .comparison section {
    border-top: 2px solid var(--art-line);
  }
</style>
<h1>Local versus remote</h1>
<p>The session engine stays the same; transport and machine ownership differ.</p>
<div class="comparison">
  <section>
    <h2>Local: current</h2>
    <p>Desktop owns local pi sessions over IPC.</p>
  </section>
  <section>
    <h2>Remote: proposed</h2>
    <p>A Host owns pi sessions reached through a private API.</p>
  </section>
</div>
<details>
  <summary>Technical evidence</summary>
  <p>Link the relevant code and tests here.</p>
</details>
```

For a UI review replace prose-only panels with selected annotated screenshots
or clearly labelled prototype views. Put each review question next to what it
concerns. A tab or filter must actually change the visible content; use real
buttons with accessible names and keyboard operation, not decorative controls.

## Quantitative charts

Markdown `chart` fences and standalone `chart` artifacts accept Chart.js JSON:

```chart
{"type":"bar","data":{"labels":["Baseline","Candidate"],"datasets":[{"label":"Example duration (ms), illustrative only","data":[140,95]}]},"options":{"plugins":{"legend":{"display":true}},"scales":{"y":{"beginAtZero":true}}}}
```

Markdown also supports `vega-lite` fences (not a standalone artifact type):

```vega-lite
{"data":{"values":[{"stage":"Baseline","ms":140},{"stage":"Candidate","ms":95}]},"mark":"bar","encoding":{"x":{"field":"stage","type":"nominal"},"y":{"field":"ms","type":"quantitative","title":"Example duration (ms), illustrative only"}}}
```

Replace illustrative data with verified values for a real deliverable. Name
units, sampling conditions and evidence. Use bars for comparisons, lines for
ordered trends, and tables when precise lookup matters more than shape. Keep
Vega data inline; do not rely on URL-loaded data or executable expressions.
