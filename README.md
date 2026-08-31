# AutoJoinStream

A Vencord user plugin that automatically watches, prioritises, and switches
between Discord streams in your current voice channel. It detects both newly
started streams and streams that were already running when you joined.

AutoJoinStream never moves you into another voice channel.

## Features

- Three multi-stream modes: focus newest, watch all, or replace current.
- A true focus-history stack that returns to the previously watched stream.
- Temporary focus locking, including optional locking after manual selection.
- Ordered user priorities plus user, server, and channel allow/block lists.
- Configurable switch delay and cooldown.
- Normal, side-by-side grid, fullscreen, and stream pop-out display modes.
- Notifications and compatibility error reporting.
- `/autostream` commands for status, locking, and mode changes.

## Install

Custom plugins require a [Vencord source build](https://docs.vencord.dev/installing/custom-plugins/).

From the Vencord repository:

```sh
git clone https://github.com/blacksheep25/AutoJoinStream.git src/userplugins/autoJoinStream
pnpm install --frozen-lockfile
pnpm build
```

For Discord Desktop, run `pnpm inject`, restart Discord, then enable
**AutoJoinStream** under **Settings > Vencord > Plugins**. Vesktop users can
select Vencord's `dist` directory in Vesktop settings.

## Stream modes

- **Focus newest:** watches every stream and focuses the newest eligible one.
  Priority users override recency.
- **Watch all:** watches every stream without changing focus while the current
  stream remains active.
- **Replace current:** disconnects the previous stream and watches only the
  preferred newest stream.

When the focused stream ends, the plugin follows its focus history back to an
eligible stream that is still running.

Choose **Side-by-side grid** as the display mode to show all watched streams in
Discord's native grid instead of enlarging one participant.

## Rules and priorities

All ID settings accept comma-separated Discord IDs:

- **Allowed users:** empty means everyone; otherwise only listed users qualify.
- **Blocked users:** always excluded, even if present in the allowed list.
- **Priority users:** ordered from highest to lowest priority.
- **Allowed/blocked servers and channels:** scope automatic watching to the
  places where you want it.

Enable Discord Developer Mode and right-click a user, server, or channel to copy
its ID.

## Commands

- `/autostream lock` pauses automatic focus changes for the current session.
- `/autostream unlock` resumes automatic focus changes.
- `/autostream status` shows mode, lock, channel, detected streams, and errors.
- `/autostream mode` changes multi-stream behavior.

## Development

The GitHub workflow tests the plugin against current Vencord using ESLint,
TypeScript, and a full build. Tags matching `v*` create a GitHub release with a
ready-to-copy zip archive.

Discord client internals are not a public API. AutoJoinStream validates the
required store on startup and reports compatibility failures through a toast and
`/autostream status`.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
