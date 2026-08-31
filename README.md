# AutoJoinStream

A private Vencord user plugin that automatically starts watching a stream when
someone begins streaming in your current voice channel. It also detects streams
that were already running when you joined the channel or enabled the plugin.

It deliberately does **not** move you into another voice channel. If multiple
people are streaming, Discord's normal multi-stream behavior still applies.

## Install

Custom plugins require a Vencord build from source.

1. Copy this entire `autoJoinStream` folder into `Vencord/src/userplugins/`.
2. From the Vencord repository, run `pnpm build`.
3. For Discord Desktop, run `pnpm inject` and select your Discord install.
   For Vesktop, select Vencord's `dist` folder in Vesktop settings instead.
4. Restart Discord or Vesktop.
5. Open **Settings > Vencord > Plugins**, find **AutoJoinStream**, and enable it.

## Settings

- **User IDs:** Leave empty to watch anyone in your current voice channel, or
  enter comma-separated Discord user IDs to restrict automatic watching.
- **Stream mode:** Controls what happens when multiple people stream:
  - **Focus newest:** keeps all streams playing and focuses the latest one.
  - **Watch all:** keeps all streams playing without changing focus after the
    first stream.
  - **Replace current:** stops watching the previous stream and focuses the
    latest one.

When the focused stream ends, the plugin returns to the most recently started
eligible stream that is still running.

To copy a user ID, enable Discord's Developer Mode, right-click the user, and
choose **Copy User ID**.

## Compatibility note

Discord's client internals are not a public API. A Discord update can rename the
internal stream action and require this plugin's module lookup to be adjusted.
