'use strict';

// In-process fake of the Overleaf services overleap talks to. Behaviour follows
// overleaf/overleaf@e039ad26 (2026-09-17, after per-project pub/sub for applied ops):
//
// real-time
//   Router.js / WebsocketController.applyOtUpdate: the server sets
//     update.meta.source = client.publicId and calls the applyOtUpdate callback once the
//     update is queued for document-updater, before it is applied.
//   DocumentUpdaterController._applyUpdateFromDocumentUpdater: every client in the
//     project room gets the applied op; the client whose publicId equals meta.source gets
//     only { v, doc } (its ack), all others get the full update (op, v, meta, ...).
//   DocumentUpdaterController._processErrorFromDocumentUpdater: on an apply error every
//     client that joined the doc gets otUpdateError(error, message) and is disconnected.
// document-updater
//   sharejs/server/model.js applyOp: the op is transformed over every op since update.v,
//     applied, and broadcast ('applyOp') before ShareJsUpdateManager checks the hash.
//   ShareJsUpdateManager.applyUpdate: the hash (sha1 of "blob <length>\0<content>") is
//     checked only when the op was not transformed; a failing check is 'Invalid hash' and
//     the new content is not persisted. A delete whose text does not match is
//     'Delete component does not match'.
// web
//   EditorController.upsertFile: replacing a file publishes removeEntity(oldId) and then
//     reciveNewFile(folderId, newFile) before ProjectUploadController answers
//     { success, entity_id, entity_type, hash }. The new file always gets a new id.
//
// Publishes travel through redis pub/sub in production, so each is delivered on its own
// timer (`pubsubDelayMs`) while the HTTP response has its own latency.

const http = require('http');
const crypto = require('crypto');
const SocketManager = require('../../src/socket');
const textType = require('./sharejs/text');

const encodeForWebsockets = (s) => unescape(encodeURIComponent(s));
const blobHash = (content) =>
  crypto.createHash('sha1').update('blob ' + content.length + '\x00').update(content, 'utf8').digest('hex');

let idCounter = 0;
const newId = () => (++idCounter).toString(16).padStart(24, '0');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** The socket.io 0.9 client socket as SocketManager sees it. */
class FakeIoSocket {
  constructor(server, client) {
    this.server = server;
    this.client = client;
    this.handlers = new Map();
    this.disconnected = false;
  }

  on(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(fn);
  }

  // client -> server
  emit(name, ...args) {
    if (this.disconnected) return;
    this.server._fromClient(this.client, name, args);
  }

  // server -> client
  deliver(name, ...args) {
    if (this.disconnected) return;
    for (const fn of this.handlers.get(name) || []) fn(...args);
  }

  disconnect() {
    this.server._drop(this.client, 'client disconnect');
  }
}

class FakeOverleaf {
  constructor(opts = {}) {
    this.projectId = 'a'.repeat(24);
    this.pubsubDelayMs = opts.pubsubDelayMs ?? 2;
    this.applyDelayMs = opts.applyDelayMs ?? 5;
    this.uploadResponseDelayMs = opts.uploadResponseDelayMs ?? 0;
    this.rootFolderId = newId();
    this.folders = new Map(); // id -> { name, parentId }
    this.docs = new Map(); // id -> { name, folderId, content, version, ops: [{ op, v }] }
    this.files = new Map(); // id -> { name, folderId, data }
    this.clients = new Set();
    this.queue = [];
    this.updates = []; // every applyOtUpdate received: { publicId, docId, v, ops }
    this.requests = []; // every HTTP request: { method, path }
    this.errors = [];
    // Test hooks
    this.onQueue = null; // (client, update) => void, runs when an update is queued
    this.onJoinDoc = null; // async (client, docId, nthJoin) => void, runs before answering
    this.onUpload = null; // (name, folderId) => void, runs after an HTTP upload is applied
  }

  // ---------- project setup ----------

  addFolder(name, parentId = this.rootFolderId) {
    const id = newId();
    this.folders.set(id, { name, parentId });
    return id;
  }

  addDoc(name, content, folderId = this.rootFolderId) {
    const id = newId();
    this.docs.set(id, { name, folderId, content, version: 1, ops: [] });
    return id;
  }

  addFile(name, data, folderId = this.rootFolderId) {
    const id = newId();
    this.files.set(id, { name, folderId, data: Buffer.from(data) });
    return id;
  }

  findFile(name, folderId) {
    for (const [id, f] of this.files) if (f.name === name && f.folderId === folderId) return id;
    return null;
  }

  project() {
    const build = (folderId, name) => ({
      _id: folderId,
      name,
      docs: [...this.docs].filter(([, d]) => d.folderId === folderId).map(([id, d]) => ({ _id: id, name: d.name })),
      fileRefs: [...this.files].filter(([, f]) => f.folderId === folderId).map(([id, f]) => ({ _id: id, name: f.name })),
      folders: [...this.folders].filter(([, f]) => f.parentId === folderId).map(([id, f]) => build(id, f.name)),
    });
    return { name: 'Fake project', rootFolder: [build(this.rootFolderId, 'rootFolder')] };
  }

  // ---------- real-time ----------

  /** Connect a real SocketManager whose socket.io transport is this fake. */
  connect() {
    const sm = new SocketManager('cookie', this.projectId, 'http://fake');
    const client = { sm, publicId: 'P.' + crypto.randomBytes(8).toString('hex'), joined: new Set(), joins: 0 };
    client.io = new FakeIoSocket(this, client);
    sm.socket = client.io;
    sm.connected = true;
    sm.publicId = client.publicId; // what connect() resolves from joinProjectResponse
    sm._setupEventHandlers();
    this.clients.add(client);
    return sm;
  }

  _client(sm) {
    for (const c of this.clients) if (c.sm === sm) return c;
    return null;
  }

  _publish(fn) {
    setTimeout(fn, this.pubsubDelayMs);
  }

  _drop(client, reason) {
    if (client.io.disconnected) return;
    client.io.deliver('disconnect', reason);
    client.io.disconnected = true;
    this.clients.delete(client);
  }

  _fromClient(client, name, args) {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
    if (name === 'joinDoc') {
      this._joinDoc(client, args[0]).then((res) => cb(null, ...res), (err) => cb({ message: err.message }));
    } else if (name === 'leaveDoc') {
      // Per-doc rooms were removed upstream; leaving does not stop broadcasts.
      client.joined.delete(args[0]);
    } else if (name === 'applyOtUpdate') {
      this._applyOtUpdate(client, args[0], args[1], cb);
    }
  }

  async _joinDoc(client, docId) {
    const doc = this.docs.get(docId);
    if (!doc) throw new Error('not found');
    client.joins++;
    if (this.onJoinDoc) await this.onJoinDoc(client, docId, client.joins);
    client.joined.add(docId);
    const lines = doc.content.split(/\r\n|\n|\r/).map(encodeForWebsockets);
    return [lines, doc.version, [], {}, 'sharejs-text-ot'];
  }

  _applyOtUpdate(client, docId, update, cb) {
    update.doc = docId;
    update.meta = update.meta || {};
    update.meta.source = client.publicId;
    this.updates.push({ publicId: client.publicId, docId, v: update.v, ops: update.op.length });
    this.queue.push(update);
    if (this.onQueue) this.onQueue(client, update);
    setTimeout(() => cb(), 0); // queued: callback before the op is applied
    setTimeout(() => this._drain(), this.applyDelayMs);
  }

  /** Inject an update from `sm` at the front of the queue (applied before what is queued). */
  submitFirst(sm, docId, op, v) {
    const client = this._client(sm);
    const update = { doc: docId, op, v, meta: { source: client.publicId } };
    this.queue.unshift(update);
  }

  _drain() {
    while (this.queue.length) this._applyOne(this.queue.shift());
  }

  _applyOne(update) {
    const doc = this.docs.get(update.doc);
    const incomingVersion = update.v;
    let op = update.op;
    let v = update.v;
    let snapshot;
    try {
      if (v > doc.version) throw new Error('Op at future version');
      for (const old of doc.ops.filter((o) => o.v >= update.v)) {
        op = textType.transform(op, old.op, 'left');
        v++;
      }
      snapshot = textType.apply(doc.content, op);
    } catch (err) {
      const msg = /^Delete component/.test(err.message) ? 'Delete component does not match' : err.message;
      return this._publishError(update.doc, msg);
    }
    const applied = { ...update, op, v };
    // model.applyOp emits 'applyOp' (-> clients) before ShareJsUpdateManager checks the hash.
    this._broadcastOp(applied);
    if (update.hash != null && incomingVersion === doc.version && blobHash(snapshot) !== update.hash) {
      return this._publishError(update.doc, 'Invalid hash');
    }
    doc.content = snapshot;
    doc.ops.push({ op, v });
    doc.version = v + 1;
  }

  _broadcastOp(update) {
    this._publish(() => {
      for (const client of [...this.clients]) {
        if (client.publicId === update.meta.source) {
          client.io.deliver('otUpdateApplied', { v: update.v, doc: update.doc });
        } else if (!update.dup) {
          client.io.deliver('otUpdateApplied', JSON.parse(JSON.stringify(update)));
        }
      }
    });
  }

  _publishError(docId, error) {
    this.errors.push(error);
    const message = { project_id: this.projectId, doc_id: docId, error };
    this._publish(() => {
      for (const client of [...this.clients]) {
        if (!client.joined.has(docId)) continue;
        client.io.deliver('otUpdateError', error, message);
        this._drop(client, 'booted');
      }
    });
  }

  _emitToRoom(name, ...args) {
    this._publish(() => {
      for (const client of [...this.clients]) client.io.deliver(name, ...args);
    });
  }

  /** Another editor replaces (or adds) a binary via the upload endpoint. */
  upsertFile(name, data, folderId = this.rootFolderId) {
    const oldId = this.findFile(name, folderId);
    const id = newId();
    if (oldId) this.files.delete(oldId);
    this.files.set(id, { name, folderId, data: Buffer.from(data) });
    if (oldId) this._emitToRoom('removeEntity', oldId, 'upload');
    this._emitToRoom('reciveNewFile', folderId, { _id: id, name, linkedFileData: null }, 'upload', null, 'user');
    return { id, oldId };
  }

  // ---------- web (HTTP) ----------

  listen() {
    this.http = http.createServer((req, res) => this._handleHttp(req, res));
    return new Promise((resolve) => {
      this.http.listen(0, '127.0.0.1', () => {
        this.baseUrl = `http://127.0.0.1:${this.http.address().port}`;
        resolve(this.baseUrl);
      });
    });
  }

  close() {
    for (const c of [...this.clients]) c.io.disconnected = true;
    this.clients.clear();
    return new Promise((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
  }

  _handleHttp(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      this.requests.push({ method: req.method, path: url.pathname });
      const body = Buffer.concat(chunks);
      let m;
      if (req.method === 'POST' && (m = url.pathname.match(/^\/project\/[^/]+\/upload$/))) {
        const { name, data } = parseMultipart(body, req.headers['content-type']);
        const folderId = url.searchParams.get('folder_id');
        const { id } = this.upsertFile(name, data, folderId);
        if (this.onUpload) this.onUpload(name, folderId);
        await delay(this.uploadResponseDelayMs);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, entity_id: id, entity_type: 'file', hash: 'h' }));
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/project\/[^/]+\/file\/([^/]+)$/))) {
        const file = this.files.get(m[1]);
        if (!file) { res.writeHead(404); return res.end(); }
        res.writeHead(200);
        return res.end(file.data);
      }
      if (req.method === 'DELETE' && (m = url.pathname.match(/^\/project\/[^/]+\/file\/([^/]+)$/))) {
        if (!this.files.delete(m[1])) { res.writeHead(404); return res.end(); }
        this._emitToRoom('removeEntity', m[1], 'editor');
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  }
}

function parseMultipart(body, contentType) {
  const boundary = '--' + /boundary=(.+)$/.exec(contentType)[1];
  const parts = [];
  let start = body.indexOf(boundary);
  while (start !== -1) {
    const next = body.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = body.subarray(start + boundary.length + 2, next - 2); // strip CRLFs
    const headerEnd = part.indexOf('\r\n\r\n');
    parts.push({ headers: part.subarray(0, headerEnd).toString(), data: part.subarray(headerEnd + 4) });
    start = next;
  }
  const namePart = parts.find((p) => /name="name"/.test(p.headers));
  const filePart = parts.find((p) => /filename=/.test(p.headers));
  return { name: namePart.data.toString(), data: filePart.data };
}

module.exports = { FakeOverleaf, blobHash, delay };
