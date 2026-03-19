'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');

// Monkey-patch socket.io-client v0.9 to support extraHeaders in Node.js.
(function patchSocketIO() {
  const io = require('socket.io-client');

  // 1. Replace handshake to use Node.js https (bypasses xmlhttprequest)
  io.Socket.prototype.handshake = function (fn) {
    const self = this;
    const options = this.options;
    const extraHeaders = options.extraHeaders || {};

    const scheme = options.secure === false ? 'http:/' : 'https:/';
    const handshakeUrl = [
      scheme,
      options.host + ':' + options.port,
      options.resource,
      io.protocol,
      '?t=' + Date.now(),
    ].join('/');
    const queryStr = options.query || '';
    const fullUrl = queryStr ? handshakeUrl + '&' + queryStr : handshakeUrl;
    const parsed = new (require('url').URL)(fullUrl);

    const httpModule = parsed.protocol === 'http:' ? require('http') : require('https');
    const req = httpModule.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: Object.assign({}, extraHeaders),
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          fn.apply(null, body.split(':'));
        } else {
          self.connecting = false;
          self.onError(new Error('Handshake failed: ' + res.statusCode));
        }
      });
    });
    req.on('error', (err) => { self.connecting = false; self.onError(err); });
    req.setTimeout(15000, () => req.destroy(new Error('Handshake timeout')));
    req.end();
  };

  // 2. Replace WebSocket open to pass extraHeaders
  io.Transport.websocket.prototype.open = function () {
    const query = io.util.query(this.socket.options.query);
    const WS = require('ws');
    const wsOpts = {};
    if (this.socket.options.extraHeaders) {
      wsOpts.headers = this.socket.options.extraHeaders;
    }
    this.websocket = new WS(this.prepareUrl() + query, wsOpts);

    const self = this;
    this.websocket.onopen = function () { self.onOpen(); self.socket.setBuffer(false); };
    this.websocket.onmessage = function (ev) { self.onData(ev.data); };
    this.websocket.onclose = function () { self.onClose(); self.socket.setBuffer(true); };
    this.websocket.onerror = function (e) { self.onError(e); };
    return this;
  };
})();

class SocketManager extends EventEmitter {
  constructor(cookie, projectId, baseUrl) {
    super();
    this.cookie = cookie;
    this.projectId = projectId;
    this.baseUrl = baseUrl;
    this.socket = null;
    this.connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const io = require('socket.io-client');

      const queryUrl = `${this.baseUrl}?projectId=${this.projectId}&t=${Date.now()}`;
      this.socket = io.connect(queryUrl, {
        reconnect: false,
        'force new connection': true,
        extraHeaders: {
          'Cookie': this.cookie,
          'Origin': this.baseUrl,
        },
      });

      const timeout = setTimeout(() => {
        try { this.socket.disconnect(); } catch (e) { /* ignore */ }
        reject(new Error('Connection timeout (15s)'));
      }, 15000);

      // v2 scheme: server sends joinProjectResponse automatically
      this.socket.on('joinProjectResponse', (data) => {
        clearTimeout(timeout);
        this.connected = true;
        this._setupEventHandlers();
        resolve({
          publicId: data.publicId,
          project: data.project,
          permissionsLevel: data.permissionsLevel,
          protocolVersion: data.protocolVersion,
        });
      });

      // v1 scheme fallback (self-hosted instances)
      this.socket.on('connectionAccepted', (_, publicId) => {
        this.socket.emit('joinProject', { project_id: this.projectId }, (err, project, permissionsLevel, protocolVersion) => {
          clearTimeout(timeout);
          if (err) {
            reject(new Error(err.message || String(err)));
            return;
          }
          this.connected = true;
          this._setupEventHandlers();
          resolve({ publicId, project, permissionsLevel, protocolVersion });
        });
      });

      this.socket.on('connect_failed', () => {
        clearTimeout(timeout);
        try { this.socket.disconnect(); } catch (e) { /* ignore */ }
        reject(new Error('Socket.IO connection failed'));
      });

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        try { this.socket.disconnect(); } catch (e) { /* ignore */ }
        reject(new Error(String(err)));
      });
    });
  }

  _setupEventHandlers() {
    this.socket.on('otUpdateApplied', (update) => {
      this.emit('otUpdateApplied', update);
    });

    this.socket.on('otUpdateError', (err) => {
      this.emit('otUpdateError', err);
    });

    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      this.emit('disconnect', { reason: reason || 'server disconnected' });
    });

    this.socket.on('forceDisconnect', (message) => {
      this.connected = false;
      this.emit('disconnect', { reason: `force disconnect: ${message}` });
    });

    // File tree events
    this.socket.on('reciveNewDoc', (parentFolderId, doc) => {
      this.emit('reciveNewDoc', { parentFolderId, doc });
    });

    this.socket.on('reciveNewFile', (parentFolderId, file) => {
      this.emit('reciveNewFile', { parentFolderId, file });
    });

    this.socket.on('removeEntity', (entityId) => {
      this.emit('removeEntity', { entityId });
    });
  }

  _promisifiedEmit(event, ...args) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${event} timeout (10s)`));
      }, 10000);

      this.socket.emit(event, ...args, (err, ...data) => {
        clearTimeout(timeout);
        if (err) {
          reject(new Error(err.message || String(err)));
        } else {
          resolve(data);
        }
      });
    });
  }

  async joinDoc(docId) {
    const data = await this._promisifiedEmit('joinDoc', docId, -1, { encodeRanges: true });
    const [docLines, version] = data;

    // Decode Latin-1 to UTF-8
    const lines = (docLines || []).map((line) =>
      Buffer.from(line, 'latin1').toString('utf-8')
    );

    return { lines, version };
  }

  leaveDoc(docId) {
    this.socket.emit('leaveDoc', docId);
  }

  async applyOtUpdate(docId, op, version, contentAfterOps) {
    const update = {
      doc: docId,
      op: op,
      v: version,
      lastV: version,
    };

    // Hash the final content directly (no re-applying ops — avoids divergence)
    // Note: Overleaf uses JS string length (not byte length) in the git-blob prefix
    if (contentAfterOps !== undefined && contentAfterOps !== null) {
      update.hash = crypto
        .createHash('sha1')
        .update('blob ' + contentAfterOps.length + '\x00' + contentAfterOps)
        .digest('hex');
    }

    await this._promisifiedEmit('applyOtUpdate', docId, update);
  }

  disconnect() {
    if (this.socket) {
      try { this.socket.disconnect(); } catch (e) { /* ignore */ }
      this.socket = null;
      this.connected = false;
    }
  }
}

module.exports = SocketManager;
