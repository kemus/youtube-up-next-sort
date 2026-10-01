# YouTube Up Next Sort

A TypeScript userscript that sorts **loaded upcoming videos** using the same
native handler as YouTube's manual dragging. The current video and everything
before it stay fixed. Equal values preserve their order from before the sort
cycle. Live, upcoming, and unknown durations go last in both directions.

## Install in Firefox

The built script is [dist/playlist-sort.user.js](dist/playlist-sort.user.js).
In Tampermonkey or Violentmonkey, create a new script, replace the entire editor
contents with that file, and save. Reload YouTube after installation.

Alternatively, with Node installed, run `npm run serve` and open
<http://127.0.0.1:8731/playlist-sort.user.js> in Firefox. The server binds only to
localhost and serves the compiled script. Stop it with Ctrl+C after installation.
If your manager doesn't intercept the link, use the editor installation above.

Open a queue or a playing, editable playlist and expand its panel. Each small
neutral button cycles through three actions:

| Button | First click | Second click | Third click |
| --- | --- | --- | --- |
| Duration | Shortest → longest | Longest → shortest | Undo |
| Title | A → Z | Z → A | Undo |
| Date, when available | Oldest → newest | Newest → oldest | Undo |

When YouTube's queue header holds only its **Save** button, the script shows a
matching Save button first in the same row and hides YouTube's now-empty row.
Clicking it clicks YouTube's own Save button, which stays in the page. Layouts
with other header controls, such as loop or shuffle, keep YouTube's row as is.

The arrow shows the applied direction. Hover for the next action. Undo restores
the order from before that button's first click. Switching to another sort starts
a fresh cycle from the current order. Playback, membership, or external order
changes reset the cycle; reloading also clears undo history.

**Date** appears only when every loaded upcoming item already carries a posting
date in YouTube's page data. The script never fetches extra metadata for it and
never substitutes the date added to the playlist. ISO dates and recognizable
English relative posting ages are supported; relative ages are approximate.

The active button becomes **Stop** while moves run. Scope and playlist details
are in hover tooltips; only errors or required actions show extra text.

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
  or unexpected reorders stop further moves. After an interrupted sort, the next
  click offers undo if the same queue and current item still permit restoration.
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

- `src/sort.ts`: duration/date parsing and stable tail sorting by each key.
- `src/youtube.ts`: native queue snapshots, moves, and verification.
- `src/userscript.ts`: panel control, Save mirroring, and navigation lifecycle.
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
controller and item data shapes but did not produce an editable queue. The user
subsequently reported that sorting works in their live session. Version 0.2.0
adds the sort cycles; no further browser testing was run at the user's request.
Version 0.3.0 moves Save into the sort row. On 2026-10-01, a dump from the user's
signed-in queue located Save as the only control under `#playlist-actions`
(`#flexible-item-buttons > ytd-button-renderer`). A signed-out probe of a public
playlist confirmed that its item data has no view, like, or publish-date fields.
Thirteen fixture scenarios each passed in Firefox and Chromium; the live Save
button was not yet tested.
