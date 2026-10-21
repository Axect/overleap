'use strict';

// Regression tests for the 2026-10-21 incident (see outputs/incident_20261021): OT
// re-sync re-sending a stale diff, and binary replacement deleting files. Each test
// drives the real SyncEngine, SocketManager (socket.io layer faked) and FileWatcher
// (real chokidar on a temp dir) against FakeOverleaf.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FakeOverleaf, delay } = require('./helpers/fake-overleaf');
const FileWatcher = require('../src/watcher');
const SyncEngine = require('../src/sync-engine');

function captureLogs() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  return { lines, text: () => lines.join('\n'), restore: () => Object.assign(console, orig) };
}

async function startDaemon(server, dir) {
  const socket = server.connect();
  const watcher = new FileWatcher(dir);
  await watcher.start();
  const engine = new SyncEngine(socket, watcher, dir, server.baseUrl, 'cookie', server.projectId, 'csrf');
  await engine.initialSync(server.project());
  await delay(900); // let chokidar report (and the engine absorb) the initial-sync writes
  return {
    socket,
    engine,
    async stop() {
      engine.cleanup();
      engine.detach();
      await watcher.stop();
    },
  };
}

async function withProject(fn, serverOpts) {
  const server = new FakeOverleaf(serverOpts);
  await server.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleap-regress-'));
  const logs = captureLogs();
  try {
    await fn({ server, dir, logs });
  } finally {
    logs.restore();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('OT: own updates and conflict re-sync', () => {
  it('a concurrent remote edit is merged; re-sync never re-sends a stale diff', async () => {
    await withProject(async ({ server, dir, logs }) => {
      const C0 = '\\section{Intro}\nWe consider the problem.\n\n% end';
      const T = '\\section{Interaction geometry}\nWe consider the problem of representing.\n\n% end';
      const note = '\n% remote note';
      const docId = server.addDoc('main.tex', C0);
      const mainPath = path.join(dir, 'main.tex');

      const d = await startDaemon(server, dir);
      const collaborator = server.connect();

      // The collaborator's edit reaches document-updater just ahead of ours, so ours is
      // transformed and we see their op (with op) before our ack: "Conflict detected".
      let injected = false;
      server.onQueue = (client, update) => {
        if (!injected && client.sm === d.socket) {
          injected = true;
          server.submitFirst(collaborator, docId, [{ i: note, p: C0.length }], update.v);
        }
      };
      // While we re-sync, the file is saved again with the same content (a second `cp`,
      // an editor autosave, another tool writing the file).
      server.onJoinDoc = async (client, id, nth) => {
        if (client.sm === d.socket && nth === 2) {
          fs.writeFileSync(mainPath, T);
          await delay(1500);
        }
      };

      fs.writeFileSync(mainPath, T); // whole-file replacement, as in the incident
      await delay(4000);
      await d.stop();

      const ours = server.updates.filter((u) => u.publicId === d.socket.publicId);
      assert.deepEqual(server.errors, [], 'server rejected an update:\n' + logs.text());
      assert.equal(server.docs.get(docId).content, T + note, 'server doc garbled:\n' + logs.text());
      assert.equal(fs.readFileSync(mainPath, 'utf-8'), T + note, 'local file not merged:\n' + logs.text());
      assert.equal(ours.length, 1, 'diff sent more than once:\n' + logs.text());
      assert.ok(!/OT update error/.test(logs.text()), logs.text());
    });
  });

  describe('_onRemoteUpdate', () => {
    function engineWithDoc(doc) {
      const socket = new EventEmitter();
      socket.publicId = 'P.self';
      socket.leaveDoc = () => {};
      const watcher = new EventEmitter();
      const engine = new SyncEngine(socket, watcher, '/tmp/overleap-unit', 'https://x', 'c', 'p', 't');
      engine._atomicWrite = () => {};
      engine.resyncs = [];
      engine._resyncDoc = async (id, base) => engine.resyncs.push({ id, base });
      engine.docs.set('d', Object.assign({ path: 'main.tex', dirty: false, needsResync: false }, doc));
      return engine;
    }

    it('treats an op carrying our own meta.source as our ack, not a conflict', () => {
      const logs = captureLogs();
      let engine;
      try {
        engine = engineWithDoc({
          version: 5, content: 'ab',
          pending: { baseVersion: 5, targetContent: 'xab', sentAt: 0, sendEpoch: 1 },
        });
        engine._onRemoteUpdate({ doc: 'd', op: [{ i: 'x', p: 0 }], v: 5, meta: { source: 'P.self' } });
      } finally {
        logs.restore();
      }
      const doc = engine.docs.get('d');
      assert.ok(!/Conflict/.test(logs.text()), logs.text());
      assert.equal(doc.pending, null);
      assert.equal(doc.needsResync, false);
      assert.equal(doc.content, 'xab');
      assert.equal(doc.version, 6);
    });

    it('ignores a repeated ack for an older op while a newer op is in flight', () => {
      const engine = engineWithDoc({
        version: 6, content: 'xab',
        pending: { baseVersion: 6, targetContent: 'yxab', sentAt: 0, sendEpoch: 2 },
      });
      engine._onRemoteUpdate({ doc: 'd', v: 5 }); // duplicate ack of the op applied at v5
      const doc = engine.docs.get('d');
      assert.notEqual(doc.pending, null);
      assert.equal(doc.content, 'xab');
      assert.equal(doc.version, 6);
    });

    it('takes the version from the ack and re-syncs when the server transformed our op', () => {
      const engine = engineWithDoc({
        version: 5, content: 'ab',
        pending: { baseVersion: 5, targetContent: 'abc', sentAt: 0, sendEpoch: 1 },
      });
      // Applied at v7: two ops we never received were applied before ours.
      engine._onRemoteUpdate({ doc: 'd', v: 7 });
      assert.equal(engine.docs.get('d').pending, null);
      assert.deepEqual(engine.resyncs, [{ id: 'd', base: 'abc' }]);
    });

    it('drops a remote op older than our version (duplicate delivery)', () => {
      const engine = engineWithDoc({ version: 6, content: 'xab', pending: null });
      engine._onRemoteUpdate({ doc: 'd', op: [{ i: 'x', p: 0 }], v: 5, meta: { source: 'P.other' } });
      assert.equal(engine.docs.get('d').content, 'xab');
      assert.equal(engine.docs.get('d').version, 6);
      assert.deepEqual(engine.resyncs, []);
    });
  });
});

describe('Binary replacement', () => {
  it('another editor replacing a file updates it locally and never deletes it', async () => {
    await withProject(async ({ server, dir, logs }) => {
      const figs = server.addFolder('figs');
      server.addFile('x.pdf', 'OLD', figs);
      server.addDoc('main.tex', 'x');
      const d = await startDaemon(server, dir);

      server.upsertFile('x.pdf', 'NEW', figs); // removeEntity(old), then reciveNewFile(new)
      await delay(2500);
      await d.stop();

      const id = server.findFile('x.pdf', figs);
      assert.ok(id, 'server lost figs/x.pdf:\n' + logs.text());
      assert.equal(server.files.get(id).data.toString(), 'NEW');
      assert.equal(fs.readFileSync(path.join(dir, 'figs/x.pdf'), 'utf-8'), 'NEW', logs.text());
      assert.deepEqual(server.requests.filter((r) => r.method !== 'GET'), [], logs.text());
    });
  });

  it('our own replace keeps the file when the server events arrive after the upload response', async () => {
    await withProject(async ({ server, dir, logs }) => {
      const figs = server.addFolder('figs');
      server.addFile('x.pdf', 'OLD', figs);
      server.addDoc('main.tex', 'x');
      const d = await startDaemon(server, dir);

      server.pubsubDelayMs = 200; // removeEntity/reciveNewFile land after the HTTP response
      fs.writeFileSync(path.join(dir, 'figs/x.pdf'), 'MINE');
      await delay(2500);
      await d.stop();

      const id = server.findFile('x.pdf', figs);
      assert.ok(id, 'server lost figs/x.pdf:\n' + logs.text());
      assert.equal(server.files.get(id).data.toString(), 'MINE');
      assert.equal(fs.readFileSync(path.join(dir, 'figs/x.pdf'), 'utf-8'), 'MINE', logs.text());
      assert.deepEqual(server.requests.filter((r) => r.method === 'DELETE'), [], logs.text());
      assert.equal(server.requests.filter((r) => r.path.endsWith('/upload')).length, 1, logs.text());
    });
  });

  it('a file we just uploaded and another client then replaced is updated, not deleted', async () => {
    await withProject(async ({ server, dir, logs }) => {
      const figs = server.addFolder('figs');
      server.addFile('x.pdf', 'OLD', figs);
      server.addDoc('main.tex', 'x');
      const d = await startDaemon(server, dir);

      // A second uploader of the same path (the incident: two daemons on one project)
      // replaces our upload right after it lands.
      let raced = false;
      server.onUpload = () => {
        if (raced) return;
        raced = true;
        setTimeout(() => server.upsertFile('x.pdf', 'THEIRS', figs), 20);
      };
      fs.writeFileSync(path.join(dir, 'figs/x.pdf'), 'MINE');
      await delay(3000);
      await d.stop();

      const id = server.findFile('x.pdf', figs);
      assert.ok(id, 'server lost figs/x.pdf:\n' + logs.text());
      assert.equal(server.files.get(id).data.toString(), 'THEIRS');
      assert.equal(fs.readFileSync(path.join(dir, 'figs/x.pdf'), 'utf-8'), 'THEIRS', logs.text());
      assert.deepEqual(server.requests.filter((r) => r.method === 'DELETE'), [], logs.text());
      assert.equal(server.requests.filter((r) => r.path.endsWith('/upload')).length, 1, logs.text());
    });
  });
});
