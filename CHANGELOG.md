# Changelog

## [0.1.0] — 2026-03-17

### Added

- Real-time bidirectional sync using Overleaf's native Socket.IO v0.9 / OT protocol
- Smart project selection: pick by number (`-p 3`), fuzzy name (`-p "quantum"`), direct ID, or interactive list
- `overleap sync` — connect and start live syncing
- `overleap projects` — list available Overleaf projects
- `overleap compile` — trigger LaTeX compilation and download PDF
- Automatic reconnection with exponential backoff
- Conflict detection with server re-sync on concurrent edits
- Version gap detection with automatic recovery
- Content-hash based write suppression (no timing-dependent race conditions)
- Per-document send queue preventing duplicate OT version sends
- Atomic file writes (temp + rename) with cleanup on failure
- Binary file download on initial sync (skipped if already local)
- `.env` file support for configuration
- Graceful shutdown on SIGINT/SIGTERM

[0.1.0]: https://github.com/Axect/overleap/releases/tag/v0.1.0
