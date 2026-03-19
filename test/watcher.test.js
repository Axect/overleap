'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const FileWatcher = require('../src/watcher');

describe('FileWatcher suppression', () => {
  let tmpDir;
  let watcher;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleap-test-'));
    watcher = new FileWatcher(tmpDir, { debounceMs: 10 });
    await watcher.start();
  });

  afterEach(async () => {
    await watcher.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('suppresses content-hash matched write events', async () => {
    const filePath = path.join(tmpDir, 'test.tex');
    const content = 'hello world';

    const events = [];
    watcher.on('file-change', (e) => events.push(e));

    // Suppress then write — do NOT call release() before chokidar fires
    // The TTL (5s) keeps suppression alive while chokidar processes the event
    watcher.suppress(filePath, content);
    fs.writeFileSync(filePath, content, 'utf-8');

    // Wait for chokidar's awaitWriteFinish (stabilityThreshold: 500ms + margin)
    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(events.length, 0, 'Should suppress our own write');
  });

  it('emits event for non-matching content', async () => {
    const filePath = path.join(tmpDir, 'test2.tex');

    const events = [];
    watcher.on('file-change', (e) => events.push(e));

    // Suppress for content "aaa" but write "bbb"
    watcher.suppress(filePath, 'aaa');
    fs.writeFileSync(filePath, 'bbb', 'utf-8');

    await new Promise((r) => setTimeout(r, 1500));

    assert.ok(events.length > 0, 'Should emit event for mismatched content');
  });

  it('path-based suppression suppresses all event types including unlink', async () => {
    const filePath = path.join(tmpDir, 'binary.png');
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // Wait for initial add event to pass
    await new Promise((r) => setTimeout(r, 1500));

    const events = [];
    watcher.on('file-change', (e) => events.push(e));

    // Path-based suppress (no content) then unlink — don't release before chokidar fires
    watcher.suppress(filePath);
    fs.unlinkSync(filePath);

    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(events.length, 0, 'Should suppress unlink via path-based suppression');
  });

  it('path-based suppression suppresses change events', async () => {
    const filePath = path.join(tmpDir, 'data.bin');
    fs.writeFileSync(filePath, Buffer.from([1, 2, 3]));

    // Wait for initial add event to pass
    await new Promise((r) => setTimeout(r, 1500));

    const events = [];
    watcher.on('file-change', (e) => events.push(e));

    // Path-based suppress then write new content
    watcher.suppress(filePath);
    fs.writeFileSync(filePath, Buffer.from([4, 5, 6]));

    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(events.length, 0, 'Should suppress change via path-based suppression');
  });

  it('clears _suppressedPaths on stop', async () => {
    const filePath = path.join(tmpDir, 'file.bin');
    watcher.suppress(filePath);

    assert.ok(watcher._suppressedPaths.has(filePath));
    await watcher.stop();
    assert.equal(watcher._suppressedPaths.size, 0);
  });

  it('_suppressedPaths is separate from _expectedHashes', () => {
    const filePath = path.join(tmpDir, 'test.bin');

    // Path-based suppress (no content) should only add to _suppressedPaths
    watcher.suppress(filePath);
    assert.ok(watcher._suppressedPaths.has(filePath));
    assert.ok(!watcher._expectedHashes.has(filePath));

    watcher._clearSuppression(filePath);

    // Content-based suppress should only add to _expectedHashes
    watcher.suppress(filePath, 'some content');
    assert.ok(!watcher._suppressedPaths.has(filePath));
    assert.ok(watcher._expectedHashes.has(filePath));
  });
});
