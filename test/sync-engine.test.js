'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const path = require('path');

// Minimal mock for SyncEngine unit tests (no real I/O)

class MockSocketManager extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this._joinedDocs = new Map();
  }

  async joinDoc(docId) {
    const data = this._joinedDocs.get(docId) || { lines: [''], version: 1 };
    return data;
  }

  leaveDoc() {}

  async applyOtUpdate() {}

  disconnect() {
    this.connected = false;
  }
}

class MockWatcher extends EventEmitter {
  constructor() {
    super();
    this._suppressedPaths = new Set();
    this._expectedHashes = new Map();
  }

  suppress(filePath) {
    this._suppressedPaths.add(filePath);
    return () => this._suppressedPaths.delete(filePath);
  }

  removeListener(event, fn) {
    super.removeListener(event, fn);
  }
}

// We need to mock fs operations for sync-engine since it does file I/O
// Instead, test the logic parts that don't touch the filesystem directly.

describe('SyncEngine', () => {
  describe('Semaphore', () => {
    // Extract Semaphore from sync-engine module
    // Since it's not exported, we test it indirectly via the engine
    // But we can replicate the class for direct testing
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

    it('allows up to max concurrent acquisitions', async () => {
      const sem = new Semaphore(2);

      await sem.acquire();
      await sem.acquire();
      assert.equal(sem._count, 2);

      // Third acquire should block
      let thirdResolved = false;
      const third = sem.acquire().then(() => { thirdResolved = true; });

      // Give microtasks a chance to run
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(thirdResolved, false);

      sem.release();
      await third;
      assert.equal(thirdResolved, true);
      assert.equal(sem._count, 2);

      sem.release();
      sem.release();
      assert.equal(sem._count, 0);
    });

    it('processes queue in FIFO order', async () => {
      const sem = new Semaphore(1);
      const order = [];

      await sem.acquire();

      const p1 = sem.acquire().then(() => order.push(1));
      const p2 = sem.acquire().then(() => order.push(2));

      sem.release();
      await p1;
      sem.release();
      await p2;

      assert.deepStrictEqual(order, [1, 2]);
      sem.release();
    });
  });

  describe('_folderPathById', () => {
    let SyncEngine;
    let engine;

    beforeEach(() => {
      SyncEngine = require('../src/sync-engine');
      const socket = new MockSocketManager();
      const watcher = new MockWatcher();
      engine = new SyncEngine(socket, watcher, '/tmp/test', 'https://example.com', 'cookie', 'proj1', 'csrf');
    });

    it('returns empty string for rootFolderId', () => {
      engine.rootFolderId = 'root123';
      assert.equal(engine._folderPathById('root123'), '');
    });

    it('returns path from _folderIdToPath map (O(1) lookup)', () => {
      engine._folderIdToPath.set('folder1', 'images');
      engine._folderIdToPath.set('folder2', 'images/sub');

      assert.equal(engine._folderPathById('folder1'), 'images');
      assert.equal(engine._folderPathById('folder2'), 'images/sub');
    });

    it('returns empty string for unknown folderId', () => {
      assert.equal(engine._folderPathById('unknown'), '');
    });
  });

  describe('_ensureFolder concurrency', () => {
    let SyncEngine;
    let engine;
    let createCount;

    beforeEach(() => {
      SyncEngine = require('../src/sync-engine');
      const socket = new MockSocketManager();
      const watcher = new MockWatcher();
      engine = new SyncEngine(socket, watcher, '/tmp/test', 'https://example.com', 'cookie', 'proj1', 'csrf');
      engine.rootFolderId = 'root123';

      // Mock _createFolder to track calls
      createCount = 0;
      engine._createFolder = async (folderRelPath) => {
        createCount++;
        await new Promise((r) => setTimeout(r, 50));
        const id = 'folder_' + folderRelPath;
        engine.pathToFolderId.set(folderRelPath, id);
        return id;
      };
    });

    it('deduplicates concurrent calls to the same folder', async () => {
      const [r1, r2, r3] = await Promise.all([
        engine._ensureFolder('images'),
        engine._ensureFolder('images'),
        engine._ensureFolder('images'),
      ]);

      assert.equal(r1, 'folder_images');
      assert.equal(r2, 'folder_images');
      assert.equal(r3, 'folder_images');
      assert.equal(createCount, 1, 'Should only create folder once');
    });

    it('allows different folders to be created in parallel', async () => {
      const [r1, r2] = await Promise.all([
        engine._ensureFolder('images'),
        engine._ensureFolder('chapters'),
      ]);

      assert.equal(r1, 'folder_images');
      assert.equal(r2, 'folder_chapters');
      assert.equal(createCount, 2);
    });

    it('returns cached result for already-existing folder', async () => {
      engine.pathToFolderId.set('existing', 'cached_id');
      const result = await engine._ensureFolder('existing');
      assert.equal(result, 'cached_id');
      assert.equal(createCount, 0, 'Should not create folder if cached');
    });
  });

  describe('_onRemoteUpdate', () => {
    let SyncEngine;
    let engine;

    beforeEach(() => {
      SyncEngine = require('../src/sync-engine');
      const socket = new MockSocketManager();
      const watcher = new MockWatcher();
      engine = new SyncEngine(socket, watcher, '/tmp/test', 'https://example.com', 'cookie', 'proj1', 'csrf');

      // Stub _atomicWrite to avoid filesystem
      engine._atomicWrite = () => {};
    });

    it('ignores updates without doc field', () => {
      // Should not throw
      engine._onRemoteUpdate(null);
      engine._onRemoteUpdate({});
      engine._onRemoteUpdate({ op: [] });
    });

    it('ignores stray ack when no pending send', () => {
      engine.docs.set('doc1', {
        path: 'main.tex',
        version: 5,
        content: 'hello',
        pending: null,
        dirty: false,
        needsResync: false,
      });

      // Ack with no pending — should be ignored silently
      engine._onRemoteUpdate({ doc: 'doc1', op: [], v: 5 });
      assert.equal(engine.docs.get('doc1').version, 5);
    });

    it('processes ack and advances version when pending', () => {
      engine.docs.set('doc1', {
        path: 'main.tex',
        version: 5,
        content: 'hello',
        pending: { baseVersion: 5, targetContent: 'hello world', sentAt: Date.now(), sendEpoch: 1 },
        dirty: false,
        needsResync: false,
      });

      engine._onRemoteUpdate({ doc: 'doc1', op: [], v: 5 });

      const doc = engine.docs.get('doc1');
      assert.equal(doc.version, 6);
      assert.equal(doc.pending, null);
      assert.equal(doc.content, 'hello world');
    });

    it('uses else-if for op.d and op.i (exclusive branching)', () => {
      engine.docs.set('doc1', {
        path: 'main.tex',
        version: 5,
        content: 'abcdef',
        pending: null,
        dirty: false,
        needsResync: false,
      });

      // Apply an insert op
      engine._onRemoteUpdate({
        doc: 'doc1',
        op: [{ i: 'XY', p: 3 }],
        v: 5,
      });

      assert.equal(engine.docs.get('doc1').content, 'abcXYdef');
      assert.equal(engine.docs.get('doc1').version, 6);
    });
  });

  describe('_refreshAuthIfNeeded', () => {
    let SyncEngine;

    it('returns false when no onAuthExpired callback', async () => {
      SyncEngine = require('../src/sync-engine');
      const socket = new MockSocketManager();
      const watcher = new MockWatcher();
      const engine = new SyncEngine(socket, watcher, '/tmp/test', 'https://example.com', 'cookie', 'proj1', 'csrf');

      const result = await engine._refreshAuthIfNeeded();
      assert.equal(result, false);
    });

    it('refreshes credentials when onAuthExpired succeeds', async () => {
      SyncEngine = require('../src/sync-engine');
      const socket = new MockSocketManager();
      const watcher = new MockWatcher();
      const engine = new SyncEngine(socket, watcher, '/tmp/test', 'https://example.com', 'old_cookie', 'proj1', 'old_csrf', {
        onAuthExpired: async () => ({ cookie: 'new_cookie', csrfToken: 'new_csrf' }),
      });

      const result = await engine._refreshAuthIfNeeded();
      assert.equal(result, true);
      assert.equal(engine.cookie, 'new_cookie');
      assert.equal(engine.csrfToken, 'new_csrf');
    });

    it('returns false when onAuthExpired throws', async () => {
      SyncEngine = require('../src/sync-engine');
      const socket = new MockSocketManager();
      const watcher = new MockWatcher();
      const engine = new SyncEngine(socket, watcher, '/tmp/test', 'https://example.com', 'cookie', 'proj1', 'csrf', {
        onAuthExpired: async () => { throw new Error('network error'); },
      });

      const result = await engine._refreshAuthIfNeeded();
      assert.equal(result, false);
    });
  });

  describe('constructor opts', () => {
    it('accepts opts parameter with onAuthExpired', () => {
      const SyncEngine = require('../src/sync-engine');
      const socket = new MockSocketManager();
      const watcher = new MockWatcher();
      const cb = async () => ({});
      const engine = new SyncEngine(socket, watcher, '/tmp/test', 'https://example.com', 'cookie', 'proj1', 'csrf', {
        onAuthExpired: cb,
      });

      assert.equal(engine.onAuthExpired, cb);
    });

    it('defaults onAuthExpired to null', () => {
      const SyncEngine = require('../src/sync-engine');
      const socket = new MockSocketManager();
      const watcher = new MockWatcher();
      const engine = new SyncEngine(socket, watcher, '/tmp/test', 'https://example.com', 'cookie', 'proj1', 'csrf');

      assert.equal(engine.onAuthExpired, null);
    });
  });
});
