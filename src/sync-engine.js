'use strict';

const fs = require('fs');
const path = require('path');
const { computeOps } = require('./diff');
const { flattenTree } = require('./tree');

class SyncEngine {
  constructor(socketManager, watcher, dir, baseUrl, cookie) {
    this.socket = socketManager;
    this.watcher = watcher;
    this.dir = path.resolve(dir);
    this.baseUrl = baseUrl;
    this.cookie = cookie;

    // State per document: docId → { path, version, content, sending, dirty, pendingContent, needsResync }
    // content: last server-confirmed content
    // pendingContent: content we sent but haven't received ack for
    this.docs = new Map();
    // Reverse map: relativePath → docId
    this.pathToDocId = new Map();
    // Binary files: fileRefId → relativePath
    this.filePaths = new Map();

    // H2: store bound handler reference for cleanup
    this._onFileChange = (event) => this._onLocalChange(event);

    this._setupHandlers();
  }

  _setupHandlers() {
    // Remote → Local: OT updates from server
    this.socket.on('otUpdateApplied', (update) => this._onRemoteUpdate(update));
    this.socket.on('otUpdateError', (err) => {
      console.error('[sync] OT update error:', err);
      if (err && err.doc) {
        const docState = this.docs.get(err.doc);
        if (docState) {
          docState.sending = false;
          docState.pendingContent = null;
          this._resyncDoc(err.doc).catch((e) => console.error('[sync] Re-sync error:', e.message));
        }
      }
    });

    this.socket.on('reciveNewDoc', ({ parentFolderId, doc }) => {
      console.log(`[sync] New doc on server: ${doc.name}`);
    });

    // M3: use async fs.promises.unlink instead of blocking unlinkSync
    this.socket.on('removeEntity', ({ entityId }) => {
      const docState = this.docs.get(entityId);
      if (docState) {
        console.log(`[sync] Doc removed on server: ${docState.path}`);
        const absPath = path.join(this.dir, docState.path);
        const release = this.watcher.suppress(absPath);
        fs.promises.unlink(absPath).catch(() => {}).finally(release);
        this.docs.delete(entityId);
        this.pathToDocId.delete(docState.path);
      }
    });

    // Local → Remote: file changes (H2: use stored reference)
    this.watcher.on('file-change', this._onFileChange);
  }

  /**
   * H2: detach watcher listener on cleanup (prevents listener accumulation on reconnect)
   */
  detach() {
    this.watcher.removeListener('file-change', this._onFileChange);
  }

  /**
   * Initial sync: join all docs, write to local filesystem.
   */
  async initialSync(project) {
    const { docPaths, pathDocs, filePaths, pathFiles } = flattenTree(project.rootFolder);

    this.filePaths = filePaths;

    fs.mkdirSync(this.dir, { recursive: true });

    const docEntries = Array.from(docPaths.entries());
    console.log(`[sync] Joining ${docEntries.length} docs...`);

    for (const [docId, relPath] of docEntries) {
      try {
        const { lines, version } = await this.socket.joinDoc(docId);
        const content = lines.join('\n');

        this.docs.set(docId, {
          path: relPath,
          version,
          content,
          sending: false,
          dirty: false,
          pendingContent: null,
          needsResync: false,
        });
        this.pathToDocId.set(relPath, docId);

        const absPath = path.join(this.dir, relPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });

        // H4: suppress with content hash
        const release = this.watcher.suppress(absPath, content);
        this._atomicWrite(absPath, content);
        release();

        console.log(`  ✓ ${relPath} (v${version})`);
      } catch (err) {
        console.error(`  ✗ ${relPath}: ${err.message}`);
      }
    }

    // Download binary files — skip if already exists locally
    const fileEntries = Array.from(filePaths.entries());
    if (fileEntries.length > 0) {
      const { httpGetBinary } = require('./auth');
      let downloaded = 0, skipped = 0;

      for (const [fileId, relPath] of fileEntries) {
        const absPath = path.join(this.dir, relPath);

        if (fs.existsSync(absPath)) {
          skipped++;
          continue;
        }

        try {
          const url = `${this.baseUrl}/project/${this.socket.projectId}/file/${fileId}`;
          const res = await httpGetBinary(url, this.cookie);
          if (res.status === 200) {
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            const release = this.watcher.suppress(absPath);
            fs.writeFileSync(absPath, res.body);
            release();
            downloaded++;
            console.log(`  ✓ ${relPath} (binary)`);
          } else {
            console.error(`  ✗ ${relPath}: HTTP ${res.status}`);
          }
        } catch (err) {
          console.error(`  ✗ ${relPath}: ${err.message}`);
        }
      }

      if (downloaded > 0 || skipped > 0) {
        console.log(`[sync] Binary files: ${downloaded} downloaded, ${skipped} skipped (already exist)`);
      }
    }

    console.log(`[sync] Initial sync complete. Watching for changes...`);
  }

  /**
   * Handle remote OT update → apply to local file.
   */
  _onRemoteUpdate(update) {
    if (!update || !update.doc) return;

    const docState = this.docs.get(update.doc);
    if (!docState) return;

    // Ack for our own update (no op field, or empty op)
    if (!update.op || update.op.length === 0) {
      docState.version = update.v;
      docState.sending = false;

      if (docState.needsResync) {
        docState.needsResync = false;
        docState.pendingContent = null;
        docState.dirty = false;
        this._resyncDoc(update.doc).catch((e) => console.error('[sync] Re-sync error:', e.message));
        return;
      }

      // Commit the pending content as server-confirmed
      if (docState.pendingContent !== null) {
        docState.content = docState.pendingContent;
        docState.pendingContent = null;
      }

      if (docState.dirty) {
        docState.dirty = false;
        this._flushDoc(update.doc).catch((e) => console.error('[sync] Flush error:', e.message));
      }
      return;
    }

    // Remote change from another user
    if (docState.sending) {
      docState.version = update.v;
      docState.needsResync = true;
      console.log(`[sync] Conflict detected on ${docState.path} — will re-sync after ack`);
      return;
    }

    // M7: version gap detection
    const expectedVersion = docState.version + 1;
    if (update.v !== expectedVersion) {
      console.log(`[sync] Version gap on ${docState.path}: expected v${expectedVersion}, got v${update.v} — re-syncing`);
      this._resyncDoc(update.doc).catch((e) => console.error('[sync] Re-sync error:', e.message));
      return;
    }

    // Normal case: apply remote ops to in-memory content
    let content = docState.content;
    for (const op of update.op) {
      if (op.d) {
        content = content.slice(0, op.p) + content.slice(op.p + op.d.length);
      }
      if (op.i) {
        content = content.slice(0, op.p) + op.i + content.slice(op.p);
      }
    }

    docState.content = content;
    docState.version = update.v;

    // Write to local file (H4: suppress with content hash)
    const absPath = path.join(this.dir, docState.path);
    const release = this.watcher.suppress(absPath, content);
    this._atomicWrite(absPath, content);
    release();

    console.log(`[remote→local] ${docState.path} (v${update.v})`);
  }

  /**
   * Handle local file change → queue OT update.
   */
  _onLocalChange(event) {
    const { type, relativePath } = event;

    if (type === 'unlink') {
      console.log(`[local] File deleted: ${relativePath} (not synced to server)`);
      return;
    }

    const docId = this.pathToDocId.get(relativePath);
    if (!docId) {
      return; // binary or untracked file — ignore silently
    }

    const docState = this.docs.get(docId);
    if (!docState) return;

    if (docState.sending) {
      docState.dirty = true;
      return;
    }

    this._flushDoc(docId).catch((e) => console.error('[sync] Flush error:', e.message));
  }

  /**
   * Compute diff and send OT ops for a document.
   * Only called when docState.sending is false.
   */
  async _flushDoc(docId) {
    const docState = this.docs.get(docId);
    if (!docState || docState.sending) return;

    const absPath = path.join(this.dir, docState.path);

    let newContent;
    try {
      newContent = fs.readFileSync(absPath, 'utf-8');
    } catch (err) {
      console.error(`[sync] Cannot read ${docState.path}: ${err.message}`);
      return;
    }

    if (newContent === docState.content) {
      docState.dirty = false;
      return;
    }

    const ops = computeOps(docState.content, newContent);
    if (ops.length === 0) {
      docState.dirty = false;
      return;
    }

    docState.sending = true;
    docState.pendingContent = newContent;

    console.log(`[local→remote] ${docState.path} (${ops.length} ops, v${docState.version})`);

    try {
      await this.socket.applyOtUpdate(docId, ops, docState.version, newContent);
      // Content will be committed when ack arrives in _onRemoteUpdate
    } catch (err) {
      console.error(`[sync] Failed to sync ${docState.path}: ${err.message}`);
      docState.sending = false;
      docState.pendingContent = null;
    }
  }

  /**
   * Re-sync a document from the server after a conflict or version gap.
   */
  async _resyncDoc(docId) {
    const docState = this.docs.get(docId);
    if (!docState) return;

    console.log(`[sync] Re-syncing ${docState.path} from server...`);

    try {
      this.socket.leaveDoc(docId);
      const { lines, version } = await this.socket.joinDoc(docId);
      const serverContent = lines.join('\n');

      docState.version = version;
      docState.content = serverContent;
      docState.sending = false;
      docState.pendingContent = null;
      docState.needsResync = false;

      const absPath = path.join(this.dir, docState.path);
      const release = this.watcher.suppress(absPath, serverContent);
      this._atomicWrite(absPath, serverContent);
      release();

      console.log(`[sync] Re-synced ${docState.path} (v${version})`);
    } catch (err) {
      console.error(`[sync] Re-sync failed for ${docState.path}: ${err.message}`);
    }
  }

  /**
   * L3: Atomic write with temp file cleanup on failure.
   */
  _atomicWrite(filePath, content) {
    const tmpPath = filePath + '.tmp.' + process.pid;
    try {
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      // Clean up temp file on failure
      try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
      throw err;
    }
  }

  /**
   * Cleanup: leave all docs.
   */
  cleanup() {
    for (const docId of this.docs.keys()) {
      try {
        this.socket.leaveDoc(docId);
      } catch (e) { /* ignore */ }
    }
  }
}

module.exports = SyncEngine;
