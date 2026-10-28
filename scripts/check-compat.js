#!/usr/bin/env node
/*
 * Fails the build if anything headed for the TV needs a newer runtime than old webOS has.
 * - JS must be ES5: webOS 4 runs services on Node 0.12 and old webOS runs apps on Chromium 38.
 *   Either rejects the whole file on a single arrow function, and a service that won't load
 *   just leaves the app waiting for a reply.
 * - The TV app's CSS can't use layout features newer than Chromium 53 (webOS 4): they're
 *   silently ignored there, so the layout falls apart only on the TV.
 * The web page served to computers (service/remote.html) isn't checked; it runs in a modern browser.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const dist = path.resolve(__dirname, '..', 'dist');
const files = ['app.js', 'service/service.js', 'service/tv-stream.js'];
let failed = false;

for (const f of files) {
  const src = fs.readFileSync(path.join(dist, f), 'utf8');
  try {
    acorn.parse(src, { ecmaVersion: 5 });
  } catch (e) {
    const line = src.split('\n')[e.loc.line - 1] || '';
    console.error(`dist/${f}:${e.loc.line}:${e.loc.column + 1} is not ES5: ${e.message}\n  ${line.trim().slice(0, 120)}`);
    failed = true;
  }
}

const CSS_RULES = [
  [/display\s*:\s*(inline-)?grid/, 'CSS grid (Chrome 57)'],
  [/(^|[;{\s])(row-|column-)?gap\s*:/, 'gap (flexbox gap is Chrome 84)'],
  [/(^|[;{\s])inset\s*:/, 'inset (Chrome 87)'],
  [/place-(items|content|self)\s*:/, 'place-* (Chrome 59)'],
  [/aspect-ratio\s*:/, 'aspect-ratio (Chrome 88)'],
  [/clip-path\s*:/, 'unprefixed clip-path (Chrome 55)'],
];
const css = fs.readFileSync(path.join(dist, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
css.split('\n').forEach((line, i) => {
  for (const [re, what] of CSS_RULES) {
    if (re.test(line)) {
      console.error(`dist/style.css:${i + 1} uses ${what}, which webOS 4's Chromium 53 ignores\n  ${line.trim().slice(0, 160)}`);
      failed = true;
    }
  }
});

if (failed) process.exit(1);
console.log('TV compatibility check passed (ES5 JS, Chromium 53 CSS)');
