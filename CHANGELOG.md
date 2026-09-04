# Changelog

All notable changes to AutoJoinStream are documented here.

## [v2.4.0] - 2026-09-05

### Added

- Automatic display mode: focus a single stream and switch to Discord's native
  grid when multiple streams are active.
- Optional automatic full-screen maximising for focused streams.
- Optional automatic member-panel hiding while watching streams.
- Configurable automatic stream volume from muted through 200%.
- Timed manual-focus locks with 5, 15, 30, and 60-minute presets.
- `/autostream next` and `/autostream previous` commands for cycling through
  active streams.
- `/autostream volume` for changing the focused stream's volume.
- An optional duration argument for `/autostream lock`.

### Changed

- The previous automatic-mute toggle now migrates to the new stream-volume
  setting at 0%.
- `/autostream status` now reports configured stream volume and timed-lock
  expiry.

### Fixed

- Previous stream volume, call layout, own-stream visibility, and member-panel
  state are restored when appropriate.
- Manual layout, volume, and member-panel changes are respected instead of
  being overwritten during cleanup.
- Automatic layout updates correctly when the number of active streams changes.

## [v2.3.0] - 2026-09-01

### Added

- Optional automatic muting for shared stream audio without muting voice chat.
- Restoration of previous stream volume when a managed stream ends.

## [v2.2.0] - 2026-09-01

### Added

- Own screen shares are hidden from side-by-side grid mode by default.
- A setting to show your own screen share in the grid when desired.

## [v2.1.0] - 2026-09-01

### Added

- Side-by-side display using Discord's native stream grid.

## [v2.0.1] - 2026-09-01

### Fixed

- Removed the large blank area that could appear below a focused stream in
  normal display mode.

## [v2.0.0] - 2026-09-01

### Added

- Multi-stream modes for focusing the newest stream, watching all streams, or
  replacing the current stream.
- Focus history with automatic fallback when the current stream ends.
- Manual focus locking, user priorities, allow/block filters, switching delays,
  cooldowns, notifications, compatibility reporting, and `/autostream`
  commands.
- Automated lint, TypeScript, build, and release workflows.

[v2.4.0]: https://github.com/blacksheep25/AutoJoinStream/compare/v2.3.0...v2.4.0
[v2.3.0]: https://github.com/blacksheep25/AutoJoinStream/compare/v2.2.0...v2.3.0
[v2.2.0]: https://github.com/blacksheep25/AutoJoinStream/compare/v2.1.0...v2.2.0
[v2.1.0]: https://github.com/blacksheep25/AutoJoinStream/compare/v2.0.1...v2.1.0
[v2.0.1]: https://github.com/blacksheep25/AutoJoinStream/compare/v2.0.0...v2.0.1
[v2.0.0]: https://github.com/blacksheep25/AutoJoinStream/releases/tag/v2.0.0
