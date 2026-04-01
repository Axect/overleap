'use strict';

const fs = require('fs');
const path = require('path');
const { computeOps } = require('./diff');
const { flattenTree } = require('./tree');
const { IGNORE_PATTERNS } = require('./constants');
const { httpPost, httpDelete, httpPostMultipart, httpGetBinary } = require('./auth');

const TEXT_EXTENSIONS = new Set([
  '.tex', '.bib', '.cls', '.sty', '.bst', '.def', '.cfg', '.dtx', '.ins',
  '.fd', '.clo', '.ldf', '.bbx', '.cbx', '.dbx', '.lbx',
  '.txt', '.md', '.csv', '.tsv', '.log', '.bbl', '.aux', '.toc',
  '.lof', '.lot', '.out', '.nav', '.snm', '.vrb', '.listing',
  '.tikz', '.pgf', '.eps_tex', '.pdf_tex',
  '.spl', '.glsdefs', '.ist', '.gls', '.glo', '.acn', '.acr', '.alg',
  '.idx', '.ind', '.ilg', '.nlo', '.nls', '.nomencl',
  '.pytxcode', '.rnw', '.rtex',
  '.latexmkrc', '.gitignore', '.yml', '.yaml', '.json', '.xml', '.html',
  '.css', '.js', '.r', '.py', '.lua', '.sh', '.bat', '.makefile',
]);

function isTextFile(relativePath) {
  const basename = path.basename(relativePath).toLowerCase();
  // Files without extension but known names
  if (basename === 'makefile' || basename === 'latexmkrc' || basename === '.gitignore') return true;
  const ext = path.extname(relativePath).toLowerCase();
  return ext !== '' && TEXT_EXTENSIONS.has(ext);
}

class Semaphore {
  constructor(max) {
    this._max = max;
    this._count = 0;
    this._queue = [];
  }

  acquire() {
    return new Promise((resolve) => {
      if (this._count < this._max) {
        this._count++;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  }

  release() {
    this._count--;
    if (this._queue.length > 0) {
      this._count++;
      this._queue.shift()();
    }
  }
}

class SyncEngine {
  constructor(socketManager, watcher, dir, baseUrl, cookie, projectId, csrfToken, opts = {}) {
    this.socket = socketManager;
    this.watcher = watcher;
    this.dir = path.resolve(dir);
    this.baseUrl = baseUrl;
    this.cookie = cookie;
    this.projectId = projectId;
    this.csrfToken = csrfToken;
    this.onAuthExpired = opts.onAuthExpired || null;

    // State per document: docId -> { path, version, content, pending, dirty, needsResync }
    // content: last server-confirmed content
    // pending: null (idle) or { baseVersion, targetContent, sentAt, sendEpoch } (awaiting ack)
    this.docs = new Map();
    // Monotonic send epoch counter — survives resyncs, prevents stale ack confusion
    this._sendEpoch = 0;
    // Reverse map: relativePath -> docId
    this.pathToDocId = new Map();
    // Binary files: fileRefId -> relativePath
    this.filePaths = new Map();
    // Reverse map: relativePath -> fileRefId
    this.pathToFileId = new Map();
    // Folder tracking: relativePath -> folderId
    this.pathToFolderId = new Map();
    // Reverse map: folderId -> relativePath (O(1) lookup)
    this._folderIdToPath = new Map();
    this.rootFolderId = null;
    // Prevent duplicate creation/upload attempts
    this._creatingFiles = new Set();
    // Prevent concurrent folder creation for the same path
    this._creatingFolders = new Map();
    // Track file entity IDs being replaced by _handleBinaryUpdate
    // so removeEntity can skip deleting the local file during replacement
    this._replacingFileIds = new Set();
    // Per-doc flush debounce timers (rapid edit protection)
    this._flushTimers = new Map();
    // Track locally-initiated doc creates (relativePath -> content saved before POST).
    // Lets _handleRemoteDocCreate distinguish our own echo from a legitimate remote create.
    this._locallyInitiated = new Map();
    // Limit concurrent binary uploads
    this._binarySemaphore = new Semaphore(3);

    // H2: store bound handler reference for cleanup
    this._onFileChange = (event) => this._onLocalChange(event);

    this._setupHandlers();
  }

  _setupHandlers() {
    // Remote -> Local: OT updates from server
    this.socket.on('otUpdateApplied', (update) => this._onRemoteUpdate(update));
    this.socket.on('otUpdateError', (err) => {
      console.error('[sync] OT update error:', err);
      if (err && err.doc) {
        const docState = this.docs.get(err.doc);
        if (docState) {
          docState.pending = null;
          this._resyncDoc(err.doc).catch((e) => console.error('[sync] Re-sync error:', e.message));
        }
      }
    });

    this.socket.on('reciveNewDoc', ({ parentFolderId, doc }) => {
      this._handleRemoteDocCreate(parentFolderId, doc).catch((e) =>
        console.error('[sync] Remote doc create error:', e.message)
      );
    });

    this.socket.on('reciveNewFile', ({ parentFolderId, file }) => {
      this._handleRemoteFileCreate(parentFolderId, file).catch((e) =>
        console.error('[sync] Remote file create error:', e.message)
      );
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
        return;
      }

      const filePath = this.filePaths.get(entityId);
      if (filePath) {
        // If this entity is being replaced by _handleBinaryUpdate, skip
        // the local file deletion — the file has been updated, not removed.
        if (this._replacingFileIds.has(entityId)) {
          this.filePaths.delete(entityId);
          return;
        }
        console.log(`[sync] Binary file removed on server: ${filePath}`);
        const absPath = path.join(this.dir, filePath);
        const release = this.watcher.suppress(absPath);
        fs.promises.unlink(absPath).catch(() => {}).finally(release);
        this.filePaths.delete(entityId);
        this.pathToFileId.delete(filePath);
      }
    });

    // Local -> Remote: file changes (H2: use stored reference)
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
    const { docPaths, pathDocs, filePaths, pathFiles, folderPaths, pathFolders, rootFolderId } = flattenTree(project.rootFolder);

    this.filePaths = filePaths;
    this.pathToFileId = pathFiles;
    this.pathToFolderId = pathFolders;
    this.rootFolderId = rootFolderId;

    // Build reverse map: folderId -> relativePath
    this._folderIdToPath = new Map();
    if (folderPaths) {
      for (const [folderId, folderPath] of folderPaths.entries()) {
        this._folderIdToPath.set(folderId, folderPath);
      }
    }

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
          pending: null,
          dirty: false,
          needsResync: false,
        });
        this.pathToDocId.set(relPath, docId);

        const absPath = path.join(this.dir, relPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });

        // H4: suppress with content hash
        const release = this.watcher.suppress(absPath, content);
        this._atomicWrite(absPath, content);
        release();

        console.log(`  \u2713 ${relPath} (v${version})`);
      } catch (err) {
        console.error(`  \u2717 ${relPath}: ${err.message}`);
      }
    }

    // Download binary files — skip if already exists locally
    const fileEntries = Array.from(filePaths.entries());
    if (fileEntries.length > 0) {
      let downloaded = 0, skipped = 0;

      for (const [fileId, relPath] of fileEntries) {
        const absPath = path.join(this.dir, relPath);

        if (fs.existsSync(absPath)) {
          skipped++;
          continue;
        }

        try {
          const url = `${this.baseUrl}/project/${this.projectId}/file/${fileId}`;
          const res = await httpGetBinary(url, this.cookie);
          if (res.status === 200) {
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            const release = this.watcher.suppress(absPath);
            fs.writeFileSync(absPath, res.body);
            release();
            downloaded++;
            console.log(`  \u2713 ${relPath} (binary)`);
          } else {
            console.error(`  \u2717 ${relPath}: HTTP ${res.status}`);
          }
        } catch (err) {
          console.error(`  \u2717 ${relPath}: ${err.message}`);
        }
      }

      if (downloaded > 0 || skipped > 0) {
        console.log(`[sync] Binary files: ${downloaded} downloaded, ${skipped} skipped (already exist)`);
      }
    }

    // Upload local-only files that don't exist on the server
    await this._uploadLocalOnly();

    console.log(`[sync] Initial sync complete. Watching for changes...`);
  }

  /**
   * Scan local directory for files not tracked by the server and upload them.
   */
  async _uploadLocalOnly() {
    const localFiles = this._scanDir(this.dir, '');
    const serverPaths = new Set([...this.pathToDocId.keys(), ...this.pathToFileId.keys()]);

    const untracked = localFiles.filter((rel) => !serverPaths.has(rel));
    if (untracked.length === 0) return;

    console.log(`[sync] Found ${untracked.length} local-only file(s), uploading...`);

    for (const relativePath of untracked) {
      try {
        await this._handleLocalCreate(relativePath);
      } catch (err) {
        console.error(`  \u2717 ${relativePath}: ${err.message}`);
      }
    }
  }

  /**
   * Recursively scan a directory, returning relative paths (respecting ignore patterns).
   */
  _scanDir(base, prefix) {
    const results = [];

    let entries;
    try {
      entries = fs.readdirSync(path.join(base, prefix), { withFileTypes: true });
    } catch (e) {
      return results;
    }

    for (const entry of entries) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (IGNORE_PATTERNS.some((p) => p.test(rel))) continue;

      if (entry.isDirectory()) {
        results.push(...this._scanDir(base, rel));
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }

    return results;
  }

  /**
   * Handle remote OT update -> apply to local file.
   */
  _onRemoteUpdate(update) {
    if (!update || !update.doc) return;

    const docState = this.docs.get(update.doc);
    if (!docState) return;

    // Ack for our own update (no op field, or empty op)
    if (!update.op || update.op.length === 0) {
      // Validate: ack must correspond to a pending send
      if (!docState.pending) {
        // Stray/duplicate ack with no pending send — ignore
        return;
      }
      // Our update was applied — advance version past it
      docState.version++;
      const committedContent = docState.pending.targetContent;
      docState.pending = null;

      if (docState.needsResync) {
        docState.needsResync = false;
        docState.dirty = false;
        this._resyncDoc(update.doc).catch((e) => console.error('[sync] Re-sync error:', e.message));
        return;
      }

      // Commit the pending content as server-confirmed
      docState.content = committedContent;

      if (docState.dirty) {
        docState.dirty = false;
        this._scheduleFlush(update.doc);
      }
      return;
    }

    // Remote change from another user
    if (docState.pending) {
      docState.version = update.v + 1;
      docState.needsResync = true;
      console.log(`[sync] Conflict detected on ${docState.path} — will re-sync after ack`);
      return;
    }

    // M7: version gap detection — update.v should equal our current version
    if (update.v !== docState.version) {
      console.log(`[sync] Version gap on ${docState.path}: expected v${docState.version}, got v${update.v} — re-syncing`);
      this._resyncDoc(update.doc).catch((e) => console.error('[sync] Re-sync error:', e.message));
      return;
    }

    // Normal case: apply remote ops to in-memory content
    let content = docState.content;
    for (const op of update.op) {
      if (op.d) {
        content = content.slice(0, op.p) + content.slice(op.p + op.d.length);
      } else if (op.i) {
        content = content.slice(0, op.p) + op.i + content.slice(op.p);
      }
    }

    docState.content = content;
    docState.version = update.v + 1;

    // Write to local file (H4: suppress with content hash)
    const absPath = path.join(this.dir, docState.path);
    const release = this.watcher.suppress(absPath, content);
    this._atomicWrite(absPath, content);
    release();

    console.log(`[remote\u2192local] ${docState.path} (v${update.v})`);
  }

  /**
   * Handle local file change -> queue OT update, create, or delete on server.
   */
  _onLocalChange(event) {
    const { type, relativePath } = event;

    if (type === 'unlink') {
      this._handleLocalDelete(relativePath).catch((e) =>
        console.error('[sync] Delete error:', e.message)
      );
      return;
    }

    // Existing text doc — OT sync
    const docId = this.pathToDocId.get(relativePath);
    if (docId) {
      const docState = this.docs.get(docId);
      if (!docState) return;

      if (docState.pending) {
        docState.dirty = true;
        return;
      }

      this._scheduleFlush(docId);
      return;
    }

    // Existing binary file — re-upload on change, skip on add (already on server)
    const fileId = this.pathToFileId.get(relativePath);
    if (fileId) {
      if (type === 'change') {
        this._handleBinaryUpdate(relativePath, fileId).catch((e) =>
          console.error('[sync] Binary update error:', e.message)
        );
      }
      return;
    }

    // Untracked file — create on server
    // Handles both 'add' (new file) and 'change' (file existed locally before sync started)
    this._handleLocalCreate(relativePath).catch((e) =>
      console.error('[sync] Create error:', e.message)
    );
  }

  /**
   * Schedule a debounced flush for a document.
   * Coalesces rapid edits (e.g. from AI agents) into a single OT update.
   */
  _scheduleFlush(docId, delay = 150) {
    if (this._flushTimers.has(docId)) {
      clearTimeout(this._flushTimers.get(docId));
    }
    this._flushTimers.set(docId, setTimeout(() => {
      this._flushTimers.delete(docId);
      this._flushDoc(docId).catch((e) => console.error('[sync] Flush error:', e.message));
    }, delay));
  }

  /**
   * Create a new file (text doc or binary) on Overleaf when a local file is added.
   */
  async _handleLocalCreate(relativePath) {
    if (this._creatingFiles.has(relativePath)) return;
    this._creatingFiles.add(relativePath);

    try {
      const absPath = path.join(this.dir, relativePath);
      const fileName = path.basename(relativePath);
      const dirName = path.dirname(relativePath);

      // Determine parent folder ID (create intermediate folders if needed)
      let parentFolderId = this.rootFolderId;
      if (dirName && dirName !== '.') {
        parentFolderId = await this._ensureFolder(dirName);
      }

      if (!parentFolderId) {
        console.error(`[sync] Cannot determine parent folder for ${relativePath}`);
        return;
      }

      if (isTextFile(relativePath)) {
        await this._createTextDoc(absPath, relativePath, fileName, parentFolderId);
      } else {
        await this._uploadBinaryFile(absPath, relativePath, fileName, parentFolderId);
      }
    } finally {
      this._creatingFiles.delete(relativePath);
    }
  }

  /**
   * Create a text document on Overleaf via REST API and join for OT editing.
   */
  async _createTextDoc(absPath, relativePath, fileName, parentFolderId) {
    const content = fs.readFileSync(absPath, 'utf-8');

    // Mark as locally initiated BEFORE POST so _handleRemoteDocCreate can
    // distinguish our own echo from a legitimate remote create, even if
    // joinDoc fails and _creatingFiles is cleaned up.
    this._locallyInitiated.set(relativePath, content);
    const initTimer = setTimeout(() => this._locallyInitiated.delete(relativePath), 60000);

    const url = `${this.baseUrl}/project/${this.projectId}/doc`;
    const res = await httpPost(url, this.cookie, this.csrfToken, {
      name: fileName,
      parent_folder_id: parentFolderId,
    });

    if (res.status === 403 && await this._refreshAuthIfNeeded()) {
      return this._createTextDoc(absPath, relativePath, fileName, parentFolderId);
    }

    if (res.status !== 200 && res.status !== 201) {
      console.error(`[sync] Failed to create ${relativePath}: HTTP ${res.status}`);
      clearTimeout(initTimer);
      this._locallyInitiated.delete(relativePath);
      return;
    }

    let newDoc;
    try {
      newDoc = JSON.parse(res.body);
    } catch (e) {
      console.error(`[sync] Failed to parse create-doc response for ${relativePath}: ${e.message}`);
      clearTimeout(initTimer);
      this._locallyInitiated.delete(relativePath);
      return;
    }
    const docId = newDoc._id;

    // Join the doc for OT editing
    const { lines, version } = await this.socket.joinDoc(docId);
    const serverContent = lines.join('\n');

    this.docs.set(docId, {
      path: relativePath,
      version,
      content: serverContent,
      pending: null,
      dirty: false,
      needsResync: false,
    });
    this.pathToDocId.set(relativePath, docId);
    clearTimeout(initTimer);
    this._locallyInitiated.delete(relativePath);

    console.log(`[local\u2192remote] Created ${relativePath} (${docId})`);

    // Push local content if non-empty
    if (content && content !== serverContent) {
      await this._flushDoc(docId);
    }
  }

  /**
   * Upload a binary file to Overleaf via multipart upload.
   * Retries once after a delay on failure.
   */
  async _uploadBinaryFile(absPath, relativePath, fileName, parentFolderId, _retryCount = 0) {
    const fileBuffer = fs.readFileSync(absPath);

    if (fileBuffer.length === 0) {
      if (_retryCount < 2) {
        // File may still be writing — wait and retry
        const delay = 500 * (_retryCount + 1);
        console.warn(`[sync] ${relativePath} is 0 bytes, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        return this._uploadBinaryFile(absPath, relativePath, fileName, parentFolderId, _retryCount + 1);
      }
      console.error(`[sync] Skipping empty file ${relativePath}`);
      return;
    }

    await this._binarySemaphore.acquire();
    try {
      const url = `${this.baseUrl}/project/${this.projectId}/upload?folder_id=${parentFolderId}`;
      const res = await httpPostMultipart(url, this.cookie, this.csrfToken, fileName, fileBuffer);

      if (res.status === 403 && await this._refreshAuthIfNeeded()) {
        this._binarySemaphore.release();
        return this._uploadBinaryFile(absPath, relativePath, fileName, parentFolderId, _retryCount);
      }

      if (res.status !== 200 && res.status !== 201) {
        console.error(`[sync] Failed to upload ${relativePath} (${fileBuffer.length} bytes): HTTP ${res.status}`);
        if (res.body) console.error(`[sync]   Response: ${res.body.slice(0, 500)}`);

        // Retry once on transient failure
        if (_retryCount < 1) {
          console.log(`[sync] Retrying upload of ${relativePath} in 1s...`);
          await new Promise((r) => setTimeout(r, 1000));
          this._binarySemaphore.release();
          return this._uploadBinaryFile(absPath, relativePath, fileName, parentFolderId, _retryCount + 1);
        }
        return;
      }

      let result;
      try {
        result = JSON.parse(res.body);
      } catch (e) {
        console.error(`[sync] Failed to parse upload response for ${relativePath}: ${e.message}`);
        return;
      }
      const fileId = result.entity_id || result._id || (result.entity && result.entity._id);

      if (fileId) {
        this.filePaths.set(fileId, relativePath);
        this.pathToFileId.set(relativePath, fileId);
      }

      console.log(`[local\u2192remote] Uploaded ${relativePath} (binary, ${fileBuffer.length} bytes)`);
    } finally {
      this._binarySemaphore.release();
    }
  }

  /**
   * Re-upload a binary file when it changes locally.
   */
  async _handleBinaryUpdate(relativePath, oldFileId) {
    if (this._creatingFiles.has(relativePath)) return;
    this._creatingFiles.add(relativePath);
    // Mark oldFileId as being replaced so removeEntity skips local file deletion
    this._replacingFileIds.add(oldFileId);

    try {
      const absPath = path.join(this.dir, relativePath);
      const fileBuffer = fs.readFileSync(absPath);

      // Skip 0-byte files (file may still be writing)
      if (fileBuffer.length === 0) {
        console.warn(`[sync] Skipping 0-byte binary update for ${relativePath}`);
        return;
      }

      const fileName = path.basename(relativePath);
      const dirName = path.dirname(relativePath);

      let parentFolderId = this.rootFolderId;
      if (dirName && dirName !== '.') {
        parentFolderId = await this._ensureFolder(dirName);
      }

      await this._binarySemaphore.acquire();
      try {
        const url = `${this.baseUrl}/project/${this.projectId}/upload?folder_id=${parentFolderId}`;
        const res = await httpPostMultipart(url, this.cookie, this.csrfToken, fileName, fileBuffer);

        if (res.status === 403 && await this._refreshAuthIfNeeded()) {
          // Retry after auth refresh
          this._binarySemaphore.release();
          this._replacingFileIds.delete(oldFileId);
          this._creatingFiles.delete(relativePath);
          return this._handleBinaryUpdate(relativePath, oldFileId);
        }

        if (res.status !== 200 && res.status !== 201) {
          console.error(`[sync] Failed to update binary ${relativePath} (${fileBuffer.length} bytes): HTTP ${res.status}`);
          if (res.body) console.error(`[sync]   Response: ${res.body.slice(0, 500)}`);
          return;
        }

        let result;
        try {
          result = JSON.parse(res.body);
        } catch (e) {
          console.error(`[sync] Failed to parse update response for ${relativePath}: ${e.message}`);
          return;
        }
        const newFileId = result.entity_id || result._id || (result.entity && result.entity._id);

        if (newFileId && newFileId !== oldFileId) {
          this.filePaths.delete(oldFileId);
          this.filePaths.set(newFileId, relativePath);
          this.pathToFileId.set(relativePath, newFileId);
        }

        console.log(`[local\u2192remote] Updated ${relativePath} (binary)`);
      } finally {
        this._binarySemaphore.release();
      }
    } finally {
      this._replacingFileIds.delete(oldFileId);
      this._creatingFiles.delete(relativePath);
    }
  }

  /**
   * Ensure a folder path exists on the server, creating intermediate folders as needed.
   * Returns the folderId for the deepest folder.
   * Uses _creatingFolders to prevent concurrent duplicate creation.
   */
  async _ensureFolder(folderRelPath) {
    const existing = this.pathToFolderId.get(folderRelPath);
    if (existing) return existing;

    // If another call is already creating this folder, wait for it
    const inflight = this._creatingFolders.get(folderRelPath);
    if (inflight) return inflight;

    const promise = this._createFolder(folderRelPath);
    this._creatingFolders.set(folderRelPath, promise);
    try {
      return await promise;
    } finally {
      this._creatingFolders.delete(folderRelPath);
    }
  }

  /**
   * Internal: actually create folder hierarchy on the server.
   */
  async _createFolder(folderRelPath) {
    const parts = folderRelPath.split('/');
    let currentPath = '';
    let parentId = this.rootFolderId;

    for (const part of parts) {
      currentPath = currentPath ? currentPath + '/' + part : part;
      const existingId = this.pathToFolderId.get(currentPath);
      if (existingId) {
        parentId = existingId;
        continue;
      }

      // Create folder via REST API
      const url = `${this.baseUrl}/project/${this.projectId}/folder`;
      const res = await httpPost(url, this.cookie, this.csrfToken, {
        name: part,
        parent_folder_id: parentId,
      });

      if (res.status !== 200 && res.status !== 201) {
        console.error(`[sync] Failed to create folder ${currentPath}: HTTP ${res.status}`);
        return null;
      }

      let newFolder;
      try {
        newFolder = JSON.parse(res.body);
      } catch (e) {
        console.error(`[sync] Failed to parse folder response for ${currentPath}: ${e.message}`);
        return null;
      }
      parentId = newFolder._id;
      this.pathToFolderId.set(currentPath, parentId);
      this._folderIdToPath.set(parentId, currentPath);
      console.log(`[local\u2192remote] Created folder ${currentPath}`);
    }

    return parentId;
  }

  /**
   * Delete a document or binary file on Overleaf when a local file is removed.
   */
  async _handleLocalDelete(relativePath) {
    const docId = this.pathToDocId.get(relativePath);
    if (docId) {
      try {
        const url = `${this.baseUrl}/project/${this.projectId}/doc/${docId}`;
        const res = await httpDelete(url, this.cookie, this.csrfToken);
        if (res.status === 200 || res.status === 204) {
          console.log(`[local\u2192remote] Deleted ${relativePath}`);
        } else {
          console.error(`[sync] Failed to delete ${relativePath}: HTTP ${res.status}`);
        }
      } catch (err) {
        console.error(`[sync] Delete error for ${relativePath}: ${err.message}`);
      }
      this._cancelFlush(docId);
      this.docs.delete(docId);
      this.pathToDocId.delete(relativePath);
      return;
    }

    const fileId = this.pathToFileId.get(relativePath);
    if (fileId) {
      try {
        const url = `${this.baseUrl}/project/${this.projectId}/file/${fileId}`;
        const res = await httpDelete(url, this.cookie, this.csrfToken);
        if (res.status === 200 || res.status === 204) {
          console.log(`[local\u2192remote] Deleted ${relativePath} (binary)`);
        } else {
          console.error(`[sync] Failed to delete binary ${relativePath}: HTTP ${res.status}`);
        }
      } catch (err) {
        console.error(`[sync] Delete error for ${relativePath}: ${err.message}`);
      }
      this.filePaths.delete(fileId);
      this.pathToFileId.delete(relativePath);
      return;
    }

    console.log(`[local] File deleted: ${relativePath} (untracked)`);
  }

  /**
   * Handle a new doc created remotely — join and download.
   */
  async _handleRemoteDocCreate(parentFolderId, doc) {
    const prefix = this._folderPathById(parentFolderId);
    const relativePath = prefix ? prefix + '/' + doc.name : doc.name;

    if (this.pathToDocId.has(relativePath)) return; // already tracked
    if (this._creatingFiles.has(relativePath)) return; // being created locally

    try {
      const { lines, version } = await this.socket.joinDoc(doc._id);
      const content = lines.join('\n');

      this.docs.set(doc._id, {
        path: relativePath,
        version,
        content,
        pending: null,
        dirty: false,
        needsResync: false,
      });
      this.pathToDocId.set(relativePath, doc._id);

      const absPath = path.join(this.dir, relativePath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });

      // If this doc was locally initiated (our POST succeeded but joinDoc
      // failed inside _createTextDoc), recover by pushing saved local content
      // instead of overwriting the local file with the empty server doc.
      const savedContent = this._locallyInitiated.get(relativePath);
      if (savedContent !== undefined) {
        this._locallyInitiated.delete(relativePath);
        console.log(`[remote\u2192local] New doc ${relativePath} (v${version}) — recovering local create, pushing to remote`);
        await this._flushDoc(doc._id);
      } else {
        const release = this.watcher.suppress(absPath, content);
        this._atomicWrite(absPath, content);
        release();
        console.log(`[remote\u2192local] New doc ${relativePath} (v${version})`);
      }
    } catch (err) {
      console.error(`[sync] Failed to sync new doc ${doc.name}: ${err.message}`);
    }
  }

  /**
   * Handle a new binary file created remotely — download.
   */
  async _handleRemoteFileCreate(parentFolderId, file) {
    const prefix = this._folderPathById(parentFolderId);
    const relativePath = prefix ? prefix + '/' + file.name : file.name;

    if (this.pathToFileId.has(relativePath)) return; // already tracked
    if (this._creatingFiles.has(relativePath)) return; // being created locally

    const absPath = path.join(this.dir, relativePath);
    if (fs.existsSync(absPath)) return;

    try {
      const url = `${this.baseUrl}/project/${this.projectId}/file/${file._id}`;
      const res = await httpGetBinary(url, this.cookie);
      if (res.status === 200) {
        // Set maps before file write so concurrent events see the tracked file
        this.filePaths.set(file._id, relativePath);
        this.pathToFileId.set(relativePath, file._id);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        const release = this.watcher.suppress(absPath);
        fs.writeFileSync(absPath, res.body);
        release();
        console.log(`[remote\u2192local] Downloaded ${relativePath} (binary)`);
      }
    } catch (err) {
      console.error(`[sync] Failed to download ${file.name}: ${err.message}`);
    }
  }

  /**
   * Resolve folder ID to relative path (O(1) via reverse map).
   */
  _folderPathById(folderId) {
    if (folderId === this.rootFolderId) return '';
    return this._folderIdToPath.get(folderId) || '';
  }

  /**
   * Refresh auth credentials on 403. Returns true if auth was refreshed (caller should retry).
   */
  async _refreshAuthIfNeeded() {
    if (!this.onAuthExpired) return false;
    try {
      const newAuth = await this.onAuthExpired();
      if (newAuth) {
        this.cookie = newAuth.cookie;
        this.csrfToken = newAuth.csrfToken;
        console.log('[sync] Auth credentials refreshed');
        return true;
      }
    } catch (e) {
      console.error('[sync] Auth refresh failed:', e.message);
    }
    return false;
  }

  /**
   * Compute diff and send OT ops for a document.
   * Reads file content and verifies stability before sending.
   */
  async _flushDoc(docId) {
    const docState = this.docs.get(docId);
    if (!docState || docState.pending) return;

    const absPath = path.join(this.dir, docState.path);

    let newContent;
    try {
      newContent = fs.readFileSync(absPath, 'utf-8');
    } catch (err) {
      console.error(`[sync] Cannot read ${docState.path}: ${err.message}`);
      return;
    }

    // Snapshot fence: capture state before async gap to detect concurrent remote updates
    const snapshotVersion = docState.version;
    const snapshotContent = docState.content;

    // Content stability check: re-read after a brief pause to catch mid-write states
    await new Promise((r) => setTimeout(r, 50));
    try {
      const reread = fs.readFileSync(absPath, 'utf-8');
      if (reread !== newContent) {
        // File changed during stability check — reschedule
        this._scheduleFlush(docId);
        return;
      }
    } catch (err) {
      // File may have been deleted
      return;
    }

    // Snapshot fence: abort if remote update changed docState during the await
    if (docState.version !== snapshotVersion || docState.content !== snapshotContent) {
      this._scheduleFlush(docId);
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

    const epoch = ++this._sendEpoch;
    docState.pending = {
      baseVersion: docState.version,
      targetContent: newContent,
      sentAt: Date.now(),
      sendEpoch: epoch,
    };

    console.log(`[local\u2192remote] ${docState.path} (${ops.length} ops, v${docState.version})`);

    try {
      await this.socket.applyOtUpdate(docId, ops, docState.version, newContent);
      // Content will be committed when ack arrives in _onRemoteUpdate
    } catch (err) {
      const isTimeout = err.message && err.message.includes('timeout');
      if (isTimeout && docState.pending && docState.pending.sendEpoch === epoch) {
        // Timeout: enter uncertain state — server may have applied the ops.
        // Keep pending record alive; start grace timer for late ack or forced resync.
        console.log(`[sync] Timeout on ${docState.path} — entering uncertain state, waiting for late ack...`);
        setTimeout(() => {
          // If still waiting for this same send after grace period, force resync
          if (docState.pending && docState.pending.sendEpoch === epoch) {
            console.log(`[sync] Grace period expired for ${docState.path} — forcing re-sync`);
            docState.pending = null;
            this._resyncDoc(docId).catch((e) => console.error('[sync] Re-sync error:', e.message));
          }
        }, 5000);
      } else {
        // Non-timeout error: clear immediately and resync
        console.error(`[sync] Failed to sync ${docState.path}: ${err.message}`);
        docState.pending = null;
        this._resyncDoc(docId).catch((e) => console.error('[sync] Re-sync error:', e.message));
      }
    }
  }

  /**
   * Cancel a pending flush timer for a document.
   */
  _cancelFlush(docId) {
    if (this._flushTimers.has(docId)) {
      clearTimeout(this._flushTimers.get(docId));
      this._flushTimers.delete(docId);
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
      docState.pending = null;
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
   * Cleanup: leave all docs and cancel pending timers.
   */
  cleanup() {
    for (const docId of this.docs.keys()) {
      try {
        this.socket.leaveDoc(docId);
      } catch (e) { /* ignore */ }
    }
    for (const timer of this._flushTimers.values()) {
      clearTimeout(timer);
    }
    this._flushTimers.clear();
  }
}

module.exports = SyncEngine;
