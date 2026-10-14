# YouTube Up Next Sort

A TypeScript userscript that sorts **loaded upcoming videos** using the same
native handler as YouTube's manual dragging. The current video and everything
before it stay fixed. Equal values preserve their order from before the sort
cycle. Live, upcoming, and unknown durations go last in both directions. It can
also remove watched or repeated videos through each row's own remove action.

## Install in Firefox

The built script is [dist/playlist-sort.user.js](dist/playlist-sort.user.js).
In Tampermonkey or Violentmonkey, create a new script, replace the entire editor
contents with that file, and save. Reload YouTube after installation.

Alternatively, with Node installed, run `npm run serve` and open
<http://127.0.0.1:8731/playlist-sort.user.js> in Firefox. The server binds only to
localhost and serves the compiled script. On a machine in a Tailscale network, it
also listens on that machine's Tailscale addresses and prints their install
links, so other devices on the tailnet can install from it; every device there
can fetch the script while the server runs. Stop it with Ctrl+C after installation.
If your manager doesn't intercept the link, use the editor installation above.

Version 0.4.0 asks for the manager's storage permission (`GM_getValue` and
`GM_setValue`) to keep its settings, so updating from an earlier version needs
the new permissions accepted.

Open a queue or a playing, editable playlist and expand its panel. Each small
neutral button cycles through three actions:

| Button | First click | Second click | Third click |
| --- | --- | --- | --- |
| Duration | Shortest → longest | Longest → shortest | Undo |
| Title | A → Z | Z → A | Undo |
| Views, Likes, when enabled | Fewest → most | Most → fewest | Undo |
| Uploaded, when enabled | Oldest → newest | Newest → oldest | Undo |

When YouTube's queue header holds only its **Save** button, the script shows a
matching Save button first in the same row and hides YouTube's now-empty row.
Clicking it clicks YouTube's own Save button, which stays in the page. Layouts
with other header controls, such as loop or shuffle, keep YouTube's row as is.

The arrow shows the applied direction. Hover for the next action. Undo restores
the order from before that button's first click. Switching to another sort starts
a fresh cycle from the current order. Playback, membership, or external order
changes reset the cycle; reloading also clears undo history.

A sort leaves the longest run of videos already in the new order in place and
drops each other video straight after its new predecessor, so a mostly sorted
queue needs only a few moves.

### Settings

The gear button opens a small panel. Settings are saved in your userscript
manager's storage, not in YouTube's site storage. Toggles save when flipped.
The key field shows the saved key masked and stays editable; a key is saved
only with **Save**, and **Clear** removes it. The panel sits in a closed shadow
root, and requests send the key in a header rather than the address. That keeps
the key from casual reads, but the script runs in YouTube's page context, so a
page script built to intercept it still could. Restrict the key to the YouTube
Data API. If the manager did not grant storage, the panel says so and nothing
is saved.

- **Fetch views, likes and upload dates**, with a YouTube Data API key. Off by
  default. **Views**, **Likes**, and **Uploaded** appear only when this is on
  and a key is saved.
- **Dedupe**: remove repeated videos when sorting. On by default, unless the
  manager grants no storage.

### Views, Likes, and Uploaded

YouTube's queue data has no view, like, or publish-date fields, so these sorts
ask the YouTube Data API (`videos.list`) when clicked, and only then. A click
requests the loaded upcoming videos not fetched in the last eight hours, up to
50 per request; each request costs 1 unit of the key's daily quota (10,000 by
default). Results are kept per video for eight hours in the manager's storage,
so reloads and other tabs reuse them, or in memory until reload without it.
Videos without a value, such as hidden like counts or private videos, go last
in both directions. A rejected key or a used-up quota shows a message under the
row and moves nothing.

Requests go from the page straight to `www.googleapis.com` without cookies and
carry the key (in an `X-Goog-Api-Key` header) and the video IDs. Create the key in Google Cloud console with the
YouTube Data API v3 enabled, and restrict it to that API. The API's publish time
can differ from the upload time.

### Removing videos

**Remove watched** removes every loaded video that YouTube shows with watch
progress, before or after the current video; the current video stays. Any
progress above zero counts. YouTube's figure can lag behind what you watched, so
a video you finished may still show as unwatched or partly watched.

With **Dedupe** on, each sort first removes
upcoming copies of a video that is the current video, appears before it, or
appears earlier among the upcoming ones. Entries at or before the current video
are never removed as repeats.

In a temporary queue, removals run at once. In a saved playlist they change the
playlist itself, so the script first asks "Remove N videos from this saved
playlist?" and does nothing unless you confirm. Removals run one at a time and
each is checked in YouTube's queue data before the next. They cannot be undone,
and a sort's Undo does not bring removed videos back.

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
- The script verifies the native queue data and rendered order after each move
  or removal, waiting for them only when a move does not show at once. This is not server acknowledgement: YouTube handles its own
  network requests and may reject or revert an update later.
- Stopping leaves completed moves and removals applied. Playback changes,
  additions/removals, or unexpected reorders stop further changes. After an
  interrupted sort, the next click offers undo if the same queue and current
  item still permit restoration.
- YouTube's handlers are undocumented and may change. The script's only network
  request is the optional YouTube Data API call described above. It has no
  OAuth flow, cookie access, or third-party runtime dependencies.

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
cancellation, duplicates, and concurrent changes, plus settings storage, a
mocked Data API, and removals. They do not use your regular profile, contact
the Data API, or authenticate to YouTube.

For live acceptance, make a short queue with different lengths, start the first
video, sort, and confirm both **Next** and automatic advancement follow the new
order. Repeat in a disposable editable playlist if you want playlist coverage.

## Source and integration

- `src/sort.ts`: duration parsing, stable tail sorting by each key, and the
  repeated and watched selections.
- `src/youtube.ts`: native queue snapshots, moves, removals, and verification.
- `src/stats.ts`: YouTube Data API requests and their eight-hour cache.
- `src/settings.ts`: settings in the userscript manager's storage.
- `src/userscript.ts`: panel control, settings, Save mirroring, and navigation
  lifecycle.
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

Version 0.4.0 adds settings, fetched sorts, and removals. On 2026-10-13, the
YouTube watch page's Content-Security-Policy had no `connect-src`, and the Data
API answered with `access-control-allow-origin: https://www.youtube.com`, so the
page can call it directly. A dump from the user's signed-in queue located watch
progress at `thumbnailOverlayResumePlaybackRenderer.percentDurationWatched` and
each row's remove action as a `playlistEditEndpoint` with `ACTION_REMOVE_VIDEO`
in its menu; the script passes that endpoint to `ytd-app`'s `resolveCommand`.
Eight unit tests and twenty-one fixture scenarios each in Firefox and Chromium
passed. A signed-out headless Chromium probe on a real temporary queue, with
the built script injected and storage stubbed, removed three repeats on sort,
removed entries before and after the current video while playback continued,
and showed that typing in the key field did not trigger player hotkeys. Not
tested: a real userscript manager with the new grants, a real API key, watch
progress reported by YouTube itself, saved playlists, and Firefox on the live
site. In one earlier probe a removed row reappeared when playback advanced.
The user then installed 0.4.0 in Violentmonkey 2.49.0 and saved a key through
its settings panel, and confirmed in their signed-in queue that the sort row's
Save button opens YouTube's "Save to..." dialog.

Version 0.5.0 saves the key only with **Save**, shows settings as toggles,
turns Dedupe on by default, and keeps fetched details for eight hours. Eight
unit tests and twenty-four fixture scenarios each in Firefox and Chromium
passed on 2026-10-13.

Version 0.6.0 plans the fewest moves and waits less between them: it checks for
each move every 25 ms instead of 100 ms and pauses 50 ms instead of 350 ms
after it. Ten unit tests and twenty-four fixture scenarios each in Firefox and
Chromium passed on 2026-10-13. A signed-out headless Chromium probe on a real
temporary queue of nine videos, with the current video second, ran a Duration
cycle with each build: shortest first took 1.2 s and 3 moves (0.5.0: 8.2 s,
5 moves), longest first 0.9 s and 6 moves (6.6 s, 6), and undo 0.5 s (4.4 s).
Each order still held in YouTube's queue data and rows four seconds later.

Version 0.7.0 drops the waits between moves. YouTube's queue data and rows show
each move by the time its drag handler returns, so the script checks at once
and only waits for the next frame before the next move; it polls every 25 ms
only if a move shows up late. Ten unit tests and twenty-five fixture scenarios
each in Firefox and Chromium passed on 2026-10-14. In the same signed-out
headless Chromium probe on a temporary queue of sixteen upcoming videos, all
32 measured moves showed before the handler returned, and a Duration cycle ran
shortest first in 1.0 s and 11 moves (0.6.0: 2.4 s), longest first in 1.1 s
and 14 moves (2.7 s), and undo in 0.5 s (1.1 s). A second 0.7.0 run took
0.9 s, 1.3 s and 0.6 s, and each order held four seconds later.
