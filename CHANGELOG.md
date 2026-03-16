# Changelog

## [0.2.0] — 2026-03-17

### Added

- Full binary file sync: upload, update, and delete binary files (images, PDFs, etc.) via Overleaf's multipart upload API
- Auto-detect text vs binary files by extension (`.tex`, `.bib`, `.sty`, etc. → OT doc; everything else → binary upload)
- Upload local-only files on initial sync (files that exist locally but not on the server)
- Handle `reciveNewDoc` / `reciveNewFile` socket events — auto-download docs and files created by collaborators
- Binary file deletion sync (local delete → server delete via REST API)
- Binary file re-upload on local change

### Fixed

- Untracked file changes (files existing before watcher start) now trigger server creation instead of being silently ignored
- `removeEntity` handler now cleans up binary files in addition to text docs
- Rapid edits from AI agents no longer upload corrupted text — added per-doc flush debouncing (150ms) and content stability verification before OT send

### Changed

- All HTTP helpers (`httpPost`, `httpDelete`, `httpGetBinary`, `httpPostMultipart`) imported at module top level instead of inline `require()`
- `SyncEngine` constructor accepts `projectId` and `csrfToken` (required for REST API calls)
- Folder tracking (`pathToFolderId`, `rootFolderId`) populated during initial sync for file/folder creation

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

[0.2.0]: https://github.com/Axect/overleap/releases/tag/v0.2.0
[0.1.0]: https://github.com/Axect/overleap/releases/tag/v0.1.0
