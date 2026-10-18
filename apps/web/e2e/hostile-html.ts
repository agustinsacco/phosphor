// All attack destinations are synthetic, blocked by the browser policy and by the
// suite's outbound tripwire. Never use a live listener or third-party endpoint.
export const hostileHtml = `
<h1>Safe synthetic preview</h1>
<p id="safe">Readable content remains</p>
<script>document.getElementById('safe').textContent='SCRIPT EXECUTED';fetch('https://escape.invalid/script')</script>
<img src="https://escape.invalid/image" onerror="document.body.textContent='SCRIPT EXECUTED'">
<style>@import url('https://escape.invalid/style'); body { background-image:url('https://escape.invalid/background') }</style>
<link rel="stylesheet" href="https://escape.invalid/link">
<meta http-equiv="refresh" content="0;url=https://escape.invalid/refresh">
<iframe src="https://escape.invalid/frame"></iframe>
<a href="https://escape.invalid/navigation" target="_top" ping="https://escape.invalid/ping">Attempt navigation</a>
<form action="https://escape.invalid/form"><button>Submit escape</button></form>
<svg width="300" height="180" xmlns="http://www.w3.org/2000/svg" onload="document.body.textContent='SCRIPT EXECUTED'">
 <text x="5" y="20">Safe SVG text</text>
 <image href="https://escape.invalid/svg-image" />
 <a href="javascript:alert('escape')"><text x="5" y="50">SVG navigation</text></a>
 <animate attributeName="href" values="https://escape.invalid/animate" />
 <foreignObject y="80" width="200" height="80"><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://escape.invalid/foreign" /></div></foreignObject>
</svg>`
