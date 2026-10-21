'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { readBinding, assertBinding, writeBinding, acquireDirLock, BINDING_FILE, LOCK_FILE } = require('../src/binding');
const { IGNORE_PATTERNS } = require('../src/constants');

const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

describe('directory binding', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleap-binding-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('allows any project in an unbound directory', () => {
    assert.equal(assertBinding(dir, ID_A), null);
  });

  it('accepts the bound project and rejects a different one', () => {
    writeBinding(dir, ID_A, 'Referee report');
    assert.deepEqual(assertBinding(dir, ID_A), { id: ID_A, name: 'Referee report' });
    assert.throws(() => assertBinding(dir, ID_B), /bound to project "Referee report"/);
  });

  it('rejects a malformed binding file instead of ignoring it', () => {
    fs.writeFileSync(path.join(dir, BINDING_FILE), '{"name": "no id"}');
    assert.throws(() => readBinding(dir), /malformed/);
  });

  it('is never uploaded (dotfile is ignored)', () => {
    assert.ok(IGNORE_PATTERNS.some((p) => p.test(BINDING_FILE)));
  });
});

describe('directory sync lock', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleap-lock-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a second daemon while another live process holds the directory', async () => {
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    try {
      fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: other.pid }));
      assert.throws(() => acquireDirLock(dir), new RegExp(`pid ${other.pid}\\) is already running`));
    } finally {
      other.kill();
    }
  });

  it('takes over a lock left by a process that has exited, and releases it', () => {
    const { pid } = spawnSync(process.execPath, ['-e', '']);
    fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid }));
    const release = acquireDirLock(dir);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf-8')).pid, process.pid);
    release();
    assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false);
  });

  it('is never uploaded (dotfile is ignored)', () => {
    assert.ok(IGNORE_PATTERNS.some((p) => p.test(LOCK_FILE)));
  });
});

describe('IGNORE_PATTERNS for logs and LaTeX artifacts', () => {
  const ignored = (rel) => IGNORE_PATTERNS.some((p) => p.test(rel));

  it('skips logs and build artifacts at any depth', () => {
    for (const rel of ['sync.log', 'main.aux', 'main.synctex.gz', 'main.fdb_latexmk',
      'main.out', 'main.xdv', 'sections/ch1.aux']) {
      assert.ok(ignored(rel), `${rel} should be ignored`);
    }
  });

  it('keeps project sources, including .bbl for arXiv-style uploads', () => {
    for (const rel of ['main.tex', 'refs.bib', 'main.bbl', 'figs/plot.pdf', 'style.sty',
      'catalog.txt', 'outline.tex']) {
      assert.ok(!ignored(rel), `${rel} should be synced`);
    }
  });
});
