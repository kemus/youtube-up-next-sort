# Agent notes

## Installing updates

Violentmonkey in Firefox on regnar and devarc installs the script from
https://raw.githubusercontent.com/kemus/youtube-up-next-sort/main/dist/playlist-sort.user.js,
which the script also names as its update URL, so each higher `@version` on
main reaches both machines on Violentmonkey's daily update check. Bump the
version in every change that reaches main, and do feature work in a separate
worktree.

Agents may push verified merges on main to github.com/kemus/youtube-up-next-sort
(public) without asking. After a push, tell the user to click Violentmonkey's
"Check for updates" and reload YouTube.

Agents may keep `mise exec -- npm run serve` running from the main worktree
to test a build before it is pushed.
