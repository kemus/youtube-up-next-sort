import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: ['src/userscript.ts'],
  outfile: 'dist/playlist-sort.user.js',
  bundle: true,
  format: 'iife',
  target: ['firefox128', 'chrome120'],
  minify: false,
  legalComments: 'inline',
  banner: { js: `// ==UserScript==
// @name         YouTube Up Next — Shortest First
// @namespace    urn:kemus:youtube-up-next-sort
// @version      ${version}
// @description  Sort upcoming videos by duration, title, or available posting date. Click to cycle ascending, descending, and undo.
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @inject-into  page
// @noframes
// ==/UserScript==` },
});
console.log('Built dist/playlist-sort.user.js');
