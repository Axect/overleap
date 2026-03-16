'use strict';

const fs = require('fs');
const path = require('path');
const { computeOps } = require('./diff');
const { flattenTree } = require('./tree');
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

class SyncEngine {
  constructor(socketManager, watcher, dir, baseUrl, cookie, projectId, csrfToken) {
    this.socket = socketManager;
    this.watcher = watcher;
    this.dir = path.resolve(dir);
    this.baseUrl = baseUrl;
    this.cookie = cookie;
    this.projectId = projectId;
    this.csrfToken = csrfToken;

    // State per document: docId → { path, version, content, sending, dirty, pendingContent, needsResync }
    // content: last server-confirmed content
    // pendingContent: content we sent but haven't received ack for
    this.docs = new Map();
    // Reverse map: relativePath → docId
    this.pathToDocId = new Map();
    // Binary files: fileRefId → relativePath
    this.filePaths = new Map();
    // Reverse map: relativePath → fileRefId
    this.pathToFileId = new Map();
    // Folder tracking: relativePath → folderId
    this.pathToFolderId = new Map();
    this.rootFolderId = null;
    // Prevent duplicate creation/upload attempts
    this._creatingFiles = new Set();
    // Per-doc flush debounce timers (rapid edit protection)
    this._flushTimers = new Map();

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
        console.log(`[sync] Binary file removed on server: ${filePath}`);
        const absPath = path.join(this.dir, filePath);
        const release = this.watcher.suppress(absPath);
        fs.promises.unlink(absPath).catch(() => {}).finally(release);
        this.filePaths.delete(entityId);
        this.pathToFileId.delete(filePath);
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
    const { docPaths, pathDocs, filePaths, pathFiles, pathFolders, rootFolderId } = flattenTree(project.rootFolder);

    this.filePaths = filePaths;
    this.pathToFileId = pathFiles;
    this.pathToFolderId = pathFolders;
    this.rootFolderId = rootFolderId;

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
        console.error(`  ✗ ${relativePath}: ${err.message}`);
      }
    }
  }

  /**
   * Recursively scan a directory, returning relative paths (respecting watcher ignore patterns).
   */
  _scanDir(base, prefix) {
    const results = [];
    const ignorePatterns = [
      /(^|[/\\])\../,
      /node_modules/,
      /\.git/,
      /\.env(\.|$)/,
      /~$/,
      /\.swp$/,
      /\.swo$/,
      /\.tmp\.\d+$/,
    ];

    let entries;
    try {
      entries = fs.readdirSync(path.join(base, prefix), { withFileTypes: true });
    } catch (e) {
      return results;
    }

    for (const entry of entries) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (ignorePatterns.some((p) => p.test(rel))) continue;

      if (entry.isDirectory()) {
        results.push(...this._scanDir(base, rel));
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }

    return results;
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
        this._scheduleFlush(update.doc);
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
   * Handle local file change → queue OT update, create, or delete on server.
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

      if (docState.sending) {
        docState.dirty = true;
        return;
      }

      this._scheduleFlush(docId);
      return;
    }

    // Existing binary file — re-upload
    const fileId = this.pathToFileId.get(relativePath);
    if (fileId && type === 'change') {
      this._handleBinaryUpdate(relativePath, fileId).catch((e) =>
        console.error('[sync] Binary update error:', e.message)
      );
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

    const url = `${this.baseUrl}/project/${this.projectId}/doc`;
    const res = await httpPost(url, this.cookie, this.csrfToken, {
      name: fileName,
      parent_folder_id: parentFolderId,
    });

    if (res.status !== 200 && res.status !== 201) {
      console.error(`[sync] Failed to create ${relativePath}: HTTP ${res.status}`);
      return;
    }

    const newDoc = JSON.parse(res.body);
    const docId = newDoc._id;

    // Join the doc for OT editing
    const { lines, version } = await this.socket.joinDoc(docId);
    const serverContent = lines.join('\n');

    this.docs.set(docId, {
      path: relativePath,
      version,
      content: serverContent,
      sending: false,
      dirty: false,
      pendingContent: null,
      needsResync: false,
    });
    this.pathToDocId.set(relativePath, docId);

    console.log(`[local→remote] Created ${relativePath} (${docId})`);

    // Push local content if non-empty
    if (content && content !== serverContent) {
      await this._flushDoc(docId);
    }
  }

  /**
   * Upload a binary file to Overleaf via multipart upload.
   */
  async _uploadBinaryFile(absPath, relativePath, fileName, parentFolderId) {
    const fileBuffer = fs.readFileSync(absPath);
    const url = `${this.baseUrl}/project/${this.projectId}/upload?folder_id=${parentFolderId}`;
    const res = await httpPostMultipart(url, this.cookie, this.csrfToken, fileName, fileBuffer);

    if (res.status !== 200 && res.status !== 201) {
      console.error(`[sync] Failed to upload ${relativePath}: HTTP ${res.status}`);
      return;
    }

    const result = JSON.parse(res.body);
    const fileId = result.entity_id || result._id || (result.entity && result.entity._id);

    if (fileId) {
      this.filePaths.set(fileId, relativePath);
      this.pathToFileId.set(relativePath, fileId);
    }

    console.log(`[local→remote] Uploaded ${relativePath} (binary)`);
  }

  /**
   * Re-upload a binary file when it changes locally.
   */
  async _handleBinaryUpdate(relativePath, oldFileId) {
    if (this._creatingFiles.has(relativePath)) return;
    this._creatingFiles.add(relativePath);

    try {
      const absPath = path.join(this.dir, relativePath);
      const fileBuffer = fs.readFileSync(absPath);
      const fileName = path.basename(relativePath);
      const dirName = path.dirname(relativePath);

      let parentFolderId = this.rootFolderId;
      if (dirName && dirName !== '.') {
        parentFolderId = await this._ensureFolder(dirName);
      }

      const url = `${this.baseUrl}/project/${this.projectId}/upload?folder_id=${parentFolderId}`;
      const res = await httpPostMultipart(url, this.cookie, this.csrfToken, fileName, fileBuffer);

      if (res.status !== 200 && res.status !== 201) {
        console.error(`[sync] Failed to update binary ${relativePath}: HTTP ${res.status}`);
        return;
      }

      const result = JSON.parse(res.body);
      const newFileId = result.entity_id || result._id || (result.entity && result.entity._id);

      if (newFileId && newFileId !== oldFileId) {
        this.filePaths.delete(oldFileId);
        this.filePaths.set(newFileId, relativePath);
        this.pathToFileId.set(relativePath, newFileId);
      }

      console.log(`[local→remote] Updated ${relativePath} (binary)`);
    } finally {
      this._creatingFiles.delete(relativePath);
    }
  }

  /**
   * Ensure a folder path exists on the server, creating intermediate folders as needed.
   * Returns the folderId for the deepest folder.
   */
  async _ensureFolder(folderRelPath) {
    const existing = this.pathToFolderId.get(folderRelPath);
    if (existing) return existing;

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

      const newFolder = JSON.parse(res.body);
      parentId = newFolder._id;
      this.pathToFolderId.set(currentPath, parentId);
      console.log(`[local→remote] Created folder ${currentPath}`);
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
          console.log(`[local→remote] Deleted ${relativePath}`);
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
          console.log(`[local→remote] Deleted ${relativePath} (binary)`);
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

    try {
      const { lines, version } = await this.socket.joinDoc(doc._id);
      const content = lines.join('\n');

      this.docs.set(doc._id, {
        path: relativePath,
        version,
        content,
        sending: false,
        dirty: false,
        pendingContent: null,
        needsResync: false,
      });
      this.pathToDocId.set(relativePath, doc._id);

      const absPath = path.join(this.dir, relativePath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      const release = this.watcher.suppress(absPath, content);
      this._atomicWrite(absPath, content);
      release();

      console.log(`[remote→local] New doc ${relativePath} (v${version})`);
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

    const absPath = path.join(this.dir, relativePath);
    if (fs.existsSync(absPath)) return;

    try {
      const url = `${this.baseUrl}/project/${this.projectId}/file/${file._id}`;
      const res = await httpGetBinary(url, this.cookie);
      if (res.status === 200) {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        const release = this.watcher.suppress(absPath);
        fs.writeFileSync(absPath, res.body);
        release();
        this.filePaths.set(file._id, relativePath);
        this.pathToFileId.set(relativePath, file._id);
        console.log(`[remote→local] Downloaded ${relativePath} (binary)`);
      }
    } catch (err) {
      console.error(`[sync] Failed to download ${file.name}: ${err.message}`);
    }
  }

  /**
   * Resolve folder ID to relative path.
   */
  _folderPathById(folderId) {
    if (folderId === this.rootFolderId) return '';
    for (const [folderPath, id] of this.pathToFolderId.entries()) {
      if (id === folderId) return folderPath;
    }
    return '';
  }

  /**
   * Compute diff and send OT ops for a document.
   * Reads file content and verifies stability before sending.
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
