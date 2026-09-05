# YouTube Up Next — Shortest First

A TypeScript userscript prototype that sorts **loaded upcoming videos by duration,
shortest to longest**, using the same native handler as YouTube's manual dragging.
The current video and everything before it stay fixed. Equal durations preserve
their existing order. Live, upcoming, and unknown durations go last.

## Install in Firefox

The built script is [dist/playlist-sort.user.js](dist/playlist-sort.user.js).
In Tampermonkey or Violentmonkey, create a new script, replace the entire editor
contents with that file, and save. Reload YouTube after installation.

Alternatively, with Node installed, run `npm run serve` and open
<http://127.0.0.1:8731/playlist-sort.user.js> in Firefox. The server binds only to
localhost and serves the compiled script. Stop it with Ctrl+C after installation.
If your manager doesn't intercept the link, use the editor installation above.

Open a queue or a playing, editable playlist, expand its panel, and click
**Duration ↑**. Start with a short queue whose items are all loaded.
The small neutral button becomes **Stop** while moves run. Scope and playlist
details are in its hover tooltip; only errors or required actions show extra text.

The script needs to run in YouTube's page context to access its native handler.
Its metadata requests that context in Tampermonkey and Violentmonkey. If the script
reports that it cannot read the queue, check your manager's injection setting.

## Prototype boundaries

- Works only where YouTube exposes native reordering with drag handles.
- Only already-loaded items after the selected video are sorted. It does not
  scroll or fetch missing items. The button tooltip reports a partial count when available.
- Shuffle must be off. Radio/mix lists and unsupported layouts stop with a message.
- **Moving items in an editable saved playlist can also save the new order**, just
  as manual dragging does. This is not a temporary-playlist replacement.
- The script verifies the native queue data and rendered order after each move.
  This is not server acknowledgement: YouTube handles its own network requests
  and may reject or revert an update later.
- Stopping leaves completed moves applied. Playback changes, additions/removals,
  or unexpected reorders stop further moves.
- YouTube's handler is undocumented and may change. The script has no private
  HTTP client, OAuth flow, cookie access, or third-party runtime dependencies.

## Build and test

Use Node 22.18 or newer:

```sh
npm ci
npm run check
npm run test:browser
```

`check` runs TypeScript checking, sorting tests, and a readable esbuild bundle.
The compiled `.user.js` is committed for installation without build tooling.

Browser tests use installed Firefox and Chromium with disposable headless profiles.
Override `FIREFOX_BIN` and `CHROMIUM_BIN` if needed. They exercise native-handler
fixtures, including independent playback state, failure/no-op detection,
cancellation, duplicates, and concurrent changes. They do not use your regular
profile or authenticate to YouTube.

For live acceptance, make a short queue with different lengths, start the first
video, sort, and confirm both **Next** and automatic advancement follow the new
order. Repeat in a disposable editable playlist if you want playlist coverage.

## Source and integration

- `src/sort.ts`: pure duration parsing and stable tail sorting.
- `src/youtube.ts`: native queue snapshots, moves, and verification.
- `src/userscript.ts`: panel control and navigation lifecycle.
- `scripts/build.mjs`: TypeScript bundle and userscript metadata.

On 2026-09-04, inspection of YouTube's public frontend confirmed that
`ytd-playlist-panel-renderer` owns a `ytReorderableController.handleDrop` callback.
The callback takes `{ currDragItem }`, reads the row's `playlistSetVideoId` and
its new position, then updates YouTube's playback model and native playlist proxy.
The adapter positions one row and calls that callback, then verifies the model;
it does not replace playback controls or claim success from DOM order alone.

Browser fixture tests cannot establish compatibility with every live YouTube
experiment or with every userscript manager's injection mode.

Validation on 2026-09-04: five sorting unit tests and eleven fixture scenarios each
in installed Linux Firefox and Chromium passed, including Trusted Types CSP
enforcement. A public Firefox Developer Edition probe reproduced the v0.1.0 UI
failure (`ShadowRoot.innerHTML` rejected by YouTube's policy) and confirmed the
v0.1.1 button is visible on the real watch page after replacing HTML-string
insertion with DOM creation. The earlier signed-out probe confirmed the native
controller and item data shapes but did not produce an editable queue. Actual
native reordering and playback on YouTube still require the live acceptance
check above.
