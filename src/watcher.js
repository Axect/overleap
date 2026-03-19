'use strict';

const fs = require('fs');
const crypto = require('crypto');
const chokidar = require('chokidar');
const path = require('path');
const EventEmitter = require('events');
const { IGNORE_PATTERNS } = require('./constants');

class FileWatcher extends EventEmitter {
  constructor(dir, opts = {}) {
    super();
    this.dir = path.resolve(dir);
    this.debounceMs = opts.debounceMs || 100;
    this.watcher = null;

    // H4: content-hash based write suppression (deterministic, no timing issues)
    // Map<absPath, contentHash> — expected hash after our write
    this._expectedHashes = new Map();

    // L1: TTL safety net — auto-clear stale suppressions after 5s
    this._suppressionTimers = new Map();

    // Path-based suppression for binary files (no content hash available)
    this._suppressedPaths = new Set();

    // Debounce timers per file
    this._debounceTimers = new Map();
  }

  start() {
    this.watcher = chokidar.watch(this.dir, {
      ignored: IGNORE_PATTERNS,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 50,
      },
    });

    this.watcher.on('change', (filePath) => this._handleEvent('change', filePath));
    this.watcher.on('add', (filePath) => this._handleEvent('add', filePath));
    this.watcher.on('unlink', (filePath) => this._handleEvent('unlink', filePath));

    this.watcher.on('error', (err) => {
      this.emit('error', err);
    });

    return new Promise((resolve) => {
      this.watcher.on('ready', () => resolve());
    });
  }

  _handleEvent(eventType, filePath) {
    // Path-based suppression — suppress ALL event types including unlink
    if (this._suppressedPaths.has(filePath)) {
      this._clearSuppression(filePath);
      return;
    }

    // H4: content-hash based suppression
    if (this._expectedHashes.has(filePath)) {
      if (eventType === 'unlink') {
        // File deleted — clear suppression
        this._clearSuppression(filePath);
        // Still emit the event for unlinks
      } else {
        // Read the file and check hash
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const hash = this._hashContent(content);
          if (hash === this._expectedHashes.get(filePath)) {
            // This is our own write — suppress it
            this._clearSuppression(filePath);
            return;
          }
        } catch (e) {
          // File might be gone, clear suppression
          this._clearSuppression(filePath);
        }
      }
    }

    const relPath = path.relative(this.dir, filePath);

    // Debounce: reset timer for this file
    if (this._debounceTimers.has(filePath)) {
      clearTimeout(this._debounceTimers.get(filePath));
    }

    this._debounceTimers.set(filePath, setTimeout(() => {
      this._debounceTimers.delete(filePath);
      this.emit('file-change', { type: eventType, path: filePath, relativePath: relPath });
    }, this.debounceMs));
  }

  _hashContent(content) {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  /**
   * Suppress the next change event for a file by expected content hash.
   * Returns a release function (for safety, also auto-clears after 5s).
   */
  suppress(filePath, content) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.dir, filePath);

    if (content !== undefined) {
      this._expectedHashes.set(absPath, this._hashContent(content));
    } else {
      this._suppressedPaths.add(absPath);
    }

    // L1: TTL safety — clear after 5s even if chokidar never fires
    if (this._suppressionTimers.has(absPath)) {
      clearTimeout(this._suppressionTimers.get(absPath));
    }
    this._suppressionTimers.set(absPath, setTimeout(() => {
      this._clearSuppression(absPath);
    }, 5000));

    return () => this._clearSuppression(absPath);
  }

  _clearSuppression(absPath) {
    this._expectedHashes.delete(absPath);
    this._suppressedPaths.delete(absPath);
    if (this._suppressionTimers.has(absPath)) {
      clearTimeout(this._suppressionTimers.get(absPath));
      this._suppressionTimers.delete(absPath);
    }
  }

  async stop() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
    for (const timer of this._suppressionTimers.values()) {
      clearTimeout(timer);
    }
    this._suppressionTimers.clear();
    this._expectedHashes.clear();
    this._suppressedPaths.clear();
  }
}

module.exports = FileWatcher;
