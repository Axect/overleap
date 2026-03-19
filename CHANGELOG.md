# Changelog

## [0.2.4] — 2026-03-19

### Fixed

- **Binary file delete/re-upload loop**: added path-based watcher suppression for binary files (no content hash available) — suppresses all event types including `unlink`, preventing the loop when multiple binary files change simultaneously
- **Socket connection leak**: `connect()` timeout, `error`, and `connect_failed` handlers now disconnect the socket before rejecting
- **Reconnect socket leak**: old `socketManager` is disconnected before creating a new one during reconnect
- **Concurrent folder creation**: `_ensureFolder` deduplicates simultaneous requests for the same folder path via in-flight promise tracking
- **Zero-byte binary update**: `_handleBinaryUpdate` skips 0-byte files instead of uploading empty content
- **Remote file create race**: map entries (`filePaths`, `pathToFileId`) are now set before file write in `_handleRemoteFileCreate`, so concurrent events see the file as tracked
- **JSON parse safety**: 4 unguarded `JSON.parse` calls (create doc, upload, update, create folder responses) wrapped in try/catch
- **OT op branching**: `else if` for `op.i` prevents theoretical double-application when an op has both `d` and `i` fields
- **Filename sanitization**: `sanitizeFileName` strips control characters and quotes before multipart upload headers

### Added

- **Concurrent binary upload throttling**: `Semaphore(3)` limits simultaneous binary uploads, preventing server overload
- **Auth token auto-refresh**: `_refreshAuthIfNeeded` retries on HTTP 403 after refreshing cookie/CSRF via `onAuthExpired` callback
- **O(1) folder path lookup**: `_folderIdToPath` reverse map replaces O(n) scan in `_folderPathById`
- **Test infrastructure**: 38 tests via `node:test` covering `computeOps`, `flattenTree`, watcher suppression (including unlink), and sync-engine core logic
- Centralized `IGNORE_PATTERNS` in `constants.js`, shared between watcher and sync-engine

### Changed

- `listProjects()` now calls `updateCookies` for session stickiness
- `require('fs')` moved to module top-level in watcher (was inlined in `_handleEvent`)

## [0.2.3] — 2026-03-17

### Fixed

- **Copy-paste upload reliability**: increased `awaitWriteFinish` stability threshold from 50ms to 500ms, preventing premature reads of partially-written files during copy-paste operations
- **Zero-byte file handling**: files read as 0 bytes (still being written) are now retried up to 2 times with increasing delay instead of uploading empty content
- **Transient upload failures**: binary uploads now retry once after 1s on HTTP error before giving up

### Changed

- Upload failure logs now include file size and full response body (up to 500 chars) for better diagnosis
- Successful upload logs now show file size

## [0.2.2] — 2026-03-17

### Fixed

- **Binary file upload broken**: Overleaf's upload endpoint requires a `name` form field (`req.body.name`) for the display filename — added the missing multipart field to `httpPostMultipart`, fixing HTTP 422 `invalid_filename` errors on all binary uploads
- **Spurious upload attempts on tracked binary files**: watcher `add` events on already-tracked binary files (e.g. after startup) no longer fall through to `_handleLocalCreate`, preventing unnecessary 422 errors

### Changed

- Upload failure logs now include the server response body (truncated to 200 chars) for easier diagnosis

## [0.2.1] — 2026-03-17

### Fixed

- **OT version tracking**: fixed stale version numbers causing "Delete component does not match" errors — `docState.version` now correctly increments after self-update acks and remote updates, matching the ShareJS OT protocol
- **Timeout handling**: send timeouts now enter an "uncertain" state instead of immediately clearing pending state, preventing content drift and duplicate sends when the server applies ops but the callback is lost
- **Pre-send race condition**: added snapshot fence in `_flushDoc` to detect concurrent remote updates arriving during the 50ms content stability check

### Changed

- Replaced boolean `sending` flag and `pendingContent` string with structured `pending` record (`{ baseVersion, targetContent, sentAt, sendEpoch }`) for explicit in-flight operation tracking
- Added monotonic `sendEpoch` counter to prevent stale ack confusion after resyncs
- Self-update acks are now validated: stray/duplicate acks with no pending send are silently ignored instead of corrupting version state
- Non-timeout send failures now trigger immediate resync instead of silently clearing state

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

[0.2.4]: https://github.com/Axect/overleap/releases/tag/v0.2.4
[0.2.3]: https://github.com/Axect/overleap/releases/tag/v0.2.3
[0.2.2]: https://github.com/Axect/overleap/releases/tag/v0.2.2
[0.2.1]: https://github.com/Axect/overleap/releases/tag/v0.2.1
[0.2.0]: https://github.com/Axect/overleap/releases/tag/v0.2.0
[0.1.0]: https://github.com/Axect/overleap/releases/tag/v0.1.0
