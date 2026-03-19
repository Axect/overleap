'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getConfig } = require('./config');
const { fetchProjectPage, updateCookies, httpPost, httpGetBinary } = require('./auth');
const SocketManager = require('./socket');
const FileWatcher = require('./watcher');
const SyncEngine = require('./sync-engine');

class Daemon {
  constructor(opts) {
    this.config = getConfig(opts);
    this.socketManager = null;
    this.watcher = null;
    this.syncEngine = null;
    this._shutdown = false;
    this._reconnecting = false; // H3: prevent concurrent reconnect attempts
  }

  /**
   * List available projects.
   */
  async listProjects() {
    const { cookie, url } = this.config;
    console.log(`Connecting to ${url}...`);
    await updateCookies(cookie, url);
    const { projects, userEmail } = await fetchProjectPage(cookie, url);
    if (userEmail) console.log(`Logged in as: ${userEmail}`);
    return projects;
  }

  /**
   * Resolve project ID from various input formats.
   */
  async resolveProjectId(input) {
    const { cookie, url } = this.config;

    // Direct Overleaf ID (24 hex chars)
    if (input && /^[a-f0-9]{24}$/i.test(input)) {
      return input;
    }

    const { projects, userEmail } = await fetchProjectPage(cookie, url);
    if (userEmail) console.log(`Logged in as: ${userEmail}`);

    if (projects.length === 0) {
      throw new Error('No projects found on this account.');
    }

    // Number → pick by index
    if (input && /^\d+$/.test(input)) {
      const idx = parseInt(input, 10);
      if (idx < 1 || idx > projects.length) {
        throw new Error(`Invalid number: ${idx}. Choose 1-${projects.length}.`);
      }
      const picked = projects[idx - 1];
      console.log(`Selected: ${picked.name}\n`);
      return picked.id;
    }

    // String → fuzzy match (case-insensitive substring)
    if (input) {
      const query = input.toLowerCase();
      const matches = projects.filter((p) =>
        p.name.toLowerCase().includes(query)
      );

      if (matches.length === 1) {
        console.log(`Matched: ${matches[0].name}\n`);
        return matches[0].id;
      }

      if (matches.length > 1) {
        console.log(`\nMultiple matches for "${input}":\n`);
        this._printProjectList(matches);
        const idx = await this._promptNumber(matches.length);
        return matches[idx - 1].id;
      }

      throw new Error(`No project matching "${input}".`);
    }

    // No input → interactive selection
    console.log(`\nProjects:\n`);
    this._printProjectList(projects);
    const idx = await this._promptNumber(projects.length);
    return projects[idx - 1].id;
  }

  _printProjectList(projects) {
    const maxNameLen = Math.max(...projects.map((p) => p.name.length));
    projects.forEach((p, i) => {
      const num = String(i + 1).padStart(3);
      const name = p.name.padEnd(maxNameLen);
      const date = p.lastUpdated ? new Date(p.lastUpdated).toLocaleDateString() : '';
      console.log(`  ${num}. ${name}  [${p.accessLevel}]  ${date}`);
    });
    console.log();
  }

  // L7: handle stdin close gracefully
  _promptNumber(max) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve, reject) => {
      rl.on('close', () => {
        reject(new Error('Input stream closed'));
      });
      rl.question(`Pick a project (1-${max}): `, (answer) => {
        rl.close();
        const n = parseInt(answer.trim(), 10);
        if (isNaN(n) || n < 1 || n > max) {
          reject(new Error(`Invalid selection: ${answer}`));
        } else {
          resolve(n);
        }
      });
    });
  }

  /**
   * Start bidirectional sync.
   */
  async start() {
    const { cookie, url, dir } = this.config;
    const projectId = await this.resolveProjectId(this.config.projectId);
    // Store resolved projectId for reconnection
    this._projectId = projectId;

    console.log(`[daemon] Connecting to ${url}...`);

    // 1. Authenticate and get GCLB cookie
    const { csrfToken, userEmail } = await fetchProjectPage(cookie, url);
    if (userEmail) console.log(`[daemon] Logged in as: ${userEmail}`);

    const updatedCookie = await updateCookies(cookie, url);
    console.log('[daemon] Session cookies updated');

    // 2. Connect Socket.IO
    this.socketManager = new SocketManager(updatedCookie, projectId, url);
    const joinResult = await this.socketManager.connect();
    const projectName = joinResult.project?.name || projectId;
    console.log(`[daemon] Connected to project: ${projectName}`);
    console.log(`[daemon] Permissions: ${joinResult.permissionsLevel}`);

    // 3. Start file watcher
    this.watcher = new FileWatcher(dir);
    await this.watcher.start();
    console.log(`[daemon] Watching directory: ${dir}`);

    // L6: handle watcher errors (e.g., ENOSPC inotify limit)
    this.watcher.on('error', (err) => {
      if (err.code === 'ENOSPC') {
        console.error('[daemon] inotify watcher limit reached. Increase with:');
        console.error('  echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p');
      } else {
        console.error('[daemon] Watcher error:', err.message);
      }
    });

    // 4. Start sync engine
    this.syncEngine = new SyncEngine(this.socketManager, this.watcher, dir, url, updatedCookie, projectId, csrfToken, {
      onAuthExpired: async () => {
        const { csrfToken: newCsrf } = await fetchProjectPage(cookie, url);
        const newCookie = await updateCookies(cookie, url);
        return { cookie: newCookie, csrfToken: newCsrf };
      },
    });

    // 5. Initial sync
    await this.syncEngine.initialSync(joinResult.project);

    // 6. Handle disconnection — H3: use once to prevent accumulation
    this._bindDisconnectHandler();

    console.log('\n[daemon] Sync is running. Press Ctrl+C to stop.\n');

    // 7. Handle shutdown signals
    const shutdown = () => this.stop();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  // H2+H3: centralized disconnect handler, prevents listener accumulation
  _bindDisconnectHandler() {
    this.socketManager.once('disconnect', ({ reason }) => {
      console.log(`[daemon] Disconnected: ${reason}`);
      if (!this._shutdown) {
        this._reconnect().catch((err) => {
          console.error('[daemon] Reconnect error:', err.message);
        });
      }
    });
  }

  /**
   * Reconnect with exponential backoff.
   * H3: guard against concurrent reconnect attempts.
   */
  async _reconnect() {
    if (this._reconnecting || this._shutdown) return;
    this._reconnecting = true;

    const maxDelay = 30000;
    let delay = 1000;

    while (!this._shutdown) {
      console.log(`[daemon] Reconnecting in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));

      if (this._shutdown) break;

      try {
        const { cookie, url, dir } = this.config;
        const updatedCookie = await updateCookies(cookie, url);

        // H2: cleanup old SyncEngine before creating new one
        if (this.syncEngine) {
          this.syncEngine.cleanup();
          this.syncEngine.detach(); // remove watcher listener
        }
        // Disconnect old socket before creating new one
        if (this.socketManager) {
          this.socketManager.disconnect();
        }

        const { csrfToken } = await fetchProjectPage(cookie, url);
        this.socketManager = new SocketManager(updatedCookie, this._projectId, url);
        const joinResult = await this.socketManager.connect();
        console.log('[daemon] Reconnected successfully');

        // Re-initialize sync
        this.syncEngine = new SyncEngine(this.socketManager, this.watcher, dir, url, updatedCookie, this._projectId, csrfToken, {
          onAuthExpired: async () => {
            const { csrfToken: newCsrf } = await fetchProjectPage(cookie, url);
            const newCookie = await updateCookies(cookie, url);
            return { cookie: newCookie, csrfToken: newCsrf };
          },
        });
        await this.syncEngine.initialSync(joinResult.project);

        // H3: single disconnect handler via once
        this._bindDisconnectHandler();

        console.log('[daemon] Sync resumed.\n');
        this._reconnecting = false;
        return;
      } catch (err) {
        console.error(`[daemon] Reconnect failed: ${err.message}`);
        delay = Math.min(delay * 2, maxDelay);
      }
    }
    this._reconnecting = false;
  }

  /**
   * Graceful shutdown.
   * L4: avoid process.exit — let event loop drain naturally.
   */
  async stop() {
    if (this._shutdown) return;
    this._shutdown = true;

    console.log('\n[daemon] Shutting down...');

    if (this.syncEngine) {
      this.syncEngine.cleanup();
    }
    if (this.watcher) {
      await this.watcher.stop();
    }
    if (this.socketManager) {
      this.socketManager.disconnect();
    }

    console.log('[daemon] Goodbye.');
    // Let the process exit naturally once all handles are released.
    // Force exit after 2s if something hangs.
    setTimeout(() => process.exit(0), 2000).unref();
  }

  /**
   * Trigger compilation and download PDF.
   */
  async compile() {
    const { cookie, url } = this.config;
    const projectId = await this.resolveProjectId(this.config.projectId);

    console.log(`[compile] Triggering compilation for ${projectId}...`);

    const { csrfToken } = await fetchProjectPage(cookie, url);

    const compileRes = await httpPost(
      `${url}/project/${projectId}/compile`,
      cookie,
      csrfToken,
      { rootDoc_id: '', draft: false, check: 'silent', incrementalCompilesEnabled: true }
    );

    let result;
    try {
      result = JSON.parse(compileRes.body);
    } catch (e) {
      throw new Error(`Compilation request failed (HTTP ${compileRes.status})`);
    }
    if (result.status !== 'success') {
      console.error('[compile] Compilation failed:', result.status);
      if (result.outputFiles) {
        const log = result.outputFiles.find((f) => f.type === 'log');
        if (log) console.error('[compile] Check the log for errors.');
      }
      return;
    }

    // Download PDF
    const pdfFile = result.outputFiles.find((f) => f.type === 'pdf');
    if (pdfFile) {
      const pdfUrl = `${url}${pdfFile.url}`;
      console.log('[compile] Downloading PDF...');
      const pdfRes = await httpGetBinary(pdfUrl, cookie);
      if (pdfRes.status === 200) {
        const outPath = path.join(this.config.dir, 'output.pdf');
        fs.writeFileSync(outPath, pdfRes.body);
        console.log(`[compile] PDF saved to: ${outPath}`);
      }
    }
  }
}

module.exports = Daemon;
