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
// @description  Sort upcoming videos by duration or title, and optionally by views, likes, or upload date. Remove watched or repeated videos.
// @homepageURL  https://github.com/kemus/youtube-up-next-sort
// @downloadURL  https://raw.githubusercontent.com/kemus/youtube-up-next-sort/main/dist/playlist-sort.user.js
// @updateURL    https://raw.githubusercontent.com/kemus/youtube-up-next-sort/main/dist/playlist-sort.user.js
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @sandbox      raw
// @inject-into  page
// @noframes
// ==/UserScript==` },
});
console.log('Built dist/playlist-sort.user.js');
