# Agent notes

## Installing updates

Violentmonkey in Firefox Developer Edition on regnar tracks
http://127.0.0.1:8731/playlist-sort.user.js with "Track external edits", so it
reinstalls the script whenever the served `dist/playlist-sort.user.js` changes.
Agents may keep `mise exec -- npm run serve` running from the main worktree,
and start it again if it stopped, without asking. Do feature work in a separate
worktree so the served build changes only when verified work is merged to main.
After each merge, tell the user to reload YouTube. If the tracking tab was
closed, ask the user to reopen the install URL and click "Track external
edits" again.
